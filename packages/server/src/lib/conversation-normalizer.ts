import { logger } from './logger.js';

/**
 * Conversation normalizer — converts various AI conversation export formats
 * into a common Exchange[] format for downstream mining.
 *
 * Supported formats:
 *   - claude-code:  JSONL with type:"human" / type:"assistant"
 *   - codex:        JSONL with event_msg (role-based) + session_meta
 *   - claude-ai:    JSON array with sender:"human"/"assistant" or nested chat_messages
 *   - chatgpt:      conversations.json tree with mapping object
 *   - slack:         JSON array of messages with text/user fields
 *   - plain:         Lines starting with > are user turns; rest is assistant
 */

export interface Exchange {
  userMessage: string;
  assistantMessage: string;
  timestamp?: string;
  source: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Claude Code JSONL
// ---------------------------------------------------------------------------

function parseClaudeCodeJsonl(raw: string): Exchange[] {
  const exchanges: Exchange[] = [];
  try {
    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    let i = 0;
    while (i < parsed.length) {
      const current = parsed[i];
      if (current.type === 'human') {
        const userMsg = extractMessageText(current);
        // Look for next assistant message
        let assistantMsg = '';
        let timestamp: string | undefined;
        for (let j = i + 1; j < parsed.length; j++) {
          if (parsed[j].type === 'assistant') {
            assistantMsg = extractMessageText(parsed[j]);
            timestamp =
              typeof parsed[j].timestamp === 'string'
                ? (parsed[j].timestamp as string)
                : undefined;
            i = j + 1;
            break;
          }
          if (parsed[j].type === 'human') {
            // No assistant response found before next human
            i = j;
            break;
          }
        }
        if (i <= parsed.indexOf(current)) i = i + 1; // prevent infinite loop
        if (userMsg || assistantMsg) {
          exchanges.push({
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            timestamp,
            source: 'claude-code',
          });
        }
        continue;
      }
      i++;
    }
  } catch (err) {
    logger.warn('Conversation parse failed', { format: 'claude-code', error: String(err) });
  }
  return exchanges;
}

// ---------------------------------------------------------------------------
// OpenAI Codex JSONL
// ---------------------------------------------------------------------------

function parseCodexJsonl(raw: string): Exchange[] {
  const exchanges: Exchange[] = [];
  try {
    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed: Array<Record<string, unknown>> = [];
    let sessionId: string | undefined;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.session_meta && typeof obj.session_meta === 'object') {
          sessionId =
            typeof (obj.session_meta as Record<string, unknown>).id === 'string'
              ? ((obj.session_meta as Record<string, unknown>).id as string)
              : undefined;
        }
        if (obj.event_msg || obj.role) {
          parsed.push(obj);
        }
      } catch {
        // skip malformed lines
      }
    }

    let i = 0;
    while (i < parsed.length) {
      const current = parsed[i];
      const role = extractRole(current);
      if (role === 'user') {
        const userMsg = extractMessageText(current);
        let assistantMsg = '';
        let timestamp: string | undefined;
        for (let j = i + 1; j < parsed.length; j++) {
          const nextRole = extractRole(parsed[j]);
          if (nextRole === 'assistant') {
            assistantMsg = extractMessageText(parsed[j]);
            timestamp =
              typeof parsed[j].timestamp === 'string'
                ? (parsed[j].timestamp as string)
                : undefined;
            i = j + 1;
            break;
          }
          if (nextRole === 'user') {
            i = j;
            break;
          }
        }
        if (i <= parsed.indexOf(current)) i++;
        if (userMsg || assistantMsg) {
          exchanges.push({
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            timestamp,
            source: 'codex',
            sessionId,
          });
        }
        continue;
      }
      i++;
    }
  } catch (err) {
    logger.warn('Conversation parse failed', { format: 'codex', error: String(err) });
  }
  return exchanges;
}

// ---------------------------------------------------------------------------
// Claude.ai JSON
// ---------------------------------------------------------------------------

