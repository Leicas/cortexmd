import { readNote, writeNote, listFiles } from './vault.js';
import { logger } from './logger.js';
import { linkFromIndex } from './index-notes.js';

/**
 * Build a formatted timestamp string for journal entries.
 */
function formatTimestamp(date: Date = new Date()): string {
  return [
    String(date.getHours()).padStart(2, '0'),
    ':',
    String(date.getMinutes()).padStart(2, '0'),
    ':',
    String(date.getSeconds()).padStart(2, '0'),
  ].join('');
}

/**
 * Build a short HH:MM timestamp for diary entries.
 */
function formatTime(date: Date = new Date()): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Get the daily journal file path for a given date.
 * Format: Journal/YYYY/MM/YYYY-MM-DD.md
 */
function journalPath(date: Date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `Journal/${year}/${month}/${year}-${month}-${day}.md`;
}

/**
 * Get the daily diary file path for an agent on a given date.
 * Format: Ops/Agent Diaries/{agentName}/YYYY-MM-DD.md
 */
function diaryPath(agentName: string, date: Date = new Date()): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `Ops/Agent Diaries/${agentName}/${year}-${month}-${day}.md`;
}

// ---------------------------------------------------------------------------
// Diary wiki-links: every diary entry links the PROJECT and the MACHINE it was
// written from, so Obsidian's graph ties agent activity to `Projects/<slug>`
// (the same notes the dream reconciles cold memories into — see
// project-reconcile.ts) and to `Machines/<id>` (one note per host; created
// on demand by Obsidian when the link is first followed).
//
// Rendered as an entry suffix: ` · [[Projects/<slug>]] @ [[Machines/<id>]]`.
// ---------------------------------------------------------------------------

export interface DiaryLinkOptions {
  /** Project slug → `[[Projects/<slug>]]`. Slugified like Projects/<slug>.md. */
  project?: string;
  /**
   * Machine id → `[[Machines/<id>]]`. When omitted, derived from the agent
   * name's trailing parenthesised segment (`Claude Code (Ao)` → `Ao`). Never
   * the server's own machineId — that is where the SERVER runs, not the agent.
   */
  machine?: string;
}

