/**
 * Recall ranking contract on a synthetic vault (invented notes):
 *   - bounded priors are tie-breakers, never a substitute for relevance
 *   - explicit caller intent (relatedTo, archive, stale validity) stays strong
 *   - digests / email captures are a low-priority tier unless asked for
 *   - a minimum-evidence floor makes unanswerable queries return nothing
 *   - bilingual lexical analysis, score fusion, kNN depth, scope filtering
 *   - the reranker runs after re-scoring and its order is the final one
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-recall-ranking-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-recall-ranking';
process.env.DASHBOARD_PASSWORD = 'test-recall-ranking';
process.env.ENABLE_EMBEDDINGS = 'false';
process.env.ENABLE_KG = 'false';
process.env.RECALL_NO_TOUCH = '1';
for (const k of [
  'RECALL_SCORING', 'RECALL_SCOPE', 'HYBRID_FUSION', 'LEXICAL_ANALYZER', 'RECALL_MIN_EVIDENCE',
  'RECALL_PRIOR_BOUND', 'RECALL_LOW_TIER_PENALTY', 'RECALL_MMR_LAMBDA', 'PPR_RECALL', 'ENABLE_RERANKER',
  'RECALL_EPISODIC', 'RECALL_EPISODIC_PENALTY', 'RECALL_TIME_QUERY', 'RECALL_TIME_SLACK_DAYS',
]) delete process.env[k];

// Controllable semantic arm and reranker (both off unless a test turns them on).
const semantic = {
  ready: false,
  hits: [] as Array<{ path: string; score: number; chunk?: { index: number; start: number; end: number; text?: string } }>,
  lastK: 0,
};
vi.mock('../embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../embeddings.js')>()),
  isEmbeddingsReady: () => semantic.ready,
  searchSemantic: async (_q: string, k: number) => { semantic.lastK = k; return semantic.hits.slice(0, k); },
}));
const reranker = { enabled: false, calls: [] as Array<Array<{ title: string; snippet: string }>> };
vi.mock('../reranker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reranker.js')>()),
  isRerankerEnabled: () => reranker.enabled,
  rerankResults: async (_q: string, candidates: Array<{ index: number; title: string; snippet: string }>) => {
    reranker.calls.push(candidates.map((c) => ({ title: c.title, snippet: c.snippet })));
    return candidates.map((_, i) => i).reverse();
  },
}));

const { config } = await import('../../config.js');
const { createNote } = await import('../vault.js');
const search = await import('../search.js');
const { stringifyFrontmatter } = await import('../frontmatter.js');
const memory = await import('../memory.js');
const { runMemoryRecall, renderRecall } = await import('../../tools/memory-recall.js');
const { formatRerankCandidates, RERANK_PASSAGE_CHARS } = await import('../reranker.js');
type SearchResult = import('../search.js').SearchResult;

const cfg = config as unknown as Record<string, unknown>;
const saved = { ...cfg };
afterEach(() => {
  Object.assign(cfg, saved);
  semantic.ready = false;
  semantic.hits = [];
  reranker.enabled = false;
  reranker.calls = [];
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TODAY = new Date().toISOString().slice(0, 10);
const P = {
  decision: 'Memories/decision/lumen-database.md',
  chatter: 'Memories/observation/database-restart.md',
  coldObs: 'Memories/observation/cold-note.md',
  related: 'Memories/fact/lumen-oncall.md',
  archived: 'Memories/decision/old-database.md',
  stale: 'Memories/fact/stale-claim.md',
  digest: 'Memories/consolidated/ops-2026-W10.md',
  typedDigest: 'Memories/consolidated/ops-2026-W11.md',
  email: 'EmailLog/2026-03-02-newsletter.md',
  reunion: 'Memories/fact/reunion-trimestrielle.md',
  ascii: 'Memories/fact/hebergement-ascii.md',
  project: 'Projects/Lumen.md',
  index: 'Indexes/Everything.md',
  task: 'Tasks/migrate-lumen.md',
  long: 'Memories/fact/long-note.md',
  recent: 'Memories/fact/quokka-ledger.md',
  hookEcho: 'Memories/observation/hook-echo.md',
  diary: 'Ops/Agent Diaries/Test Agent/2026-03-01.md',
};

function mem(title: string, body: string, extra: Record<string, unknown> = {}): string {
  return stringifyFrontmatter({ type: 'memory', category: 'fact', title, created: '2026-03-01', ...extra }, `${body}\n`);
}

beforeAll(async () => {
  await createNote(P.decision, mem('Lumen database choice', 'We chose PostgreSQL for the Lumen billing service database.', {
    category: 'decision', importance: 'medium', heat_score: 0, temperature: 'cold', last_accessed: '2024-01-01',
  }));
  await createNote(P.chatter, mem('Database container restart', 'Restarted the database container; the Lumen dashboards came back.', {
    category: 'observation', importance: 'critical', heat_score: 16, temperature: 'hot', last_accessed: TODAY,
  }));
  await createNote(P.coldObs, mem('Cold observation', 'Observed a quiet weekend on the Lumen billing queue.', {
    category: 'observation', importance: 'low', heat_score: 0, temperature: 'cold', last_accessed: '2024-01-01',
  }));
  await createNote(P.related, mem('Lumen on-call rotation', 'Database on-call rotation for billing. See [[Projects/Lumen]].', {
    related: ['[[Projects/Lumen]]'],
  }));
  await createNote(P.archived, mem('Old database plan', 'Earlier plan: MySQL for the Lumen billing database.', {
    category: 'decision', archived: true,
  }));
  await createNote(P.stale, mem('Stale claim', 'The Lumen billing database runs on SQLite.', {
    validity_alpha: 2, validity_beta: 2,
  }));
  await createNote(P.digest, mem('ops — 2026-W10', 'Weekly digest: PostgreSQL Lumen billing database, restarts, dashboards, on-call rotation.', {
    category: 'insight', tags: ['ops', 'consolidated-series'], heat_score: 16, temperature: 'hot', last_accessed: TODAY,
  }));
  await createNote(P.typedDigest, stringifyFrontmatter(
    { type: 'digest', title: 'ops — 2026-W11', importance: 'low', tags: ['ops', 'consolidated-series'] },
    'Weekly digest: PostgreSQL Lumen billing database follow-ups.\n',
  ));
  await createNote(P.email, mem('Email - Database newsletter', 'Newsletter: PostgreSQL database conference, Lumen billing case study.', {
    category: 'observation', source: 'n8n:mail-triage', heat_score: 12, temperature: 'hot',
  }));
  await createNote(P.reunion, mem('Réunion trimestrielle', 'La réunion trimestrielle du comité a lieu le premier mardi du trimestre.'));
  await createNote(P.ascii, mem('Hebergement', 'Le projet Cerf-volant est heberge chez un fournisseur regional.'));
  await createNote(P.project, stringifyFrontmatter({ type: 'project', title: 'Lumen' },
    '# Lumen\n\nLumen project overview: billing service backed by a PostgreSQL database.\n'));
  await createNote(P.index, stringifyFrontmatter({ type: 'index', title: 'Everything' },
    'Lumen billing PostgreSQL database index of everything.\n'));
  await createNote(P.task, stringifyFrontmatter({ type: 'task', title: 'Migrate Lumen' },
    'Task: migrate the Lumen billing PostgreSQL database.\n'));
  await createNote(P.long, mem('Long note', `${'Filler sentence about nothing in particular. '.repeat(40)}The zeppelin hangar key is under the blue mat. ${'More filler follows here. '.repeat(40)}`));
  await createNote(P.recent, mem('Quokka ledger', 'The quokka ledger lives in the lighthouse annex.', { created: TODAY }));
  await createNote(P.hookEcho, mem('Quokka ledger hook capture', 'Hook saw the quokka ledger command run.', {
    category: 'observation', source: 'hook:PostToolUse:Bash',
  }));
  await createNote(P.diary, '# Test Agent — 2026-03-01\n\n- **10:00** — moved the quokka ledger to the lighthouse annex\n');
  await search.rebuildIndex();
});

/** Synthetic search hit for a real indexed path. */
function hit(p: string, score: number, extra: Partial<SearchResult> = {}): SearchResult {
  return { path: p, title: p, snippet: '', score, lexicalScore: score, semanticScore: 0, graphScore: 0, fusedScore: score, ...extra };
}
const paths = (rs: Array<{ path: string }>) => rs.map((r) => r.path);

