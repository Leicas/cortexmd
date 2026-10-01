// Target may contain balanced `[...]` groups (e.g. `[[Tasks/[P1] Reply]]`);
// an optional `|alias` (group 2) follows.
const WIKILINK_RE = /\[\[((?:[^[\]|]|\[[^[\]|]*\])+)(?:\|([^\]]*))?\]\]/g;

/**
 * Normalise a raw wiki-link target. Returns undefined when the text is not a
 * real link but shell/command syntax: bash tests (`[[ -f x ]]`,
 * `[[ $x == y ]]`), `&&` chains, variable expansions (`$HOME`, `${x}`,
 * `$(cmd)`) and `; then`-style control flow. A bare `$` or `;` in a note name
 * (`[[Pricing $99]]`) is kept. A trailing backslash (from table-escaped
 * `[[a\|alias]]`) is stripped.
 */
function cleanWikilinkTarget(raw: string): string | undefined {
  const target = raw.replace(/\\+$/, '').trim();
  if (!target) return undefined;
  if (/^[-!]/.test(target) || /&&/.test(target)) return undefined;
  if (/\$[A-Za-z_{(]/.test(target) || /;\s*(then|do|done|fi|else)\b/.test(target)) return undefined;
  // bash `[[ a == b ]]` always pads with spaces; a padded comparison is never a note
  if (/^\s/.test(raw) && /\s(==|!=|=~|-eq|-ne|-lt|-gt|-le|-ge)\s/.test(raw)) return undefined;
  return target;
}

/**
 * Rewrite every line that is outside fenced code blocks (``` or ~~~; an
 * unterminated fence runs to end of file, as in CommonMark). `fn` gets the
 * line with inline code spans removed from view: it is called per non-code
 * segment and its results are re-joined with the untouched code spans.
 */
function mapProseSegments(content: string, fn: (segment: string, line: number) => string): string {
  const lines = content.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
        continue;
      }
      // A closing fence uses the same char, is at least as long, and has no info string
      if (marker[0] === fence[0] && marker.length >= fence.length && !fenceMatch[2].trim()) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;
    // split() with two groups yields [prose, code, backticks, prose, ...]
    const parts = lines[i].split(/((`+)[^`]*?\2)/);
    let out = '';
    for (let j = 0; j < parts.length; j++) {
      if (j % 3 === 0) out += fn(parts[j], i + 1);
      else if (j % 3 === 1) out += parts[j];
    }
    lines[i] = out;
  }
  return lines.join('\n');
}

/**
 * Extract wiki-link targets with 1-based line numbers, ignoring fenced code
 * blocks and inline code spans.
 */
export function extractWikilinksWithLines(content: string): Array<{ target: string; line: number }> {
  const out: Array<{ target: string; line: number }> = [];
  mapProseSegments(content, (segment, line) => {
    for (const match of segment.matchAll(WIKILINK_RE)) {
      const target = cleanWikilinkTarget(match[1]);
      if (target) out.push({ target, line });
    }
    return segment;
  });
  return out;
}

/**
 * Rewrite wiki-links outside code. `fn` receives the cleaned target, the alias
 * (if any) and whether the link used a table-escaped `\|`; it returns the
 * replacement text, or undefined to leave the link unchanged.
 */
export function replaceWikilinks(
  content: string,
  fn: (target: string, alias: string | undefined, escapedPipe: boolean) => string | undefined,
): string {
  return mapProseSegments(content, (segment) =>
    segment.replace(WIKILINK_RE, (whole, raw: string, alias: string | undefined) => {
      const target = cleanWikilinkTarget(raw);
      if (!target) return whole;
      return fn(target, alias, /\\$/.test(raw)) ?? whole;
    }),
  );
}

/**
 * Extract all wiki-link targets from markdown content.
 * Returns link targets without aliases.
 */
export function extractWikilinks(content: string): string[] {
  return extractWikilinksWithLines(content).map((l) => l.target);
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
