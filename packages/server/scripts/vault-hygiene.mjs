#!/usr/bin/env node
// cortexmd vault-hygiene — dry-run-first maintenance for a brain vault.
// Runs the compiled CLI (dist/) when built, otherwise the TypeScript source via tsx.
// See src/lib/vault-hygiene/cli.ts for usage, or run with --help.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'lib', 'vault-hygiene', 'cli.js');
let mod;
if (existsSync(dist) && process.env.VAULT_HYGIENE_FROM_SOURCE !== '1') {
  mod = await import(pathToFileURL(dist).href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  mod = await import(pathToFileURL(path.join(here, '..', 'src', 'lib', 'vault-hygiene', 'cli.ts')).href);
}
process.exitCode = await mod.main(process.argv.slice(2));
