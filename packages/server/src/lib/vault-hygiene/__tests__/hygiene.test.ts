import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import { planHygiene } from '../report.js';
import { applyPlan, loadVaultDir, restoreBackup, treeDigest } from '../fs-runner.js';
import { main } from '../cli.js';
import { normaliseTags, reheatFix } from '../commands.js';
import { parseNote } from '../model.js';

// Every note below is invented for the test.
const fm = (data: Record<string, unknown>, body: string): string => matter.stringify(body, data);

const VAULT: Record<string, string> = {
  'Memories/observation/2026/01/2026-01-05-webapp-npm-run-build-abc.md': fm(
    { type: 'memory', title: 'webapp: npm run build && npm test', tags: ['auto-capture'], source: 'hook:PostToolUse:Bash', temperature: 'warm', heat_score: 6 },
    '# webapp: npm run build && npm test\n\nwebapp: npm run build && npm test\n'),
  'Memories/observation/2026/01/2026-01-06-git-commit-fix.md': fm(
    { type: 'memory', title: 'git commit: fix(api): handle empty payloads', tags: ['auto-capture'], source: 'hook:PostToolUse:git-commit' },
    '# git commit: fix(api): handle empty payloads\n\nMade a commit with message: "fix(api): handle empty payloads"\n'),
  'Memories/decision/2026/01/2026-01-07-use-postgres.md': fm(
    { type: 'memory', category: 'decision', title: 'Use Postgres for billing', importance: 'high', temperature: 'cold', heat_score: 0, tags: [2024, 'billing'] },
    '# Use Postgres for billing\n\nSee [[Projects/demo-app]] and [[Gone Note|the old plan]] and ![[diagram.png]].\n\n## Related (auto)\n- [[Memories/consolidated/promo-2026-W02.md]]\n- [[Memories/insight/2026/01/real-insight.md]]\n'),
  'Memories/insight/2026/01/real-insight.md': fm(
    { type: 'memory', category: 'insight', title: 'Billing retries need idempotency keys', importance: 'medium', temperature: 'cold', heat_score: 1 },
    '# Billing retries need idempotency keys\n'),
  'Memories/consolidated/promo-2026-W02.md': fm(
    { type: 'memory', title: 'Promo — W02', tags: ['consolidated-series'], consolidated_from: ['EmailLog/observation/2026/01/a.md'], temperature: 'warm', heat_score: 6, importance: 3 },
    '# Promo — W02\n\n- [[EmailLog/observation/2026/01/a.md]] — Sale\n- [[EmailLog/observation/2026/01/b.md|Another sale]]\n'),
  'EmailLog/observation/2026/01/a.md': fm(
    { type: 'memory', title: 'Email - Sale', tags: ['matrimail', 'msg:18c0ffee', 'msg: 19deadbeef', '2: FYI', 'INBOX', 'source:n8n:triage', 'account: work'], source: 'n8n:triage', temperature: 'warm', heat_score: 8 },
    '# Email - Sale\n'),
  'Projects/demo-app.md': fm({ type: 'project', title: 'demo-app' }, '# demo-app\n'),
  'Projects/jane-doe.md': fm({ type: 'project', title: 'Jane Doe', auto_reconciled: true }, '# Jane Doe\n\n## Related memories\n- [[Memories/insight/2026/01/real-insight.md|x]]\n'),
  'Projects/2026-01-03-email-hello.md': fm({ type: 'project', title: '2026-01-03-email-hello', auto_reconciled: true }, '# x\n'),
  'Projects/tooling.md': fm({ type: 'project', title: 'tooling', auto_reconciled: true }, '# tooling\n'),
  'CRM/People/Jane Doe.md': fm({ type: 'entity', title: 'Jane Doe' }, '# Jane Doe\n\nContact.\n'),
  'Ops/Agent Diaries/Agent (box1)/2026-01-08.md': '# Agent (box1) — 2026-01-08\n\n- **09:00** — shipped · [[Projects/tooling]] @ [[Machines/box1]]\n',
  'Notes/legacy.md': fm({ title: 'Legacy', heat_score: 53, temperature: 'warm', importance: 'low', tags: ['auto-capture'] }, '# Legacy\n'),
  'Notes/plain.md': 'No frontmatter, link to [[Missing Thing]] and `[[code ref]]`.\n',
};

let root: string;
let backups: string;

function writeVault(dir: string): void {
  for (const [p, c] of Object.entries(VAULT)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'hygiene-vault-'));
  backups = mkdtempSync(path.join(os.tmpdir(), 'hygiene-backup-'));
  writeVault(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(backups, { recursive: true, force: true });
});

