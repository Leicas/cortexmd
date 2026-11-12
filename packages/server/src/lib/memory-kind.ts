/**
 * Episodic vs semantic vs procedural memory kinds.
 *
 *   episodic   — what happened: email captures, hook/tool echoes, raw machine
 *                observations (n8n, hooks), agent diary lines, digests,
 *                conversation logs. High volume, time-bound.
 *   semantic   — what is true: decisions, facts, insights, plans, reflections,
 *                deliberate observations, entity notes (people, projects…).
 *   procedural — how to act: preferences, conventions, how-tos, skills,
 *                runbooks.
 *
 * `memoryKindOf` is pure (no config / index import: it reuses the
 * dependency-free rules in vault-hygiene/patterns.ts) so the hygiene CLI,
 * the store path and the recall path all classify identically. Callers that
 * honour MACHINE_CAPTURE_SOURCES pass `config.machineCaptureSourcePatterns`.
 *
 * Precedence: explicit `memory_kind` frontmatter → episodic structure
 * (email / diary / digest / machine source / hook echo / conversation) →
 * procedural signals → semantic signals → default semantic. The default is
 * semantic so a note we cannot place stays in default recall.
 */
import {
  classifyEcho,
  isDigestNote,
  isEmailNote,
  isMachineSource,
} from './vault-hygiene/patterns.js';

export type MemoryKind = 'episodic' | 'semantic' | 'procedural';
export const MEMORY_KINDS: readonly MemoryKind[] = ['episodic', 'semantic', 'procedural'];

/** Default recall scope: durable knowledge, not event exhaust. */
export const DEFAULT_RECALL_KINDS: readonly MemoryKind[] = ['semantic', 'procedural'];

export function isMemoryKind(v: unknown): v is MemoryKind {
  return typeof v === 'string' && (MEMORY_KINDS as readonly string[]).includes(v);
}

export interface MemoryKindOptions {
  /** config.machineCaptureSourcePatterns (empty → built-in defaults). */
  machineSourcePatterns?: readonly string[];
}

const EPISODIC_TYPES = new Set(['email', 'diary', 'journal', 'digest', 'conversation', 'session', 'log', 'transcript', 'event', 'meeting-log']);
const PROCEDURAL_TYPES = new Set(['skill', 'how-to', 'howto', 'procedure', 'runbook', 'playbook', 'recipe', 'guide', 'convention', 'preference']);
const SEMANTIC_TYPES = new Set(['person', 'people', 'project', 'company', 'organization', 'organisation', 'entity', 'concept', 'reference', 'decision', 'fact', 'adr']);

const EPISODIC_CATEGORIES = new Set(['conversation']);
const PROCEDURAL_CATEGORIES = new Set(['preference']);
const SEMANTIC_CATEGORIES = new Set(['decision', 'fact', 'insight', 'plan', 'reflection', 'observation']);

const PROCEDURAL_TAGS = new Set(['how-to', 'howto', 'runbook', 'procedure', 'playbook', 'skill', 'convention', 'preference']);
// Not 'auto-capture': /api/store-memory tags every capture with it, deliberate
// ones included — the machine-source rule is what marks hook / n8n exhaust.
const EPISODIC_TAGS = new Set(['trigger-capture', 'diary', 'journal', 'transcript']);

