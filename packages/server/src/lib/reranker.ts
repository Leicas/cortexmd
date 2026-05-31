import { config } from '../config.js';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type RerankerProvider = 'anthropic' | 'openai-compatible' | 'none';

export interface RerankerCandidate {
  index: number;
  title: string;
  snippet: string;
}

export interface RerankerMetrics {
  provider: string;
  enabled: boolean;
  totalCalls: number;
  totalErrors: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  lastCallTimestamp: number;
  fallbackCount: number;
  circuitBreaker: { state: string; consecutiveFailures: number };
}

// ── State ──────────────────────────────────────────────────────────────

let resolvedProvider: RerankerProvider = 'none';
let metricsState = {
  totalCalls: 0,
  totalErrors: 0,
  totalLatencyMs: 0,
  lastCallTimestamp: 0,
  fallbackCount: 0,
};

// ── Circuit breaker ───────────────────────────────────────────────────

type BreakerState = 'closed' | 'open' | 'half-open';
const MAX_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

let consecutiveFailures = 0;
let breakerState: BreakerState = 'closed';
let breakerOpenedAt = 0;

function breakerAllows(): boolean {
  if (breakerState === 'closed') return true;
  if (breakerState === 'open') {
    if (Date.now() - breakerOpenedAt >= COOLDOWN_MS) {
      breakerState = 'half-open';
      logger.info('Reranker circuit breaker entering half-open state');
      return true; // allow one probe
    }
    return false;
  }
  // half-open: allow the probe request
  return true;
}

function breakerRecordSuccess(): void {
  if (breakerState === 'half-open') {
    logger.info('Reranker circuit breaker reset to closed');
  }
  consecutiveFailures = 0;
  breakerState = 'closed';
}

function breakerRecordFailure(): void {
  consecutiveFailures++;
  if (breakerState === 'half-open') {
    breakerState = 'open';
    breakerOpenedAt = Date.now();
    logger.warn('Reranker circuit breaker re-opened after probe failure');
  } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    breakerState = 'open';
    breakerOpenedAt = Date.now();
    logger.warn('Reranker circuit breaker opened', { consecutiveFailures });
  }
}

// ── Provider resolution ────────────────────────────────────────────────

/**
 * Resolve which reranker provider to use based on config/env.
 * Called once at module load and cached.
 */
function resolveProvider(): RerankerProvider {
  // Explicitly disabled
  if (!config.enableReranker) {
    return 'none';
  }

  const explicit = config.rerankerProvider;

  if (explicit === 'openai-compatible') {
    if (config.rerankerBaseUrl) {
      return 'openai-compatible';
    }
    logger.warn('RERANKER_PROVIDER=openai-compatible but RERANKER_BASE_URL not set — reranker disabled');
    return 'none';
  }

  if (explicit === 'anthropic') {
    if (config.anthropicApiKey) {
      return 'anthropic';
    }
    logger.warn('RERANKER_PROVIDER=anthropic but ANTHROPIC_API_KEY not set — reranker disabled');
    return 'none';
  }

  // Auto-detect: if no explicit provider, try anthropic first
  if (config.anthropicApiKey) {
    return 'anthropic';
  }

  if (config.rerankerBaseUrl) {
    return 'openai-compatible';
  }

  // ENABLE_RERANKER=true but nothing configured
  logger.warn('ENABLE_RERANKER=true but no reranker provider configured (need ANTHROPIC_API_KEY or RERANKER_BASE_URL) — reranker disabled');
  return 'none';
}

// Resolve once at module load
resolvedProvider = resolveProvider();

if (resolvedProvider !== 'none') {
  logger.info('Reranker enabled', { provider: resolvedProvider, model: config.rerankerModel });
}

// ── Public API ─────────────────────────────────────────────────────────

export function isRerankerEnabled(): boolean {
  return resolvedProvider !== 'none';
}

export function getRerankerProvider(): RerankerProvider {
  return resolvedProvider;
}

export function getRerankerMetrics(): RerankerMetrics {
  return {
    provider: resolvedProvider,
    enabled: resolvedProvider !== 'none',
    totalCalls: metricsState.totalCalls,
    totalErrors: metricsState.totalErrors,
    totalLatencyMs: metricsState.totalLatencyMs,
    avgLatencyMs: metricsState.totalCalls > 0
      ? Math.round(metricsState.totalLatencyMs / metricsState.totalCalls)
      : 0,
    lastCallTimestamp: metricsState.lastCallTimestamp,
    fallbackCount: metricsState.fallbackCount,
    circuitBreaker: { state: breakerState, consecutiveFailures },
  };
}

/**
 * Re-rank search results using the configured LLM provider.
 * Returns indices into the original `candidates` array, ordered by relevance.
 * Falls back to original order on any failure.
 *
 * The function signature is stable — internal implementation varies by provider.
 */
export async function rerankResults(
  query: string,
  candidates: RerankerCandidate[],
): Promise<number[]> {
  const fallback = candidates.map((_, i) => i);
  if (resolvedProvider === 'none' || candidates.length === 0) {
    return fallback;
  }

  // Circuit breaker: skip if open
  if (!breakerAllows()) {
    metricsState.fallbackCount++;
    return fallback;
  }

  const start = Date.now();
  metricsState.totalCalls++;
  metricsState.lastCallTimestamp = start;

  try {
    let ranking: number[];

    if (resolvedProvider === 'anthropic') {
      ranking = await rerankWithAnthropic(query, candidates);
    } else {
      ranking = await rerankWithOpenAICompatible(query, candidates);
    }

    metricsState.totalLatencyMs += Date.now() - start;
    breakerRecordSuccess();
    return ranking;
  } catch (err) {
    metricsState.totalErrors++;
    metricsState.fallbackCount++;
    metricsState.totalLatencyMs += Date.now() - start;
    breakerRecordFailure();
    logger.warn('Reranker failed, falling back to original order', {
      provider: resolvedProvider,
      error: err instanceof Error ? err.message : String(err),
      breakerState,
      consecutiveFailures,
    });
    return fallback;
  }
}