async function plan(commands: Parameters<typeof planHygiene>[2], extra = {}) {
  const { files, otherFiles } = await loadVaultDir(root);
  return planHygiene(files, otherFiles, commands, { today: '2026-02-01', ...extra });
}
const change = (r: Awaited<ReturnType<typeof plan>>, p: string) => r.plan.find((c) => c.path === p);
const dataOf = (text: string) => matter(text, {}).data;

describe('sub-commands (dry-run planning)', () => {
  it('hook-echoes archives echo captures only', async () => {
    const r = await plan(['hook-echoes']);
    expect(r.plan.filter((c) => c.op === 'archive').map((c) => c.path).sort()).toEqual([
      'Memories/observation/2026/01/2026-01-05-webapp-npm-run-build-abc.md',
      'Memories/observation/2026/01/2026-01-06-git-commit-fix.md',
    ]);
    expect(change(r, 'Memories/observation/2026/01/2026-01-06-git-commit-fix.md')!.to)
      .toBe('Archive/vault-hygiene/Memories/observation/2026/01/2026-01-06-git-commit-fix.md');
  });

  it('junk-projects merges into an entity note, archives junk, keeps curated + diary-confirmed', async () => {
    const r = await plan(['junk-projects']);
    expect(change(r, 'Projects/jane-doe.md')).toMatchObject({ op: 'archive' });
    expect(change(r, 'Projects/2026-01-03-email-hello.md')).toMatchObject({ op: 'archive' });
    expect(change(r, 'CRM/People/Jane Doe.md')!.newContent).toContain('## Merged from Projects/jane-doe (vault-hygiene)');
    expect(change(r, 'Projects/demo-app.md')).toBeUndefined();
    expect(change(r, 'Projects/tooling.md')).toBeUndefined(); // diary-confirmed
  });

  it('tags: msg→gmail_id, labels→email_label, drop duplicate source tag, unspace, numeric coerced', async () => {
    const r = await plan(['tags']);
    const d = dataOf(change(r, 'EmailLog/observation/2026/01/a.md')!.newContent!);
    expect(d.tags).toEqual(['matrimail', 'account:work']);
    expect(d.gmail_id).toEqual(['18c0ffee', '19deadbeef']);
    expect(d.email_label).toEqual(['2: FYI', 'INBOX']);
    const dec = dataOf(change(r, 'Memories/decision/2026/01/2026-01-07-use-postgres.md')!.newContent!);
    expect(dec.tags).toEqual(['2024', 'billing']);
  });

  it('normaliseTags never throws on odd YAML tag shapes', () => {
    const n = parseNote('x.md', '---\ntags:\n  - 2024\n  - 3.5\n  - true\n  -\n  - {a: 1}\n---\nbody\n');
    expect(() => normaliseTags(n)).not.toThrow();
    expect(n.data!.tags).toEqual(['2024', '3.5', 'true']);
    const single = parseNote('y.md', '---\ntags: 2025\n---\n');
    expect(() => normaliseTags(single)).not.toThrow();
  });

  it('digests: type digest, low, cold, heat 0, source links → consolidated_from', async () => {
    const r = await plan(['digests']);
    const c = change(r, 'Memories/consolidated/promo-2026-W02.md')!;
    const d = dataOf(c.newContent!);
    expect(d).toMatchObject({ type: 'digest', importance: 'low', temperature: 'cold', heat_score: 0 });
    expect(d.consolidated_from).toEqual(['EmailLog/observation/2026/01/a.md', 'EmailLog/observation/2026/01/b.md']);
    expect(matter(c.newContent!, {}).content).not.toContain('[[');
    expect(c.newContent).toContain('- Another sale');
  });

  it('auto-related strips links to digests and keeps real ones', async () => {
    const r = await plan(['auto-related']);
    const body = change(r, 'Memories/decision/2026/01/2026-01-07-use-postgres.md')!.newContent!;
    expect(body).not.toContain('promo-2026-W02');
    expect(body).toContain('[[Memories/insight/2026/01/real-insight.md]]');
  });

  it('reheat: high-importance decision floored, email capped, 0-100 fossil rescaled', async () => {
    const r = await plan(['reheat']);
    expect(dataOf(change(r, 'Memories/decision/2026/01/2026-01-07-use-postgres.md')!.newContent!)).toMatchObject({ temperature: 'warm', heat_score: 5 });
    expect(dataOf(change(r, 'EmailLog/observation/2026/01/a.md')!.newContent!)).toMatchObject({ temperature: 'cold', heat_score: 2 });
    expect(dataOf(change(r, 'Notes/legacy.md')!.newContent!)).toMatchObject({ temperature: 'cold', heat_score: 2 });
    expect(reheatFix(parseNote('z.md', '---\ntemperature: cold\n---\n'))).toBeUndefined();
  });

  it('broken-links: unresolved → plain text; embeds/code untouched; diary entity links get stubs', async () => {
    const r = await plan(['broken-links']);
    const dec = change(r, 'Memories/decision/2026/01/2026-01-07-use-postgres.md')!.newContent!;
    expect(dec).toContain('and the old plan and ![[diagram.png]]');
    expect(dec).toContain('[[Projects/demo-app]]');
    expect(change(r, 'Notes/plain.md')!.newContent).toBe('No frontmatter, link to Missing Thing and `[[code ref]]`.\n');
    expect(change(r, 'Machines/box1.md')).toMatchObject({ op: 'create' });
    expect(dataOf(change(r, 'Machines/box1.md')!.newContent!)).toMatchObject({ type: 'machine', host: 'box1' });
    expect(change(r, 'Ops/Agent Diaries/Agent (box1)/2026-01-08.md')).toBeUndefined();
  });

  it('--prefix / --exclude scope the run', async () => {
    const r = await plan(['broken-links'], { prefixes: ['Notes/'] });
    expect(r.plan.map((c) => c.path)).toEqual(['Notes/plain.md']);
    const x = await plan(['broken-links'], { excludePrefixes: ['Notes/', 'Ops/'] });
    // The digest's dangling source link (b.md) is unlinked too and lands in consolidated_from.
    expect(x.plan.map((c) => c.path)).toEqual([
      'Memories/consolidated/promo-2026-W02.md',
      'Memories/decision/2026/01/2026-01-07-use-postgres.md',
    ]);
    expect(dataOf(x.plan[0].newContent!).consolidated_from).toContain('EmailLog/observation/2026/01/b.md');
  });

  it('body-only edits never reformat frontmatter', async () => {
    const r = await plan(['broken-links'], { prefixes: ['Memories/decision/'] });
    const before = VAULT['Memories/decision/2026/01/2026-01-07-use-postgres.md'];
    const after = r.plan[0].newContent!;
    expect(after.slice(0, after.indexOf('# Use Postgres'))).toBe(before.slice(0, before.indexOf('# Use Postgres')));
  });
});

