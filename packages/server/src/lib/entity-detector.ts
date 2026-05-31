/**
 * Heuristic Named Entity Recognition (NER) for detecting persons, projects,
 * and organizations from unstructured text content.
 *
 * Balanced design — accepts entities with one strong signal or two weak signals.
 * Strong signals: title prefix, legal suffix, explicit role/org keywords.
 * Weak signals: capitalized name near a verb, possessive, attribution.
 */

import { findEntity as registryLookup } from './entity-registry.js';

export interface DetectedEntity {
  name: string;
  type: 'person' | 'project' | 'organization';
  confidence: number; // 0–1
  signals: string[];
  context: string; // surrounding text snippet
}

// ── Signal strength ──────────────────────────────────────────────────────────

/** Strong signals are sufficient alone; weak signals need 2+ to fire */
const STRONG_SIGNALS = new Set([
  'preceded_by_title',
  'legal_suffix',
  'org_keyword',
  'org_team_pattern',
  'repo_url',
  'name_with_role',
  'versioned_name',
  'wiki_link',
]);

// ── Signal patterns ──────────────────────────────────────────────────────────

// Wiki-link pattern: [[Name]] or [[path|Name]] — strongest signal in an Obsidian vault
const WIKI_LINK_RE = /\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g;

// Email addresses: extract person name (before @) and org domain
const EMAIL_RE = /\b([a-zA-Z][a-zA-Z0-9_.+-]*@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;

// Domain names in text: "acme.com", "example.org" (skip common tech/file extensions)
const DOMAIN_RE = /\b([a-zA-Z][a-zA-Z0-9-]{1,30}\.(?:com|io|co|org|net|dev|ai|app|tech|cloud|xyz|me|us|ca|uk|fr|de|eu))\b/g;

// Capitalized multi-word names (2–4 words, each starting with uppercase, supports hyphenated parts)
const CAPITALIZED_NAME_RE = /\b([A-Z][a-z]{1,20}(?:-[A-Z][a-z]{1,20})*(?:\s+[A-Z][a-z]{1,20}(?:-[A-Z][a-z]{1,20})*){1,3})\b/g;

// Single capitalized word (for use near strong contextual signals only)
const SINGLE_CAP_NAME_RE = /\b([A-Z][a-z]{2,20}(?:-[A-Z][a-z]{2,20})*)\b/g;

// ALL-CAPS names (2+ letters, not common abbreviations) — catches NVIDIA, GTC, AbbVie-style
const ALL_CAPS_NAME_RE = /\b([A-Z]{2,20})\b/g;

// Mixed-case names: uppercase letter followed by lowercase then uppercase again (AbbVie, GitHub, YouTube)
const MIXED_CASE_NAME_RE = /\b([A-Z][a-z]+[A-Z][a-zA-Z]*)\b/g;

// Relationship / role verbs that often appear near person names
const PERSON_VERB_RE = /\b(?:work(?:s|ed)?\s+(?:at|for|with)|manages?|managed|leads?|led|reports?\s+to|reported\s+to|mentors?|mentored|hired|met\s+with|spoke\s+(?:to|with)|emailed|called|texted|married\s+to|partner\s+of|friend\s+of|colleague|teammate|asked|told|assigned\s+to|cc[':]?d?|invited|introduced|onboard(?:ed|ing)?|interview(?:ed|ing)?|approved\s+by|requested\s+by|delegated\s+to|synced?\s+with|joined|founded|co-founded|supervised|coordinated\s+with)\b/i;

// Titles that precede person names (single-word names accepted after titles)
// Note: must NOT cross sentence boundaries (no . before \s+), and the following
// word must be a capitalized proper name, not a role word like "Engineering"
const PERSON_TITLE_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|CEO|CTO|CFO|COO|VP|SVP|EVP|Director|Manager|Engineer|Designer|Analyst|Architect|Lead|Sr|Jr|Principal)\b\.?\s+/;

// "Name (role)" pattern common in meeting notes — "Alice (PM)", "Marie-Claire (lead designer)"
const PERSON_ROLE_RE = /\b([A-Z][a-z]{1,20}(?:-[A-Z][a-z]{1,20})*(?:\s+[A-Z][a-z]{1,20}(?:-[A-Z][a-z]{1,20})*){0,2})\s+\((?:PM|CTO|CEO|CFO|COO|VP|lead|manager|engineer|designer|analyst|director|founder|intern|consultant|contractor|architect|admin|coordinator|head\s+of\b)[^)]*\)/gi;

// Possessive / attribution patterns — "Alice's project", "feedback from Bob"
const PERSON_POSSESSIVE_RE = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2})'s\b/;
const PERSON_FROM_RE = /\b(?:from|by|with|via|to|for)\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2})\b/;

