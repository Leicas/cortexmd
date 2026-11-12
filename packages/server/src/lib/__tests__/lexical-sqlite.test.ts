import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteLexicalBackend, LEXICAL_SCHEMA_VERSION } from '../lexical-sqlite.js';
import {
  bilingualAnalyzer, boundedLevenshtein, encodeTerm, paddedTrigrams, referenceBilingualAnalyzer,
} from '../lexical/analyzer.js';
import { rankOverlap } from '../lexical/shadow.js';
import { noteRecordFromMarkdown } from '../lexical/record.js';
import type { ListingEntry } from '../lexical/types.js';

// Synthetic bilingual corpus — invented notes only.
const NOTES: Record<string, string> = {
  'Memories/serveur.md': `---\ntitle: Configuration du serveur\ntags: [infra, réseau]\ntype: memory\ncategory: decision\ntemperature: hot\nheat_score: 9\ndate: 2026-03-02\n---\nLes serveurs de l'entreprise étaient configurés avec des réseaux privés. Le cœur du système tourne sur Kubernetes.`,
  'Memories/policy.md': `---\ntitle: Retention policies\ntags: [compliance]\ntype: memory\ncategory: fact\ntemperature: warm\nheat_score: 4\ndate: 2026-01-15\n---\nOur data retention policies require deleting backups after ninety days. Policy owners review boxes yearly.`,
  'Projects/apollo/plan.md': `---\ntitle: Apollo launch plan\ntags: [apollo, roadmap]\ntype: project\ndate: 2026-05-20\n---\nThe Apollo launch depends on the authentication service and the billing migration.`,
  'Projects/apollo/notes.md': `---\ntitle: Réunion Apollo\ntags: [apollo]\ntype: meeting\ndate: 2026-05-21\n---\nCompte rendu: la migration de facturation est retardée. Élèves stagiaires ont testé l'authentification.`,
  'Archive/old.md': `---\ntitle: Ancien serveur\narchived: true\ntype: memory\n---\nAncien serveur décommissionné, configuration obsolète.`,
  'Daily/2026-02-01.md': `---\ntags: [daily]\n---\nWorked on the kubernetes ingress controller and certificate renewal.`,
  'Knowledge/naive.md': `---\ntitle: Naïve Bayes classifier\ntags: [ml]\ntype: reference\n---\nA naive Bayes classifier assumes feature independence. Used for spam filtering.`,
};

let dir: string;
let vault: string;

