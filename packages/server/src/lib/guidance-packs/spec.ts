/**
 * Pack declarations: parsing (GUIDANCE_PACKS env, runtime registry) and the
 * validation that decides what the server is allowed to fetch.
 *
 * Trust model:
 *   - `env` specs are written by the operator: any absolute local directory
 *     and `file://` git remotes are accepted.
 *   - `registry` specs arrive through the admin REST endpoint / dashboard /
 *     CLI: only HTTPS git URLs on an allowlisted host (GUIDANCE_PACK_HOSTS,
 *     default `github.com`), or local directories under GUIDANCE_PACK_LOCAL_ROOTS
 *     (default: none), are accepted.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFile } from '../atomic-write.js';
import { PackError, type PackSpec, type SyncCaps } from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const URL_PATH_RE = /^\/[A-Za-z0-9._~/-]+$/;
export const MAX_PACKS = 16;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Directory holding every pack (outside the vault). */
export function packsRoot(): string {
  return process.env.GUIDANCE_PACKS_DIR || path.join(config.dataDir, 'packs');
}

export function allowedHosts(): string[] {
  return envList('GUIDANCE_PACK_HOSTS', ['github.com']).map((h) => h.toLowerCase());
}

export function allowedLocalRoots(): string[] {
  return envList('GUIDANCE_PACK_LOCAL_ROOTS', []).map((r) => path.resolve(r));
}

export function syncCaps(): SyncCaps {
  return {
    maxFiles: envInt('GUIDANCE_PACK_MAX_FILES', 2000),
    maxBytes: envInt('GUIDANCE_PACK_MAX_BYTES', 32 * 1024 * 1024),
    maxFileBytes: envInt('GUIDANCE_PACK_MAX_FILE_BYTES', 1024 * 1024),
    maxRepoBytes: envInt('GUIDANCE_PACK_MAX_REPO_BYTES', 256 * 1024 * 1024),
    gitTimeoutMs: envInt('GUIDANCE_PACK_GIT_TIMEOUT_MS', 120_000),
  };
}

/** Runtime add/remove through REST/dashboard/CLI. `GUIDANCE_PACKS_ADMIN=off` makes packs env-only. */
export function adminEnabled(): boolean {
  return (process.env.GUIDANCE_PACKS_ADMIN ?? 'on').toLowerCase().trim() !== 'off';
}

export type SourceKind = { kind: 'git'; url: string; fileProtocol: boolean } | { kind: 'local'; dir: string };

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Classify + validate a source string. Throws PackError on anything not allowed. */
export function resolveSource(source: string, trusted: boolean): SourceKind {
  const s = String(source ?? '').trim();
  if (!s || s.length > 500 || /[\0\r\n]/.test(s)) throw new PackError('bad_source', 'source is empty or malformed');
  if (s.startsWith('-')) throw new PackError('bad_source', 'source must not start with "-"');

  if (/^https:\/\//i.test(s)) {
    // Checked on the raw string: the URL parser would silently normalise `..` away.
    if (s.includes('..') || s.includes('\\')) throw new PackError('bad_source', 'URL path contains unsupported characters');
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new PackError('bad_source', 'source is not a valid URL');
    }
    if (u.protocol !== 'https:') throw new PackError('bad_source', 'only https:// git URLs are accepted');
    if (u.username || u.password) throw new PackError('bad_source', 'credentials in the URL are not accepted');
    if (u.port) throw new PackError('bad_source', 'a custom port is not accepted');
    if (u.search || u.hash) throw new PackError('bad_source', 'query strings and fragments are not accepted');
    const host = u.hostname.toLowerCase();
    if (!allowedHosts().includes(host)) {
      throw new PackError(
        'host_not_allowed',
        `host "${host}" is not in GUIDANCE_PACK_HOSTS (${allowedHosts().join(', ') || 'empty'})`,
        403,
      );
    }
    if (!URL_PATH_RE.test(u.pathname) || u.pathname.includes('..') || u.pathname.includes('//')) {
      throw new PackError('bad_source', 'URL path contains unsupported characters');
    }
    return { kind: 'git', url: `https://${host}${u.pathname}`, fileProtocol: false };
  }

  if (/^file:\/\//i.test(s)) {
    if (!trusted) throw new PackError('bad_source', 'file:// git remotes can only be declared in GUIDANCE_PACKS', 403);
    return { kind: 'git', url: s, fileProtocol: true };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s) || s.includes('::')) {
    throw new PackError('bad_source', 'only https:// git URLs or absolute local directories are accepted');
  }

  if (!path.isAbsolute(s)) throw new PackError('bad_source', 'a local source must be an absolute directory path');
  const dir = path.resolve(s);
  if (!trusted) {
    const roots = allowedLocalRoots();
    if (!roots.some((r) => isUnder(dir, r))) {
      throw new PackError('local_not_allowed', 'local directory is not under GUIDANCE_PACK_LOCAL_ROOTS', 403);
    }
  }
  return { kind: 'local', dir };
}

function parseRefresh(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '' || raw === 'off' || raw === false) return undefined;
  if (typeof raw === 'number') return raw >= 1 ? Math.floor(raw) : undefined;
  const m = /^(\d+)\s*(h|d|w)?$/i.exec(String(raw).trim());
  if (!m) throw new PackError('bad_refresh', 'refresh must be "off", "<n>h", "<n>d" or "<n>w"');
  const n = Number(m[1]) * ({ h: 1, d: 24, w: 168 }[(m[2] ?? 'h').toLowerCase()] ?? 1);
  return n >= 1 ? n : undefined;
}

