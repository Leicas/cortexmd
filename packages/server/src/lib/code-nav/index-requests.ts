import type BetterSqlite3 from 'better-sqlite3';
import { getCodeDb } from './db.js';
import { getMachineId } from './repos.js';
import { logger } from '../logger.js';

/**
 * Proxy-indexing work queue.
 *
 * The server's `code.db` is per-machine, but in the common remote/containerized
 * deployment the symbols are pushed by a *different* machine's CLI (the one that
 * owns the source checkout). When a code-nav query comes up stale or empty for
 * such a repo, there is nothing the server can re-index itself — the source tree
 * isn't mounted. Instead it enqueues a request here for the owning machine(s),
 * whose long-lived hud-line daemon polls and fulfills it (re-index + push back
 * through `code_ingest_repo`). This module is the queue's data access layer.
 */

export interface IndexRequestRow {
  id: number;
  repo_id: string;
  machine_id: string;
  abs_path: string;
  reason: string | null;
  status: string;
  requested_at: number;
  claimed_at: number | null;
  completed_at: number | null;
  /** Times this request has been served to a daemon (claim + reclaims). */
  attempts: number;
  /** Last error reported by the daemon (via `failIndexRequest`), if any. */
  last_error: string | null;
}

/** A machine that owns a checkout of a repo, with index freshness metadata. */
export interface RepoLocality {
  machineId: string;
  absPath: string;
  lastSeenAt: number;
  /** Newest `files.indexed_at` for this repo (machine-independent). */
  lastIndexedAt: number | null;
}

/**
 * Return every registered checkout location for `repoId`, newest-seen first,
 * each annotated with the repo's most-recent index timestamp. Used both to
 * build machine-aware staleness diagnostics and to decide which machines to
 * enqueue a re-index for.
 */
export function getRepoLocality(repoId: string, db: BetterSqlite3.Database = getCodeDb()): RepoLocality[] {
  const lastIndexedRow = db
    .prepare(`SELECT MAX(indexed_at) AS last FROM files WHERE repo_id=?`)
    .get(repoId) as { last: number | null } | undefined;
  const lastIndexedAt = lastIndexedRow?.last ?? null;

  const rows = db
    .prepare(
      `SELECT machine_id, abs_path, last_seen_at
         FROM repo_paths
        WHERE repo_id=?
        ORDER BY last_seen_at DESC`,
    )
    .all(repoId) as Array<{ machine_id: string; abs_path: string; last_seen_at: number }>;

  return rows.map((r) => ({
    machineId: r.machine_id,
    absPath: r.abs_path,
    lastSeenAt: r.last_seen_at,
    lastIndexedAt,
  }));
}

/**
 * Enqueue a pending re-index request for every machine that owns a checkout of
 * `repoId` *other than this server's own machine* (re-indexing locally is the
 * job of `code_index_repo`, not this queue). The partial unique index dedupes
 * against any already-outstanding request for the same (repo, machine), so this
 * is safe to call on every stale/empty query. Returns the machines actually
 * enqueued (those with a fresh insert) plus the ones already outstanding.
 */
