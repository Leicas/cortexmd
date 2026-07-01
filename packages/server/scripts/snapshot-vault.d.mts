/**
 * Type declaration for the pure helper exported by snapshot-vault.mjs so the
 * eval test (real-vault.test.ts) can import it under strict TS without an
 * implicit-any error. The script itself stays plain ESM.
 */
export function shouldInclude(
  relPath: string,
  filters?: { include?: string[]; exclude?: string[] },
): boolean;
