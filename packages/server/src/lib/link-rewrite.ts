import { config } from '../config.js';
import { listFiles, readNote, writeNote } from './vault.js';
import { replaceWikilinks } from './markdown.js';
import { buildLinkLookup, resolveWikilink } from './link-resolver.js';
import { indexNote } from './search.js';
import { invalidateGraphCache } from './graph.js';
import { logger } from './logger.js';

/**
 * Rewrite every inbound `[[link]]` to a note that is about to be removed so it
 * never dangles. With `replacementPath` (e.g. the note's `consolidated_into`
 * summary) links are re-pointed there, keeping the original display text;
 * otherwise they collapse to plain text. Call BEFORE deleting the file so
 * bare-basename links still resolve to it. Returns the rewritten note paths.
 */
export async function rewriteInboundLinks(removedPath: string, replacementPath?: string): Promise<string[]> {
  let files: string[];
  try {
    files = await listFiles(config.brainVault);
  } catch {
    return [];
  }
  const lookup = buildLinkLookup([...files, removedPath]);
  const basename = removedPath.replace(/\.md$/i, '').split('/').pop()!;
  // `consolidated_into` may hold a bare path or a `[[wiki-link]]`
  const replacementNote = replacementPath?.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
  const replacementResolved = replacementNote ? resolveWikilink(replacementNote, lookup) : undefined;
  // A missing summary would just move the dangling link; flatten instead
  const replacement = replacementResolved && replacementResolved !== removedPath
    ? replacementResolved.replace(/\.md$/i, '')
    : undefined;
  const rewritten: string[] = [];

  for (const filePath of files) {
    if (filePath === removedPath) continue;
    try {
      const { content, etag } = await readNote(filePath);
      if (!content.includes(basename)) continue;
      const next = replaceWikilinks(content, (target, alias, escapedPipe) => {
        if (resolveWikilink(target, lookup, filePath) !== removedPath) return undefined;
        const display = alias?.trim() || target.split('#')[0].replace(/\.md$/i, '').split('/').pop()!;
        // The summary itself lists its sources: a self-link there is noise
        if (!replacement || `${replacement}.md` === filePath) return display;
        return `[[${replacement}${escapedPipe ? '\\|' : '|'}${display}]]`;
      });
      if (next === content) continue;
      await writeNote(filePath, next, etag);
      await indexNote(filePath);
      rewritten.push(filePath);
    } catch (err) {
      logger.warn('rewriteInboundLinks: skipped note', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (rewritten.length > 0) invalidateGraphCache();
  return rewritten;
}
