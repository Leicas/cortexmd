/**
 * Guidance-pack routes for the dashboard tab: the REST handlers from
 * lib/guidance-packs/rest.ts mounted under /dashboard/api/guidance. Auth and
 * CSRF come from the `/dashboard` mounts in index.ts (dashboardSecurityMiddleware
 * runs before every /dashboard/* route, so each POST/DELETE needs the token).
 */
import type { Router } from 'express';
import { registerGuidanceRoutes } from '../../lib/guidance-packs/rest.js';

export function registerGuidanceDashboardRoutes(router: Router): void {
  registerGuidanceRoutes(router, '/dashboard/api/guidance');
}
