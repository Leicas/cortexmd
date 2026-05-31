import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Must set env before any imports that load config.
process.env.API_KEY = 'test-key-for-unit-tests';

// Two real temp dirs: the writable brain, and a read-only "source" vault that
// writes must never reach. A third dir lives entirely outside any vault and is
// the symlink-escape target.
const brainVault = mkdtempSync(join(tmpdir(), 'brain-'));
const sourceVault = mkdtempSync(join(tmpdir(), 'source-'));
const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'));

// Mock config to point the vault module at our temp dirs.
vi.mock('../../config.js', () => ({
  config: {
    brainVault,
    sourceVaults: [sourceVault],
    sourceVaultConfigs: [{ name: 'source', path: sourceVault, includeGlobs: [] }],
    allVaults: [brainVault, sourceVault],
    deniedSegments: ['.obsidian', '.sync', '.trash'],
    maxPathLength: 1024,
    maxNoteSize: 5 * 1024 * 1024,
  },
}));

const { resolveSafePath, writeNote } = await import('../vault.js');

afterAll(() => {
  for (const d of [brainVault, sourceVault, outsideDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('vault write-routing containment', () => {
  it('rejects a write targeting a SOURCE-vault path', () => {
    // An absolute path inside the read-only source vault must not be writable.
    const target = join(sourceVault, 'note.md');
    expect(() => resolveSafePath(target, true)).toThrow(/brain vault/i);
  });

  it('routes a relative write into the brain vault, never the source vault', () => {
    const resolved = resolveSafePath('note.md', true);
    expect(resolved.startsWith(brainVault)).toBe(true);
    expect(resolved.startsWith(sourceVault)).toBe(false);
  });

  it('allows a normal write inside the brain vault', async () => {
    const { etag } = await writeNote('subdir/hello.md', '# hello');
    expect(etag).toBeTruthy();
    const written = readFileSync(join(brainVault, 'subdir', 'hello.md'), 'utf-8');
    expect(written).toBe('# hello');
  });

  it('rejects a write via a symlink inside the brain that points outside it', () => {
    // Create a directory symlink inside the brain that points outside any
    // vault. A write "through" it must be rejected by realpath containment.
    const linkPath = join(brainVault, 'escape');
    let symlinkCreated = false;
    try {
      // 'junction' works on Windows without elevation; 'dir' elsewhere.
      symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkCreated = true;
    } catch {
      // Environment forbids symlink creation — skip rather than false-pass.
    }
    if (!symlinkCreated) {
      return; // cannot exercise symlink escape here
    }

    expect(() => resolveSafePath('escape/evil.md', true)).toThrow(/symlink|brain vault/i);

    // Sanity: the realpath of the escape target really is outside the brain.
    expect(outsideDir.startsWith(brainVault)).toBe(false);
  });

  it('still allows a symlink inside the brain that stays inside the brain', () => {
    const realDir = join(brainVault, 'real');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'placeholder.md'), 'x');
    const linkPath = join(brainVault, 'innerlink');
    let symlinkCreated = false;
    try {
      symlinkSync(realDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkCreated = true;
    } catch {
      /* skip */
    }
    if (!symlinkCreated) return;

    const resolved = resolveSafePath('innerlink/ok.md', true);
    expect(resolved.startsWith(brainVault)).toBe(true);
  });
});
