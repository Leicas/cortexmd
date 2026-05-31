import path from 'node:path';
import fs from 'node:fs';
import { config } from '../../config.js';
import { getCodeDb } from './db.js';

export interface CodeNavPerRepoStat {
  slug: string;
  symbols: number;
  files: number;
  lastIndexedAt: number | null;
}

export interface CodeNavStats {
  repoCount: number;
  symbolCount: number;
  fileCount: number;
  callCount: { resolved: number; unresolved: number };
  dbSizeBytes: number;
  perRepo: CodeNavPerRepoStat[];
}

export function getCodeNavStats(): CodeNavStats {
  const db = getCodeDb();

  const repoCount = (db.prepare(`SELECT COUNT(*) as c FROM repos`).get() as { c: number }).c;
  const symbolCount = (db.prepare(`SELECT COUNT(*) as c FROM symbols`).get() as { c: number }).c;
  const fileCount = (db.prepare(`SELECT COUNT(*) as c FROM files`).get() as { c: number }).c;
  const resolved =
    (db.prepare(`SELECT COUNT(*) as c FROM calls WHERE callee_id IS NOT NULL`).get() as {
      c: number;
    }).c;
  const unresolved =
    (db.prepare(`SELECT COUNT(*) as c FROM calls WHERE callee_id IS NULL`).get() as {
      c: number;
    }).c;

  const perRepoRows = db
    .prepare(
      `SELECT r.slug,
              (SELECT COUNT(*) FROM symbols s WHERE s.repo_id = r.id) AS symbols,
              (SELECT COUNT(*) FROM files f   WHERE f.repo_id = r.id) AS files,
              (SELECT MAX(indexed_at) FROM files f WHERE f.repo_id = r.id) AS last_indexed_at
       FROM repos r ORDER BY r.slug`,
    )
    .all() as Array<{ slug: string; symbols: number; files: number; last_indexed_at: number | null }>;

  let dbSizeBytes = 0;
  try {
    const dbPath = path.join(config.dataDir, 'code.db');
    dbSizeBytes = fs.statSync(dbPath).size;
  } catch {
    /* ignore */
  }

  return {
    repoCount,
    symbolCount,
    fileCount,
    callCount: { resolved, unresolved },
    dbSizeBytes,
    perRepo: perRepoRows.map((r) => ({
      slug: r.slug,
      symbols: r.symbols,
      files: r.files,
      lastIndexedAt: r.last_indexed_at ?? null,
    })),
  };
}
