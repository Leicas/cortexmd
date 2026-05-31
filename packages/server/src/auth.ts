import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { checkRateLimit } from './lib/rate-limit.js';
import { logSecurityEvent } from './lib/journal.js';
import { logger } from './lib/logger.js';
import { verifyJwt, refreshJwt, verifyDashboardSession } from './oauth.js';
import { recordAuthFailure } from './lib/metrics.js';

/** Pre-computed expected Authorization header value as a Buffer. */
const EXPECTED_AUTH = Buffer.from(`Bearer ${config.apiKey}`, 'utf-8');

/** Rate-limit window: 10 failures per 5 minutes per IP. */
const AUTH_MAX_FAILURES = 10;
const AUTH_WINDOW_MS = 5 * 60 * 1000;

function isApiKeyValid(header: string): boolean {
  const supplied = Buffer.from(header, 'utf-8');
  if (supplied.length !== EXPECTED_AUTH.length) return false;
  return timingSafeEqual(supplied, EXPECTED_AUTH);
}

/** Name of the dashboard session cookie set on a successful /login. */
export const SESSION_COOKIE_NAME = 'cortexmd_session';

/**
 * Parse a single cookie value out of the raw `Cookie` header. We avoid adding
 * cookie-parser as a dependency — the header format is a simple
 * `name=value; name2=value2` list (RFC 6265 §4.2.1).
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * API key + JWT middleware for /mcp.
 *
 * Accepts either:
 *   - Authorization: Bearer <API_KEY>  (static key for simple setups)
 *   - Authorization: Bearer <JWT>      (OAuth token from /authorize flow)
 */
export function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip = getClientIp(req);

  // Request size enforcement (always checked first, independent of auth)
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > config.maxRequestSizeBytes) {
    logSecurityEvent('request_too_large', {
      ip,
      contentLength,
      limit: config.maxRequestSizeBytes,
    }).catch(() => {});
    res.status(413).json({ error: 'Request body too large' });
    return;
  }

  const header = req.headers.authorization;
  if (!header) {
    // No auth header at all — check rate limit, record failure, return 401
    handleAuthFailure(ip, req, res);
    return;
  }

  // Fast path: static API key — skip rate limiting entirely
  if (isApiKeyValid(header)) {
    next();
    return;
  }

  // Slow path: JWT from OAuth flow — skip rate limiting if valid
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    handleAuthFailure(ip, req, res);
    return;
  }

  verifyJwt(token).then(async (result) => {
    if (result) {
      res.locals.user = result;

      // Transparent token refresh: if past half-life, issue a new token
      if (result.iat != null && result.exp != null) {
        const now = Math.floor(Date.now() / 1000);
        const halfLife = (result.exp - result.iat) / 2;
        if (result.exp - now < halfLife) {
          try {
            const freshToken = await refreshJwt({ sub: result.sub, clientId: result.clientId });
            res.setHeader('X-Refreshed-Token', freshToken);
          } catch {
            // Non-fatal — continue with the existing valid token
          }
        }
      }

      next();
    } else {
      // JWT verification failed — apply rate limiting
      handleAuthFailure(ip, req, res);
    }
  }).catch(() => {
    res.status(500).json({ error: 'Internal auth error' });
  });
}

/**
 * Handle a failed auth attempt: check rate limit, record the failure, return 401 or 429.
 */
function handleAuthFailure(ip: string, req: Request, res: Response): void {
  const rl = checkRateLimit(`auth:${ip}`, AUTH_MAX_FAILURES, AUTH_WINDOW_MS);
  if (!rl.allowed) {
    logSecurityEvent('rate_limit_exceeded', {
      ip,
      resetAt: new Date(rl.resetAt).toISOString(),
    }).catch(() => {});
    recordAuthFailure(ip, req.path, req.method);
    res.status(429).json({ error: 'Too many failed authentication attempts' });
    return;
  }

  logSecurityEvent('auth_failure', { ip, path: req.path, method: req.method }).catch(() => {});
  recordAuthFailure(ip, req.path, req.method);
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Admin/dashboard auth middleware for routes that, in a team deployment, sit
 * behind an upstream forward-auth proxy (e.g. Authelia/Traefik).
 *
 * Forward-auth is OPTIONAL and OFF by default:
 *   - PROXY_AUTH=true  → trust the Remote-User header set by the proxy.
 *   - PROXY_AUTH unset → fall back to plain API-key auth (apiKeyMiddleware).
 *
 * The Remote-User path is only safe when the app is reachable solely through
 * the trusted proxy (e.g. bound to 127.0.0.1, no direct external access).
 */
export function proxyAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!config.proxyAuth) {
    // No forward-auth proxy configured — protect with the static API key / JWT.
    apiKeyMiddleware(req, res, next);
    return;
  }

  const remoteUser = req.headers['remote-user'] as string | undefined;

  if (!remoteUser) {
    const ip = getClientIp(req);
    logger.warn('Missing Remote-User header', { ip, path: req.path, method: req.method });
    res.status(401).json({ error: 'Unauthorized — forward-auth (Remote-User) required' });
    return;
  }

  res.locals.user = {
    username: remoteUser,
    name: req.headers['remote-name'] as string | undefined,
    email: req.headers['remote-email'] as string | undefined,
    groups: req.headers['remote-groups'] as string | undefined,
  };

  next();
}

/**
 * Resolve a Bearer credential (static API key or OAuth JWT) WITHOUT sending a
 * response. Returns the authenticated user (or `true` for the static key) on
 * success, or null when there is no valid Bearer credential. Used by
 * dashboardAuthMiddleware so it can fall through to other auth methods instead
 * of short-circuiting with a 401.
 */
async function resolveBearer(
  req: Request,
): Promise<{ sub: string; clientId: string } | true | null> {
  const header = req.headers.authorization;
  if (!header) return null;
  if (isApiKeyValid(header)) return true;
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  return await verifyJwt(token);
}

/**
 * Dashboard / admin auth (Component A — the DEFAULT human auth path).
 *
 * Authorizes when ANY of the following hold:
 *   - a valid `cortexmd_session` cookie (server-managed password login), or
 *   - a valid Bearer API key / OAuth JWT (programmatic / advanced clients), or
 *   - PROXY_AUTH=true and an upstream proxy set the Remote-User header
 *     (advanced/team forward-auth deployment).
 *
 * On failure: browser requests (Accept: text/html) get a 302 redirect to
 * /login so a human lands on the password form; API/XHR requests get a 401
 * JSON error.
 */
export function dashboardAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    // 1. Session cookie
    const sessionToken = readCookie(req, SESSION_COOKIE_NAME);
    if (sessionToken && (await verifyDashboardSession(sessionToken))) {
      res.locals.user = { username: 'dashboard', via: 'session' };
      next();
      return;
    }

    // 2. Bearer API key / OAuth JWT
    const bearer = await resolveBearer(req);
    if (bearer) {
      if (bearer !== true) res.locals.user = bearer;
      next();
      return;
    }

    // 3. Forward-auth (Remote-User) when explicitly enabled
    if (config.proxyAuth) {
      const remoteUser = req.headers['remote-user'] as string | undefined;
      if (remoteUser) {
        res.locals.user = {
          username: remoteUser,
          name: req.headers['remote-name'] as string | undefined,
          email: req.headers['remote-email'] as string | undefined,
          groups: req.headers['remote-groups'] as string | undefined,
        };
        next();
        return;
      }
    }

    // Unauthorized — branch on client type.
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/html')) {
      res.redirect(302, '/login');
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  })().catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'Internal auth error' });
  });
}
