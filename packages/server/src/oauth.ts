import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { loadOrCreateJwtSecret, loadClients, saveClients } from './lib/persistence.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── Signing key (persisted across restarts) ─────────────────────────────────
const JWT_SECRET = loadOrCreateJwtSecret(config.dataDir);
const JWT_ISSUER = config.publicUrl;

// Token lifetimes. The access token is a short-ish bearer JWT; the refresh
// token is a long-lived, signed JWT (kind:"refresh") that lets OAuth clients
// (e.g. n8n) transparently mint new access tokens via the refresh_token grant
// without re-running the browser authorize flow. Both are stateless — they
// survive a server restart as long as DATA_DIR (the JWT secret) is persisted.
const ACCESS_TOKEN_TTL = 2_592_000; // 30 days
const REFRESH_TOKEN_TTL = 31_536_000; // 365 days

/** Mint a signed access-token JWT carrying sub/scope/client_id. */
async function signAccessToken(sub: string, clientId: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, scope, client_id: clientId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL)
    .setIssuer(JWT_ISSUER)
    .sign(JWT_SECRET);
}

/** Mint a signed refresh-token JWT (marked kind:"refresh", long expiry). */
async function signRefreshToken(sub: string, clientId: string, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, scope, client_id: clientId, kind: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + REFRESH_TOKEN_TTL)
    .setIssuer(JWT_ISSUER)
    .sign(JWT_SECRET);
}

// ── Stores (persisted to disk) ──────────────────────────────────────────────

export interface OAuthClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  registeredAt: number;
}

interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scopes: string[];
  user: string;
  expiresAt: number;
}

const clients = loadClients(config.dataDir);
const authCodes = new Map<string, AuthCodeEntry>();

// Cleanup expired auth codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
}, 5 * 60_000);

// ── Router ──────────────────────────────────────────────────────────────────

export const oauthRouter = Router();

// ── Discovery: Protected Resource Metadata (RFC 9728) ───────────────────────

oauthRouter.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  res.json({
    resource: `${config.publicUrl}/mcp`,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
  });
});

// ── Discovery: Authorization Server Metadata (RFC 8414) ─────────────────────

oauthRouter.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  res.json({
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/authorize`,
    token_endpoint: `${config.publicUrl}/token`,
    registration_endpoint: `${config.publicUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: ['mcp:tools'],
  });
});

// ── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

export interface CreateOAuthClientInput {
  redirect_uris: string[];
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

/**
 * Register a new OAuth client and persist it. Shared by the public RFC 7591
 * `/register` endpoint and the authenticated dashboard helper. Throws if the
 * client store can't be persisted (e.g. unwritable DATA_DIR) — callers map that
 * to their own error shape. The new client (including its secret) is returned.
 */
export function createOAuthClient(input: CreateOAuthClientInput): OAuthClient {
  const client: OAuthClient = {
    client_id: crypto.randomUUID(),
    client_secret: crypto.randomBytes(32).toString('hex'),
    redirect_uris: input.redirect_uris,
    client_name: input.client_name || 'MCP Client',
    // Default to advertising refresh_token too — clients like n8n rely on the
    // refresh_token grant to avoid re-running the browser flow every 30 days.
    grant_types: input.grant_types || ['authorization_code', 'refresh_token'],
    response_types: input.response_types || ['code'],
    token_endpoint_auth_method: input.token_endpoint_auth_method || 'client_secret_post',
    registeredAt: Date.now(),
  };
  clients.set(client.client_id, client);
  try {
    saveClients(config.dataDir, clients);
  } catch (err) {
    // Roll back the in-memory add so a failed persist doesn't leave a client
    // that vanishes on next restart. Caller logs + surfaces the error.
    clients.delete(client.client_id);
    throw err;
  }
  logger.info('OAuth client registered', { clientId: client.client_id, clientName: client.client_name });
  return client;
}

/** Delete a registered OAuth client. Returns true if it existed. */
export function deleteOAuthClient(clientId: string): boolean {
  const existed = clients.delete(clientId);
  if (existed) saveClients(config.dataDir, clients);
  return existed;
}

oauthRouter.post('/register', (req: Request, res: Response) => {
  // Rate limit: 10 registrations per hour per IP
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) ?? 'unknown';
  const rl = checkRateLimit(`register:${ip}`, 10, 3_600_000);
  if (!rl.allowed) {
    res.status(429).json({ error: 'too_many_requests', error_description: 'Registration rate limit exceeded' });
    return;
  }

  const { redirect_uris, client_name, grant_types, response_types, token_endpoint_auth_method } = req.body;

  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
    return;
  }