/** Normalise + validate one declaration. */
export function validateSpec(input: unknown, origin: 'env' | 'registry'): PackSpec {
  if (!input || typeof input !== 'object') throw new PackError('bad_spec', 'pack spec must be an object');
  const o = input as Record<string, unknown>;
  const name = String(o.name ?? '').trim().toLowerCase();
  if (!NAME_RE.test(name) || name.includes('..')) {
    throw new PackError('bad_name', 'pack name must match [a-z0-9][a-z0-9._-]{0,63}');
  }
  const source = String(o.source ?? o.url ?? o.path ?? '').trim();
  resolveSource(source, origin === 'env');

  const spec: PackSpec = { name, source, origin };
  if (o.ref !== undefined && o.ref !== null && o.ref !== '') {
    const ref = String(o.ref).trim();
    if (!REF_RE.test(ref) || ref.includes('..') || ref.endsWith('.lock')) throw new PackError('bad_ref', 'ref contains unsupported characters');
    spec.ref = ref;
  }
  if (o.commit !== undefined && o.commit !== null && o.commit !== '') {
    const commit = String(o.commit).trim().toLowerCase();
    if (!COMMIT_RE.test(commit)) throw new PackError('bad_commit', 'commit must be a full 40/64-hex sha');
    spec.commit = commit;
  }
  if (o.include !== undefined && o.include !== null) {
    const list = Array.isArray(o.include) ? o.include : String(o.include).split(',');
    const include = list.map((g) => String(g).trim().replace(/\\/g, '/').replace(/^\.?\//, '')).filter(Boolean);
    if (include.length > 32) throw new PackError('bad_include', 'at most 32 include globs');
    for (const g of include) {
      if (g.length > 200 || g.includes('..') || /[\0\r\n]/.test(g)) throw new PackError('bad_include', `bad include glob "${g.slice(0, 40)}"`);
    }
    if (include.length > 0) spec.include = include;
  }
  const refresh = parseRefresh(o.refreshHours ?? o.refresh);
  if (refresh) spec.refreshHours = refresh;
  if (o.adapter !== undefined && o.adapter !== null && o.adapter !== '') {
    const adapter = String(o.adapter).trim();
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(adapter)) throw new PackError('bad_adapter', 'bad adapter name');
    spec.adapter = adapter;
  }
  return spec;
}

/**
 * GUIDANCE_PACKS: a JSON array of specs, or the shorthand
 * `name=source[#ref]` entries separated by `;` or newlines.
 * Invalid entries are reported, never fatal (boot must not fail on them).
 */
export function parsePacksEnv(raw: string | undefined): { specs: PackSpec[]; errors: string[] } {
  const specs: PackSpec[] = [];
  const errors: string[] = [];
  const text = (raw ?? '').trim();
  if (!text) return { specs, errors };
  let items: unknown[] = [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      return { specs, errors: [`GUIDANCE_PACKS is not valid JSON: ${(e as Error).message}`] };
    }
  } else {
    for (const part of text.split(/[;\n]+/)) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf('=');
      if (eq <= 0) {
        errors.push(`GUIDANCE_PACKS entry "${p.slice(0, 60)}" is not name=source`);
        continue;
      }
      let source = p.slice(eq + 1).trim();
      let ref: string | undefined;
      const hash = source.lastIndexOf('#');
      if (hash > 0) {
        ref = source.slice(hash + 1);
        source = source.slice(0, hash);
      }
      items.push({ name: p.slice(0, eq).trim(), source, ...(ref ? (/^[0-9a-f]{40}$/i.test(ref) ? { commit: ref } : { ref }) : {}) });
    }
  }
  const seen = new Set<string>();
  for (const item of items) {
    try {
      const spec = validateSpec(item, 'env');
      if (seen.has(spec.name)) throw new PackError('duplicate', `duplicate pack "${spec.name}"`);
      seen.add(spec.name);
      specs.push(spec);
    } catch (e) {
      errors.push(`GUIDANCE_PACKS: ${(e as Error).message}`);
    }
  }
  return { specs: specs.slice(0, MAX_PACKS), errors };
}

function registryPath(root: string): string {
  return path.join(root, 'packs.json');
}

/** Specs added at runtime (admin endpoint). Re-validated on every read. */
export async function readRegistry(root = packsRoot()): Promise<PackSpec[]> {
  let raw: string;
  try {
    raw = await fs.readFile(registryPath(root), 'utf8');
  } catch {
    return [];
  }
  const out: PackSpec[] = [];
  try {
    const parsed = JSON.parse(raw) as { packs?: unknown[] };
    for (const item of parsed.packs ?? []) {
      try {
        out.push(validateSpec(item, 'registry'));
      } catch {
        // A spec that no longer passes validation (allowlist tightened) is ignored.
      }
    }
  } catch {
    return [];
  }
  return out;
}

export async function writeRegistry(specs: PackSpec[], root = packsRoot()): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const packs = specs.map(({ origin: _origin, ...rest }) => rest);
  await atomicWriteFile(registryPath(root), JSON.stringify({ packs }, null, 2) + '\n');
}

/** Every declared pack: env first (wins on a name clash), then the registry. */
export async function declaredSpecs(root = packsRoot()): Promise<PackSpec[]> {
  const env = parsePacksEnv(process.env.GUIDANCE_PACKS).specs;
  const names = new Set(env.map((s) => s.name));
  const reg = (await readRegistry(root)).filter((s) => !names.has(s.name));
  return [...env, ...reg].slice(0, MAX_PACKS);
}

/** Tiny glob matcher for include patterns: `**`, `*`, `?`; a bare directory matches its subtree. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  g = re;
  return new RegExp(`^${g}(?:/.*)?$`);
}
