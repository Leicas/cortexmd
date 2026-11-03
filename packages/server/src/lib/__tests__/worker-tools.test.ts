import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
vi.mock('../search.js', () => ({ searchNotes: vi.fn() }));
vi.mock('../vault.js', () => ({ readNote: vi.fn(), resolveSafePathForRead: vi.fn() }));
import { createWorkerTools, workerPath, withinWorkerScope } from '../worker-tools.js';
import { config } from '../../config.js';

let db: Database.Database;
let dir: string;
const signal = new AbortController().signal;
const id = 'aaaaaaaaaaaaaaaa',
  other = 'bbbbbbbbbbbbbbbb',
  outside = 'cccccccccccccccc';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'worker-tools-'));
  db = new Database(':memory:');
  db.exec(
    `CREATE TABLE repos(id TEXT,slug TEXT); CREATE TABLE repo_paths(repo_id TEXT,machine_id TEXT,abs_path TEXT); CREATE TABLE symbols(id TEXT,repo_id TEXT,relative_path TEXT,name TEXT,kind TEXT,signature TEXT,docstring TEXT,start_line INTEGER,end_line INTEGER,content_hash TEXT); CREATE TABLE files(repo_id TEXT,relative_path TEXT,content_hash TEXT,indexed_at INTEGER); CREATE TABLE calls(caller_id TEXT,callee_id TEXT); INSERT INTO repos VALUES('r1','one'),('r2','two');`,
  );
  const insert = db.prepare('INSERT INTO symbols VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run(
    id,
    'r1',
    'src/a.ts',
    'hello',
    'function',
    'hello()',
    'description',
    1,
    1,
    'symbolhash',
  );
  insert.run(other, 'r2', 'src/secret.ts', 'secret', 'function', 'secret()', null, 1, 1, 'secret');
  insert.run(
    outside,
    'r1',
    'src-other/b.ts',
    'secret',
    'function',
    'secret()',
    null,
    1,
    1,
    'secret',
  );
  db.prepare('INSERT INTO calls VALUES(?,?)').run(other, id);
  db.prepare('INSERT INTO calls VALUES(?,?)').run(outside, id);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src/a.ts'), 'function hello() {}\n');
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
describe('worker scope boundary', () => {
  it.each([
    '../secret',
    'src/../secret',
    '/etc/passwd',
    'C:\\secret',
    'src//x',
    'src/./x',
    'src\0x',
  ])('rejects unsafe path %s', (p) => expect(() => workerPath(p)).toThrow());
  it('uses directory boundaries, not a lexical prefix', () => {
    expect(withinWorkerScope('src/a.ts', ['src'])).toBe(true);
    expect(withinWorkerScope('src-other/a.ts', ['src'])).toBe(false);
  });
  it('denies write, recursive, unknown tools and extra arguments', async () => {
    const w = createWorkerTools({ mode: 'code-investigator', repo: 'one', paths: ['src'] }, { db });
    for (const name of ['notes_upsert', 'code_index_repo', 'worker_run', 'shell'])
      await expect(w.executeTool(name, {}, signal)).rejects.toThrow('not permitted');
    await expect(
      w.executeTool('code_symbol_search', { query: 'hello', repo: 'two' }, signal),
    ).rejects.toThrow();
  });
  it('search/get/call traversal cannot expose other repos or sibling paths', async () => {
    const w = createWorkerTools({ mode: 'code-investigator', repo: 'one', paths: ['src'] }, { db });
    expect(
      JSON.stringify(await w.executeTool('code_symbol_search', { query: 'secret' }, signal)),
    ).not.toContain('secret.ts');
    await expect(w.executeTool('code_symbol_get', { id: other }, signal)).rejects.toThrow('scope');
    await expect(w.executeTool('code_symbol_get', { id: outside }, signal)).rejects.toThrow(
      'scope',
    );
    await expect(
      w.executeTool('code_file_outline', { path: 'src-other/b.ts' }, signal),
    ).rejects.toThrow('scope');
    expect((await w.executeTool('code_symbol_callers', { id }, signal)).sources).toEqual([]);
    expect(db.prepare('SELECT count(*) n FROM symbols').get()).toEqual({ n: 3 });
  });
  it('reports missing server source and never claims source coverage', async () => {
    const w = createWorkerTools({ mode: 'code-investigator', repo: 'one' }, { db });
    const result = await w.executeTool('code_symbol_get', { id }, signal);
    expect(result.limitations?.join(' ')).toContain('Source unavailable');
    expect(result.content).not.toHaveProperty('body');
  });
  it('reads verified source and refuses a stale file without modifying the index', async () => {
    db.prepare('INSERT INTO repo_paths VALUES(?,?,?)').run('r1', config.machineId, dir);
    const hash = createHash('sha1').update('function hello() {}\n').digest('hex');
    db.prepare('INSERT INTO files VALUES(?,?,?,?)').run('r1', 'src/a.ts', hash, 123);
    const w = createWorkerTools({ mode: 'code-investigator', repo: 'one', paths: ['src'] }, { db });
    const fresh = await w.executeTool('code_symbol_get', { id }, signal);
    expect(fresh.content).toMatchObject({
      body: 'function hello() {}',
      fileHash: hash,
      indexedAt: 123,
    });
    expect(fresh.sources?.[0].hash).toBe(hash);
    await writeFile(path.join(dir, 'src/a.ts'), 'function changed() {}\n');
    const stale = await w.executeTool('code_symbol_get', { id }, signal);
    expect(stale.content).not.toHaveProperty('body');
    expect(stale.limitations?.join(' ')).toContain('stale');
    expect(db.prepare('SELECT content_hash FROM files').get()).toEqual({ content_hash: hash });
  });
  it('honors cancellation before any tool execution', async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      createWorkerTools({ mode: 'code-investigator', repo: 'one' }, { db }).executeTool(
        'code_symbol_search',
        { query: 'hello' },
        c.signal,
      ),
    ).rejects.toThrow();
  });
  it('requires explicit knowledge scope and filters prefix siblings', async () => {
    expect(() => createWorkerTools({ mode: 'knowledge-investigator' })).toThrow('note_paths');
    await mkdir(path.join(dir, 'Projects'));
    await writeFile(path.join(dir, 'Projects/a.md'), 'hello');
    const search = vi.fn().mockReturnValue([
      { path: 'Projects/a.md', title: 'allowed', snippet: 'yes' },
      { path: 'Projects-secret/a.md', title: 'secret', snippet: 'secret' },
    ]);
    const read = vi.fn().mockResolvedValue({ content: 'hello', etag: 'hash' });
    const resolveNote = vi.fn().mockResolvedValue(path.join(dir, 'Projects/a.md'));
    const w = createWorkerTools(
      { mode: 'knowledge-investigator', note_paths: ['Projects'] },
      { search, read, resolveNote, vaultRoots: [dir] },
    );
    const result = await w.executeTool('notes_search', { query: 'hello' }, signal);
    expect(result.content).toMatchObject({
      results: [{ path: 'Projects/a.md', title: 'allowed', snippet: 'yes' }],
    });
    await expect(
      w.executeTool('notes_get', { path: 'Projects-secret/a.md' }, signal),
    ).rejects.toThrow('scope');
    expect(read).not.toHaveBeenCalled();
    expect(await w.executeTool('notes_get', { path: 'Projects/a.md' }, signal)).toMatchObject({
      sources: [
        { path: 'Projects/a.md', hash: createHash('sha256').update('hello').digest('hex') },
      ],
    });
    expect(search.mock.calls[0][1]).toMatchObject({ rerank: false, graph: false });
  });
  it('rejects note aliases produced by the ordinary vault resolver', async () => {
    await writeFile(path.join(dir, 'a.md'), 'secret');
    const read = vi.fn();
    const w = createWorkerTools(
      { mode: 'knowledge-investigator', note_paths: ['VaultName'] },
      { read, resolveNote: vi.fn().mockResolvedValue(path.join(dir, 'a.md')), vaultRoots: [dir] },
    );
    await expect(w.executeTool('notes_get', { path: 'VaultName/a.md' }, signal)).rejects.toThrow(
      'aliases',
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects a directory junction that points outside the narrower code scope', async () => {
    await mkdir(path.join(dir, 'private'));
    await writeFile(path.join(dir, 'private/a.ts'), 'function hello() {}\n');
    await symlink(path.join(dir, 'private'), path.join(dir, 'src/alias'), 'junction');
    db.prepare('UPDATE symbols SET relative_path=? WHERE id=?').run('src/alias/a.ts', id);
    db.prepare('INSERT INTO repo_paths VALUES(?,?,?)').run('r1', config.machineId, dir);
    db.prepare('INSERT INTO files VALUES(?,?,?,?)').run(
      'r1',
      'src/alias/a.ts',
      createHash('sha1').update('function hello() {}\n').digest('hex'),
      123,
    );
    const result = await createWorkerTools(
      { mode: 'code-investigator', repo: 'one', paths: ['src'] },
      { db },
    ).executeTool('code_symbol_get', { id }, signal);
    expect(result.content).not.toHaveProperty('body');
    expect(result.limitations?.join(' ')).toContain('outside scope');
  });
  it('rejects note junctions and never invokes the note reader', async () => {
    await mkdir(path.join(dir, 'private'));
    await writeFile(path.join(dir, 'private/a.md'), 'secret');
    await symlink(path.join(dir, 'private'), path.join(dir, 'Projects'), 'junction');
    const read = vi.fn();
    const w = createWorkerTools(
      { mode: 'knowledge-investigator', note_paths: ['Projects'] },
      {
        read,
        resolveNote: vi.fn().mockResolvedValue(path.join(dir, 'Projects/a.md')),
        vaultRoots: [dir],
      },
    );
    await expect(w.executeTool('notes_get', { path: 'Projects/a.md' }, signal)).rejects.toThrow(
      'symlink',
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('accepts a configured vault root alias while preserving relative note scope', async () => {
    const vault = path.join(dir, 'actual-vault');
    const alias = path.join(dir, 'configured-vault');
    await mkdir(path.join(vault, 'Projects'), { recursive: true });
    await writeFile(path.join(vault, 'Projects/a.md'), 'verified note');
    // A root alias reproduces the canonical-vs-configured prefix difference
    // introduced by Windows short temp paths without needing 8.3 support.
    await symlink(vault, alias, 'junction');
    const w = createWorkerTools(
      { mode: 'knowledge-investigator', note_paths: ['Projects'] },
      {
        resolveNote: vi.fn().mockImplementation(async (p: string) => path.join(alias, p)),
        vaultRoots: [alias],
      },
    );
    const result = await w.executeTool('notes_get', { path: 'Projects/a.md' }, signal);
    expect(result.content).toMatchObject({ path: 'Projects/a.md', content: 'verified note' });
    await expect(w.executeTool('notes_get', { path: 'Projects-other/a.md' }, signal))
      .rejects.toThrow('scope');
  });
  it('marks filtered knowledge result truncation even below the search ceiling', async () => {
    await mkdir(path.join(dir, 'Projects'));
    const hits = await Promise.all(
      Array.from({ length: 21 }, async (_, i) => {
        await writeFile(path.join(dir, `Projects/${i}.md`), 'note');
        return { path: `Projects/${i}.md`, title: 'note', snippet: 'note' };
      }),
    );
    const w = createWorkerTools(
      { mode: 'knowledge-investigator', note_paths: ['Projects'] },
      {
        search: vi.fn().mockReturnValue(hits),
        resolveNote: vi.fn().mockImplementation(async (p: string) => path.join(dir, p)),
        vaultRoots: [dir],
      },
    );
    const result = await w.executeTool('notes_search', { query: 'note' }, signal);
    expect(result.sources).toHaveLength(20);
    expect(result.limitations).toContain('Search results truncated; refine scope or query.');
  });
  it('reads note excerpts with continuation and rejects oversized notes before loading them', async () => {
    await mkdir(path.join(dir, 'Projects'));
    await writeFile(path.join(dir, 'Projects/a.md'), 'a'.repeat(4000));
    const w = createWorkerTools(
      { mode: 'knowledge-investigator', note_paths: ['Projects'] },
      {
        resolveNote: vi.fn().mockImplementation(async (p: string) => path.join(dir, p)),
        vaultRoots: [dir],
      },
    );
    expect(
      (await w.executeTool('notes_get', { path: 'Projects/a.md' }, signal)).content,
    ).toMatchObject({ nextOffsetChars: 3000, truncated: true });
    expect(
      (await w.executeTool('notes_get', { path: 'Projects/a.md', offset_chars: 3000 }, signal))
        .content,
    ).toMatchObject({ content: 'a'.repeat(1000), nextOffsetChars: null });
    await writeFile(path.join(dir, 'Projects/a.md'), 'a'.repeat(64001));
    await expect(w.executeTool('notes_get', { path: 'Projects/a.md' }, signal)).rejects.toThrow(
      'ceiling',
    );
  });
  it('rejects a basename-prefixed alias even when its suffix matches the absolute path', async () => {
    const vault = path.join(dir, 'VaultName');
    await mkdir(vault);
    await mkdir(path.join(vault, 'Projects'));
    await writeFile(path.join(vault, 'Projects/a.md'), 'secret');
    const read = vi.fn();
    const w = createWorkerTools(
      { mode: 'knowledge-investigator', note_paths: ['VaultName/Projects'] },
      {
        read,
        resolveNote: vi.fn().mockResolvedValue(path.join(vault, 'Projects/a.md')),
        vaultRoots: [vault],
      },
    );
    await expect(
      w.executeTool('notes_get', { path: 'VaultName/Projects/a.md' }, signal),
    ).rejects.toThrow('aliases');
    expect(read).not.toHaveBeenCalled();
  });
});
