/**
 * Pure classification rules shared by the ingest path (capture-filter,
 * store-memory-api, auto-link) and the `vault_hygiene` maintenance tool/CLI.
 *
 * This module must stay dependency-free (no config.ts, no search index): the
 * hygiene CLI runs it against an arbitrary vault directory without booting the
 * server. Callers that honour runtime config pass their configured pattern
 * lists in explicitly.
 */

// ---------------------------------------------------------------------------
// Machine vs deliberate capture sources
// ---------------------------------------------------------------------------

/**
 * `source` values that mark a capture as machine exhaust (n8n triage, email
 * pipelines, Claude Code / Codex hooks). Case-insensitive regex sources.
 * MACHINE_CAPTURE_SOURCES (config.machineCaptureSourcePatterns) replaces them.
 */
export const DEFAULT_MACHINE_SOURCE_PATTERNS: readonly string[] = [
  '^n8n\\b',
  '^(e-?mail|gmail|matrimail|emaillog)',
  '^hooks?(\\b|:|$)',
  '^(posttooluse|pretooluse|userpromptsubmit|precompact|stop)\\b',
  '^auto-?capture',
  '^trigger-capture',
];

const compiledCache = new Map<string, RegExp[]>();

/** Compile (and memoise) a list of regex sources; invalid entries are skipped. */
export function compilePatterns(sources: readonly string[], flags = 'i'): RegExp[] {
  const key = `${flags}\u0000${sources.join('\u0000')}`;
  const hit = compiledCache.get(key);
  if (hit) return hit;
  const out: RegExp[] = [];
  for (const s of sources) {
    try { out.push(new RegExp(s, flags)); } catch { /* skip invalid */ }
  }
  compiledCache.set(key, out);
  return out;
}

/**
 * True when `source` names a machine capture pipeline. An empty/undefined
 * pattern list means "use the defaults".
 */
export function isMachineSource(source: unknown, patterns?: readonly string[]): boolean {
  if (typeof source !== 'string' || !source.trim()) return false;
  const list = patterns && patterns.length > 0 ? patterns : DEFAULT_MACHINE_SOURCE_PATTERNS;
  const s = source.trim();
  return compilePatterns(list).some((re) => re.test(s));
}

// ---------------------------------------------------------------------------
// Hook echoes: shell commands, tool-result fragments, git commit echoes,
// prompt fragments
// ---------------------------------------------------------------------------

/**
 * Commands whose name is never an English sentence opener: a lowercase title
 * starting with one of these plus ≤3 tokens (or any shell syntax) is a command.
 */