function parseClaudeAiJson(raw: string): Exchange[] {
  const exchanges: Exchange[] = [];
  try {
    const data = JSON.parse(raw);
    const messages: Array<Record<string, unknown>> = [];

    if (Array.isArray(data)) {
      // Could be a direct array of messages or an array of conversations
      for (const item of data) {
        if (item.sender && (item.sender === 'human' || item.sender === 'assistant')) {
          messages.push(item);
        } else if (Array.isArray(item.chat_messages)) {
          messages.push(...(item.chat_messages as Array<Record<string, unknown>>));
        }
      }
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.chat_messages)) {
        messages.push(...(data.chat_messages as Array<Record<string, unknown>>));
      }
    }

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.sender === 'human') {
        const userMsg = extractMessageText(msg);
        let assistantMsg = '';
        let timestamp: string | undefined;
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].sender === 'assistant') {
            assistantMsg = extractMessageText(messages[j]);
            timestamp =
              typeof messages[j].created_at === 'string'
                ? (messages[j].created_at as string)
                : typeof messages[j].updated_at === 'string'
                  ? (messages[j].updated_at as string)
                  : undefined;
            i = j + 1;
            break;
          }
          if (messages[j].sender === 'human') {
            i = j;
            break;
          }
        }
        if (i <= messages.indexOf(msg)) i++;
        if (userMsg || assistantMsg) {
          exchanges.push({
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            timestamp,
            source: 'claude-ai',
          });
        }
        continue;
      }
      i++;
    }
  } catch (err) {
    logger.warn('Conversation parse failed', { format: 'claude-ai', error: String(err) });
  }
  return exchanges;
}

// ---------------------------------------------------------------------------
// ChatGPT conversations.json
// ---------------------------------------------------------------------------

function parseChatGptJson(raw: string): Exchange[] {
  const exchanges: Exchange[] = [];
  try {
    const data = JSON.parse(raw);
    const conversations: Array<Record<string, unknown>> = Array.isArray(data) ? data : [data];

    for (const convo of conversations) {
      const mapping = convo.mapping as Record<string, Record<string, unknown>> | undefined;
      if (!mapping || typeof mapping !== 'object') continue;

      // Build the linear chain from the tree structure
      const linearMessages = flattenChatGptMapping(mapping);

      let i = 0;
      while (i < linearMessages.length) {
        const msg = linearMessages[i];
        if (msg.role === 'user') {
          const userMsg = msg.text;
          let assistantMsg = '';
          let timestamp: string | undefined;
          for (let j = i + 1; j < linearMessages.length; j++) {
            if (linearMessages[j].role === 'assistant') {
              assistantMsg = linearMessages[j].text;
              timestamp = linearMessages[j].timestamp;
              i = j + 1;
              break;
            }
            if (linearMessages[j].role === 'user') {
              i = j;
              break;
            }
          }
          if (i <= linearMessages.indexOf(msg)) i++;
          if (userMsg || assistantMsg) {
            exchanges.push({
              userMessage: userMsg,
              assistantMessage: assistantMsg,
              timestamp,
              source: 'chatgpt',
            });
          }
          continue;
        }
        i++;
      }
    }
  } catch (err) {
    logger.warn('Conversation parse failed', { format: 'chatgpt', error: String(err) });
  }
  return exchanges;
}

/**
 * Flatten ChatGPT's tree-structured mapping into a linear message list.
 * Each node has an optional parent; we walk from roots to leaves,
 * choosing the first child at each branch.
 */