// Project signals: version numbers, repo patterns, "building X", "project X"
const PROJECT_VERSION_RE = /\b([A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,2})\s+v?\d+\.\d+/;
const PROJECT_REPO_RE = /(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w-]+\/([\w-]+)/;
const PROJECT_KEYWORD_RE = /\b(?:project|repo|repository|codebase|app|application|service|platform|tool|framework|library|package|module|plugin|extension)\s+(?:called\s+)?["']?([A-Z][\w-]*(?:\s+[\w-]+){0,2})["']?/i;
const BUILDING_RE = /\b(?:building|developing|shipping|launching|deploying|releasing|maintaining)\s+(?:the\s+)?["']?([A-Z][\w-]*(?:\s+[\w-]+){0,2})["']?/i;

// Organization signals: legal suffixes, "company", "team at"
const ORG_SUFFIX_RE = /\b([A-Z][\w]*(?:\s+[A-Z][\w]*){0,3})\s+(?:Inc|LLC|Corp|Ltd|GmbH|AG|SA|SAS|PLC|Co)\b\.?/;
const ORG_KEYWORD_RE = /\b(?:company|corporation|organization|organisation|startup|firm\b|agency|team\s+at|work(?:s|ed)?\s+(?:at|for)|(?:role|position|job)\s+at|(?:joined|left|founded|co-founded)\s+)\s*["']?([A-Z][\w]*(?:\s+[\w]+){0,3})["']?/i;
// "the Foo team" — name part must start uppercase (prevents "the firmware team")
// Case-insensitive only for "the" and suffix; [A-Z] enforced by no /i flag
const ORG_THE_RE = /\b[Tt]he\s+([A-Z][\w]*(?:\s+[A-Z][\w]*){0,2})\s+(?:[Tt]eam|[Gg]roup|[Dd]epartment|[Dd]ivision|[Oo]rg|[Cc]ompany|[Cc]orporation)\b/;

// Common false-positive words to exclude
const STOP_NAMES = new Set([
  'The', 'This', 'That', 'These', 'Those', 'Which', 'Where', 'When', 'What',
  'How', 'Why', 'Who', 'Here', 'There', 'Some', 'Many', 'Most', 'Every',
  'Each', 'All', 'Any', 'None', 'Other', 'Another', 'Both', 'Few', 'Several',
  'Much', 'More', 'Less', 'Such', 'Own', 'Same', 'Different', 'New', 'Old',
  'Good', 'Bad', 'Great', 'Big', 'Small', 'Long', 'Short', 'High', 'Low',
  'First', 'Last', 'Next', 'Previous', 'Current', 'Important', 'Note', 'Notes',
  'Memory', 'Memories', 'Task', 'Tasks', 'Project', 'Projects', 'Related',
  'Summary', 'Overview', 'Details', 'Update', 'Updates', 'Status', 'Action',
  'Todo', 'Done', 'Pending', 'Review', 'Meeting', 'Agenda', 'Minutes',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'Today', 'Tomorrow', 'Yesterday',
  'However', 'Therefore', 'Furthermore', 'Moreover', 'Although', 'Because',
  'Since', 'While', 'Until', 'Unless', 'After', 'Before',
  'Markdown', 'Obsidian', 'Vault', 'Wiki',
  'README', 'Index', 'Dashboard', 'Template', 'Untitled', 'Draft',
  'Session', 'Inbox', 'Archive', 'General', 'Home',
  // ALL-CAPS abbreviations that are not entities
  'API', 'URL', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'JSON', 'XML', 'SQL', 'CLI',
  'TODO', 'WIP', 'TBD', 'FYI', 'ASAP', 'ETA', 'FAQ', 'TL', 'DR', 'TLDR',
  'PDF', 'CSV', 'SVG', 'PNG', 'JPG', 'GIF', 'MP3', 'MP4',
  'SSE', 'SSR', 'JWT', 'SSH', 'DNS', 'TCP', 'UDP', 'REST', 'CRUD', 'CORS',
  'NPM', 'ESM', 'CJS', 'MCP', 'LLM', 'RAG', 'NER', 'NLP', 'AI', 'ML',
  'IDE', 'SDK', 'ENV', 'ORM', 'CMS', 'CDN', 'AWS', 'GCP',
  'YAML', 'TOML', 'EOF', 'NULL', 'TRUE', 'FALSE',
  'ISO', 'UTC', 'GMT', 'PST', 'EST', 'CET',
  'PR', 'MR', 'CI', 'CD', 'QA', 'UAT', 'SLA', 'KPI', 'ROI', 'OKR',
  'CEO', 'CTO', 'CFO', 'COO', 'VP', 'SVP', 'EVP', 'PM', 'PO', 'HR',
  'RW', 'RO', 'IO', 'OS', 'UI', 'UX', 'DX',
  'BFS', 'DFS', 'HNSW', 'RRF',
  'IMPORTANT', 'NOTE', 'WARNING', 'CRITICAL', 'DEBUG', 'INFO', 'ERROR',
  // Role/department words that follow titles but are not person names
  'Engineering', 'Marketing', 'Sales', 'Finance', 'Operations', 'Design',
  'Research', 'Development', 'Security', 'Infrastructure', 'Platform',
  'Product', 'Support', 'Legal', 'Compliance', 'Analytics',
  'Previously', 'Currently', 'Recently', 'Formerly',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function isStopName(name: string): boolean {
  // Check each word individually and the full name
  if (STOP_NAMES.has(name)) return true;
  const words = name.split(/\s+/);
  if (words.length === 1 && STOP_NAMES.has(words[0])) return true;
  // If the first word is a stop word and there's only one non-stop word, likely noise
  if (words.length === 2 && STOP_NAMES.has(words[0]) && STOP_NAMES.has(words[1])) return true;
  return false;
}

function extractContext(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(text.length, matchIndex + matchLength + 40);
  let ctx = text.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) ctx = '...' + ctx;
  if (end < text.length) ctx = ctx + '...';
  return ctx;
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

// ── Main detector ────────────────────────────────────────────────────────────

/**
 * Detect entities (persons, projects, organizations) from content text.
 * Uses heuristic pattern matching with multiple signal requirement for confidence.
 */
export function detectEntities(content: string): DetectedEntity[] {
  const entityMap = new Map<string, {
    name: string;
    type: 'person' | 'project' | 'organization';
    signals: Set<string>;
    contexts: string[];
    bestIndex: number;
  }>();

  function addSignal(
    name: string,
    type: 'person' | 'project' | 'organization',
    signal: string,
    context: string,
    index: number,
  ): void {
    const key = `${type}:${normalizeName(name).toLowerCase()}`;
    const existing = entityMap.get(key);
    if (existing) {
      existing.signals.add(signal);
      if (existing.contexts.length < 3) existing.contexts.push(context);
    } else {
      entityMap.set(key, {
        name: normalizeName(name),
        type,
        signals: new Set([signal]),
        contexts: [context],
        bestIndex: index,
      });
    }
  }

  // ── Wiki-link detection (strong signal) ──────────────────────────────────
  // [[wiki-links]] are the highest-confidence entity signal in an Obsidian vault
  {
    const wikiRe = new RegExp(WIKI_LINK_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = wikiRe.exec(content)) !== null) {
      const raw = match[1].trim();
      // Skip date-like links (YYYY-MM-DD) and purely numeric links
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw) || /^\d+$/.test(raw)) continue;
      // Skip stop names
      if (isStopName(raw)) continue;
      // Skip path-like links with slashes (these are note paths, not entity names)
      // but extract the final segment as the entity name
      const name = raw.includes('/') ? raw.split('/').pop()!.trim() : raw;
      if (!name || name.length < 2 || isStopName(name)) continue;

      // Guess type from context: default to 'person' for single/two-word names,
      // 'project' for hyphenated or camelCase, 'organization' otherwise
      let type: 'person' | 'project' | 'organization' = 'organization';
      if (/^[A-Z][a-z]+([\s-][A-Z][a-z]+){0,2}$/.test(name)) {
        // "Alice Smith", "Marie-Claire" → person
        type = 'person';
      } else if (/[-_]/.test(name) || /^[a-z]/.test(name)) {
        // "cortexmd", "camelCase" → project
        type = 'project';
      }
      addSignal(name, type, 'wiki_link', extractContext(content, match.index, match[0].length), match.index);
    }
  }

  // ── Email-based detection (person + organization) ───────────────────────
  {
    const emailRe = new RegExp(EMAIL_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = emailRe.exec(content)) !== null) {
      const email = match[1];
      const [localPart, domain] = email.split('@');

      // Extract person name from local part: "john.smith" → "John Smith"
      const nameParts = localPart.split(/[._+-]/).filter(p => p.length > 1);
      if (nameParts.length >= 2) {
        const personName = nameParts
          .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
          .join(' ');
        if (!isStopName(personName)) {
          addSignal(personName, 'person', 'email_address', extractContext(content, match.index, email.length), match.index);
        }
      }

      // Extract org from domain (skip common providers)
      const commonProviders = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'protonmail.com', 'live.com', 'aol.com', 'mail.com', 'proton.me']);
      if (!commonProviders.has(domain.toLowerCase())) {
        const orgName = domain.split('.')[0];
        if (orgName.length > 2 && !isStopName(orgName)) {
          const capitalizedOrg = orgName.charAt(0).toUpperCase() + orgName.slice(1);
          addSignal(capitalizedOrg, 'organization', 'email_domain', extractContext(content, match.index, email.length), match.index);
        }
      }
    }
  }

  // ── Domain-based organization detection ─────────────────────────────────
  {
    const domainRe = new RegExp(DOMAIN_RE.source, 'g');
    let match: RegExpExecArray | null;
    const commonDomains = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'google.com', 'stackoverflow.com', 'npmjs.com', 'docker.com', 'example.com', 'localhost.com']);
    while ((match = domainRe.exec(content)) !== null) {
      const domain = match[1];
      if (commonDomains.has(domain.toLowerCase())) continue;
      const orgName = domain.split('.')[0];
      if (orgName.length > 2 && !isStopName(orgName) && !isStopName(orgName.toUpperCase())) {
        const capitalizedOrg = orgName.charAt(0).toUpperCase() + orgName.slice(1);
        addSignal(capitalizedOrg, 'organization', 'domain_mention', extractContext(content, match.index, domain.length), match.index);
      }
    }
  }

  // ── ALL-CAPS and mixed-case name detection ──────────────────────────────
  // Catches names like NVIDIA, GTC, AbbVie that standard patterns miss
  {
    const capsRe = new RegExp(ALL_CAPS_NAME_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = capsRe.exec(content)) !== null) {
      const name = match[1];
      if (name.length < 3 || isStopName(name)) continue;
      // ALL-CAPS near relationship verbs or possessives get a signal
      const surroundStart = Math.max(0, match.index - 80);
      const surroundEnd = Math.min(content.length, match.index + name.length + 80);
      const surround = content.slice(surroundStart, surroundEnd);
      if (PERSON_VERB_RE.test(surround)) {
        addSignal(name, 'organization', 'near_relationship_verb', extractContext(content, match.index, name.length), match.index);
      }
      // Check for possessive: "NVIDIA's"
      const after = content.slice(match.index + name.length, match.index + name.length + 2);
      if (after === "'s") {
        addSignal(name, 'organization', 'possessive_pattern', extractContext(content, match.index, name.length + 2), match.index);
      }
      // Check for attribution: "from NVIDIA", "by NVIDIA", "with NVIDIA"
      const before = content.slice(Math.max(0, match.index - 10), match.index);
      if (/\b(?:from|by|with|via|to|for|at)\s+$/i.test(before)) {
        addSignal(name, 'organization', 'attribution_pattern', extractContext(content, match.index, name.length), match.index);
      }
    }
  }

  // Mixed-case names: AbbVie, GitHub, YouTube
  {
    const mixedRe = new RegExp(MIXED_CASE_NAME_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = mixedRe.exec(content)) !== null) {
      const name = match[1];
      if (isStopName(name) || name.length < 3) continue;
      // Mixed-case is a weak signal on its own; check for context
      const surroundStart = Math.max(0, match.index - 80);
      const surroundEnd = Math.min(content.length, match.index + name.length + 80);
      const surround = content.slice(surroundStart, surroundEnd);
      if (PERSON_VERB_RE.test(surround)) {
        addSignal(name, 'organization', 'near_relationship_verb', extractContext(content, match.index, name.length), match.index);
      }
      const after = content.slice(match.index + name.length, match.index + name.length + 2);
      if (after === "'s") {
        addSignal(name, 'organization', 'possessive_pattern', extractContext(content, match.index, name.length + 2), match.index);
      }
      const before = content.slice(Math.max(0, match.index - 10), match.index);
      if (/\b(?:from|by|with|via|to|for|at)\s+$/i.test(before)) {
        addSignal(name, 'organization', 'attribution_pattern', extractContext(content, match.index, name.length), match.index);
      }
    }
  }

  // ── Person detection ─────────────────────────────────────────────────────

  // Check for capitalized names near relationship verbs
  // Accept both multi-word and single-word names in verb context
  const sentences = content.split(/[.!?\n]+/);
  for (const sentence of sentences) {
    if (PERSON_VERB_RE.test(sentence)) {
      // Multi-word names (higher quality)
      let match: RegExpExecArray | null;
      const nameRe = new RegExp(CAPITALIZED_NAME_RE.source, 'g');
      while ((match = nameRe.exec(sentence)) !== null) {
        const name = match[1];
        if (!isStopName(name)) {
          const idx = content.indexOf(sentence) + (match.index ?? 0);
          addSignal(name, 'person', 'near_relationship_verb', extractContext(content, idx, name.length), idx);
        }
      }
      // Single-word names near verbs (weaker but valid — people often referred by first name)
      const singleRe = new RegExp(SINGLE_CAP_NAME_RE.source, 'g');
      while ((match = singleRe.exec(sentence)) !== null) {
        const name = match[1];
        if (!isStopName(name)) {
          const idx = content.indexOf(sentence) + (match.index ?? 0);
          addSignal(name, 'person', 'near_relationship_verb', extractContext(content, idx, name.length), idx);
        }
      }
    }
  }

  // Person titles — strong signal, single-word names accepted
  {
    const titleRe = new RegExp(PERSON_TITLE_RE.source + '([A-Z][a-z]{1,20}(?:\\s+[A-Z][a-z]{1,20}){0,2})', 'g');
    let match: RegExpExecArray | null;
    while ((match = titleRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name)) {
        addSignal(name, 'person', 'preceded_by_title', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // "Name (role)" pattern — strong signal, common in meeting notes
  {
    const roleRe = new RegExp(PERSON_ROLE_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = roleRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name)) {
        addSignal(name, 'person', 'name_with_role', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // Possessive pattern: "Alice's ..."
  {
    const possRe = new RegExp(PERSON_POSSESSIVE_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = possRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name) && name.split(/\s+/).length <= 3) {
        addSignal(name, 'person', 'possessive_pattern', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // "from/by/with/to/for Name" pattern — accept single-word names
  {
    const fromRe = new RegExp(PERSON_FROM_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = fromRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name)) {
        addSignal(name, 'person', 'attribution_pattern', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // ── Project detection ────────────────────────────────────────────────────

  // Versioned names: "ProjectX v2.0"
  {
    const versionRe = new RegExp(PROJECT_VERSION_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = versionRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name)) {
        addSignal(name, 'project', 'versioned_name', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // Repo URLs
  {
    const repoRe = new RegExp(PROJECT_REPO_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = repoRe.exec(content)) !== null) {
      const name = match[1];
      if (name && name.length > 2) {
        addSignal(name, 'project', 'repo_url', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // "project X", "building X"
  {
    const kwRe = new RegExp(PROJECT_KEYWORD_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = kwRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name) && name.length > 2) {
        addSignal(name, 'project', 'project_keyword', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  {
    const buildRe = new RegExp(BUILDING_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = buildRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name) && name.length > 2) {
        addSignal(name, 'project', 'building_keyword', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // ── Organization detection ───────────────────────────────────────────────

  // Legal suffixes: "Acme Inc", "Foo LLC"
  {
    const suffixRe = new RegExp(ORG_SUFFIX_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = suffixRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name)) {
        addSignal(name, 'organization', 'legal_suffix', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // "company X", "team at X"
  {
    const orgKwRe = new RegExp(ORG_KEYWORD_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = orgKwRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name) && name.length > 2) {
        addSignal(name, 'organization', 'org_keyword', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // "the Foo team/group/department" — case-sensitive to require uppercase name
  {
    const theRe = new RegExp(ORG_THE_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = theRe.exec(content)) !== null) {
      const name = match[1];
      if (name && !isStopName(name)) {
        addSignal(name, 'organization', 'org_team_pattern', extractContext(content, match.index, match[0].length), match.index);
      }
    }
  }

  // ── Build results ────────────────────────────────────────────────────────

  const results: DetectedEntity[] = [];

  for (const entry of entityMap.values()) {
    const signalCount = entry.signals.size;
    const hasStrongSignal = [...entry.signals].some(s => STRONG_SIGNALS.has(s));

    // Accept if: 1 strong signal, OR 2+ weak signals
    if (!hasStrongSignal && signalCount < 2) continue;

    // Confidence: strong signals start higher
    const baseConf = hasStrongSignal ? 0.55 : 0.4;
    const confidence = Math.min(0.95, baseConf + signalCount * 0.12);

    results.push({
      name: entry.name,
      type: entry.type,
      confidence: Math.round(confidence * 100) / 100,
      signals: [...entry.signals],
      context: entry.contexts[0],
    });
  }

  // ── Registry-aware confidence boosting ──────────────────────────────────
  for (const result of results) {
    try {
      const registered = registryLookup(result.name);
      if (registered) {
        const tierBoost = registered.tier === 'confirmed' ? 0.2
          : registered.tier === 'detected' ? 0.1
          : 0.05;
        result.confidence = Math.min(0.98, result.confidence + tierBoost);
        result.confidence = Math.round(result.confidence * 100) / 100;
        result.signals.push(`registry_${registered.tier}`);
        if (registered.tier === 'confirmed' && registered.type !== result.type) {
          result.type = registered.type;
        }
      }
    } catch {
      // Registry not loaded — skip
    }
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}