describe('rescoreRecall — bounded priors', () => {
  it('a hot, critical, recent note cannot overtake a clearly more relevant cold one', () => {
    const out = memory.rescoreRecall([hit(P.coldObs, 1.0), hit(P.chatter, 0.85)], { limit: 5 });
    expect(paths(out)).toEqual([P.coldObs, P.chatter]);
    // Combined prior stays inside ±recallPriorBound.
    expect(out[1].score).toBeLessThanOrEqual(0.85 * (1 + config.recallPriorBound) + 1e-9);
    expect(out[0].score).toBeGreaterThanOrEqual(1.0 * (1 - config.recallPriorBound) - 1e-9);
  });

  it('priors break ties between equally relevant notes', () => {
    const out = memory.rescoreRecall([hit(P.coldObs, 0.9), hit(P.chatter, 0.9)], { limit: 5 });
    expect(out[0].path).toBe(P.chatter);
  });

  it('a durable category is not penalised for being cold or old', () => {
    const out = memory.rescoreRecall([hit(P.decision, 1.0), hit(P.coldObs, 1.0)], { limit: 5, explain: true });
    const decision = out.find((r) => r.path === P.decision)!;
    const cold = out.find((r) => r.path === P.coldObs)!;
    expect(decision.signals!.prior!).toBeGreaterThanOrEqual(0);
    expect(cold.signals!.prior!).toBeLessThan(0);
    expect(out[0].path).toBe(P.decision);
  });

  it('RECALL_SCORING=legacy restores the unbounded multiplicative boosts', () => {
    cfg.recallScoring = 'legacy';
    const out = memory.rescoreRecall([hit(P.coldObs, 1.0), hit(P.chatter, 0.85)], { limit: 5 });
    expect(out[0].path).toBe(P.chatter);
    expect(out[0].score).toBeGreaterThan(1.5);
  });

  it('scores are normalised relevance (best candidate ≈ 1), whatever the fused scale', () => {
    const small = memory.rescoreRecall([hit(P.decision, 0.03), hit(P.related, 0.015)], { limit: 5 });
    const big = memory.rescoreRecall([hit(P.decision, 900), hit(P.related, 450)], { limit: 5 });
    expect(small[0].score).toBeCloseTo(big[0].score, 9);
    expect(small[1].score).toBeCloseTo(big[1].score, 9);
    expect(small[0].score).toBeGreaterThan(0.9);
    expect(small[0].score).toBeLessThan(1.1);
  });
});

