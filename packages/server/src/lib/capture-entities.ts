/**
 * Capture-time entity linking for email and chat captures.
 *
 * Email captures (the n8n triage posting to POST /api/store-memory with the
 * `matrimail` tag, or memory_store with that tag) used to land in EmailLog/
 * with no entity links and no graph nodes: a coworker you exchange mail with
 * every day never got a People note, a registry entry or a KG entity. This
 * module gives those captures the same "make the graph grow on write"
 * treatment curated memories already get, from the capture's own headers:
 *
 *   1. parse the participants out of the header lines the pipelines write
 *      (`**From:** "Name" <email>`, `To:`, `Cc:`, Slack-style `**User:**`)
 *   2. resolve each one to an existing person note — by `work_email` /
 *      `aliases` frontmatter under the CRM people dir, then by canonical name
 *   3. create a stub person note for an unknown sender on an internal domain
 *      (a coworker), never for an external or automated address
 *   4. register every resolved participant in the entity registry and seed
 *      the temporal KG (`mentions_person`, `emailed` / `messaged`)
 *   5. return the `## Entities (auto)` links for the capture body and, once
 *      the capture is written, append a timeline line to each person note
 *
 * Two-phase on purpose: `planCaptureEntityLinks` runs BEFORE the capture is
 * written so the links land in the note on its first write (one index/graph
 * update), `commitCaptureEntityLinks` runs AFTER so the person notes can link
 * back to a path that exists. Everything is best-effort and never throws.
 */
import { config } from '../config.js';
import { logger } from './logger.js';
import { readNote, writeNote, createNote } from './vault.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { getDocMeta, indexNote } from './search.js';
import { updateGraphForNote } from './graph.js';
import { buildLinkLookup, type LinkLookup } from './link-resolver.js';
import { registerEntity } from './entity-registry.js';
import { kgAddTriple, isKgInitialized } from './knowledge-graph.js';
import { resolveEntityTarget } from './auto-link.js';
import { appendLineToSection } from './markdown.js';

export type CaptureKind = 'email' | 'chat';
export type ParticipantRole = 'from' | 'to' | 'cc' | 'author' | 'mention';

export interface CaptureParticipant {
  name?: string;
  email?: string;
  role: ParticipantRole;
}

export interface LinkedPerson {
  /** Canonical display name (note title when resolved, header name otherwise). */
  name: string;
  /** Vault-relative path of the person note. */
  path: string;
  role: ParticipantRole;
  email?: string;
  /** True when this call created the stub note. */
  created: boolean;
}

export interface CaptureLinkPlan {
  kind: CaptureKind;
  participants: CaptureParticipant[];
  people: LinkedPerson[];
  /** `[[path|Name]]` links, deduplicated, in participant order. */
  links: string[];
}

// ── Header parsing ───────────────────────────────────────────────────────────

const HEADER_LINE_RE = /^\s*(?:\*\*)?(From|To|Cc|Bcc|Sender|Author|User|Participants|Entities)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$/i;
const ADDRESS_RE = /^\s*"?([^"<]*?)"?\s*<\s*([^>\s]+@[^>\s]+)\s*>\s*$/;
const BARE_EMAIL_RE = /^\s*<?([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>?\s*$/;
/** Only the header block is scanned — body text is the detector's job. */
const MAX_HEADER_LINES = 40;
const MAX_PARTICIPANTS = 12;

const ROLE_BY_HEADER: Record<string, ParticipantRole> = {
  from: 'from',
  sender: 'from',
  author: 'author',
  user: 'author',
  to: 'to',
  cc: 'cc',
  bcc: 'cc',
  participants: 'mention',
  entities: 'mention',
};

/** Mailbox names that are never a person (newsletters, bots, shared inboxes). */
const AUTOMATED_LOCAL_PART_RE = /^(?:no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|bounces?|newsletters?|subscriptioncenter|subscriptions?|digest|updates?|news|alerts?|info|support|hello|team|sales|marketing|billing|invoices?|receipts?|admin|postmaster|dashboard|bot|robot|automation|calendar(?:-notification)?|drive-shares-(?:dm-)?noreply)(?:[._+-].*)?$/i;

function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '<' && !inQuotes) inAngle = true;
    else if (ch === '>' && !inQuotes) inAngle = false;
    if ((ch === ',' || ch === ';') && !inQuotes && !inAngle) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function cleanName(raw: string): string | undefined {
  let name = raw.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
  // "Annie Bergevin via Miro", "Joel (Slack)" → the person
  name = name.replace(/\s+via\s+.+$/i, '').replace(/\s*\((?:slack|email|via [^)]*)\)\s*$/i, '').trim();
  if (!name || name === '-' || name === '—') return undefined;
  if (/@/.test(name)) return undefined;
  if (name.length > 80) return undefined;
  return name;
}

