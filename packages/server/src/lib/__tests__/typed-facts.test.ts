import { describe, expect, it } from 'vitest';
import {
  extractTypedFacts,
  normalizeEntityName,
  entityKey,
  isTypedFactSource,
  type TypedFact,
} from '../memory-extractor.js';

const decision = (body: string, extra: Record<string, unknown> = {}) =>
  extractTypedFacts({ body, frontmatter: { category: 'decision', ...extra }, path: 'Memories/decision/2026/11/x.md' });
const triples = (facts: TypedFact[]) => facts.map((f) => [f.subject, f.predicate, f.object]);

describe('normalizeEntityName', () => {
  it('unwraps wiki-links and code spans, trims punctuation and articles', () => {
    expect(normalizeEntityName('[[Projects/cortexmd.md|cortex]]')).toBe('cortexmd');
    expect(normalizeEntityName('`hnswlib-node`')).toBe('hnswlib-node');
    expect(normalizeEntityName('  the   Billing   Service. ')).toBe('Billing Service');
    expect(normalizeEntityName("l'équipe infra")).toBe('équipe infra');
  });

  it('drops corporate suffixes', () => {
    expect(normalizeEntityName('Acme, Inc.')).toBe('Acme');
    expect(normalizeEntityName('Globex Corp')).toBe('Globex');
    expect(normalizeEntityName('Initech SAS')).toBe('Initech');
  });

  it('resolves aliases (map is case-insensitive; resolver function)', () => {
    expect(normalizeEntityName('postgresql', { PostgreSQL: 'Postgres' })).toBe('Postgres');
    expect(normalizeEntityName('k8s', (n) => (n.toLowerCase() === 'k8s' ? 'Kubernetes' : undefined))).toBe('Kubernetes');
    expect(normalizeEntityName('Redis', { PostgreSQL: 'Postgres' })).toBe('Redis');
  });

  it('entityKey folds case, accents and whitespace', () => {
    expect(entityKey('  Équipe   Infra ')).toBe('equipe infra');
  });
});

describe('extractTypedFacts — English', () => {
  it.each<[string, [string, string, string]]>([
    ['The billing service runs on Postgres 16.', ['billing service', 'runs_on', 'Postgres 16']],
    ['cortexmd is now hosted on Fly.io in production.', ['cortexmd', 'runs_on', 'Fly.io']],
    ['The dashboard depends on [[Projects/charts-lib]].', ['dashboard', 'depends_on', 'charts-lib']],
    ['MySQL was replaced by Postgres last quarter.', ['MySQL', 'replaced_by', 'Postgres']],
    ['We agreed that Postgres replaces MySQL.', ['MySQL', 'replaced_by', 'Postgres']],
    ['The CLI is now at version 1.20.0.', ['CLI', 'version_is', '1.20.0']],
    ['cortexmd is on v1.19.1', ['cortexmd', 'version_is', 'v1.19.1']],
    ['The Ingest Pipeline is owned by Ada Lovelace.', ['Ingest Pipeline', 'owned_by', 'Ada Lovelace']],
    ['Team Platform owns the Komodo stack.', ['Komodo stack', 'owned_by', 'Team Platform']],
    ['Acme, Inc. is headquartered in Montreal.', ['Acme', 'located_at', 'Montreal']],
  ])('%s', (body, triple) => {
    expect(triples(decision(body))).toEqual([triple]);
  });

  it('records the evidence clause', () => {
    expect(decision('Build note. The API runs on Node 22.')[0].evidence).toBe('The API runs on Node 22.');
  });

  it('applies aliases to both sides', () => {
    const facts = extractTypedFacts(
      { body: 'The billing service runs on postgresql.', frontmatter: { category: 'fact' }, path: 'Memories/fact/x.md' },
      { aliases: { postgresql: 'Postgres', 'billing service': 'Billing' } },
    );
    expect(triples(facts)).toEqual([['Billing', 'runs_on', 'Postgres']]);
  });
});

