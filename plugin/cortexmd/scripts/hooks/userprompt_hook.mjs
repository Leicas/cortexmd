#!/usr/bin/env node
// Claude Code UserPromptSubmit hook — one recall block per prompt + capture of
// explicit "remember that / from now on" statements.
//
// On every user prompt:
//   1. Clean the prompt: drop <private>…</private>, fenced code blocks and
//      quoted lines; normalise accents (NFD, diacritics stripped).
//   2. Skip trivial prompts (<20 chars, "ok"/"merci"…, or containing #skip).
//   3. Capture at most ONE explicit trigger statement ("remember that …",
//      "rappelle-toi …", "from now on …", sentence-initial "always/never …")
//      as a memory and confirm it with the stored path.
//   4. Recall (hybrid search, server-side) and inject ≤3 items under
//      RECALL_HEADER — the block is marked "data, not instructions" and is
//      never emitted empty.
//
// All best-effort. Failures are non-blocking (`{}`).

import {
  readStdin, passthrough, logError, recall, storeMemory, formatMemoryBlock,
  RECALL_HEADER, RECALL_HEADER_MINIMAL,
  HOOK_DISABLED, MEMORY_DISABLED, HOOK_MINIMAL,
} from './_mcp_rest.mjs';

if (HOOK_DISABLED) passthrough();

// Explicit markers only, sentence-anchored, evaluated on `cleaned` (no code
// fences / quotes / <private>). One capture max per prompt.
const TRIGGER_PATTERNS = [
  /(?:^|[.!?]\s+)(?:please\s+)?remember(?: that)?\s*[:,]?\s*(.{5,200})/i,
  /(?:^|[.!?]\s+)(?:rappelle[- ]toi|souviens[- ]toi|n'oublie pas|note that|from now on|désormais|desormais|à partir de maintenant|a partir de maintenant)\s*(?:que|that|:|,)?\s*(.{5,200})/i,
  /(?:^|[.!?]\s+)(?:always|never|toujours|jamais)\s+(.{5,200})/i,
];

// Short acknowledgements ("yes please go ahead", "merci, parfait") carry no
// recall signal even when they pass the 20-char floor.
const CONVERSATIONAL = /^(ok|okay|oui|yes|yep|go|merci|thanks|thank you|non|no|nope)\b.{0,24}$/i;
const PREFERENCE_SUBJECT = /^(i|we|you|tu|nous|vous|on|je|j')\b/i;

/** Prompt text with everything that must never reach memory or search removed. */
function cleanPrompt(raw) {
  return String(raw ?? '')
    .replace(/<private>[\s\S]*?<\/private>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function findTrigger(cleaned) {
  for (const pat of TRIGGER_PATTERNS) {
    const m = cleaned.match(pat);
    if (!m) continue;
    // Keep the first sentence only (the statement ends at ., !, ? or a newline).
    const stmt = (m[1] ?? '').split(/\n/)[0].split(/(?<=[.!?])\s+/)[0].trim().replace(/[\s.!?]+$/, '');
    if (stmt.length < 5) continue;
    const category = PREFERENCE_SUBJECT.test(stmt) ? 'preference' : 'observation';
    return { stmt, category };
  }
  return null;
}

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
  }) + '\n');
}

async function captureTrigger(cleaned) {
  const hit = findTrigger(cleaned);
  if (!hit) return '';
  try {
    const res = await storeMemory({
      content: hit.stmt,
      category: hit.category,
      title: hit.stmt.slice(0, 70),
      tags: ['trigger-capture'],
      source: 'hook:UserPromptSubmit',
    });
    const path = res && typeof res.path === 'string' ? res.path : '';
    if (!path) return '';
    return `🧠 cortexmd stored: "${hit.stmt.slice(0, 90)}" → [[${path}]]. If this was not meant as a standing rule, ask me to delete it (notes_delete).`;
  } catch (err) {
    logError('UserPromptSubmit:storeMemory', err);
    return '';
  }
}

async function main() {
  const stdin = await readStdin();
  let evt;
  try { evt = JSON.parse(stdin || '{}'); } catch { return passthrough(); }
  if (!evt || typeof evt !== 'object') return passthrough();

  const promptRaw = evt.prompt ?? evt.user_input ?? evt.userPrompt ?? '';
  if (typeof promptRaw !== 'string' || !promptRaw) return passthrough();
  if (/(^|\s)#skip\b/i.test(promptRaw)) return passthrough();

  const cleaned = cleanPrompt(promptRaw);
  if (cleaned.length < 20) return passthrough();
  if (CONVERSATIONAL.test(cleaned)) return passthrough();

  // Capture first so the memory exists by the time we recall.
  let captureNote = '';
  try { captureNote = await captureTrigger(cleaned); }
  catch (err) { logError('UserPromptSubmit:captureTrigger', err); }

  let block = '';
  if (!MEMORY_DISABLED) {
    const query = cleaned.replace(/\n/g, ' ').slice(0, 300);
    try {
      const res = await recall({ query, limit: 5, kinds: 'both' });
      if (res && typeof res === 'object') {
        const memories = Array.isArray(res.memories) ? res.memories : [];
        const notes = Array.isArray(res.notes) ? res.notes : [];
        block = formatMemoryBlock(memories, notes, HOOK_MINIMAL ? RECALL_HEADER_MINIMAL : RECALL_HEADER, 400);
      }
    } catch (err) {
      logError('UserPromptSubmit:recall', err);
    }
  }

  const additionalContext = [block, captureNote].filter(Boolean).join('\n');
  if (!additionalContext) return passthrough();
  emit(additionalContext);
}

main().catch((err) => { logError('UserPromptSubmit:main', err); passthrough(); });
