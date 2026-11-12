import { describe, expect, it } from 'vitest';
import { parseTimeQuery, hasDateFilter, __test } from '../time-query.js';

// Wednesday 11 November 2026 (ISO week 46: Mon 9 → Sun 15).
const NOW = new Date('2026-11-11T15:30:00Z');
const p = (q: string, now: Date = NOW, opts = {}) => parseTimeQuery(q, now, opts);

describe('parseTimeQuery — relative days', () => {
  it('yesterday / hier / today / avant-hier', () => {
    expect(p('what broke yesterday')).toMatchObject({ dateFrom: '2026-11-10', dateTo: '2026-11-10', strippedQuery: 'what broke' });
    expect(p("qu'est-ce qui a cassé hier")).toMatchObject({ dateFrom: '2026-11-10', dateTo: '2026-11-10', strippedQuery: "qu'est-ce qui a cassé" });
    expect(p("notes d'aujourd'hui")).toMatchObject({ dateFrom: '2026-11-11', dateTo: '2026-11-11' });
    expect(p('avant-hier le déploiement')).toMatchObject({ dateFrom: '2026-11-09', dateTo: '2026-11-09' });
  });

  it('yesterday across a month and a year boundary', () => {
    expect(p('yesterday', new Date('2026-12-01T08:00:00Z'))).toMatchObject({ dateFrom: '2026-11-30', dateTo: '2026-11-30' });
    expect(p('hier', new Date('2027-01-01T08:00:00Z'))).toMatchObject({ dateFrom: '2026-12-31', dateTo: '2026-12-31' });
  });

  it('does not see "hier" inside other words', () => {
    const r = p('hierarchy of recall arms');
    expect(hasDateFilter(r)).toBe(false);
    expect(r.strippedQuery).toBe('hierarchy of recall arms');
  });
});

describe('parseTimeQuery — weeks', () => {
  it('last week is the previous ISO week (Mon–Sun)', () => {
    expect(p('what did we decide last week about the sync')).toMatchObject({
      dateFrom: '2026-11-02', dateTo: '2026-11-08', strippedQuery: 'what did we decide about the sync',
    });
  });

  it('French with and without accents', () => {
    expect(p('la semaine dernière')).toMatchObject({ dateFrom: '2026-11-02', dateTo: '2026-11-08', strippedQuery: '' });
    expect(p('la semaine derniere sur cortexmd')).toMatchObject({ dateFrom: '2026-11-02', strippedQuery: 'sur cortexmd' });
    expect(p('LA SEMAINE PASSÉE')).toMatchObject({ dateFrom: '2026-11-02', dateTo: '2026-11-08' });
  });

  it('week boundaries: on a Monday and on a Sunday', () => {
    expect(p('last week', new Date('2026-11-09T00:30:00Z'))).toMatchObject({ dateFrom: '2026-11-02', dateTo: '2026-11-08' });
    expect(p('last week', new Date('2026-11-15T23:00:00Z'))).toMatchObject({ dateFrom: '2026-11-02', dateTo: '2026-11-08' });
    expect(__test.isoWeekStart('2026-11-15')).toBe('2026-11-09');
  });

  it('last week across a year rollover', () => {
    // Fri 1 Jan 2027 → ISO week starts Mon 28 Dec 2026; previous week 21–27 Dec.
    expect(p('last week', new Date('2027-01-01T12:00:00Z'))).toMatchObject({ dateFrom: '2026-12-21', dateTo: '2026-12-27' });
  });

  it('this week / cette semaine run Monday → today', () => {
    expect(p('this week')).toMatchObject({ dateFrom: '2026-11-09', dateTo: '2026-11-11' });
    expect(p('cette semaine')).toMatchObject({ dateFrom: '2026-11-09', dateTo: '2026-11-11' });
  });
});

