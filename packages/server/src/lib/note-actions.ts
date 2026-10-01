/**
 * Shared note removal paths used by the notes_delete / notes_archive tools and
 * the dream's orphan triage, so every caller re-points inbound links, updates
 * the indexes and leaves the same journal audit line.
 */
import { readNote, writeNote, deleteNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { indexNote, removeFromIndex } from './search.js';
import { appendJournalEntry } from './journal.js';
import { rewriteInboundLinks } from './link-rewrite.js';
import { recordArchive } from './metrics.js';

export interface DeleteResult {
  path: string;
  title: string;
  relinked: string[];
}

/**
 * Permanently delete a note: inbound links are re-pointed at its
 * `consolidated_into` summary (or flattened to plain text), the file is
 * removed, the indexes are updated and the deletion is journaled.
 */
export async function deleteNoteWithRelink(notePath: string, reason: string): Promise<DeleteResult> {
  let title = notePath;
  let category: string | undefined;
  let consolidatedInto: string | undefined;
  try {
    const { content } = await readNote(notePath);
    const { data } = parseFrontmatter(content);
    title = data.title ?? notePath;
    category = data.category;
    if (typeof data.consolidated_into === 'string') consolidatedInto = data.consolidated_into;
  } catch {
    // File might not parse — still allow deletion
  }

  const relinked = await rewriteInboundLinks(notePath, consolidatedInto);
  await deleteNote(notePath);
  removeFromIndex(notePath);
  await appendJournalEntry(
    `Deleted note: \`${notePath}\` (${title})${category ? ` [${category}]` : ''} — reason: ${reason}`,
  );
  return { path: notePath, title, relinked };
}

/**
 * Archive a note in place: frontmatter gets archived/archived_at/archive_reason
 * and goes cold. Optionally writes a copy under Archive/. Journaled.
 */
export async function archiveNoteInPlace(
  notePath: string,
  reason?: string,
  moveToArchive = false,
): Promise<{ path: string; archiveCopyPath?: string }> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const { content, etag } = await readNote(notePath);
  const { data, body } = parseFrontmatter(content);
  data.archived = true;
  data.archived_at = todayStr;
  if (reason) data.archive_reason = reason;
  data.temperature = 'cold';
  data.heat_score = 0;

  const updated = stringifyFrontmatter(data, body);
  await writeNote(notePath, updated, etag);

  let archiveCopyPath: string | undefined;
  if (moveToArchive) {
    archiveCopyPath = `Archive/${notePath}`;
    await writeNote(archiveCopyPath, updated);
  }

  recordArchive(notePath);
  await appendJournalEntry(`Archived note: [[${notePath}]]${reason ? ` — reason: ${reason}` : ''}`);
  await indexNote(notePath);
  if (archiveCopyPath) await indexNote(archiveCopyPath);
  return { path: notePath, archiveCopyPath };
}