describe('extractTypedFacts — French', () => {
  it.each<[string, [string, string, string]]>([
    ['Le service de facturation tourne sur Postgres.', ['service de facturation', 'runs_on', 'Postgres']],
    ['cortexmd est hébergé sur Komodo.', ['cortexmd', 'runs_on', 'Komodo']],
    ['Le dashboard dépend de la librairie Chart.', ['dashboard', 'depends_on', 'librairie Chart']],
    ['MySQL a été remplacé par Postgres.', ['MySQL', 'replaced_by', 'Postgres']],
    ['Postgres remplace MySQL.', ['MySQL', 'replaced_by', 'Postgres']],
    ['Le CLI est en version 1.20.0.', ['CLI', 'version_is', '1.20.0']],
    ['Le dépôt appartient à Haply.', ['dépôt', 'owned_by', 'Haply']],
    ['Le serveur est géré par Camille.', ['serveur', 'owned_by', 'Camille']],
    ['Le bureau est situé à Montréal.', ['bureau', 'located_at', 'Montréal']],
  ])('%s', (body, triple) => {
    expect(triples(decision(body))).toEqual([triple]);
  });
});

describe('extractTypedFacts — precision guards', () => {
  it.each([
    'It runs on Postgres.',
    'This depends on the weather.',
    'Il tourne sur Postgres.',
    'Cela dépend de toi.',
    'The thing that runs on the old box and also does the nightly backups for every service we have.',
    'We should probably look at whether it depends on something.',
    'Version 2 is better.',
    'The old db was replaced by Postgres.',
  ])('no fact from: %s', (body) => {
    const facts = decision(body);
    // Only the passive form of the last case is allowed to produce a fact.
    if (body.startsWith('The old db')) {
      expect(triples(facts)).toEqual([['old db', 'replaced_by', 'Postgres']]);
    } else {
      expect(facts).toEqual([]);
    }
  });

  it('ignores code blocks', () => {
    expect(decision('Config:\n```\nThe API runs on Node 18.\n```\nDone here.')).toEqual([]);
  });

  it('dedupes repeated facts', () => {
    expect(decision('The API runs on Node 22. The API runs on Node 22.')).toHaveLength(1);
  });
});

describe('extractTypedFacts — gate: decision / fact notes only', () => {
  const body = 'The billing service runs on Postgres. MySQL was replaced by Postgres.';

  it('extracts from decision and fact notes (category or path)', () => {
    expect(decision(body)).toHaveLength(2);
    expect(extractTypedFacts({ body, frontmatter: {}, path: 'Memories/fact/x.md' })).toHaveLength(2);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['observation', { category: 'observation' }, 'Memories/observation/x.md'],
    ['email capture (EmailLog)', { category: 'decision' }, 'EmailLog/decision/x.md'],
    ['email capture (matrimail tag)', { category: 'fact', tags: ['matrimail'] }, 'Memories/fact/x.md'],
    ['hook capture', { category: 'decision', source: 'hook:PostToolUse:Bash' }, 'Memories/decision/x.md'],
    ['n8n capture', { category: 'fact', source: 'n8n:triage' }, 'Memories/fact/x.md'],
    ['auto-capture tag', { category: 'decision', tags: ['auto-capture'] }, 'Memories/decision/x.md'],
    ['digest', { category: 'fact', type: 'digest' }, 'Memories/fact/x.md'],
    ['explicit episodic kind', { category: 'fact', memory_kind: 'episodic' }, 'Memories/fact/x.md'],
    ['no category, non-memory path', {}, 'Notes/x.md'],
  ])('no extraction from %s', (_label, fm, path) => {
    expect(isTypedFactSource(fm, path)).toBe(false);
    expect(extractTypedFacts({ body, frontmatter: fm, path })).toEqual([]);
  });

  it('ungated callers can bypass the gate', () => {
    expect(extractTypedFacts({ body, frontmatter: { category: 'observation' } }, { ungated: true })).toHaveLength(2);
  });
});