  let client: OAuthClient;
  try {
    client = createOAuthClient({ redirect_uris, client_name, grant_types, response_types, token_endpoint_auth_method });
  } catch (err) {
    // Most commonly an unwritable DATA_DIR (volume not mounted, or owned by a
    // different uid than the container's `node` user). Surface the real cause
    // in the logs and return a spec-compliant error rather than a bare 500.
    logger.error('OAuth client registration failed to persist', {
      error: err instanceof Error ? err.message : String(err),
      dataDir: config.dataDir,
    });
    res.status(500).json({
      error: 'server_error',
      error_description: 'Failed to persist client registration',
    });
    return;
  }

  res.status(201).json({
    client_id: client.client_id,
    client_secret: client.client_secret,
    client_id_issued_at: Math.floor(client.registeredAt / 1000),
    redirect_uris: client.redirect_uris,
    client_name: client.client_name,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  });
});

// ── Authorization Endpoint ──────────────────────────────────────────────────
// Forward-auth (Authelia/Traefik) on this route is OPTIONAL.
//   - PROXY_AUTH=true  → an upstream proxy authenticates the user and sets the
//     Remote-User header; the grant is attributed to that user.
//   - PROXY_AUTH unset → the grant is attributed to the configured local user
//     (PROXY_AUTH_USER, default "local"). The OAuth flow stays secure on its
//     own via client registration, redirect_uri allowlisting, PKCE and rate
//     limiting; no forward-auth proxy is required.

oauthRouter.get('/authorize', (req: Request, res: Response) => {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, scope } =
    req.query as Record<string, string>;

  let remoteUser: string | undefined;
  if (config.proxyAuth) {
    // Forward-auth proxy must have authenticated the user and set Remote-User.
    remoteUser = req.headers['remote-user'] as string | undefined;
    if (!remoteUser) {
      res.status(401).json({ error: 'access_denied', error_description: 'Forward-auth (Remote-User) required' });
      return;
    }
  } else {
    remoteUser = config.proxyAuthUser;
  }

  const client = clients.get(client_id);
  if (!client) {
    res.status(400).json({ error: 'invalid_client' });
    return;
  }

  if (!client.redirect_uris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
    return;
  }

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
    return;
  }

  // Generate authorization code. PKCE method is only stored when a challenge was sent;
  // otherwise we leave it undefined so the /token handler skips PKCE validation entirely
  // (RFC 7636 makes PKCE OPTIONAL for confidential clients).
  const authCode = crypto.randomBytes(32).toString('hex');
  authCodes.set(authCode, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge || undefined,
    codeChallengeMethod: code_challenge ? (code_challenge_method || 'S256') : undefined,
    scopes: scope ? scope.split(' ') : [],
    user: remoteUser,
    expiresAt: Date.now() + 60_000, // 1 minute
  });

  logger.info('Authorization code issued', { user: remoteUser, clientId: client_id });

  // Redirect back to the MCP client
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', authCode);
  if (state) redirectUrl.searchParams.set('state', state);

  res.redirect(redirectUrl.toString());
});

// ── Token Endpoint ──────────────────────────────────────────────────────────

