/**
 * Local cross-encoder reranker (transformers.js / ONNX, CPU).
 *
 * `rerankPassages(query, passages, { topK })` scores (query, passage) pairs
 * with a sequence-classification cross-encoder and returns the passages best
 * first. Independent of the LLM reranker in lib/reranker.ts.
 *
 *   - config-gated: a no-op (input order) unless ENABLE_CROSS_ENCODER=true or
 *     the caller passes `force` (eval harness);
 *   - lazy: the model is downloaded/loaded on first use, never at boot;
 *   - batched: CROSS_ENCODER_BATCH_SIZE pairs per forward pass;
 *   - budgeted: all-or-nothing within `timeoutMs` — if the model is not loaded
 *     yet, or scoring overruns, the INPUT order is returned (`reranked:false`)
 *     and the load keeps warming in the background for the next call;
 *   - deterministic: stable sort on score, ties keep input order; only the
 *     first `topK` passages are scored, the rest keep their place after them.
 *
 * It never throws: every failure degrades to the input order.
 */

import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

export type PassageInput = string | { text: string };

export interface RerankOptions {
  /** How many leading passages to score (default CROSS_ENCODER_TOP_K). */
  topK?: number;
  /** Latency budget in ms (default CROSS_ENCODER_TIMEOUT_MS; 0 = unlimited). */
  timeoutMs?: number;
  batchSize?: number;
  /** Passage chars fed to the model (default CROSS_ENCODER_MAX_CHARS). */
  maxChars?: number;
  /** Model id override (default CROSS_ENCODER_MODEL). */
  model?: string;
  /** Run even when ENABLE_CROSS_ENCODER is off (eval / tests). */
  force?: boolean;
}

export interface RerankedPassage {
  /** Index into the `passages` array passed in. */
  index: number;
  text: string;
  /** Relevance in (0,1) (sigmoid of the model logit); null when not scored. */
  score: number | null;
}

export interface RerankOutput {
  /** All input passages, best first. */
  results: RerankedPassage[];
  /** False when the input order was returned unchanged. */
  reranked: boolean;
  reason?: 'disabled' | 'empty' | 'loading' | 'timeout' | 'busy' | 'error';
  /** Pairs scored. */
  scored: number;
  ms: number;
  model: string;
}

/** Scores (query, passage) pairs → one raw logit per pair. */
export type PairScorer = (pairs: Array<[string, string]>) => Promise<number[]>;

interface Loaded { model: string; score: PairScorer }
let loaded: Loaded | null = null;
let loading: { model: string; promise: Promise<Loaded | null> } | null = null;
let loadFailedAt = 0;
let loadFailedModel = '';
const LOAD_RETRY_MS = 5 * 60_000;
// One rerank at a time: ONNX runs serialise anyway, and a caller that timed
// out must not stack more work behind a pass that is still finishing.
let inFlight = 0;

const stats = { calls: 0, reranked: 0, timeouts: 0, errors: 0, totalMs: 0, lastLoadMs: 0 };

export function getCrossEncoderStats(): {
  enabled: boolean; model: string; loaded: boolean;
  calls: number; reranked: number; timeouts: number; errors: number; avgMs: number; lastLoadMs: number;
} {
  return {
    enabled: config.enableCrossEncoder,
    model: loaded?.model ?? config.crossEncoderModel,
    loaded: loaded !== null,
    calls: stats.calls, reranked: stats.reranked, timeouts: stats.timeouts, errors: stats.errors,
    avgMs: stats.reranked > 0 ? Math.round(stats.totalMs / stats.reranked) : 0,
    lastLoadMs: stats.lastLoadMs,
  };
}