export function enqueueIndexRequestsForRepo(
  repoId: string,
  reason: string,
  nowMs: number,
  db: BetterSqlite3.Database = getCodeDb(),
): { enqueued: string[]; alreadyPending: string[] } {
  const serverMachine = getMachineId();
  const locality = getRepoLocality(repoId, db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO index_requests
       (repo_id, machine_id, abs_path, reason, status, requested_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  );

  const enqueued: string[] = [];
  const alreadyPending: string[] = [];
  const tx = db.transaction(() => {
    for (const loc of locality) {
      if (loc.machineId === serverMachine) continue; // server can index itself
      const res = insert.run(repoId, loc.machineId, loc.absPath, reason, nowMs);
      if (res.changes > 0) enqueued.push(loc.machineId);
      else alreadyPending.push(loc.machineId);
    }
  });
  tx();

  if (enqueued.length > 0) {
    logger.info('Enqueued proxy-index requests', { repoId, reason, machines: enqueued });
  }
  return { enqueued, alreadyPending };
}

/**
 * How long a 'claimed' request may sit unfulfilled before it is considered
 * abandoned and becomes claimable again. Covers a daemon that died mid-index or
 * claimed a request whose checkout has since gone missing — without this, a
 * stuck claim would block re-enqueue forever (partial unique index). Generous
 * relative to a normal re-index so we don't double-fulfill in-flight work.
 */
export const RECLAIM_AFTER_MS = 5 * 60 * 1000;

/**
 * Maximum number of times a request is served (initial claim + reclaims)
 * before it is flipped to `status='failed'` and never re-served. Without a cap,
 * a request whose checkout is permanently broken (path gone, parser crash) was
 * reclaimed and re-served every `RECLAIM_AFTER_MS` forever. A 'failed' row is
 * outside the partial unique index on (repo_id, machine_id), so a later stale
 * query can enqueue a fresh row and the loop gets another MAX attempts.
 */
export const MAX_INDEX_ATTEMPTS = 3;

/**
 * Atomically claim up to `limit` requests for `machineId`, flipping them to
 * 'claimed'. Returns the claimed rows so the caller (the owning daemon) can act
 * on them. Picks up both fresh 'pending' rows and stale 'claimed' rows (claimed
 * longer ago than `reclaimAfterMs`) so an abandoned claim self-heals on a later
 * poll. Claiming — rather than deleting — keeps the request visible for
 * observability and lets `completeIndexRequests` mark the lifecycle end.
 *
 * Every claim/reclaim increments `attempts`. A stale 'claimed' row that has
 * already been served `MAX_INDEX_ATTEMPTS` times is flipped to 'failed' instead
 * of being re-served (I-3).
 */
export function claimPendingRequests(
  machineId: string,
  limit: number,
  nowMs: number,
  reclaimAfterMs: number = RECLAIM_AFTER_MS,
  db: BetterSqlite3.Database = getCodeDb(),
): IndexRequestRow[] {
  const staleBefore = nowMs - reclaimAfterMs;
  const claim = db.transaction((): IndexRequestRow[] => {
    // Exhausted stale claims → failed (never re-served).
    const exhausted = db
      .prepare(
        `UPDATE index_requests
            SET status='failed', completed_at=?,
                last_error=COALESCE(last_error, 'exhausted ' || attempts || ' attempts without completion')
          WHERE machine_id=? AND status='claimed' AND claimed_at < ? AND attempts >= ?`,
      )
      .run(nowMs, machineId, staleBefore, MAX_INDEX_ATTEMPTS);
    if (exhausted.changes > 0) {
      logger.warn('Proxy-index requests exhausted their attempts', {
        machineId, count: exhausted.changes, maxAttempts: MAX_INDEX_ATTEMPTS,
      });
    }

    const claimable = db
      .prepare(
        `SELECT * FROM index_requests
          WHERE machine_id=?
            AND (status='pending' OR (status='claimed' AND claimed_at < ?))
          ORDER BY requested_at ASC
          LIMIT ?`,
      )
      .all(machineId, staleBefore, limit) as IndexRequestRow[];
    if (claimable.length === 0) return [];
    const mark = db.prepare(
      `UPDATE index_requests SET status='claimed', claimed_at=?, attempts=attempts+1 WHERE id=?`,
    );
    for (const r of claimable) mark.run(nowMs, r.id);
    return claimable.map((r) => ({
      ...r,
      status: 'claimed',
      claimed_at: nowMs,
      attempts: (r.attempts ?? 0) + 1,
    }));
  });
  return claim();
}

/** Result of {@link failIndexRequest}. */
export interface FailIndexRequestResult {
  id: number;
  attempts: number;
  /** 'claimed' when the request will be re-served after the reclaim window; 'failed' when exhausted. */
  status: 'claimed' | 'failed';
}

/**
 * Record a daemon-side failure for the outstanding request matching
 * (`machine_id`, `abs_path`) — I-3. Stores `last_error`; if the row has already
 * been served `MAX_INDEX_ATTEMPTS` times it is flipped to 'failed' right away
 * (no need to wait for the reclaim window to expire), otherwise it stays
 * 'claimed' and becomes claimable again after `RECLAIM_AFTER_MS`. Does NOT
 * increment `attempts` (the claim that served the request already did).
 * Returns `null` when there is no outstanding (pending|claimed) row.
 */
export function failIndexRequest(
  req: { abs_path: string; machine_id: string },
  error: string,
  nowMs: number,
  db: BetterSqlite3.Database = getCodeDb(),
): FailIndexRequestResult | null {
  const message = String(error ?? '').slice(0, 2000);
  const tx = db.transaction((): FailIndexRequestResult | null => {
    const row = db
      .prepare(
        `SELECT id, attempts FROM index_requests
          WHERE machine_id=? AND abs_path=? AND status IN ('pending','claimed')
          ORDER BY requested_at DESC
          LIMIT 1`,
      )
      .get(req.machine_id, req.abs_path) as { id: number; attempts: number } | undefined;
    if (!row) return null;
    const attempts = row.attempts ?? 0;
    if (attempts >= MAX_INDEX_ATTEMPTS) {
      db.prepare(
        `UPDATE index_requests SET status='failed', last_error=?, completed_at=? WHERE id=?`,
      ).run(message, nowMs, row.id);
      logger.warn('Proxy-index request failed permanently', {
        id: row.id, machineId: req.machine_id, absPath: req.abs_path, attempts, error: message,
      });
      return { id: row.id, attempts, status: 'failed' };
    }
    db.prepare(`UPDATE index_requests SET last_error=? WHERE id=?`).run(message, row.id);
    return { id: row.id, attempts, status: 'claimed' };
  });
  return tx();
}

/**
 * Mark every outstanding (pending|claimed) request for (repoId, machineId) as
 * 'done'. Called from `code_ingest_repo` after a successful push so the queue
 * self-clears the moment fresh symbols arrive. Returns the number cleared.
 */
export function completeIndexRequests(
  repoId: string,
  machineId: string,
  nowMs: number,
  db: BetterSqlite3.Database = getCodeDb(),
): number {
  const res = db
    .prepare(
      `UPDATE index_requests
          SET status='done', completed_at=?
        WHERE repo_id=? AND machine_id=? AND status IN ('pending','claimed')`,
    )
    .run(nowMs, repoId, machineId);
  return res.changes;
}
