import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Must set env before any import that loads config / resolves the machine id.
process.env.API_KEY = 'test-key-for-unit-tests';
process.env.MACHINE_ID = 'server-box';

const tmpDir = mkdtempSync(join(tmpdir(), 'idxreq-test-'));

// Point the code DB at a throwaway dir. Only the fields these helpers touch
// are needed on the mocked config.
vi.mock('../../config.js', () => ({
  config: {
    dataDir: tmpDir,
    logLevel: 'silent',
  },
}));

const { getCodeDb, closeCodeDb } = await import('../code-nav/db.js');
const {
  getRepoLocality,
  enqueueIndexRequestsForRepo,
  claimPendingRequests,
  completeIndexRequests,
  failIndexRequest,
  MAX_INDEX_ATTEMPTS,
} = await import('../code-nav/index-requests.js');

const REPO_ID = 'a'.repeat(16);
const SERVER = 'server-box';
const OWNER = 'win-dev';

/** Seed one repo with a checkout on the owning machine + the server machine. */
function seed(now: number): void {
  const db = getCodeDb();
  db.prepare(
    `INSERT INTO repos (id, slug, git_origin, first_commit_sha, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(REPO_ID, 'dashboard-pm', 'git@example.com:x/dashboard-pm.git', 'f'.repeat(40), now);
  const insPath = db.prepare(
    `INSERT INTO repo_paths (repo_id, machine_id, abs_path, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  );
  insPath.run(REPO_ID, OWNER, '/c/Codes/dashboard-pm', now - 1000, now); // newest-seen
  insPath.run(REPO_ID, SERVER, '/app/data/dashboard-pm', now - 5000, now - 5000);
  db.prepare(
    `INSERT INTO files (repo_id, relative_path, content_hash, language, size_bytes, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(REPO_ID, 'src/a.ts', 'h', 'typescript', 10, now - 2000);
}

describe('code-nav index-requests queue', () => {
  beforeEach(() => {
    closeCodeDb();
    rmSync(join(tmpDir, 'code.db'), { force: true });
    rmSync(join(tmpDir, 'code.db-wal'), { force: true });
    rmSync(join(tmpDir, 'code.db-shm'), { force: true });
    seed(1_000_000);
  });

  afterEach(() => {
    closeCodeDb();
  });

  it('reports locality with freshness, newest-seen first', () => {
    const loc = getRepoLocality(REPO_ID);
    expect(loc.map((l) => l.machineId)).toEqual([OWNER, SERVER]);
    expect(loc[0].lastIndexedAt).toBe(1_000_000 - 2000);
  });

  it('enqueues only non-server machines and dedupes outstanding requests', () => {
    const first = enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_001);
    expect(first.enqueued).toEqual([OWNER]);
    expect(first.alreadyPending).toEqual([]);

    // Server's own machine is never enqueued.
    expect(first.enqueued).not.toContain(SERVER);

    const second = enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_002);
    expect(second.enqueued).toEqual([]);
    expect(second.alreadyPending).toEqual([OWNER]);
  });

  it('claim flips pending→claimed and keeps the request outstanding', () => {
    enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_001);
    const claimed = claimPendingRequests(OWNER, 10, 1_000_010);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('claimed');
    expect(claimed[0].abs_path).toBe('/c/Codes/dashboard-pm');

    // A claimed request still blocks a duplicate enqueue.
    const again = enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_011);
    expect(again.enqueued).toEqual([]);
    expect(again.alreadyPending).toEqual([OWNER]);

    // ...and is invisible to a second poll.
    expect(claimPendingRequests(OWNER, 10, 1_000_012)).toHaveLength(0);
  });

  it('completion clears outstanding requests and allows re-enqueue', () => {
    enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_001);
    claimPendingRequests(OWNER, 10, 1_000_010);

    const cleared = completeIndexRequests(REPO_ID, OWNER, 1_000_020);
    expect(cleared).toBe(1);

    // Now a fresh request can be enqueued again (the loop can re-fire later).
    const reEnqueue = enqueueIndexRequestsForRepo(REPO_ID, 'miss-again', 1_000_021);
    expect(reEnqueue.enqueued).toEqual([OWNER]);
  });

  it('reclaims a stale claimed request so an abandoned claim self-heals', () => {
    enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_001);
    const first = claimPendingRequests(OWNER, 10, 1_000_010, 1000);
    expect(first).toHaveLength(1);

    // Within the reclaim window — not yet reclaimable.
    expect(claimPendingRequests(OWNER, 10, 1_000_500, 1000)).toHaveLength(0);

    // Past the reclaim window (claimed_at 1_000_010, now 1_002_000, window 1000ms).
    const reclaimed = claimPendingRequests(OWNER, 10, 1_002_000, 1000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].repo_id).toBe(REPO_ID);
  });

  it('counts attempts on every claim/reclaim and exposes attempts/last_error on the row', () => {
    enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_001);
    const first = claimPendingRequests(OWNER, 10, 1_000_010, 1000);
    expect(first[0].attempts).toBe(1);
    expect(first[0].last_error).toBeNull();
    const second = claimPendingRequests(OWNER, 10, 1_002_000, 1000);
    expect(second[0].attempts).toBe(2);
    // Persisted, not just decorated on the returned row.
    const row = getCodeDb().prepare(`SELECT attempts FROM index_requests WHERE id=?`).get(first[0].id) as { attempts: number };
    expect(row.attempts).toBe(2);
  });

  it('flips to failed after MAX_INDEX_ATTEMPTS reclaims, never re-serves it, and allows a fresh enqueue', () => {
    expect(MAX_INDEX_ATTEMPTS).toBe(3);
    enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_001);
    const window = 1000;
    let now = 1_000_010;
    const served: number[] = [];
    // Serve it MAX times (claim + reclaims), each past the reclaim window.
    for (let i = 0; i < MAX_INDEX_ATTEMPTS; i++) {
      const got = claimPendingRequests(OWNER, 10, now, window);
      expect(got).toHaveLength(1);
      expect(got[0].attempts).toBe(i + 1);
      served.push(got[0].id);
      now += window * 2;
    }
    // The next stale poll must NOT re-serve it: it is flipped to 'failed'.
    expect(claimPendingRequests(OWNER, 10, now, window)).toHaveLength(0);
    const row = getCodeDb()
      .prepare(`SELECT status, attempts, last_error, completed_at FROM index_requests WHERE id=?`)
      .get(served[0]) as { status: string; attempts: number; last_error: string | null; completed_at: number | null };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAX_INDEX_ATTEMPTS);
    expect(row.last_error).toMatch(/exhausted/);
    expect(row.completed_at).toBe(now);
    // Still not served on later polls, however stale.
    now += window * 100;
    expect(claimPendingRequests(OWNER, 10, now, window)).toHaveLength(0);

    // 'failed' is outside the partial unique index → a fresh row can be enqueued.
    const fresh = enqueueIndexRequestsForRepo(REPO_ID, 'miss-again', now + 1);
    expect(fresh.enqueued).toEqual([OWNER]);
    const again = claimPendingRequests(OWNER, 10, now + 2, window);
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(served[0]);
    expect(again[0].attempts).toBe(1);
  });

  it('failIndexRequest records last_error, keeps the row claimed until attempts are exhausted, then fails it', () => {
    enqueueIndexRequestsForRepo(REPO_ID, 'miss', 1_000_001);
    const window = 1000;
    const req = { abs_path: '/c/Codes/dashboard-pm', machine_id: OWNER };

    // No outstanding claim for an unknown path → null.
    expect(failIndexRequest({ abs_path: '/nope', machine_id: OWNER }, 'x', 1_000_005)).toBeNull();

    const c1 = claimPendingRequests(OWNER, 10, 1_000_010, window);
    expect(c1).toHaveLength(1);
    const f1 = failIndexRequest(req, 'parser crashed', 1_000_011);
    expect(f1).toEqual({ id: c1[0].id, attempts: 1, status: 'claimed' });
    // Within the reclaim window it is still not re-served...
    expect(claimPendingRequests(OWNER, 10, 1_000_500, window)).toHaveLength(0);
    // ...and the error is now visible on the row when it is reclaimed.
    const c2 = claimPendingRequests(OWNER, 10, 1_002_000, window);
    expect(c2).toHaveLength(1);
    expect(c2[0].attempts).toBe(2);
    expect(c2[0].last_error).toBe('parser crashed');
    expect(failIndexRequest(req, 'still broken', 1_002_001)).toEqual({ id: c1[0].id, attempts: 2, status: 'claimed' });

    const c3 = claimPendingRequests(OWNER, 10, 1_004_000, window);
    expect(c3[0].attempts).toBe(3);
    // Third failure exhausts the budget → failed immediately (no reclaim wait).
    const f3 = failIndexRequest(req, 'gave up', 1_004_001);
    expect(f3).toEqual({ id: c1[0].id, attempts: 3, status: 'failed' });
    const row = getCodeDb()
      .prepare(`SELECT status, last_error FROM index_requests WHERE id=?`)
      .get(c1[0].id) as { status: string; last_error: string | null };
    expect(row).toEqual({ status: 'failed', last_error: 'gave up' });
    // Never re-served, and a subsequent fail call finds no outstanding row.
    expect(claimPendingRequests(OWNER, 10, 1_010_000, window)).toHaveLength(0);
    expect(failIndexRequest(req, 'late', 1_010_001)).toBeNull();
    // Fresh enqueue is allowed afterwards.
    expect(enqueueIndexRequestsForRepo(REPO_ID, 'miss-again', 1_010_002).enqueued).toEqual([OWNER]);
  });
});
