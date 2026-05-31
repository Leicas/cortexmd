/**
 * Memory extractor — analyzes Exchange[] from conversation normalizers
 * and extracts categorized memories using keyword signals and entity detection.
 */

import type { Exchange } from './conversation-normalizer.js';

export interface ExtractedMemory {
  category: 'decision' | 'preference' | 'milestone' | 'problem' | 'fact';
  content: string;
  timestamp?: string;
  entities: string[];
}

// ---------------------------------------------------------------------------
// Signal patterns for each memory category
// ---------------------------------------------------------------------------

const SIGNAL_PATTERNS: Array<{
  category: ExtractedMemory['category'];
  patterns: RegExp[];
}> = [
  {
    category: 'decision',
    patterns: [
      /\b(?:decided|went\s+with|chose|trade-?off|opted\s+for)\b/i,
      /\b(?:decision\s+(?:was|is)|we(?:'ll|\s+will)\s+go\s+with)\b/i,
      /\b(?:settled\s+on|picked|selecting|selected)\b/i,
    ],
  },
  {
    category: 'preference',
    patterns: [
      /\bI\s+prefer\b/i,
      /\bI\s+(?:always\s+)?(?:like|love|use)\b/i,
      /\b(?:always\s+use|convention\s+is|my\s+go-?to)\b/i,
      /\b(?:I\s+dislike|I\s+hate|I\s+avoid)\b/i,
      /\b(?:prefer(?:red|s)?|preference)\b/i,
    ],
  },
  {
    category: 'milestone',
    patterns: [
      /\b(?:shipped|launched|deployed)\b/i,
      /\b(?:finally\s+got|breakthrough|completed)\b/i,
      /\b(?:released|went\s+live|went\s+to\s+prod)\b/i,
      /\b(?:finished|accomplished|achieved|milestone)\b/i,
    ],
  },
  {
    category: 'problem',
    patterns: [
      /\b(?:bug|crash(?:es|ed|ing)?|error)\b/i,
      /\b(?:broken|failing|issue\s+with)\b/i,
      /\b(?:problem|regression|outage)\b/i,
      /\b(?:doesn'?t\s+work|can'?t\s+(?:find|load|connect|start))\b/i,
      /\b(?:exception|stack\s*trace|segfault|panic)\b/i,
    ],
  },
  {
    category: 'fact',
    patterns: [
      /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:is\s+a|are\s+a|works?\s+at|runs?\s+on)\b/,
      /\b(?:the\s+(?:API|URL|endpoint|port|version)\s+is)\b/i,
      /\b(?:located\s+(?:at|in)|hosted\s+(?:on|at))\b/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extract capitalized multi-word sequences that appear near signal words.
 * Also picks up PascalCase identifiers and common proper nouns.
 */
function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // Multi-word capitalized sequences (e.g. "John Smith", "React Native")
  const multiWordRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = multiWordRegex.exec(text)) !== null) {
    const candidate = match[1].trim();
    // Skip common sentence starters and false positives
    if (!isCommonPhrase(candidate)) {
      entities.add(candidate);
    }
  }

  // PascalCase identifiers (e.g. "TypeScript", "PostgreSQL")
  const pascalRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  while ((match = pascalRegex.exec(text)) !== null) {
    entities.add(match[1]);
  }

  // Single capitalized words that appear mid-sentence (likely proper nouns)
  const lines = text.split('\n');
  for (const line of lines) {
    const words = line.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const word = words[i].replace(/[^a-zA-Z]/g, '');
      if (word.length >= 3 && /^[A-Z][a-z]+$/.test(word) && !isCommonWord(word)) {
        entities.add(word);
      }
    }
  }

  return [...entities];
}

const COMMON_PHRASES = new Set([
  'The',
  'This',
  'That',
  'These',
  'Those',
  'Here',
  'There',
  'When',
  'Where',
  'What',
  'Which',
  'After',
  'Before',
  'Since',
  'Until',
  'Also',
  'Just',
  'Then',
  'Next',
  'First',
  'Last',
  'However',
  'Moreover',
  'Therefore',
  'Furthermore',
]);

function isCommonPhrase(text: string): boolean {
  const firstWord = text.split(/\s+/)[0];
  return COMMON_PHRASES.has(firstWord);
}

const COMMON_WORDS = new Set([
  'The',
  'This',
  'That',
  'These',
  'Those',
  'Here',
  'There',
  'When',
  'Where',
  'What',
  'Which',
  'After',
  'Before',
  'Since',
  'Until',
  'Also',
  'Just',
  'Then',
  'Next',
  'First',
  'Last',
  'However',
  'Moreover',
  'Therefore',
  'Furthermore',
  'Some',
  'Many',
  'Most',
  'Any',
  'All',
  'Each',
  'Every',
  'Other',
  'Another',
  'Both',
  'But',
  'And',
  'Not',
  'Yes',
  'Now',
  'Still',
  'Already',
  'Maybe',
  'Could',
  'Would',
  'Should',
  'Can',
  'Will',
]);

function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word);
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  // Split on sentence boundaries, keeping reasonable chunks
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .filter((s) => s.trim().length > 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract categorized memories from a set of exchanges.
 * Scans both user and assistant messages for signal patterns.
 */
export function extractMemories(exchanges: Exchange[]): ExtractedMemory[] {
  if (!Array.isArray(exchanges) || exchanges.length === 0) return [];

  const memories: ExtractedMemory[] = [];
  const seen = new Set<string>(); // dedup by content hash

  for (const exchange of exchanges) {
    // Combine both sides of the exchange for analysis
    const texts = [exchange.userMessage, exchange.assistantMessage].filter(Boolean);

    for (const text of texts) {
      const sentences = splitSentences(text);

      for (const sentence of sentences) {
        for (const signal of SIGNAL_PATTERNS) {
          const matched = signal.patterns.some((p) => p.test(sentence));
          if (!matched) continue;

          // Truncate very long sentences
          const content =
            sentence.length > 500 ? sentence.slice(0, 497) + '...' : sentence;

          // Dedup
          const key = `${signal.category}:${content.slice(0, 100).toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const entities = extractEntities(sentence);

          memories.push({
            category: signal.category,
            content,
            timestamp: exchange.timestamp,
            entities,
          });

          // Only one category per sentence
          break;
        }
      }
    }
  }

  return memories;
}
