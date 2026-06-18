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
});
