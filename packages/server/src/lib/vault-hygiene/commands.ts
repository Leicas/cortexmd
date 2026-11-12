/**
 * vault_hygiene sub-commands. Each one mutates the in-memory VaultModel and
 * records what it did; computePlan() turns the result into the exact list of
 * file modifications / archive moves. Pure: no disk, no config, no index.
 */
import { replaceWikilinks } from '../markdown.js';
import {
  classifyEcho,
  diaryProjectSlugs,
  isDiaryPath,
  isDigestNote,
  isEmailNote,
  isImplausibleProjectName,
  isLowValueLinkTarget,
  isMachineSource,
  projectSlug,
} from './patterns.js';
import { noteLike, noteTags, noteTitle, type HygieneNote, type VaultModel } from './model.js';
import { entityStubPath, isSafeStubName, renderEntityStub, type EntityStubKind } from './stub-template.js';

export const HYGIENE_COMMANDS = [
  'hook-echoes',
  'junk-projects',
  'digests',
  'auto-related',
  'tags',
  'reheat',
  'broken-links',
] as const;
export type HygieneCommand = (typeof HYGIENE_COMMANDS)[number];

export interface HygieneOptions {
  /** Only act on notes under these path prefixes (default: whole vault). */
  prefixes?: string[];
  /** Never act on notes under these path prefixes. */
  excludePrefixes?: string[];
  /** Machine-source regexes (default: patterns.ts DEFAULT_MACHINE_SOURCE_PATTERNS). */
  machineSourcePatterns?: readonly string[];
  /** YYYY-MM-DD stamped on created stubs (default: today). */
  today?: string;
}

function inScope(path: string, opts: HygieneOptions): boolean {
  const p = opts.prefixes?.filter(Boolean) ?? [];
  const x = opts.excludePrefixes?.filter(Boolean) ?? [];
  if (x.some((pre) => path.startsWith(pre))) return false;
  return p.length === 0 || p.some((pre) => path.startsWith(pre));
}

function setData(note: HygieneNote, key: string, value: unknown): boolean {
  if (!note.data) return false;
  if (JSON.stringify(note.data[key]) === JSON.stringify(value)) return false;
  if (value === undefined) delete note.data[key];
  else note.data[key] = value;
  note.dataDirty = true;
  return true;
}

// ---------------------------------------------------------------------------
// Link resolution (Obsidian-like: exact path, path suffix, basename; case-insensitive)
// ---------------------------------------------------------------------------

const ATTACHMENT_EXT = /\.(?!md$)[a-z0-9]{1,6}$/i;

export class LinkIndex {
  private readonly keys = new Map<string, string | null>();

  constructor(paths: Iterable<string>) {
    for (const p of paths) {
      const lower = p.toLowerCase();
      const key = lower.endsWith('.md') ? lower.slice(0, -3) : lower;
      const parts = key.split('/');
      for (let i = 0; i < parts.length; i++) {
        const k = parts.slice(i).join('/');
        const prev = this.keys.get(k);
        if (prev === undefined) this.keys.set(k, p);
        else if (prev !== p) this.keys.set(k, null);
      }
    }
  }

  /**
   * `{ exists, path }` — `path` only when the target resolves uniquely.
   * Heading-only links (`[[#x]]`) exist trivially.
   */
  resolve(target: string, sourcePath?: string): { exists: boolean; path?: string; attachment: boolean } {
    let raw = target.split('#')[0].split('^')[0].trim().replace(/\\/g, '/');
    const attachment = ATTACHMENT_EXT.test(raw);
    if (!raw) return { exists: true, attachment };
    if ((raw.startsWith('./') || raw.startsWith('../')) && sourcePath) {
      const base = sourcePath.split('/').slice(0, -1);
      for (const seg of raw.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') base.pop();
        else base.push(seg);
      }
      raw = base.join('/');
    }
    let key = raw.toLowerCase().replace(/^\/+/, '');
    if (key.endsWith('.md')) key = key.slice(0, -3);
    const hit = this.keys.get(key);
    if (hit === undefined) return { exists: false, attachment };
    return { exists: true, attachment, ...(hit ? { path: hit } : {}) };
  }
}