/** "joel.scott" → "Joel Scott"; single-token mailboxes give nothing. */
export function nameFromEmail(email: string): string | undefined {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._+-]/).filter((p) => p.length > 1 && /^[a-z]+$/i.test(p));
  if (parts.length < 2) return undefined;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

function parseAddress(item: string, role: ParticipantRole): CaptureParticipant | undefined {
  const withAngle = item.match(ADDRESS_RE);
  if (withAngle) {
    const email = withAngle[2].toLowerCase();
    return { name: cleanName(withAngle[1]) ?? nameFromEmail(email), email, role };
  }
  const bare = item.match(BARE_EMAIL_RE);
  if (bare) {
    const email = bare[1].toLowerCase();
    return { name: nameFromEmail(email), email, role };
  }
  const name = cleanName(item);
  return name ? { name, role } : undefined;
}

/**
 * Extract participants from the capture header block. Order is preserved
 * (sender first), duplicates by email/name are collapsed, and the list is
 * capped so a 200-recipient announcement cannot fan out into 200 links.
 */
export function parseCaptureParticipants(content: string): CaptureParticipant[] {
  const out: CaptureParticipant[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n').slice(0, MAX_HEADER_LINES);
  for (const line of lines) {
    const m = line.match(HEADER_LINE_RE);
    if (!m) continue;
    const role = ROLE_BY_HEADER[m[1].toLowerCase()];
    const value = m[2].trim();
    if (!role || !value || value === '-' || value === '—') continue;
    for (const item of splitAddressList(value)) {
      const p = parseAddress(item, role);
      if (!p || (!p.name && !p.email)) continue;
      const key = (p.email ?? p.name!).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= MAX_PARTICIPANTS) return out;
    }
  }
  return out;
}

export function isAutomatedAddress(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return AUTOMATED_LOCAL_PART_RE.test(local);
}

// ── Person-note index (email / alias → path) ─────────────────────────────────

interface PersonIndex {
  dir: string;
  byEmail: Map<string, string>;
  byName: Map<string, string>;
  internalDomains: Set<string>;
  pathCount: number;
  builtAt: number;
}

const PERSON_INDEX_TTL_MS = 5 * 60_000;
const PEOPLE_DIR_CANDIDATES = ['05 CRM/Entities/People', 'CRM/Entities/People', 'CRM/People', 'CRM/people', 'People', 'Entities/People'];
const DEFAULT_PEOPLE_DIR = 'CRM/People';

let personIndex: PersonIndex | null = null;

/** Test hook: drop the cached person index so the next call rebuilds it. */
export function invalidatePersonIndex(): void {
  personIndex = null;
}

function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Where person notes live: `CRM_PEOPLE_DIR`, else the first conventional
 * directory that already holds notes, else `CRM/People`.
 */
export function resolvePeopleDir(): string {
  if (config.crmPeopleDir) return config.crmPeopleDir;
  const paths = getDocMeta().keys();
  const present = new Set<string>();
  for (const p of paths) {
    for (const cand of PEOPLE_DIR_CANDIDATES) {
      if (p.startsWith(`${cand}/`)) present.add(cand);
    }
  }
  for (const cand of PEOPLE_DIR_CANDIDATES) if (present.has(cand)) return cand;
  return DEFAULT_PEOPLE_DIR;
}

function peoplePaths(dir: string): string[] {
  const prefix = `${dir}/`;
  const out: string[] = [];
  for (const p of getDocMeta().keys()) {
    if (p.startsWith(prefix) && p.endsWith('.md') && !p.slice(prefix.length).includes('/')) out.push(p);
  }
  return out;
}

async function buildPersonIndex(): Promise<PersonIndex> {
  const dir = resolvePeopleDir();
  const paths = peoplePaths(dir);
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string>();
  const domainCounts = new Map<string, number>();

  for (const p of paths) {
    const basename = p.slice(dir.length + 1, -3);
    byName.set(normalizeName(basename), p);
    let data: Record<string, unknown> = {};
    try {
      data = parseFrontmatter((await readNote(p)).content).data;
    } catch {
      continue;
    }
    if (typeof data.entity === 'string') byName.set(normalizeName(data.entity), p);
    if (typeof data.title === 'string') byName.set(normalizeName(data.title), p);
    const emails: string[] = [];
    for (const key of ['work_email', 'email', 'emails', 'aliases']) {
      const v = data[key];
      if (typeof v === 'string') emails.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') emails.push(x);
    }
    for (const raw of emails) {
      const value = raw.trim().toLowerCase();
      if (!value) continue;
      if (value.includes('@')) {
        if (!byEmail.has(value)) byEmail.set(value, p);
        const domain = value.split('@')[1];
        if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      } else {
        const n = normalizeName(value);
        if (n && !byName.has(n)) byName.set(n, p);
      }
    }
  }

  // Internal domains: configured, else the domain(s) most of the people notes
  // share (a coworker directory synced from HR has one dominant domain).
  const internalDomains = new Set<string>(config.crmInternalDomains);
  if (internalDomains.size === 0 && byEmail.size > 0) {
    for (const [domain, count] of domainCounts) {
      if (count >= 3 && count / byEmail.size >= 0.4) internalDomains.add(domain);
    }
  }

  return { dir, byEmail, byName, internalDomains, pathCount: paths.length, builtAt: Date.now() };
}

