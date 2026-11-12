import { describe, expect, it } from 'vitest';
import {
  classifyEcho,
  diaryProjectSlugs,
  isBareCommand,
  isDigestNote,
  isEmailNote,
  isImplausibleProjectName,
  isLowValueLinkTarget,
  isMachineSource,
  isPromptFragment,
  isUsableStem,
  titleStem,
} from '../patterns.js';

// All examples are invented — none are copied from a real vault.

describe('isMachineSource', () => {
  it.each(['n8n:triage-v3', 'n8n', 'hook', 'hook:PostToolUse:Bash', 'hooks', 'email', 'gmail-sync', 'matrimail',
    'posttooluse', 'UserPromptSubmit', 'auto-capture', 'trigger-capture'])('machine: %s', (s) => {
    expect(isMachineSource(s)).toBe(true);
  });
  it.each(['claude-code', 'codex', 'user', 'manual', 'dashboard', 'odoo', 'hooky-app', '', undefined])('deliberate: %s', (s) => {
    expect(isMachineSource(s)).toBe(false);
  });
  it('honours an explicit pattern list', () => {
    expect(isMachineSource('cron-job', ['^cron'])).toBe(true);
    expect(isMachineSource('hook', ['^cron'])).toBe(false);
  });
});

describe('isBareCommand', () => {
  it.each([
    'git status',
    'npm install',
    'docker compose up',
    'webapp: npm run build && npm test',
    'infra: ssh -o BatchMode=yes deploy@10.0.0.5 uptime',
    '$ ls -la /var/log',
    'cd ~/projects/demo',
    'cat package.json | jq .version',
    'echo "done" > /tmp/flag',
    'rm -rf dist',
    'kubectl get pods -n staging',
  ])('command: %s', (t) => expect(isBareCommand(t)).toBe(true));

  it.each([
    'Git is the source of truth for releases',
    'git rebase broke the release branch twice this week',
    'npm audit shows three critical vulnerabilities',
    'find the root cause of the flaky upload test',
    'Docker deploy fails when the volume is read-only',
    'make sure the backup runs before midnight',
    'set up the staging database with seed data',
    'cat sitter booked for the weekend',
    'Decision: rm is aliased to trash on every workstation',
  ])('prose: %s', (t) => expect(isBareCommand(t)).toBe(false));
});

describe('classifyEcho', () => {
  it('flags tool-result fragments', () => {
    expect(classifyEcho({ title: 'the parser returns early.</result>' })).toBe('tool-result');
    expect(classifyEcho({ title: '{"status": "ok", "count": 3}' })).toBe('tool-result');
    expect(classifyEcho({ title: '42\timport { foo } from "./bar"' })).toBe('tool-result');
    expect(classifyEcho({ title: 'Traceback (most recent call last)' })).toBe('tool-result');
  });

  it('flags git commit echoes by title and by multi-line body', () => {
    expect(classifyEcho({ title: 'git commit: fix(api): handle empty payloads' })).toBe('git-commit-echo');
    expect(classifyEcho({ title: 'webapp: git commit -m "wip"' })).toBe('git-commit-echo');
    expect(classifyEcho({
      title: 'Release prep for the mobile app',
      content: 'Made a commit with message: "chore: bump version"\n\nCo-authored lines follow',
    })).toBe('git-commit-echo');
    expect(classifyEcho({
      title: 'tooling: stage and commit',
      content: "git add -A && git commit -F - <<'EOF'\nfeat: x\nEOF",
    })).toBe('git-commit-echo');
  });

  it('flags prompt fragments only from prompt-capture sources', () => {
    const src = 'hook:UserPromptSubmit';
    expect(classifyEcho({ title: 'three widgets', content: 'three widgets', source: src })).toBe('prompt-fragment');
    expect(classifyEcho({
      title: 'keep the retry loop bounded so the worker never spins forev',
      content: 'keep the retry loop bounded so the worker never spins forever on a bad message',
      source: src,
    })).toBe('prompt-fragment');
    // Complete lowercase sentence with ≥5 words is kept.
    expect(isPromptFragment({
      title: 'always label currency on exported quotes',
      content: 'always label currency on exported quotes',
      source: src,
    })).toBe(false);
    // Same short text from a deliberate source is kept.
    expect(classifyEcho({ title: 'three widgets', content: 'three widgets', source: 'claude-code' })).toBeUndefined();
    // Capitalised prompt-capture text is kept.
    expect(classifyEcho({ title: 'Prefer UTC everywhere', source: src })).toBeUndefined();
  });

  it('keeps real memories', () => {
    for (const title of [
      'Decided to use SQLite for the code index',
      'Upload service drops files over 2 GB',
      'Staging DB credentials rotate monthly',
      'cortexmd: sync bug root cause is the etag check',
      'The deploy script needs bash 5',
    ]) {
      expect(classifyEcho({ title, content: `${title}. Some detail.`, source: 'hook' })).toBeUndefined();
    }
  });
});