describe('parseTimeQuery — months and years', () => {
  it('last month / le mois dernier, including January rollover', () => {
    expect(p('last month')).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    expect(p('le mois dernier')).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    expect(p('le mois dernier', new Date('2027-01-15T00:00:00Z'))).toMatchObject({ dateFrom: '2026-12-01', dateTo: '2026-12-31' });
    expect(p('last month', new Date('2026-03-31T00:00:00Z'))).toMatchObject({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  });

  it('in October / en octobre resolve to the most recent past occurrence', () => {
    expect(p('deploys in October')).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-31', strippedQuery: 'deploys' });
    expect(p('en octobre')).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    // In March 2026, "in October" means October 2025.
    expect(p('in October', new Date('2026-03-10T00:00:00Z'))).toMatchObject({ dateFrom: '2025-10-01', dateTo: '2025-10-31' });
    // The current month is the current year.
    expect(p('in November')).toMatchObject({ dateFrom: '2026-11-01', dateTo: '2026-11-30' });
  });

  it('in October 2026 / en février 2024 (leap year)', () => {
    expect(p('incidents in October 2026')).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-31', strippedQuery: 'incidents' });
    expect(p('en février 2024')).toMatchObject({ dateFrom: '2024-02-01', dateTo: '2024-02-29' });
    expect(p('en fevrier 2024')).toMatchObject({ dateFrom: '2024-02-01', dateTo: '2024-02-29' });
  });

  it('since March / depuis mars set only dateFrom', () => {
    const r = p('what changed since March');
    expect(r).toMatchObject({ dateFrom: '2026-03-01', strippedQuery: 'what changed' });
    expect(r.dateTo).toBeUndefined();
    expect(p('depuis mars')).toMatchObject({ dateFrom: '2026-03-01' });
    // Since December, asked in November → last December.
    expect(p('since December')).toMatchObject({ dateFrom: '2025-12-01' });
  });

  it('before / after / until a month', () => {
    expect(p('before March 2026')).toMatchObject({ dateTo: '2026-02-28' });
    expect(p('after June')).toMatchObject({ dateFrom: '2026-07-01' });
    expect(p("jusqu'en juin 2026")).toMatchObject({ dateTo: '2026-06-30' });
    expect(p('avant septembre')).toMatchObject({ dateTo: '2026-08-31' });
  });

  it('specific days and ISO dates with a preposition', () => {
    expect(p('le 3 mars')).toMatchObject({ dateFrom: '2026-03-03', dateTo: '2026-03-03' });
    expect(p('on March 3rd 2025')).toMatchObject({ dateFrom: '2025-03-03', dateTo: '2025-03-03' });
    expect(p('since 2026-09-15')).toMatchObject({ dateFrom: '2026-09-15' });
    expect(p('in 2026-10')).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  });

  it('years', () => {
    expect(p('in 2025')).toMatchObject({ dateFrom: '2025-01-01', dateTo: '2025-12-31' });
    expect(p('en 2025')).toMatchObject({ dateFrom: '2025-01-01', dateTo: '2025-12-31' });
    expect(p('last year')).toMatchObject({ dateFrom: '2025-01-01', dateTo: '2025-12-31' });
    expect(p("l'année dernière")).toMatchObject({ dateFrom: '2025-01-01', dateTo: '2025-12-31' });
    expect(p('this year')).toMatchObject({ dateFrom: '2026-01-01', dateTo: '2026-11-11' });
  });

  it('as of → asOf', () => {
    expect(p('office location as of March 2026')).toMatchObject({ asOf: '2026-03-31', strippedQuery: 'office location' });
    expect(p('as of 2026-02-01')).toMatchObject({ asOf: '2026-02-01' });
  });
});

describe('parseTimeQuery — last N / ago', () => {
  it('last 3 days, past two weeks, les 3 derniers mois', () => {
    expect(p('errors in the last 3 days')).toMatchObject({ dateFrom: '2026-11-09', dateTo: '2026-11-11', strippedQuery: 'errors' });
    expect(p('past two weeks')).toMatchObject({ dateFrom: '2026-10-29', dateTo: '2026-11-11' });
    expect(p('les 3 derniers mois')).toMatchObject({ dateFrom: '2026-08-12', dateTo: '2026-11-11' });
  });

  it('N days ago / il y a N semaines', () => {
    expect(p('3 days ago')).toMatchObject({ dateFrom: '2026-11-08', dateTo: '2026-11-08' });
    expect(p('il y a 2 semaines')).toMatchObject({ dateFrom: '2026-10-26', dateTo: '2026-11-01' });
    expect(p('two months ago')).toMatchObject({ dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  });
});

describe('parseTimeQuery — recency', () => {
  it('latest / most recent / récemment set preferRecent without filtering', () => {
    const r = p('latest cortexmd version');
    expect(r.preferRecent).toBe(true);
    expect(hasDateFilter(r)).toBe(false);
    expect(r.strippedQuery).toBe('cortexmd version');
    expect(p('most recent decision on embeddings')).toMatchObject({ preferRecent: true, strippedQuery: 'decision on embeddings' });
    expect(p('récemment')).toMatchObject({ preferRecent: true, strippedQuery: '' });
    expect(p('recemment sur le dashboard')).toMatchObject({ preferRecent: true, strippedQuery: 'sur le dashboard' });
  });

  it('current / actuel keep the word in the query', () => {
    expect(p('current deploy target')).toMatchObject({ preferRecent: true, strippedQuery: 'current deploy target' });
    expect(p('la config actuelle')).toMatchObject({ preferRecent: true, strippedQuery: 'la config actuelle' });
    expect(p('la dernière version de cortexmd')).toMatchObject({ preferRecent: true });
  });

  it('"mise à jour" is not a recency phrase that eats words', () => {
    expect(p('mise à jour du serveur').strippedQuery).toBe('mise à jour du serveur');
  });
});

describe('parseTimeQuery — unresolved anchors', () => {
  it('before the v1.18 release → anchor, no filter, query kept', () => {
    const r = p('what did recall look like before the v1.18 release');
    expect(hasDateFilter(r)).toBe(false);
    expect(r.unresolved).toEqual(['the v1.18 release']);
    expect(r.matched).toEqual([expect.objectContaining({ kind: 'anchor', anchor: 'the v1.18 release' })]);
    expect(r.strippedQuery).toBe('what did recall look like before the v1.18 release');
  });

  it('avant la migration → anchor', () => {
    expect(p('avant la migration S3').unresolved).toEqual(['la migration S3']);
  });

  it('plain "before" without an event noun is ignored', () => {
    const r = p('things to check before deploying');
    expect(r.matched).toEqual([]);
    expect(r.strippedQuery).toBe('things to check before deploying');
  });
});

describe('parseTimeQuery — false positives', () => {
  it.each([
    'The Hunt for Red October',
    'notes from the October Summit',
    'March Madness bracket',
    'in March Madness pools',
    'Révolution d\'octobre',
    'August Rush soundtrack',
    'this may break the build',
    'it may be in may-be state',
    'mission to Mars',
    'buffer of 2048 bytes',
    'in 2048 bytes',
    'version 2026.1 notes',
    'decembre',
    'sept agents en parallèle',
    'run tests in mar',
    'in dec mode',
  ])('%s → no date filter', (q) => {
    expect(hasDateFilter(p(q))).toBe(false);
  });

  it('keeps the original query when nothing matched', () => {
    expect(p('sync conflicts on the webdav vault')).toEqual({ strippedQuery: 'sync conflicts on the webdav vault', matched: [] });
  });

  it('handles empty / non-string input', () => {
    expect(p('')).toEqual({ strippedQuery: '', matched: [] });
    expect(parseTimeQuery(undefined as unknown as string, NOW)).toEqual({ strippedQuery: '', matched: [] });
  });

  it('conflicting bounds drop the filter and only prefer recent', () => {
    const r = p('since November before March');
    expect(hasDateFilter(r)).toBe(false);
    expect(r.preferRecent).toBe(true);
  });

  it('intersects compatible bounds', () => {
    expect(p('since March 2026 before June 2026')).toMatchObject({ dateFrom: '2026-03-01', dateTo: '2026-05-31' });
  });
});

describe('parseTimeQuery — explicit caller bounds win', () => {
  it('explicit dateFrom/dateTo override parsed ones', () => {
    const r = p('last week deploys', NOW, { dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect(r).toMatchObject({ dateFrom: '2026-01-01', dateTo: '2026-01-31', overridden: true, strippedQuery: 'deploys' });
  });

  it('explicit asOf alone also drops parsed range', () => {
    const r = p('in October', NOW, { asOf: '2026-05-01' });
    expect(r.asOf).toBe('2026-05-01');
    expect(r.dateFrom).toBeUndefined();
    expect(r.dateTo).toBeUndefined();
  });

  it('invalid explicit values are ignored', () => {
    expect(p('in October', NOW, { dateFrom: 'garbage' })).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
  });
});

describe('parseTimeQuery — locale', () => {
  it('locale en ignores French-only phrases', () => {
    expect(hasDateFilter(p('hier', NOW, { locale: 'en' }))).toBe(false);
    expect(hasDateFilter(p('en octobre', NOW, { locale: 'en' }))).toBe(false);
    expect(p('in October', NOW, { locale: 'en' })).toMatchObject({ dateFrom: '2026-10-01' });
  });

  it('locale fr ignores English-only phrases', () => {
    expect(hasDateFilter(p('yesterday', NOW, { locale: 'fr' }))).toBe(false);
    expect(p('hier', NOW, { locale: 'fr' })).toMatchObject({ dateFrom: '2026-11-10' });
  });
});

describe('fold', () => {
  it('preserves length while folding accents, case and curly quotes', () => {
    const s = 'L’Année DERNIÈRE';
    expect(__test.fold(s)).toBe("l'annee derniere");
    expect(__test.fold(s).length).toBe(s.length);
  });
});