async function getPersonIndex(): Promise<PersonIndex> {
  const fresh = personIndex
    && Date.now() - personIndex.builtAt < PERSON_INDEX_TTL_MS
    && personIndex.pathCount === peoplePaths(personIndex.dir).length;
  if (!fresh) personIndex = await buildPersonIndex();
  return personIndex!;
}

export function isInternalEmail(email: string, index: Pick<PersonIndex, 'internalDomains'>): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return !!domain && index.internalDomains.has(domain);
}

// ── Stub person notes ────────────────────────────────────────────────────────

function safeNoteBasename(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function createPersonStub(name: string, email: string | undefined, index: PersonIndex, kind: CaptureKind): Promise<string | undefined> {
  const basename = safeNoteBasename(name);
  if (!basename) return undefined;
  const notePath = `${index.dir}/${basename}.md`;
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter: Record<string, unknown> = {
    entity: name,
    entity_type: 'person',
    status: 'active',
    priority: 'medium',
    match_confidence: 'medium',
    work_email: email ?? null,
    aliases: [],
    source: `capture:${kind}`,
    category: 'crm',
    created: today,
    last_updated: today,
    tags: ['crm', 'person', 'auto-capture'],
  };
  const body = `# ${name}\n\nAuto-created from a captured ${kind === 'email' ? 'email' : 'conversation'} on ${today}`
    + (email ? ` (${email})` : '')
    + '. Add role and organisation.\n\n## Notes\n\n## Email Timeline\n\n## Open Threads\n';
  try {
    await createNote(notePath, stringifyFrontmatter(frontmatter, body));
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
  try { await indexNote(notePath); } catch { /* best-effort */ }
  try { updateGraphForNote(notePath, body); } catch { /* graph may not be built yet */ }
  if (email) index.byEmail.set(email, notePath);
  index.byName.set(normalizeName(name), notePath);
  index.pathCount += 1;
  return notePath;
}

// ── Plan (before the capture is written) ─────────────────────────────────────

function displayNameFor(path: string, dir: string, fallback: string): string {
  const base = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '') || fallback;
}

/**
 * Resolve the capture's participants to person notes (creating stubs for
 * internal-domain coworkers) and return the links for its body. Never throws;
 * an empty plan when the feature is off or nothing resolves.
 */
export async function planCaptureEntityLinks(content: string, kind: CaptureKind): Promise<CaptureLinkPlan> {
  const empty: CaptureLinkPlan = { kind, participants: [], people: [], links: [] };
  if (!config.autoLink || !config.captureEntityLinks) return empty;
  try {
    const participants = parseCaptureParticipants(content);
    if (participants.length === 0) return empty;
    const index = await getPersonIndex();
    const lookup: LinkLookup = buildLinkLookup(getDocMeta().keys());
    const people: LinkedPerson[] = [];
    const seenPaths = new Set<string>();

    for (const p of participants) {
      const email = p.email?.toLowerCase();
      if (email && isAutomatedAddress(email)) continue;
      let path: string | undefined;
      let created = false;
      if (email) path = index.byEmail.get(email);
      if (!path && p.name) {
        path = index.byName.get(normalizeName(p.name));
        if (!path) {
          const target = resolveEntityTarget(p.name, lookup).target;
          // Only a note that lives in the people dir can stand for a person
          // from a header; a project or org note sharing the name must not.
          if (target && target.startsWith(`${index.dir}/`)) path = target;
        }
      }
      if (!path && email && p.name && isInternalEmail(email, index)) {
        path = await createPersonStub(p.name, email, index, kind);
        created = !!path;
      }
      if (!path || seenPaths.has(path)) continue;
      seenPaths.add(path);
      people.push({ name: displayNameFor(path, index.dir, p.name ?? email ?? path), path, role: p.role, email, created });
    }

    const links = people.map((person) => `[[${person.path.replace(/\.md$/i, '')}|${person.name}]]`);
    return { kind, participants, people, links };
  } catch (err) {
    logger.warn('planCaptureEntityLinks failed', { error: err instanceof Error ? err.message : String(err) });
    return empty;
  }
}

/** `## Entities (auto)` section for the capture body ('' when nothing resolved). */
export function renderCaptureEntitySection(plan: CaptureLinkPlan): string {
  if (plan.links.length === 0) return '';
  const lines = plan.people.map((p, i) => `- ${plan.links[i]} (${p.role})`);
  return `\n\n## Entities (auto)\n${lines.join('\n')}`;
}

// ── Commit (after the capture is written) ────────────────────────────────────

export interface CommitCaptureOptions {
  notePath: string;
  title: string;
  /** Capture date (YYYY-MM-DD); defaults to today. */
  date?: string;
  /** Pipeline message id (e.g. the `msg:<gmail id>` tag) for the timeline line. */
  messageId?: string;
}

const MAX_TIMELINE_BACKLINKS = 6;
const CO_MENTION_CAP = 6;

function messageIdFromTags(tags: string[] | undefined): string | undefined {
  for (const t of tags ?? []) {
    const m = /^msg:(.+)$/.exec(t);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Register the resolved people, seed the KG and append a timeline backlink to
 * each person note. Idempotent per capture path (a retried capture does not
 * duplicate the timeline line). Never throws.
 */
export async function commitCaptureEntityLinks(plan: CaptureLinkPlan, opts: CommitCaptureOptions & { tags?: string[] }): Promise<void> {
  if (plan.people.length === 0) return;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const messageId = opts.messageId ?? messageIdFromTags(opts.tags);
  const source = `capture:${plan.kind}:${opts.notePath}`;

  // 1. Registry: every linked person is a detected entity with a note.
  for (const person of plan.people) {
    try {
      registerEntity(person.name, 'person', {
        tier: 'detected',
        notePath: person.path,
        aliases: person.email ? [person.email] : undefined,
      });
    } catch { /* non-critical */ }
  }

  // 2. Knowledge graph: capture mentions each person; sender → recipients.
  if (config.autoSeedKg && config.kgEnabled && isKgInitialized()) {
    try {
      for (const person of plan.people) {
        kgAddTriple(opts.title, 'mentions_person', person.name, { source, confidence: 0.9 });
      }
      const senders = plan.people.filter((p) => p.role === 'from' || p.role === 'author');
      const recipients = plan.people.filter((p) => p.role === 'to' || p.role === 'cc');
      const predicate = plan.kind === 'email' ? 'emailed' : 'messaged';
      for (const s of senders) {
        for (const r of recipients.slice(0, CO_MENTION_CAP)) {
          if (s.name !== r.name) kgAddTriple(s.name, predicate, r.name, { source, confidence: 0.9 });
        }
      }
      const co = plan.people.slice(0, CO_MENTION_CAP);
      for (let i = 0; i < co.length; i++) {
        for (let j = i + 1; j < co.length; j++) {
          kgAddTriple(co[i].name, 'co_mentioned', co[j].name, { source, confidence: 0.5 });
        }
      }
    } catch (err) {
      logger.warn('capture KG seeding failed', { notePath: opts.notePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3. Timeline backlink on each person note (sender + recipients, capped).
  const capturePath = opts.notePath.replace(/\.md$/i, '');
  const sectionTitle = plan.kind === 'email' ? 'Email Timeline' : 'Mentions (auto)';
  const line = `- ${date} — ${opts.title} ([[${capturePath}|${plan.kind}]])${messageId ? ` [id:${messageId}]` : ''}`;
  for (const person of plan.people.slice(0, MAX_TIMELINE_BACKLINKS)) {
    try {
      const { content, etag } = await readNote(person.path);
      if (content.includes(`[[${capturePath}`)) continue;
      const { data, body } = parseFrontmatter(content);
      const nextBody = appendLineToSection(body, sectionTitle, line);
      const nextData = { ...data, last_contact: date, last_updated: date };
      await writeNote(person.path, stringifyFrontmatter(nextData, nextBody), etag);
      try { await indexNote(person.path); } catch { /* best-effort */ }
      try { updateGraphForNote(person.path, nextBody); } catch { /* best-effort */ }
    } catch (err) {
      logger.warn('capture timeline backlink failed', { person: person.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Capture kind from the pipeline's tags/source: email (`matrimail`), chat (`slack`, `teams`, `discord`, `chat`). */
export function detectCaptureKind(tags: string[], source: string): CaptureKind | undefined {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.includes('matrimail') || lower.includes('email')) return 'email';
  const chatHint = /\b(slack|teams|discord|chat|matrix|element)\b/i;
  if (lower.some((t) => chatHint.test(t)) || chatHint.test(source)) return 'chat';
  return undefined;
}
