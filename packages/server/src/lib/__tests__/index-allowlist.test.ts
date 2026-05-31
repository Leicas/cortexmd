import { describe, it, expect, vi } from 'vitest';

process.env.API_KEY = 'test-key-for-unit-tests';

// Mock config with two source vaults: one default-deny (allowlist) and one
// open (empty allowlist).
vi.mock('../../config.js', () => ({
  config: {
    brainVault: '/brain',
    sourceVaults: ['/src/locked', '/src/open'],
    sourceVaultConfigs: [
      { name: 'locked', path: '/src/locked', includeGlobs: ['Public/**', 'docs/*.md'] },
      { name: 'open', path: '/src/open', includeGlobs: [] },
    ],
    allVaults: ['/brain', '/src/locked', '/src/open'],
    deniedSegments: ['.obsidian', '.sync', '.trash'],
  },
}));

const { isPathIndexable, sourceNameForVault } = await import('../index-allowlist.js');

describe('index allowlist (default-deny)', () => {
  it('allows paths matching an include glob', () => {
    expect(isPathIndexable('locked', 'Public/readme.md')).toBe(true);
    expect(isPathIndexable('locked', 'Public/nested/deep.md')).toBe(true);
    expect(isPathIndexable('locked', 'docs/guide.md')).toBe(true);
  });

  it('denies paths not matching any include glob', () => {
    expect(isPathIndexable('locked', 'Private/secret.md')).toBe(false);
    expect(isPathIndexable('locked', 'docs/nested/deep.md')).toBe(false); // docs/*.md is one level
    expect(isPathIndexable('locked', 'top.md')).toBe(false);
  });

  it('indexes everything when the allowlist is empty', () => {
    expect(isPathIndexable('open', 'anything/at/all.md')).toBe(true);
    expect(isPathIndexable('open', 'top.md')).toBe(true);
  });

  it('hard-blocks denied segments even with an empty allowlist', () => {
    expect(isPathIndexable('open', '.obsidian/workspace.json')).toBe(false);
    expect(isPathIndexable('open', 'sub/.trash/x.md')).toBe(false);
    expect(isPathIndexable('open', '.sync/state')).toBe(false);
  });

  it('hard-blocks denied segments even if an explicit glob would match', () => {
    expect(isPathIndexable('locked', 'Public/.obsidian/x.json')).toBe(false);
  });

  it('treats unknown source names (e.g. the brain) as fully indexable', () => {
    expect(isPathIndexable('brain', 'anything.md')).toBe(true);
  });

  it('maps a vault root path back to its source name', () => {
    expect(sourceNameForVault('/src/locked')).toBe('locked');
    expect(sourceNameForVault('/src/open')).toBe('open');
    expect(sourceNameForVault('/brain')).toBeUndefined();
  });
});
