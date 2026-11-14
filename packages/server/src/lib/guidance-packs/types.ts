/**
 * Guidance packs: curated third-party best-practice packs (e.g. an agent skill
 * pack of Markdown guides) served next to personal memory, but stored OUTSIDE
 * the vault under `<DATA_DIR>/packs/<name>/` so they never enter recall, heat,
 * the knowledge graph, auto-linking, dream/consolidation or wakeup.
 *
 * Pack content is DATA: it is only ever read as text. Nothing in a pack is
 * executed, imported or evaluated.
 */

export class PackError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** HTTP status the REST layer should answer with. */
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'PackError';
  }
}

/** Declared pack (GUIDANCE_PACKS env or the runtime registry `packs.json`). */
export interface PackSpec {
  name: string;
  /** `https://<allowlisted host>/...` (git), `file://...` (git, env only) or an absolute local directory. */
  source: string;
  /** Branch or tag to follow (default: remote HEAD). */
  ref?: string;
  /** Full commit sha pin; sync fails when the fetched commit differs. */
  commit?: string;
  /** Sub-path globs (`skills/**`, `docs/*.md`). Empty = whole tree. */
  include?: string[];
  /** Re-sync when the last sync is older than this many hours (0/undefined = manual only). */
  refreshHours?: number;
  /** Force a layout adapter (`skill-pack` | `markdown-folder`); default: auto-detect. */
  adapter?: string;
  /** Where the declaration came from. `env` specs are operator-trusted. */
  origin?: 'env' | 'registry';
}

export interface PackManifest {
  name: string;
  source: { kind: 'git' | 'local'; url: string };
  ref: string | null;
  /** Resolved commit sha (git sources) or null (local directory). */
  commit: string | null;
  pinned: boolean;
  license: { file: string | null; spdx: string | null };
  syncedAt: string;
  files: number;
  bytes: number;
  /** Files dropped by the per-file size cap. */
  skippedLarge: number;
  adapter: string;
  entries: number;
  skills: number;
}

export interface PackEntry {
  pack: string;
  id: string;
  title: string;
  description: string;
  area: string;
  /** Path relative to the pack content root (posix). */
  path: string;
  bytes: number;
  headings: string[];
  /** Skill directory the entry belongs to, when the pack is a skill pack. */
  skill?: string;
}

export interface PackSkill {
  pack: string;
  /** Skill name from frontmatter (falls back to the directory name). */
  name: string;
  description: string;
  path: string;
  bytes: number;
}

export interface PackFile {
  path: string;
  bytes: number;
}

export interface ParsedPack {
  adapter: string;
  entries: PackEntry[];
  skills: PackSkill[];
}

/** Read-only view of a synced pack handed to a layout adapter. */
export interface AdapterContext {
  pack: string;
  files: PackFile[];
  /** Read a pack file as UTF-8 text. Never executes anything. */
  read(relPath: string): Promise<string>;
}

/**
 * A layout adapter turns a file tree into entries + skills. Add one to
 * `ADAPTERS` in adapters.ts to support another pack layout.
 */
export interface PackAdapter {
  name: string;
  detect(files: PackFile[]): boolean;
  parse(ctx: AdapterContext): Promise<{ entries: PackEntry[]; skills: PackSkill[] }>;
}

export interface SyncCaps {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxRepoBytes: number;
  gitTimeoutMs: number;
}
