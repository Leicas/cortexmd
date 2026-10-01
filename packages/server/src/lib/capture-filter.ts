/**
 * Capture-time noise filter. Hooks, other clients and the n8n email triage
 * push memories through memory_store / POST /api/store-memory; a vault audit
 * found thousands of orphan observations that were just a shell command
 * ("cortexmd: git add -A", "systemctl stop x") or an automated email
 * (package updates, one-time codes, calendar invitations). These patterns are
 * matched against the memory title; config.captureNoisePatterns adds more and
 * CAPTURE_NOISE_FILTER=false turns the filter off.
 */
import { config } from '../config.js';
import { logger } from './logger.js';

export const DEFAULT_NOISE_PATTERNS: readonly RegExp[] = [
  // "<label>: <raw command>" stubs
  /^[\w.-]+: (rtk |cd |git |python|ssh |rm |chmod|mkdir|gh |docker|taskkill|pkill|echo)/,
  /^systemctl (start|stop)\b/,
  /^(git commit|chmod \+x)/,
  // Automated email captures
  /^Email - (\[Vault\.local\]|New activity|Your team made progress|Invitation( mise à jour)?|Accepté|Refusé|Événement annulé|NOTIFICATION: ANTOINE|\d{6} is your)/,
];

let extraCache: { source: readonly string[]; patterns: RegExp[] } | undefined;

function extraPatterns(): RegExp[] {
  const source = config.captureNoisePatterns;
  if (extraCache?.source === source) return extraCache.patterns;
  const patterns: RegExp[] = [];
  for (const raw of source) {
    try {
      patterns.push(new RegExp(raw));
    } catch (err) {
      logger.warn('capture-filter: ignoring invalid CAPTURE_NOISE_PATTERNS entry', {
        pattern: raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  extraCache = { source, patterns };
  return patterns;
}

/** The pattern that marks `title` as capture noise, or undefined to keep it. */
export function matchCaptureNoise(title: string): RegExp | undefined {
  if (!config.captureNoiseFilter) return undefined;
  const t = title.trim();
  return [...DEFAULT_NOISE_PATTERNS, ...extraPatterns()].find((re) => re.test(t));
}

/**
 * A title that is only a filename slug ("2026-09-30-fix-the-sync-bug") or
 * empty. Callers should derive a readable title from the content instead.
 */
export function isSlugTitle(title: string): boolean {
  const t = title.trim();
  return !t || /^(\d{4}-\d{2}-\d{2}-)?[a-z0-9]+(-[a-z0-9]+)+$/.test(t);
}
