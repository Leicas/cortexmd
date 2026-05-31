import { readNote, writeNote, listFiles } from './vault.js';
import { logger } from './logger.js';

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

/**
 * Append a timestamped entry to today's journal file,
 * or to a per-agent daily diary when agentName is provided.
 *
 * Journal files: Journal/YYYY/MM/YYYY-MM-DD.md
 * Diary files:   Ops/Agent Diaries/{agent}/YYYY-MM-DD.md
 */
export async function appendJournalEntry(
  entry: string,
  source?: { kind: string; id?: string },
  agentName?: string,
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
    const line = `- **${timestamp}** — ${entry}`;
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

/**
 * Read a per-agent diary. Scans all daily diary files for the agent
 * and returns the last N entries across all dates.
 */
export async function readAgentDiary(
  agentName: string,
  lastN?: number,
): Promise<{ entries: DiaryEntry[]; total: number }> {
  const agentDir = `Ops/Agent Diaries/${agentName}`;

  let files: string[];
  try {
    files = await listFiles(agentDir, '*.md');
  } catch {
    return { entries: [], total: 0 };
  }

  // Sort by filename (date) descending to get most recent first
  files.sort((a, b) => b.localeCompare(a));

  const entries: DiaryEntry[] = [];
  const entryRegex = /^-\s+\*\*(\d{2}:\d{2})\*\*\s+—\s+(.+)$/gm;

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
    } catch {
      continue;
    }

    // Early exit if we have enough entries
    if (lastN && entries.length >= lastN) break;
  }

  const total = entries.length;
  const sliced = lastN && lastN > 0 ? entries.slice(0, lastN) : entries;

  return { entries: sliced, total };
}

/**
 * List all agents that have diary files, with metadata.
 */
export async function listAgents(): Promise<
  Array<{ name: string; lastActive: string; entryCount: number }>
> {
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

  const agents: Array<{ name: string; lastActive: string; entryCount: number }> = [];

  for (const [name, files] of agentFiles) {
    // Most recent file = last active date
    files.sort((a, b) => b.localeCompare(a));
    const latestFile = files[0];
    const dateMatch = latestFile.match(/(\d{4}-\d{2}-\d{2})\.md$/);
    const lastActive = dateMatch ? dateMatch[1] : 'unknown';

    const { total } = await readAgentDiary(name);
    agents.push({ name, lastActive, entryCount: total });
  }

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
