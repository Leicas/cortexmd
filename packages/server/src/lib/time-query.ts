/**
 * Time-aware query parsing for recall (English + French, accent-insensitive).
 *
 * `parseTimeQuery("what did we decide last week about the sync", now)` returns
 * `{ dateFrom: '2026-11-02', dateTo: '2026-11-08', strippedQuery: 'what did we
 * decide about the sync', matched: [...] }` so the recall path can filter by
 * note date and search on the topical part of the query only.
 *
 * Contract:
 *   - Pure and deterministic: no I/O, no LLM, no dependency. All calendar
 *     arithmetic is done in UTC on `now` (the store path stamps `created` from
 *     `toISOString()`, i.e. UTC days too).
 *   - `dateFrom` / `dateTo` are INCLUSIVE `YYYY-MM-DD` days ("in October" →
 *     2026-10-01 … 2026-10-31). `asOf` is a `YYYY-MM-DD` day ("as of March
 *     2026" → the last day of March).
 *   - Weeks are ISO weeks (Monday → Sunday).
 *   - A bare month ("in October") resolves to its most recent occurrence that
 *     is not in the future (in November 2026 → October 2026; in March 2026 →
 *     October 2025).
 *   - Precision over recall: month names only count after a temporal
 *     preposition ("in/since/before/en/depuis/avant…"), never when followed by
 *     a capitalised word ("in March Madness", "the October Summit"), and years
 *     only between 2000 and next year. An event anchor with no date ("before
 *     the v1.18 release") is reported (`unresolved`) but never filters. When
 *     signals conflict (empty range) no date filter is returned.
 *   - Recency words ("latest", "most recent", "current", "récemment"…) only set
 *     `preferRecent: true` — they never filter.
 *   - Caller-supplied `dateFrom` / `dateTo` / `asOf` always win: when any
 *     explicit bound is given, parsed bounds are ignored (matches are still
 *     reported and stripped).
 *   - `strippedQuery` is the query minus the matched temporal phrases (and the
 *     strippable recency words). It may be EMPTY ("last week") — callers fall
 *     back to the original query, or to a date-only listing, in that case.
 */

export type TimeQueryLocale = 'en' | 'fr' | 'auto';

export interface TimeQueryOptions {
  /** Restrict the rule set to one language. Default 'auto' (both). */
  locale?: TimeQueryLocale;
  /** Explicit caller bounds — always win over anything parsed. */
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
}

export type TimeMatchKind = 'range' | 'as_of' | 'recent' | 'anchor';

export interface TimeMatch {
  /** The phrase as it appears in the original query. */
  phrase: string;
  kind: TimeMatchKind;
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
  /** Unresolved event anchor ("the v1.18 release"), kind === 'anchor' only. */
  anchor?: string;
}

export interface TimeQueryResult {
  dateFrom?: string;
  dateTo?: string;
  asOf?: string;
  preferRecent?: boolean;
  strippedQuery: string;
  matched: TimeMatch[];
  /** Event anchors that could not be resolved to a date (never filtered on). */
  unresolved?: string[];
  /** True when explicit caller bounds overrode the parsed ones. */
  overridden?: boolean;
}

// ---------------------------------------------------------------------------
// Calendar helpers (UTC)
// ---------------------------------------------------------------------------

interface Day { y: number; m: number; d: number } // m: 1-12
interface Period { from: Day; to: Day }