function writeVault(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function listing(): ListingEntry[] {
  const out: ListingEntry[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else out.push({ path: path.relative(vault, abs).split(path.sep).join('/'), vault, mtimeMs: fs.statSync(abs).mtimeMs });
    }
  };
  walk(vault);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const load = (e: ListingEntry) => fs.promises.readFile(path.join(e.vault, e.path), 'utf-8');

async function build(dbPath = path.join(dir, 'lex.sqlite'), opts: Partial<ConstructorParameters<typeof SqliteLexicalBackend>[0]> = {}) {
  const b = new SqliteLexicalBackend({ dbPath, ...opts });
  await b.syncFromListing(listing(), load);
  return b;
}

const paths = (hits: Array<{ path: string }>) => hits.map((h) => h.path);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexsql-'));
  vault = path.join(dir, 'vault');
  writeVault(NOTES);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('analyzer helpers', () => {
  it('encodes non-alphanumeric terms reversibly per character', () => {
    expect(encodeTerm('serveur')).toBe('serveur');
    expect(encodeTerm('c++')).toBe('c_2b__2b_');
    expect(encodeTerm('c++').startsWith(encodeTerm('c+'))).toBe(true);
  });
  it('fast analyzer is output-identical to the MiniSearch-equivalent reference', () => {
    const samples = [
      ...Object.values(NOTES),
      "L'ŒUVRE naïve d'Ångström — Straße, İstanbul; ΣΟΦΙΑΣ c++ v17.2 (test_case) e-mail: x@y.fr",
      'Ünïcödé   tabs\tand\nnewlines… «guillemets» ‘quotes’',
    ];
    for (const s of samples) expect(bilingualAnalyzer(s)).toEqual(referenceBilingualAnalyzer(s));
  });
  it('bounded Levenshtein and padded trigrams', () => {
    expect(boundedLevenshtein('serveur', 'serveru', 2)).toBe(2);
    expect(boundedLevenshtein('kubernetes', 'kubernets', 2)).toBe(1);
    expect(boundedLevenshtein('abc', 'xyzxyz', 1)).toBe(2);
    expect(paddedTrigrams('abcde')).toHaveLength(7);
  });
});

describe('SqliteLexicalBackend — search', () => {
  it('matches accent-insensitively and stems plurals (EN + FR)', async () => {
    const b = await build();
    expect(paths(b.search('réseau'))).toContain('Memories/serveur.md');
    expect(paths(b.search('reseaux'))).toContain('Memories/serveur.md');
    expect(paths(b.search('serveur'))[0]).toBe('Memories/serveur.md');
    expect(paths(b.search('policy'))[0]).toBe('Memories/policy.md');
    expect(paths(b.search('coeur'))).toContain('Memories/serveur.md');
    expect(paths(b.search('eleve'))).toContain('Projects/apollo/notes.md');
    expect(paths(b.search('naive'))).toContain('Knowledge/naive.md');
    // Stopwords alone match nothing.
    expect(b.search('the les des')).toEqual([]);
    b.close();
  });

  it('weights title above body and reports matched query terms', async () => {
    const b = await build();
    const hits = b.search('apollo migration');
    expect(hits[0].path).toBe('Projects/apollo/plan.md');
    expect(hits[0].queryTerms.sort()).toEqual(['apollo', 'migration']);
    expect(b.docFrequency('apollo')).toBe(2);
    expect(b.docFrequency('zzzz')).toBe(0);
    b.close();
  });

  it('prefix and fuzzy are length-gated', async () => {
    const b = await build();
    expect(paths(b.search('kubern'))).toContain('Daily/2026-02-01.md'); // prefix
    expect(paths(b.search('kubernets'))).toContain('Daily/2026-02-01.md'); // fuzzy (1 edit)
    expect(paths(b.search('kubern', { prefix: false }))).not.toContain('Daily/2026-02-01.md');
    // 'kubrenetes' (transposition = 2 edits on a 9-char stem) is reachable only fuzzily.
    expect(paths(b.search('kubrenetes'))).toContain('Daily/2026-02-01.md');
    expect(paths(b.search('kubrenetes', { fuzzy: false }))).not.toContain('Daily/2026-02-01.md');
    // 4-letter terms get no fuzzy (gate < 5 chars).
    expect(paths(b.search('spom'))).toEqual([]);
    b.close();
  });

  it('pushes filters into SQL (type, category, temperature, tags, dates, prefix, archived)', async () => {
    const b = await build();
    const q = 'serveur';
    expect(paths(b.search(q))).not.toContain('Archive/old.md');
    expect(paths(b.search(q, { filters: { excludeArchived: false } }))).toContain('Archive/old.md');
    expect(paths(b.search('apollo', { filters: { types: ['meeting'] } }))).toEqual(['Projects/apollo/notes.md']);
    expect(paths(b.search('apollo', { filters: { types: ['meeting', 'project'] } })).sort())
      .toEqual(['Projects/apollo/notes.md', 'Projects/apollo/plan.md']);
    expect(paths(b.search('policies serveur', { filters: { category: 'fact' } }))).toEqual(['Memories/policy.md']);
    expect(paths(b.search('policies serveur', { filters: { temperature: 'hot' } }))).toEqual(['Memories/serveur.md']);
    expect(paths(b.search('policies serveur', { filters: { minHeatScore: 5 } }))).toEqual(['Memories/serveur.md']);
    expect(paths(b.search('apollo serveur', { filters: { tagsAny: ['roadmap', 'infra'] } })).sort())
      .toEqual(['Memories/serveur.md', 'Projects/apollo/plan.md']);
    expect(paths(b.search('apollo', { filters: { dateFrom: '2026-05-21' } }))).toEqual(['Projects/apollo/notes.md']);
    expect(paths(b.search('apollo', { filters: { dateTo: '2026-05-20' } }))).toEqual(['Projects/apollo/plan.md']);
    // Notes without a date drop out of date-filtered searches.
    expect(paths(b.search('kubernetes', { filters: { dateFrom: '2000-01-01' } }))).not.toContain('Daily/2026-02-01.md');
    expect(paths(b.search('serveur apollo', { filters: { pathPrefixes: ['Projects/'] } })).every((p) => p.startsWith('Projects/'))).toBe(true);
    // `_` is literal in path prefixes (not a LIKE wildcard).
    expect(b.search('apollo', { filters: { pathPrefixes: ['Projects_'] } })).toEqual([]);
    // Combined filters.
    expect(paths(b.search('apollo migration', {
      filters: { types: ['project', 'meeting'], tagsAny: ['roadmap'], dateFrom: '2026-01-01', pathPrefixes: ['Projects/apollo/'] },
    }))).toEqual(['Projects/apollo/plan.md']);
    b.close();
  });
});

describe('SqliteLexicalBackend — incremental sync', () => {
  it('skips unchanged mtimes, touches on same hash, re-indexes changes, removes deletions', async () => {
    const b = await build();
    const first = await b.syncFromListing(listing(), load);
    expect(first.skippedMtime).toBe(Object.keys(NOTES).length);
    expect(first.upserted).toBe(0);

    // Same bytes, new mtime → touch only.
    const p = path.join(vault, 'Memories/policy.md');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(p, later, later);
    const touched = await b.syncFromListing(listing(), load);
    expect(touched.touchedHash).toBe(1);
    expect(touched.upserted).toBe(0);

    // Content change → re-indexed (old terms gone, new terms searchable).
    fs.writeFileSync(p, NOTES['Memories/policy.md'].replace('ninety days', 'thirty weeks'));
    const changed = await b.syncFromListing(listing(), load);
    expect(changed.upserted).toBe(1);
    expect(paths(b.search('ninety'))).not.toContain('Memories/policy.md');
    expect(paths(b.search('thirty'))).toContain('Memories/policy.md');

    // Deletion.
    fs.rmSync(path.join(vault, 'Daily/2026-02-01.md'));
    const removed = await b.syncFromListing(listing(), load);
    expect(removed.removed).toBe(1);
    expect(b.has('Daily/2026-02-01.md')).toBe(false);
    expect(paths(b.search('kubernetes'))).not.toContain('Daily/2026-02-01.md');
    expect(b.docCount()).toBe(Object.keys(NOTES).length - 1);
    b.close();
  });

  it('reports changes via callbacks and restores caller metadata without file reads', async () => {
    const upserted: string[] = [];
    const removedPaths: string[] = [];
    const dbPath = path.join(dir, 'lex.sqlite');
    const b = new SqliteLexicalBackend({
      dbPath,
      toRecord: (p, c) => ({ ...noteRecordFromMarkdown(p, c), extra: { links: [`link-of-${p}`], n: c.length } }),
    });
    await b.syncFromListing(listing(), load, { onUpsert: (r) => upserted.push(r.path), onRemove: (p) => removedPaths.push(p) });
    expect(upserted.sort()).toEqual(Object.keys(NOTES).sort());
    fs.rmSync(path.join(vault, 'Knowledge/naive.md'));
    await b.syncFromListing(listing(), load, { onRemove: (p) => removedPaths.push(p) });
    expect(removedPaths).toEqual(['Knowledge/naive.md']);
    b.close();
    const warm = new SqliteLexicalBackend({ dbPath });
    const seen = new Map<string, unknown>();
    await warm.forEachNote((n) => seen.set(n.path, n.extra));
    expect(seen.size).toBe(Object.keys(NOTES).length - 1);
    expect(seen.get('Memories/policy.md')).toMatchObject({ links: ['link-of-Memories/policy.md'] });
    warm.close();
  });

  it('upsert/remove single notes and serves bodies on demand', async () => {
    const b = await build();
    b.upsert({ path: 'Memories/new.md', title: 'Quantum widget', body: 'Le gadget quantique', tags: ['lab'], type: 'memory' });
    expect(paths(b.search('quantique'))).toEqual(['Memories/new.md']);
    expect(b.getBody('Memories/new.md')).toBe('Le gadget quantique');
    b.upsert({ path: 'Memories/new.md', title: 'Quantum widget', body: 'Replaced body', tags: [], type: 'memory' });
    expect(b.search('quantique')).toEqual([]);
    expect(paths(b.search('quantum'))).toEqual(['Memories/new.md']);
    b.remove('Memories/new.md');
    expect(b.search('quantum')).toEqual([]);
    expect(b.getBody('Memories/new.md')).toBeUndefined();
    b.close();
  });

  it('analyses big notes in pieces and caps the indexed part (body still stored)', async () => {
    const big = 'filler '.repeat(60_000) + 'needleword ' + 'tail '.repeat(10);
    writeVault({ 'Dump/big.md': `---\ntitle: Big dump\n---\nheadword ${big}` });
    const b = new SqliteLexicalBackend({ dbPath: path.join(dir, 'lex.sqlite'), maxIndexedChars: 200_000 });
    const st = await b.syncFromListing(listing(), load);
    expect(st.failed).toBe(0);
    expect(paths(b.search('headword'))).toEqual(['Dump/big.md']);
    expect(b.search('needleword')).toEqual([]); // beyond the cap: not indexed
    expect(b.getBody('Dump/big.md')).toContain('needleword');
    b.close();
  });

  it('keeps every slice short (time-sliced transactions)', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 1500; i++) many[`Bulk/n${i}.md`] = `---\ntitle: Note ${i}\n---\n` + 'lorem ipsum dolor sit amet '.repeat(40) + ` token${i}`;
    writeVault(many);
    const b = new SqliteLexicalBackend({ dbPath: path.join(dir, 'lex.sqlite'), sliceMs: 10 });
    const st = await b.syncFromListing(listing(), load);
    expect(st.upserted).toBe(1500 + Object.keys(NOTES).length);
    expect(st.slices).toBeGreaterThan(1);
    // One item can overshoot the budget; allow generous headroom for slow CI.
    expect(st.maxSliceMs).toBeLessThan(200);
    b.close();
  });
});