/** Same slug rule as Projects/<slug>.md (project-reconcile.ts). */
export function projectSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/** Strip anything that would break a `[[wiki-link]]` or a path segment. */
function sanitizeLinkSegment(text: string): string {
  return text
    .replace(/[\/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[\[\]|#^\r\n]/g, '')
    .trim();
}

/**
 * Machine id implied by a machine-scoped agent name: the trailing
 * parenthesised segment (`Claude Code (Ao)` → `Ao`). Returns '' when the name
 * carries no such segment.
 */
export function machineFromAgentName(agentName: string): string {
  const m = /\(([^()]+)\)\s*$/.exec(agentName);
  return m ? sanitizeLinkSegment(m[1]) : '';
}

/**
 * Render the wiki-link suffix for a diary entry, e.g.
 * ` · [[Projects/cortexmd]] @ [[Machines/Ao]]`. Links already present in
 * `entry` are not repeated (the agent may have written them itself, as the
 * hooks instruct when talking to a server that predates these params).
 * Returns '' when there is nothing to add.
 */
export function renderDiaryLinks(
  entry: string,
  agentName: string,
  opts: DiaryLinkOptions = {},
): string {
  const project = opts.project ? projectSlug(sanitizeLinkSegment(opts.project)) : '';
  const machine = sanitizeLinkSegment(opts.machine ?? '') || machineFromAgentName(agentName);

  const links: string[] = [];
  if (project) {
    const link = `[[Projects/${project}]]`;
    if (!entry.toLowerCase().includes(link.toLowerCase())) links.push(link);
  }
  if (machine) {
    const link = `[[Machines/${machine}]]`;
    if (!entry.toLowerCase().includes(link.toLowerCase())) links.push(link);
  }
  if (links.length === 0) return '';
  return ` · ${links.join(' @ ')}`;
}

/**
 * Append a timestamped entry to today's journal file,
 * or to a per-agent daily diary when agentName is provided.
 *
 * Journal files: Journal/YYYY/MM/YYYY-MM-DD.md
 * Diary files:   Ops/Agent Diaries/{agent}/YYYY-MM-DD.md
 *
 * Diary entries get a ` · [[Projects/<slug>]] @ [[Machines/<id>]]` suffix
 * (see {@link renderDiaryLinks}); `links` is ignored for the daily journal.
 */
export async function appendJournalEntry(
  entry: string,
  source?: { kind: string; id?: string },
  agentName?: string,
  links?: DiaryLinkOptions,
): Promise<{ path: string; lineRef: string }> {
  const now = new Date();

  // Per-agent diary
  if (agentName) {
    const safeName = agentName.replace(/[\/\\]/g, '').replace(/\.\./g, '');
    if (!safeName || safeName.startsWith('.')) {
      throw new Error('Invalid agent name');
    }
    const filePath = diaryPath(safeName, now);
    const timestamp = formatTime(now);
    // Diary contract: ONE line per entry. readAgentDiary / memory_wakeup only
    // parse the first line of an entry, so a multi-line "paragraph" would be
    // silently truncated on read-back — fold newlines into " / " instead.
    const oneLine = entry.replace(/\s*\r?\n+\s*/g, ' / ').trim();
    const suffix = renderDiaryLinks(oneLine, safeName, links);
    const line = `- **${timestamp}** — ${oneLine}${suffix}`;
    const today = now.toISOString().slice(0, 10);

    let existing = '';
    let ifMatch: string | undefined;
    try {
      const result = await readNote(filePath);
      existing = result.content;
      ifMatch = result.etag;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
      existing = `# ${agentName} — ${today}\n\n`;
    }

    const newContent = existing.trimEnd() + '\n' + line + '\n';
    await writeNote(filePath, newContent, ifMatch);
    // A new diary day gets an inbound link from the per-agent index so it is
    // never an orphan (index notes sit beside, not inside, the agent folder,
    // so readAgentDiary / listAgents never mistake them for diary days).
    if (!ifMatch) {
      await linkFromIndex(
        { path: `Ops/Agent Diaries/${safeName}.md`, title: `${safeName} — diary` },
        filePath,
        [{ path: 'Ops/Agent Diaries/Agent Diaries.md', title: 'Agent Diaries' }],
      );
    }

    const lineNumber = newContent.trimEnd().split('\n').length;
    return { path: filePath, lineRef: `L${lineNumber}:${timestamp}` };
  }

  // Daily journal file
  const filePath = journalPath(now);
  const timestamp = formatTimestamp(now);
  const today = now.toISOString().slice(0, 10);

  const sourceTag = source
    ? ` (source: ${source.kind}${source.id ? ' ' + source.id : ''})`
    : '';
  const line = `- [${timestamp}] ${entry}${sourceTag}`;

  let existing = '';
  let ifMatch: string | undefined;
  try {
    const result = await readNote(filePath);
    existing = result.content;
    ifMatch = result.etag;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    existing = `# Journal — ${today}\n\ntags: #journal\n\n`;
  }

  const newContent = existing.trimEnd() + '\n' + line + '\n';
  await writeNote(filePath, newContent, ifMatch);
  // A new journal day gets an inbound link from its month index.
  if (!ifMatch) {
    const month = filePath.match(/^Journal\/(\d{4})\/(\d{2})\//)!;
    await linkFromIndex(
      { path: `Journal/${month[1]}/${month[1]}-${month[2]}.md`, title: `Journal — ${month[1]}-${month[2]}` },
      filePath,
      [{ path: 'Journal/Journal Index.md', title: 'Journal' }],
    );
  }

  const lineNumber = newContent.trimEnd().split('\n').length;
  return { path: filePath, lineRef: `L${lineNumber}:${timestamp}` };
}

// ---------------------------------------------------------------------------
// Per-agent diary reading
// ---------------------------------------------------------------------------

export interface DiaryEntry {
  date: string;
  time: string;
  text: string;
}

export interface ReadDiaryOptions {
  /**
   * Keep only entries that link `[[Projects/<slug>]]` (case-insensitive;
   * aliases and headings tolerated). Falls back to the unfiltered diary when
   * fewer than 2 entries match, so a brand-new project still gets context.
   */
  project?: string;
}

/** Newest diary files scanned when looking for project-linked entries. */
const DIARY_PROJECT_SCAN_MAX_FILES = 60;
/** Below this many project matches the filter is abandoned (see ReadDiaryOptions). */
const DIARY_PROJECT_MIN_MATCHES = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[[Projects/<slug>]]`, `[[Projects/<slug>|alias]]`, `[[projects/<slug>#h]]`. */
export function diaryProjectMatcher(project: string): RegExp | null {
  const slug = projectSlug(sanitizeLinkSegment(project));
  if (!slug) return null;
  return new RegExp(`\\[\\[projects/${escapeRegExp(slug)}(?:\\.md)?(?:\\]\\]|\\||#)`, 'i');
}

/**
 * Read a per-agent diary. Scans daily diary files for the agent (newest
 * first) and returns the last N entries across all dates.
 *
 * With `lastN`, the N entries returned are the chronologically LAST ones,
 * in chronological order (oldest → newest), so "showing last 3" reads as a
 * recap. Without `lastN` the raw file order is kept (files newest-first,
 * lines in file order) for backward compatibility.
 *
 * `projectFiltered` reports whether the project filter was applied.
 */
export async function readAgentDiary(
  agentName: string,
  lastN?: number,
  opts: ReadDiaryOptions = {},
): Promise<{ entries: DiaryEntry[]; total: number; projectFiltered: boolean }> {
  const agentDir = `Ops/Agent Diaries/${agentName}`;

  let files: string[];
  try {
    files = await listFiles(agentDir, '*.md');
  } catch {
    return { entries: [], total: 0, projectFiltered: false };
  }

  // Sort by filename (date) descending to get most recent first
  files.sort((a, b) => b.localeCompare(a));

  const projectRe = opts.project ? diaryProjectMatcher(opts.project) : null;
  const entries: DiaryEntry[] = [];
  const matched: DiaryEntry[] = [];
  const entryRegex = /^-\s+\*\*(\d{2}:\d{2})\*\*\s+—\s+(.+)$/gm;
  let filesRead = 0;

  for (const file of files) {
    // Extract date from filename: "2026-04-08.md" -> "2026-04-08"
    const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.md$/);
    const date = dateMatch ? dateMatch[1] : 'unknown';

    try {
      const { content } = await readNote(file);
      let match: RegExpExecArray | null;
      const fileEntries: DiaryEntry[] = [];

      while ((match = entryRegex.exec(content)) !== null) {
        fileEntries.push({ date, time: match[1], text: match[2] });
      }

      entries.push(...fileEntries);
      if (projectRe) {
        for (const e of fileEntries) if (projectRe.test(e.text)) matched.push(e);
      }
    } catch {
      continue;
    }
    filesRead++;

    // Early exit once we have enough entries (both lists when filtering, so
    // the fallback has material too); bound the scan when filtering.
    if (lastN) {
      if (!projectRe && entries.length >= lastN) break;
      if (projectRe && matched.length >= lastN && entries.length >= lastN) break;
    }
    if (projectRe && filesRead >= DIARY_PROJECT_SCAN_MAX_FILES) break;
  }

  const projectFiltered = !!projectRe && matched.length >= DIARY_PROJECT_MIN_MATCHES;
  const pool = projectFiltered ? matched : entries;
  const total = pool.length;

  if (lastN && lastN > 0) {
    // Chronological, then keep the last N (newest).
    const chrono = [...pool].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    return { entries: chrono.slice(-lastN), total, projectFiltered };
  }
  return { entries: pool, total, projectFiltered };
}

/**
 * Cheap variant of {@link listAgents}: returns only agent names by grouping
 * diary filenames, with NO per-file content reads. Used by the wakeup hot
 * path, which only needs names for awareness — reading every diary of every
 * agent just to count entries (as listAgents does) is wasted work there.
 */
export async function listAgentNames(): Promise<string[]> {
  const baseDir = 'Ops/Agent Diaries';

  let files: string[];
  try {
    files = await listFiles(baseDir, '*/*.md');
  } catch {
    return [];
  }

  const names = new Set<string>();
  for (const file of files) {
    const relative = file.replace(/^Ops\/Agent Diaries\//, '');
    const slash = relative.indexOf('/');
    if (slash === -1) continue;
    names.add(relative.slice(0, slash));
  }
  return [...names];
}

// Short-TTL cache for listAgents — the agent roster changes slowly and the
// call fans out over every diary file, so a few seconds of staleness is a good
// trade for keeping callers (e.g. vault_status) off the serial-read hot path.
let listAgentsCache: {
  ts: number;
  value: Array<{ name: string; lastActive: string; entryCount: number }>;
} | null = null;
const LIST_AGENTS_TTL_MS = 5_000;

/**
 * List all agents that have diary files, with metadata.
 *
 * `lastActive` is derived purely from filenames (no body reads). `entryCount`
 * requires counting entry lines, so per-agent diary reads are fanned out with
 * `Promise.all` rather than awaited serially. Results are memoised for a short
 * TTL so repeated status calls do not re-scan every diary.
 */
export async function listAgents(): Promise<
  Array<{ name: string; lastActive: string; entryCount: number }>
> {
  if (listAgentsCache && Date.now() - listAgentsCache.ts < LIST_AGENTS_TTL_MS) {
    return listAgentsCache.value;
  }

  const baseDir = 'Ops/Agent Diaries';

  let agentDirs: string[];
  try {
    agentDirs = await listFiles(baseDir, '*/*.md');
  } catch {
    return [];
  }

  // Group files by agent name (first path segment after base)
  const agentFiles = new Map<string, string[]>();
  for (const file of agentDirs) {
    // file looks like "Ops/Agent Diaries/claude/2026-04-08.md" or just "claude/2026-04-08.md"
    const relative = file.replace(/^Ops\/Agent Diaries\//, '');
    const slash = relative.indexOf('/');
    if (slash === -1) continue;
    const name = relative.slice(0, slash);
    const existing = agentFiles.get(name) ?? [];
    existing.push(file);
    agentFiles.set(name, existing);
  }

  // Fan out the per-agent entry counts in parallel instead of a serial loop.
  const agents = await Promise.all(
    [...agentFiles].map(async ([name, files]) => {
      // Most recent file = last active date (from filename, no body read).
      files.sort((a, b) => b.localeCompare(a));
      const latestFile = files[0];
      const dateMatch = latestFile.match(/(\d{4}-\d{2}-\d{2})\.md$/);
      const lastActive = dateMatch ? dateMatch[1] : 'unknown';

      const { total } = await readAgentDiary(name);
      return { name, lastActive, entryCount: total };
    }),
  );

  listAgentsCache = { ts: Date.now(), value: agents };
  return agents;
}

/**
 * Log a write operation (tool invocation) to the execution journal.
 * Wraps the journal write in try/catch so logging failures never break the
 * parent operation.
 */
export async function logToolOperation(
  toolName: string,
  inputSummary: string,
  status: 'ok' | 'error',
  errorMessage?: string,
): Promise<void> {
  try {
    const truncatedInput =
      inputSummary.length > 200
        ? inputSummary.slice(0, 200) + '...'
        : inputSummary;

    const statusTag = status === 'error' && errorMessage
      ? `[ERROR: ${errorMessage.slice(0, 100)}]`
      : `[${status.toUpperCase()}]`;

    await appendJournalEntry(
      `Tool \`${toolName}\` ${statusTag} — ${truncatedInput}`,
    );
  } catch {
    // Logging must never fail the parent operation
    logger.error(`Failed to log tool operation: ${toolName}`);
  }
}

/**
 * Log a security-relevant event (auth failure, path violation, rate limit, etc.)
 * to both stderr and the execution journal.  Journal write failures are
 * swallowed so they never mask the original event.
 */
export async function logSecurityEvent(
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  const detailStr = JSON.stringify(details);
  const logLine = `[SECURITY] ${event}: ${detailStr}`;

  logger.error(logLine);

  try {
    await appendJournalEntry(`**SECURITY** ${event} — ${detailStr}`);
  } catch {
    logger.error('Failed to write security event to journal');
  }
}