oauthRouter.post('/token', async (req: Request, res: Response) => {
  const { grant_type, code, code_verifier, redirect_uri } = req.body;
  let { client_id } = req.body;

  // RFC 6749 §2.3.1 — accept client_secret_basic (HTTP Basic header) in addition to
  // client_secret_post (request body). Some OAuth clients (incl. n8n in some modes)
  // send credentials only via the Authorization header.
  const authHeader = req.headers.authorization;
  if (!client_id && typeof authHeader === 'string' && authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > -1) client_id = decoded.slice(0, sep);
    } catch {
      /* ignore malformed header */
    }
  }

  // ── Refresh Token grant (RFC 6749 §6) ──────────────────────────────────────
  // The refresh token is a signed JWT (kind:"refresh"); validation is stateless.
  // We rotate it on each use (issue a fresh refresh token alongside the access
  // token) so clients that persist the latest value keep a rolling 365-day window.
  if (grant_type === 'refresh_token') {
    const { refresh_token } = req.body;
    if (!refresh_token || typeof refresh_token !== 'string') {
      res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
      return;
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(refresh_token, JWT_SECRET, { issuer: JWT_ISSUER }));
    } catch {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
      return;
    }
    if (payload.kind !== 'refresh') {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Not a refresh token' });
      return;
    }
    const tokenClientId = payload.client_id as string;
    // If the client identified itself (body or Basic header), it must match.
    if (client_id && tokenClientId !== client_id) {
      logger.warn('OAuth /token refresh client_id mismatch', { expected: tokenClientId, got: client_id });
      res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      return;
    }
    const sub = payload.sub as string;
    const scope = (payload.scope as string) || '';

    const accessToken = await signAccessToken(sub, tokenClientId, scope);
    const newRefreshToken = await signRefreshToken(sub, tokenClientId, scope);
    logger.info('Access token refreshed', { user: sub, clientId: tokenClientId });

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: newRefreshToken,
      scope,
    });
    return;
  }

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  const entry = authCodes.get(code);
  if (!entry) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
    return;
  }

  // Single-use: delete immediately
  authCodes.delete(code);

  if (entry.expiresAt < Date.now()) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
    return;
  }

  if (entry.clientId !== client_id) {
    logger.warn('OAuth /token client_id mismatch', { expected: entry.clientId, got: client_id, hasAuthHeader: !!authHeader });
    res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
    return;
  }
  if (entry.redirectUri !== redirect_uri) {
    logger.warn('OAuth /token redirect_uri mismatch', { expected: entry.redirectUri, got: redirect_uri });
    res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    return;
  }

  // PKCE — only enforced if a code_challenge was sent at /authorize. Confidential
  // clients without PKCE skip this branch entirely (RFC 7636 §4 — optional for them).
  if (entry.codeChallenge) {
    if (!code_verifier) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
      return;
    }
    if (entry.codeChallengeMethod === 'S256') {
      const expected = crypto.createHash('sha256').update(code_verifier).digest('base64url');
      if (expected !== entry.codeChallenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    } else if (code_verifier !== entry.codeChallenge) {
      // 'plain' method (RFC 7636 §4.6)
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }
  }

  // Issue access + refresh token pair
  const scope = entry.scopes.join(' ');
  const accessToken = await signAccessToken(entry.user, entry.clientId, scope);
  const refreshToken = await signRefreshToken(entry.user, entry.clientId, scope);

  logger.info('Access token issued', { user: entry.user, clientId: entry.clientId });

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope,
  });
});

// ── Token verification (used by auth middleware) ────────────────────────────

/**
 * Return all registered OAuth clients (excluding secrets).
 */
export function getOAuthClients(): Array<{
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  registeredAt: number;
}> {
  const result: Array<{
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    registeredAt: number;
  }> = [];
  for (const client of clients.values()) {
    result.push({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      registeredAt: client.registeredAt,
    });
  }
  return result;
}

export async function verifyJwt(token: string): Promise<{
  sub: string;
  clientId: string;
  iat?: number;
  exp?: number;
} | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { issuer: JWT_ISSUER });
    return {
      sub: payload.sub as string,
      clientId: payload.client_id as string,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

// ── Dashboard session cookie (Component A) ──────────────────────────────────
// A short-lived signed JWT, separate in intent from OAuth access tokens but
// signed with the SAME secret/issuer so we don't introduce a second key to
// manage. Carries sub:"dashboard" and is delivered in an httpOnly cookie.

const DASHBOARD_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Mint a signed dashboard session token (sub:"dashboard", 7d expiry).
 */
export async function mintDashboardSession(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: 'dashboard-session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('dashboard')
    .setIssuedAt(now)
    .setExpirationTime(now + DASHBOARD_SESSION_TTL_SECONDS)
    .setIssuer(JWT_ISSUER)
    .sign(JWT_SECRET);
}

/**
 * Verify a dashboard session token. Returns true only for a valid, unexpired
 * token minted by mintDashboardSession (sub:"dashboard").
 */
export async function verifyDashboardSession(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { issuer: JWT_ISSUER });
    return payload.sub === 'dashboard';
  } catch {
    return false;
  }
}

/**
 * Issue a fresh JWT with the same claims but a new expiry.
 * Used for transparent token refresh when a token is past its half-life.
 */
export async function refreshJwt(payload: {
  sub: string;
  clientId: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 2_592_000; // 30 days

  return new SignJWT({
    sub: payload.sub,
    client_id: payload.clientId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setIssuer(JWT_ISSUER)
    .sign(JWT_SECRET);
}
