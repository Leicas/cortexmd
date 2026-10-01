import { readNote, writeNote } from './vault.js';
import { logger } from './logger.js';

export interface IndexNoteRef {
  path: string;
  title: string;
}

/**
 * Append `- [[target]]` to an index note (creating it when missing) so a
 * freshly generated leaf note — a daily journal, a diary day, an EmailLog
 * capture — always has an inbound link. When the index itself is created it is
 * linked from `parents[0]`, and so on up the chain, so new index notes are not
 * orphans either. Best-effort: never throws.
 */
export async function linkFromIndex(
  index: IndexNoteRef,
  targetPath: string,
  parents: IndexNoteRef[] = [],
): Promise<void> {
  const link = `[[${targetPath.replace(/\.md$/i, '')}]]`;
  try {
    let existing: string;
    let etag: string | undefined;
    try {
      ({ content: existing, etag } = await readNote(index.path));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      await writeNote(index.path, `# ${index.title}\n\n- ${link}\n`);
      if (parents.length > 0) await linkFromIndex(parents[0], index.path, parents.slice(1));
      return;
    }
    if (existing.includes(link)) return;
    await writeNote(index.path, `${existing.trimEnd()}\n- ${link}\n`, etag);
  } catch (err) {
    logger.warn('linkFromIndex failed', {
      index: index.path,
      target: targetPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