describe('rescoreRecall — explicit intent stays meaningful', () => {
  it('relatedTo lifts a linked note over a more relevant unlinked one', () => {
    const plain = memory.rescoreRecall([hit(P.decision, 1.0), hit(P.related, 0.75)], { limit: 5 });
    expect(plain[0].path).toBe(P.decision);
    const anchored = memory.rescoreRecall([hit(P.decision, 1.0), hit(P.related, 0.75)], { limit: 5, relatedTo: ['Projects/Lumen.md'], explain: true });
    expect(anchored[0].path).toBe(P.related);
    expect(anchored[0].signals!.related).toBe(true);
  });

  it('contextSnippet keywords are accent-insensitive and boost matching notes', () => {
    expect(memory.extractContextKeywords('Réunion du comité à Évry')).toEqual(['reunion', 'comite', 'evry']);
    const out = memory.rescoreRecall([hit(P.decision, 1.0), hit(P.reunion, 0.9)], { limit: 5, contextSnippet: 'prochaine reunion du comite trimestrielle' });
    expect(out[0].path).toBe(P.reunion);
  });

  it('archived and stale notes keep their penalties', () => {
    const out = memory.rescoreRecall([hit(P.archived, 1.0), hit(P.stale, 1.0), hit(P.related, 0.7)], { limit: 5, explain: true });
    expect(out[0].path).toBe(P.related);
    const stale = out.find((r) => r.path === P.stale)!;
    expect(stale.signals!.stale).toBe(true);
    expect(stale.score).toBeLessThan(0.6);
    expect(out.find((r) => r.path === P.archived)!.score).toBeLessThan(0.45);
  });

  it('category / importance filters still apply', () => {
    const rs = [hit(P.decision, 1.0), hit(P.chatter, 0.9), hit(P.coldObs, 0.8)];
    expect(paths(memory.rescoreRecall(rs, { limit: 5, categories: ['decision'] }))).toEqual([P.decision]);
    expect(paths(memory.rescoreRecall(rs, { limit: 5, minImportance: 'high' }))).toEqual([P.chatter]);
    expect(paths(memory.rescoreRecall(rs, { limit: 5, exclude: [P.decision] }))).not.toContain(P.decision);
  });
});

describe('rescoreRecall — low-priority tier (digests, email captures)', () => {
  it('a digest and an email capture rank below a less relevant real memory', () => {
    const out = memory.rescoreRecall([hit(P.digest, 1.0), hit(P.email, 0.95), hit(P.decision, 0.6)], { limit: 5, query: 'Lumen billing database', explain: true });
    expect(out[0].path).toBe(P.decision);
    expect(out.find((r) => r.path === P.digest)!.tier).toBe('digest');
    expect(out.find((r) => r.path === P.email)!.tier).toBe('email');
    expect(out.find((r) => r.path === P.digest)!.signals!.reason).toContain('digest (low priority)');
  });

  it('…unless the query asks for them', () => {
    const digestFirst = memory.rescoreRecall([hit(P.digest, 1.0), hit(P.decision, 0.6)], { limit: 5, query: 'weekly digest of the Lumen database work' });
    expect(digestFirst[0].path).toBe(P.digest);
    const emailFirst = memory.rescoreRecall([hit(P.email, 1.0), hit(P.decision, 0.6)], { limit: 5, query: 'the email about the database conference' });
    expect(emailFirst[0].path).toBe(P.email);
    expect(memory.queryAsksForTier('résumé hebdomadaire des courriels')).toEqual({ digest: true, email: true });
    expect(memory.queryAsksForTier('which database did we pick')).toEqual({ digest: false, email: false });
  });

  it('a `type: digest` note is recalled as low-priority tier, never as a memory', () => {
    const out = memory.rescoreRecall([hit(P.typedDigest, 1.0), hit(P.decision, 0.6)], { limit: 5, query: 'Lumen billing database' });
    expect(paths(out)).toEqual([P.decision, P.typedDigest]);
    expect(out[1].tier).toBe('digest');
  });
});

