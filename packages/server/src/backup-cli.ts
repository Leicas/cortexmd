/**
 * Brain-vault backup CLI (no server needed):
 *
 *   node dist/backup-cli.js create            # archive BRAIN_VAULT now
 *   node dist/backup-cli.js list              # archives in BACKUP_DIR
 *   node dist/backup-cli.js restore <archive> <dest-dir> [--overwrite]
 *
 * In the container: `docker compose exec cortexmd node dist/backup-cli.js list`.
 * BACKUP_DIR defaults to <DATA_DIR>/backups; see docs/deploy-http.md
 * ("Backup and restore") for the full restore procedure.
 */
import path from 'node:path';
import { config } from './config.js';
import { createBackup, listBackups, restoreBackup, resolveBackupDir as backupDir } from './lib/backup.js';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'create') {
    const r = await createBackup({ vaultDir: config.brainVault, backupDir: backupDir(), keep: config.backupKeep });
    process.stdout.write(`${r.file}  (${r.files} files, ${r.bytes} bytes, ${r.ms} ms, pruned ${r.pruned.length})\n`);
    return 0;
  }
  if (cmd === 'list') {
    for (const f of await listBackups(backupDir())) process.stdout.write(path.join(backupDir(), f) + '\n');
    return 0;
  }
  if (cmd === 'restore' && rest.length >= 2) {
    const r = await restoreBackup(rest[0], rest[1], { overwrite: rest.includes('--overwrite') });
    process.stdout.write(`restored ${r.files} files into ${path.resolve(rest[1])}\n`);
    return 0;
  }
  process.stderr.write('usage: backup-cli create | list | restore <archive> <dest-dir> [--overwrite]\n');
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`backup-cli: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