// ── Anthropic provider ─────────────────────────────────────────────────

async function rerankWithAnthropic(
  query: string,
  candidates: RerankerCandidate[],
): Promise<number[]> {
  // Lazy import to avoid hard dep if not using Anthropic
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.title} — ${c.snippet.slice(0, 100)}`)
    .join('\n');

  const response = await client.messages.create({
    model: config.rerankerModel,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: buildRerankPrompt(query, candidateList),
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => {
      const b = block as unknown as { text: string };
      return b.text;
    })
    .join('');

  return parseRankingResponse(text, candidates.length);
}

// ── OpenAI-compatible provider ─────────────────────────────────────────

async function rerankWithOpenAICompatible(
  query: string,
  candidates: RerankerCandidate[],
): Promise<number[]> {
  const baseUrl = config.rerankerBaseUrl!;
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.title} — ${c.snippet.slice(0, 100)}`)
    .join('\n');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.rerankerApiKey) {
    headers['Authorization'] = `Bearer ${config.rerankerApiKey}`;
  }

  const body: Record<string, unknown> = {
    model: config.rerankerModel,
    messages: [
      {
        role: 'system',
        content:
          'You are a search result ranker. Given a query and numbered search results, ' +
          'return a JSON object with a "ranking" array containing the result numbers ordered ' +
          'from most to least relevant. Only include results that are relevant.',
      },
      {
        role: 'user',
        content: buildRerankPrompt(query, candidateList),
      },
    ],
    max_tokens: 256,
    temperature: 0,
    stream: false,
  };

  // Request JSON format if supported (most OpenAI-compatible servers handle this)
  body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.rerankerTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>');
      throw new Error(`OpenAI-compatible API returned ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    const text = data?.choices?.[0]?.message?.content ?? '';
    return parseRankingResponse(text, candidates.length);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Prompt construction ────────────────────────────────────────────────

function buildRerankPrompt(query: string, candidateList: string): string {
  return (
    `Query: "${query}"\n\n` +
    `Results:\n${candidateList}\n\n` +
    `Respond with JSON only: {"ranking": [3, 1, 5, ...]}`
  );
}

// ── Response parsing (tolerant) ────────────────────────────────────────

/**
 * Parse a ranking response from the LLM. Extremely tolerant:
 * 1. Try JSON.parse for `{"ranking": [...]}`
 * 2. Look for an array pattern `[digits, ...]` via regex
 * 3. Look for comma-separated numbers
 * 4. Validate indices, deduplicate, ignore out-of-range
 * 5. Fall back to original order if < 50% recovered
 */
function parseRankingResponse(text: string, candidateCount: number): number[] {
  const originalOrder = Array.from({ length: candidateCount }, (_, i) => i);

  if (!text || !text.trim()) {
    metricsState.fallbackCount++;
    return originalOrder;
  }

  let rawNumbers: number[] | null = null;

  // Strategy 1: JSON.parse
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.ranking)) {
      rawNumbers = parsed.ranking.filter((n: unknown) => typeof n === 'number');
    } else if (Array.isArray(parsed)) {
      rawNumbers = parsed.filter((n: unknown) => typeof n === 'number');
    }
  } catch {
    // not valid JSON, try regex
  }

  // Strategy 2: regex for array pattern [1, 3, 5, ...]
  if (!rawNumbers) {
    const arrayMatch = text.match(/\[[\d,\s]+\]/);
    if (arrayMatch) {
      try {
        const arr = JSON.parse(arrayMatch[0]);
        if (Array.isArray(arr)) {
          rawNumbers = arr.filter((n: unknown) => typeof n === 'number');
        }
      } catch {
        // try next strategy
      }
    }
  }

  // Strategy 3: comma-separated numbers anywhere in text
  if (!rawNumbers) {
    const numberMatches = text.match(/\d+/g);
    if (numberMatches) {
      rawNumbers = numberMatches.map(Number);
    }
  }

  if (!rawNumbers || rawNumbers.length === 0) {
    metricsState.fallbackCount++;
    return originalOrder;
  }

  // Convert 1-based to 0-based indices, deduplicate, filter out-of-range
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const num of rawNumbers) {
    const idx = num - 1; // 1-based to 0-based
    if (idx >= 0 && idx < candidateCount && !seen.has(idx)) {
      seen.add(idx);
      indices.push(idx);
    }
  }

  // If we recovered fewer than 50% of candidates, fall back
  if (indices.length < candidateCount * 0.5) {
    metricsState.fallbackCount++;
    logger.debug('Reranker response recovered too few indices, falling back', {
      recovered: indices.length,
      total: candidateCount,
    });
    return originalOrder;
  }

  // Append any missing indices at the end (preserve their original relative order)
  for (let i = 0; i < candidateCount; i++) {
    if (!seen.has(i)) {
      indices.push(i);
    }
  }

  return indices;
}
