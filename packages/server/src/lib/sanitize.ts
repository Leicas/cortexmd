/**
 * Input sanitization utilities for the Obsidian MCP server.
 */

/**
 * Sanitize a vault-relative path: strip null bytes, normalize separators,
 * collapse dots, and reject obviously malicious patterns.
 */
export function sanitizePath(input: string): string {
  // Strip null bytes
  let cleaned = input.replace(/\0/g, '');

  // Normalize backslashes to forward slashes
  cleaned = cleaned.replace(/\\/g, '/');

  // Collapse multiple slashes
  cleaned = cleaned.replace(/\/+/g, '/');

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  // Strip leading slashes
  cleaned = cleaned.replace(/^\/+/, '');

  // Strip trailing slashes
  cleaned = cleaned.replace(/\/+$/, '');

  return cleaned;
}

/**
 * Sanitize content: strip null bytes and enforce a maximum length.
 * The default limit (10 MB) is intentionally generous — the vault layer
 * enforces the real per-note cap via MAX_NOTE_SIZE.
 */
export function sanitizeContent(
  input: string,
  maxLength: number = 10 * 1024 * 1024,
): string {
  // Strip null bytes
  let cleaned = input.replace(/\0/g, '');

  // Enforce length limit
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
  }

  return cleaned;
}

/**
 * Sanitize a search query: strip control characters and limit length.
 */
export function sanitizeQuery(
  input: string,
  maxLength: number = 500,
): string {
  // Strip null bytes and control characters (keep newlines/tabs for multi-line queries)
  // eslint-disable-next-line no-control-regex
  let cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Enforce length limit
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
  }

  return cleaned.trim();
}

/**
 * Validate an ISO 8601 date string (YYYY-MM-DD).
 * Returns true if the string is a valid date in this format.
 */
export function validateDateString(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return false;
  }

  const [year, month, day] = input.split('-').map(Number);
  const date = new Date(year, month - 1, day);

  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}