/** Run `fn` on body wikilinks (outside code), leaving `![[embeds]]` untouched. */
function rewriteBodyLinks(
  body: string,
  fn: (target: string, alias: string | undefined, escapedPipe: boolean) => string | undefined,
): string {
  // Hide the `[[` of every embed so the wikilink regex never sees it.
  const masked = body.replace(/!\[\[/g, '!\u0000\u0001');
  return replaceWikilinks(masked, fn).replace(/!\u0000\u0001/g, '![[');
}

function plainText(target: string, alias: string | undefined): string {
  if (alias && alias.trim()) return alias.trim();
  const [p, heading] = target.split('#');
  const base = p.replace(/\.md$/i, '').split('/').pop() || p;
  return heading ? `${base} > ${heading}` : base;
}

const LINK_IN_STRING = /^\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/;

// ---------------------------------------------------------------------------
// hook-echoes
// ---------------------------------------------------------------------------

function isCapture(note: HygieneNote, opts: HygieneOptions): boolean {
  const d = note.data ?? {};
  const tags = noteTags(note).map(String);
  return tags.includes('auto-capture') || tags.includes('trigger-capture') || isMachineSource(d.source, opts.machineSourcePatterns);
}

export function cmdHookEchoes(model: VaultModel, opts: HygieneOptions): void {
  const hits: Array<[string, string]> = [];
  for (const note of model.active()) {
    if (!inScope(note.path, opts) || !note.data) continue;
    if (!/^(Memories|EmailLog)\//.test(note.path)) continue;
    if (!isCapture(note, opts)) continue;
    const kind = classifyEcho({
      title: noteTitle(note),
      content: note.body.replace(/^\s+/, ''),
      source: note.data.source,
      tags: noteTags(note).map(String),
    });
    if (kind) hits.push([note.path, kind]);
  }
  for (const [p, kind] of hits) model.archive('hook-echoes', p, `hook echo: ${kind}`);
}

// ---------------------------------------------------------------------------
// junk-projects
// ---------------------------------------------------------------------------

export function diarySlugsOf(model: VaultModel): Set<string> {
  const out = new Set<string>();
  for (const note of model.notes.values()) {
    if (!isDiaryPath(note.path)) continue;
    for (const s of diaryProjectSlugs(note.body)) out.add(s);
  }
  return out;
}

export function cmdJunkProjects(model: VaultModel, opts: HygieneOptions): void {
  const diarySlugs = diarySlugsOf(model);
  // Merge targets: non-project notes keyed by the slug of their basename/title.
  const bySlug = new Map<string, string | null>();
  for (const note of model.active()) {
    if (/^Projects\//i.test(note.path) || isDiaryPath(note.path)) continue;
    if (/^(Memories|EmailLog|Journal|Ops\/Agent Diaries)\//.test(note.path)) continue;
    const base = note.path.replace(/\.md$/i, '').split('/').pop() ?? '';
    for (const s of new Set([projectSlug(base), projectSlug(noteTitle(note))])) {
      if (!s) continue;
      const prev = bySlug.get(s);
      if (prev === undefined) bySlug.set(s, note.path);
      else if (prev !== note.path) {
        // Prefer a CRM entity when names collide; otherwise ambiguous.
        const crm = [prev, note.path].filter((p) => p && /CRM\//.test(p));
        bySlug.set(s, crm.length === 1 ? crm[0] : null);
      }
    }
  }

  const projects = [...model.active()].filter((n) => /^Projects\/[^/]+\.md$/i.test(n.path) && inScope(n.path, opts));
  for (const note of projects) {
    const d = note.data ?? {};
    const base = note.path.replace(/\.md$/i, '').split('/').pop() ?? '';
    const title = noteTitle(note);
    const slugs = new Set([projectSlug(base), projectSlug(title)]);
    const confirmedByDiary = [...slugs].some((s) => diarySlugs.has(s));
    if (confirmedByDiary) continue;
    if (d.auto_reconciled !== true) {
      // Human/curated or diary-stub note: never touched; reported only when
      // it would fail the strict registry guard.
      if (d.type !== 'project' || isImplausibleProjectName(title)) {
        model.record('junk-projects', note.path, 'report-only', { reason: 'curated note, not a registry project (left untouched)' });
      }
      continue;
    }
    const reason = isImplausibleProjectName(title) || isImplausibleProjectName(base)
      ? 'implausible name (filename / dated slug / email / tag pair)'
      : 'auto-reconciled, not linked by any agent diary';
    const target = [...slugs].map((s) => bySlug.get(s)).find((p): p is string => typeof p === 'string');
    if (target) {
      const t = model.notes.get(target)!;
      const marker = `<!-- vault-hygiene:merged ${note.path} -->`;
      if (!t.body.includes(marker)) {
        const content = note.body.replace(/^\s*#\s+.*(?:\r?\n)+/, '').trim();
        t.body = `${t.body.replace(/\s*$/, '')}\n\n## Merged from ${note.path.replace(/\.md$/i, '')} (vault-hygiene)\n${marker}\n\n${content || '(empty)'}\n`;
        model.record('junk-projects', target, 'merge-in', { from: note.path });
      }
      model.archive('junk-projects', note.path, `${reason}; content merged into ${target}`);
    } else {
      model.archive('junk-projects', note.path, reason);
    }
  }
}

// ---------------------------------------------------------------------------
// digests
// ---------------------------------------------------------------------------

export function cmdDigests(model: VaultModel, opts: HygieneOptions): void {
  const links = new LinkIndex(model.allPaths());
  for (const note of model.active()) {
    if (!/^Memories\/consolidated\//i.test(note.path) || !inScope(note.path, opts) || !note.data) continue;
    // consolidated/sources/** holds archived source copies, not digests.
    if (/^Memories\/consolidated\/sources\//i.test(note.path)) continue;
    const d = note.data;
    const tags = noteTags(note).map(String);
    const isDigest = /^Memories\/consolidated\/[^/]+\.md$/i.test(note.path)
      || 'consolidated_from' in d || 'series_tag' in d || d.auto_consolidated === true
      || tags.some((t) => t.startsWith('consolidated')) || d.type === 'digest';
    if (!isDigest) continue;

    const changed: string[] = [];
    if (setData(note, 'type', 'digest')) changed.push('type');
    if (setData(note, 'importance', 'low')) changed.push('importance');
    if (setData(note, 'temperature', 'cold')) changed.push('temperature');
    if (setData(note, 'heat_score', 0)) changed.push('heat_score');

    const from: string[] = Array.isArray(d.consolidated_from) ? d.consolidated_from.map(String) : [];
    const fromSet = new Set(from);
    let stripped = 0;
    note.body = rewriteBodyLinks(note.body, (target, alias) => {
      const r = links.resolve(target, note.path);
      const p = r.path ?? target.split('#')[0].trim();
      const isSource = /^(Memories|EmailLog)\//i.test(p) || fromSet.has(p) || fromSet.has(`${p}.md`);
      if (!isSource) return undefined;
      const full = /\.md$/i.test(p) ? p : `${p}.md`;
      if (!fromSet.has(full) && !fromSet.has(p)) { fromSet.add(full); from.push(full); }
      stripped++;
      return plainText(target, alias);
    });
    if (stripped > 0) {
      setData(note, 'consolidated_from', from);
      changed.push(`stripped ${stripped} source links`);
    }
    if (changed.length > 0) model.record('digests', note.path, 're-frontmatter', changed);
  }
}

// ---------------------------------------------------------------------------
// auto-related
// ---------------------------------------------------------------------------

export function cmdAutoRelated(model: VaultModel, opts: HygieneOptions): void {
  const links = new LinkIndex(model.allPaths());
  const lowValue = (target: string, source: string): boolean => {
    const r = links.resolve(target, source);
    if (!r.path) {
      // Unresolved: classify by the path itself.
      return isDigestNote({ path: target }) || isEmailNote({ path: target });
    }
    const t = model.notes.get(r.path);
    if (!t) return false;
    return isLowValueLinkTarget(noteLike(t));
  };

  for (const note of model.active()) {
    if (!inScope(note.path, opts)) continue;
    let removed = 0;
    if (/^#{2,4}\s+Related \(auto\)\s*$/m.test(note.body)) {
      const lines = note.body.split('\n');
      const out: string[] = [];
      let inSection = false;
      let headerIdx = -1;
      let kept = 0;
      for (const line of lines) {
        const h = /^(#{1,6})\s+(.*)$/.exec(line.replace(/\r$/, ''));
        if (h) {
          if (inSection && kept === 0 && headerIdx >= 0) out.splice(headerIdx); // drop empty section
          inSection = /^Related \(auto\)\s*$/.test(h[2]);
          headerIdx = inSection ? out.length : -1;
          kept = 0;
          out.push(line);
          continue;
        }
        if (inSection) {
          const m = /^\s*[-*]\s+\[\[([^\]|#]+)[^\]]*\]\]\s*\r?$/.exec(line);
          if (m && lowValue(m[1], note.path)) { removed++; continue; }
          if (line.trim()) kept++;
        }
        out.push(line);
      }
      if (inSection && kept === 0 && headerIdx >= 0) {
        out.splice(headerIdx);
        while (out.length && !out[out.length - 1].trim()) out.pop();
        out.push('');
      }
      if (removed > 0) note.body = out.join('\n');
    }
    const ar = note.data?.auto_related;
    if (Array.isArray(ar)) {
      const keep = ar.filter((v) => {
        const m = LINK_IN_STRING.exec(String(v));
        return !(m && lowValue(m[1], note.path));
      });
      if (keep.length !== ar.length) {
        removed += ar.length - keep.length;
        setData(note, 'auto_related', keep.length > 0 ? keep : undefined);
      }
    }
    if (removed > 0) model.record('auto-related', note.path, 'strip-auto-links', { removed });
  }
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

const GMAIL_SYSTEM_LABEL = /^(INBOX|UNREAD|IMPORTANT|STARRED|SENT|SPAM|TRASH|DRAFT|CATEGORY_[A-Z]+)$/;

export function normaliseTags(note: HygieneNote): { changed: boolean; actions: string[] } {
  const d = note.data;
  if (!d || d.tags === undefined || d.tags === null) return { changed: false, actions: [] };
  const raw = noteTags(note);
  const actions = new Set<string>();
  const gmailIds: string[] = [];
  const labels: string[] = [];
  const out: string[] = [];
  const source = typeof d.source === 'string' ? d.source.replace(/:\s+/g, ':').trim() : undefined;
  let newSource: string | undefined;

  for (const t of raw) {
    if (t === null || t === undefined) { actions.add('drop-empty'); continue; }
    if (typeof t === 'object') { actions.add('drop-non-scalar'); continue; }
    if (typeof t !== 'string') actions.add('coerce-scalar');
    let s = String(t).trim().replace(/^#+/, '');
    if (!s) { actions.add('drop-empty'); continue; }
    const msg = /^msg:\s*(\S+)$/i.exec(s);
    if (msg) { gmailIds.push(msg[1]); actions.add('msg→gmail_id'); continue; }
    if (/^\d+:\s*\S/.test(s) || GMAIL_SYSTEM_LABEL.test(s)) { labels.push(s.replace(/:\s*/, ': ')); actions.add('gmail-label→email_label'); continue; }
    const kv = /^([A-Za-z][\w-]*):\s+(\S.*)$/.exec(s);
    if (kv) { s = `${kv[1]}:${kv[2]}`; actions.add('unspace'); }
    const src = /^source:(.+)$/.exec(s);
    if (src) {
      const value = src[1].replace(/:\s+/g, ':').trim();
      if (source !== undefined && value === source) { actions.add('drop-duplicate-source'); continue; }
      if (source === undefined && newSource === undefined) { newSource = value; actions.add('source-tag→source'); continue; }
    }
    out.push(s);
  }
  const deduped = [...new Set(out)];
  if (deduped.length !== out.length) actions.add('dedupe');
  if (actions.size === 0) return { changed: false, actions: [] };

  setData(note, 'tags', deduped);
  if (gmailIds.length > 0) {
    const prev = d.gmail_id === undefined ? [] : Array.isArray(d.gmail_id) ? d.gmail_id.map(String) : [String(d.gmail_id)];
    const all = [...new Set([...prev, ...gmailIds])];
    setData(note, 'gmail_id', all.length === 1 ? all[0] : all);
  }
  if (labels.length > 0) {
    const prev = Array.isArray(d.email_label) ? d.email_label.map(String) : d.email_label ? [String(d.email_label)] : [];
    setData(note, 'email_label', [...new Set([...prev, ...labels])]);
  }
  if (newSource !== undefined) setData(note, 'source', newSource);
  return { changed: true, actions: [...actions] };
}

export function cmdTags(model: VaultModel, opts: HygieneOptions): void {
  for (const note of model.active()) {
    if (!inScope(note.path, opts)) continue;
    const r = normaliseTags(note);
    if (r.changed) model.record('tags', note.path, 'normalise-tags', r.actions);
  }
}

// ---------------------------------------------------------------------------
// reheat
// ---------------------------------------------------------------------------

const KNOWLEDGE_CATEGORIES = new Set(['decision', 'fact', 'insight', 'preference', 'plan']);

function temperatureFor(heat: number): 'hot' | 'warm' | 'cold' {
  return heat >= 10 ? 'hot' : heat >= 4 ? 'warm' : 'cold';
}

export interface ReheatFix {
  from: { temperature?: unknown; heat_score?: unknown };
  to: { temperature: string; heat_score: number };
  rule: string;
}

/** The corrected temperature/heat for a note, or undefined when consistent. */
export function reheatFix(note: HygieneNote, opts: HygieneOptions = {}): ReheatFix | undefined {
  const d = note.data;
  if (!d || (d.heat_score === undefined && d.temperature === undefined)) return undefined;
  const raw = Number(d.heat_score);
  let heat = Number.isFinite(raw) ? raw : 0;
  const rules: string[] = [];
  if (heat > 10) { heat = Math.round(heat / 10); rules.push('rescale 0-100 fossil'); }
  const like = noteLike(note);
  const lowValue = isDigestNote(like) || isEmailNote(like)
    || (noteTags(note).map(String).includes('auto-capture') && (d.importance === 'low' || d.importance === undefined))
    || (isMachineSource(d.source, opts.machineSourcePatterns) && d.importance !== 'high');
  const important = (d.importance === 'high' || d.importance === 'critical') && KNOWLEDGE_CATEGORIES.has(String(d.category));
  // Conflicting signals (a high-importance decision filed as an email capture)
  // are left alone: neither capped nor floored.
  if (lowValue && !important && heat > 2) { heat = 2; rules.push('machine/email/digest capped at 2'); }
  else if (important && !lowValue && heat < 4) { heat = 5; rules.push('high-importance knowledge floored at warm 5'); }
  const temperature = temperatureFor(heat);
  if (temperature !== d.temperature) rules.push('temperature matches heat');
  const heatUnchanged = Number.isFinite(raw) ? heat === raw : heat === 0;
  if (heatUnchanged && temperature === d.temperature) return undefined;
  if (rules.length === 0) rules.push('heat_score normalised');
  return { from: { temperature: d.temperature, heat_score: d.heat_score }, to: { temperature, heat_score: heat }, rule: rules.join('; ') };
}

export function cmdReheat(model: VaultModel, opts: HygieneOptions): void {
  for (const note of model.active()) {
    if (!inScope(note.path, opts)) continue;
    const fix = reheatFix(note, opts);
    if (!fix) continue;
    if (note.data?.heat_score !== undefined || fix.to.heat_score !== 0) setData(note, 'heat_score', fix.to.heat_score);
    setData(note, 'temperature', fix.to.temperature);
    model.record('reheat', note.path, 'reheat', fix);
  }
}

// ---------------------------------------------------------------------------
// broken-links
// ---------------------------------------------------------------------------

const DIARY_ENTITY_LINK = /\[\[(Projects|Machines)\/([^\]|#]+?)(?:\.md)?(?:[|#][^\]]*)?\]\]/g;

/**
 * Agent diaries link `[[Projects/<slug>]] @ [[Machines/<host>]]` on every
 * line, but nothing created those notes. Create the missing MOC stubs (the
 * same template the diary write path now uses) so those links resolve instead
 * of being unlinked as broken.
 */
export function createDiaryEntityStubs(model: VaultModel, today: string): void {
  const links = new LinkIndex(model.allPaths());
  const wanted = new Map<string, [EntityStubKind, string]>();
  for (const note of model.notes.values()) {
    if (!isDiaryPath(note.path)) continue;
    for (const m of note.body.matchAll(DIARY_ENTITY_LINK)) {
      const name = m[2].trim();
      if (!isSafeStubName(name)) continue;
      const kind: EntityStubKind = m[1] === 'Projects' ? 'project' : 'machine';
      const path = entityStubPath(kind, name);
      if (!wanted.has(path.toLowerCase()) && !links.resolve(`${m[1]}/${name}`).exists) {
        wanted.set(path.toLowerCase(), [kind, name]);
      }
    }
  }
  for (const [kind, name] of wanted.values()) {
    model.create('broken-links', entityStubPath(kind, name), renderEntityStub(kind, name, today), `diary-linked ${kind} stub`);
  }
}

export function cmdBrokenLinks(model: VaultModel, opts: HygieneOptions): void {
  // Only when the diaries themselves are in scope.
  if (inScope('Ops/Agent Diaries/x/2000-01-01.md', opts)) {
    createDiaryEntityStubs(model, opts.today ?? new Date().toISOString().slice(0, 10));
  }
  const links = new LinkIndex(model.allPaths());
  for (const note of model.active()) {
    if (!inScope(note.path, opts)) continue;
    const digest = isDigestNote(noteLike(note));
    const fromAdd: string[] = [];
    let rewritten = 0;
    note.body = rewriteBodyLinks(note.body, (target, alias) => {
      const r = links.resolve(target, note.path);
      if (r.exists || r.attachment) return undefined;
      rewritten++;
      if (digest) {
        const p = target.split('#')[0].trim();
        if (p.includes('/')) fromAdd.push(/\.md$/i.test(p) ? p : `${p}.md`);
      }
      return plainText(target, alias);
    });
    let fmDropped = 0;
    for (const key of ['related', 'auto_related']) {
      const arr = note.data?.[key];
      if (!Array.isArray(arr)) continue;
      const keep = arr.filter((v) => {
        const m = LINK_IN_STRING.exec(String(v));
        if (!m) return true;
        const r = links.resolve(m[1], note.path);
        return r.exists || r.attachment;
      });
      if (keep.length !== arr.length) {
        fmDropped += arr.length - keep.length;
        setData(note, key, keep.length > 0 ? keep : undefined);
      }
    }
    if (fromAdd.length > 0 && note.data) {
      const prev: string[] = Array.isArray(note.data.consolidated_from) ? note.data.consolidated_from.map(String) : [];
      setData(note, 'consolidated_from', [...new Set([...prev, ...fromAdd])]);
    }
    if (rewritten > 0 || fmDropped > 0) {
      model.record('broken-links', note.path, 'unlink-broken', { body: rewritten, frontmatter: fmDropped, ...(fromAdd.length ? { consolidated_from: fromAdd.length } : {}) });
    }
  }
}

// ---------------------------------------------------------------------------

const RUNNERS: Record<HygieneCommand, (m: VaultModel, o: HygieneOptions) => void> = {
  'hook-echoes': cmdHookEchoes,
  'junk-projects': cmdJunkProjects,
  digests: cmdDigests,
  'auto-related': cmdAutoRelated,
  tags: cmdTags,
  reheat: cmdReheat,
  'broken-links': cmdBrokenLinks,
};

/**
 * Run sub-commands in the canonical order (archives first, broken-links last
 * so it sees links left dangling by the moves). `all` runs every command.
 */
export function runHygiene(model: VaultModel, commands: Array<HygieneCommand | 'all'>, opts: HygieneOptions = {}): void {
  const wanted = commands.includes('all') ? [...HYGIENE_COMMANDS] : HYGIENE_COMMANDS.filter((c) => commands.includes(c));
  for (const c of wanted) RUNNERS[c](model, opts);
}
