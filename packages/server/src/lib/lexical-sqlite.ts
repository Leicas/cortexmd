/**
 * SQLite/FTS5 lexical backend — an on-disk replacement for the in-RAM
 * MiniSearch index + `docMeta.content` (see docs/ARCHITECTURE.md §6).
 *
 * The markdown files stay the source of truth; this DB is a derived cache that
 * can be deleted at any time (it is rebuilt from the vault on the next sync).
 *
 * Layout (SCHEMA_VERSION 1):
 *   notes     one row per note: path, vault, mtime, content hash, filter columns,
 *             body, caller JSON `extra`
 *   note_tags (tag, note_id) — tag filter
 *   f_title / f_content / f_tags   one contentless FTS5 table PER FIELD over
 *             PRE-ANALYSED text (the shared bilingual analyzer runs in JS, like
 *             MiniSearch's processTerm; FTS5 only splits on spaces). One table
 *             per field gives per-field BM25 length normalisation and document
 *             frequencies — MiniSearch scores each field separately.
 *   v_*       fts5vocab(row) per field — document frequency + prefix expansion
 *   vocab / vgram  padded-trigram side index over alphabetic terms → fuzzy
 *   meta      schema_version, analyzer fingerprint
 *
 * Query model (parity with MiniSearch `searchOptions`): every analysed query
 * term is scored per field with FTS5 bm25(); for exact terms the tf component
 * is recovered from bm25 (÷ FTS5's idf) and re-scored with MiniSearch's BM25+
 * (idf = ln(1 + …), d = 0.5) × field boost (title 3, content 1, tags 2).
 * Prefix and fuzzy expansions are OR'd groups down-weighted like MiniSearch
 * (0.375 / 0.45 scaled by distance). Per-note sums are multiplied by the
 * number of matched query terms (MiniSearch "quality"). Filters are SQL WHERE.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { foldText } from './text-analyzer.js';
import {
  type Analyzer,
  allowPrefix,
  analyzerFingerprint,
  bilingualAnalyzer,
  boundedLevenshtein,
  encodeTerm,
  isFuzzyVocabTerm,
  maxEditDistance,
  paddedTrigrams,
} from './lexical/analyzer.js';
import { noteRecordFromMarkdown } from './lexical/record.js';
import type {
  LexicalBackend,
  LexicalFilters,
  LexicalHit,
  LexicalSearchOptions,
  LexicalStats,
  ListingEntry,
  NoteRecord,
  SyncOptions,
  SyncStats,
} from './lexical/types.js';

export const LEXICAL_SCHEMA_VERSION = 1;

/** MiniSearch defaults (`searchOptions.weights`, `bm25`) and today's field boosts. */
const PREFIX_WEIGHT = 0.375;
const FUZZY_WEIGHT = 0.45;
const FIELDS = [
  { name: 'title', boost: 3 },
  { name: 'content', boost: 1 },
  { name: 'tags', boost: 2 },
] as const;
type FieldName = (typeof FIELDS)[number]['name'];
/** MiniSearch BM25+ `d`. */
const BM25_D = 0.5;

export type AnalyzerMode =
  /** Shared JS analyzer (default): exact parity with MiniSearch's term stream. */
  | { kind: 'shared'; analyze?: Analyzer; analyzed?: boolean; id?: string }
  /** FTS5 built-in `unicode61 remove_diacritics 2` (optionally + porter) on raw text. */
  | { kind: 'native'; porter?: boolean };

export interface SqliteLexicalOptions {
  /** DB file (`:memory:` for tests). */
  dbPath: string;
  analyzer?: AnalyzerMode;
  /** Max synchronous slice during sync, ms (default 25). */
  sliceMs?: number;
  /** Keep note bodies in the DB for on-demand `getBody` (default true). */
  storeBodies?: boolean;
  /** Markdown → record (default: `noteRecordFromMarkdown`). */
  toRecord?: (relPath: string, content: string) => NoteRecord;
  /** Max prefix expansions per query term (default 64, shortest first). */
  maxPrefixExpansions?: number;
  /** Max fuzzy expansions per query term (default 32). */
  maxFuzzyExpansions?: number;
  /** Per-group candidate depth = max(limit × this, 200) (default 5). */
  depthFactor?: number;
  /** Body characters indexed per note (default 256 KiB; the rest is stored, not indexed). */
  maxIndexedChars?: number;
}

/** Bodies above this are analysed in yielding pieces of PIECE chars. */
const BIG_TEXT = 128 * 1024;
const PIECE = 64 * 1024;
/** Pages of work per FTS5 'merge' step. */
const MERGE_PAGES = 16;

interface Analysed { title: string; content: string; tags: string }
type Prepared =
  | { kind: 'touch'; id: number; e: ListingEntry }
  | { kind: 'upsert'; rec: NoteRecord; an: Analysed; sig: { vault?: string; mtimeMs?: number; hash?: string } };

function noteSlice(st: SyncStats, dur: number): void {
  if (dur > st.maxSliceMs) st.maxSliceMs = dur;
  if (dur > 50) st.slowSlices++;
}

/** WAL size that triggers a background checkpoint. */
const CHECKPOINT_WAL_BYTES = 16 * 1024 * 1024;

/**
 * Checkpointer thread. SQLite's auto-checkpoint runs inside the writer's COMMIT
 * and was the main source of 50–150 ms event-loop stalls during bulk sync, so
 * the main connection disables it and this worker (its own connection) runs
 * PASSIVE checkpoints off the event loop. PASSIVE never blocks the writer.
 */