function flattenChatGptMapping(
  mapping: Record<string, Record<string, unknown>>,
): Array<{ role: string; text: string; timestamp?: string }> {
  // Build parent->children map
  const children = new Map<string, string[]>();
  let rootIds: string[] = [];

  for (const [nodeId, node] of Object.entries(mapping)) {
    const parentId = node.parent as string | null | undefined;
    if (!parentId) {
      rootIds.push(nodeId);
    } else {
      const existing = children.get(parentId) ?? [];
      existing.push(nodeId);
      children.set(parentId, existing);
    }
  }

  // If no explicit roots, find nodes that aren't anyone's child
  if (rootIds.length === 0) {
    const allChildIds = new Set<string>();
    for (const kids of children.values()) {
      for (const kid of kids) allChildIds.add(kid);
    }
    rootIds = Object.keys(mapping).filter((id) => !allChildIds.has(id));
  }

  // Walk from root, always following first child
  const result: Array<{ role: string; text: string; timestamp?: string }> = [];
  const visited = new Set<string>();

  function walk(nodeId: string): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = mapping[nodeId];
    if (!node) return;

    const message = node.message as Record<string, unknown> | undefined;
    if (message) {
      const role = (message.author as Record<string, unknown>)?.role as string | undefined
        ?? message.role as string | undefined
        ?? '';
      const text = extractChatGptContent(message);
      const createTime = message.create_time as number | undefined
        ?? node.create_time as number | undefined;
      const timestamp = createTime
        ? new Date(createTime * 1000).toISOString()
        : undefined;

      if ((role === 'user' || role === 'assistant') && text) {
        result.push({ role, text, timestamp });
      }
    }

    // Follow children (first child for the main branch)
    const kids = children.get(nodeId) ?? (node.children as string[] | undefined) ?? [];
    for (const kid of kids) {
      walk(kid);
    }
  }

  for (const root of rootIds) {
    walk(root);
  }

  return result;
}

/**
 * Extract text content from a ChatGPT message node.
 */
function extractChatGptContent(message: Record<string, unknown>): string {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content) return '';

  const parts = content.parts as unknown[] | undefined;
  if (Array.isArray(parts)) {
    const texts: string[] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        texts.push(part);
      } else if (part && typeof part === 'object' && 'text' in (part as Record<string, unknown>)) {
        texts.push(String((part as Record<string, unknown>).text));
      }
    }
    return texts.join('\n').trim();
  }

  if (typeof content.text === 'string') {
    return content.text;
  }

  return '';
}

// ---------------------------------------------------------------------------
// Slack JSON
// ---------------------------------------------------------------------------