const EPISODIC_PATHS = [
  /^EmailLog\//i,
  /^Ops\/Agent Diaries\//i,
  /^Journal\//i,
  /^Daily\//i,
  /^Conversations?\//i,
  /^Memories\/conversation\//i,
  /^Memories\/consolidated\//i,
];
const PROCEDURAL_PATHS = [/^Skills\//i, /^Memories\/preference\//i, /^How-?tos?\//i, /^Runbooks?\//i, /^Playbooks?\//i];
const SEMANTIC_PATHS = [
  /^Memories\/(decision|fact|insight|plan|reflection|observation)\//i,
  /^(People|Projects|Companies|Organizations|Entities|Concepts|CRM|References?)\//i,
];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function tagsOf(fm: Record<string, unknown>): string[] {
  const raw = fm.tags;
  if (!Array.isArray(raw)) return typeof raw === 'string' ? [raw.replace(/^#/, '').toLowerCase()] : [];
  return raw.map((t) => String(t).replace(/^#/, '').toLowerCase());
}

/**
 * Classify one note. `frontmatter` may be a full parsed frontmatter object or
 * the search index's DocMeta (it carries type/category/tags/source/title).
 */
export function memoryKindOf(
  frontmatter: Record<string, unknown> | null | undefined,
  path: string,
  opts: MemoryKindOptions = {},
): MemoryKind {
  const fm = frontmatter ?? {};
  const p = (path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');

  // 1. Explicit value wins.
  const explicit = str(fm.memory_kind)?.toLowerCase();
  if (isMemoryKind(explicit)) return explicit;

  const type = str(fm.type)?.toLowerCase();
  const category = str(fm.category)?.toLowerCase();
  const source = str(fm.source);
  const title = str(fm.title);
  const tags = tagsOf(fm);
  const noteLike = { path: p, type, tags, source, title, auto_consolidated: fm.auto_consolidated };

  // 2. Episodic structure: where/how the note was produced beats its category
  // (a hook capture tagged `decision` is still hook exhaust).
  if (EPISODIC_PATHS.some((re) => re.test(p))) return 'episodic';
  if (isEmailNote(noteLike) || isDigestNote(noteLike)) return 'episodic';
  if (type && EPISODIC_TYPES.has(type)) return 'episodic';
  if (source && isMachineSource(source, opts.machineSourcePatterns)) return 'episodic';
  if (tags.some((t) => EPISODIC_TAGS.has(t))) return 'episodic';
  if (title && classifyEcho({ title, content: str(fm.content), source, tags })) return 'episodic';
  if (category && EPISODIC_CATEGORIES.has(category)) return 'episodic';

  // 3. Procedural.
  if (category && PROCEDURAL_CATEGORIES.has(category)) return 'procedural';
  if (type && PROCEDURAL_TYPES.has(type)) return 'procedural';
  if (PROCEDURAL_PATHS.some((re) => re.test(p))) return 'procedural';
  if (tags.some((t) => PROCEDURAL_TAGS.has(t))) return 'procedural';
  if (str(fm.preference_type)) return 'procedural';

  // 4. Semantic (explicit signals, then the default).
  if (category && SEMANTIC_CATEGORIES.has(category)) return 'semantic';
  if (type && SEMANTIC_TYPES.has(type)) return 'semantic';
  if (SEMANTIC_PATHS.some((re) => re.test(p))) return 'semantic';
  return 'semantic';
}

// ---------------------------------------------------------------------------
// Recall scoping
// ---------------------------------------------------------------------------

export interface MemoryKindScopeInput {
  /** Explicit kinds to recall (wins over includeEpisodic). */
  kinds?: readonly string[] | null;
  /** Add episodic notes to the default semantic + procedural scope. */
  includeEpisodic?: boolean | null;
}

/**
 * The set of kinds a recall should return. Default semantic + procedural;
 * `includeEpisodic: true` adds episodic; a non-empty `kinds` list replaces
 * the default (invalid entries are ignored; an all-invalid list falls back to
 * the default).
 */
export function resolveKindScope(input: MemoryKindScopeInput = {}): ReadonlySet<MemoryKind> {
  const explicit = (input.kinds ?? []).map((k) => String(k).toLowerCase()).filter(isMemoryKind);
  if (explicit.length > 0) return new Set(explicit);
  const out = new Set<MemoryKind>(DEFAULT_RECALL_KINDS);
  if (input.includeEpisodic) out.add('episodic');
  return out;
}

/** True when the scope covers every kind (callers can skip filtering). */
export function isUnrestrictedScope(scope: ReadonlySet<MemoryKind>): boolean {
  return MEMORY_KINDS.every((k) => scope.has(k));
}

/** Predicate for the recall candidate filter. */
export function kindInScope(
  meta: Record<string, unknown> | null | undefined,
  path: string,
  scope: ReadonlySet<MemoryKind>,
  opts: MemoryKindOptions = {},
): boolean {
  if (isUnrestrictedScope(scope)) return true;
  return scope.has(memoryKindOf(meta, path, opts));
}
