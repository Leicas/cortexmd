#!/usr/bin/env node
// Claude Code UserPromptSubmit hook — token-overlap memory recall + trigger
// capture.
//
// On every user prompt:
//   1. Strip <private>...</private> blocks so they never reach memory.
//   2. Recall top-N memories matching the prompt (token overlap).
//   3. Detect trigger phrases ("remember that", "rappelle-toi", "never ...")
//      and capture them as low-importance memories.
//   4. Inject the recall results as additionalContext.
//
// All best-effort. Failures are non-blocking.

import {
  readStdin, passthrough, logError, recall, storeMemory,
  formatMemoryBlock, HOOK_DISABLED, MEMORY_DISABLED, HOOK_MINIMAL,
} from './_mcp_rest.mjs';

if (HOOK_DISABLED) passthrough();

const TRIGGER_PATTERNS = [
  /\bremember that\b\s*[:,]?\s*(.{5,500})/i,
  /\brappelle[- ]toi\b\s*[:,]?\s*(.{5,500})/i,
  /\bnever\b\s+(.{5,300})/i,
  /\balways\b\s+(.{5,300})/i,
];

const STOPWORDS = new Set([
  'the','and','for','that','this','with','from','have','been','are','was','were',
  'will','can','could','would','should','not','but','they','their','them','what',
  'which','when','where','how','who','all','some','any','also','just','about',
  'into','onto','your','you','our','its','his','her','him','she','than','then','too',
  'des','les','une','que','est','elle','ils','nous','vous','pour','dans','avec',
]);

function tokenize(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function stripPrivate(text) {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, '');
}

async function captureTriggers(prompt) {
  for (const pat of TRIGGER_PATTERNS) {
    const m = prompt.match(pat);
    if (!m) continue;
    const stmt = (m[1] ?? '').trim().replace(/[\s.]+$/, '');
    if (stmt.length < 5) continue;
    try {
      await storeMemory({
        content: stmt,
        category: 'preference',
        title: stmt.slice(0, 70),
        tags: ['trigger-capture'],
        source: 'hook:UserPromptSubmit',
      });
      return stmt;
    } catch (err) {
      logError('UserPromptSubmit:storeMemory', err);
      return null;
    }
  }
  return null;
}

async function main() {
  const stdin = await readStdin();
  let evt;
  try { evt = JSON.parse(stdin || '{}'); } catch { return passthrough(); }

  const promptRaw = (evt.prompt ?? evt.userPrompt ?? '').toString();
  if (!promptRaw) return passthrough();

  const prompt = stripPrivate(promptRaw);
  if (prompt.trim().length < 8) return passthrough();

  // Trigger capture (fire-and-forget, but await so the memory exists by the
  // time we recall — keeps the next turn's context stable).
  let captured = null;
  try { captured = await captureTriggers(prompt); }
  catch (err) { logError('UserPromptSubmit:captureTriggers', err); }

  if (MEMORY_DISABLED) {
    // Still emit a small captured-confirmation note so the user can verify
    // their `remember that ...` landed.
    if (captured && !HOOK_MINIMAL) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `🧠 Captured preference: "${captured.slice(0, 90)}"`,
        },
      }) + '\n');
      return;
    }
    return passthrough();
  }

  // Use top tokens as a query — works regardless of hybrid-search availability.
  const tokens = tokenize(prompt);
  if (tokens.length === 0) return passthrough();
  const query = tokens.slice(0, 8).join(' ');

  let res;
  try {
    res = await recall({ query, limit: 3, kinds: 'both' });
  } catch (err) {
    logError('UserPromptSubmit:recall', err);
    if (captured && !HOOK_MINIMAL) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `🧠 Captured preference: "${captured.slice(0, 90)}"`,
        },
      }) + '\n');
      return;
    }
    return passthrough();
  }
  if (!res) return passthrough();

  const memories = Array.isArray(res.memories) ? res.memories : [];
  const notes = Array.isArray(res.notes) ? res.notes : [];
  const block = formatMemoryBlock(memories, notes, HOOK_MINIMAL ? 'Recall' : '📌 Relevant memory (prompt)', 800);
  const captureNote = captured && !HOOK_MINIMAL ? `\n🧠 Captured preference: "${captured.slice(0, 90)}"` : '';
  const additionalContext = (block || captureNote) ? (block + captureNote).trim() : '';

  if (!additionalContext) return passthrough();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }) + '\n');
}

main().catch((err) => { logError('UserPromptSubmit:main', err); passthrough(); });
