/**
 * Markdown for `Projects/<slug>.md` / `Machines/<host>.md` MOC stubs (pure —
 * shared by the diary write path and the hygiene planner).
 *
 * Dataview/Bases-friendly: typed frontmatter properties (`type`, `status`,
 * `slug`/`host`, `description`, `created`) plus a Dataview block listing the
 * diary days that link the entity.
 */
import { stringifyFrontmatter } from '../frontmatter.js';

export type EntityStubKind = 'project' | 'machine';

export function entityStubPath(kind: EntityStubKind, name: string): string {
  return `${kind === 'project' ? 'Projects' : 'Machines'}/${name}.md`;
}

/** A name usable as a single path segment (no separators / reserved chars). */
export function isSafeStubName(name: string): boolean {
  return !!name.trim() && !/[\\/:*?"<>|#^[\]\r\n]/.test(name) && !name.startsWith('.') && name.length <= 120;
}

/** Markdown for a new stub. `name` is the already-sanitised slug / host id. */
export function renderEntityStub(kind: EntityStubKind, name: string, today: string): string {
  const data: Record<string, unknown> = kind === 'project'
    ? { type: 'project', title: name, slug: name, status: 'active', description: '', created: today, tags: ['project'], auto_stub: true }
    : { type: 'machine', title: name, host: name, description: '', created: today, tags: ['machine'], auto_stub: true };
  const label = kind === 'project' ? 'project (git repo slug)' : 'machine (agent host)';
  const body =
    `# ${name}\n\n` +
    `> One-line description of this ${label} — fill in \`description\` above.\n\n` +
    `## Diary activity\n\n` +
    '```dataview\n' +
    'LIST FROM "Ops/Agent Diaries"\n' +
    'WHERE contains(file.outlinks, this.file.link)\n' +
    'SORT file.name DESC\n' +
    'LIMIT 30\n' +
    '```\n';
  return stringifyFrontmatter(data, body);
}
