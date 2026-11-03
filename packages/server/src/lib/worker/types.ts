export interface WorkerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WorkerSource {
  path: string;
  repo?: string;
  revision?: string;
  hash?: string;
  startLine?: number;
  endLine?: number;
}

export interface WorkerToolResult {
  content: unknown;
  sources?: WorkerSource[];
  coverage?: string[];
  limitations?: string[];
  isError?: boolean;
}

export interface WorkerBudget {
  maxToolCalls: number;
  maxRounds: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolResultBytes: number;
  timeoutMs: number;
}

export interface WorkerRequest {
  task: string;
  mode: string;
  scope?: unknown;
  budget?: Partial<WorkerBudget>;
  signal?: AbortSignal;
}

export interface WorkerMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WorkerToolCall[];
  tool_call_id?: string;
}

export interface WorkerToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WorkerCompletion {
  content: string | null;
  toolCalls?: WorkerToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  truncated?: boolean;
}

export interface WorkerProvider {
  /** Configured identity only; never credentials or endpoint query strings. */
  model: string;
  complete(input: {
    messages: WorkerMessage[];
    tools: WorkerTool[];
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<WorkerCompletion>;
}

export interface WorkerEvidence {
  id: string;
  tool: string;
  sources: WorkerSource[];
}

export interface WorkerResult {
  status: 'complete' | 'partial' | 'cancelled' | 'failed';
  answer: string;
  findings: Array<{ claim: string; evidence_ids: string[] }>;
  evidence: WorkerEvidence[];
  coverage: { inspected: string[]; limitations: string[] };
  usage: {
    model: string;
    toolCalls: number;
    rounds: number;
    inputTokens: number;
    outputTokens: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    providerUsageComplete: boolean;
    durationMs: number;
  };
}
