import { logger } from './logger.js';

export interface ToolMetaEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let toolsMeta: ToolMetaEntry[] = [];
const toolEmbeddings = new Map<string, number[]>();
let embeddingsBuildPromise: Promise<void> | null = null;
let embeddingsBuilt = false;

function zodShapeToJsonSchema(shape: Record<string, unknown>): Record<string, unknown> {
  try {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, raw] of Object.entries(shape)) {
      const z = raw as { _def?: any; isOptional?: () => boolean; description?: string };
      const def = z._def ?? {};
      const typeName = def.typeName as string | undefined;
      const desc = (def.description as string | undefined) ?? '';
      const isOpt =
        typeof z.isOptional === 'function' ? z.isOptional() :
        typeName === 'ZodOptional' || typeName === 'ZodDefault';

      const prop: Record<string, unknown> = {};
      let inner = def;
      let innerName = typeName;
      if (innerName === 'ZodOptional' || innerName === 'ZodDefault') {
        inner = inner.innerType?._def ?? inner;
        innerName = inner.typeName;
      }

      if (innerName === 'ZodString') prop.type = 'string';
      else if (innerName === 'ZodNumber') prop.type = 'number';
      else if (innerName === 'ZodBoolean') prop.type = 'boolean';
      else if (innerName === 'ZodArray') {
        prop.type = 'array';
        const item = inner.type?._def?.typeName;
        if (item === 'ZodString') prop.items = { type: 'string' };
        else if (item === 'ZodNumber') prop.items = { type: 'number' };
        else if (inner.type?._def?.typeName === 'ZodEnum') {
          prop.items = { type: 'string', enum: inner.type._def.values };
        }
      } else if (innerName === 'ZodEnum') {
        prop.type = 'string';
        prop.enum = inner.values;
      } else if (innerName === 'ZodObject') {
        prop.type = 'object';
      } else {
        prop.type = innerName ?? 'unknown';
      }

      if (desc) prop.description = desc;
      properties[key] = prop;
      if (!isOpt) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  } catch (err) {
    logger.debug('zodShapeToJsonSchema failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { type: 'object' };
  }
}

/**
 * Snapshot tool metadata from a freshly-registered McpServer instance.
 * Reads the SDK's internal `_registeredTools` map. Idempotent — once tools
 * have been captured, subsequent calls are a no-op (the registry shape is
 * deterministic across server instances, so re-running would just discard
 * the embeddings cache for no benefit).
 */
export function snapshotTools(server: unknown): void {
  if (toolsMeta.length > 0) return;
  try {
    const reg = (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
    const list: ToolMetaEntry[] = [];
    for (const [name, raw] of Object.entries(reg)) {
      const tool = raw as { description?: string; inputSchema?: unknown };
      const description = tool.description ?? '';
      let inputSchema: Record<string, unknown> = { type: 'object' };
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        // SDK stores Zod raw shape under inputSchema. Convert to a JSON-Schema-shaped object.
        inputSchema = zodShapeToJsonSchema(tool.inputSchema as Record<string, unknown>);
      }
      list.push({ name, description, inputSchema });
    }
    toolsMeta = list;
    logger.info('Tool registry snapshotted', { count: list.length });
  } catch (err) {
    logger.warn('snapshotTools failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getToolsMeta(): ReadonlyArray<ToolMetaEntry> {
  return toolsMeta;
}

export function isToolEmbeddingsBuilt(): boolean {
  return embeddingsBuilt;
}

export function getToolEmbedding(name: string): number[] | undefined {
  return toolEmbeddings.get(name);
}

/**
 * Build embeddings for all tool descriptions. Cached after first call.
 * Idempotent: concurrent callers share a single in-flight promise.
 * Silent no-op if embeddings aren't ready.
 */
export async function buildToolEmbeddings(): Promise<void> {
  if (embeddingsBuilt) return;
  if (embeddingsBuildPromise) return embeddingsBuildPromise;

  embeddingsBuildPromise = (async () => {
    try {
      const { isEmbeddingsReady, embedText } = await import('./embeddings.js');
      if (!isEmbeddingsReady()) return;
      for (const t of toolsMeta) {
        try {
          const text = `${t.name} ${t.description}`.slice(0, 1024);
          const vec = await embedText(text);
          toolEmbeddings.set(t.name, vec);
        } catch {
          /* skip individual failures */
        }
      }
      embeddingsBuilt = true;
      logger.info('Tool embeddings built', { count: toolEmbeddings.size });
    } catch (err) {
      logger.warn('buildToolEmbeddings failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      embeddingsBuildPromise = null;
    }
  })();

  return embeddingsBuildPromise;
}
