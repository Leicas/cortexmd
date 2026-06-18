import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpDir = mkdtempSync(join(tmpdir(), 'symsearch-test-'));

// Set env before importing the real config so it initializes fully against our
// throwaway data dir (mocking config too narrowly breaks code-nav.ts's
// transitive imports, which read several config fields at module load).
process.env.API_KEY = 'test-key-for-unit-tests';
process.env.DASHBOARD_PASSWORD = 'test-dashboard';
process.env.DATA_DIR = tmpDir;
process.env.MACHINE_ID = 'server-box';

const { getCodeDb, closeCodeDb } = await import('../code-nav/db.js');
const { registerCodeSymbolSearch } = await import('../../tools/code-nav.js');

const REPO_ID = 'd'.repeat(16);
const SERVER = 'server-box';
const OWNER = 'WIN-DEV';

/**
 * Capture the wrapped handler that registerCodeSymbolSearch registers, by
 * passing a minimal fake McpServer whose `.tool()` just stashes the callback.
 */
function captureSearchHandler(): (args: Record<string, unknown>) => Promise<any> {
  let handler: ((args: any, extra: unknown) => Promise<any>) | null = null;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: any) => {
      handler = h;
    },
  };
  registerCodeSymbolSearch(fakeServer as any);
  if (!handler) throw new Error('handler not registered');
  return (args: Record<string, unknown>) => handler!(args, {});
}

/** Seed a repo whose only checkout lives on the OWNER machine (not the server). */
function seedRepoOnOtherMachine(now: number): void {
  const db = getCodeDb();
  db.prepare(
    `INSERT INTO repos (id, slug, git_origin, first_commit_sha, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(REPO_ID, 'dashboard-pm', 'git@example.com:x/dashboard-pm.git', 'a'.repeat(40), now);
  db.prepare(
    `INSERT INTO repo_paths (repo_id, machine_id, abs_path, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(REPO_ID, OWNER, '/c/Codes/dashboard-pm', now - 1000, now);
  db.prepare(
    `INSERT INTO files (repo_id, relative_path, content_hash, language, size_bytes, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(REPO_ID, 'src/a.ts', 'h', 'typescript', 10, now - 2000);
  // One searchable symbol so the "match" path can be exercised too.
  db.prepare(
    `INSERT INTO symbols (id, repo_id, relative_path, name, kind, qualified_name, signature, docstring, start_line, end_line, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('e'.repeat(16), REPO_ID, 'src/a.ts', 'existingSymbol', 'function', 'existingSymbol', null, null, 1, 5, 'h');
}

describe('code_symbol_search machine-aware staleness diagnostic', () => {
  beforeEach(() => {
    closeCodeDb();
    for (const f of ['code.db', 'code.db-wal', 'code.db-shm']) rmSync(join(tmpDir, f), { force: true });
    seedRepoOnOtherMachine(1_000_000);
  });

  afterEach(() => closeCodeDb());

  it('on an empty repo-filtered search, returns a machine-aware hint, requests a re-index, and enqueues it', async () => {
    const search = captureSearchHandler();
    const res = await search({ query: 'enqueueIndexRequestsForRepo', repo: 'dashboard-pm' });
    const payload = JSON.parse(res.content[0].text);

    expect(payload.results).toEqual([]);
    // Names the owning machine, not the server, and asks the agent to retry.
    expect(payload.hint).toMatch(/indexed from machine WIN-DEV/);
    expect(payload.hint).toMatch(/not this server \(server-box\)/);
    expect(payload.hint).toMatch(/re-index has been requested/);
    expect(payload.reindexRequested).toEqual([OWNER]);

    // The request was actually enqueued for the owning machine.
    const row = getCodeDb()
      .prepare(`SELECT machine_id, status, abs_path FROM index_requests WHERE repo_id=?`)
      .get(REPO_ID) as { machine_id: string; status: string; abs_path: string } | undefined;
    expect(row).toMatchObject({ machine_id: OWNER, status: 'pending', abs_path: '/c/Codes/dashboard-pm' });
  });

  it('does not enqueue or hint when the search actually matches', async () => {
    const search = captureSearchHandler();
    const res = await search({ query: 'existingSymbol', repo: 'dashboard-pm' });
    const payload = JSON.parse(res.content[0].text);

    expect(payload.results.length).toBe(1);
    expect(payload.results[0].name).toBe('existingSymbol');
    expect(payload.reindexRequested).toBeUndefined();
    expect(payload.hint).toBeUndefined();

    const count = (getCodeDb()
      .prepare(`SELECT COUNT(*) c FROM index_requests`)
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('does not enqueue when the repo is unfiltered (ambiguous which repo to re-index)', async () => {
    const search = captureSearchHandler();
    const res = await search({ query: 'somethingNotPresentAnywhere' });
    const payload = JSON.parse(res.content[0].text);

    expect(payload.results).toEqual([]);
    expect(payload.reindexRequested).toBeUndefined();
    expect(payload.hint).toMatch(/any registered repo/);

    const count = (getCodeDb()
      .prepare(`SELECT COUNT(*) c FROM index_requests`)
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
