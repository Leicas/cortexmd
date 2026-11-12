/**
 * In-memory working copy of a vault for the hygiene planner.
 *
 * Every sub-command mutates this model; the final plan is the diff between the
 * model and the original bytes. Nothing here touches the disk — loading and
 * applying live in fs-runner.ts (CLI) / the MCP tool (dry-run only).
 *
 * Frontmatter is split off verbatim and only re-serialised when a command
 * actually changed a property, so body-only edits (link rewrites) never
 * reformat YAML.
 */
import matter from 'gray-matter';

export interface HygieneNote {
  path: string;
  /** Original bytes (as text). Never mutated. */
  readonly original: string;
  /** Frontmatter block including both `---` fences and trailing newline, or ''. */
  fmText: string;
  body: string;
  /** Parsed frontmatter (lazily); `undefined` when the YAML failed to parse. */
  data: Record<string, any> | undefined;
  dataDirty: boolean;
  parseError?: string;
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** gray-matter turns unquoted YAML dates into Date objects; write them back as text. */
function normaliseDates(value: unknown): unknown {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return String(value);
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) return value.map(normaliseDates);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normaliseDates(v);
    return out;
  }
  return value;
}

export function parseNote(path: string, raw: string): HygieneNote {
  const m = FM_RE.exec(raw);
  const note: HygieneNote = {
    path,
    original: raw,
    fmText: m ? m[0] : '',
    body: m ? raw.slice(m[0].length) : raw,
    data: m ? undefined : {},
    dataDirty: false,
  };
  if (m) {
    try {
      // Passing options bypasses gray-matter's content cache (whose parsed
      // objects would otherwise be shared — and mutated — across notes).
      const parsed = matter(raw, {});
      note.data = normaliseDates(parsed.data ?? {}) as Record<string, any>;
    } catch (err) {
      note.data = undefined;
      note.parseError = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
  }
  return note;
}

/** Serialise a (possibly modified) note back to text. */
export function renderNote(note: HygieneNote): string {
  if (!note.dataDirty || !note.data) return note.fmText + note.body;
  if (Object.keys(note.data).length === 0 && !note.fmText) return note.body;
  const eol = note.original.includes('\r\n') ? '\r\n' : '\n';
  // matter.stringify('', data) → "---\n<yaml>---\n\n"; keep the original EOL style.
  const fm = matter.stringify('', note.data).replace(/\s+$/, '').replace(/\r?\n/g, eol) + eol;
  return fm + note.body;
}

export function noteTitle(note: HygieneNote): string {
  const t = note.data?.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  if (typeof t === 'number') return String(t);
  const h = /^#\s+(.+)$/m.exec(note.body);
  if (h) return h[1].trim();
  return note.path.replace(/\.md$/i, '').split('/').pop() ?? note.path;
}

export function noteTags(note: HygieneNote): unknown[] {
  const t = note.data?.tags;
  if (Array.isArray(t)) return t;
  if (t === undefined || t === null || t === '') return [];
  return [t];
}

/** NoteLike view for patterns.ts classifiers. */
export function noteLike(note: HygieneNote) {
  const d = note.data ?? {};
  return {
    path: note.path,
    type: d.type,
    tags: noteTags(note).map((t) => String(t)),
    source: d.source,
    title: noteTitle(note),
    importance: d.importance,
    auto_consolidated: d.auto_consolidated,
    content: note.body.slice(0, 2000),
  };
}

export interface ChangeRecord {
  command: string;
  path: string;
  action: string;
  detail?: unknown;
}

/**
 * The mutable vault. `notes` holds every markdown file still at its path;
 * `otherFiles` holds attachments (for link resolution only); `moves` maps an
 * original path to its archive destination.
 */
export class VaultModel {
  readonly notes = new Map<string, HygieneNote>();
  readonly otherFiles = new Set<string>();
  readonly moves = new Map<string, string>();
  readonly log: ChangeRecord[] = [];
  readonly archiveRoot: string;

  constructor(files: Iterable<[string, string]>, otherFiles: Iterable<string> = [], archiveRoot = 'Archive/vault-hygiene') {
    this.archiveRoot = archiveRoot.replace(/\/+$/, '');
    for (const [p, raw] of files) this.notes.set(p, parseNote(p, raw));
    for (const p of otherFiles) this.otherFiles.add(p);
  }

  /** Notes the commands may act on (everything outside the hygiene archive). */
  *active(): Iterable<HygieneNote> {
    for (const n of this.notes.values()) {
      if (n.path.startsWith(`${this.archiveRoot}/`)) continue;
      yield n;
    }
  }

  record(command: string, path: string, action: string, detail?: unknown): void {
    this.log.push({ command, path, action, ...(detail === undefined ? {} : { detail }) });
  }

  /** Move a note into the archive (never deletes). Returns the destination. */
  archive(command: string, path: string, reason: string): string | undefined {
    const note = this.notes.get(path);
    if (!note) return undefined;
    let dest = `${this.archiveRoot}/${path}`;
    let i = 1;
    while (this.notes.has(dest) || [...this.moves.values()].includes(dest)) dest = `${this.archiveRoot}/${path.replace(/\.md$/i, '')}~${i++}.md`;
    this.notes.delete(path);
    // The moved note keeps any edits made by earlier commands.
    this.moves.set(path, dest);
    this.archivedContent.set(dest, note);
    this.record(command, path, 'archive', { to: dest, reason });
    return dest;
  }

  /** Content of notes moved to the archive, keyed by destination. */
  readonly archivedContent = new Map<string, HygieneNote>();

  /** Paths of notes this run creates (never pre-existing). */
  readonly created = new Set<string>();

  /** Create a new note; refuses (returns false) when any file is at `path`. */
  create(command: string, path: string, content: string, reason: string): boolean {
    const lower = path.toLowerCase();
    for (const p of this.allPaths()) if (p.toLowerCase() === lower) return false;
    this.notes.set(path, { ...parseNote(path, content), original: '' });
    this.created.add(path);
    this.record(command, path, 'create', { reason });
    return true;
  }

  /** All paths that currently exist (md + attachments), for link resolution. */
  allPaths(): Iterable<string> {
    return [...this.notes.keys(), ...this.otherFiles];
  }
}

export interface PlannedChange {
  path: string;
  op: 'modify' | 'archive' | 'create';
  /** Destination for `archive`. */
  to?: string;
  /** New text (`modify`/`create`, and `archive` when the note was also edited). */
  newContent?: string;
  commands: string[];
}

/** Diff the model against the original files. */
export function computePlan(model: VaultModel): PlannedChange[] {
  const byPath = new Map<string, Set<string>>();
  for (const r of model.log) {
    const set = byPath.get(r.path) ?? new Set<string>();
    set.add(r.command);
    byPath.set(r.path, set);
  }
  const plan: PlannedChange[] = [];
  for (const note of model.notes.values()) {
    const text = renderNote(note);
    if (model.created.has(note.path)) {
      plan.push({ path: note.path, op: 'create', newContent: text, commands: [...(byPath.get(note.path) ?? [])] });
    } else if (text !== note.original) {
      plan.push({ path: note.path, op: 'modify', newContent: text, commands: [...(byPath.get(note.path) ?? [])] });
    }
  }
  for (const [from, to] of model.moves) {
    const note = model.archivedContent.get(to)!;
    const text = renderNote(note);
    plan.push({
      path: from,
      op: 'archive',
      to,
      ...(text !== note.original ? { newContent: text } : {}),
      commands: [...(byPath.get(from) ?? [])],
    });
  }
  plan.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return plan;
}
