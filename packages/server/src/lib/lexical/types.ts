/**
 * Backend-neutral lexical index contract. Mirrors exactly what lib/search.ts
 * needs from MiniSearch today: add/discard one note, a ranked OR query with
 * prefix + fuzzy expansion and field boosts (title 3, tags 2, content 1), the
 * matched query terms per hit (recall `coverage`), and a document frequency per
 * analysed term (recall IDF weights). Filters are part of the query so a SQL
 * backend can push them into WHERE instead of post-filtering.
 */

/** Filterable metadata + text of one note (what lib/search.ts `metadataForNote` derives). */
export interface NoteRecord {
  path: string;
  title: string;
  /** Markdown body without frontmatter. */
  body: string;
  tags: string[];
  date?: string;
  type?: string;
  category?: string;
  temperature?: string;
  heat_score?: number;
  importance?: string;
  archived?: boolean;
  collection?: string;
  /**
   * Opaque JSON-serialisable caller data stored with the row (search.ts: the
   * rest of DocMeta minus `content`, plus the note's wikilinks) and returned by
   * `forEachNote`, so a warm boot needs no file reads.
   */
  extra?: unknown;
}

/** Scope filters; same semantics as lib/search.ts `passesFilters`. */
export interface LexicalFilters {
  /** Keep notes whose `type` is one of these. */
  types?: string[];
  category?: string;
  temperature?: string;
  minHeatScore?: number;
  importance?: string;
  /** Keep notes carrying ANY of these tags. */
  tagsAny?: string[];
  /** Inclusive day bounds; notes without a date are dropped when either is set. */
  dateFrom?: string;
  dateTo?: string;
  /** Keep notes whose path starts with ANY of these prefixes. */
  pathPrefixes?: string[];
  collections?: string[];
  /** Default true, like `passesFilters`. */
  excludeArchived?: boolean;
}

export interface LexicalSearchOptions {
  limit?: number;
  filters?: LexicalFilters;
  /** Length-gated fuzzy expansion (default true). */
  fuzzy?: boolean;
  /** Length-gated prefix expansion (default true). */
  prefix?: boolean;
}

export interface LexicalHit {
  path: string;
  /** Higher is better (MiniSearch-style: Σ term scores × matched-term count). */
  score: number;
  /** Analysed query terms this note matched (exactly, by prefix or fuzzily). */
  queryTerms: string[];
}

/** One file of a vault listing, as the rescan sees it. */
export interface ListingEntry {
  path: string;
  vault: string;
  /** `stat().mtimeMs`; undefined → always re-read (hash decides). */
  mtimeMs?: number;
}

export interface SyncOptions {
  /** Concurrent file reads (default 16). */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /** Called (inside the write slice) for every re-indexed note. */
  onUpsert?: (rec: NoteRecord) => void;
  /** Called for every note removed because it left the listing. */
  onRemove?: (path: string) => void;
}

export interface SyncStats {
  listed: number;
  skippedMtime: number;
  touchedHash: number;
  upserted: number;
  removed: number;
  failed: number;
  ms: number;
  /** Longest synchronous slice (ms) — the event-loop block this sync caused. */
  maxSliceMs: number;
  /** Slices that exceeded 50 ms (single huge notes: frontmatter parse, FTS insert). */
  slowSlices: number;
  slices: number;
}

export interface LexicalStats {
  backend: string;
  docs: number;
  vocab?: number;
  dbBytes?: number;
  schemaVersion?: number;
  analyzer?: string;
  rebuiltOnOpen?: boolean;
}

export interface LexicalBackend {
  readonly name: string;
  /** Insert or replace one note (synchronous, one small transaction). */
  upsert(rec: NoteRecord, sig?: { vault?: string; mtimeMs?: number; hash?: string }): void;
  remove(path: string): void;
  /**
   * Incremental, crash-safe reconcile against a full listing: unchanged mtime →
   * skip; unchanged content hash → touch mtime; else re-index. Paths absent from
   * the listing are removed. Work is time-sliced so the event loop is never
   * blocked for longer than the configured slice.
   */
  syncFromListing(
    listing: ListingEntry[],
    load: (e: ListingEntry) => Promise<string>,
    opts?: SyncOptions,
  ): Promise<SyncStats>;
  search(query: string, opts?: LexicalSearchOptions): LexicalHit[];
  /** Number of docs containing the analysed term (0 = absent). */
  docFrequency(term: string): number;
  docCount(): number;
  has(path: string): boolean;
  /** Note body on demand (lets docMeta drop `content`). */
  getBody(path: string): string | undefined;
  stats(): LexicalStats;
  close(): void;
}
