/**
 * Heading-aware note chunking for the semantic arm.
 *
 * One vector per note (title + first ~1,024 chars) makes everything past the
 * lead invisible to semantic search, and the default model only reads ~256
 * tokens anyway. `chunkNote` turns a note into:
 *
 *   - short note (body ≤ singleChunkMaxChars): ONE chunk whose embed text is
 *     exactly the legacy `title + ' ' + body` — so vectors/hashes persisted by
 *     the one-vector-per-note index stay valid (no re-embed on migration);
 *   - long note: a `lead` chunk (the legacy text — again reusable as-is) plus
 *     `section` chunks of ~targetChars (≈200 tokens) cut on headings, blank
 *     lines, fenced code blocks and sentence ends, with a small overlap, each
 *     carrying a contextual header (`title > heading > sub-heading`).
 *
 * Every chunk is a contiguous slice of the body: `text === body.slice(start,
 * end)`, so callers can show a query-aware snippet from the offsets alone.
 * Pure and synchronous — no I/O, no model.
 */

export interface Chunk {
  /** Position in the note's chunk list (0 = lead / only chunk). */
  index: number;
  kind: 'lead' | 'section';
  /** Offsets into the body passed in (frontmatter, if any, is skipped). */
  start: number;
  end: number;
  /** body.slice(start, end). */
  text: string;
  /** Heading path in effect where the chunk starts (outermost first). */
  headings: string[];
  /** What is fed to the embedding model (contextual header + text). */
  embedText: string;
}

export interface ChunkOptions {
  /** Bodies up to this many chars stay one (legacy-identical) chunk. */
  singleChunkMaxChars?: number;
  /** Soft chunk size in chars (~4 chars/token → 800 ≈ 200 tokens). */
  targetChars?: number;
  /** Hard chunk size; an oversized block is split below this. */
  maxChars?: number;
  /** Tail of the previous chunk repeated at the start of the next one. */
  overlapChars?: number;
  /** Max `section` chunks per note (very long digests / blobs are cut off). */
  maxChunks?: number;
  /** Emit the legacy lead chunk for long notes (default true). */
  lead?: boolean;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  singleChunkMaxChars: 1024,
  targetChars: 800,
  maxChars: 1000,
  overlapChars: 120,
  maxChunks: 24,
  lead: true,
};

/** Legacy one-vector-per-note embed text: title + first 1,024 body chars. */
export function leadText(doc: { title: string; content: string }): string {
  return (doc.title + ' ' + doc.content.slice(0, 1024)).trim();
}

/** Length of a leading YAML frontmatter block (0 when there is none). */
export function frontmatterLength(content: string): number {
  if (!content.startsWith('---')) return 0;
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return m ? m[0].length : 0;
}

