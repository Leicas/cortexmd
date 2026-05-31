import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getNeighbors, getKgNeighbors, isBridgeNode } from '../lib/graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    "graph_neighbors",
    `Get neighboring nodes and edges for a given note in the knowledge graph built from [[wiki-links]].

Returns all notes connected to the given note via outgoing links (notes it references) and backlinks (notes that reference it), up to the specified traversal depth. Use this to: discover related context before answering questions, find candidates for new links (if A links to B and B links to C, maybe A should link to C), identify isolated notes that need better connections, and understand the local structure around any topic. The graph is bidirectional — a [[wiki-link]] in note A pointing to note B creates an edge from A to B and a backlink edge from B to A.

Set includeKg to also return relationships from the temporal knowledge graph (entity triples). Set includeBridgeInfo to annotate which neighbor nodes are cross-collection bridges.`,
    {
      nodePath: z.string().describe("Vault-relative path of the node to query (e.g. Projects/Acme.md)"),
      depth: z.number().optional().describe("Traversal depth — 1 for direct neighbors, 2+ to explore wider context (default 1)"),
      includeKg: z.boolean().optional().describe("Include relationships from the temporal knowledge graph (default true)"),
      includeBridgeInfo: z.boolean().optional().describe("Annotate which nodes are cross-collection bridges (default false)"),
    },
    wrapToolHandler("graph_neighbors", async (params) => {
      const nodePath = sanitizePath(params.nodePath as string);
      const includeKg = (params.includeKg as boolean | undefined) !== false;
      const includeBridgeInfo = (params.includeBridgeInfo as boolean | undefined) === true;

      const result = await getNeighbors(nodePath, params.depth as number | undefined);
      const response: Record<string, unknown> = { nodes: result.nodes, edges: result.edges };

      if (includeKg) {
        const kgEdges = getKgNeighbors(nodePath);
        if (kgEdges.length > 0) {
          response.kgRelationships = kgEdges;
        }
      }

      if (includeBridgeInfo) {
        const bridgeInfo: Record<string, string[]> = {};
        for (const node of result.nodes) {
          const info = isBridgeNode(node);
          if (info.isBridge) {
            bridgeInfo[node] = info.collections;
          }
        }
        if (Object.keys(bridgeInfo).length > 0) {
          response.bridges = bridgeInfo;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response),
          },
        ],
      };
    })
  );
}
