import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTeam, getAgent, getSkill, type AgentDef } from '../lib/agents.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

/**
 * Resolve the ordered, deduplicated union of team+agent skill slugs and
 * render the =  SKILLS = section that gets injected into every prompt.
 * Unknown slugs become HTML-comment warnings so the prompt still renders
 * and the dispatcher can see which skills failed to resolve.
 */
async function renderSkillsSection(
  teamSkills: string[] | undefined,
  agentSkills: string[] | undefined,
): Promise<string> {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const s of [...(teamSkills ?? []), ...(agentSkills ?? [])]) {
    if (!seen.has(s)) {
      seen.add(s);
      ordered.push(s);
    }
  }

  if (ordered.length === 0) {
    return `=== SKILLS ===\n(none)\n`;
  }

  const blocks: string[] = [];
  for (const slug of ordered) {
    const skill = await getSkill(slug);
    if (!skill) {
      blocks.push(`<!-- WARNING: skill "${slug}" not found -->`);
      continue;
    }
    blocks.push(`## ${skill.display_name}\n${skill.body}`);
  }

  return `=== SKILLS ===\n${blocks.join('\n\n')}\n`;
}

/**
 * team_dispatch is a pure prompt renderer — it does not invoke any model.
 * The calling Claude process is expected to run the returned steps itself
 * (spawning sub-agents via the Task tool or similar) and then call this
 * tool again with mode="synthesize" to get the final prompt for the
 * synthesizer agent.
 */

function renderStepPrompt(args: {
  agent: AgentDef;
  team: { name: string; shared_context: string[] };
  task: string;
  priorWork: string;
  skillsSection: string;
}): string {
  const { agent, team, task, priorWork, skillsSection } = args;
  const shared =
    team.shared_context.length > 0 ? team.shared_context.join('\n') : '(none)';
  const prior = priorWork.trim() ? priorWork : '(none)';
  const tools =
    agent.allowed_tools.length > 0 ? agent.allowed_tools.join(', ') : '(any)';
  const sys = agent.system_prompt.trim() || '(agent system prompt not set)';

  return `=== ROLE ===
${sys}

=== TASK ===
${task}

=== SHARED CONTEXT ===
${shared}

${skillsSection}
=== PRIOR WORK ===
${prior}

=== OPERATING RULES ===
You may only use these tools: ${tools}
(This is advisory; enforce it yourself by not calling other tools.)

When done, call mcp__cortexmd__agent_diary_append with:
  agentName="${agent.name}"
  silent=false
  source="team:${team.name}"
  entry=<one-paragraph recap of what you did>`;
}

