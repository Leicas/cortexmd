/**
 * Entity MOC stubs for the diary's `[[Projects/<slug>]] @ [[Machines/<host>]]`
 * suffix. Every diary line links both, but nothing ever created the notes, so
 * the links were dangling and Obsidian's graph had no hub to hang agent
 * activity on. On each diary write we create the missing stub — idempotent,
 * create-only (`wx`): an existing note, curated or not, is never touched.
 * Template: stub-template.ts.
 */
import { createNote } from '../vault.js';
import { logger } from '../logger.js';
import { entityStubPath, isSafeStubName, renderEntityStub, type EntityStubKind } from './stub-template.js';

export { entityStubPath, renderEntityStub } from './stub-template.js';

/**
 * Create `Projects/<project>.md` / `Machines/<machine>.md` when missing.
 * Returns the paths actually created. Never throws, never overwrites.
 */
export async function ensureEntityStubs(
  targets: { project?: string; machine?: string },
  today: string = new Date().toISOString().slice(0, 10),
): Promise<string[]> {
  const created: string[] = [];
  const jobs: Array<[EntityStubKind, string | undefined]> = [['project', targets.project], ['machine', targets.machine]];
  for (const [kind, name] of jobs) {
    if (!name || !isSafeStubName(name)) continue;
    const path = entityStubPath(kind, name);
    try {
      await createNote(path, renderEntityStub(kind, name, today));
      created.push(path);
    } catch (err: any) {
      if (err?.code === 'EEXIST') continue; // already there — never overwrite
      logger.warn('entity stub create failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (created.length > 0) {
    try {
      const { indexNote } = await import('../search.js');
      for (const p of created) await indexNote(p);
    } catch {
      // Index not ready — the next rebuild picks the stubs up.
    }
  }
  return created;
}
