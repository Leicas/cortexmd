import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { csrfOk, csrfTokenFor, dashboardSecurityMiddleware, DASHBOARD_CSP } from '../security.js';

function req(over: { method?: string; cookie?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...(over.headers ?? {}) };
  if (over.cookie) headers.cookie = over.cookie;
  return { method: over.method ?? 'POST', headers } as unknown as Request;
}

describe('dashboard CSRF', () => {
  it('lets safe methods through', () => {
    expect(csrfOk(req({ method: 'GET', cookie: 'cortexmd_session=abc' }))).toBe(true);
  });

  it('rejects a cookie-authenticated POST without (or with a wrong) token', () => {
    expect(csrfOk(req({ cookie: 'cortexmd_session=abc' }))).toBe(false);
    expect(csrfOk(req({ cookie: 'cortexmd_session=abc', headers: { 'x-csrf-token': 'nope' } }))).toBe(false);
  });

  it('accepts the token bound to the same session, not another session', () => {
    const token = csrfTokenFor(req({ cookie: 'cortexmd_session=abc' }));
    expect(token).toBeTruthy();
    expect(csrfOk(req({ cookie: 'cortexmd_session=abc', headers: { 'x-csrf-token': token } }))).toBe(true);
    expect(csrfOk(req({ cookie: 'cortexmd_session=other', headers: { 'x-csrf-token': token } }))).toBe(false);
  });

  it('exempts explicit bearer credentials and credential-less requests', () => {
    expect(csrfOk(req({ cookie: 'cortexmd_session=abc', headers: { authorization: 'Bearer k' } }))).toBe(true);
    expect(csrfOk(req())).toBe(true); // auth middleware will 401 it
  });

  it('middleware sets the CSP and answers 403 on a failed check', () => {
    const headers: Record<string, string> = {};
    let status = 0;
    let nextCalled = false;
    const res = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status(code: number) { status = code; return this; },
      json() { return this; },
    } as unknown as Response;
    dashboardSecurityMiddleware(req({ cookie: 'cortexmd_session=abc' }), res, () => { nextCalled = true; });
    expect(headers['Content-Security-Policy']).toBe(DASHBOARD_CSP);
    expect(DASHBOARD_CSP).toContain("script-src 'self'");
    expect(DASHBOARD_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(status).toBe(403);
    expect(nextCalled).toBe(false);
  });
});
