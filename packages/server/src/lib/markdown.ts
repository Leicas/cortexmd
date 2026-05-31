/**
 * Extract all wiki-link targets from markdown content.
 * Returns link targets without aliases.
 */
export function extractWikilinks(content: string): string[] {
  const regex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

/**
 * Replace or insert a section identified by heading title.
 *
 * Finds a heading (## to ####) matching `sectionTitle` and replaces everything
 * between it and the next heading of the same or higher level with `newContent`.
 * If the section is not found, appends a new ## section at the end.
 */
export function mergeSection(
  content: string,
  sectionTitle: string,
  newContent: string,
): string {
  const lines = content.split('\n');
  const headingRegex = /^(#{2,4})\s+(.+)$/;

  let sectionStart = -1;
  let sectionEnd = -1;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingRegex);
    if (!match) continue;

    const level = match[1].length;
    const title = match[2].trim();

    if (sectionStart === -1) {
      // Looking for the target section
      if (title === sectionTitle) {
        sectionStart = i;
        sectionLevel = level;
      }
    } else {
      // Found section start — look for the end (next heading of same or higher level)
      if (level <= sectionLevel) {
        sectionEnd = i;
        break;
      }
    }
  }

  if (sectionStart === -1) {
    // Section not found — append at end
    const trimmed = content.trimEnd();
    return `${trimmed}\n\n## ${sectionTitle}\n${newContent}\n`;
  }

  // Replace section content
  if (sectionEnd === -1) {
    sectionEnd = lines.length;
  }

  const before = lines.slice(0, sectionStart + 1);
  const after = lines.slice(sectionEnd);
  return [...before, newContent, ...after].join('\n');
}

/**
 * Append text at the end of content with a newline separator.
 */
export function appendToContent(content: string, text: string): string {
  if (!content.endsWith('\n')) {
    return `${content}\n${text}`;
  }
  return `${content}${text}`;
}
