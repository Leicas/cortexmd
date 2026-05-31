/**
 * Module-singleton mutable dashboard state.
 *
 * These values are read/written across SSE pushes and admin action handlers.
 * Extracted verbatim from the legacy `dashboard.ts` module scope. Exposed via
 * typed getters/setters so route + payload modules never touch the raw `let`s.
 */
import type { MemoryLayer } from '../../lib/memory-stack.js';
import type { DreamReport } from '../../lib/dream-engine.js';

const MAX_DREAM_HISTORY = 50;

/** Async memory-stack data cached across SSE pushes (show-last-value semantics). */
let memoryStackCache: MemoryLayer[] = [];

/** Async agent-diary data cached across SSE pushes. */
let agentDiaryCache: Array<{ agentId: string; lastActive: string; entryCount: number }> = [];

/** Dream report history (in-memory, capped at MAX_DREAM_HISTORY). */
let dreamHistory: DreamReport[] = [];
let lastDreamReport: DreamReport | null = null;
let dreamRunning = false;

/** LLM availability + recent suggestion tracking. */
export interface LlmStatus {
  available: boolean;
  lastCheck: number;
  lastError?: string;
  recentSuggestions: Array<{ group: string; summary: string; timestamp: string }>;
}
const llmStatus: LlmStatus = {
  available: false,
  lastCheck: 0,
  recentSuggestions: [],
};

/** Dismissed suggestion keys (session-scoped). */
const dismissedSuggestions = new Set<string>();

// ── Memory stack cache ──────────────────────────────────────────────────────
export const getMemoryStackCache = (): MemoryLayer[] => memoryStackCache;
export const setMemoryStackCache = (layers: MemoryLayer[]): void => { memoryStackCache = layers; };

// ── Agent diary cache ───────────────────────────────────────────────────────
export const getAgentDiaryCache = (): Array<{ agentId: string; lastActive: string; entryCount: number }> => agentDiaryCache;
export const setAgentDiaryCache = (
  v: Array<{ agentId: string; lastActive: string; entryCount: number }>,
): void => { agentDiaryCache = v; };

// ── Dream history / last report ─────────────────────────────────────────────
export const getDreamHistory = (): DreamReport[] => dreamHistory;
export const getLastDreamReport = (): DreamReport | null => lastDreamReport;
export const recordDreamReport = (report: DreamReport): void => {
  lastDreamReport = report;
  dreamHistory.push(report);
  if (dreamHistory.length > MAX_DREAM_HISTORY) {
    dreamHistory = dreamHistory.slice(-MAX_DREAM_HISTORY);
  }
};

// ── Dream running flag ──────────────────────────────────────────────────────
export const isDreamRunning = (): boolean => dreamRunning;
export const setDreamRunning = (v: boolean): void => { dreamRunning = v; };

// ── LLM status ──────────────────────────────────────────────────────────────
export const getLlmStatus = (): LlmStatus => llmStatus;

// ── Dismissed suggestions ───────────────────────────────────────────────────
export const dismissSuggestion = (key: string): void => { dismissedSuggestions.add(key); };
export const isDismissed = (key: string): boolean => dismissedSuggestions.has(key);
