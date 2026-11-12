/**
 * Dashboard browser-hardening middleware: Content-Security-Policy + CSRF.
 *
 * Mounted ONCE in `src/index.ts` as `app.use('/dashboard', dashboardSecurityMiddleware)`
 * BEFORE any `/dashboard/*` route (including the read-only-vault REST routes that
 * live in index.ts), so every state-changing dashboard request is covered.
 *
 * CSRF model (synchronizer token, stateless):
 *   token = HMAC-SHA256(processSecret, binding)
 *   binding = the session cookie value (password login) or `remote-user:<name>`
 *   (forward-auth). The token is rendered into `<meta name="csrf-token">` by the
 *   page route and sent back by the client in the `X-CSRF-Token` header on every
 *   non-GET request (core.js patches `fetch` for same-origin calls).
 *
 * Only *ambient* browser credentials need CSRF protection. A request that
 * authenticates with an explicit `Authorization` header (API key / OAuth JWT)
 * cannot be forged cross-site, so it is exempt. A request with no ambient
 * credential at all is passed through and rejected by `dashboardAuthMiddleware`.
 *
 * The CORS middleware does not list `X-CSRF-Token` in Allow-Headers, so a
 * cross-origin page cannot even send the header.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { readCookie, SESSION_COOKIE_NAME } from '../auth.js';
import { config } from '../config.js';

const SECRET = crypto.randomBytes(32);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

/**
 * CSP for the no-build ES-module dashboard. No inline <script>, no inline event
 * handlers (they were migrated to `data-cx-*` delegation in core.js), no eval.
 * `style-src 'unsafe-inline'` stays because fragments use `style=""` attributes.
 * `obsidian:` is not a fetch target, so links to it need no directive.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** The ambient-credential binding for this request, or null when there is none. */
function bindingFor(req: Request): string | null {
  const session = readCookie(req, SESSION_COOKIE_NAME);
  if (session) return `session:${session}`;
  if (config.proxyAuth) {
    const remoteUser = req.headers['remote-user'];
    if (typeof remoteUser === 'string' && remoteUser) return `remote-user:${remoteUser}`;
  }
  return null;
}

/** CSRF token for the current request's browser credential ('' when none). */
export function csrfTokenFor(req: Request): string {
  const binding = bindingFor(req);
  if (!binding) return '';
  return crypto.createHmac('sha256', SECRET).update(binding).digest('base64url');
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** True when a state-changing request carries a valid CSRF token (or is exempt). */
export function csrfOk(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  // Explicit bearer credential → not forgeable cross-site.
  if (typeof req.headers.authorization === 'string' && req.headers.authorization) return true;
  const expected = csrfTokenFor(req);
  if (!expected) return true; // no ambient credential: auth middleware will 401
  const got = req.headers[CSRF_HEADER];
  return typeof got === 'string' && tokensEqual(got, expected);
}

export function dashboardSecurityMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', DASHBOARD_CSP);
  if (!csrfOk(req)) {
    res.status(403).json({ error: 'CSRF token missing or invalid — reload the dashboard and retry.' });
    return;
  }
  next();
}
