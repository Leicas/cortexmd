import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveSessions, loadSessions, DEFAULT_MAX_PERSISTED_SESSIONS } from '../persistence.js';
import type { PersistedSession } from '../persistence.js';

function mkSession(i: number, lastActivity: number): PersistedSession {
  return {
    sessionId: `s-${i}`,
    createdAt: lastActivity - 1000,
    lastActivity,
    requestCount: i,
    toolCounts: { notes_search: i },
    lastTools: ['notes_search'],
  };
}

describe('saveSessions', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortexmd-sessions-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes compact JSON (no pretty-print whitespace)', () => {
    saveSessions(dir, [mkSession(1, 1000), mkSession(2, 2000)]);
    const raw = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf-8');
    expect(raw).not.toContain('\n');
    expect(raw).not.toContain('  ');
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    expect(JSON.parse(raw)).toHaveLength(2);
  });

  it('caps at 500 records by default, keeping the newest lastActivity', () => {
    expect(DEFAULT_MAX_PERSISTED_SESSIONS).toBe(500);
    const many: PersistedSession[] = [];
    for (let i = 0; i < 1200; i++) many.push(mkSession(i, i * 10));
    // Shuffle so the cap is not just "first N".
    many.sort(() => Math.random() - 0.5);

    saveSessions(dir, many);
    const loaded = loadSessions(dir);
    expect(loaded).toHaveLength(500);
    // Newest first, and every kept record is newer than every dropped one.
    const activities = loaded.map((s) => s.lastActivity);
    for (let i = 1; i < activities.length; i++) expect(activities[i - 1]).toBeGreaterThanOrEqual(activities[i]);
    expect(Math.min(...activities)).toBe((1200 - 500) * 10);
    expect(loaded[0].sessionId).toBe('s-1199');
  });

  it('honours an explicit maxRecords', () => {
    saveSessions(dir, [mkSession(1, 100), mkSession(2, 300), mkSession(3, 200)], 2);
    const loaded = loadSessions(dir);
    expect(loaded.map((s) => s.sessionId)).toEqual(['s-2', 's-3']);
  });

  it('is atomic: no .tmp file left behind and the record shape round-trips', () => {
    const s = mkSession(7, 4242);
    s.clientInfo = { sub: 'u1', clientId: 'c1' };
    s.ip = '10.0.0.1';
    saveSessions(dir, [s]);
    expect(fs.existsSync(path.join(dir, 'sessions.json.tmp'))).toBe(false);
    expect(loadSessions(dir)).toEqual([s]);
  });

  it('loadSessions returns [] for a missing or corrupt file', () => {
    expect(loadSessions(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{not json');
    expect(loadSessions(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"a":1}');
    expect(loadSessions(dir)).toEqual([]);
  });
});