function parseSlackJson(raw: string): Exchange[] {
  const exchanges: Exchange[] = [];
  try {
    const data = JSON.parse(raw);
    const messages: Array<Record<string, unknown>> = Array.isArray(data) ? data : [];

    // Determine which user IDs are bots
    const botUsers = new Set<string>();
    for (const msg of messages) {
      if (msg.bot_id || msg.subtype === 'bot_message') {
        if (typeof msg.user === 'string') botUsers.add(msg.user);
      }
    }

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      const isBot = msg.bot_id || msg.subtype === 'bot_message' || botUsers.has(msg.user as string);

      if (!isBot && typeof msg.text === 'string') {
        const userMsg = msg.text as string;
        let assistantMsg = '';
        let timestamp: string | undefined;

        for (let j = i + 1; j < messages.length; j++) {
          const next = messages[j];
          const nextIsBot = next.bot_id || next.subtype === 'bot_message' || botUsers.has(next.user as string);
          if (nextIsBot && typeof next.text === 'string') {
            assistantMsg = next.text as string;
            timestamp = typeof next.ts === 'string'
              ? new Date(parseFloat(next.ts as string) * 1000).toISOString()
              : undefined;
            i = j + 1;
            break;
          }
          if (!nextIsBot) {
            i = j;
            break;
          }
        }
        if (i <= messages.indexOf(msg)) i++;
        if (userMsg || assistantMsg) {
          exchanges.push({
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            timestamp,
            source: 'slack',
          });
        }
        continue;
      }
      i++;
    }
  } catch (err) {
    logger.warn('Conversation parse failed', { format: 'slack', error: String(err) });
  }
  return exchanges;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function parsePlainText(raw: string): Exchange[] {
  const exchanges: Exchange[] = [];
  try {
    const lines = raw.split('\n');
    let currentUser: string[] = [];
    let currentAssistant: string[] = [];
    let collectingUser = false;

    function flush(): void {
      if (currentUser.length > 0 || currentAssistant.length > 0) {
        exchanges.push({
          userMessage: currentUser.join('\n').trim(),
          assistantMessage: currentAssistant.join('\n').trim(),
          source: 'plain',
        });
        currentUser = [];
        currentAssistant = [];
      }
    }

    for (const line of lines) {
      if (line.startsWith('>')) {
        if (collectingUser && currentAssistant.length > 0) {
          // New user turn after an assistant block — flush
          flush();
        } else if (!collectingUser && currentUser.length > 0 && currentAssistant.length > 0) {
          flush();
        }
        // Strip the > prefix
        currentUser.push(line.replace(/^>\s?/, ''));
        collectingUser = true;
      } else {
        if (collectingUser) {
          collectingUser = false;
        }
        currentAssistant.push(line);
      }
    }

    flush();
  } catch (err) {
    logger.warn('Conversation parse failed', { format: 'plain', error: String(err) });
  }
  return exchanges;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessageText(obj: Record<string, unknown>): string {
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;

  // Handle nested content objects
  if (obj.content && typeof obj.content === 'object') {
    const content = obj.content as Record<string, unknown>;
    if (typeof content.text === 'string') return content.text;
    if (Array.isArray(content.parts)) {
      return content.parts
        .filter((p): p is string => typeof p === 'string')
        .join('\n');
    }
  }

  // Handle event_msg wrapper (Codex)
  if (obj.event_msg && typeof obj.event_msg === 'object') {
    const eventMsg = obj.event_msg as Record<string, unknown>;
    return extractMessageText(eventMsg);
  }

  return '';
}

function extractRole(obj: Record<string, unknown>): string {
  if (typeof obj.role === 'string') return obj.role;
  if (obj.event_msg && typeof obj.event_msg === 'object') {
    const eventMsg = obj.event_msg as Record<string, unknown>;
    if (typeof eventMsg.role === 'string') return eventMsg.role;
  }
  if (typeof obj.type === 'string') {
    if (obj.type === 'human') return 'user';
    if (obj.type === 'assistant') return 'assistant';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const FORMAT_MAP: Record<string, (raw: string) => Exchange[]> = {
  'claude-code': parseClaudeCodeJsonl,
  'codex': parseCodexJsonl,
  'claude-ai': parseClaudeAiJson,
  'chatgpt': parseChatGptJson,
  'slack': parseSlackJson,
  'plain': parsePlainText,
};

/**
 * Examine the first 2KB of raw content to auto-detect the conversation format.
 */
export function autoDetectFormat(raw: string): string {
  const sample = raw.slice(0, 2048);

  // JSONL with type:"human" / type:"assistant" → Claude Code
  if (/\"type\"\s*:\s*\"human\"/.test(sample) && /\"type\"\s*:\s*\"assistant\"/.test(sample)) {
    return 'claude-code';
  }

  // JSONL with event_msg or session_meta → Codex
  if (/\"event_msg\"/.test(sample) || /\"session_meta\"/.test(sample)) {
    return 'codex';
  }

  // JSON with mapping object → ChatGPT
  if (/\"mapping\"\s*:/.test(sample) && /\"parent\"\s*:/.test(sample)) {
    return 'chatgpt';
  }

  // JSON with sender:"human"/"assistant" or chat_messages → Claude.ai
  if (/\"sender\"\s*:\s*\"(human|assistant)\"/.test(sample) || /\"chat_messages\"/.test(sample)) {
    return 'claude-ai';
  }

  // JSON array with bot_id or subtype:"bot_message" → Slack
  if (/\"bot_id\"/.test(sample) || /\"subtype\"\s*:\s*\"bot_message\"/.test(sample)) {
    return 'slack';
  }

  // Lines starting with > → plain text
  if (/^>/m.test(sample)) {
    return 'plain';
  }

  // Default to plain text
  return 'plain';
}

/**
 * Normalize raw conversation content into Exchange[] format.
 * If format is not provided, auto-detects from content.
 */
export function normalizeConversation(raw: string, format?: string): Exchange[] {
  if (!raw || typeof raw !== 'string') return [];

  const fmt = format ?? autoDetectFormat(raw);
  const parser = FORMAT_MAP[fmt];
  if (!parser) return [];

  try {
    return parser(raw);
  } catch (err) {
    logger.warn('Conversation normalization failed', { format: fmt, error: String(err) });
    return [];
  }
}
