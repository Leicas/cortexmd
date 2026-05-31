import crypto from 'node:crypto';

interface UploadToken {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingTokens = new Map<string, UploadToken>();

/**
 * Generate a single-use upload token valid for 5 minutes.
 */
export function generateUploadToken(): { token: string; expiresAt: number } {
  // Cleanup expired tokens opportunistically
  const now = Date.now();
  for (const [k, v] of pendingTokens) {
    if (v.expiresAt <= now) pendingTokens.delete(k);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = now + TOKEN_TTL_MS;
  pendingTokens.set(token, { token, createdAt: now, expiresAt });
  return { token, expiresAt };
}

/**
 * Consume an upload token. Returns true if valid, false otherwise.
 * The token is always removed after this call (single-use).
 */
export function consumeUploadToken(token: string): boolean {
  const entry = pendingTokens.get(token);
  if (!entry) return false;
  pendingTokens.delete(token);
  return entry.expiresAt > Date.now();
}
