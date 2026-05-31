import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath, sanitizeContent } from '../lib/sanitize.js';
import { isKgInitialized, kgAddTriple } from '../lib/knowledge-graph.js';

interface EntitySpec {
  path: string;
  linksField: string;
  linkedPaths: { field: string; path: string }[];
}

export function register(server: McpServer): void {
  server.tool(
    "notes_link_entities",
    `Link person, org, and project entities together by updating their frontmatter with cross-references and evidence.

This tool creates structured relationships in the knowledge graph by adding cross-reference arrays (people_links, org_links, project_links) to each entity's frontmatter. Use it whenever you discover a connection between entities — e.g., a person works at an org, a person contributes to a project, or an org sponsors a project. Provide at least two of personPath/orgPath/projectPath. Each entity's note will be updated with links to the others, and evidence entries document why the link exists. These frontmatter links complement in-content [[wiki-links]] and make relationships queryable via search filters.

Link syntax reminder: in note body content, use [[Note Name]] for simple links, [[Note Name|alias]] for display text, [[Note Name#Section]] for heading links. This tool handles frontmatter cross-refs; for in-content links, use notes_upsert.`,
    {
      personPath: z.string().optional().describe("Vault-relative path to the person note (e.g. CRM/people/John Doe.md)"),
      orgPath: z.string().optional().describe("Vault-relative path to the org note (e.g. CRM/orgs/Acme Corp.md)"),
      projectPath: z.string().optional().describe("Vault-relative path to the project note (e.g. Projects/Project Alpha.md)"),
      evidence: z.array(z.string()).describe("Evidence entries documenting why these entities are linked (e.g. 'Met at conference 2025-03', 'Co-authored RFC-42')"),
    },
    wrapToolHandler("notes_link_entities", async (params) => {
      const personPath = params.personPath ? sanitizePath(params.personPath as string) : undefined;
      const orgPath = params.orgPath ? sanitizePath(params.orgPath as string) : undefined;
      const projectPath = params.projectPath ? sanitizePath(params.projectPath as string) : undefined;
      const evidence = (params.evidence as string[]).map((e) => sanitizeContent(e, 1000));
      const updatedPaths: string[] = [];

      // Build entity specs for each provided path
      const entities: EntitySpec[] = [];

      if (personPath) {
        const linkedPaths: { field: string; path: string }[] = [];
        if (orgPath) linkedPaths.push({ field: "org_links", path: orgPath });
        if (projectPath) linkedPaths.push({ field: "project_links", path: projectPath });
        entities.push({ path: personPath, linksField: "people_links", linkedPaths });
      }

      if (orgPath) {
        const linkedPaths: { field: string; path: string }[] = [];
        if (personPath) linkedPaths.push({ field: "people_links", path: personPath });
        if (projectPath) linkedPaths.push({ field: "project_links", path: projectPath });
        entities.push({ path: orgPath, linksField: "org_links", linkedPaths });
      }

      if (projectPath) {
        const linkedPaths: { field: string; path: string }[] = [];
        if (personPath) linkedPaths.push({ field: "people_links", path: personPath });
        if (orgPath) linkedPaths.push({ field: "org_links", path: orgPath });
        entities.push({ path: projectPath, linksField: "project_links", linkedPaths });
      }

      for (const entity of entities) {
        const { content } = await readNote(entity.path);
        const { data, body } = parseFrontmatter(content);

        // Add cross-reference links
        for (const link of entity.linkedPaths) {
          if (!Array.isArray(data[link.field])) {
            data[link.field] = [];
          }
          const arr = data[link.field] as string[];
          if (!arr.includes(link.path)) {
            arr.push(link.path);
          }
        }

        // Add evidence to sources
        if (!Array.isArray(data.sources)) {
          data.sources = [];
        }
        const sources = data.sources as string[];
        for (const entry of evidence) {
          if (!sources.includes(entry)) {
            sources.push(entry);
          }
        }

        const updated = stringifyFrontmatter(data, body);
        await writeNote(entity.path, updated);
        updatedPaths.push(entity.path);
      }

      // Seed KG triples for the entity relationships
      if (isKgInitialized()) {
        try {
          const extractName = (p: string) => p.replace(/\.md$/, '').split('/').pop() ?? p;
          if (personPath && orgPath) {
            kgAddTriple(extractName(personPath), 'works_at', extractName(orgPath), { source: personPath });
          }
          if (personPath && projectPath) {
            kgAddTriple(extractName(personPath), 'contributes_to', extractName(projectPath), { source: personPath });
          }
          if (orgPath && projectPath) {
            kgAddTriple(extractName(projectPath), 'owned_by', extractName(orgPath), { source: projectPath });
          }
        } catch {
          // Non-critical — don't fail linking if KG seeding fails
        }
      }

      if (updatedPaths.length > 0) {
        const linkedNames = updatedPaths.map((p) => `[[${p}]]`).join(", ");
        await appendJournalEntry(`Linked entities: ${linkedNames}`);
      }

      return {
        content: [
          { type: "text", text: JSON.stringify({ updatedPaths }) },
        ],
      };
    })
  );
}
