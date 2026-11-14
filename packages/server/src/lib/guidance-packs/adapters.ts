/**
 * Layout adapters: turn a synced pack's file tree into searchable entries
 * `{pack, id, title, description, area, path, bytes, headings}` and skills.
 *
 * Two layouts ship:
 *   - `skill-pack`: `skills/<skill>/SKILL.md` (or a root `SKILL.md`) plus the
 *     Markdown guides/references below each skill directory. This is the
 *     layout of GoogleChrome/modern-web-guidance.
 *   - `markdown-folder`: any folder of Markdown files.
 *
 * Descriptions come, in order, from the pack's own catalog (a Markdown link
 * list such as `- **[id](…/guides/css/id.md)**: description` in a root README /
 * index, or a JSON index of `{id, description}`), then frontmatter
 * `description`, then the `## Overview` / first paragraph.
 *
 * Everything here is pure text processing: no YAML engine (gray-matter can
 * evaluate `---js` front matter), no dynamic import, nothing executed.
 */
import type { AdapterContext, PackAdapter, PackEntry, PackFile, PackSkill, ParsedPack } from './types.js';

const DESC_MAX = 320;
const ROOT_DOC_RE = /^(readme|license|licence|notice|copying|changelog|contributing|code_of_conduct|security|authors)(\.[a-z]+)?$/i;

/** Minimal, non-evaluating frontmatter reader (scalars, quoted strings, `|`/`>` blocks). */
export function readFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const src = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i].trim());
      }
      value = (folded ? block.join(' ') : block.join('\n')).trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in data)) data[key] = value;
  }
  return { data, body: src.slice(m[0].length) };
}

function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clipDescription(s: string, max = DESC_MAX): string {
  const t = stripInlineMarkdown(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(' ')) + '…').trim();
}

/** Lines outside fenced code blocks. */
function proseLines(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) out.push(line);
  }
  return out;
}

function firstParagraph(lines: string[], from: number): string {
  const para: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) {
      if (para.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(l)) {
      if (para.length) break;
      continue;
    }
    // Skip tables of contents, lists, tables, quotes and HTML when hunting for prose.
    if (/^([-*+]|\d+\.)\s|^\||^>|^</.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l);
  }
  return para.join(' ');
}

export interface DocMeta {
  title: string;
  description: string;
  headings: string[];
}

/** Title (first `#`), headings (`##`/`###`) and a fallback description from the document itself. */
export function describeDocument(text: string, fallbackTitle: string): DocMeta {
  const { data, body } = readFrontmatter(text);
  const lines = proseLines(body);
  let title = '';
  const headings: string[] = [];
  let overviewAt = -1;
  let titleAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!h) continue;
    const text2 = stripInlineMarkdown(h[2]);
    if (h[1].length === 1 && !title) {
      title = text2;
      titleAt = i;
    } else if (h[1].length >= 2 && headings.length < 40) {
      headings.push(text2);
      if (overviewAt < 0 && /^(overview|summary|introduction|about)$/i.test(text2)) overviewAt = i;
    }
  }
  const fm = (data.description ?? '').trim();
  const prose = fm || firstParagraph(lines, overviewAt >= 0 ? overviewAt + 1 : titleAt + 1) || firstParagraph(lines, 0);
  return {
    title: title || (data.title ?? '').trim() || fallbackTitle,
    description: clipDescription(prose),
    headings,
  };
}

