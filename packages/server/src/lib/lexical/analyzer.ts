/**
 * Analyzer glue for the SQLite/FTS5 lexical backend.
 *
 * Parity contract with MiniSearch (lib/search.ts `createIndex`): MiniSearch
 * tokenizes with its default `SPACE_OR_PUNCTUATION` split and then runs every
 * token through `processTerm` (= `analyzeTerm` from lib/text-analyzer.ts). We do
 * EXACTLY the same here, in JS, before insert and at query time, so both
 * backends see the same term stream. FTS5 then only has to split on spaces —
 * the analysed terms are stored pre-tokenised (see `encodeTerm`).
 */
import { createHash } from 'node:crypto';
import { analyzeTerm, foldText, fuzzyForTerm, prefixForTerm } from '../text-analyzer.js';

/** MiniSearch's default tokenizer regex (minisearch/src/MiniSearch.ts). */
export const SPACE_OR_PUNCTUATION = /[\n\r\p{Z}\p{P}]+/u;

/** `analyze(text) → terms`: the injected analyzer both backends share. */
export type Analyzer = (text: string) => string[];

/**
 * Reference analyzer = exactly what MiniSearch does today: default tokenize,
 * then `processTerm` (= `analyzeTerm`) per raw token. Kept as the parity
 * oracle for tests.
 */
export const referenceBilingualAnalyzer: Analyzer = (text: string): string[] => {
  const out: string[] = [];
  for (const tok of text.split(SPACE_OR_PUNCTUATION)) {
    if (!tok) continue;
    const t = analyzeTerm(tok);
    if (t) out.push(t);
  }
  return out;
};

// Folded-token → analysed-term memo. Vault vocabulary is Zipfian, so a small
// bounded cache turns most per-token work into one Map lookup.
const TERM_CACHE_MAX = 50_000;
const termCache = new Map<string, string | null>();

/**
 * Default analyzer, output-identical to `referenceBilingualAnalyzer` (tested):
 * folds the WHOLE text once (lowercase + NFD mark stripping never creates or
 * removes a space/punctuation character, so token boundaries are unchanged),
 * then splits and memoises `analyzeTerm` per distinct token. Verified
 * identical on a ~9.7k-note real vault (0 mismatching docs); speed is on par.
 */
export const bilingualAnalyzer: Analyzer = (text: string): string[] => {
  const out: string[] = [];
  for (const tok of foldText(text).split(SPACE_OR_PUNCTUATION)) {
    if (!tok) continue;
    let t = termCache.get(tok);
    if (t === undefined) {
      t = analyzeTerm(tok);
      if (termCache.size >= TERM_CACHE_MAX) termCache.clear();
      termCache.set(tok, t);
    }
    if (t) out.push(t);
  }
  return out;
};

/** LEXICAL_ANALYZER=legacy equivalent: raw MiniSearch tokens, lowercased. */
export const legacyAnalyzer: Analyzer = (text: string): string[] =>
  text.split(SPACE_OR_PUNCTUATION).filter(Boolean).map((t) => t.toLowerCase());

/**
 * Map an analysed term to a token FTS5's `ascii` tokenizer keeps whole. Plain
 * `[a-z0-9]+` terms (the overwhelming majority) are stored verbatim; any other
 * character (symbols left in `c++`, non-Latin scripts) is spelled `_<hex>_`.
 * The mapping is per character, so a prefix of a term encodes to a prefix of its
 * encoding and prefix queries keep working. `_` can never occur in a raw term
 * (it is punctuation, so the tokenizer already split on it).
 */
export function encodeTerm(term: string): string {
  if (/^[a-z0-9]+$/.test(term)) return term;
  let out = '';
  for (const ch of term) {
    out += /[a-z0-9]/.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}_`;
  }
  return out;
}

/** Can this (encoded) term take part in fuzzy matching? Plain alpha only. */
export function isFuzzyVocabTerm(term: string): boolean {
  return term.length >= 4 && /^[a-z]+$/.test(term);
}

/** Max edit distance MiniSearch would use for `term` (0 = no fuzzy). */
export function maxEditDistance(term: string, analyzed: boolean): number {
  const f = analyzed ? fuzzyForTerm(term) : 0.2;
  if (f === false) return 0;
  if (f === true) return Math.min(6, Math.round(term.length * 0.2));
  return f < 1 ? Math.min(6, Math.round(term.length * f)) : f;
}

export function allowPrefix(term: string, analyzed: boolean): boolean {
  return analyzed ? prefixForTerm(term) : true;
}

/** Levenshtein distance with an early exit once every cell exceeds `max`. */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Padded trigrams (`##ab`, …, `b$$`). The q-gram lemma on padded grams gives a
 * usable lower bound even for 5-letter terms: two strings within edit distance
 * d share at least (|s| + 2) − 3d padded trigrams.
 */
export function paddedTrigrams(term: string): string[] {
  const s = `##${term}$$`;
  const out: string[] = [];
  for (let i = 0; i + 3 <= s.length; i++) out.push(s.slice(i, i + 3));
  return out;
}

/** Fixed bilingual probe text: analyzer output on it fingerprints the analyzer. */
const PROBE =
  "Les réseaux d'entreprise étaient configurés; the policies' boxes ran on serveurs " +
  'C++ v17.2 API naïve cœur ŒUVRE Ångström straße — données, élèves, été, the running dogs';

/**
 * Stable fingerprint of an analyzer's behaviour. Stored in the DB; any change
 * to the analyzer (stopword list, stemmer, folding) changes the fingerprint and
 * forces an automatic rebuild instead of silently mixing two term spaces.
 */
export function analyzerFingerprint(analyze: Analyzer): string {
  return createHash('sha1').update(analyze(PROBE).join('|')).digest('hex').slice(0, 16);
}
