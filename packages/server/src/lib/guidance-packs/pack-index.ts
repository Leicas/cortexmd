/**
 * Small in-memory lexical index for ONE guidance pack. Separate from the vault
 * index on purpose (lib/search.ts is never touched): pack content must not mix
 * with personal recall. Uses the shared bilingual analyzer so queries behave
 * like the rest of cortexmd (accent folding, stopwords, light plural stemming).
 *
 * Scoring is BM25F: per-field term frequencies are length-normalised, weighted
 * (id / title / description above headings above body) and summed BEFORE the
 * saturation step, so a word that sits in the id, the title and the body
 * counts once, strongly, instead of three times. Each query term therefore
 * contributes at most its IDF, which keeps a guide that covers every query
 * term ahead of one that repeats a single term in its file name.
 */
import { analyzeText, prefixForTerm } from '../text-analyzer.js';
import type { PackEntry } from './types.js';

export interface PackHit {
  entry: PackEntry;
  score: number;
}

const BODY_INDEX_CHARS = 60_000;
const K1 = 16;
/** [weight, length-normalisation b] per field. */
const FIELDS = {
  id: [6, 0.3],
  title: [5, 0.3],
  description: [5, 0.3],
  headings: [2, 0.4],
  area: [1.5, 0],
  body: [1, 0.6],
} as const;
type Field = keyof typeof FIELDS;

const PREFIX_WEIGHT = 0.2;
const FUZZY_WEIGHT = 0.4;
/** Extra weight when adjacent query terms are adjacent in the guide ("content visibility", "layout shift"). */
const PHRASE_BONUS = 1;

/** True when `a` and `b` are within one edit (insert / delete / substitute). */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export class PackIndex {
  /** term → (doc → weighted, length-normalised term frequency summed over fields). */
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly vocab: string[];
  /** Analyzed token stream per entry (` a b c `), for the phrase bonus. */
  private readonly streams: string[];
  readonly buildMs: number;

  constructor(
    readonly entries: PackEntry[],
    bodies: ReadonlyMap<string, string>,
  ) {
    const t0 = performance.now();
    const docs = entries.map((e) => ({
      id: analyzeText(e.id),
      title: analyzeText(e.title),
      description: analyzeText(e.description),
      headings: analyzeText(e.headings.join(' . ')),
      area: analyzeText(`${e.area} ${e.skill ?? ''}`),
      body: analyzeText((bodies.get(e.path) ?? '').slice(0, BODY_INDEX_CHARS)),
    }));
    const n = Math.max(1, docs.length);
    for (const field of Object.keys(FIELDS) as Field[]) {
      const [weight, b] = FIELDS[field];
      const avg = docs.reduce((s, d) => s + d[field].length, 0) / n || 1;
      docs.forEach((d, doc) => {
        const tokens = d[field];
        if (tokens.length === 0) return;
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        const norm = 1 - b + b * (tokens.length / avg);
        for (const [term, count] of tf) {
          let posting = this.postings.get(term);
          if (!posting) this.postings.set(term, (posting = new Map()));
          posting.set(doc, (posting.get(doc) ?? 0) + (weight * count) / norm);
        }
      });
    }
    this.vocab = [...this.postings.keys()];
    this.streams = docs.map((d) => ` ${[...d.id, '.', ...d.title, '.', ...d.description, '.', ...d.headings, '.', ...d.body].join(' ')} `);
    this.buildMs = performance.now() - t0;
  }

  /** Index terms a query term stands for, with their weight. */
  private expand(term: string): Array<[string, number]> {
    const out = new Map<string, number>();
    if (this.postings.has(term)) out.set(term, 1);
    // The shared analyzer only stems plurals. Gerunds are common in queries
    // ("descaling", "styling", "positioning"), so the stem is searched as a
    // prefix too ("styl" → style / styles / styling).
    const prefixes = [term];
    if (term.length >= 6 && term.endsWith('ing')) prefixes.push(term.slice(0, -3));
    for (const p of prefixes) {
      if (!prefixForTerm(p) || p.length < 4) continue;
      for (const v of this.vocab) {
        if (v.length > p.length && v.startsWith(p) && !out.has(v)) out.set(v, PREFIX_WEIGHT);
      }
    }
    // Typo tolerance only when nothing else matched (and never on short terms / identifiers).
    if (out.size === 0 && term.length >= 5 && !/\d/.test(term)) {
      for (const v of this.vocab) if (withinOneEdit(term, v)) out.set(v, FUZZY_WEIGHT);
    }
    return [...out];
  }

  search(query: string, limit = 5): PackHit[] {
    const ordered = analyzeText(query);
    const terms = [...new Set(ordered)];
    if (terms.length === 0) return [];
    const n = this.entries.length;
    const scores = new Map<number, number>();
    const matchedTerms = new Map<number, number>();
    for (const term of terms) {
      const tf = new Map<number, number>();
      for (const [variant, weight] of this.expand(term)) {
        for (const [doc, value] of this.postings.get(variant)!) tf.set(doc, (tf.get(doc) ?? 0) + weight * value);
      }
      if (tf.size === 0) continue;
      const idf = Math.log(1 + (n - tf.size + 0.5) / (tf.size + 0.5));
      for (const [doc, value] of tf) {
        scores.set(doc, (scores.get(doc) ?? 0) + idf * (value / (K1 + value)));
        matchedTerms.set(doc, (matchedTerms.get(doc) ?? 0) + 1);
      }
    }
    const pairs: string[] = [];
    for (let i = 0; i + 1 < ordered.length; i++) pairs.push(` ${ordered[i]} ${ordered[i + 1]} `);
    const slug = terms.join('-');
    const hits: PackHit[] = [];
    for (const [doc, base] of scores) {
      const entry = this.entries[doc];
      // Coverage: a guide matching every query term beats one that matches
      // only some of them ("light dismiss dialog" must not return every guide
      // that merely mentions "light").
      const coverage = (matchedTerms.get(doc) ?? 0) / terms.length;
      let score = base * coverage;
      if (pairs.length > 0) {
        const stream = this.streams[doc];
        score *= 1 + PHRASE_BONUS * (pairs.filter((p) => stream.includes(p)).length / pairs.length);
      }
      if (analyzeText(entry.id).join('-') === slug) score *= 2;
      hits.push({ entry, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));
    return hits.slice(0, Math.max(1, limit));
  }
}