export function register(server: McpServer): void {
  server.tool(
    'team_dispatch',
    `Render prompts for a team launch. Two modes:

• mode="plan" (default) — load the team and every member agent, then return an ordered list of steps. Each step has the fully-rendered prompt, model, and allowed_tools for one member. For coordination="sequential" the prompts include an empty {{PRIOR_WORK}} placeholder the caller fills in between iterations; for "parallel" they are independent.

• mode="synthesize" — requires memberOutputs. Returns the prompt for the team's synthesizer, with each member's output labelled by agent name and role.

This tool only renders text; the caller is responsible for actually invoking the agents (e.g. via the Task tool) and feeding outputs back in for synthesis.`,
    {
      team: z.string().describe('Team name (matches Ops/Teams/<name>.md)'),
      task: z.string().describe('Task description handed to every member'),
      mode: z
        .enum(['plan', 'synthesize'])
        .optional()
        .default('plan')
        .describe('plan = render per-member prompts; synthesize = render the synthesizer prompt from member outputs'),
      memberOutputs: z
        .array(
          z.object({
            member: z.string(),
            output: z.string(),
          }),
        )
        .optional()
        .describe('Required when mode="synthesize": one entry per member with their produced output'),
      context: z
        .string()
        .optional()
        .describe('Extra free-form context appended to the synthesizer prompt'),
    },
    wrapToolHandler('team_dispatch', async (params) => {
      const teamName = (params.team as string).trim();
      const task = (params.task as string).trim();
      const mode = ((params.mode as string | undefined) ?? 'plan') as 'plan' | 'synthesize';
      const memberOutputs = params.memberOutputs as
        | Array<{ member: string; output: string }>
        | undefined;
      const context = (params.context as string | undefined)?.trim() ?? '';

      const team = await getTeam(teamName, false);
      if (!team) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'team_not_found', team: teamName }) },
          ],
          isError: true,
        };
      }

      if (mode === 'synthesize') {
        if (!memberOutputs || memberOutputs.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ error: 'memberOutputs_required' }) },
            ],
            isError: true,
          };
        }
        const synthName = team.synthesizer;
        if (!synthName) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ error: 'no_synthesizer', team: teamName }) },
            ],
            isError: true,
          };
        }
        const synth = await getAgent(synthName);
        if (!synth) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'synthesizer_not_found', synthesizer: synthName }),
              },
            ],
            isError: true,
          };
        }

        const roleByAgent = new Map<string, string>();
        for (const m of team.members) {
          roleByAgent.set(typeof m.agent === 'string' ? m.agent : m.agent.name, m.role);
        }

        const sections: string[] = [];
        for (const mo of memberOutputs) {
          const role = roleByAgent.get(mo.member) ?? '(unknown role)';
          sections.push(`--- MEMBER: ${mo.member} (${role}) ---\n${mo.output.trim()}`);
        }

        const shared =
          team.shared_context.length > 0 ? team.shared_context.join('\n') : '(none)';
        const sys = synth.system_prompt.trim() || '(agent system prompt not set)';
        const tools =
          synth.allowed_tools.length > 0 ? synth.allowed_tools.join(', ') : '(any)';
        const skillsSection = await renderSkillsSection(team.skills, synth.skills);

        const prompt = `=== ROLE ===
${sys}

=== TASK ===
${task}

=== SHARED CONTEXT ===
${shared}

${skillsSection}
=== MEMBER OUTPUTS ===
${sections.join('\n\n')}

${context ? `=== EXTRA CONTEXT ===\n${context}\n\n` : ''}=== OPERATING RULES ===
You may only use these tools: ${tools}
(This is advisory; enforce it yourself by not calling other tools.)

Produce the final consolidated result for the team. When done, call mcp__cortexmd__agent_diary_append with:
  agentName="${synth.name}"
  silent=false
  source="team:${team.name}"
  entry=<one-paragraph recap of what you synthesized>`;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  team: team.name,
                  synthesizer: synth.name,
                  model: synth.model,
                  allowed_tools: synth.allowed_tools,
                  prompt,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // mode === 'plan'
      const steps: Array<{
        order: number;
        member: string;
        role: string;
        description: string;
        prompt: string;
        model: string;
        allowed_tools: string[];
      }> = [];

      let order = 1;
      for (const m of team.members) {
        const memberName = typeof m.agent === 'string' ? m.agent : m.agent.name;
        const agent = await getAgent(memberName);
        if (!agent) {
          steps.push({
            order: order++,
            member: memberName,
            role: m.role,
            description: `Agent "${memberName}" not found in Ops/Agents/. Skipping — resolve this before dispatching.`,
            prompt: '',
            model: '',
            allowed_tools: [],
          });
          continue;
        }

        const priorWork = team.coordination === 'sequential' ? '{{PRIOR_WORK}}' : '';
        const skillsSection = await renderSkillsSection(team.skills, agent.skills);
        const prompt = renderStepPrompt({
          agent,
          team: { name: team.name, shared_context: team.shared_context },
          task,
          priorWork,
          skillsSection,
        });

        const desc = m.role
          ? `${agent.display_name} — ${m.role}`
          : agent.display_name;

        steps.push({
          order: order++,
          member: agent.name,
          role: m.role,
          description: desc,
          prompt,
          model: agent.model,
          allowed_tools: agent.allowed_tools,
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                team: team.name,
                coordination: team.coordination,
                synthesizer: team.synthesizer,
                steps,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );
}