describe('SqliteLexicalBackend — schema + crash safety', () => {
  it('reopens without rebuilding, rebuilds on schema-version or analyzer change', async () => {
    const dbPath = path.join(dir, 'lex.sqlite');
    const b = await build(dbPath);
    b.close();
    const again = new SqliteLexicalBackend({ dbPath });
    expect(again.rebuiltOnOpen).toBe(false);
    expect(again.docCount()).toBe(Object.keys(NOTES).length);
    again.close();

    // Simulate an older on-disk schema.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(LEXICAL_SCHEMA_VERSION - 1));
    raw.close();
    const migrated = new SqliteLexicalBackend({ dbPath });
    expect(migrated.rebuiltOnOpen).toBe(true);
    expect(migrated.docCount()).toBe(0);
    await migrated.syncFromListing(listing(), load);
    expect(migrated.docCount()).toBe(Object.keys(NOTES).length);
    migrated.close();

    // A different analyzer (fingerprint) also forces a rebuild.
    const other = new SqliteLexicalBackend({
      dbPath,
      analyzer: { kind: 'shared', analyze: (t) => bilingualAnalyzer(t).map((x) => x + 'x'), id: 'test' },
    });
    expect(other.rebuiltOnOpen).toBe(true);
    other.close();
  });

  it('discards a corrupt DB file and starts fresh', async () => {
    const dbPath = path.join(dir, 'lex.sqlite');
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all, just garbage bytes'.repeat(100));
    const b = new SqliteLexicalBackend({ dbPath });
    expect(b.rebuiltOnOpen).toBe(true);
    await b.syncFromListing(listing(), load);
    expect(b.docCount()).toBe(Object.keys(NOTES).length);
    b.close();
  });

  it('a reader on another connection sees consistent committed state during a sync', async () => {
    const dbPath = path.join(dir, 'lex.sqlite');
    const many: Record<string, string> = {};
    for (let i = 0; i < 800; i++) many[`Bulk/n${i}.md`] = `---\ntitle: Bulk ${i}\n---\nalpha beta gamma ${'delta '.repeat(200)}`;
    writeVault(many);
    const writer = new SqliteLexicalBackend({ dbPath, sliceMs: 5 });
    const reader = new SqliteLexicalBackend({ dbPath });
    let observations = 0;
    let inconsistent = 0;
    const timer = setInterval(() => {
      // notes rows and FTS rows are written in the same transaction → equal counts.
      const n = (reader.handle.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number }).c;
      const hits = reader.search('gamma', { limit: 10_000 }).length;
      if (n > 0 && hits > n) inconsistent++;
      observations++;
    }, 1);
    const st = await writer.syncFromListing(listing(), load);
    clearInterval(timer);
    expect(st.upserted).toBe(800 + Object.keys(NOTES).length);
    expect(observations).toBeGreaterThan(0);
    expect(inconsistent).toBe(0);
    expect(reader.search('gamma', { limit: 10_000 })).toHaveLength(800);
    await reader.dispose();
    await writer.dispose();
  });
});

describe('native FTS5 tokenizer mode', () => {
  it('folds accents with unicode61 remove_diacritics 2', async () => {
    const b = await build(path.join(dir, 'native.sqlite'), { analyzer: { kind: 'native' } });
    expect(paths(b.search('reseaux'))).toContain('Memories/serveur.md');
    b.close();
  });
});

describe('shadow-mode rank overlap', () => {
  it('computes overlap@k and top-1 agreement', () => {
    expect(rankOverlap(['a', 'b', 'c'], ['a', 'c', 'x'], 3)).toMatchObject({ overlap: 2 / 3, top1: true });
    expect(rankOverlap([], [], 10)).toMatchObject({ overlap: 1, top1: true });
  });
});