describe('note kinds', () => {
  it('digests and emails', () => {
    expect(isDigestNote({ path: 'Memories/consolidated/weekly-2026-W10.md' })).toBe(true);
    expect(isDigestNote({ path: 'Notes/x.md', tags: ['consolidated-series'] })).toBe(true);
    expect(isDigestNote({ path: 'Notes/x.md', type: 'digest' })).toBe(true);
    expect(isDigestNote({ path: 'Memories/decision/x.md' })).toBe(false);
    expect(isEmailNote({ path: 'EmailLog/observation/2026/01/x.md' })).toBe(true);
    expect(isEmailNote({ path: 'Memories/observation/x.md', tags: ['msg:18c0ffee'] })).toBe(true);
    expect(isEmailNote({ path: 'Memories/observation/x.md', source: 'n8n:triage' })).toBe(true);
    expect(isEmailNote({ path: 'Memories/observation/x.md', title: 'Email - Invoice from Vendor' })).toBe(true);
    expect(isEmailNote({ path: 'Memories/decision/x.md', title: 'Use Postgres' })).toBe(false);
  });

  it('low-value link targets', () => {
    expect(isLowValueLinkTarget({ path: 'Memories/consolidated/a.md' })).toBe(true);
    expect(isLowValueLinkTarget({ path: 'Memories/observation/a.md', tags: ['auto-capture'], importance: 'low' })).toBe(true);
    expect(isLowValueLinkTarget({ path: 'Memories/observation/a.md', tags: ['auto-capture'], importance: 'high', title: 'Real finding' })).toBe(false);
    expect(isLowValueLinkTarget({ path: 'Memories/decision/a.md', title: 'Use Postgres for billing' })).toBe(false);
  });
});

describe('titleStem', () => {
  it('collapses dated recurring titles to one stem', () => {
    const a = titleStem('Daily briefing — Tue 2026-11-10');
    expect(a).toBe('daily briefing');
    expect(titleStem('Daily Briefing - Wednesday 11 Nov')).toBe(a);
    expect(titleStem('Daily briefing (11/12/2026)')).toBe(a);
    expect(titleStem('Weekly ops summary W45')).toBe('weekly ops summary');
    expect(titleStem('Résumé hebdo — lundi 3 mars')).toBe('résumé hebdo');
  });
  it('rejects generic stems', () => {
    expect(isUsableStem(titleStem('2026-11-10'))).toBe(false);
    expect(isUsableStem(titleStem('Update 12'))).toBe(false);
    expect(isUsableStem(titleStem('Daily briefing 2026-11-10'))).toBe(true);
  });
});

describe('project names', () => {
  it('extracts diary project slugs', () => {
    expect(diaryProjectSlugs('- **09:00** — done · [[Projects/demo-app]] @ [[Machines/box1]] and [[Projects/Other Repo|x]]'))
      .toEqual(['demo-app', 'other-repo']);
  });
  it.each(['a + b', 'notes.md', 'meeting-notes-md', '2026-05-01-email-hello', 'Email - Hello', 'Re: budget', ''])(
    'implausible: %s', (n) => expect(isImplausibleProjectName(n)).toBe(true),
  );
  it.each(['demo-app', 'Payments Platform', 'homelab'])('plausible: %s', (n) => expect(isImplausibleProjectName(n)).toBe(false));
});
