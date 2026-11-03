import type { WorkerProvider, WorkerCompletion, WorkerToolCall } from './types.js';

export interface CompatibleProviderOptions {
  /** Exact chat-completions endpoint supplied by server configuration. */
  endpoint: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}

function validCalls(value: unknown): value is WorkerToolCall[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (call) =>
        call &&
        typeof call.id === 'string' &&
        call.id.length > 0 &&
        call.id.length <= 256 &&
        call.type === 'function' &&
        typeof call.function?.name === 'string' &&
        typeof call.function?.arguments === 'string',
    )
  );
}

/** No SDK dependency, credential fallback, model escalation, or automatic retries. */
export function createCompatibleProvider(options: CompatibleProviderOptions): WorkerProvider {
  const endpoint = new URL(options.endpoint);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error('Invalid worker provider endpoint');
  }
  if (!options.model.trim()) throw new Error('Worker model is required');
  const fetcher = options.fetch ?? fetch;
  const ceiling = options.maxResponseBytes ?? 1_048_576;
  return {
    model: options.model,
    async complete(input): Promise<WorkerCompletion> {
      const response = await fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: input.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: input.messages,
          stream: false,
          max_tokens: input.maxOutputTokens,
          ...(input.tools.length
            ? {
                tools: input.tools.map((tool) => ({ type: 'function', function: tool })),
                tool_choice: 'auto',
                parallel_tool_calls: false,
              }
            : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Worker provider returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error('Worker provider returned an empty response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > ceiling) throw new Error('Worker provider response exceeds limit');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Error('Worker provider returned invalid JSON');
      }
      const choice = body.choices?.[0];
      const message = choice?.message;
      if (
        !message ||
        (message.content !== null && typeof message.content !== 'string') ||
        (message.tool_calls !== undefined && !validCalls(message.tool_calls))
      ) {
        throw new Error('Worker provider returned an invalid completion');
      }
      const usage = body.usage;
      const validUsage =
        Number.isSafeInteger(usage?.prompt_tokens) &&
        usage.prompt_tokens >= 0 &&
        Number.isSafeInteger(usage?.completion_tokens) &&
        usage.completion_tokens >= 0;
      return {
        content: message.content,
        toolCalls: message.tool_calls,
        truncated: choice.finish_reason === 'length',
        ...(validUsage
          ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
          : {}),
      };
    },
  };
}
