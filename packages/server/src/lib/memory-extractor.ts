/**
 * Memory extractor — analyzes Exchange[] from conversation normalizers
 * and extracts categorized memories using keyword signals and entity detection.
 */

import type { Exchange } from './conversation-normalizer.js';
import { memoryKindOf } from './memory-kind.js';

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

// ---------------------------------------------------------------------------
// Typed fact extraction (decision / fact notes only — precision over recall)
// ---------------------------------------------------------------------------

/**
 * High-precision typed predicates. `runs_on`, `version_is`, `owned_by` and
 * `located_at` are single-valued (a newer value supersedes the older one —
 * see bitemporal.ts SINGLE_VALUED); `depends_on` is multi-valued;
 * `replaced_by` records a replacement edge.
 */
export const TYPED_PREDICATES = ['runs_on', 'depends_on', 'replaced_by', 'version_is', 'owned_by', 'located_at'] as const;
export type TypedPredicate = (typeof TYPED_PREDICATES)[number];
export const SINGLE_VALUED_TYPED: ReadonlySet<TypedPredicate> = new Set<TypedPredicate>(['runs_on', 'version_is', 'owned_by', 'located_at']);

export interface TypedFact {
  subject: string;
  predicate: TypedPredicate;
  object: string;
  /** The clause the fact was read from (for audit / UI). */
  evidence: string;
}

/** Alias hook: a map (case-insensitive keys) or a resolver returning a canonical name. */
export type EntityAliases = Record<string, string> | ((name: string) => string | undefined);

/** Corporate suffixes dropped during normalisation ("Acme, Inc." → "Acme"). */
const CORPORATE_SUFFIX = /,?\s+(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|ag|s\.?a\.?s?|sarl|sas|plc|bv|oy|ab)\.?$/i;

/**
 * Normalise an entity mention: unwrap [[wiki|links]] (last path segment, no
 * `.md`) and `code spans`, collapse whitespace, trim punctuation, drop a
 * leading article and corporate suffixes, then resolve aliases. Keeps the
 * mention's casing. Returns '' for an empty mention.
 */