describe('CLI safety + apply/restore', () => {
  it('dry-run is the default and writes nothing', async () => {
    const before = await treeDigest(root);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['all', '--vault', root])).toBe(0);
    } finally { out.mockRestore(); }
    expect(await treeDigest(root)).toEqual(before);
  });

  it('refuses --apply without --backup-dir', async () => {
    const before = await treeDigest(root);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main(['all', '--vault', root, '--apply'])).toBe(2);
    } finally { err.mockRestore(); }
    expect(await treeDigest(root)).toEqual(before);
  });

  it('refuses a backup dir inside the vault', async () => {
    const r = await plan(['all']);
    await expect(applyPlan(root, r.plan, path.join(root, 'bk'), ['all'])).rejects.toThrow(/outside the vault/);
  });

  it('apply backs up + moves (never deletes); restore is byte-identical', async () => {
    const before = await treeDigest(root);
    const r = await plan(['all']);
    const { runDir, manifest } = await applyPlan(root, r.plan, backups, ['all']);
    expect(manifest.status).toBe('applied');
    const archived = manifest.entries.filter((e) => e.op === 'archive');
    expect(archived.length).toBeGreaterThan(0);
    for (const e of archived) {
      expect(existsSync(path.join(root, e.path))).toBe(false);
      expect(existsSync(path.join(root, e.to!))).toBe(true);
      expect(readFileSync(path.join(runDir, e.backup!), 'utf8')).toBe(VAULT[e.path]);
    }
    expect(existsSync(path.join(root, 'Machines/box1.md'))).toBe(true);
    expect(await treeDigest(root)).not.toEqual(before);

    const res = await restoreBackup(runDir);
    expect(res.mismatched).toEqual([]);
    expect(res.keptArchiveCopies).toEqual([]);
    expect(await treeDigest(root)).toEqual(before);
    expect(existsSync(path.join(root, 'Archive'))).toBe(false);
    expect(existsSync(path.join(root, 'Machines'))).toBe(false);
  });
});