const CHECKPOINT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.mod);
// Open per checkpoint: no long-lived handle (Windows cannot delete open files).
parentPort.on('message', () => {
  let db;
  try {
    db = new Database(workerData.path);
    db.pragma('busy_timeout = 2000');
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {}
  try { db && db.close(); } catch {}
  parentPort.postMessage('done');
});
`;

const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r));

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || /malformed|not a database/i.test(String(err));
}

export class SqliteLexicalBackend implements LexicalBackend {
  readonly name = 'sqlite';
  readonly rebuiltOnOpen: boolean;
  private db: BetterSqlite3.Database;
  private readonly dbPath: string;
  private readonly analyze: Analyzer;
  private readonly analyzed: boolean;
  private readonly native: boolean;
  private readonly analyzerId: string;
  private readonly sliceMs: number;
  private readonly storeBodies: boolean;
  private readonly toRecord: (relPath: string, content: string) => NoteRecord;
  private readonly maxPrefix: number;
  private readonly maxFuzzy: number;
  private readonly depthFactor: number;
  private readonly maxIndexedChars: number;
  private readonly searchStmts = new Map<string, BetterSqlite3.Statement>();
  private syncChain: Promise<unknown> = Promise.resolve();
  private vocabSet: Set<string> | null = null;
  private nDocs: number | undefined;
  /** Archived note ids (small) — lets unfiltered queries skip the notes join. */
  private readonly archivedIds = new Set<number>();
  private ckptWorker: Worker | null = null;
  private ckptBusy = false;
  private s!: ReturnType<SqliteLexicalBackend['prepare']>;

  constructor(opts: SqliteLexicalOptions) {
    this.dbPath = opts.dbPath;
    const mode: AnalyzerMode = opts.analyzer ?? { kind: 'shared' };
    this.native = mode.kind === 'native';
    if (mode.kind === 'shared') {
      this.analyze = mode.analyze ?? bilingualAnalyzer;
      this.analyzed = mode.analyzed ?? true;
      this.analyzerId = `shared:${mode.id ?? 'custom'}:${analyzerFingerprint(this.analyze)}`;
    } else {
      // Query-side approximation of unicode61 (fold + split); FTS re-tokenizes anyway.
      this.analyze = (t) => foldText(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      this.analyzed = false;
      this.analyzerId = mode.porter ? 'native:porter-unicode61-rd2' : 'native:unicode61-rd2';
    }
    this.sliceMs = opts.sliceMs ?? 25;
    this.storeBodies = opts.storeBodies ?? true;
    this.toRecord = opts.toRecord ?? noteRecordFromMarkdown;
    this.maxPrefix = opts.maxPrefixExpansions ?? 64;
    this.maxFuzzy = opts.maxFuzzyExpansions ?? 32;
    this.depthFactor = opts.depthFactor ?? 5;
    this.maxIndexedChars = opts.maxIndexedChars ?? 256 * 1024;

    let rebuilt: boolean;
    try {
      this.db = this.open();
      rebuilt = this.ensureSchema(mode);
    } catch (err) {
      // Derived data: a corrupt/unreadable file is simply discarded and rebuilt.
      if (this.dbPath === ':memory:' || !isCorruptionError(err)) throw err;
      // The handle may be open if open() succeeded and ensureSchema() hit the corruption.
      const half = (this as unknown as { db?: BetterSqlite3.Database }).db;
      try { if (half?.open) half.close(); } catch { /* ignore */ }
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(this.dbPath + suffix, { force: true });
      this.db = this.open();
      rebuilt = this.ensureSchema(mode);
    }
    this.rebuiltOnOpen = rebuilt;
    this.s = this.prepare();
    for (const r of this.db.prepare('SELECT id FROM notes WHERE archived = 1').all() as Array<{ id: number }>) {
      this.archivedIds.add(r.id);
    }
    if (this.dbPath !== ':memory:') this.startCheckpointer();
  }

  private open(): BetterSqlite3.Database {
    if (this.dbPath !== ':memory:') fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    try {
      this.configure(db);
    } catch (err) {
      // Close before the caller deletes the file: Windows refuses to unlink an open handle.
      db.close();
      throw err;
    }
    return db;
  }

  private startCheckpointer(): void {
    try {
      const mod = createRequire(import.meta.url).resolve('better-sqlite3');
      const w = new Worker(CHECKPOINT_WORKER, { eval: true, workerData: { mod, path: this.dbPath } });
      w.unref();
      w.on('message', () => { this.ckptBusy = false; });
      w.on('error', () => { this.ckptWorker = null; this.db.pragma('wal_autocheckpoint = 1000'); });
      this.ckptWorker = w;
      this.db.pragma('wal_autocheckpoint = 0');
      // Truncate the WAL file back to 64 MB after a checkpoint resets it.
      this.db.pragma('journal_size_limit = 67108864');
    } catch {
      this.ckptWorker = null; // keep SQLite's in-line auto-checkpoint
    }
  }

  /** Ask the checkpointer thread for a PASSIVE checkpoint once the WAL is big. */
  private maybeCheckpoint(): void {
    if (!this.ckptWorker || this.ckptBusy) return;
    let size = 0;
    try { size = fs.statSync(this.dbPath + '-wal').size; } catch { return; }
    if (size < CHECKPOINT_WAL_BYTES) return;
    this.ckptBusy = true;
    this.ckptWorker.postMessage('ckpt');
  }

  private configure(db: BetterSqlite3.Database): void {
    // Same conventions as lib/knowledge-graph.ts: WAL + synchronous=NORMAL
    // (a crash can lose the last commits, never corrupt; the DB is derived).
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    // Page cache is native memory, outside the V8 heap; bounded at ~16 MB.
    db.pragma('cache_size = -16000');
  }

  /** Create or validate the schema; drop + recreate on version/analyzer change. Returns true when (re)created. */
  private ensureSchema(mode: AnalyzerMode): boolean {
    const db = this.db;
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const get = (k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value;
    const version = get('schema_version');
    const analyzer = get('analyzer');
    if (version === String(LEXICAL_SCHEMA_VERSION) && analyzer === this.analyzerId) return false;

    db.exec(`
      DROP TABLE IF EXISTS fts_v;
      DROP TABLE IF EXISTS fts;
      DROP TABLE IF EXISTS v_title;
      DROP TABLE IF EXISTS v_content;
      DROP TABLE IF EXISTS v_tags;
      DROP TABLE IF EXISTS f_title;
      DROP TABLE IF EXISTS f_content;
      DROP TABLE IF EXISTS f_tags;
      DROP TABLE IF EXISTS vgram;
      DROP TABLE IF EXISTS vocab;
      DROP TABLE IF EXISTS note_tags;
      DROP TABLE IF EXISTS notes;
    `);
    const tokenizer = mode.kind === 'native'
      ? (mode.porter ? `'porter unicode61 remove_diacritics 2'` : `'unicode61 remove_diacritics 2'`)
      : `"ascii tokenchars '_'"`;
    db.exec(`
      CREATE TABLE notes (
        id          INTEGER PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,
        vault       TEXT,
        mtime       REAL,
        hash        TEXT,
        title       TEXT NOT NULL,
        body        TEXT,
        date        TEXT,
        type        TEXT,
        category    TEXT,
        temperature TEXT,
        heat_score  REAL,
        importance  TEXT,
        archived    INTEGER NOT NULL DEFAULT 0,
        collection  TEXT,
        extra       TEXT
      );
      CREATE INDEX notes_type ON notes(type);
      CREATE INDEX notes_category ON notes(category);
      CREATE INDEX notes_temperature ON notes(temperature);
      CREATE INDEX notes_date ON notes(date);
      CREATE INDEX notes_collection ON notes(collection);
      CREATE TABLE note_tags (
        tag     TEXT NOT NULL,
        note_id INTEGER NOT NULL,
        PRIMARY KEY (tag, note_id)
      ) WITHOUT ROWID;
      CREATE INDEX note_tags_note ON note_tags(note_id);
      ${FIELDS.map((f) => `
      CREATE VIRTUAL TABLE f_${f.name} USING fts5(
        t, content = '', contentless_delete = 1, tokenize = ${tokenizer}
      );
      CREATE VIRTUAL TABLE v_${f.name} USING fts5vocab(f_${f.name}, 'row');`).join('')}
      CREATE TABLE vocab (id INTEGER PRIMARY KEY, term TEXT NOT NULL UNIQUE);
      CREATE TABLE vgram (
        gram    TEXT NOT NULL,
        len     INTEGER NOT NULL,
        term_id INTEGER NOT NULL,
        PRIMARY KEY (gram, len, term_id)
      ) WITHOUT ROWID;
    `);
    const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    put.run('schema_version', String(LEXICAL_SCHEMA_VERSION));
    put.run('analyzer', this.analyzerId);
    // FTS5 merges segments at COMMIT by default (automerge=4), which made a
    // commit cost 50–150 ms at bulk-load rates. Merging is instead done by
    // `mergeSome()` in time-bounded steps between slices; crisismerge stays as
    // a safety net for long runs of single upserts.
    for (const f of FIELDS) {
      db.prepare(`INSERT INTO f_${f.name} (f_${f.name}, rank) VALUES ('automerge', 0)`).run();
      db.prepare(`INSERT INTO f_${f.name} (f_${f.name}, rank) VALUES ('crisismerge', 32)`).run();
    }
    return true;
  }

  /**
   * Incremental FTS5 segment merging, bounded by `budgetMs`: repeated small
   * `merge` steps (each ~MERGE_PAGES pages) across the field tables. Returns
   * true when there is still work left.
   */
  private mergeSome(budgetMs: number): boolean {
    const start = performance.now();
    let more = false;
    for (const f of FIELDS) {
      for (;;) {
        if (performance.now() - start >= budgetMs) return true;
        const before = this.db.prepare('SELECT total_changes() AS c').get() as { c: number };
        this.s.merge[FIELDS.indexOf(f)].run(MERGE_PAGES);
        const after = this.db.prepare('SELECT total_changes() AS c').get() as { c: number };
        // Per the FTS5 docs: fewer than 2 changes means no more merge work.
        if (after.c - before.c < 2) break;
        more = true;
      }
    }
    return more && performance.now() - start >= budgetMs;
  }

  /** Run merge steps (yielding between them) until the indexes are compact. */
  private async mergeAll(st: SyncStats): Promise<void> {
    for (;;) {
      const start = performance.now();
      const more = this.mergeSome(this.sliceMs);
      noteSlice(st, performance.now() - start);
      if (!more) return;
      await yieldTick();
    }
  }

  private prepare() {
    const db = this.db;
    return {
      byPath: db.prepare('SELECT id, hash FROM notes WHERE path = ?'),
      upsertNote: db.prepare(`
        INSERT INTO notes (path, vault, mtime, hash, title, body, date, type, category, temperature,
                           heat_score, importance, archived, collection, extra)
        VALUES (@path, @vault, @mtime, @hash, @title, @body, @date, @type, @category, @temperature,
                @heat_score, @importance, @archived, @collection, @extra)
        ON CONFLICT(path) DO UPDATE SET
          vault = excluded.vault, mtime = excluded.mtime, hash = excluded.hash, title = excluded.title,
          body = excluded.body, date = excluded.date, type = excluded.type, category = excluded.category,
          temperature = excluded.temperature, heat_score = excluded.heat_score,
          importance = excluded.importance, archived = excluded.archived, collection = excluded.collection,
          extra = excluded.extra
        RETURNING id`),
      touch: db.prepare('UPDATE notes SET mtime = ?, vault = ? WHERE id = ?'),
      delNote: db.prepare('DELETE FROM notes WHERE id = ?'),
      delTags: db.prepare('DELETE FROM note_tags WHERE note_id = ?'),
      addTag: db.prepare('INSERT OR IGNORE INTO note_tags (tag, note_id) VALUES (?, ?)'),
      delFts: FIELDS.map((f) => db.prepare(`DELETE FROM f_${f.name} WHERE rowid = ?`)),
      addFts: FIELDS.map((f) => db.prepare(`INSERT INTO f_${f.name} (rowid, t) VALUES (?, ?)`)),
      merge: FIELDS.map((f) => db.prepare(`INSERT INTO f_${f.name} (f_${f.name}, rank) VALUES ('merge', ?)`)),
      addVocab: db.prepare('INSERT OR IGNORE INTO vocab (term) VALUES (?)'),
      addGram: db.prepare('INSERT OR IGNORE INTO vgram (gram, len, term_id) VALUES (?, ?, ?)'),
      df: FIELDS.map((f) => db.prepare(`SELECT doc FROM v_${f.name} WHERE term = ?`)),
      prefixRange: FIELDS.map((f) => db.prepare(
        `SELECT term, doc FROM v_${f.name} WHERE term > ? AND term < ? ORDER BY length(term), doc DESC LIMIT ?`)),
      body: db.prepare('SELECT body FROM notes WHERE path = ?'),
      has: db.prepare('SELECT 1 FROM notes WHERE path = ?'),
      count: db.prepare('SELECT COUNT(*) AS c FROM notes'),
      vocabCount: db.prepare('SELECT COUNT(*) AS c FROM vocab'),
      page: db.prepare('SELECT id, path, mtime, hash FROM notes WHERE id > ? ORDER BY id LIMIT ?'),
      pathsByIds: db.prepare('SELECT id, path FROM notes WHERE id IN (SELECT value FROM json_each(?))'),
    };
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  private text(s: string): string {
    if (this.native) return s;
    return this.analyze(s).map(encodeTerm).join(' ');
  }

  /**
   * The part of the body that is indexed: the first `maxIndexedChars` (cut on
   * whitespace). Only multi-hundred-KB dumps/exports are affected; their FTS
   * insert alone would otherwise block the event loop for ~0.3–1 s. The full
   * body is still stored and returned by `getBody`.
   */
  private indexedBody(body: string): string {
    if (body.length <= this.maxIndexedChars) return body;
    const cut = body.lastIndexOf(' ', this.maxIndexedChars);
    return body.slice(0, cut > this.maxIndexedChars / 2 ? cut : this.maxIndexedChars);
  }

  private analyzeRecord(rec: NoteRecord): Analysed {
    return { title: this.text(rec.title), content: this.text(this.indexedBody(rec.body)), tags: this.text(rec.tags.join(' ')) };
  }

  /**
   * Same as `analyzeRecord`, but a big body is analysed in ~64 KB pieces cut on
   * whitespace (never inside a token) with a yield between pieces, so a single
   * multi-MB note cannot block the event loop for hundreds of ms.
   */
  private async analyzeRecordAsync(rec: NoteRecord, st: SyncStats): Promise<Analysed> {
    const body = this.indexedBody(rec.body);
    if (this.native || body.length <= BIG_TEXT) return this.analyzeRecord(rec);
    const parts: string[] = [];
    let off = 0;
    while (off < body.length) {
      const start = performance.now();
      let end = Math.min(body.length, off + PIECE);
      if (end < body.length) {
        const ws = body.slice(off, end).search(/\s\S*$/);
        if (ws > 0) end = off + ws + 1;
      }
      parts.push(this.text(body.slice(off, end)));
      off = end;
      const dur = performance.now() - start;
      noteSlice(st, dur);
      await yieldTick();
    }
    return { title: this.text(rec.title), content: parts.filter(Boolean).join(' '), tags: this.text(rec.tags.join(' ')) };
  }

  /** Upsert inside the caller's transaction. */
  private upsertRow(rec: NoteRecord, an: Analysed, sig: { vault?: string; mtimeMs?: number; hash?: string }): void {
    const row = this.s.upsertNote.get({
      path: rec.path,
      vault: sig.vault ?? null,
      mtime: sig.mtimeMs ?? null,
      hash: sig.hash ?? null,
      title: rec.title,
      body: this.storeBodies ? rec.body : null,
      date: rec.date ?? null,
      type: rec.type ?? null,
      category: rec.category ?? null,
      temperature: rec.temperature ?? null,
      heat_score: rec.heat_score ?? null,
      importance: rec.importance ?? null,
      archived: rec.archived === true ? 1 : 0,
      collection: rec.collection ?? null,
      extra: rec.extra === undefined ? null : JSON.stringify(rec.extra),
    }) as { id: number };
    const id = row.id;
    if (rec.archived === true) this.archivedIds.add(id);
    else this.archivedIds.delete(id);
    const texts = [an.title, an.content, an.tags];
    for (let i = 0; i < FIELDS.length; i++) {
      this.s.delFts[i].run(id); // no-op for a new row
      this.s.addFts[i].run(id, texts[i]);
    }
    this.nDocs = undefined;
    this.s.delTags.run(id);
    for (const t of new Set(rec.tags)) this.s.addTag.run(t, id);
    if (!this.native) this.addVocab(an.title, an.content, an.tags);
  }

  /**
   * Register new alphabetic terms in the fuzzy side index (terms of deleted
   * notes stay — harmless, they just expand to nothing). During a sync the known
   * vocabulary is held in a transient Set so the per-note lookups are free.
   */
  private addVocab(...texts: string[]): void {
    const seen = new Set<string>();
    for (const txt of texts) {
      for (const term of txt.split(' ')) {
        if (seen.has(term) || !isFuzzyVocabTerm(term)) continue;
        seen.add(term);
        if (this.vocabSet) {
          if (this.vocabSet.has(term)) continue;
          this.vocabSet.add(term);
        }
        const r = this.s.addVocab.run(term);
        if (r.changes === 1) {
          const id = Number(r.lastInsertRowid);
          for (const g of new Set(paddedTrigrams(term))) this.s.addGram.run(g, term.length, id);
        }
      }
    }
  }

  private removeRow(id: number): void {
    this.archivedIds.delete(id);
    for (const st of this.s.delFts) st.run(id);
    this.nDocs = undefined;
    this.s.delTags.run(id);
    this.s.delNote.run(id);
  }

  upsert(rec: NoteRecord, sig: { vault?: string; mtimeMs?: number; hash?: string } = {}): void {
    const an = this.analyzeRecord(rec);
    this.db.transaction(() => this.upsertRow(rec, an, sig))();
    this.mergeSome(5);
    this.maybeCheckpoint();
  }

  remove(p: string): void {
    const row = this.s.byPath.get(p) as { id: number } | undefined;
    if (row) this.db.transaction(() => this.removeRow(row.id))();
  }

  /**
   * Run `fn` over `items` in time-bounded transactions: BEGIN, process items
   * until `sliceMs` has elapsed, COMMIT, yield to the event loop. Each item is
   * self-contained (row + FTS + tags in the same transaction), so a crash
   * between slices leaves a consistent DB that the next sync simply continues.
   */
  private async runSliced<T>(items: T[], fn: (item: T) => void, st: SyncStats): Promise<void> {
    let i = 0;
    while (i < items.length) {
      const start = performance.now();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        while (i < items.length) {
          const item = items[i++];
          try { fn(item); } catch { st.failed++; }
          // Half the budget for row work: COMMIT then flushes FTS5's pending
          // terms to a new segment, which costs about as much again.
          if (performance.now() - start >= this.sliceMs / 2) break;
        }
        this.db.exec('COMMIT');
      } catch (err) {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
        throw err;
      }
      // Keep segment count bounded during long loads with whatever budget is left.
      const left = this.sliceMs - (performance.now() - start);
      if (left > 2) this.mergeSome(left);
      this.maybeCheckpoint();
      const dur = performance.now() - start;
      st.slices++;
      noteSlice(st, dur);
      await yieldTick();
    }
  }

  /** Page the known fuzzy vocabulary into a transient Set (dropped after the sync). */
  private async loadVocabSet(st: SyncStats): Promise<void> {
    const set = new Set<string>();
    const page = this.db.prepare('SELECT id, term FROM vocab WHERE id > ? ORDER BY id LIMIT 20000');
    let after = 0;
    for (;;) {
      const start = performance.now();
      const rows = page.all(after) as Array<{ id: number; term: string }>;
      for (const r of rows) set.add(r.term);
      const dur = performance.now() - start;
      noteSlice(st, dur);
      if (rows.length < 20000) break;
      after = rows[rows.length - 1].id;
      await yieldTick();
    }
    this.vocabSet = set;
  }

  syncFromListing(
    listing: ListingEntry[],
    load: (e: ListingEntry) => Promise<string>,
    opts: SyncOptions = {},
  ): Promise<SyncStats> {
    // Serialise syncs: a second call waits for the running one.
    const run = this.syncChain.catch(() => undefined).then(() => this.doSync(listing, load, opts));
    this.syncChain = run;
    return run;
  }

  private async doSync(
    listing: ListingEntry[],
    load: (e: ListingEntry) => Promise<string>,
    opts: SyncOptions,
  ): Promise<SyncStats> {
    const t0 = performance.now();
    const st: SyncStats = {
      listed: listing.length, skippedMtime: 0, touchedHash: 0, upserted: 0, removed: 0, failed: 0,
      ms: 0, maxSliceMs: 0, slices: 0, slowSlices: 0,
    };

    // 1. Existing state, paged by rowid so no statement stays open across a yield.
    const existing = new Map<string, { id: number; mtime: number | null; hash: string | null }>();
    let after = 0;
    for (;;) {
      const start = performance.now();
      const rows = this.s.page.all(after, 5000) as Array<{ id: number; path: string; mtime: number | null; hash: string | null }>;
      for (const r of rows) existing.set(r.path, { id: r.id, mtime: r.mtime, hash: r.hash });
      const dur = performance.now() - start;
      noteSlice(st, dur);
      if (rows.length < 5000) break;
      after = rows[rows.length - 1].id;
      await yieldTick();
    }

    // 2. Classify by mtime.
    const seen = new Set<string>();
    const toRead: ListingEntry[] = [];
    for (const e of listing) {
      if (seen.has(e.path)) continue; // first vault wins (caller should already de-dup)
      seen.add(e.path);
      const ex = existing.get(e.path);
      if (ex && e.mtimeMs !== undefined && ex.mtime === e.mtimeMs) st.skippedMtime++;
      else toRead.push(e);
    }

    // 3. Read changed files with bounded concurrency; hash + parse + analyse
    //    them OUTSIDE any transaction (time-sliced, big notes in pieces), then
    //    write them in time-bounded transactions.
    if (!this.native && toRead.length > 0) await this.loadVocabSet(st);
    const conc = Math.max(1, opts.concurrency ?? 16);
    const CHUNK = conc * 8;
    let done = 0;
    try {
      for (let off = 0; off < toRead.length; off += CHUNK) {
        const chunk = toRead.slice(off, off + CHUNK);
        const contents: Array<string | null> = new Array(chunk.length).fill(null);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(conc, chunk.length) }, async () => {
          while (next < chunk.length) {
            const k = next++;
            try { contents[k] = await load(chunk[k]); } catch { contents[k] = null; }
          }
        }));
        const work: Prepared[] = [];
        let sliceStart = performance.now();
        for (let k = 0; k < chunk.length; k++) {
          const e = chunk[k];
          const content = contents[k];
          contents[k] = null;
          if (content === null) { st.failed++; continue; }
          try {
            const hash = sha1(content);
            const ex = existing.get(e.path);
            if (ex && ex.hash === hash) {
              work.push({ kind: 'touch', id: ex.id, e });
            } else {
              const rec = this.toRecord(e.path, content);
              let an: Analysed;
              if (rec.body.length > BIG_TEXT) {
                const before = performance.now() - sliceStart;
                noteSlice(st, before);
                an = await this.analyzeRecordAsync(rec, st);
                sliceStart = performance.now();
              } else {
                an = this.analyzeRecord(rec);
              }
              work.push({ kind: 'upsert', rec, an, sig: { vault: e.vault, mtimeMs: e.mtimeMs, hash } });
            }
          } catch {
            st.failed++;
          }
          const dur = performance.now() - sliceStart;
          if (dur >= this.sliceMs) {
            noteSlice(st, dur);
            await yieldTick();
            sliceStart = performance.now();
          }
        }
        await this.runSliced(work, (w) => {
          if (w.kind === 'touch') {
            this.s.touch.run(w.e.mtimeMs ?? null, w.e.vault, w.id);
            st.touchedHash++;
          } else {
            this.upsertRow(w.rec, w.an, w.sig);
            st.upserted++;
            opts.onUpsert?.(w.rec);
          }
        }, st);
        done += chunk.length;
        opts.onProgress?.(done, toRead.length);
      }
    } finally {
      this.vocabSet = null;
    }

    // 4. Remove notes that are no longer listed.
    const gone: number[] = [];
    const gonePaths = new Map<number, string>();
    for (const [p, ex] of existing) if (!seen.has(p)) { gone.push(ex.id); gonePaths.set(ex.id, p); }
    await this.runSliced(gone, (id) => {
      this.removeRow(id);
      st.removed++;
      opts.onRemove?.(gonePaths.get(id)!);
    }, st);

    if (st.upserted > 0 || st.removed > 0) await this.mergeAll(st);
    st.ms = performance.now() - t0;
    return st;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  private fieldDf(i: number, encoded: string): number {
    return (this.s.df[i].get(encoded) as { doc: number } | undefined)?.doc ?? 0;
  }

  /** Max per-field document frequency — what search.ts `termDocFrequency` computes from MiniSearch. */
  docFrequency(term: string): number {
    const t = this.native ? term : encodeTerm(term);
    let df = 0;
    for (let i = 0; i < FIELDS.length; i++) df = Math.max(df, this.fieldDf(i, t));
    return df;
  }

  docCount(): number {
    if (this.nDocs === undefined) this.nDocs = (this.s.count.get() as { c: number }).c;
    return this.nDocs;
  }

  has(p: string): boolean {
    return this.s.has.get(p) !== undefined;
  }

  getBody(p: string): string | undefined {
    const row = this.s.body.get(p) as { body: string | null } | undefined;
    return row?.body ?? undefined;
  }

  stats(): LexicalStats {
    let dbBytes: number | undefined;
    if (this.dbPath !== ':memory:') {
      dbBytes = 0;
      for (const suffix of ['', '-wal']) {
        try { dbBytes += fs.statSync(this.dbPath + suffix).size; } catch { /* absent */ }
      }
    }
    return {
      backend: this.name,
      docs: this.docCount(),
      vocab: (this.s.vocabCount.get() as { c: number }).c,
      dbBytes,
      schemaVersion: LEXICAL_SCHEMA_VERSION,
      analyzer: this.analyzerId,
      rebuiltOnOpen: this.rebuiltOnOpen,
    };
  }

  /** WHERE fragment + params for the filters (all columns of `n`). */
  private filterSql(f: LexicalFilters | undefined): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f?.excludeArchived ?? true) where.push('n.archived = 0');
    if (!f) return { sql: where.map((w) => ` AND ${w}`).join(''), params };
    const inList = (col: string, vals: string[]) => {
      where.push(`${col} IN (${vals.map(() => '?').join(',')})`);
      params.push(...vals);
    };
    if (f.types?.length) inList('n.type', f.types);
    if (f.category) { where.push('n.category = ?'); params.push(f.category); }
    if (f.temperature) { where.push('n.temperature = ?'); params.push(f.temperature); }
    if (f.importance) { where.push('n.importance = ?'); params.push(f.importance); }
    if (f.minHeatScore !== undefined) { where.push('n.heat_score >= ?'); params.push(f.minHeatScore); }
    if (f.collections?.length) inList('n.collection', f.collections);
    if (f.dateFrom || f.dateTo) {
      where.push('n.date IS NOT NULL');
      if (f.dateFrom) { where.push('n.date >= ?'); params.push(f.dateFrom); }
      if (f.dateTo) { where.push('n.date <= ?'); params.push(f.dateTo); }
    }
    if (f.pathPrefixes?.length) {
      // substr(): exact byte-prefix semantics like `id.startsWith(sp)` (LIKE would
      // treat _ and % as wildcards and fold ASCII case).
      where.push(`(${f.pathPrefixes.map(() => 'substr(n.path, 1, ?) = ?').join(' OR ')})`);
      for (const p of f.pathPrefixes) params.push(p.length, p);
    }
    if (f.tagsAny?.length) {
      where.push(`EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.tag IN (${f.tagsAny.map(() => '?').join(',')}))`);
      params.push(...f.tagsAny);
    }
    return { sql: where.map((w) => ` AND ${w}`).join(''), params };
  }

  /**
   * Per-field ranked query. Unfiltered queries (the common case: only the
   * default archived exclusion) skip the `notes` join entirely — a PK lookup
   * per matching row dominated the cost of frequent terms — and drop archived
   * notes in JS from the in-memory `archivedIds` set instead.
   */
  private groupStmt(field: FieldName, filterSql: string | null): BetterSqlite3.Statement {
    const key = `${field}\u0000${filterSql ?? '#nojoin'}`;
    let st = this.searchStmts.get(key);
    if (!st) {
      st = this.db.prepare(filterSql === null
        ? `SELECT rowid AS id, bm25(f_${field}) AS s FROM f_${field} WHERE f_${field} MATCH ? ORDER BY s LIMIT ?`
        : `SELECT n.id AS id, bm25(f_${field}) AS s
         FROM f_${field} JOIN notes n ON n.id = f_${field}.rowid
         WHERE f_${field} MATCH ?${filterSql}
         ORDER BY s LIMIT ?`,
      );
      if (this.searchStmts.size > 512) this.searchStmts.clear();
      this.searchStmts.set(key, st);
    }
    return st;
  }

  /** Prefix expansions of `t` across the field vocabularies, shortest (= highest weight) first. */
  private prefixExpansions(t: string): Array<{ term: string; df: number }> {
    const best = new Map<string, number>();
    for (const st of this.s.prefixRange) {
      for (const r of st.all(t, t + '\u007f', this.maxPrefix) as Array<{ term: string; doc: number }>) {
        best.set(r.term, Math.max(best.get(r.term) ?? 0, r.doc));
      }
    }
    return [...best.entries()]
      .map(([term, df]) => ({ term, df }))
      .sort((a, b) => a.term.length - b.term.length || b.df - a.df)
      .slice(0, this.maxPrefix);
  }

  /** Fuzzy expansions within MiniSearch's edit distance, via the padded-trigram index. */
  private fuzzyExpansions(t: string, d: number, exclude: Set<string>): Array<{ term: string; dist: number }> {
    const grams = [...new Set(paddedTrigrams(t))];
    const need = Math.max(1, t.length + 2 - 3 * d);
    const sql = `SELECT v.term AS term FROM vgram g JOIN vocab v ON v.id = g.term_id
      WHERE g.gram IN (${grams.map(() => '?').join(',')}) AND g.len BETWEEN ? AND ?
      GROUP BY g.term_id HAVING COUNT(*) >= ?`;
    let st = this.searchStmts.get(sql);
    if (!st) { st = this.db.prepare(sql); this.searchStmts.set(sql, st); }
    const rows = st.all(...grams, t.length - d, t.length + d, need) as Array<{ term: string }>;
    const out: Array<{ term: string; dist: number }> = [];
    for (const { term } of rows) {
      if (term === t || exclude.has(term)) continue;
      const dist = boundedLevenshtein(t, term, d);
      if (dist <= d) out.push({ term, dist });
    }
    out.sort((a, b) => a.dist - b.dist || a.term.length - b.term.length);
    return out.slice(0, this.maxFuzzy);
  }

  search(query: string, opts: LexicalSearchOptions = {}): LexicalHit[] {
    const limit = opts.limit ?? 20;
    const depth = Math.max(limit * this.depthFactor, 200);
    const { sql: fsql0, params: params0 } = this.filterSql(opts.filters);
    const noJoin = fsql0 === '' || fsql0 === ' AND n.archived = 0';
    const dropArchived = noJoin && fsql0 !== '' && this.archivedIds.size > 0;
    const fsql = noJoin ? null : fsql0;
    const params = noJoin ? [] : params0;
    const stmts = FIELDS.map((f) => this.groupStmt(f.name, fsql));
    const fetch = (i: number, expr: string) => {
      const rows = stmts[i].all(expr, ...params, dropArchived ? depth + this.archivedIds.size : depth) as Array<{ id: number; s: number }>;
      return dropArchived ? rows.filter((r) => !this.archivedIds.has(r.id)) : rows;
    };
    const N = Math.max(1, this.docCount());
    const idfMs = (n: number) => Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const idfFts = (n: number) => { const v = Math.log((N - n + 0.5) / (n + 0.5)); return v > 0 ? v : 1e-6; };
    const terms = [...new Set(this.analyze(query).map((t) => (this.native ? t : encodeTerm(t))))];
    const acc = new Map<number, { score: number; terms: string[] }>();
    const credit = (id: number, score: number, qt: string) => {
      let e = acc.get(id);
      if (!e) { e = { score: 0, terms: [] }; acc.set(id, e); }
      e.score += score;
      if (!e.terms.includes(qt)) e.terms.push(qt);
    };
    // Exact term: recover the tf part per field and re-score with MiniSearch BM25+.
    const exact = (t: string) => {
      FIELDS.forEach((f, i) => {
        const n = this.fieldDf(i, t);
        if (n === 0 && !this.native) return;
        const rows = fetch(i, `"${t.replace(/"/g, '""')}"`);
        if (rows.length === 0) return;
        const nn = n || rows.length; // porter: query term ≠ stored stem → approximate
        const iF = idfFts(nn);
        const iM = idfMs(nn);
        for (const r of rows) credit(r.id, f.boost * iM * (BM25_D + -r.s / iF), t);
      });
    };
    // Expansion group: one OR query per field; FTS5 bm25 sums per-expansion
    // idf × tf parts, plus MiniSearch's d·idf (with the group's mean idf).
    const group = (expansions: Array<{ term: string; df: number }>, weight: number, qt: string) => {
      const expr = expansions.map((x) => `"${x.term}"`).join(' OR ');
      let idfSum = 0;
      for (const x of expansions) idfSum += idfMs(x.df);
      const dPart = BM25_D * (idfSum / expansions.length);
      FIELDS.forEach((f, i) => {
        const rows = fetch(i, expr);
        for (const r of rows) credit(r.id, weight * f.boost * (dPart + -r.s), qt);
      });
    };
    for (const t of terms) {
      exact(t);
      const prefixTerms = opts.prefix !== false && allowPrefix(t, this.analyzed) && (!this.native || t.length >= 3)
        ? this.prefixExpansions(t)
        : [];
      if (prefixTerms.length) {
        let w = 0;
        for (const p of prefixTerms) w += p.term.length / (p.term.length + 0.3 * (p.term.length - t.length));
        group(prefixTerms, PREFIX_WEIGHT * (w / prefixTerms.length), t);
      }
      const d = !this.native && opts.fuzzy !== false && isFuzzyVocabTerm(t) ? maxEditDistance(t, this.analyzed) : 0;
      if (d > 0) {
        const fz = this.fuzzyExpansions(t, d, new Set(prefixTerms.map((p) => p.term)));
        if (fz.length) {
          let w = 0;
          for (const f of fz) w += f.term.length / (f.term.length + f.dist);
          group(fz.map((f) => ({ term: f.term, df: this.docFrequency(f.term) })), FUZZY_WEIGHT * (w / fz.length), t);
        }
      }
    }
    if (acc.size === 0) return [];
    const ranked = [...acc.entries()]
      .map(([id, e]) => ({ id, score: e.score * e.terms.length, terms: e.terms }))
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, limit);
    const paths = new Map<number, string>();
    for (const r of this.s.pathsByIds.all(JSON.stringify(ranked.map((r) => r.id))) as Array<{ id: number; path: string }>) {
      paths.set(r.id, r.path);
    }
    return ranked.map((r) => ({ path: paths.get(r.id)!, score: r.score, queryTerms: r.terms }));
  }

  /**
   * Stream every stored note (path, title, caller `extra`) in rowid pages with a
   * yield between pages — warm boot rebuilds docMeta/docLinks from this instead
   * of re-reading and re-parsing every markdown file.
   */
  async forEachNote(cb: (n: { path: string; title: string; extra: unknown }) => void, pageSize = 2000): Promise<void> {
    const page = this.db.prepare('SELECT id, path, title, extra FROM notes WHERE id > ? ORDER BY id LIMIT ?');
    let after = 0;
    for (;;) {
      const rows = page.all(after, pageSize) as Array<{ id: number; path: string; title: string; extra: string | null }>;
      for (const r of rows) cb({ path: r.path, title: r.title, extra: r.extra === null ? undefined : JSON.parse(r.extra) });
      if (rows.length < pageSize) return;
      after = rows[rows.length - 1].id;
      await yieldTick();
    }
  }

  /** Paths in the index (iteration helper for docMeta rebuild / tests). */
  listPaths(): string[] {
    return (this.db.prepare('SELECT path FROM notes ORDER BY id').all() as Array<{ path: string }>).map((r) => r.path);
  }

  /** Underlying handle (tests / benchmark only). */
  get handle(): BetterSqlite3.Database {
    return this.db;
  }

  /** `close()` and wait for the checkpointer thread to exit (tests, shutdown). */
  async dispose(): Promise<void> {
    const w = this.ckptWorker;
    this.close();
    if (w) await w.terminate();
  }

  close(): void {
    if (this.ckptWorker) {
      void this.ckptWorker.terminate();
      this.ckptWorker = null;
    }
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    this.db.close();
  }
}