export function normalizeEntityName(raw: string, aliases?: EntityAliases): string {
  let s = String(raw ?? '').trim();
  const wiki = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(s);
  if (wiki) s = wiki[1].split('/').pop()!.replace(/\.md$/i, '');
  s = s.replace(/^`([^`]+)`$/, '$1');
  s = s.replace(/\s+/g, ' ').replace(/^[\s"'“”«»(]+|[\s"'“”«»),.;:!?]+$/g, '');
  s = s.replace(/^(?:the|a|an|our|my|le|la|les|un|une|notre|nos|mon|ma)\s+/i, '').replace(/^l'/i, '');
  for (let i = 0; i < 2 && CORPORATE_SUFFIX.test(s); i++) s = s.replace(CORPORATE_SUFFIX, '').trim();
  if (!s) return '';
  if (aliases) {
    const hit = typeof aliases === 'function'
      ? aliases(s)
      : aliases[s] ?? Object.entries(aliases).find(([k]) => k.toLowerCase() === s.toLowerCase())?.[1];
    if (hit && hit.trim()) return hit.trim();
  }
  return s;
}

/** Comparison key for an entity (case/whitespace/accent-insensitive). */
export function entityKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const PRONOUNS = new Set([
  'it', 'this', 'that', 'these', 'those', 'which', 'who', 'what', 'everything', 'something', 'nothing', 'he', 'she',
  'they', 'we', 'i', 'you', 'there', 'here', 'one', 'all', 'each', 'both', 'il', 'elle', 'ils', 'elles', 'ce', 'cela',
  'ça', 'ca', 'qui', 'que', 'tout', 'on', 'nous', 'vous', 'je', 'tu', 'celui', 'celle', 'ceci',
]);

// Entity mention shapes. Capitalised / wiki-link / code-span mentions may sit
// anywhere in a clause; a lowercase subject must open the clause.
const WIKI = String.raw`\[\[[^\]\n]{1,120}\]\]`;
const CODE = String.raw`\x60[^\x60\n]{1,60}\x60`;
const CAP = String.raw`\p{Lu}[\p{L}\p{N}_.+#-]*(?:\s+(?:[\p{Lu}\p{N}][\p{L}\p{N}_.+#-]*))*(?:,?\s+(?:Inc|LLC|Ltd|Corp|GmbH|SAS|SARL)\.?)?`;
const ENTITY = `(?:${WIKI}|${CODE}|${CAP})`;
const LOWER_SUBJECT = String.raw`(?:(?:[Tt]he|[Oo]ur|[Ll]e|[Ll]a|[Ll]es|[Nn]otre)\s+|[Ll]')?\p{Ll}[\p{L}\p{N}_.+#-]{1,40}(?:\s+\p{Ll}[\p{L}\p{N}_.+#-]{1,40}){0,2}`;
const VERSION = String.raw`v?\d+(?:\.\d+){0,3}(?:[-+][\w.]+)?`;
/** Object: a short span, cut later at conjunctions. */
const OBJ = String.raw`[^,;:()\n]{1,80}`;

interface TypedRule {
  predicate: TypedPredicate;
  verb: string;
  /** Swap subject/object ("Y replaces X" → X replaced_by Y). */
  inverse?: boolean;
  /** Object must be a version string. */
  version?: boolean;
}

const TYPED_RULES: TypedRule[] = [
  // runs_on
  { predicate: 'runs_on', verb: String.raw`(?:now\s+)?(?:runs|is\s+running|is\s+(?:now\s+)?(?:hosted|deployed))\s+(?:on|to)` },
  { predicate: 'runs_on', verb: String.raw`(?:tourne|fonctionne|est\s+(?:maintenant\s+)?(?:h[ée]berg[ée]e?|d[ée]ploy[ée]e?))\s+sur` },
  // depends_on
  { predicate: 'depends_on', verb: String.raw`(?:depends|relies)\s+on` },
  { predicate: 'depends_on', verb: String.raw`d[ée]pend\s+(?:de|du|des|d')` },
  // replaced_by
  { predicate: 'replaced_by', verb: String.raw`(?:was|has\s+been|is|got|will\s+be)\s+replaced\s+(?:by|with)` },
  { predicate: 'replaced_by', verb: String.raw`(?:a\s+[ée]t[ée]|est|sera)\s+remplac[ée]e?\s+par` },
  { predicate: 'replaced_by', verb: String.raw`(?:replaces|replaced|remplace)`, inverse: true },
  // version_is
  { predicate: 'version_is', verb: String.raw`(?:is\s+(?:now\s+)?(?:at|on)\s+version|is\s+(?:now\s+)?(?:at|on)|version\s+is(?:\s+now)?|is\s+now\s+version)`, version: true },
  { predicate: 'version_is', verb: String.raw`(?:est\s+(?:maintenant\s+)?en\s+version|est\s+(?:maintenant\s+)?en)`, version: true },
  // owned_by
  { predicate: 'owned_by', verb: String.raw`is\s+(?:now\s+)?(?:owned|maintained|run)\s+by` },
  { predicate: 'owned_by', verb: String.raw`(?:appartient\s+(?:à|a)|est\s+(?:maintenant\s+)?(?:g[ée]r[ée]e?|maintenue?|d[ée]tenue?)\s+par)` },
  { predicate: 'owned_by', verb: String.raw`(?:owns|maintains)`, inverse: true },
  // located_at
  { predicate: 'located_at', verb: String.raw`is\s+(?:now\s+)?(?:located|based|headquartered)\s+(?:in|at)` },
  { predicate: 'located_at', verb: String.raw`(?:est\s+(?:maintenant\s+)?(?:situ[ée]e?|bas[ée]e?|install[ée]e?)|se\s+trouve)\s+(?:à|a|au|aux|en|dans)` },
];

/** Compiled once: anywhere-subject and clause-start-subject variants per rule. */
const COMPILED = TYPED_RULES.map((rule) => {
  const obj = rule.version ? String.raw`(?<o>${VERSION})(?![\p{L}\p{N}_]|\.\d)` : `(?<o>${OBJ})`;
  return {
    rule,
    anywhere: new RegExp(String.raw`(?:^|(?<=[\s(]))(?<s>${ENTITY})\s+(?:${rule.verb})\s+${obj}`, 'u'),
    start: new RegExp(String.raw`^(?<s>${LOWER_SUBJECT})\s+(?:${rule.verb})\s+${obj}`, 'u'),
  };
});

const OBJECT_CUT = /\s+(?:and|but|because|since|which|who|so|while|when|until|for|to|et|mais|car|parce|qui|donc|depuis|pour|quand|avec|with|as|after|before|apr[eè]s|avant|in|on|at|dans|en|from|de|last|this|next|yesterday|today|tomorrow|now|currently|hier|aujourd'hui|maintenant|d[ée]sormais|cette|ce)\b.*$/i;

/** An object never starts with a preposition ("replaced by X" read from the wrong side). */
const LEADING_PREPOSITIONS = new Set(['by', 'with', 'to', 'on', 'in', 'at', 'of', 'par', 'avec', 'sur', 'dans', 'de', 'du', 'des']);
/** A subject never ends with an auxiliary ("X was" + "replaced" …). */
const TRAILING_AUXILIARIES = new Set(['was', 'is', 'are', 'were', 'has', 'have', 'had', 'been', 'be', 'will', 'got', 'a', 'est', 'été', 'ete', 'sera', 'ont', 'sont']);

function cleanObject(raw: string, version: boolean): string | undefined {
  let o = raw.trim();
  if (version) return /^v?\d+(?:\.\d+){0,3}/.test(o) ? o : undefined;
  o = o.replace(OBJECT_CUT, '').replace(/[\s.!?]+$/, '').trim();
  o = o.replace(/^(?:the|a|an|le|la|les|un|une|our|notre|nos)\s+/i, '').replace(/^l'/i, '');
  if (!o) return undefined;
  const words = o.split(/\s+/);
  if (words.length > 5) return undefined;
  if (PRONOUNS.has(words[0].toLowerCase()) || LEADING_PREPOSITIONS.has(words[0].toLowerCase())) return undefined;
  return o;
}

function splitClauses(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')       // never read facts out of code blocks
    .split(/(?<=[.!?])(?<!\b(?:Inc|Ltd|Corp|Co|Dr|Mr|Mrs|Ms|St|vs|etc|e\.g|i\.e)\.)\s+|[;\n]+/)
    .map((c) => c.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^#+\s*/, '').trim())
    .filter((c) => c.length >= 8 && c.length <= 400);
}

/** Notes eligible for typed extraction: deliberate decision / fact notes only. */
export function isTypedFactSource(frontmatter: Record<string, unknown> | null | undefined, path = ''): boolean {
  const fm = frontmatter ?? {};
  const category = typeof fm.category === 'string' ? fm.category.toLowerCase() : '';
  const fromPath = /^Memories\/(decision|fact)\//i.test(path);
  if (category !== 'decision' && category !== 'fact' && !(category === '' && fromPath)) return false;
  // Auto-captures (hook / API exhaust) and episodic sources (email, n8n,
  // digests, diaries) never yield facts.
  const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => String(t).replace(/^#/, '')) : [];
  if (tags.includes('auto-capture') || fm.auto_extracted === true) return false;
  return memoryKindOf(fm, path) !== 'episodic';
}

export interface ExtractTypedFactsInput {
  body: string;
  title?: string;
  frontmatter?: Record<string, unknown> | null;
  path?: string;
}

export interface ExtractTypedFactsOptions {
  aliases?: EntityAliases;
  /** Skip the decision/fact + non-episodic gate (explicit callers only). */
  ungated?: boolean;
}

/**
 * Extract typed (subject, predicate, object) facts from a decision / fact
 * note. Conservative: subjects must be a named entity (capitalised word,
 * [[wiki-link]], `code span`) or a short lowercase noun phrase opening the
 * clause, objects ≤ 5 words, pronouns and code blocks ignored, email /
 * machine-capture / digest / diary notes never read. Never throws.
 */
export function extractTypedFacts(input: ExtractTypedFactsInput, opts: ExtractTypedFactsOptions = {}): TypedFact[] {
  const out: TypedFact[] = [];
  try {
    if (!opts.ungated && !isTypedFactSource(input.frontmatter ?? {}, input.path ?? '')) return out;
    const seen = new Set<string>();
    const text = `${input.title ? `${input.title}.\n` : ''}${input.body ?? ''}`;
    for (const clause of splitClauses(text)) {
      for (const { rule, anywhere, start } of COMPILED) {
        const m = anywhere.exec(clause) ?? start.exec(clause);
        if (!m?.groups) continue;
        const objectText = cleanObject(m.groups.o, Boolean(rule.version));
        if (!objectText) continue;
        let subject = normalizeEntityName(m.groups.s, opts.aliases);
        let object = rule.version ? objectText : normalizeEntityName(objectText, opts.aliases);
        if (!subject || !object) continue;
        if (subject.toLowerCase().split(' ').some((w) => PRONOUNS.has(w))) continue;
        if (TRAILING_AUXILIARIES.has(m.groups.s.trim().toLowerCase().split(/\s+/).pop() ?? '')) continue;
        if (rule.inverse) [subject, object] = [object, subject];
        if (entityKey(subject) === entityKey(object)) continue;
        const key = `${entityKey(subject)}|${rule.predicate}|${entityKey(object)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ subject, predicate: rule.predicate, object, evidence: clause.slice(0, 200) });
      }
    }
  } catch {
    return out;
  }
  return out;
}