interface Unit {
  start: number;
  end: number;
  /** Heading path in effect at this unit. */
  headings: string[];
  /** A heading line: prefer starting a new chunk here. */
  isHeading: boolean;
  /** Paragraph / block boundary before this unit (cheap place to cut). */
  blockStart: boolean;
  /** Inside a fenced code block (never an overlap seed mid-fence). */
  code: boolean;
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Split [start,end) of `s` into pieces ≤ max, preferring sentence ends, then spaces. */
function splitLong(s: string, start: number, end: number, max: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let a = start;
  while (end - a > max) {
    const win = s.slice(a, a + max);
    let cut = -1;
    // Last sentence end in the window (., !, ?, …, ; or : followed by space).
    const re = /[.!?…;:][)"'»\]]*\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(win))) cut = m.index + m[0].length;
    if (cut < max * 0.4) {
      const sp = win.lastIndexOf(' ');
      cut = sp > max * 0.4 ? sp + 1 : max;
    }
    // Never cut inside a surrogate pair.
    const code = s.charCodeAt(a + cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out.push([a, a + cut]);
    a += cut;
  }
  if (end > a) out.push([a, end]);
  return out;
}

/** Line-level units with heading path, code-fence and block-boundary flags. */
function toUnits(body: string, base: number, maxChars: number): Unit[] {
  const units: Unit[] = [];
  const path: Array<{ level: number; text: string }> = [];
  let fence: string | null = null;
  let prevBlank = true;
  let pos = base;
  while (pos < body.length) {
    let nl = body.indexOf('\n', pos);
    if (nl === -1) nl = body.length - 1;
    const lineEnd = nl + 1;
    const line = body.slice(pos, lineEnd).replace(/\r?\n$/, '');
    const blank = line.trim() === '';
    let isHeading = false;
    const wasInFence = fence !== null;
    const fm = FENCE_RE.exec(line);
    if (fm) {
      if (fence === null) fence = fm[1][0];
      else if (fm[1][0] === fence) fence = null;
    } else if (fence === null && !blank) {
      const hm = HEADING_RE.exec(line);
      if (hm) {
        isHeading = true;
        const level = hm[1].length;
        while (path.length && path[path.length - 1].level >= level) path.pop();
        path.push({ level, text: hm[2].trim() });
      }
    }
    if (!blank) {
      const headings = path.map((h) => h.text);
      const code = wasInFence || fm !== null;
      const blockStart = prevBlank || isHeading || (fm !== null && !wasInFence);
      const pieces = lineEnd - pos > maxChars ? splitLong(body, pos, lineEnd, maxChars) : [[pos, lineEnd] as [number, number]];
      pieces.forEach(([a, b], i) => {
        units.push({ start: a, end: b, headings, isHeading: isHeading && i === 0, blockStart: blockStart && i === 0, code });
      });
    } else if (units.length) {
      // Blank lines ride along with the previous unit so slices stay contiguous.
      units[units.length - 1].end = lineEnd;
    }
    prevBlank = blank;
    pos = lineEnd;
  }
  return units;
}

function contextHeader(title: string, headings: string[]): string {
  const parts = [title.trim(), ...headings].filter(Boolean);
  // A heading that merely repeats the title adds nothing.
  const dedup = parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase());
  return dedup.join(' > ');
}

/**
 * Chunk a note. `doc.content` is normally the frontmatter-stripped body the
 * indexer already holds; a leading frontmatter block is skipped defensively
 * (offsets stay relative to `doc.content` as passed).
 */
export function chunkNote(doc: { title: string; content: string }, options: ChunkOptions = {}): Chunk[] {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const content = doc.content ?? '';
  const title = doc.title ?? '';
  const fm = frontmatterLength(content);
  const bodyLen = content.length - fm;
  const legacy = leadText({ title, content: fm ? content.slice(fm) : content });

  if (bodyLen <= o.singleChunkMaxChars || o.maxChunks <= 0) {
    if (!legacy) return [];
    const end = Math.min(content.length, fm + 1024);
    return [{ index: 0, kind: 'lead', start: fm, end, text: content.slice(fm, end), headings: [], embedText: legacy }];
  }

  const chunks: Chunk[] = [];
  if (o.lead) {
    const end = fm + 1024;
    chunks.push({ index: 0, kind: 'lead', start: fm, end, text: content.slice(fm, end), headings: [], embedText: legacy });
  }

  const units = toUnits(content, fm, o.maxChars);
  let i = 0;
  let sections = 0;
  while (i < units.length && sections < o.maxChunks) {
    const first = i;
    let len = 0;
    let j = i;
    while (j < units.length) {
      const u = units[j];
      const ulen = u.end - u.start;
      if (j > first) {
        if (len + ulen > o.maxChars) break;
        // A heading opens a new chunk once the current one has some substance.
        if (u.isHeading && len >= o.targetChars * 0.25) break;
        // Past the soft target, stop at the next block boundary.
        if (len >= o.targetChars && u.blockStart) break;
        if (len + ulen > o.targetChars && u.blockStart && len >= o.targetChars * 0.5) break;
      }
      len += ulen;
      j++;
    }
    const start = units[first].start;
    const end = units[j - 1].end;
    const text = content.slice(start, end);
    if (text.trim()) {
      const header = contextHeader(title, units[first].headings);
      chunks.push({
        index: chunks.length,
        kind: 'section',
        start,
        end,
        text,
        headings: units[first].headings,
        embedText: (header ? header + '\n' : '') + text.trim(),
      });
      sections++;
    }
    if (j >= units.length) break;
    // Overlap: back up over trailing units worth ≤ overlapChars — but never
    // across a heading (a new section starts clean) and never into code.
    let k = j;
    if (!units[j].isHeading && o.overlapChars > 0) {
      let back = 0;
      while (k - 1 > first && !units[k - 1].isHeading && !units[k - 1].code) {
        const l = units[k - 1].end - units[k - 1].start;
        if (back + l > o.overlapChars) break;
        back += l;
        k--;
      }
    }
    i = k;
  }
  return chunks;
}

/** A chunk-level hit (one vector) before the note-level roll-up. */
export interface ChunkHit {
  path: string;
  /** Chunk position in the note. */
  index: number;
  score: number;
  start: number;
  end: number;
}

export interface NoteHit {
  path: string;
  /** Note-level score (see `rollupChunkHits`). */
  score: number;
  /** The best-matching chunk of the note. */
  best: ChunkHit;
  /** How many of the note's chunks were among the retrieved neighbours. */
  matched: number;
}

export type ChunkRollup = 'max' | 'top2';

/**
 * Roll chunk-level hits up to note level. `max` = best chunk; `top2` = mean
 * of the two best chunks of the note (a note with a single retrieved chunk
 * keeps that chunk's score). Deterministic: ties break on path.
 */
export function rollupChunkHits(hits: ChunkHit[], mode: ChunkRollup = 'max'): NoteHit[] {
  const byNote = new Map<string, ChunkHit[]>();
  for (const h of hits) {
    const list = byNote.get(h.path);
    if (list) list.push(h); else byNote.set(h.path, [h]);
  }
  const out: NoteHit[] = [];
  for (const [p, list] of byNote) {
    list.sort((a, b) => b.score - a.score || a.index - b.index);
    const best = list[0];
    const score = mode === 'top2' && list.length > 1 ? (list[0].score + list[1].score) / 2 : best.score;
    out.push({ path: p, score, best, matched: list.length });
  }
  out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
