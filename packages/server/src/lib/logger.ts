import { config } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  source?: string;
  meta?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Ring buffer for dashboard streaming
const LOG_BUFFER_SIZE = 200;
const logBuffer: LogEntry[] = [];

function inferSource(message: string): string {
  const msg = message.toLowerCase();
  if (msg.includes('embed') || msg.includes('hnsw') || msg.includes('vector')) return 'embeddings';
  if (msg.includes('index') || msg.includes('search') || msg.includes('minisearch')) return 'search';
  if (msg.includes('vault') || msg.includes('note') || msg.includes('file')) return 'vault';
  if (msg.includes('auth') || msg.includes('oauth') || msg.includes('token')) return 'auth';
  if (msg.includes('session')) return 'sessions';
  if (msg.includes('metric') || msg.includes('persist')) return 'metrics';
  if (msg.includes('rate') || msg.includes('limit')) return 'ratelimit';
  if (msg.includes('listen') || msg.includes('startup') || msg.includes('starting') || msg.includes('shutdown')) return 'server';
  return 'general';
}

function shouldLog(level: LogLevel): boolean {
  const configuredLevel = (config.logLevel ?? 'info') as LogLevel;
  return LEVEL_ORDER[level] >= (LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info);
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };

  if (meta !== undefined) {
    entry.meta = meta;
  }

  // Infer source from message prefix or meta
  const source = (meta?.source as string) ?? inferSource(message);

  // Push to ring buffer for dashboard
  const logEntry: LogEntry = { timestamp: Date.now(), level, message, source, meta };
  logBuffer.push(logEntry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_SIZE);
  }

  const line = JSON.stringify(entry);

  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

/**
 * Returns the most recent log entries (up to 200).
 */
export function getRecentLogs(): LogEntry[] {
  return logBuffer.slice();
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    emit('debug', message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    emit('info', message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    emit('warn', message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    emit('error', message, meta);
  },
};
