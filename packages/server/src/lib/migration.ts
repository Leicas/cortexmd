import { readFile, writeFile, unlink, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

export interface MigrationResult {
  status: 'ok' | 'partial' | 'error';
  memoriesMoved: number;
  journalEntriesSplit: number;
  diaryFilesSplit: number;
  insightsMerged: number;
  errors: string[];
  dryRun: boolean;
}

/**
 * Resolve a vault-relative path to an absolute path in the RW vault.
 */
function abs(vaultRelative: string): string {
  return path.join(config.brainVault, vaultRelative);
}

/**
 * Check if a path exists.
 */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively list all files under a directory (absolute paths).
 */
async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Move a file from src to dest, creating parent directories as needed.
 * Returns true if moved, false if skipped (dest already exists).
 */
async function moveFile(src: string, dest: string): Promise<boolean> {
  if (await exists(dest)) {
    return false; // don't overwrite
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const content = await readFile(src, 'utf-8');
  await writeFile(dest, content, 'utf-8');
  await unlink(src);
  return true;
}

// ── Memory migration ────────────────────────────────────────────────────────

/**
 * Migrate flat memory files to year/month subfolders.
 * Memories/{category}/2026-04-08-slug.md → Memories/{category}/2026/04/2026-04-08-slug.md
 *
 * Timeless categories (fact, preference) are left flat.
 * Also merges `insights/` into `insight/`.
 */
async function migrateMemories(dryRun: boolean): Promise<{ moved: number; insightsMerged: number; errors: string[] }> {
  const memoriesDir = abs('Memories');
  let moved = 0;
  let insightsMerged = 0;
  const errors: string[] = [];

  const TIMELESS = new Set(['fact', 'preference']);
  const DATE_PREFIX = /^(\d{4})-(\d{2})-\d{2}-.+\.md$/;

  // Step 1: Merge insights/ into insight/ (fix the typo split)
  const insightsDir = path.join(memoriesDir, 'insights');
  const insightDir = path.join(memoriesDir, 'insight');
  if (await exists(insightsDir)) {
    const files = await walkDir(insightsDir);
    for (const file of files) {
      const relative = path.relative(insightsDir, file);
      const dest = path.join(insightDir, relative);
      try {
        if (dryRun) {
          insightsMerged++;
        } else {
          const didMove = await moveFile(file, dest);
          if (didMove) insightsMerged++;
        }
      } catch (err) {
        errors.push(`insights merge ${relative}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Step 2: Move date-prefixed files into year/month subfolders
  let categories: string[];
  try {
    const entries = await readdir(memoriesDir, { withFileTypes: true });
    categories = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return { moved, insightsMerged, errors };
  }

  for (const category of categories) {
    if (category === 'insights') continue; // already handled above
    if (TIMELESS.has(category)) continue;

    const catDir = path.join(memoriesDir, category);
    let files: string[];
    try {
      // Only list direct children (not already in subfolders)
      const entries = await readdir(catDir, { withFileTypes: true });
      files = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
    } catch {
      continue;
    }

    for (const filename of files) {
      const match = filename.match(DATE_PREFIX);
      if (!match) continue; // skip files without date prefix

      const year = match[1];
      const month = match[2];
      const src = path.join(catDir, filename);
      const dest = path.join(catDir, year, month, filename);

      try {
        if (dryRun) {
          moved++;
        } else {
          const didMove = await moveFile(src, dest);
          if (didMove) moved++;
        }
      } catch (err) {
        errors.push(`memory ${category}/${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { moved, insightsMerged, errors };
}

// ── Journal migration ───────────────────────────────────────────────────────

/**
 * Split the single Execution Journal into daily files.
 * 05 CRM/Logs/Execution Journal.md → Journal/YYYY/MM/YYYY-MM-DD.md
 *
 * Parses lines like: "- [2026-04-08 14:30:00] Entry text..."
 * Groups by date and writes one file per day.
 */
async function migrateJournal(dryRun: boolean): Promise<{ entriesSplit: number; errors: string[] }> {
  const journalFile = abs('05 CRM/Logs/Execution Journal.md');
  let entriesSplit = 0;
  const errors: string[] = [];

  if (!(await exists(journalFile))) {
    return { entriesSplit, errors };
  }

  let content: string;
  try {
    content = await readFile(journalFile, 'utf-8');
  } catch (err) {
    errors.push(`read journal: ${err instanceof Error ? err.message : String(err)}`);
    return { entriesSplit, errors };
  }

  // Parse entries grouped by date
  const LINE_RE = /^- \[(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\]\s+(.+)$/;
  const dayEntries = new Map<string, string[]>();

  for (const line of content.split('\n')) {
    const match = line.match(LINE_RE);
    if (!match) continue;
    const date = match[1];
    const time = match[2];
    const text = match[3];
    const existing = dayEntries.get(date) ?? [];
    existing.push(`- [${time}] ${text}`);
    dayEntries.set(date, existing);
  }

  if (dayEntries.size === 0) {
    return { entriesSplit, errors };
  }

  for (const [date, entries] of dayEntries) {
    const [year, month] = date.split('-');
    const destPath = abs(`Journal/${year}/${month}/${date}.md`);

    // If daily file already exists, append non-duplicate entries
    let existingContent = '';
    if (await exists(destPath)) {
      existingContent = await readFile(destPath, 'utf-8');
    }

    const header = existingContent || `# Journal — ${date}\n\ntags: #journal\n\n`;
    const newEntries = entries.filter(e => !existingContent.includes(e));

    if (newEntries.length === 0) continue;

    const finalContent = header.trimEnd() + '\n' + newEntries.join('\n') + '\n';

    try {
      if (dryRun) {
        entriesSplit += newEntries.length;
      } else {
        await mkdir(path.dirname(destPath), { recursive: true });
        await writeFile(destPath, finalContent, 'utf-8');
        entriesSplit += newEntries.length;
      }
    } catch (err) {
      errors.push(`journal ${date}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rename old journal to .migrated (don't delete — safety net)
  if (!dryRun && entriesSplit > 0) {
    try {
      const backupPath = journalFile.replace('.md', '.migrated.md');
      const backupContent = `---\nmigrated: true\nmigrated_at: ${new Date().toISOString()}\nentries_moved: ${entriesSplit}\n---\n\nThis journal has been migrated to daily files under Journal/YYYY/MM/.\nOriginal content preserved below for reference.\n\n${content}`;
      await writeFile(backupPath, backupContent, 'utf-8');
      await unlink(journalFile);
    } catch (err) {
      errors.push(`journal backup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { entriesSplit, errors };
}

// ── Diary migration ─────────────────────────────────────────────────────────

/**
 * Split per-agent monolithic diary files into daily files.
 * 05 CRM/Logs/Agent Diaries/{agent}.md → Ops/Agent Diaries/{agent}/YYYY-MM-DD.md
 *
 * Parses date headings (## YYYY-MM-DD) and splits entries accordingly.
 */
async function migrateDiaries(dryRun: boolean): Promise<{ filesSplit: number; errors: string[] }> {
  const oldDir = abs('05 CRM/Logs/Agent Diaries');
  let filesSplit = 0;
  const errors: string[] = [];

  if (!(await exists(oldDir))) {
    return { filesSplit, errors };
  }

  let agentFiles: string[];
  try {
    const entries = await readdir(oldDir, { withFileTypes: true });
    agentFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
  } catch {
    return { filesSplit, errors };
  }

  const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
  const ENTRY_RE = /^-\s+\*\*(\d{2}:\d{2})\*\*\s+—\s+(.+)$/;

  for (const filename of agentFiles) {
    const agentName = filename.replace(/\.md$/, '');
    const filePath = path.join(oldDir, filename);

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      errors.push(`read diary ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Parse into date-grouped entries
    const dayEntries = new Map<string, string[]>();
    let currentDate = '';

    for (const line of content.split('\n')) {
      const dateMatch = line.match(DATE_HEADING);
      if (dateMatch) {
        currentDate = dateMatch[1];
        continue;
      }

      const entryMatch = line.match(ENTRY_RE);
      if (entryMatch && currentDate) {
        const existing = dayEntries.get(currentDate) ?? [];
        existing.push(line);
        dayEntries.set(currentDate, existing);
      }
    }

    if (dayEntries.size === 0) continue;

    for (const [date, entries] of dayEntries) {
      const destPath = abs(`Ops/Agent Diaries/${agentName}/${date}.md`);

      let existingContent = '';
      if (await exists(destPath)) {
        existingContent = await readFile(destPath, 'utf-8');
      }

      const header = existingContent || `# ${agentName} — ${date}\n\n`;
      const newEntries = entries.filter(e => !existingContent.includes(e));
      if (newEntries.length === 0) continue;

      const finalContent = header.trimEnd() + '\n' + newEntries.join('\n') + '\n';

      try {
        if (dryRun) {
          filesSplit++;
        } else {
          await mkdir(path.dirname(destPath), { recursive: true });
          await writeFile(destPath, finalContent, 'utf-8');
          filesSplit++;
        }
      } catch (err) {
        errors.push(`diary ${agentName}/${date}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Rename old file to .migrated
    if (!dryRun && dayEntries.size > 0) {
      try {
        const backupPath = filePath.replace('.md', '.migrated.md');
        const backupContent = `---\nmigrated: true\nmigrated_at: ${new Date().toISOString()}\n---\n\nMigrated to daily files under Ops/Agent Diaries/${agentName}/.\n\n${content}`;
        await writeFile(backupPath, backupContent, 'utf-8');
        await unlink(filePath);
      } catch (err) {
        errors.push(`diary backup ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { filesSplit, errors };
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the full vault migration.
 * Set dryRun=true to preview changes without modifying files.
 */
export async function runMigration(dryRun = false): Promise<MigrationResult> {
  logger.info('Starting vault migration', { dryRun });
  const allErrors: string[] = [];

  const memResult = await migrateMemories(dryRun);
  allErrors.push(...memResult.errors);

  const journalResult = await migrateJournal(dryRun);
  allErrors.push(...journalResult.errors);

  const diaryResult = await migrateDiaries(dryRun);
  allErrors.push(...diaryResult.errors);

  const result: MigrationResult = {
    status: allErrors.length === 0 ? 'ok' : (memResult.moved > 0 || journalResult.entriesSplit > 0 ? 'partial' : 'error'),
    memoriesMoved: memResult.moved,
    journalEntriesSplit: journalResult.entriesSplit,
    diaryFilesSplit: diaryResult.filesSplit,
    insightsMerged: memResult.insightsMerged,
    errors: allErrors,
    dryRun,
  };

  logger.info('Vault migration complete', { ...result });
  return result;
}
