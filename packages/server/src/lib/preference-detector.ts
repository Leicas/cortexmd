/**
 * Regex-based detection of preference signals from content text.
 *
 * Detects three types of signals:
 * - preference: "I prefer", "I like", "I always", "I never"
 * - convention: "we should always", "the convention is", "the standard is"
 * - pain_point: "doesn't work well", "frustrating", "annoying", "broken"
 */

export interface DetectedPreference {
  type: 'preference' | 'convention' | 'pain_point';
  statement: string; // The extracted statement
  entity?: string;   // Related entity name, if detectable
}

// ── Pattern definitions ──────────────────────────────────────────────────────

interface PatternDef {
  type: DetectedPreference['type'];
  pattern: RegExp;
}

const PATTERNS: PatternDef[] = [
  // Preferences — personal inclinations
  { type: 'preference', pattern: /\bI\s+prefer\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'preference', pattern: /\bI\s+(?:really\s+)?like\s+(?:to\s+|using\s+|how\s+)?(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'preference', pattern: /\bI\s+(?:really\s+)?dislike\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'preference', pattern: /\bI\s+always\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'preference', pattern: /\bI\s+never\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'preference', pattern: /\bmy\s+(?:preferred|favorite|go-to)\s+(?:\w+\s+)?(?:is|are)\s+(.{5,120}?)(?:\.|$|\n)/gi },
  { type: 'preference', pattern: /\bI\s+(?:tend\s+to|usually)\s+(.{10,120}?)(?:\.|$|\n)/gi },

  // Conventions — team or project standards
  { type: 'convention', pattern: /\bwe\s+(?:should\s+)?always\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'convention', pattern: /\bwe\s+(?:should\s+)?never\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'convention', pattern: /\bthe\s+convention\s+is\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'convention', pattern: /\bthe\s+standard\s+is\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'convention', pattern: /\bour\s+(?:team|project|codebase|convention)\s+(?:uses?|requires?|follows?)\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'convention', pattern: /\bthe\s+rule\s+(?:is|here)\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'convention', pattern: /\b(?:best\s+practice|standard\s+practice)\s+(?:is\s+(?:to\s+)?)?(.{10,120}?)(?:\.|$|\n)/gi },

  // Pain points — friction and frustration
  { type: 'pain_point', pattern: /\b(.{5,60}?)\s+doesn'?t\s+work\s+well\b/gi },
  { type: 'pain_point', pattern: /\b(.{5,60}?)\s+is\s+(?:really\s+)?(?:frustrating|annoying|broken|unreliable|buggy|slow|painful)\b/gi },
  { type: 'pain_point', pattern: /\bfrustrated\s+(?:by|with)\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'pain_point', pattern: /\bstruggling\s+with\s+(.{10,120}?)(?:\.|$|\n)/gi },
  { type: 'pain_point', pattern: /\bthe\s+(?:problem|issue|trouble)\s+(?:with|is)\s+(.{10,120}?)(?:\.|$|\n)/gi },
];

// ── Entity extraction from statements ────────────────────────────────────────

const ENTITY_PATTERNS = [
  // "X over Y" → X
  /^(\w[\w\s-]{2,30})\s+over\s+/i,
  // "using X" → X
  /\busing\s+(\w[\w\s.-]{2,30})/i,
  // Capitalized proper nouns
  /\b([A-Z][\w.-]+(?:\s+[A-Z][\w.-]+){0,2})\b/,
];

function extractEntity(statement: string): string | undefined {
  for (const pattern of ENTITY_PATTERNS) {
    const match = pattern.exec(statement);
    if (match?.[1]) {
      const candidate = match[1].trim();
      // Reject very short or generic results
      if (candidate.length > 2 && !/^(?:it|the|this|that|my|our|we|they)$/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// ── Main extraction ──────────────────────────────────────────────────────────

/**
 * Extract preference signals from content text.
 * Returns an array of detected preferences, conventions, and pain points.
 */
export function extractPreferences(content: string): DetectedPreference[] {
  const results: DetectedPreference[] = [];
  const seenStatements = new Set<string>();

  for (const def of PATTERNS) {
    // Reset lastIndex for each pattern (they have the global flag)
    def.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = def.pattern.exec(content)) !== null) {
      const rawStatement = match[1]?.trim();
      if (!rawStatement) continue;

      // Clean up the statement
      const statement = rawStatement
        .replace(/\s+/g, ' ')
        .replace(/^[,;:\s]+/, '')
        .replace(/[,;:\s]+$/, '')
        .trim();

      // Skip very short or already-seen statements
      if (statement.length < 10) continue;
      const normalized = statement.toLowerCase();
      if (seenStatements.has(normalized)) continue;
      seenStatements.add(normalized);

      const entity = extractEntity(statement);

      results.push({
        type: def.type,
        statement,
        ...(entity ? { entity } : {}),
      });
    }
  }

  return results;
}
