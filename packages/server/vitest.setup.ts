// Vitest setup: provide default env so config.ts and other modules that read
// required env vars at import time do not throw under a bare `vitest run`.
// These defaults are applied ONLY in the test process and never weaken the
// production requirement enforced in src/config.ts.
process.env.API_KEY ||= 'test';
// Component A: provide a dashboard password so config.ts does not generate (and
// persist) one into the default brain vault during the test run.
process.env.DASHBOARD_PASSWORD ||= 'test-dashboard';
