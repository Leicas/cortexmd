import path from 'node:path';
import { stat } from 'node:fs/promises';
import { glob } from 'glob';
import { config } from '../config.js';
import { readNote } from './vault.js';
import { parseFrontmatter } from './frontmatter.js';

/**
 * Agent/team registry — reads `Ops/Agents/*.md` and `Ops/Teams/*.md` from the
 * read-write vault. Notes are cached by mtime; a stale cache entry is thrown
 * out and re-parsed on the next access.
 *
 * Agents declare role, model, allowed tools and a System Prompt H2 section
 * that is extracted and exposed to callers so team-dispatch can stitch
 * multi-agent workflows together.
 */

export type TeamCoordination = 'parallel' | 'sequential' | 'debate' | 'router';

export interface AgentDef {
  name: string;
  display_name: string;
  role: string;
  model: string;
  allowed_tools: string[];
  diary_subdir: string;
  tags: string[];
  skills: string[];
  system_prompt: string;
  raw_markdown: string;
  path: string;
}

export interface TeamMemberRef {
  agent: string;
  role: string;
}

export interface TeamDef {
  name: string;
  display_name: string;
  coordination: TeamCoordination;
  members: TeamMemberRef[];
  synthesizer?: string;
  shared_context: string[];
  tags: string[];
  skills: string[];
  raw_markdown: string;
  path: string;
}

export interface SkillDef {
  name: string;
  display_name: string;
  description: string;
  trigger: string;
  tags: string[];
  body: string;
  path: string;
}

const AGENTS_DIR = 'Ops/Agents';
const TEAMS_DIR = 'Ops/Teams';
const SKILLS_DIR = 'Ops/Skills';
const KEBAB_RE = /^[a-z0-9-]+$/;

interface CacheEntry<T> {
  mtimeMs: number;
  value: T;
}

const agentCache = new Map<string, CacheEntry<AgentDef>>();
const teamCache = new Map<string, CacheEntry<TeamDef>>();
const skillCache = new Map<string, CacheEntry<SkillDef>>();

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

function extractSystemPrompt(body: string): string {
  // Grab everything under "## System Prompt" up to the next H2 (or EOF).
  // JS regex has no \Z, so we match to next H2 or rely on the lazy match
  // stopping at the final newline via a secondary anchor.
  const withNext = body.match(/^##\s+System\s+Prompt\s*$([\s\S]*?)(?=^##\s+)/im);
  if (withNext) return withNext[1].trim();
  const toEnd = body.match(/^##\s+System\s+Prompt\s*$([\s\S]*)$/im);
  return toEnd ? toEnd[1].trim() : '';
}

function parseAgent(filePath: string, content: string): AgentDef | null {
  const { data: fm, body } = parseFrontmatter(content);
  if (fm.type !== 'agent') return null;

  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name || !KEBAB_RE.test(name)) return null;

  const display_name =
    (typeof fm.display_name === 'string' && fm.display_name.trim()) ||
    (typeof fm.title === 'string' && fm.title.trim()) ||
    name;

  return {
    name,
    display_name,
    role: typeof fm.role === 'string' ? fm.role : '',
    model: typeof fm.model === 'string' ? fm.model : '',
    allowed_tools: toStringArray(fm.allowed_tools),
    diary_subdir: typeof fm.diary_subdir === 'string' ? fm.diary_subdir : name,
    tags: toStringArray(fm.tags),
    skills: toStringArray(fm.skills).filter((s) => KEBAB_RE.test(s)),
    system_prompt: extractSystemPrompt(body),
    raw_markdown: body,
    path: filePath,
  };
}

function parseTeam(filePath: string, content: string): TeamDef | null {
  const { data: fm, body } = parseFrontmatter(content);
  if (fm.type !== 'team') return null;

  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name || !KEBAB_RE.test(name)) return null;

  const display_name =
    (typeof fm.display_name === 'string' && fm.display_name.trim()) ||
    (typeof fm.title === 'string' && fm.title.trim()) ||
    name;

  const coordRaw =
    typeof fm.coordination === 'string' ? fm.coordination.trim().toLowerCase() : 'parallel';
  const coordination: TeamCoordination =
    coordRaw === 'parallel' || coordRaw === 'sequential' || coordRaw === 'debate' || coordRaw === 'router'
      ? coordRaw
      : 'parallel';

  const members: TeamMemberRef[] = [];
  if (Array.isArray(fm.members)) {
    for (const m of fm.members) {
      if (typeof m === 'string' && KEBAB_RE.test(m)) {
        members.push({ agent: m, role: '' });
      } else if (m && typeof m === 'object') {
        const obj = m as Record<string, unknown>;
        const agent = typeof obj.agent === 'string' ? obj.agent.trim() : '';
        const role = typeof obj.role === 'string' ? obj.role : '';
        if (agent && KEBAB_RE.test(agent)) {
          members.push({ agent, role });
        }
      }
    }
  }

  const synthRaw = typeof fm.synthesizer === 'string' ? fm.synthesizer.trim() : '';
  const synthesizer = synthRaw && KEBAB_RE.test(synthRaw) ? synthRaw : undefined;

  return {
    name,
    display_name,
    coordination,
    members,
    synthesizer,
    shared_context: toStringArray(fm.shared_context),
    tags: toStringArray(fm.tags),
    skills: toStringArray(fm.skills).filter((s) => KEBAB_RE.test(s)),
    raw_markdown: body,
    path: filePath,
  };
}