describe('rescoreRecall — scope', () => {
  const rs = () => [hit(P.project, 1.0), hit(P.index, 0.95), hit(P.task, 0.9), hit(P.decision, 0.8)];

  it("scope 'memory' returns memories only; the default scope is 'durable'", () => {
    expect(paths(memory.rescoreRecall(rs(), { limit: 5, scope: 'memory' }))).toEqual([P.decision]);
    expect(config.recallScope).toBe('durable');
    expect(paths(memory.rescoreRecall(rs(), { limit: 5 })).sort()).toEqual([P.decision, P.project].sort());
  });

  it("scope 'durable' adds durable KNOWLEDGE only: a non-memory episodic note (diary day) stays out", () => {
    expect(memory.recallTierOf(P.diary, { title: 'Test Agent — 2026-03-01' }, 'durable')).toBeUndefined();
    expect(memory.recallTierOf(P.project, { type: 'project', title: 'Lumen' }, 'durable')).toBe('note');
    expect(paths(memory.rescoreRecall([hit(P.diary, 1.0), hit(P.decision, 0.8)], { limit: 5, scope: 'durable' }))).toEqual([P.decision]);
  });

  it("scope 'durable' adds durable notes at a lower weight but no index / task notes", () => {
    const out = memory.rescoreRecall(rs(), { limit: 5, scope: 'durable' });
    expect(paths(out).sort()).toEqual([P.decision, P.project].sort());
    const project = out.find((r) => r.path === P.project)!;
    expect(project.tier).toBe('note');
    expect(project.score).toBeCloseTo(memory.NOTE_TIER_WEIGHT, 6);
    // Memory-frontmatter filters cannot be satisfied by a non-memory note.
    expect(paths(memory.rescoreRecall(rs(), { limit: 5, scope: 'durable', categories: ['decision'] }))).toEqual([P.decision]);
  });
});

describe('minimum-evidence floor', () => {
  const weak = (p: string, s: number) => hit(p, s, { lexicalEvidence: 1.2, semanticSim: 0.31, coverage: 0.3 });

  it('returns nothing when no candidate carries real evidence', () => {
    expect(memory.assessRecallEvidence([weak(P.decision, 1)]).level).toBe('none');
    expect(memory.rescoreRecall([weak(P.decision, 1.0), weak(P.chatter, 0.9)], { limit: 5 })).toEqual([]);
  });

  it('one strong signal — lexical or semantic — is enough', () => {
    const lexical = [weak(P.decision, 1.0), hit(P.chatter, 0.9, { lexicalEvidence: 40, semanticSim: 0.2 })];
    expect(memory.rescoreRecall(lexical, { limit: 5 })).toHaveLength(2);
    const sem = [weak(P.decision, 1.0), hit(P.chatter, 0.9, { semanticSim: 0.71 })];
    expect(memory.rescoreRecall(sem, { limit: 5 })).toHaveLength(2);
  });

  it('flags weak-but-present evidence as low confidence, and can be switched off', () => {
    const low = [hit(P.decision, 1.0, { lexicalEvidence: 4, semanticSim: 0.4 })];
    expect(memory.assessRecallEvidence(low).level).toBe('low');
    expect(memory.rescoreRecall(low, { limit: 5 })).toHaveLength(1);
    expect(memory.rescoreRecall([weak(P.decision, 1.0)], { limit: 5, minEvidence: false })).toHaveLength(1);
    cfg.recallMinEvidence = false;
    expect(memory.rescoreRecall([weak(P.decision, 1.0)], { limit: 5 })).toHaveLength(1);
  });

  it('candidate lists without evidence fields (legacy callers) are never floored', () => {
    expect(memory.assessRecallEvidence([hit(P.decision, 1.0)]).level).toBe('ok');
  });
});

describe('mmrSelect', () => {
  const items = [
    { title: 'alpha beta gamma', snippet: 'delta epsilon', score: 1 },
    { title: 'alpha beta gamma', snippet: 'delta epsilon zeta', score: 0.95 },
    { title: 'unrelated words here', snippet: 'totally different', score: 0.9 },
  ];
  it('trades a near-duplicate for a novel result, and lambda ≥ 1 disables diversity', () => {
    expect(memory.mmrSelect(items, 2, 0.5).map((i) => i.score)).toEqual([1, 0.9]);
    expect(memory.mmrSelect(items, 2, 1).map((i) => i.score)).toEqual([1, 0.95]);
  });
});