function humanize(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * Catalog descriptions shipped by the pack: Markdown link lists in root-level
 * documents (`[label](path/to/guide.md)…: description`) and JSON indexes
 * (`[{id, description}]`, or an object holding such an array).
 * Returns path-suffix → description and id → description maps.
 */
export async function readCatalog(ctx: AdapterContext): Promise<{ byPath: Map<string, string>; byId: Map<string, string> }> {
  const byPath = new Map<string, string>();
  const byId = new Map<string, string>();
  const rootDocs = ctx.files.filter((f) => !f.path.includes('/') && /\.(md|json)$/i.test(f.path) && f.bytes <= 2 * 1024 * 1024);
  for (const f of rootDocs) {
    let text: string;
    try {
      text = await ctx.read(f.path);
    } catch {
      continue;
    }
    if (/\.json$/i.test(f.path)) {
      if (/^(package|package-lock|tsconfig|plugin)\.json$/i.test(f.path)) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        const arrays: unknown[][] = Array.isArray(parsed)
          ? [parsed]
          : parsed && typeof parsed === 'object'
            ? Object.values(parsed as Record<string, unknown>).filter(Array.isArray) as unknown[][]
            : [];
        for (const arr of arrays) {
          for (const item of arr) {
            const o = item as { id?: unknown; description?: unknown; path?: unknown };
            if (!o || typeof o.description !== 'string' || !o.description.trim()) continue;
            if (typeof o.id === 'string' && !byId.has(o.id)) byId.set(o.id, clipDescription(o.description));
            if (typeof o.path === 'string') byPath.set(o.path.replace(/\\/g, '/').replace(/^\.?\//, ''), clipDescription(o.description));
          }
        }
      } catch {
        // not an index
      }
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:[-*+]|\d+\.)\s+\**\[([^\]]+)\]\(([^)\s]+\.md)(?:#[^)]*)?\)\**\s*(?::|[-–—])\s+(.{8,})$/.exec(line);
      if (!m) continue;
      let target = m[2];
      try {
        target = decodeURIComponent(target);
      } catch {
        // keep raw
      }
      // Hosted links (`https://github.com/o/r/blob/<ref>/path.md`) → repo-relative path.
      target = target.replace(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:blob|tree|raw)\/[^/]+\//, '').replace(/^\.?\//, '');
      if (/^[a-z]+:\/\//i.test(target)) continue;
      if (!byPath.has(target)) byPath.set(target, clipDescription(m[3]));
    }
  }
  return { byPath, byId };
}

interface Candidate {
  path: string;
  bytes: number;
  skill?: string;
}

async function buildEntries(ctx: AdapterContext, candidates: Candidate[]): Promise<PackEntry[]> {
  const catalog = await readCatalog(ctx);
  const sorted = [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // ids are file names; a clash is resolved by qualifying the later files
  // with their parent directory (then the full path).
  const taken = new Set<string>();
  const entries: PackEntry[] = [];
  for (const c of sorted) {
    const stem = baseName(c.path).replace(/\.md$/i, '');
    const area = baseName(dirName(c.path)) || '';
    let id = stem;
    if (taken.has(id)) id = area ? `${area}/${stem}` : stem;
    if (taken.has(id)) id = c.path.replace(/\.md$/i, '');
    taken.add(id);

    let text = '';
    try {
      text = await ctx.read(c.path);
    } catch {
      continue;
    }
    const meta = describeDocument(text, humanize(stem));
    const fromCatalog = catalog.byPath.get(c.path) ?? catalog.byId.get(id) ?? catalog.byId.get(stem);
    entries.push({
      pack: ctx.pack,
      id,
      title: meta.title,
      description: fromCatalog || meta.description || meta.title,
      area,
      path: c.path,
      bytes: c.bytes,
      headings: meta.headings,
      ...(c.skill ? { skill: c.skill } : {}),
    });
  }
  return entries;
}

function skillFiles(files: PackFile[]): PackFile[] {
  return files.filter((f) => /^(?:skills\/[^/]+\/)?SKILL\.md$/.test(f.path));
}

export const skillPackAdapter: PackAdapter = {
  name: 'skill-pack',
  detect: (files) => skillFiles(files).length > 0,
  async parse(ctx) {
    const skills: PackSkill[] = [];
    const candidates: Candidate[] = [];
    // The skill with the most documents (the pack's main corpus) is listed
    // first so its guides keep the bare file-name ids on a clash.
    const docCount = (def: PackFile): number => {
      const prefix = dirName(def.path) ? `${dirName(def.path)}/` : '';
      return ctx.files.filter((f) => /\.md$/i.test(f.path) && f.path.startsWith(prefix)).length;
    };
    const defs = skillFiles(ctx.files).sort((a, b) => docCount(b) - docCount(a) || (a.path < b.path ? -1 : 1));
    const ordered: Candidate[] = [];
    for (const def of defs) {
      const dir = dirName(def.path);
      const dirSkill = baseName(dir) || ctx.pack;
      let name = dirSkill;
      let description = '';
      try {
        const { data } = readFrontmatter(await ctx.read(def.path));
        if (/^[A-Za-z0-9][\w.-]{0,63}$/.test(data.name ?? '')) name = data.name;
        description = (data.description ?? '').replace(/\s+/g, ' ').trim();
      } catch {
        // keep directory-derived defaults
      }
      skills.push({ pack: ctx.pack, name, description, path: def.path, bytes: def.bytes });
      const prefix = dir ? `${dir}/` : '';
      for (const f of ctx.files) {
        if (!/\.md$/i.test(f.path) || f.path === def.path) continue;
        if (!f.path.startsWith(prefix)) continue;
        if (!dir && (!f.path.includes('/') || f.path.startsWith('skills/'))) continue;
        if (!dir && ROOT_DOC_RE.test(baseName(f.path))) continue;
        ordered.push({ path: f.path, bytes: f.bytes, skill: name });
      }
    }
    candidates.push(...ordered);
    // buildEntries sorts by path; keep the "pack-named skill first" priority by
    // building per skill and merging with clash-aware ids.
    const entries = await buildEntriesInOrder(ctx, candidates);
    return { entries, skills };
  },
};

/** Like buildEntries but preserves the caller's skill priority for id clashes. */
async function buildEntriesInOrder(ctx: AdapterContext, candidates: Candidate[]): Promise<PackEntry[]> {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = c.skill ?? '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  const all: PackEntry[] = [];
  const taken = new Set<string>();
  for (const group of groups.values()) {
    for (const e of await buildEntries(ctx, group)) {
      let id = e.id;
      if (taken.has(id)) id = e.area ? `${e.area}/${baseName(e.path).replace(/\.md$/i, '')}` : id;
      if (taken.has(id)) id = e.path.replace(/\.md$/i, '');
      taken.add(id);
      all.push({ ...e, id });
    }
  }
  return all;
}

export const markdownFolderAdapter: PackAdapter = {
  name: 'markdown-folder',
  detect: (files) => files.some((f) => /\.md$/i.test(f.path)),
  async parse(ctx) {
    const candidates = ctx.files
      .filter((f) => /\.md$/i.test(f.path))
      .filter((f) => !(ROOT_DOC_RE.test(baseName(f.path)) && !f.path.includes('/')))
      .filter((f) => baseName(f.path) !== 'SKILL.md')
      .map((f) => ({ path: f.path, bytes: f.bytes }));
    return { entries: await buildEntries(ctx, candidates), skills: [] };
  },
};

/** Detection order matters: the most specific layout first. */
export const ADAPTERS: ReadonlyArray<PackAdapter> = [skillPackAdapter, markdownFolderAdapter];

export async function parsePack(ctx: AdapterContext, forced?: string): Promise<ParsedPack> {
  const adapter =
    (forced && ADAPTERS.find((a) => a.name === forced)) || ADAPTERS.find((a) => a.detect(ctx.files)) || markdownFolderAdapter;
  const { entries, skills } = await adapter.parse(ctx);
  return { adapter: adapter.name, entries, skills };
}
