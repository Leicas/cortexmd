/**
 * Word budget for diary lines. memory_wakeup re-reads every diary line on each
 * session start, so a 150-word entry costs every future session; the contract
 * is ≤60 words for a Stop recap and ≤120 for a PreCompact handoff (a `topic`
 * marks the latter). Trimming happens AFTER sanitize and BEFORE the entry is
 * decorated (silent marker, hashtags, project/machine links), so the links are
 * never cut.
 */
export const DIARY_WORD_LIMIT = 60;
export const DIARY_WORD_LIMIT_TOPIC = 120;

export interface TrimResult {
  text: string;
  truncated: boolean;
  /** Word count of the ORIGINAL entry. */
  words: number;
  limit: number;
}

/** Whitespace-delimited word count ("[[a b]]" counts as two words, like a reader sees it). */
export function countWords(text: string): number {
  const t = String(text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Keep the first `limit` words and append "…" when something was dropped. A
 * `[[wiki-link]]` straddling the cut is kept whole (its closing `]]` is found
 * and the cut moves past it) so the entry never ends on a broken link.
 */
export function trimWords(text: string, limit: number): TrimResult {
  const src = String(text ?? '').trim();
  const words = countWords(src);
  if (words <= limit) return { text: src, truncated: false, words, limit };

  const tokens = src.split(/\s+/);
  let keep = limit;
  // Do not cut inside an open [[link]] (or **bold**): extend to its close.
  const head = tokens.slice(0, keep).join(' ');
  const openLink = (head.match(/\[\[/g) ?? []).length - (head.match(/\]\]/g) ?? []).length;
  if (openLink > 0) {
    while (keep < tokens.length && !tokens[keep - 1].includes(']]')) keep++;
  }
  const out = tokens.slice(0, keep).join(' ').replace(/[\s,;:—–-]+$/, '');
  return { text: `${out}…`, truncated: true, words, limit };
}
