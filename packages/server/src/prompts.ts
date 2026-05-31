import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCollectionNames } from './lib/collections.js';

/**
 * Register all MCP prompts on the server.
 */
export function registerPrompts(server: McpServer): void {
  // ── Prompt 1: memory-search-strategy ────────────────────────────────
  server.prompt(
    'memory-search-strategy',
    'Guides how to effectively search and retrieve memories from the vault',
    {
      query: z.string().describe('The search query or topic to find'),
      context: z
        .string()
        .optional()
        .describe('What the user is currently working on'),
    },
    (args) => {
      const contextClause = args.context
        ? `\nThe user is currently working on: ${args.context}\nTailor your search to prioritize results relevant to this context.`
        : '';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Search the vault for information related to: "${args.query}"`,
                contextClause,
                '',
                'Follow this search strategy for best results:',
                '',
                '1. **Start with memory_recall** (if available) or **notes_search** with the query.',
                '   Hot and warm memories surface first — these are the most actively used notes.',
                '',
                '2. **Broaden with notes_search** using keyword variations and synonyms.',
                '   Try different phrasings if the first search returns few results.',
                '   Use scopePaths to narrow by directory (e.g., "Memories/People/", "Projects/").',
                '',
                '3. **Check graph_neighbors** on any promising results.',
                '   Related notes are often linked and provide valuable context.',
                '   Follow links 1-2 hops deep for comprehensive coverage.',
                '',
                '4. **Use tags_list or notes_search with tag filters** to discover related tags.',
                '   Tags like #project, #person, #decision often connect disparate notes.',
                '   Combine tag filters with keyword search for precision.',
                '',
                '5. **Read the full note** with notes_get when a snippet looks relevant.',
                '   Snippets can be misleading — always verify with the full content.',
                '',
                'Tips:',
                '- Date filters (dateFrom/dateTo) help when looking for recent activity.',
                '- Check the memory://hot-items resource for currently active notes.',
                '- If searching for a person or org, also search for their name as a wiki-link target.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  // ── Prompt 2: memory-triage ─────────────────────────────────────────
  server.prompt(
    'memory-triage',
    'Process and categorize new information for storage in the vault',
    {
      information: z
        .string()
        .describe('The new information to triage and store'),
      source: z
        .string()
        .optional()
        .describe('Where this information came from (e.g., meeting, article, conversation)'),
    },
    (args) => {
      const sourceClause = args.source
        ? `\nSource: ${args.source}`
        : '';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Triage and store the following information in the vault:`,
                '',
                `"${args.information}"`,
                sourceClause,
                '',
                'Follow this process:',
                '',
                '1. **Determine the memory category.** Choose the most appropriate type:',
                '   - `observation` — something noticed, observed, or spotted',
                '   - `decision` — a decision that was made, with rationale',
                '   - `insight` — a learned lesson, pattern, or realization',
                '   - `conversation` — notes from a discussion, meeting, or call',
                '   - `fact` — factual information for future lookup',
                '   - `preference` — a like, dislike, or preference',
                '   - `plan` — a goal, milestone, roadmap, or next steps',
                '   - `reflection` — a retrospective, lesson learned, or takeaway',
                '',
                '2. **Assess importance and temperature.**',
                '   - Is this actively needed right now? (hot)',
                '   - Will it be relevant in the near future? (warm)',
                '   - Is it archival or reference-only? (cold)',
                '',
                '3. **Identify related existing notes.**',
                '   - Use notes_search to find notes that should link to/from this one.',
                '   - Use graph_neighbors on related notes to discover connection opportunities.',
                '   - Check for existing person/org/project notes that should be cross-referenced.',
                '',
                '4. **Store with notes_upsert** (or the appropriate tool):',
                '   - Place in the correct directory (e.g., Memories/People/, Memories/Projects/).',
                '   - Include proper frontmatter: type, category, tags, temperature.',
                '   - Add wiki-links [[target]] to related notes in the body.',
                '   - Use notes_link_entities to formalize discovered connections.',
                '',
                '5. **Log the activity** with journal_append so the daily note reflects this addition.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  // ── Prompt 3: daily-review ──────────────────────────────────────────
  server.prompt(
    'daily-review',
    'Conduct a daily review of the vault — decay old memories, surface hot items, identify consolidation opportunities',
    {
      date: z
        .string()
        .optional()
        .describe('Date for the review in YYYY-MM-DD format (defaults to today)'),
    },
    (args) => {
      const date =
        args.date || new Date().toISOString().slice(0, 10);

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Conduct a daily vault review for ${date}.`,
                '',
                'Follow these steps in order:',
                '',
                '1. **Refresh memory temperatures.**',
                '   Run memory_temperature_refresh with writeFrontmatter=true.',
                '   This recalculates heat scores based on recency, links, and open tasks.',
                '   Notes that have gone cold will be decayed; active notes will be promoted.',
                '',
                '2. **Review hot items.**',
                '   Check the memory://hot-items resource or use notes_search scoped to hot-temperature notes.',
                '   For each hot item, verify it still deserves hot status:',
                '   - Is there pending action?',
                '   - Has activity actually occurred recently?',
                '   - Should any be manually cooled or archived?',
                '',
                '3. **Check open tasks.**',
                '   Read memory://open-tasks for all unchecked items across the vault.',
                '   Identify tasks that are overdue or blocked.',
                '   Use tasks_resolve for any completed tasks.',
                '',
                '4. **Identify consolidation opportunities.**',
                '   Look for clusters of related warm/hot notes that could be merged.',
                '   Check for duplicate or near-duplicate information.',
                '   Use graph_neighbors to find poorly-connected notes that should be linked.',
                '',
                '5. **Generate the daily brief.**',
                `   Run brief_daily with date="${date}" and audience="internal".`,
                '   This produces a summary of key updates, open tasks, and hot items.',
                '',
                '6. **Log the review** with journal_append:',
                `   "Daily review completed for ${date}: [summary of actions taken]."`,
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  // ── Prompt 4: entity-linking-guide ──────────────────────────────────
  server.prompt(
    'entity-linking-guide',
    'Guide for discovering and creating links between person, org, and project entities',
    {
      entityPath: z
        .string()
        .describe('Vault-relative path to the entity note (e.g., "Memories/People/Alice.md")'),
    },
    (args) => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Discover and create links for the entity at: ${args.entityPath}`,
                '',
                'Follow these steps:',
                '',
                '1. **Read the entity note.**',
                `   Use notes_get to read "${args.entityPath}".`,
                '   Identify the entity name, type (person/org/project), and existing links.',
                '   Note any tags, related entities mentioned in the body, and metadata.',
                '',
                '2. **Check existing links with graph_neighbors.**',
                `   Run graph_neighbors on "${args.entityPath}".`,
                '   Review both incoming and outgoing links.',
                '   Identify any broken or missing expected connections.',
                '',
                '3. **Search for unlinked mentions.**',
                '   Extract the entity name from the note title or frontmatter.',
                '   Use notes_search with the entity name as the query.',
                '   Check each result for mentions that are not yet wiki-linked.',
                '   Also search for common aliases or abbreviations of the entity name.',
                '',
                '4. **Create discovered connections.**',
                `   Use notes_link_entities with sourcePath="${args.entityPath}" and the discovered target paths.`,
                '   This creates bidirectional wiki-links between the entity and related notes.',
                '   Verify the link type is appropriate (e.g., "works-at", "member-of", "related-to").',
                '',
                '5. **Check for missing reciprocal links.**',
                '   For each linked entity, verify they also link back.',
                '   Use graph_neighbors on linked entities to confirm bidirectional connections.',
                '',
                '6. **Update tags if needed.**',
                '   Ensure the entity has appropriate tags (#person, #org, #project).',
                '   Add context tags that match related notes (e.g., #engineering, #client).',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  // ── Prompt 5: memory-wakeup-guide ──────────────────────────────────
  server.prompt(
    'memory-wakeup-guide',
    'Layered memory retrieval guide — progressively load context from identity through full search',
    {
      context: z
        .string()
        .optional()
        .describe('Current conversation context or topic of interest'),
    },
    (args) => {
      const collections = getCollectionNames();
      const contextClause = args.context
        ? `\nCurrent context: "${args.context}"\nUse this to decide which collection to focus on in L2.`
        : '';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                'Use the layered memory retrieval system to progressively load context.',
                contextClause,
                '',
                '**Layer 0 -- Identity (~100 tokens):**',
                '1. Run `memory_wakeup` with default settings (no collection focus).',
                '   This returns L0 (identity summary) and L1 (top memories by collection).',
                '   L0 tells you what this vault is about -- its shape and collections.',
                '',
                '**Layer 1 -- Essential Narrative (~800 tokens):**',
                '2. Review the L1 output. It shows the hottest notes grouped by collection.',
                '   These are the most actively used pieces of knowledge.',
                '   Use this to understand what the user has been working on recently.',
                '',
                '**Layer 2 -- Filtered Recall (~500 tokens):**',
                '3. If the conversation has a specific focus, run `memory_wakeup` again with:',
                '   - `collection`: the relevant collection name',
                '   - `includeL2: true`',
                '   - Optionally `category` to narrow further (e.g., "decision", "plan")',
                `   Available collections: ${collections.join(', ')}`,
                '',
                '**Layer 3 -- Full Search:**',
                '4. If you need specific information, use `memory_recall` or `notes_search`',
                '   with targeted queries. This is the most expensive layer but most precise.',
                '',
                'Tips:',
                '- Start every new conversation with L0+L1 (a single `memory_wakeup` call).',
                '- Only go deeper (L2, L3) when the conversation narrows to a specific topic.',
                '- The token budget parameter lets you control how much context to load.',
                '- Hot notes (high heat score) are the most relevant -- cold notes are archival.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  // ── Prompt 6: conversation-mining-guide ────────────────────────────
  server.prompt(
    'conversation-mining-guide',
    'Guide for extracting and storing knowledge from conversation transcripts',
    {
      format: z
        .string()
        .optional()
        .describe('Format of the conversation (e.g., "slack", "email", "meeting-notes", "chat")'),
    },
    (args) => {
      const formatClause = args.format
        ? `\nThe conversation format is: ${args.format}`
        : '';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                'Extract and store knowledge from a conversation transcript.',
                formatClause,
                '',
                'Follow these steps:',
                '',
                '1. **Identify the format.**',
                '   Determine the conversation format (Slack, email, meeting notes, etc.).',
                '   Different formats have different structures -- adapt extraction accordingly.',
                '   Key differences: timestamps, participants, threading, formality level.',
                '',
                '2. **Dry-run extraction first.**',
                '   If a `conversations_mine` tool is available, run it with `dryRun: true`.',
                '   This previews what would be extracted without committing to the vault.',
                '   Review the proposed extractions for accuracy and completeness.',
                '',
                '3. **Review extractions.**',
                '   For each proposed extraction, verify:',
                '   - The category is correct (decision, insight, plan, fact, etc.)',
                '   - The importance level is appropriate',
                '   - Key entities (people, projects, orgs) are identified',
                '   - No sensitive information is being stored unintentionally',
                '',
                '4. **Commit extractions.**',
                '   Run the extraction again without dryRun (or use `memory_store` manually).',
                '   Each extraction becomes a memory note in the appropriate category directory.',
                '',
                '5. **Check for duplicates.**',
                '   After storing, use `notes_search` to look for similar existing notes.',
                '   If duplicates are found, consider using `memory_consolidate` to merge them.',
                '',
                '6. **Link entities.**',
                '   For each extracted memory that mentions people, orgs, or projects:',
                '   - Check if entity notes already exist',
                '   - Use `notes_link_entities` to create bidirectional links',
                '   - Add relevant tags to improve discoverability',
                '',
                '7. **Log the mining session.**',
                '   Use `journal_append` to record what was mined and how many extractions were made.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  // ── Prompt 7: knowledge-graph-guide ────────────────────────────────
  server.prompt(
    'knowledge-graph-guide',
    'Guide for working with the knowledge graph -- adding facts, querying relationships, checking timelines',
    {
      entity: z
        .string()
        .optional()
        .describe('The entity to focus on (e.g., a person name, project, or concept)'),
    },
    (args) => {
      const entityClause = args.entity
        ? `\nFocus entity: "${args.entity}"`
        : '';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                'Work with the knowledge graph to manage structured facts and relationships.',
                entityClause,
                '',
                'Follow these steps:',
                '',
                '1. **Check if the entity exists.**',
                '   Search for the entity using `notes_search` with the entity name.',
                '   Check `graph_neighbors` to see existing connections.',
                '   If the knowledge graph module is available, query it directly.',
                '',
                '2. **Query existing relationships.**',
                '   Use `graph_neighbors` on the entity note to see all connections.',
                '   Look for incoming and outgoing links.',
                '   Note the types of relationships (works-at, member-of, related-to, etc.).',
                '',
                '3. **Add new facts.**',
                '   When adding new relationships or facts:',
                '   - Ensure the subject and object entities both have notes',
                '   - Use `notes_link_entities` for wiki-link based relationships',
                '   - If a KG tool is available, use it for structured triples (subject, predicate, object)',
                '   - Include provenance: where did this fact come from?',
                '',
                '4. **Set validity windows.**',
                '   Facts change over time. When adding facts:',
                '   - Record when the fact became true (validFrom)',
                '   - If known, record when it stopped being true (validTo)',
                '   - Example: "Alice works-at Acme" validFrom=2024-01 validTo=2025-03',
                '',
                '5. **Check for contradictions via timeline.**',
                '   Before adding a new fact, check if it contradicts existing facts.',
                '   Example: if adding "Alice works-at NewCo", check if there is an active',
                '   "Alice works-at OldCo" that should be closed (set validTo).',
                '   Look for temporal overlaps in relationships of the same type.',
                '',
                '6. **Verify and cross-reference.**',
                '   After making changes, run `graph_neighbors` again to verify.',
                '   Check that bidirectional links are consistent.',
                '   Use `notes_search` to find any unlinked mentions of the entity.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  // ── Prompt 8: dream-cycle ─────────────────────────────────────────
  server.prompt(
    'dream-cycle',
    'Run a full dream cycle — memory consolidation, theme detection, orphan cleanup, and connection discovery',
    {
      daysBack: z
        .string()
        .optional()
        .describe('Number of days to look back for activity analysis (default: 7)'),
      aggressive: z
        .string()
        .optional()
        .describe('Set to "true" to enable auto-archive alongside decay'),
    },
    (args) => {
      const daysBack = args.daysBack || '7';
      const aggressive = args.aggressive === 'true';

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Run a dream cycle — the vault's memory consolidation and maintenance process.`,
                '',
                'Follow these steps in order:',
                '',
                '1. **Run the dream cycle.**',
                `   Call \`memory_dream\` with daysBack=${daysBack}, autoDecay=true${aggressive ? ', autoArchive=true' : ''}.`,
                '   This performs: temperature refresh, activity analysis, theme detection,',
                '   orphan identification, connection discovery, and consolidation grouping.',
                '',
                '2. **Review the dream report.**',
                '   Examine the returned themes, orphans, connections, and consolidation groups.',
                '   Pay special attention to:',
                '   - **Hot orphans** — actively used but disconnected memories that need links',
                '   - **High-confidence connections** — note pairs sharing many tags but not linked',
                '   - **Large consolidation groups** — clusters of cold notes ready to merge',
                '',
                '3. **Act on connection suggestions.**',
                '   For each high-confidence connection (>0.7):',
                '   - Read both notes with `notes_get`',
                '   - If they genuinely relate, use `notes_link_entities` to connect them',
                '   - Add appropriate wiki-links in the note bodies',
                '',
                '4. **Consolidate memory clusters.**',
                '   For each consolidation group:',
                '   - Read the source notes to understand the common thread',
                '   - Write a concise summary that captures the shared insight',
                '   - Use `memory_consolidate` with the source paths and your summary',
                '',
                '5. **Handle orphan memories.**',
                '   For orphans marked "link": find related notes and create connections',
                '   For orphans marked "archive": verify they\'re truly stale, then archive',
                '   For orphans marked "review": read and decide — promote, link, or archive',
                '',
                '6. **Promote important discoveries.**',
                '   If you found insights during consolidation that deserve high visibility:',
                '   - Use `memory_promote` with action="boost" to increase their temperature',
                '   - Add a reason so the promotion is tracked',
                '',
                '7. **Write a dream diary entry.**',
                '   Use `diary_write` to record:',
                '   - How many themes were found and what they represent',
                '   - Actions taken (links created, memories consolidated, items archived)',
                '   - Any patterns or concerns noticed about vault health',
                '   - Suggestions for the user to review',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );
}
