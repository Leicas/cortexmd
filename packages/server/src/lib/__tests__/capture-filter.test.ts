import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ captureNoiseFilter: true, captureNoisePatterns: [] as string[] }));
vi.mock('../../config.js', () => ({ config: cfg }));

const { matchCaptureNoise, isSlugTitle } = await import('../capture-filter.js');

describe('matchCaptureNoise', () => {
  it.each([
    'cortexmd: git add -A',
    'investigate: cd /opt/app && ls',
    'homelab: docker compose up -d',
    'systemctl stop nginx',
    'git commit: fix typo',
    'chmod +x run.sh',
    'Email - [Vault.local] Package updates available',
    'Email - New activity in your workspace',
    'Email - 482913 is your verification code',
    'Email - Invitation mise à jour: Standup',
    'Email - Événement annulé : Sync',
  ])('drops %s', (title) => {
    expect(matchCaptureNoise(title)).toBeDefined();
  });

  it.each([
    'Decided to use SQLite for the code index',
    'systemctl restart nginx after config change',
    'Email - Quote request from Acme',
    'cortexmd: sync bug root cause is the etag check',
    'git rebase broke the release branch twice this week',
    'npm audit shows three critical vulnerabilities',
    'find the root cause of the flaky upload test',
  ])('keeps %s', (title) => {
    expect(matchCaptureNoise(title)).toBeUndefined();
  });

  it.each([
    'git status',
    'webapp: npm run build && npm test',
    'kubectl get pods -n staging',
    'the parser returns early.</result>',
    '{"status": "ok", "count": 3}',
  ])('drops echo title %s', (title) => {
    expect(matchCaptureNoise(title)?.source).toBeDefined();
  });

  it('applies body rules only when the hook passes body/source', () => {
    const commitBody = 'Made a commit with message: "chore: bump version"';
    expect(matchCaptureNoise('Release prep for the mobile app')).toBeUndefined();
    expect(matchCaptureNoise('Release prep for the mobile app', { content: commitBody })?.source).toBe('echo:git-commit-echo');
    expect(matchCaptureNoise('three widgets', { content: 'three widgets', source: 'hook:UserPromptSubmit' })?.source)
      .toBe('echo:prompt-fragment');
    expect(matchCaptureNoise('three widgets', { content: 'three widgets', source: 'claude-code' })).toBeUndefined();
  });

  it('honours extra patterns and the kill switch', () => {
    cfg.captureNoisePatterns = ['^Cron run ', '(['];
    expect(matchCaptureNoise('Cron run 42')).toBeDefined();
    cfg.captureNoiseFilter = false;
    expect(matchCaptureNoise('cortexmd: git add -A')).toBeUndefined();
    cfg.captureNoiseFilter = true;
    cfg.captureNoisePatterns = [];
  });
});

describe('isSlugTitle', () => {
  it('flags filename slugs and empty titles', () => {
    expect(isSlugTitle('2026-09-30-fix-the-sync-bug')).toBe(true);
    expect(isSlugTitle('fix-the-sync-bug')).toBe(true);
    expect(isSlugTitle('  ')).toBe(true);
  });

  it('keeps human titles', () => {
    expect(isSlugTitle('Fix the sync bug')).toBe(false);
    expect(isSlugTitle('cortexmd')).toBe(false);
    expect(isSlugTitle('Follow-up')).toBe(false);
  });
});