function parseSkill(filePath: string, content: string): SkillDef | null {
  const { data: fm, body } = parseFrontmatter(content);
  if (fm.type !== 'skill') return null;

  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name || !KEBAB_RE.test(name)) return null;

  const display_name =
    (typeof fm.display_name === 'string' && fm.display_name.trim()) ||
    (typeof fm.title === 'string' && fm.title.trim()) ||
    name;

  return {
    name,
    display_name,
    description: typeof fm.description === 'string' ? fm.description : '',
    trigger: typeof fm.trigger === 'string' ? fm.trigger : '',
    tags: toStringArray(fm.tags),
    body: body.trim(),
    path: filePath,
  };
}

async function listMdFilesInRwVault(subdir: string): Promise<Array<{ rel: string; abs: string }>> {
  const base = path.resolve(config.brainVault, subdir);
  let names: string[];
  try {
    names = await glob('*.md', { cwd: base, nodir: true, posix: true });
  } catch {
    return [];
  }
  return names.map((n) => ({
    rel: `${subdir}/${n}`,
    abs: path.resolve(base, n),
  }));
}

async function loadAgentFromFile(rel: string, abs: string): Promise<AgentDef | null> {
  let st;
  try {
    st = await stat(abs);
  } catch {
    agentCache.delete(rel);
    return null;
  }
  const cached = agentCache.get(rel);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.value;

  let content: string;
  try {
    ({ content } = await readNote(rel));
  } catch {
    agentCache.delete(rel);
    return null;
  }
  const parsed = parseAgent(rel, content);
  if (!parsed) {
    agentCache.delete(rel);
    return null;
  }
  agentCache.set(rel, { mtimeMs: st.mtimeMs, value: parsed });
  return parsed;
}

async function loadTeamFromFile(rel: string, abs: string): Promise<TeamDef | null> {
  let st;
  try {
    st = await stat(abs);
  } catch {
    teamCache.delete(rel);
    return null;
  }
  const cached = teamCache.get(rel);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.value;

  let content: string;
  try {
    ({ content } = await readNote(rel));
  } catch {
    teamCache.delete(rel);
    return null;
  }
  const parsed = parseTeam(rel, content);
  if (!parsed) {
    teamCache.delete(rel);
    return null;
  }
  teamCache.set(rel, { mtimeMs: st.mtimeMs, value: parsed });
  return parsed;
}

async function loadSkillFromFile(rel: string, abs: string): Promise<SkillDef | null> {
  let st;
  try {
    st = await stat(abs);
  } catch {
    skillCache.delete(rel);
    return null;
  }
  const cached = skillCache.get(rel);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.value;

  let content: string;
  try {
    ({ content } = await readNote(rel));
  } catch {
    skillCache.delete(rel);
    return null;
  }
  const parsed = parseSkill(rel, content);
  if (!parsed) {
    skillCache.delete(rel);
    return null;
  }
  skillCache.set(rel, { mtimeMs: st.mtimeMs, value: parsed });
  return parsed;
}

