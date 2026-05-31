import { logger } from './logger.js';

/**
 * Minimal internal scheduler for background jobs (dream cycle, temperature
 * refresh, etc.). Supports two trigger styles:
 *
 *   - intervalMs: fire every N milliseconds (first fire happens after the
 *     interval elapses, or immediately if `runOnStart` is set)
 *   - cron: a simple "M H * * *" style string — currently only the "M H"
 *     fields are honored (i.e. daily at HH:MM local time). Anything more
 *     exotic should use intervalMs until we bolt on a real cron parser.
 *
 * Overlap is prevented per-job: if the previous run is still in flight when
 * the next tick fires, the new tick logs a skip and does not launch the
 * handler. This keeps slow jobs (dream cycles that read thousands of files)
 * from stacking.
 */

export interface JobSpec {
  name: string;
  handler: () => Promise<void>;
  intervalMs?: number;
  /** "M H * * *" — only minute+hour are honored; other fields must be "*". */
  cron?: string;
  /** If true, run once immediately on registration (useful for interval jobs). */
  runOnStart?: boolean;
}

interface JobState {
  spec: JobSpec;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  // Track whether a handler is currently running to prevent overlap
  running: boolean;
  lastRunAt?: number;
  lastRunDurationMs?: number;
  lastError?: string;
  runCount: number;
  skipCount: number;
}

const jobs = new Map<string, JobState>();

/**
 * Parse a limited cron expression of the form "M H * * *".
 * Returns {minute, hour} or null if unsupported.
 */
function parseSimpleCron(expr: string): { minute: number; hour: number } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  const minute = Number(m);
  const hour = Number(h);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return { minute, hour };
}

/**
 * Compute the milliseconds until the next local-time HH:MM from `from`.
 */
function msUntilNextDaily(hour: number, minute: number, from: Date = new Date()): number {
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    // Already passed today — schedule for tomorrow
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - from.getTime();
}

/**
 * Run a job's handler once, guarding against overlap and swallowing errors
 * so one bad run doesn't kill the scheduler.
 */
async function runJobOnce(name: string): Promise<void> {
  const state = jobs.get(name);
  if (!state) return;
  if (state.running) {
    state.skipCount++;
    logger.warn(`Scheduled job ${name} skipped — previous run still in flight`, {
      skipCount: state.skipCount,
    });
    return;
  }
  state.running = true;
  const start = Date.now();
  try {
    await state.spec.handler();
    state.lastError = undefined;
    logger.info(`Scheduled job ${name} completed`, {
      durationMs: Date.now() - start,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    logger.error(`Scheduled job ${name} failed`, { error: msg });
  } finally {
    state.running = false;
    state.lastRunAt = start;
    state.lastRunDurationMs = Date.now() - start;
    state.runCount++;
  }
}

/**
 * Register a scheduled job. Idempotent — re-registering under the same name
 * cancels the previous timer first.
 */
export function registerJob(spec: JobSpec): void {
  // Cancel any existing job with this name
  cancelJob(spec.name);

  if (!spec.intervalMs && !spec.cron) {
    throw new Error(`Job ${spec.name}: must specify either intervalMs or cron`);
  }

  let timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

  if (spec.cron) {
    const parsed = parseSimpleCron(spec.cron);
    if (!parsed) {
      throw new Error(
        `Job ${spec.name}: unsupported cron "${spec.cron}" — only "M H * * *" is supported`,
      );
    }
    // Schedule initial delay, then reschedule each fire
    const scheduleNext = (): void => {
      const delay = msUntilNextDaily(parsed.hour, parsed.minute);
      timer = setTimeout(async () => {
        await runJobOnce(spec.name);
        // Reschedule for the next occurrence
        if (jobs.has(spec.name)) {
          scheduleNext();
          const state = jobs.get(spec.name)!;
          state.timer = timer;
        }
      }, delay);
      if ((timer as NodeJS.Timeout).unref) (timer as NodeJS.Timeout).unref();
    };
    scheduleNext();
    logger.info(`Scheduler: registered ${spec.name} at ${spec.cron} (next fire in ${Math.round(msUntilNextDaily(parsed.hour, parsed.minute) / 1000)}s)`);
  } else {
    const intervalMs = spec.intervalMs!;
    timer = setInterval(() => {
      void runJobOnce(spec.name);
    }, intervalMs);
    if ((timer as NodeJS.Timeout).unref) (timer as NodeJS.Timeout).unref();
    logger.info(`Scheduler: registered ${spec.name} every ${intervalMs}ms`);
  }

  const state: JobState = {
    spec,
    timer: timer!,
    running: false,
    runCount: 0,
    skipCount: 0,
  };
  jobs.set(spec.name, state);

  if (spec.runOnStart) {
    // Fire in the background so registration doesn't block
    setImmediate(() => {
      void runJobOnce(spec.name);
    });
  }
}

/**
 * Cancel a scheduled job by name. Returns true if it was found and cancelled.
 */
export function cancelJob(name: string): boolean {
  const state = jobs.get(name);
  if (!state) return false;
  clearTimeout(state.timer as NodeJS.Timeout);
  clearInterval(state.timer as NodeJS.Timeout);
  jobs.delete(name);
  return true;
}

/**
 * Cancel all scheduled jobs. Called on graceful shutdown.
 */
export function stopAllJobs(): void {
  for (const name of [...jobs.keys()]) {
    cancelJob(name);
  }
}

export interface JobStatus {
  name: string;
  running: boolean;
  runCount: number;
  skipCount: number;
  lastRunAt?: number;
  lastRunDurationMs?: number;
  lastError?: string;
  intervalMs?: number;
  cron?: string;
}

/**
 * Snapshot of all registered jobs, useful for /metrics or dashboard.
 */
export function listJobs(): JobStatus[] {
  const out: JobStatus[] = [];
  for (const [name, state] of jobs) {
    out.push({
      name,
      running: state.running,
      runCount: state.runCount,
      skipCount: state.skipCount,
      lastRunAt: state.lastRunAt,
      lastRunDurationMs: state.lastRunDurationMs,
      lastError: state.lastError,
      intervalMs: state.spec.intervalMs,
      cron: state.spec.cron,
    });
  }
  return out;
}