describe('lexical arm — bilingual analyzer and evidence fields', () => {
  it('matches French regardless of accents, in both directions', () => {
    expect(paths(search.searchNotes('reunion trimestrielle du comite'))[0]).toBe(P.reunion);
    expect(paths(search.searchNotes('où est hébergé le projet Cerf-volant ?'))[0]).toBe(P.ascii);
  });

  it('stopwords do not match and plurals conflate', () => {
    expect(search.searchNotes('the of and le la les des')).toEqual([]);
    expect(paths(search.searchNotes('databases'))).toContain(P.decision);
  });

  it('exposes coverage and lexical evidence per hit', () => {
    const full = search.searchNotes('PostgreSQL Lumen billing')[0];
    expect(full.coverage).toBeCloseTo(1, 6);
    expect(full.lexicalEvidence!).toBeGreaterThan(0);
    expect(full.lexicalRaw).toBe(full.score);
    // A term nothing contains carries most of the IDF mass → low coverage.
    const partial = search.searchNotes('zqxvbrt database')[0];
    expect(partial.coverage!).toBeLessThan(0.5);
    expect(partial.lexicalEvidence!).toBeLessThan(full.lexicalEvidence!);
  });

  it('filters by one type or several', () => {
    const one = paths(search.searchNotes('Lumen billing database', { type: 'project' }));
    expect(one).toEqual([P.project]);
    const many = paths(search.searchNotes('Lumen billing database', { type: ['project', 'digest'] }));
    expect(many.sort()).toEqual([P.project, P.typedDigest].sort());
  });

  it('builds a query-aware snippet instead of the first characters', () => {
    const r = search.searchNotes('zeppelin hangar key')[0];
    expect(r.path).toBe(P.long);
    expect(r.snippet).toContain('zeppelin hangar key');
    expect(r.snippet.startsWith('…')).toBe(true);
    expect(r.snippet.length).toBeLessThanOrEqual(210);
    expect(search.bestPassage('short text', 'anything')).toBe('short text');
  });
});

describe('hybridSearch — fusion, kNN depth, scope', () => {
  it('fetches a deep kNN list and filters it to the scope before ranking', async () => {
    semantic.ready = true;
    semantic.hits = [
      { path: P.project, score: 0.95 }, { path: P.index, score: 0.9 }, { path: P.task, score: 0.85 },
      { path: P.related, score: 0.8 },
    ];
    const out = await search.hybridSearch('PostgreSQL', { type: 'memory', limit: 5 });
    expect(semantic.lastK).toBeGreaterThanOrEqual(config.semanticCandidates);
    expect(paths(out)).not.toContain(P.project);
    expect(paths(out)).not.toContain(P.index);
    const related = out.find((r) => r.path === P.related)!;
    expect(related.semanticSim).toBe(0.8);
    expect(related.semanticScore).toBeGreaterThan(0);
  });

  it('a strong semantic-only hit can outrank a weak lexical one (score fusion)', async () => {
    semantic.ready = true;
    semantic.hits = [{ path: P.reunion, score: 0.92 }, { path: P.decision, score: 0.2 }];
    const out = await search.hybridSearch('database container restart dashboards', { type: 'memory', limit: 10 });
    const rank = (p: string) => paths(out).indexOf(p);
    expect(out.find((r) => r.path === P.reunion)!.lexicalScore).toBe(0);
    expect(rank(P.chatter)).toBe(0); // best lexical hit keeps its place…
    expect(rank(P.reunion)).toBeGreaterThanOrEqual(0);
    expect(rank(P.reunion)).toBeLessThan(rank(P.decision)); // …the weak lexical tail does not
    // Contributions are additive and the fused score is their (collection-weighted) sum.
    for (const r of out) expect(r.fusedScore).toBeGreaterThanOrEqual(r.lexicalScore + r.semanticScore - 1e-9);
  });

  it('HYBRID_FUSION=rrf restores reciprocal-rank fusion', async () => {
    cfg.hybridFusion = 'rrf';
    semantic.ready = true;
    semantic.hits = [{ path: P.decision, score: 0.9 }];
    const out = await search.hybridSearch('PostgreSQL Lumen billing database', { type: 'memory', limit: 5 });
    const top = out.find((r) => r.path === P.decision)!;
    expect(top.semanticScore).toBeCloseTo(1 / 61, 9);
    expect(top.lexicalScore).toBeLessThanOrEqual(1 / 61 + 1e-12);
  });

  it('falls back to raw lexical scores when the semantic arm is empty', async () => {
    const out = await search.hybridSearch('PostgreSQL Lumen billing', { type: 'memory', limit: 3 });
    expect(out[0].semanticScore).toBe(0);
    expect(out[0].score).toBe(out[0].lexicalRaw);
    expect(out[0].snippet.length).toBeGreaterThan(0);
    const bare = await search.hybridSearch('PostgreSQL Lumen billing', { type: 'memory', limit: 3, snippets: false });
    expect(bare[0].snippet).toBe('');
  });

  it('bumps the index version on every index mutation and probes for archived notes', async () => {
    const before = search.getIndexVersion();
    expect(search.hasArchivedNotes()).toBe(true);
    await search.indexNote(P.related);
    expect(search.getIndexVersion()).toBeGreaterThan(before);
    expect(search.hasArchivedNotes()).toBe(true);
  });
});