function dayOf(date: Date): Day {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}
function toDate(day: Day): Date {
  return new Date(Date.UTC(day.y, day.m - 1, day.d));
}
function iso(day: Day): string {
  return toDate(day).toISOString().slice(0, 10);
}
function addDays(day: Day, n: number): Day {
  const t = toDate(day);
  t.setUTCDate(t.getUTCDate() + n);
  return dayOf(t);
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthPeriod(y: number, m: number): Period {
  return { from: { y, m, d: 1 }, to: { y, m, d: lastDayOfMonth(y, m) } };
}
function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
function isoWeekStart(day: Day): Day {
  const dow = toDate(day).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

// ---------------------------------------------------------------------------
// Vocabulary (matched against the folded = lowercased, accent-stripped query)
// ---------------------------------------------------------------------------

const MONTHS: Array<[RegExp, number]> = [
  [/^(january|jan|janvier|janv)$/, 1],
  [/^(february|feb|fevrier|fevr|fev)$/, 2],
  [/^(march|mar|mars)$/, 3],
  [/^(april|apr|avril|avr)$/, 4],
  [/^(may|mai)$/, 5],
  [/^(june|jun|juin)$/, 6],
  [/^(july|jul|juillet|juil)$/, 7],
  [/^(august|aug|aout)$/, 8],
  [/^(september|sept|sep|septembre)$/, 9],
  [/^(october|oct|octobre)$/, 10],
  [/^(november|nov|novembre)$/, 11],
  [/^(december|dec|decembre)$/, 12],
];
const MONTH_ALT =
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|' +
  'jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|janv|fevr|fev|avr|juil';
const EN_ONLY_MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec',
]);
const FR_ONLY_MONTHS = new Set([
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre',
  'novembre', 'decembre', 'janv', 'fevr', 'fev', 'avr', 'juil',
]);

const AMBIGUOUS_ABBREVIATIONS = new Set([
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec', 'janv', 'fevr', 'fev', 'avr', 'juil',
]);

function monthNumber(token: string): number | undefined {
  for (const [re, n] of MONTHS) if (re.test(token)) return n;
  return undefined;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, a: 1, an: 1,
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12,
};
const NUM = '\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze';
function parseNum(s: string): number | undefined {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NUMBER_WORDS[s];
}

type Unit = 'day' | 'week' | 'month' | 'year';
function unitOf(s: string): Unit | undefined {
  if (/^(days?|jours?)$/.test(s)) return 'day';
  if (/^(weeks?|semaines?)$/.test(s)) return 'week';
  if (/^(months?|mois)$/.test(s)) return 'month';
  if (/^(years?|ans?|annees?)$/.test(s)) return 'year';
  return undefined;
}

// Prepositions → how a resolved period maps to bounds.
type Rel = 'in' | 'since' | 'after' | 'before' | 'until' | 'as_of';
const PREP_ALT =
  "as of|as at|en date du|a la date du|in early|in late|in mid|in|during|over|throughout|on|since|from|after|before|until|till|up to|" +
  "en|pendant|durant|au cours de|au mois d'|au mois de|courant|debut|fin|le|depuis|a partir d'|a partir de|apres|avant|jusqu'en|jusqu'au|jusqu'a|d'ici";
