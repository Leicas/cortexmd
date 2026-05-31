import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { glob } from 'glob';
import { config } from '../../config.js';
import { getCodeDb } from './db.js';

const execFileAsync = promisify(execFile);

export interface CodeRepo {
  id: string;
  slug: string;
  absolutePath: string;
}

export interface RepoRow {
  id: string;
  slug: string;
  git_origin: string | null;
  first_commit_sha: string;
  created_at: number;
}

/** The machine identifier used to scope repo→path mappings. */
export function getMachineId(): string {
  return process.env.MACHINE_ID || os.hostname();
}

/** Run git in `cwd` and return stdout (trimmed). */
async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.toString();
}

/** Synchronous git probe used at startup. */
export function probeGit(): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execFileSync('git', ['--version'], { windowsHide: true }).toString().trim();
    return { ok: true, version: out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Return the first commit SHA on HEAD. Throws if the repo has no commits.
 * `git rev-list --max-parents=0 HEAD` may return multiple lines for grafted /
 * octopus-merged history — we take the first.
 */
export async function firstCommitSha(absRepoPath: string): Promise<string> {
  const out = await runGit(absRepoPath, ['rev-list', '--max-parents=0', 'HEAD']);
  const first = out.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) throw new Error('repo has no commits');
  return first;
}

/** Return the origin URL or null if none configured. */
export async function gitOrigin(absRepoPath: string): Promise<string | null> {
  try {
    const out = await runGit(absRepoPath, ['config', '--get', 'remote.origin.url']);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Fetch a repo row by slug. Returns null when not registered. */
export function resolveRepoBySlug(slug: string): RepoRow | null {
  const db = getCodeDb();
  const row = db.prepare(`SELECT * FROM repos WHERE slug=?`).get(slug) as RepoRow | undefined;
  return row ?? null;
}

/** Fetch a repo row by id. Returns null when not registered. */
export function resolveRepoById(id: string): RepoRow | null {
  const db = getCodeDb();
  const row = db.prepare(`SELECT * FROM repos WHERE id=?`).get(id) as RepoRow | undefined;
  return row ?? null;
}

/**
 * Look up the absolute path for `repoId` on the current machine.
 * Returns null if the repo isn't registered locally (e.g. registered on
 * another machine and synced via the vault registry, but never `code_repo_register`d here).
 */
export function getRepoPathOnMachine(repoId: string): string | null {
  const db = getCodeDb();
  const row = db
    .prepare(`SELECT abs_path FROM repo_paths WHERE repo_id=? AND machine_id=?`)
    .get(repoId, getMachineId()) as { abs_path: string } | undefined;
  return row?.abs_path ?? null;
}

/** Resolve a slug to a full repo (with abs path on this machine). Throws if unknown / not on this machine. */
export function resolveRepoFull(slug: string): CodeRepo {
  const row = resolveRepoBySlug(slug);
  if (!row) {
    throw new Error(`Unknown code repo "${slug}". Register with code_repo_register.`);
  }
  const abs = getRepoPathOnMachine(row.id);
  if (!abs) {
    throw new Error(
      `Repo "${slug}" is registered but has no path on this machine. Register a local checkout with code_repo_register.`,
    );
  }
  return { id: row.id, slug: row.slug, absolutePath: abs };
}

const SUPPORTED_EXTS_DEFAULT = ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go'];
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', 'build', 'out',
  'target', '__pycache__', 'venv', '.venv', 'vendor',
]);

/** Subset of supported extensions allowed via env-config. */
function allowedExts(): string[] {
  const cfg = config.codeNavLangs as readonly string[];
  if (!cfg || cfg.length === 0) return SUPPORTED_EXTS_DEFAULT;
  return cfg.map((s) => s.replace(/^\./, '').toLowerCase()).filter(Boolean);
}

/**
 * Walk a repo path standalone (no config dependency). Used by the CLI indexer.
 * Returns relative paths (POSIX-style) for all source files.
 */
export async function walkRepoStandalone(opts: {
  absolutePath: string;
  langs?: readonly string[];
  denied?: readonly string[];
}): Promise<string[]> {
  const repoRoot = path.resolve(opts.absolutePath);
  const ignore = Array.from(SKIP_DIRS).flatMap((d) => [`${d}/**`, `**/${d}/**`]);
  const exts = (() => {
    const langs = opts.langs;
    if (!langs || langs.length === 0) return SUPPORTED_EXTS_DEFAULT;
    return langs.map((s) => s.replace(/^\./, '').toLowerCase()).filter(Boolean);
  })();
  const pattern = `**/*.{${exts.join(',')}}`;

  const matches = await glob(pattern, {
    cwd: repoRoot,
    nodir: true,
    dot: false,
    ignore,
    posix: true,
  });

  const out: string[] = [];
  const denied = opts.denied ?? ['.obsidian', '.sync', '.trash'];
  for (const rel of matches) {
    const ext = path.extname(rel).toLowerCase().replace(/^\./, '');
    if (!exts.includes(ext)) continue;

    const segments = rel.split(/[\\/]/);
    if (segments.some((seg) => denied.includes(seg))) continue;
    if (segments.some((seg) => SKIP_DIRS.has(seg))) continue;

    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(repoRoot + path.sep) && abs !== repoRoot) continue;

    out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

/**
 * Walk a repo and return relative paths (POSIX-style) for all source files.
 * Filters by extension, skips standard build/vendor directories, rejects
 * vault-denied segments, verifies paths stay inside the repo root.
 */
export async function walkRepo(repo: CodeRepo): Promise<string[]> {
  return walkRepoStandalone({
    absolutePath: repo.absolutePath,
    langs: allowedExts(),
    denied: config.deniedSegments as readonly string[],
  });
}

/** Map a file extension to a tree-sitter language tag. */
export function languageForPath(
  relPath: string,
): 'typescript' | 'tsx' | 'javascript' | 'python' | 'rust' | 'go' | null {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.go') return 'go';
  return null;
}
