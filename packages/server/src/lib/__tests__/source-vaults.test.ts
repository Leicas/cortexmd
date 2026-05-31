import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

process.env.API_KEY = 'test-key-for-unit-tests';

// Real temp dirs: a writable brain, one env-configured source vault, and a few
// candidate dirs for the add path.
const brainVault = mkdtempSync(join(tmpdir(), 'sv-brain-'));
const envSource = mkdtempSync(join(tmpdir(), 'sv-env-'));
const candidateA = mkdtempSync(join(tmpdir(), 'sv-a-'));
const candidateB = mkdtempSync(join(tmpdir(), 'sv-b-'));
const aFile = join(candidateA, 'afile.txt');
writeFileSync(aFile, 'x');

// A persisted directory inside the brain (illegal target).
const insideBrain = join(brainVault, 'nested');
mkdirSync(insideBrain, { recursive: true });

vi.mock('../../config.js', () => ({
  config: {
    brainVault,
    sourceVaults: [envSource],
    sourceVaultConfigs: [{ name: 'env', path: envSource, includeGlobs: [] }],
    allVaults: [brainVault, envSource],
    deniedSegments: ['.obsidian', '.sync', '.trash'],
  },
}));

const store = await import('../source-vaults.js');
const { addSourceVault, removeSourceVault, listSourceVaults, SourceVaultError, _reloadForTests } =
  store;

function clearPersisted(): void {
  const p = join(brainVault, 'Ops', 'source-vaults.json');
  if (existsSync(p)) rmSync(p);
  _reloadForTests();
}

beforeEach(() => {
  clearPersisted();
});

afterAll(() => {
  for (const d of [brainVault, envSource, candidateA, candidateB]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('source-vaults store', () => {
  it('lists the env-configured vault by default', () => {
    const list = listSourceVaults();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('env');
  });

  it('adds a persisted source vault and merges it into the list', () => {
    const added = addSourceVault({ path: candidateA });
    expect(added.name).toBeTruthy();
    const list = listSourceVaults();
    expect(list.map((v) => v.path)).toContain(added.path);
    expect(list.some((v) => v.name === 'env')).toBe(true);
  });

  it('defaults the name to the directory basename', () => {
    const added = addSourceVault({ path: candidateA });
    expect(added.name).toBe(basename(candidateA));
  });

  it('rejects a non-existent path', () => {
    expect(() => addSourceVault({ path: join(tmpdir(), 'does-not-exist-xyz') }))
      .toThrowError(SourceVaultError);
    try {
      addSourceVault({ path: join(tmpdir(), 'does-not-exist-xyz') });
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('NOT_FOUND');
    }
  });

  it('rejects a file that is not a directory', () => {
    try {
      addSourceVault({ path: aFile });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('NOT_A_DIRECTORY');
    }
  });

  it('rejects a path inside the brain vault', () => {
    try {
      addSourceVault({ path: insideBrain });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('INSIDE_BRAIN');
    }
  });

  it('rejects a path that contains the brain vault', () => {
    try {
      // brainVault's parent contains brainVault.
      addSourceVault({ path: dirname(brainVault) });
      throw new Error('should have thrown');
    } catch (e) {
      const code = (e as InstanceType<typeof SourceVaultError>).code;
      // Either CONTAINS_BRAIN, or DUPLICATE if the parent already matched — but
      // here the parent is distinct, so it must be CONTAINS_BRAIN.
      expect(code).toBe('CONTAINS_BRAIN');
    }
  });

  it('rejects a duplicate path', () => {
    addSourceVault({ path: candidateA });
    try {
      addSourceVault({ path: candidateA });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('DUPLICATE');
    }
  });

  it('rejects a duplicate of an env-configured vault path', () => {
    try {
      addSourceVault({ path: envSource });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('DUPLICATE');
    }
  });

  it('rejects a duplicate name', () => {
    addSourceVault({ path: candidateA, name: 'shared' });
    try {
      addSourceVault({ path: candidateB, name: 'shared' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('DUPLICATE_NAME');
    }
  });

  it('rejects an invalid (filesystem-unsafe) name', () => {
    try {
      addSourceVault({ path: candidateA, name: 'bad/name' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('INVALID_NAME');
    }
  });

  it('removes a persisted vault', () => {
    const added = addSourceVault({ path: candidateA, name: 'removable' });
    expect(listSourceVaults().some((v) => v.name === 'removable')).toBe(true);
    removeSourceVault('removable');
    expect(listSourceVaults().some((v) => v.name === 'removable')).toBe(false);
    expect(added.name).toBe('removable');
  });

  it('refuses to remove an env-managed vault', () => {
    try {
      removeSourceVault('env');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('ENV_MANAGED');
    }
    // Still present.
    expect(listSourceVaults().some((v) => v.name === 'env')).toBe(true);
  });

  it('refuses to remove an unknown vault', () => {
    try {
      removeSourceVault('nope');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof SourceVaultError>).code).toBe('NOT_FOUND');
    }
  });

  it('fires the onChange callback on add and remove', () => {
    const fn = vi.fn();
    const unsub = store.onSourceVaultsChanged(fn);
    addSourceVault({ path: candidateA, name: 'cbtest' });
    expect(fn).toHaveBeenCalledTimes(1);
    removeSourceVault('cbtest');
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
    addSourceVault({ path: candidateB, name: 'cbtest2' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('persists across a reload', () => {
    addSourceVault({ path: candidateA, name: 'persisted' });
    _reloadForTests();
    expect(listSourceVaults().some((v) => v.name === 'persisted')).toBe(true);
  });
});