async function loadAllAgents(): Promise<AgentDef[]> {
  const files = await listMdFilesInRwVault(AGENTS_DIR);
  const out: AgentDef[] = [];
  for (const { rel, abs } of files) {
    const a = await loadAgentFromFile(rel, abs);
    if (a) out.push(a);
  }
  return out;
}

async function loadAllTeams(): Promise<TeamDef[]> {
  const files = await listMdFilesInRwVault(TEAMS_DIR);
  const out: TeamDef[] = [];
  for (const { rel, abs } of files) {
    const t = await loadTeamFromFile(rel, abs);
    if (t) out.push(t);
  }
  return out;
}

async function loadAllSkills(): Promise<SkillDef[]> {
  const files = await listMdFilesInRwVault(SKILLS_DIR);
  const out: SkillDef[] = [];
  for (const { rel, abs } of files) {
    const s = await loadSkillFromFile(rel, abs);
    if (s) out.push(s);
  }
  return out;
}

export type AgentSummary = Pick<AgentDef, 'name' | 'display_name' | 'role' | 'model' | 'tags' | 'path'>;

export async function listAgents(filter?: { tag?: string }): Promise<AgentSummary[]> {
  const agents = await loadAllAgents();
  const tag = filter?.tag?.trim();
  const filtered = tag ? agents.filter((a) => a.tags.includes(tag)) : agents;
  return filtered.map((a) => ({
    name: a.name,
    display_name: a.display_name,
    role: a.role,
    model: a.model,
    tags: a.tags,
    path: a.path,
  }));
}

export async function getAgent(name: string): Promise<AgentDef | null> {
  if (!name || !KEBAB_RE.test(name)) return null;
  const rel = `${AGENTS_DIR}/${name}.md`;
  const abs = path.resolve(config.brainVault, AGENTS_DIR, `${name}.md`);
  return await loadAgentFromFile(rel, abs);
}

export type TeamSummary = Pick<TeamDef, 'name' | 'display_name' | 'coordination' | 'tags' | 'path'> & {
  member_count: number;
};

export async function listTeams(filter?: { tag?: string }): Promise<TeamSummary[]> {
  const teams = await loadAllTeams();
  const tag = filter?.tag?.trim();
  const filtered = tag ? teams.filter((t) => t.tags.includes(tag)) : teams;
  return filtered.map((t) => ({
    name: t.name,
    display_name: t.display_name,
    coordination: t.coordination,
    tags: t.tags,
    path: t.path,
    member_count: t.members.length,
  }));
}

export type ResolvedTeam = Omit<TeamDef, 'members'> & {
  members: Array<{ agent: string | AgentDef; role: string }>;
};

export async function getTeam(name: string, resolveMembers = false): Promise<ResolvedTeam | null> {
  if (!name || !KEBAB_RE.test(name)) return null;
  const rel = `${TEAMS_DIR}/${name}.md`;
  const abs = path.resolve(config.brainVault, TEAMS_DIR, `${name}.md`);
  const team = await loadTeamFromFile(rel, abs);
  if (!team) return null;

  if (!resolveMembers) {
    return { ...team, members: team.members.map((m) => ({ agent: m.agent, role: m.role })) };
  }

  const resolved: Array<{ agent: string | AgentDef; role: string }> = [];
  for (const m of team.members) {
    const agentDef = await getAgent(m.agent);
    resolved.push({ agent: agentDef ?? m.agent, role: m.role });
  }
  return { ...team, members: resolved };
}

export type SkillSummary = Pick<SkillDef, 'name' | 'display_name' | 'description' | 'trigger' | 'tags' | 'path'>;

export async function listSkills(filter?: { tag?: string }): Promise<SkillSummary[]> {
  const skills = await loadAllSkills();
  const tag = filter?.tag?.trim();
  const filtered = tag ? skills.filter((s) => s.tags.includes(tag)) : skills;
  return filtered.map((s) => ({
    name: s.name,
    display_name: s.display_name,
    description: s.description,
    trigger: s.trigger,
    tags: s.tags,
    path: s.path,
  }));
}

export async function getSkill(name: string): Promise<SkillDef | null> {
  if (!name || !KEBAB_RE.test(name)) return null;
  const rel = `${SKILLS_DIR}/${name}.md`;
  const abs = path.resolve(config.brainVault, SKILLS_DIR, `${name}.md`);
  return await loadSkillFromFile(rel, abs);
}
