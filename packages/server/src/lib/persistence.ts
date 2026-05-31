import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { OAuthClient } from '../oauth.js';

/**
 * Session metadata that can be serialized (no transport object).
 */
export interface PersistedSession {
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  clientInfo?: { sub?: string; clientId?: string };
  ip?: string;
  toolCounts: Record<string, number>;
  lastTools: string[];
}

/**
 * Atomically save metrics snapshot to disk (write .tmp then rename).
 */
export function saveMetrics(dataDir: string, data: object): void {
  const metricsPath = path.join(dataDir, 'metrics.json');
  const tmpPath = metricsPath + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, metricsPath);
}

/**
 * Load persisted metrics from disk.
 * Returns null if the file doesn't exist or is corrupt.
 */
export function loadMetrics(dataDir: string): object | null {
  const metricsPath = path.join(dataDir, 'metrics.json');
  try {
    const raw = fs.readFileSync(metricsPath, 'utf-8');
    return JSON.parse(raw) as object;
  } catch {
    return null;
  }
}

/**
 * Load or create a persistent JWT signing secret.
 * Generates a 32-byte random secret on first run, then reuses it across restarts.
 */
export function loadOrCreateJwtSecret(dataDir: string): Buffer {
  const secretPath = path.join(dataDir, 'jwt-secret.json');
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    const raw = fs.readFileSync(secretPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Buffer.from(parsed.secret, 'base64');
  } catch {
    // File doesn't exist or is invalid — generate a new secret
    const secret = crypto.randomBytes(32);
    const json = JSON.stringify({ secret: secret.toString('base64') });
    fs.writeFileSync(secretPath, json, { mode: 0o600 });
    return secret;
  }
}

/**
 * Load persisted OAuth clients from disk.
 * Returns an empty Map if the file doesn't exist.
 */
export function loadClients(dataDir: string): Map<string, OAuthClient> {
  const clientsPath = path.join(dataDir, 'oauth-clients.json');
  try {
    const raw = fs.readFileSync(clientsPath, 'utf-8');
    const entries: [string, OAuthClient][] = JSON.parse(raw);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

/**
 * Atomically save OAuth clients to disk (write .tmp then rename).
 */
export function saveClients(dataDir: string, clients: Map<string, OAuthClient>): void {
  const clientsPath = path.join(dataDir, 'oauth-clients.json');
  const tmpPath = clientsPath + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(Array.from(clients.entries()), null, 2);
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, clientsPath);
}

/**
 * Atomically save session metadata to disk (write .tmp then rename).
 */
export function saveSessions(dataDir: string, sessions: PersistedSession[]): void {
  const sessionsPath = path.join(dataDir, 'sessions.json');
  const tmpPath = sessionsPath + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(sessions, null, 2);
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, sessionsPath);
}

/**
 * Load persisted session metadata from disk.
 * Returns an empty array if the file doesn't exist or is corrupt.
 */
export function loadSessions(dataDir: string): PersistedSession[] {
  const sessionsPath = path.join(dataDir, 'sessions.json');
  try {
    const raw = fs.readFileSync(sessionsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as PersistedSession[];
  } catch {
    return [];
  }
}