function relOf(prep: string): Rel {
  const p = prep.replace(/\s+/g, ' ');
  if (/^(as of|as at|en date du|a la date du)$/.test(p)) return 'as_of';
  if (/^(since|depuis|a partir d'|a partir de)$/.test(p)) return 'since';
  if (/^(after|apres)$/.test(p)) return 'after';
  if (/^(before|avant)$/.test(p)) return 'before';
  if (/^(until|till|up to|jusqu'en|jusqu'au|jusqu'a|d'ici)$/.test(p)) return 'until';
  return 'in';
}
const FR_PREPS = /^(en|pendant|durant|au cours de|au mois d'|au mois de|courant|debut|fin|le|depuis|a partir d'|a partir de|apres|avant|jusqu'en|jusqu'au|jusqu'a|d'ici|en date du|a la date du)$/;

/** Map a period + relation to (dateFrom, dateTo) or asOf. */
function bounds(rel: Rel, p: Period): Pick<TimeMatch, 'dateFrom' | 'dateTo' | 'asOf' | 'kind'> {
  switch (rel) {
    case 'since': return { kind: 'range', dateFrom: iso(p.from) };
    case 'after': return { kind: 'range', dateFrom: iso(addDays(p.to, 1)) };
    case 'before': return { kind: 'range', dateTo: iso(addDays(p.from, -1)) };
    case 'until': return { kind: 'range', dateTo: iso(p.to) };
    case 'as_of': return { kind: 'as_of', asOf: iso(p.to) };
    default: return { kind: 'range', dateFrom: iso(p.from), dateTo: iso(p.to) };
  }
}

// ---------------------------------------------------------------------------
// Folding (index-preserving: every UTF-16 unit maps to exactly one unit)
// ---------------------------------------------------------------------------

function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    let c = ch === '’' || ch === '‘' || ch === '`' ? "'" : ch;
    const lower = c.toLowerCase();
    if (lower.length === c.length) c = lower;
    const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += base.length === c.length ? base : c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface Ctx { now: Day; original: string; locale: TimeQueryLocale }
interface Hit extends TimeMatch { start: number; end: number; strip: boolean }
interface Rule {
  re: RegExp; // global, applied to the folded query
  lang: 'en' | 'fr' | 'any';
  resolve: (m: RegExpExecArray, ctx: Ctx) => Omit<Hit, 'start' | 'end' | 'phrase'> | null;
}

const B = '(?<![\\p{L}\\p{N}])';   // left word boundary (unicode-aware)
const E = '(?![\\p{L}\\p{N}])';    // right word boundary

function rx(src: string): RegExp {
  return new RegExp(src, 'gu');
}

function relDayRule(src: string, lang: Rule['lang'], offset: number): Rule {
  return {
    re: rx(`${B}(?:${src})${E}`), lang,
    resolve: (_m, ctx) => {
      const d = addDays(ctx.now, offset);
      return { kind: 'range', dateFrom: iso(d), dateTo: iso(d), strip: true };
    },
  };
}

/** Year in a plausible range for a memory vault, not a quantity. */
function plausibleYear(y: number, ctx: Ctx): boolean {
  return y >= 2000 && y <= ctx.now.y + 1;
}

/** Most recent occurrence of month `m` that is not in the future. */
function recentMonthYear(m: number, ctx: Ctx): number {
  return m > ctx.now.m ? ctx.now.y - 1 : ctx.now.y;
}

const RULES: Rule[] = [
  // ── Relative days ──────────────────────────────────────────────────────
  relDayRule("avant-hier|avant hier|the day before yesterday", 'any', -2),
  relDayRule("today|aujourd'hui|aujourdhui", 'any', 0),
  relDayRule('yesterday', 'en', -1),
  relDayRule('hier', 'fr', -1),

  // ── Relative weeks / months / years ────────────────────────────────────
  {
    re: rx(`${B}(?:(?:during |over )?(?:the )?(?:last|past|previous) week|(?:la )?semaine (?:derniere|passee|precedente))${E}`),
    lang: 'any',
    resolve: (_m, ctx) => {
      const start = addDays(isoWeekStart(ctx.now), -7);
      return { kind: 'range', dateFrom: iso(start), dateTo: iso(addDays(start, 6)), strip: true };
    },
  },
  {
    re: rx(`${B}(?:this week|cette semaine)${E}`), lang: 'any',
    resolve: (_m, ctx) => ({ kind: 'range', dateFrom: iso(isoWeekStart(ctx.now)), dateTo: iso(ctx.now), strip: true }),
  },
  {
    re: rx(`${B}(?:(?:during |over )?(?:the )?(?:last|past|previous) month|(?:le )?mois (?:dernier|passe|precedent))${E}`),
    lang: 'any',
    resolve: (_m, ctx) => {
      const { y, m } = addMonths(ctx.now.y, ctx.now.m, -1);
      const p = monthPeriod(y, m);
      return { kind: 'range', dateFrom: iso(p.from), dateTo: iso(p.to), strip: true };
    },
  },
  {
    re: rx(`${B}(?:this month|ce mois(?:-ci| ci)?)${E}`), lang: 'any',
    resolve: (_m, ctx) => ({ kind: 'range', dateFrom: iso({ ...ctx.now, d: 1 }), dateTo: iso(ctx.now), strip: true }),
  },
  {
    re: rx(`${B}(?:(?:the )?(?:last|previous) year|(?:l')?annee (?:derniere|passee|precedente)|l'an dernier|l'an passe)${E}`),
    lang: 'any',
    resolve: (_m, ctx) => ({ kind: 'range', dateFrom: `${ctx.now.y - 1}-01-01`, dateTo: `${ctx.now.y - 1}-12-31`, strip: true }),
  },
  {
    re: rx(`${B}(?:this year|cette annee)${E}`), lang: 'any',
    resolve: (_m, ctx) => ({ kind: 'range', dateFrom: `${ctx.now.y}-01-01`, dateTo: iso(ctx.now), strip: true }),
  },

  // ── "last 3 days", "past two weeks", "les 3 derniers jours" ─────────────
  {
    re: rx(`${B}(?:(?:in|over|during|within) )?(?:the )?(?:last|past) (${NUM}) (days?|weeks?|months?)${E}`),
    lang: 'en',
    resolve: (m, ctx) => lastN(m[1], m[2], ctx),
  },
  {
    re: rx(`${B}(?:(?:ces|les|depuis les|durant les|pendant les|au cours des) )?(${NUM}) (?:derniers jours|dernieres semaines|derniers mois)${E}`),
    lang: 'fr',
    resolve: (m, ctx) => {
      const unit = /jours/.test(m[0]) ? 'jours' : /semaines/.test(m[0]) ? 'semaines' : 'mois';
      return lastN(m[1], unit, ctx);
    },
  },

  // ── "3 days ago", "il y a 2 semaines" ──────────────────────────────────
  {
    re: rx(`${B}(${NUM}) (days?|weeks?|months?) ago${E}`), lang: 'en',
    resolve: (m, ctx) => ago(m[1], m[2], ctx),
  },
  {
    re: rx(`${B}il y a (${NUM}) (jours?|semaines?|mois)${E}`), lang: 'fr',
    resolve: (m, ctx) => ago(m[1], m[2], ctx),
  },

  // ── Preposition + ISO date / month(-year) / year ───────────────────────
  {
    re: rx(`${B}(${PREP_ALT}) (?:the |le |du )?(\\d{4})-(\\d{2})(?:-(\\d{2}))?${E}`), lang: 'any',
    resolve: (m, ctx) => {
      const y = parseInt(m[2], 10), mo = parseInt(m[3], 10), d = m[4] ? parseInt(m[4], 10) : undefined;
      if (!plausibleYear(y, ctx) || mo < 1 || mo > 12) return null;
      if (d !== undefined && (d < 1 || d > lastDayOfMonth(y, mo))) return null;
      const p: Period = d !== undefined ? { from: { y, m: mo, d }, to: { y, m: mo, d } } : monthPeriod(y, mo);
      return { ...bounds(relOf(m[1]), p), strip: true };
    },
  },
  {
    // "in October", "in October 2026", "since March", "en octobre", "depuis mars",
    // "before 3 March 2026", "le 3 mars". Month names only after a preposition.
    re: rx(`${B}(${PREP_ALT}) (?:(?:the |le )?(\\d{1,2})(?:st|nd|rd|th|er)? (?:of )?)?(${MONTH_ALT})\\.?(?: (\\d{1,2})(?:st|nd|rd|th)?)?(?:,? (\\d{4}))?${E}`),
    lang: 'any',
    resolve: (m, ctx) => {
      const [, prep, dayA, monthTok, dayB, yearTok] = m;
      if (ctx.locale === 'en' && FR_ONLY_MONTHS.has(monthTok) && !EN_ONLY_MONTHS.has(monthTok)) return null;
      if (ctx.locale === 'fr' && EN_ONLY_MONTHS.has(monthTok) && !FR_ONLY_MONTHS.has(monthTok)) return null;
      // Abbreviations ("mar", "dec", "sept" — also French for 7) are too
      // ambiguous without a day or a year.
      if (AMBIGUOUS_ABBREVIATIONS.has(monthTok) && !yearTok && !dayA && !dayB) return null;
      const mo = monthNumber(monthTok);
      if (!mo) return null;
      // A capitalised word right after the month (no year) = proper noun / title.
      const after = ctx.original.slice(m.index + m[0].length);
      if (!yearTok && /^\s+[A-ZÀ-Þ]/.test(after)) return null;
      // "may" is a modal verb: require a day, a year, or a sentence end after it.
      if (monthTok === 'may' && !yearTok && !dayA && !dayB && !/^\s*($|[.,;:!?)])/.test(after)) return null;
      const y = yearTok ? parseInt(yearTok, 10) : recentMonthYear(mo, ctx);
      if (!plausibleYear(y, ctx)) return null;
      const dayNum = dayA ? parseInt(dayA, 10) : dayB ? parseInt(dayB, 10) : undefined;
      if (dayNum !== undefined && (dayNum < 1 || dayNum > lastDayOfMonth(y, mo))) return null;
      const p: Period = dayNum !== undefined
        ? { from: { y, m: mo, d: dayNum }, to: { y, m: mo, d: dayNum } }
        : monthPeriod(y, mo);
      return { ...bounds(relOf(prep), p), strip: true };
    },
  },
  {
    // "in 2025", "since 2024", "en 2025" — not "in 2048 bytes".
    re: rx(`${B}(${PREP_ALT}) (\\d{4})${E}(?!\\s*(?:%|ms|s\\b|kb|mb|gb|bytes?|octets?|px|tokens?|lines?|lignes?|notes?|files?|fichiers?|items?|rows?|x\\b))`),
    lang: 'any',
    resolve: (m, ctx) => {
      const y = parseInt(m[2], 10);
      if (!plausibleYear(y, ctx)) return null;
      if (/^(on|le|over)$/.test(m[1])) return null;
      const p: Period = { from: { y, m: 1, d: 1 }, to: { y, m: 12, d: 31 } };
      return { ...bounds(relOf(m[1]), p), strip: true };
    },
  },

  // ── Unresolvable event anchors: reported, never filtered on ────────────
  {
    re: rx(`${B}(before|after|since|avant|apres|depuis) ((?:the|la|le|les|l'|our|notre) ?[^,;:.!?()]{1,60}?(?:release|launch|migration|deploy(?:ment)?|upgrade|rollout|refactor|rewrite|outage|incident|meeting|sortie|lancement|mise en prod(?:uction)?|deploiement|reunion|panne|refonte|version \\S+|v\\d[\\w.-]*)(?: \\S+)?)${E}`),
    lang: 'any',
    resolve: (m, ctx) => {
      // Report the anchor as written (folding lowercases it).
      const start = m.index + m[0].length - m[2].length;
      return { kind: 'anchor', anchor: ctx.original.slice(start, start + m[2].length).trim(), strip: false };
    },
  },

  // ── Recency preference (never filters) ─────────────────────────────────
  {
    re: rx(`${B}(?:the latest|latest|most recent(?:ly)?|newest|most up[- ]to[- ]date|recently|lately|these days|nowadays|le plus recent|la plus recente|les plus recent(?:e)?s|recemment|dernierement|ces derniers temps|en ce moment)${E}`),
    lang: 'any',
    resolve: () => ({ kind: 'recent', strip: true }),
  },
  {
    // Recency hints that may also be topical ("current sensor", "état actuel"):
    // set preferRecent but keep the words in the query.
    re: rx(`${B}(?:current(?:ly)?|recent|right now|actuel(?:le)?s?|actuellement|recente?s?|derniere? version|derniere? en date|(?:the|our|my) last(?! (?:\\d|${NUM}|week|month|year|day)))${E}`),
    lang: 'any',
    resolve: () => ({ kind: 'recent', strip: false }),
  },
];

function lastN(numTok: string, unitTok: string, ctx: Ctx): Omit<Hit, 'start' | 'end' | 'phrase'> | null {
  const n = parseNum(numTok);
  const unit = unitOf(unitTok);
  if (!n || !unit || n > 366) return null;
  let from: Day;
  if (unit === 'day') from = addDays(ctx.now, -(n - 1));
  else if (unit === 'week') from = addDays(ctx.now, -(7 * n - 1));
  else {
    const t = addMonths(ctx.now.y, ctx.now.m, -n);
    from = { y: t.y, m: t.m, d: Math.min(ctx.now.d, lastDayOfMonth(t.y, t.m)) };
    from = addDays(from, 1);
  }
  return { kind: 'range', dateFrom: iso(from), dateTo: iso(ctx.now), strip: true };
}

function ago(numTok: string, unitTok: string, ctx: Ctx): Omit<Hit, 'start' | 'end' | 'phrase'> | null {
  const n = parseNum(numTok);
  const unit = unitOf(unitTok);
  if (!n || !unit || n > 366) return null;
  if (unit === 'day') {
    const d = addDays(ctx.now, -n);
    return { kind: 'range', dateFrom: iso(d), dateTo: iso(d), strip: true };
  }
  if (unit === 'week') {
    const start = isoWeekStart(addDays(ctx.now, -7 * n));
    return { kind: 'range', dateFrom: iso(start), dateTo: iso(addDays(start, 6)), strip: true };
  }
  if (unit === 'month') {
    const t = addMonths(ctx.now.y, ctx.now.m, -n);
    const p = monthPeriod(t.y, t.m);
    return { kind: 'range', dateFrom: iso(p.from), dateTo: iso(p.to), strip: true };
  }
  return null;
}

function ruleAllowed(rule: Rule, locale: TimeQueryLocale): boolean {
  return locale === 'auto' || rule.lang === 'any' || rule.lang === locale;
}

function validIsoDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s.trim());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseTimeQuery(query: string, now: Date = new Date(), opts: TimeQueryOptions = {}): TimeQueryResult {
  const original = typeof query === 'string' ? query : '';
  const locale = opts.locale ?? 'auto';
  const ctx: Ctx = { now: dayOf(now), original, locale };
  const folded = fold(original);

  const hits: Hit[] = [];
  const overlaps = (s: number, e: number) => hits.some((h) => s < h.end && e > h.start);

  for (const rule of RULES) {
    if (!ruleAllowed(rule, locale)) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(folded)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) { rule.re.lastIndex++; continue; }
      if (overlaps(start, end)) continue;
      // French prepositions only under fr/auto; English ones only under en/auto.
      if (locale !== 'auto' && m[1] && rule.re.source.includes('as of|as at')) {
        const isFr = FR_PREPS.test(m[1]);
        if ((locale === 'en' && isFr) || (locale === 'fr' && !isFr)) continue;
      }
      let res: Omit<Hit, 'start' | 'end' | 'phrase'> | null = null;
      try { res = rule.resolve(m, ctx); } catch { res = null; }
      if (!res) continue;
      hits.push({ ...res, start, end, phrase: original.slice(start, end) });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  // Combine: intersect every range; as_of keeps the latest mention.
  let from: string | undefined;
  let to: string | undefined;
  let asOf: string | undefined;
  let preferRecent = false;
  const unresolved: string[] = [];
  for (const h of hits) {
    if (h.kind === 'range') {
      if (h.dateFrom && (!from || h.dateFrom > from)) from = h.dateFrom;
      if (h.dateTo && (!to || h.dateTo < to)) to = h.dateTo;
    } else if (h.kind === 'as_of') {
      asOf = h.asOf;
    } else if (h.kind === 'recent') {
      preferRecent = true;
    } else if (h.kind === 'anchor' && h.anchor) {
      unresolved.push(h.anchor);
    }
  }
  // Conflicting signals ("since November … before March") → don't filter.
  if (from && to && from > to) {
    from = undefined;
    to = undefined;
    preferRecent = true;
  }

  // Strip matched phrases (right to left to keep offsets valid).
  let stripped = original;
  for (const h of [...hits].sort((a, b) => b.start - a.start)) {
    if (!h.strip) continue;
    stripped = stripped.slice(0, h.start) + ' ' + stripped.slice(h.end);
  }
  stripped = stripped
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(^|\s)[,;:]+(?=\s|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[,;:\-–—]+\s*|\s*[,;:\-–—]+$/g, '')
    .trim();

  const result: TimeQueryResult = {
    strippedQuery: stripped,
    matched: hits.map(({ start: _s, end: _e, strip: _st, ...rest }) => rest),
  };

  const explicit = validIsoDay(opts.dateFrom) || validIsoDay(opts.dateTo) || validIsoDay(opts.asOf);
  if (explicit) {
    if (validIsoDay(opts.dateFrom)) result.dateFrom = opts.dateFrom!.trim();
    if (validIsoDay(opts.dateTo)) result.dateTo = opts.dateTo!.trim();
    if (validIsoDay(opts.asOf)) result.asOf = opts.asOf!.trim();
    if (from || to || asOf) result.overridden = true;
  } else {
    if (from) result.dateFrom = from;
    if (to) result.dateTo = to;
    if (asOf) result.asOf = asOf;
  }
  if (preferRecent) result.preferRecent = true;
  if (unresolved.length > 0) result.unresolved = unresolved;
  return result;
}

/** True when the parse produced a hard date filter (not just a recency hint). */
export function hasDateFilter(r: TimeQueryResult): boolean {
  return Boolean(r.dateFrom || r.dateTo || r.asOf);
}

/** Exposed for tests. */
export const __test = { fold, isoWeekStart: (d: string) => iso(isoWeekStart(dayOf(new Date(`${d}T00:00:00Z`)))) };