describe('memory_recall end to end', () => {
  it('ranks the decision first, keeps digests and email out of the top, returns a query-aware snippet', async () => {
    const r = await runMemoryRecall({ query: 'which database did we choose for Lumen billing', limit: 5 });
    expect(r.results[0].path).toBe(P.decision);
    const top3 = paths(r.results).slice(0, 3);
    expect(top3).not.toContain(P.digest);
    expect(top3).not.toContain(P.email);
    expect(r.results[0].snippet).toContain('PostgreSQL');
    // Default scope (durable): never structural notes.
    expect(paths(r.results)).not.toContain(P.index);
    expect(paths(r.results)).not.toContain(P.task);
  });

  it('abstains on a query nothing answers, and says so', async () => {
    const r = await runMemoryRecall({ query: 'zqxvbrt plonkwisp vantablorg database', limit: 5 });
    expect(r.results).toEqual([]);
    expect(r.text).toContain('Found 0 memories');
    expect(r.text).toContain('No memory matches this query well enough');
  });

  it('the default (durable) scope also recalls project notes, never index or task notes', async () => {
    const r = await runMemoryRecall({ query: 'Lumen project overview', limit: 10 });
    expect(paths(r.results)).toContain(P.project);
    expect(paths(r.results)).not.toContain(P.index);
    expect(paths(r.results)).not.toContain(P.task);
  });

  it('RECALL_SCOPE=memory restores the memory-only pool', async () => {
    cfg.recallScope = 'memory';
    const r = await runMemoryRecall({ query: 'Lumen project overview', limit: 10 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(paths(r.results)).not.toContain(P.project);
  });

  it('explain output carries the per-arm scores and signals without repeating the summary line', async () => {
    const r = await runMemoryRecall({ query: 'Lumen billing database', limit: 3, explain: true });
    const payload = JSON.parse(r.text.split('\n\n').at(-1)!) as { results: Array<Record<string, unknown>> };
    const first = payload.results[0];
    expect(Object.keys(first).sort()).toEqual(['importance', 'lexical', 'path', 'score', 'semantic', 'signals']);
    const signals = first.signals as Record<string, unknown>;
    expect(signals.match).toBe('lexical');
    expect(signals).not.toHaveProperty('reason');
    expect(signals).not.toHaveProperty('temperature');
    // The reason still reaches the agent — once, on the summary line.
    expect(r.text.split('\n')[2]).toContain('lexical match');
  });

  it('renders a graph contribution and a low-confidence caveat when present', () => {
    const base = {
      path: 'a.md', title: 'A', category: 'fact', temperature: 'warm', importance: 'medium',
      score: 0.5, lexicalScore: 0, semanticScore: 0, graphScore: 0.08, fusedScore: 0.08, snippet: '',
    };
    const out = renderRecall([base], { includeContent: false, explain: true, confidence: 'low' });
    expect(out.text).toContain('Low confidence');
    expect(JSON.parse(out.text.split('\n\n').at(-1)!).results[0].graph).toBe(0.08);
    expect(renderRecall([base], { includeContent: false, explain: false }).text).not.toContain('Low confidence');
  });

  it('applies the reranker AFTER re-scoring, on best-matching passages, and keeps its order', async () => {
    const plain = await runMemoryRecall({ query: 'Lumen billing database', limit: 3 });
    expect(reranker.calls).toHaveLength(0); // not configured → never called
    reranker.enabled = true;
    const reranked = await runMemoryRecall({ query: 'Lumen billing database', limit: 3 });
    expect(reranker.calls).toHaveLength(1); // once, not once per search
    const shown = reranker.calls[0];
    expect(shown.length).toBeGreaterThan(3); // a few extra candidates to promote from
    for (const c of shown) expect(c.snippet.length).toBeGreaterThan(0);
    // The mock reverses the candidates: the final order is the reranker's.
    expect(reranked.results).toHaveLength(3);
    expect(reranked.results[0].title).toBe(shown[shown.length - 1].title);
    expect(paths(reranked.results)).not.toEqual(paths(plain.results));
  });

  it('formats reranker candidates with a bounded, whitespace-collapsed passage', () => {
    const line = formatRerankCandidates([{ index: 0, title: 'T', snippet: `a\n\n  b ${'x'.repeat(1000)}` }]);
    expect(line.startsWith('1. T — a b x')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('1. T — '.length + RERANK_PASSAGE_CHARS);
  });
});

describe('memory kinds — one rule for scope and tiers', () => {
  it('indexes a memory_kind for every note (classifier = source of truth)', () => {
    const dm = search.getDocMeta();
    expect(dm.get(P.decision)!.memory_kind).toBe('semantic');
    expect(dm.get(P.email)!.memory_kind).toBe('episodic');
    expect(dm.get(P.digest)!.memory_kind).toBe('episodic');
    expect(dm.get(P.hookEcho)!.memory_kind).toBe('episodic');
    expect(dm.get(P.diary)!.memory_kind).toBe('episodic');
    expect(dm.get(P.project)!.memory_kind).toBe('semantic');
  });

  it('episodic notes are the low-priority tier; an explicit memory_kind wins', () => {
    expect(memory.recallTierOf(P.hookEcho, { type: 'memory', source: 'hook:PostToolUse:Bash' })).toBe('episodic');
    expect(memory.recallTierOf(P.email, { type: 'memory', title: 'Email - x' })).toBe('email');
    expect(memory.recallTierOf(P.email, { type: 'memory', title: 'Email - x', memory_kind: 'semantic' })).toBe('memory');
  });

  it('rescoreRecall honours a strict kind scope and lifts the demotion on opt-in', () => {
    const rs = () => [hit(P.email, 1.0), hit(P.decision, 0.9)];
    const strict = memory.rescoreRecall(rs(), { limit: 5, kinds: new Set(['semantic', 'procedural'] as const) });
    expect(paths(strict)).toEqual([P.decision]);
    const demoted = memory.rescoreRecall(rs(), { limit: 5 }).find((r) => r.path === P.email)!;
    const optedIn = memory.rescoreRecall(rs(), { limit: 5, episodicOptIn: true }).find((r) => r.path === P.email)!;
    expect(optedIn.score).toBeGreaterThan(demoted.score * 1.5);
  });

  it('resolveRecallKinds: default keeps episodic as a tier, explicit params are strict', () => {
    const all = (s: ReadonlySet<string>) => [...s].sort();
    expect(all(memory.resolveRecallKinds('q').kinds)).toEqual(['episodic', 'procedural', 'semantic']);
    expect(memory.resolveRecallKinds('q').episodicOptIn).toBe(false);
    expect(all(memory.resolveRecallKinds('q', { includeEpisodic: false }).kinds)).toEqual(['procedural', 'semantic']);
    expect(memory.resolveRecallKinds('q', { includeEpisodic: true }).episodicOptIn).toBe(true);
    expect(all(memory.resolveRecallKinds('q', { kinds: ['episodic'] }).kinds)).toEqual(['episodic']);
    cfg.recallEpisodic = 'exclude';
    expect(all(memory.resolveRecallKinds('which database').kinds)).toEqual(['procedural', 'semantic']);
    // A query that asks for the tier by name still reaches it.
    expect(all(memory.resolveRecallKinds('the email about the database').kinds)).toContain('episodic');
  });

  it('memory_recall: includeEpisodic:false drops episodic notes, kinds:[episodic] returns only them', async () => {
    const q = 'PostgreSQL Lumen billing database';
    const dm = search.getDocMeta();
    const base = await runMemoryRecall({ query: q, limit: 10 });
    expect(paths(base.results)).toContain(P.email); // reachable by default, as the low tier
    const strict = await runMemoryRecall({ query: q, limit: 10, includeEpisodic: false });
    expect(strict.results.length).toBeGreaterThan(0);
    for (const r of strict.results) expect(dm.get(r.path)!.memory_kind).not.toBe('episodic');
    const episodic = await runMemoryRecall({ query: q, limit: 10, kinds: ['episodic'] });
    expect(episodic.results.length).toBeGreaterThan(0);
    for (const r of episodic.results) expect(dm.get(r.path)!.memory_kind).toBe('episodic');
  });
});

describe('time-aware queries', () => {
  const NOW = new Date('2026-11-11T12:00:00Z');

  it('a period in the query becomes a date filter, is stripped from the search and is reported', async () => {
    const r = await runMemoryRecall(
      { query: 'which database did we choose for Lumen billing in March 2026', limit: 5, explain: true },
      { now: NOW },
    );
    expect(r.results[0].path).toBe(P.decision);
    expect(r.time).toMatchObject({ dateFrom: '2026-03-01', dateTo: '2026-03-31', phrases: ['in March 2026'] });
    expect(r.time!.outsidePeriod).toBeUndefined();
    expect(r.text).toContain('_Time: filtered to 2026-03-01 → 2026-03-31 ("in March 2026")._');
    expect(JSON.parse(r.text.split('\n\n').at(-1)!).time).toMatchObject({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
    // Notes written today are outside March: filtered out.
    expect(paths(r.results)).not.toContain(P.recent);
  });

  it('a parsed period that matches nothing is dropped once and flagged', async () => {
    const r = await runMemoryRecall(
      { query: 'which database did we choose for Lumen billing in January 2026', limit: 5 },
      { now: NOW },
    );
    expect(r.results[0].path).toBe(P.decision);
    expect(r.time).toMatchObject({ dateFrom: '2026-01-01', dateTo: '2026-01-31', outsidePeriod: true });
    expect(r.text).toContain('OUTSIDE the requested period');
  });

  it('explicit date parameters win and are never retried', async () => {
    const r = await runMemoryRecall(
      { query: 'which database did we choose for Lumen billing in March 2026', limit: 5, dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      { now: NOW },
    );
    expect(r.results).toEqual([]);
    expect(r.time).toMatchObject({ overridden: true });
    expect(r.time!.outsidePeriod).toBeUndefined();
  });

  it('planRecallTime widens parsed day bounds by the slack and leaves plain queries alone', () => {
    const plan = memory.planRecallTime('what did we decide yesterday about billing', {}, NOW);
    expect(plan).toMatchObject({ dateFrom: '2026-11-09', dateTo: '2026-11-11', parsedFilter: true, query: 'what did we decide about billing' });
    expect(plan.info).toMatchObject({ dateFrom: '2026-11-10', dateTo: '2026-11-10' });
    const plain = memory.planRecallTime('which database did we pick', {}, NOW);
    expect(plain).toMatchObject({ query: 'which database did we pick', parsedFilter: false, preferRecent: false });
    expect(plain.info).toBeUndefined();
    expect(memory.describeRecallTime(plain.info)).toBe('');
    cfg.recallTimeQuery = false;
    expect(memory.planRecallTime('what did we decide yesterday', {}, NOW).parsedFilter).toBe(false);
  });

  it('"latest" is a mild recency preference, never a filter', async () => {
    const plan = memory.planRecallTime('the latest quokka ledger location', {}, NOW);
    expect(plan).toMatchObject({ preferRecent: true, parsedFilter: false });
    const rs = () => [hit(P.long, 1.0), hit(P.recent, 1.0)];
    const out = memory.rescoreRecall(rs(), { limit: 5, preferRecent: true, coRecall: false });
    expect(out[0].path).toBe(P.recent);
    expect(out[0].score - out[1].score).toBeLessThanOrEqual(2 * memory.PREFER_RECENT_WEIGHT + 0.1);
    expect(paths(out)).toContain(P.long); // the older note is still returned
    const r = await runMemoryRecall({ query: 'the latest quokka ledger location', limit: 5 }, { now: NOW });
    expect(r.text).toContain('recent notes preferred');
  });

  it('date bounds are inclusive days even for notes stamped with a full instant', async () => {
    const p = 'Memories/fact/instant-stamp.md';
    await createNote(p, mem('Instant stamp', 'The wombat turbine was serviced.', { created: '2026-05-08T14:30:00.000Z' }));
    await search.indexNote(p);
    const got = await search.hybridSearch('wombat turbine', { dateFrom: '2026-05-08', dateTo: '2026-05-08' });
    expect(paths(got)).toContain(p);
    expect(paths(await search.hybridSearch('wombat turbine', { dateTo: '2026-05-07' }))).not.toContain(p);
  });
});

describe('chunk-aware snippets', () => {
  it('a semantic-only hit shows its best-matching chunk, a lexical hit its query passage', async () => {
    semantic.ready = true;
    semantic.hits = [
      { path: P.long, score: 0.9, chunk: { index: 3, start: 10, end: 60, text: 'The zeppelin hangar key is under the blue mat.' } },
    ];
    const out = await search.hybridSearch('where do we keep the airship door opener', { type: 'memory', limit: 5 });
    const long = out.find((r) => r.path === P.long)!;
    expect(long.lexicalScore).toBe(0);
    expect(long.chunk).toMatchObject({ index: 3, start: 10, end: 60 });
    expect(long.snippet).toBe('The zeppelin hangar key is under the blue mat.');
    const rescored = memory.rescoreRecall(
      await search.hybridSearch('where do we keep the airship door opener', { type: 'memory', limit: 5, snippets: false }),
      { limit: 5, query: 'where do we keep the airship door opener', minEvidence: false },
    );
    expect(rescored.find((r) => r.path === P.long)!.snippet).toBe('The zeppelin hangar key is under the blue mat.');
  });
});
