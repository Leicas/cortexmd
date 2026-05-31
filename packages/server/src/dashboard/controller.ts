/**
 * THE CONTROLLER. Builds & exports `dashboardRouter` (express.Router) and mounts
 * every route group: page + assets, SSE, admin actions, GET-json data. Each
 * group registrar attaches thin handlers that delegate to model/ and views/.
 * See ARCHITECTURE.md §1.
 */
import { Router } from 'express';
import { registerPageRoutes } from './routes/page.js';
import { registerSseRoutes } from './routes/sse.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerDataRoutes } from './routes/data.js';

export const dashboardRouter = Router();

registerActionRoutes(dashboardRouter);
registerDataRoutes(dashboardRouter);
registerSseRoutes(dashboardRouter);
registerPageRoutes(dashboardRouter);