async function loadScorer(model: string): Promise<Loaded | null> {
  const t0 = Date.now();
  try {
    const transformers: any = await import('@huggingface/transformers');
    if (transformers.env) {
      // Same persistent model cache as the embedding model.
      transformers.env.cacheDir = path.join(config.embeddingsDataDir, 'models');
      transformers.env.allowRemoteModels = true;
    }
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(model);
    const net = await transformers.AutoModelForSequenceClassification.from_pretrained(model, {
      dtype: config.crossEncoderDtype,
    });
    const score: PairScorer = async (pairs) => {
      const inputs = await tokenizer(pairs.map((p) => p[0]), {
        text_pair: pairs.map((p) => p[1]),
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const { logits } = await net(inputs);
      const data = logits.data as Float32Array;
      const width = Math.max(1, Math.round(data.length / pairs.length));
      // Single-logit rerankers (ms-marco, bge, mmarco, jina): column 0. Two-class
      // heads: the last column is the "relevant" class.
      const out: number[] = [];
      for (let i = 0; i < pairs.length; i++) out.push(data[i * width + (width - 1)]);
      return out;
    };
    stats.lastLoadMs = Date.now() - t0;
    logger.info('Cross-encoder loaded', { model, ms: stats.lastLoadMs });
    return { model, score };
  } catch (err) {
    loadFailedAt = Date.now();
    loadFailedModel = model;
    logger.warn('Cross-encoder load failed — reranking disabled for now', {
      model, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function ensureLoading(model: string): Promise<Loaded | null> {
  if (loaded && loaded.model === model) return Promise.resolve(loaded);
  if (loading && loading.model === model) return loading.promise;
  if (loadFailedModel === model && Date.now() - loadFailedAt < LOAD_RETRY_MS) return Promise.resolve(null);
  const promise = loadScorer(model).then((l) => {
    if (l) loaded = l;
    if (loading?.promise === promise) loading = null;
    return l;
  });
  loading = { model, promise };
  return promise;
}

/** Start loading the model without waiting (e.g. at boot when enabled). */
export function warmCrossEncoder(model = config.crossEncoderModel): void {
  void ensureLoading(model);
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const TIMEOUT = Symbol('timeout');
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  if (!(ms > 0)) return p;
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function rerankPassages(
  query: string,
  passages: PassageInput[],
  opts: RerankOptions = {},
): Promise<RerankOutput> {
  const t0 = Date.now();
  const model = opts.model ?? config.crossEncoderModel;
  const texts = passages.map((p) => (typeof p === 'string' ? p : p?.text ?? ''));
  const identity = (reason: RerankOutput['reason'], scored = 0): RerankOutput => ({
    results: texts.map((text, index) => ({ index, text, score: null })),
    reranked: false, reason, scored, ms: Date.now() - t0, model,
  });

  if (!opts.force && !config.enableCrossEncoder) return identity('disabled');
  const q = (query ?? '').trim();
  if (!q || texts.length === 0) return identity('empty');
  stats.calls++;

  const timeoutMs = opts.timeoutMs ?? config.crossEncoderTimeoutMs;
  const deadline = timeoutMs > 0 ? t0 + timeoutMs : Infinity;
  const topK = Math.max(1, Math.min(opts.topK ?? config.crossEncoderTopK, texts.length));
  const batchSize = Math.max(1, opts.batchSize ?? config.crossEncoderBatchSize);
  const maxChars = Math.max(1, opts.maxChars ?? config.crossEncoderMaxChars);

  try {
    const ready = await withDeadline(ensureLoading(model), timeoutMs);
    if (ready === TIMEOUT) { stats.timeouts++; return identity('loading'); }
    if (!ready) { stats.errors++; return identity('error'); }
    if (inFlight > 0 && timeoutMs > 0) return identity('busy');

    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < topK; i++) pairs.push([q, texts[i].slice(0, maxChars)]);

    let aborted = false;
    const scores: number[] = [];
    inFlight++;
    const work = (async () => {
      try {
        for (let i = 0; i < pairs.length; i += batchSize) {
          if (aborted || Date.now() > deadline) { aborted = true; return false; }
          const logits = await ready.score(pairs.slice(i, i + batchSize));
          for (const l of logits) scores.push(sigmoid(Number(l)));
        }
        return true;
      } finally {
        inFlight--;
      }
    })();
    // A pass abandoned on timeout finishes its current batch in the background;
    // swallow its outcome.
    work.catch(() => undefined);
    const done = await withDeadline(work, timeoutMs > 0 ? Math.max(1, deadline - Date.now()) : 0);
    if (done === TIMEOUT || done === false || scores.length < pairs.length) {
      aborted = true;
      stats.timeouts++;
      return identity('timeout', scores.length);
    }

    const head = pairs.map((_, index) => ({ index, text: texts[index], score: scores[index] as number | null }));
    // Array.prototype.sort is stable: equal scores keep input order.
    head.sort((a, b) => (b.score as number) - (a.score as number));
    const tail = texts.slice(topK).map((text, i) => ({ index: topK + i, text, score: null as number | null }));
    const ms = Date.now() - t0;
    stats.reranked++;
    stats.totalMs += ms;
    return { results: [...head, ...tail], reranked: true, scored: pairs.length, ms, model };
  } catch (err) {
    stats.errors++;
    logger.warn('Cross-encoder rerank failed', { error: err instanceof Error ? err.message : String(err) });
    return identity('error');
  }
}

/** Test seam: inject a fake pair scorer / reset module state. */
export const __crossEncoderTestHooks = {
  install(score: PairScorer, model = config.crossEncoderModel): void {
    loaded = { model, score };
    loading = null;
    loadFailedAt = 0;
    loadFailedModel = '';
    inFlight = 0;
  },
  /** Simulate a model that is still loading (resolves when `release` is called). */
  installPending(model = config.crossEncoderModel): { release: (score: PairScorer) => void } {
    loaded = null;
    let release!: (score: PairScorer) => void;
    const promise = new Promise<Loaded | null>((resolve) => {
      release = (score) => { loaded = { model, score }; loading = null; resolve(loaded); };
    });
    loading = { model, promise };
    return { release };
  },
  reset(): void {
    loaded = null; loading = null; loadFailedAt = 0; loadFailedModel = ''; inFlight = 0;
    stats.calls = stats.reranked = stats.timeouts = stats.errors = stats.totalMs = stats.lastLoadMs = 0;
  },
};
