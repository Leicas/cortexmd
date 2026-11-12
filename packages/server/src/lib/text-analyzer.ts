/**
 * Bilingual (English + French) text analysis shared by the lexical index
 * (MiniSearch `processTerm` in lib/search.ts) and the recall re-scorer's
 * keyword/diversity helpers (lib/memory.ts).
 *
 * Pure and dependency-free. The pipeline per token is:
 *   lowercase → NFD accent folding → stopword drop → light plural stemming.
 *
 * It is deliberately LIGHT: no Porter/Snowball. Only inflections that are safe
 * in both languages are conflated (plural -s/-es/-ies/-x), so identifiers,
 * version strings and proper nouns survive untouched.
 */

/** Lowercase + strip combining diacritics (`é` → `e`, `ç` → `c`, `œ` → `oe`). */
export function foldText(text: string): string {
  // ASCII fast path: nothing to fold, and NFD normalisation is the slow part.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(text)) return text.toLowerCase();
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae');
}

const EN_STOPWORDS = [
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'at', 'by', 'for', 'with', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in',
  'out', 'on', 'off', 'over', 'under', 'again', 'further', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'would', 'could', 'i', 'me', 'my', 'we', 'our', 'ours', 'you', 'your', 'he', 'him', 'his', 'she',
  'her', 'it', 'its', 'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'am', 'as', 'until', 'while', 'between', 'because', 'also', 'upon', 'not', 'no', 'nor',
];

// Already accent-folded (the analyzer folds before the stopword lookup).
const FR_STOPWORDS = [
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'mais', 'donc', 'car', 'ni', 'que',
  'qui', 'quoi', 'dont', 'ce', 'cet', 'cette', 'ces', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son',
  'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur', 'leurs', 'je', 'tu', 'il', 'elle', 'nous',
  'vous', 'ils', 'elles', 'se', 'en', 'au', 'aux', 'dans', 'par', 'pour', 'sur', 'sous', 'avec',
  'sans', 'chez', 'vers', 'entre', 'est', 'sont', 'etait', 'etaient', 'ete', 'etre', 'ai', 'as',
  'avons', 'avez', 'ont', 'avait', 'avoir', 'fait', 'faire', 'plus', 'moins', 'tres', 'pas', 'ne',
  'quel', 'quelle', 'quels', 'quelles', 'comment', 'pourquoi', 'quand', 'aussi', 'comme', 'si', 'cela',
  'ca', 'ceci', 'celui', 'celle', 'ceux', 'on', 'lui', 'eux', 'tout', 'tous', 'toute', 'toutes',
  'qu', 'jusqu', 'lorsqu', 'puisqu', 'afin', 'alors', 'ainsi', 'apres', 'avant', 'depuis', 'pendant',
];

export const STOPWORDS: ReadonlySet<string> = new Set([...EN_STOPWORDS, ...FR_STOPWORDS]);

/**
 * Light plural stemmer, safe for EN + FR: `policies` → `policy`, `boxes` →
 * `box`, `serveurs` → `serveur`, `reseaux` → `reseau`. Tokens containing a
 * digit (identifiers, versions) and short tokens are returned unchanged.
 */
export function lightStem(term: string): string {
  const n = term.length;
  if (n < 4 || /\d/.test(term)) return term;
  if (n > 4 && term.endsWith('ies')) return term.slice(0, -3) + 'y';
  if (n > 4 && term.endsWith('eaux')) return term.slice(0, -1);
  if (n > 4 && /(?:ss|sh|ch|x|z)es$/.test(term)) return term.slice(0, -2);
  if (term.endsWith('s') && !/(?:ss|us|is)$/.test(term)) return term.slice(0, -1);
  return term;
}

/**
 * Analyze ONE raw token. Returns the normalised index/query term, or `null`
 * when the token must be dropped (stopword, or a lone letter such as the `l`
 * left over from the French elision `l'ordinateur`).
 */
export function analyzeTerm(raw: string): string | null {
  const folded = foldText(raw);
  if (!folded) return null;
  if (folded.length === 1 && !/[0-9]/.test(folded)) return null;
  if (STOPWORDS.has(folded)) return null;
  return lightStem(folded);
}

/** Tokenize free text into analyzed terms (accent-folded, stopword-free, stemmed). */
export function analyzeText(text: string): string[] {
  const out: string[] = [];
  for (const tok of foldText(text).split(/[^a-z0-9]+/)) {
    if (!tok) continue;
    const t = analyzeTerm(tok);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Length-gated fuzzy matching for the lexical index: no typo tolerance on short
 * terms or identifiers (a 1-edit neighbour of `v17` or `api` is a different
 * thing), 1 edit from 5 chars, ~20% of the length beyond.
 */
export function fuzzyForTerm(term: string): number | boolean {
  if (term.length < 5 || /\d/.test(term)) return false;
  return term.length < 8 ? 1 : 0.2;
}

/** Prefix expansion only from 3 chars up (a 1–2 char prefix matches half the vault). */
export function prefixForTerm(term: string): boolean {
  return term.length >= 3;
}