const STRONG_COMMANDS = [
  'cd', 'ls', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsx', 'python', 'python3', 'pip', 'pip3', 'uv',
  'git', 'gh', 'docker', 'docker-compose', 'kubectl', 'helm', 'curl', 'wget', 'ssh', 'scp', 'rsync',
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'chmod', 'chown', 'sudo', 'systemctl', 'journalctl', 'crontab',
  'grep', 'rg', 'sed', 'awk', 'cargo', 'rustup', 'rtk', 'tsc', 'vitest', 'jest', 'pwsh', 'powershell',
  'taskkill', 'pkill', 'killall', 'df', 'du', 'tar', 'unzip', 'brew', 'apt', 'apt-get', 'winget',
  'choco', 'setx', 'whoami', 'nslookup', 'netstat', 'lsof', 'printenv', 'jq', 'xargs', 'wc', 'ln',
  'cortexmd', 'claude', 'codex', 'ollama', 'terraform', 'aws', 'gcloud', 'az', 'wsl', 'robocopy',
  'icacls', 'reg', 'sc', 'net', 'ipconfig', 'ifconfig', 'nmap', 'ps', 'top', 'htop', 'tmux',
];
/** English words that are also commands: only a command when shell syntax follows. */
const WEAK_COMMANDS = [
  'cat', 'echo', 'find', 'head', 'tail', 'sort', 'uniq', 'diff', 'make', 'touch', 'source', 'export',
  'set', 'start', 'open', 'code', 'kill', 'test', 'env', 'which', 'where', 'tee', 'ping', 'dig',
  'patch', 'stat', 'sleep', 'timeout', 'exit', 'type', 'more', 'less', 'watch', 'time',
];
const STRONG_SET = new Set(STRONG_COMMANDS);
const WEAK_SET = new Set(WEAK_COMMANDS);
/** Shell syntax that prose titles essentially never contain. */
const SHELL_SIGNAL = /(&&|\|\||\s\|\s|;\s|\s-{1,2}[A-Za-z][\w-]*|(^|\s)[.~]?\/[\w.-]|[A-Za-z]:[\\/]|\\\w|\s>{1,2}\s?\S|\s2>|\$\(|\$\{|\$[A-Z_]{2,}|=\S)/;

/** `label: ` prefix the PostToolUse hook prepends (`cortexmd: git add -A`). */
const LABEL_PREFIX = /^[\w.-]{1,40}:\s+/;

/**
 * True when `title` (optionally behind a `label: ` / `$ ` prefix) is a bare
 * shell command rather than prose. Conservative: requires a lowercase command
 * word and either shell syntax or a very short argument list.
 */
export function isBareCommand(title: string): boolean {
  let t = title.trim();
  const labelled = LABEL_PREFIX.exec(t);
  if (labelled) t = t.slice(labelled[0].length);
  t = t.replace(/^\$\s+/, '');
  const m = /^([a-z][a-z0-9-]*(?:\.exe)?)(?=\s|$)/.exec(t);
  if (!m) return false;
  const cmd = m[1].replace(/\.exe$/, '');
  const tokens = t.split(/\s+/).filter(Boolean);
  const hasSignal = SHELL_SIGNAL.test(` ${t}`);
  if (STRONG_SET.has(cmd)) {
    if (hasSignal) return true;
    // `git status`, `npm install`, `docker compose up`: ≤3 tokens, no prose.
    return tokens.length <= 3 && tokens.slice(1).every((tok) => /^[\w.:@/=+-]+$/.test(tok) && !/^(is|are|was|the|a|an|to|for|of|and|or|not|now|still|should|must|will)$/.test(tok));
  }
  if (WEAK_SET.has(cmd)) return hasSignal;
  return false;
}

/** Tool-output fragments that leaked into a title. */
export const TOOL_RESULT_TITLE_PATTERNS: readonly RegExp[] = [
  /<\/?(result|output|function_results|function_calls|tool_result|tool_use|stdout|stderr|system-reminder|antml:[a-z_]+|invoke|parameter)\b[^>]*>/i,
  /^\s*[{[]\s*"[\w-]+"\s*:/,                       // a JSON object/array dump
  /^\s*\d+\t/,                                       // `cat -n` / Read line-number prefix
  /^(Exit code:? \d+|exit status \d+)\b/i,
  /^Traceback \(most recent call last\)/,
  /^\s*at [\w.$<>]+ \(.*:\d+:\d+\)/,                 // JS stack frame
  /^(npm (ERR!|WARN)|error TS\d+:|warning: LF will be replaced)/,
  /^(On branch \S+|Your branch is (up to date|ahead|behind)|nothing to commit, working tree clean|Changes (not staged|to be committed))/,
];

/** Body patterns of commit echoes (`git commit:` captures and heredoc dumps). */
export const COMMIT_ECHO_CONTENT_PATTERNS: readonly RegExp[] = [
  /^\s*Made a commit with message:/,
  /git commit\b[^\n]*<<\s*['"]?EOF/,
  /\$\(cat <<\s*['"]?EOF/,
];

/** Titles of commit echoes. */
export const COMMIT_ECHO_TITLE_PATTERNS: readonly RegExp[] = [
  /^git commit\b/,
  /^[\w.-]{1,40}:\s+git commit\b/,
  /^Made a commit with message:/,
];

export interface CaptureLike {
  title: string;
  content?: string;
  source?: unknown;
  tags?: readonly unknown[];
}

/** Sources/tags of prompt-capture hooks (UserPromptSubmit trigger capture). */
function isPromptCapture(c: CaptureLike): boolean {
  if (typeof c.source === 'string' && /userpromptsubmit|trigger-capture/i.test(c.source)) return true;
  return (c.tags ?? []).some((t) => String(t) === 'trigger-capture');
}

/**
 * A prompt fragment: a UserPromptSubmit capture whose title is a lowercase,
 * mid-sentence slice of the prompt — either very short (`two badges`) or cut
 * off mid-word. Only prompt-capture sources are ever matched.
 */
export function isPromptFragment(c: CaptureLike): boolean {
  if (!isPromptCapture(c)) return false;
  const title = c.title.trim();
  if (!/^[a-z]/.test(title)) return false;
  if (/[.!?:]$/.test(title)) return false;
  const words = title.split(/\s+/).filter(Boolean).length;
  if (words <= 4) return true;
  const body = (c.content ?? '').replace(/^#\s+.*\n+/, '').trim();
  // Truncated mid-word: the body continues the title with a letter.
  if (body.startsWith(title) && body.length > title.length && /[A-Za-z0-9]/.test(body[title.length])) return true;
  return false;
}

export type EchoKind = 'shell-command' | 'tool-result' | 'git-commit-echo' | 'prompt-fragment';

/**
 * Classify a capture as a hook echo, or undefined when it looks like a real
 * memory. `content` is the note body (title heading allowed).
 */
export function classifyEcho(c: CaptureLike): EchoKind | undefined {
  const title = c.title.trim();
  if (!title) return undefined;
  if (COMMIT_ECHO_TITLE_PATTERNS.some((re) => re.test(title))) return 'git-commit-echo';
  const body = (c.content ?? '').replace(/^#\s+.*\n+/, '');
  if (COMMIT_ECHO_CONTENT_PATTERNS.some((re) => re.test(body))) return 'git-commit-echo';
  if (TOOL_RESULT_TITLE_PATTERNS.some((re) => re.test(title))) return 'tool-result';
  if (isBareCommand(title)) return 'shell-command';
  if (isPromptFragment(c)) return 'prompt-fragment';
  return undefined;
}

// ---------------------------------------------------------------------------
// Note kinds (by path + frontmatter)
// ---------------------------------------------------------------------------

export interface NoteLike {
  path: string;
  type?: unknown;
  tags?: readonly unknown[];
  source?: unknown;
  title?: unknown;
  auto_consolidated?: unknown;
}

const DIGEST_TAGS = new Set(['consolidated-series', 'consolidated-auto', 'digest']);

/** Weekly/series digests and auto-consolidated blobs. */
export function isDigestNote(n: NoteLike): boolean {
  if (/^Memories\/consolidated\//i.test(n.path)) return true;
  if (/(^|\/)Email Digests\//i.test(n.path)) return true;
  if (n.type === 'digest') return true;
  if (n.auto_consolidated === true) return true;
  return (n.tags ?? []).some((t) => DIGEST_TAGS.has(String(t)));
}

/** Email captures (EmailLog/, matrimail, n8n triage, `Email - ` titles, msg:<id> tags). */
export function isEmailNote(n: NoteLike): boolean {
  if (/^EmailLog\//i.test(n.path)) return true;
  if (n.type === 'email') return true;
  if (typeof n.source === 'string' && /^(n8n|e-?mail|gmail|matrimail)/i.test(n.source)) return true;
  if (typeof n.title === 'string' && /^Email - /.test(n.title)) return true;
  return (n.tags ?? []).some((t) => {
    const s = String(t);
    return s === 'matrimail' || /^msg:\s*\S/.test(s);
  });
}

/** Low-value targets that must never receive auto `## Related (auto)` links. */
export function isLowValueLinkTarget(n: NoteLike & { importance?: unknown; content?: string }): boolean {
  if (isDigestNote(n) || isEmailNote(n)) return true;
  const tags = (n.tags ?? []).map(String);
  if (tags.includes('auto-capture') && n.importance !== 'high' && n.importance !== 'medium' && n.importance !== 'critical') {
    return true;
  }
  if (typeof n.title === 'string' && classifyEcho({ title: n.title, content: n.content, source: n.source, tags })) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recurring-briefing title stems
// ---------------------------------------------------------------------------

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre';
const DAYS = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche';

/**
 * Normalise a title to its recurring stem: drop dates, weekday/month names,
 * ISO weeks and numbers, punctuation → space. "Daily briefing — Tue 2026-11-10"
 * and "Daily briefing - Wednesday 11 Nov" share the stem "daily briefing".
 */
export function titleStem(title: string): string {
  return title
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?/g, ' ')
    .replace(/\b\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?\b/g, ' ')
    .replace(/\b(\d{4}-)?w\d{1,2}\b/g, ' ')
    .replace(new RegExp(`\\b(${MONTHS}|${DAYS})\\b\\.?`, 'g'), ' ')
    .replace(/\d+(st|nd|rd|th|er|e)?\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A stem specific enough to key a recurring series on. */
export function isUsableStem(stem: string): boolean {
  return stem.length >= 8 && stem.split(' ').length >= 2;
}

// ---------------------------------------------------------------------------
// Project names (reconcile guard)
// ---------------------------------------------------------------------------

/** Same slug rule as Projects/<slug>.md (journal.ts / project-reconcile.ts). */
export function projectSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

const DIARY_PROJECT_LINK = /\[\[Projects\/([^\]|#]+?)(?:\.md)?(?:[|#][^\]]*)?\]\]/gi;

/** `[[Projects/<slug>]]` slugs linked from one diary note's text. */
export function diaryProjectSlugs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DIARY_PROJECT_LINK)) {
    const slug = projectSlug(m[1]);
    if (slug) out.push(slug);
  }
  return out;
}

/** Diary notes live under Ops/Agent Diaries/<agent>/YYYY-MM-DD.md. */
export function isDiaryPath(p: string): boolean {
  return /^Ops\/Agent Diaries\/[^/]+\/\d{4}-\d{2}-\d{2}\.md$/.test(p);
}

/**
 * Names that can never be a project: filenames / dated note slugs, tag pairs
 * (`a + b`), and email subjects.
 */
export function isImplausibleProjectName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (/\+/.test(n)) return true;                                   // tag pair
  if (/\.(md|txt|pdf|png|jpe?g)$/i.test(n) || /-md$/i.test(n)) return true; // filename
  if (/^\d{4}-\d{2}-\d{2}/.test(n)) return true;                  // dated note slug
  if (/^(email|re|fwd?)\b[\s:-]/i.test(n)) return true;           // email subject
  return false;
}
