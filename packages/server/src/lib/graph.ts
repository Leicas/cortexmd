import { config } from '../config.js';
import { listFiles, readNote } from './vault.js';
import { listSourceVaultPaths } from './source-vaults.js';
import { extractWikilinks } from './markdown.js';
import { classifyPath } from './collections.js';
import { isKgInitialized, kgQueryEntity } from './knowledge-graph.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface GraphTraversalNode {
  path: string;
  title?: string;
  hops: number;
}

export interface GraphTraversalResult {
  nodes: GraphTraversalNode[];
  edges: Array<{ source: string; target: string }>;
}

export interface BridgeNode {
  path: string;
  collections: string[];
  linkCount: number;
}

export interface BrokenLink {
  sourcePath: string;
  brokenTarget: string;
  line?: number;
}

export interface ExtendedGraphStats {
  totalLinks: number;
  avgLinksPerNote: number;
  orphanNotes: number;
  mostLinked: Array<{ path: string; inbound: number }>;
  bridgeCount: number;
  connectedComponents: number;
  largestComponentSize: number;
  avgPathLength: number;
}

/** Cached link graph: source path -> set of resolved target paths */
let cachedGraph: Map<string, Set<string>> | null = null;

/** Cached reverse graph: target path -> array of source paths (backlinks) */
let cachedReverseGraph: Map<string, string[]> | null = null;

/** Cached basename lookup for wikilink resolution */
let cachedBasenameLookup: Map<string, string> | null = null;

/** Cached set of all known file paths */
let cachedAllFiles: Set<string> | null = null;

/**
 * Scan all vault .md files, extract wikilinks, and build an adjacency map.
 * Keys are vault-relative paths; values are arrays of resolved link target paths.
 */
export async function buildLinkGraph(): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();

  // Collect all files across vaults so we can resolve wikilink targets
  const allFiles: string[] = [];
  for (const vault of [config.brainVault, ...listSourceVaultPaths()]) {
    try {
      const files = await listFiles(vault);
      allFiles.push(...files);
    } catch {
      continue;
    }
  }

  // Build a lookup: basename (without .md) -> full relative path
  const basenameLookup = new Map<string, string>();
  for (const f of allFiles) {
    const base = f.replace(/\.md$/, '').split('/').pop()!;
    // First match wins (could be ambiguous, but simple heuristic)
    if (!basenameLookup.has(base)) {
      basenameLookup.set(base, f);
    }
  }

  const allFilesSet = new Set(allFiles);

  for (const filePath of allFiles) {
    try {
      const { content } = await readNote(filePath);
      const links = extractWikilinks(content);

      const resolved = links
        .map((target) => resolveWikilinkTarget(target, allFilesSet, basenameLookup))
        .filter((t): t is string => t !== undefined);

      graph.set(filePath, resolved);
    } catch {
      // Skip unreadable files
    }
  }

  return graph;
}

/**
 * Build the full link graph and store it in the module-level cache.
 * Called at startup and for force-rebuild scenarios.
 */
export async function buildAndCacheGraph(): Promise<void> {
  // Collect all files across vaults
  const allFiles: string[] = [];
  for (const vault of [config.brainVault, ...listSourceVaultPaths()]) {
    try {
      const files = await listFiles(vault);
      allFiles.push(...files);
    } catch {
      continue;
    }
  }

  // Build basename lookup
  const basenameLookup = new Map<string, string>();
  for (const f of allFiles) {
    const base = f.replace(/\.md$/, '').split('/').pop()!;
    if (!basenameLookup.has(base)) {
      basenameLookup.set(base, f);
    }
  }

  const allFilesSet = new Set(allFiles);
  const graph = new Map<string, Set<string>>();

  for (const filePath of allFiles) {
    try {
      const { content } = await readNote(filePath);
      const links = extractWikilinks(content);

      const resolved = links
        .map((target) => resolveWikilinkTarget(target, allFilesSet, basenameLookup))
        .filter((t): t is string => t !== undefined);

      graph.set(filePath, new Set(resolved));
    } catch {
      // Skip unreadable files
    }
  }

  cachedGraph = graph;
  cachedBasenameLookup = basenameLookup;
  cachedAllFiles = allFilesSet;

  // Pre-compute reverse graph (backlinks) to avoid rebuilding on every query
  cachedReverseGraph = buildReverseGraph(graph);
}

/**
 * Build reverse adjacency map from a forward graph.
 */
function buildReverseGraph(graph: Map<string, Set<string>>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [source, targets] of graph) {
    for (const target of targets) {
      const existing = reverse.get(target);
      if (existing) {
        existing.push(source);
      } else {
        reverse.set(target, [source]);
      }
    }
  }
  return reverse;
}

/**
 * Update the cached graph for a single note after it has been written.
 * Extracts wikilinks from the provided content and replaces that node's edges.
 */
export function updateGraphForNote(filePath: string, content: string): void {
  if (!cachedGraph || !cachedAllFiles || !cachedBasenameLookup) {
    // Cache not initialized yet; nothing to update
    return;
  }

  // Add the file to the known files set and basename lookup
  cachedAllFiles.add(filePath);
  const base = filePath.replace(/\.md$/, '').split('/').pop()!;
  if (!cachedBasenameLookup.has(base)) {
    cachedBasenameLookup.set(base, filePath);
  }

  // Remove old edges from the reverse graph before updating
  const oldTargets = cachedGraph.get(filePath);
  if (oldTargets && cachedReverseGraph) {
    for (const oldTarget of oldTargets) {
      const backlinks = cachedReverseGraph.get(oldTarget);
      if (backlinks) {
        const idx = backlinks.indexOf(filePath);
        if (idx !== -1) backlinks.splice(idx, 1);
      }
    }
  }

  // Extract and resolve wikilinks from the new content
  const links = extractWikilinks(content);
  const resolved = links
    .map((target) => resolveWikilinkTarget(target, cachedAllFiles!, cachedBasenameLookup!))
    .filter((t): t is string => t !== undefined);

  // Replace the node's edges in the cached graph
  cachedGraph.set(filePath, new Set(resolved));

  // Update reverse graph with new edges
  if (cachedReverseGraph) {
    for (const target of resolved) {
      const existing = cachedReverseGraph.get(target);
      if (existing) {
        if (!existing.includes(filePath)) existing.push(filePath);
      } else {
        cachedReverseGraph.set(target, [filePath]);
      }
    }
  }
}

/**
 * Force-invalidate the cached graph so it will be rebuilt on next access.
 */
export function invalidateGraphCache(): void {
  cachedGraph = null;
  cachedReverseGraph = null;
  cachedBasenameLookup = null;
  cachedAllFiles = null;
}

/**
 * Compute link density stats from the cached graph.
 * Returns null if the graph has not been built yet.
 */
export function getGraphStats(): {
  totalLinks: number;
  avgLinksPerNote: number;
  orphanNotes: number;
  mostLinked: Array<{ path: string; inbound: number }>;
} | null {
  if (!cachedGraph) return null;

  let totalLinks = 0;
  const inboundCounts = new Map<string, number>();

  // Initialize all known nodes with 0 inbound
  for (const source of cachedGraph.keys()) {
    if (!inboundCounts.has(source)) inboundCounts.set(source, 0);
  }

  for (const [, targets] of cachedGraph) {
    totalLinks += targets.size;
    for (const t of targets) {
      inboundCounts.set(t, (inboundCounts.get(t) ?? 0) + 1);
    }
  }

  const nodeCount = cachedGraph.size;
  const avgLinksPerNote = nodeCount > 0 ? totalLinks / nodeCount : 0;

  // Orphan notes: no outbound links AND no inbound links
  let orphanNotes = 0;
  for (const [source, targets] of cachedGraph) {
    const outbound = targets.size;
    const inbound = inboundCounts.get(source) ?? 0;
    if (outbound === 0 && inbound === 0) orphanNotes++;
  }

  // Most linked (by inbound count)
  const sorted = [...inboundCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, inbound]) => ({ path, inbound }));

  return { totalLinks, avgLinksPerNote, orphanNotes, mostLinked: sorted };
}

/**
 * Resolve a wikilink target string to a vault-relative file path.
 */
function resolveWikilinkTarget(
  target: string,
  allFiles: Set<string>,
  basenameLookup: Map<string, string>,
): string | undefined {
  // Normalize: strip heading/block refs
  const cleaned = target.split('#')[0].trim();
  if (!cleaned) return undefined;

  // Try exact match with .md
  const withMd = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;
  if (allFiles.has(withMd)) return withMd;

  // Try basename lookup
  const baseName = cleaned.split('/').pop()!;
  const found = basenameLookup.get(baseName);
  if (found) return found;

  // Try with forward slashes normalized
  const normalized = withMd.replace(/\\/g, '/');
  if (allFiles.has(normalized)) return normalized;

  return undefined;
}

/**
 * Scan all vault .md files and report wiki-links whose targets do not resolve.
 * Returns {sourcePath, brokenTarget, line?} entries.
 *
 * Uses the same basename-lookup strategy as buildLinkGraph so results match
 * what the graph considers "resolvable". Line numbers are best-effort —
 * located by a simple line-by-line scan for `[[...]]` occurrences.
 */
export async function findBrokenLinks(): Promise<BrokenLink[]> {
  // Collect all files across vaults so we can resolve wikilink targets
  const allFiles: string[] = [];
  for (const vault of [config.brainVault, ...listSourceVaultPaths()]) {
    try {
      const files = await listFiles(vault);
      allFiles.push(...files);
    } catch {
      continue;
    }
  }

  // Build basename lookup: basename (without .md) -> full relative path
  const basenameLookup = new Map<string, string>();
  for (const f of allFiles) {
    const base = f.replace(/\.md$/, '').split('/').pop()!;
    if (!basenameLookup.has(base)) {
      basenameLookup.set(base, f);
    }
  }

  const allFilesSet = new Set(allFiles);
  const broken: BrokenLink[] = [];
  const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

  for (const filePath of allFiles) {
    try {
      const { content } = await readNote(filePath);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match: RegExpExecArray | null;
        // Reset regex state per line
        wikilinkRegex.lastIndex = 0;
        while ((match = wikilinkRegex.exec(line)) !== null) {
          const target = match[1].trim();
          if (!target) continue;
          const resolved = resolveWikilinkTarget(target, allFilesSet, basenameLookup);
          if (resolved === undefined) {
            broken.push({
              sourcePath: filePath,
              brokenTarget: target,
              line: i + 1,
            });
          }
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return broken;
}

/**
 * Public reverse-graph accessor: returns inbound link count per node, or null
 * if the cache has not been built yet. Useful for tools that need the full map
 * without exposing internal structures.
 */
export function getInboundLinkCounts(): Map<string, number> | null {
  if (!cachedGraph) return null;
  const counts = new Map<string, number>();
  for (const source of cachedGraph.keys()) {
    if (!counts.has(source)) counts.set(source, 0);
  }
  for (const [, targets] of cachedGraph) {
    for (const t of targets) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Get outgoing link counts from the cached graph. Keys are source paths,
 * values are outgoing link counts. Null if not built.
 */
export function getOutgoingLinkCounts(): Map<string, number> | null {
  if (!cachedGraph) return null;
  const counts = new Map<string, number>();
  for (const [source, targets] of cachedGraph) {
    counts.set(source, targets.size);
  }
  return counts;
}

export interface GraphSnapshotNode {
  id: string;
  label: string;
  group: string;
  deg: number;
  inDeg: number;
  outDeg: number;
}

export interface GraphSnapshot {
  nodes: GraphSnapshotNode[];
  edges: Array<{ source: string; target: string }>;
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
}

/**
 * Serialize the cached link graph into a node+edge set for the dashboard graph
 * canvas. Builds the cache on first call (reuses the startup-built cache after
 * that). When the vault has more notes than `limit`, returns the `limit`
 * most-connected nodes (by total degree) and only the edges among them, with
 * `truncated=true` and honest totals — so the canvas stays fast without a
 * Barnes-Hut optimization and nothing is silently dropped.
 */
export async function getGraphSnapshot(limit = 800): Promise<GraphSnapshot> {
  if (!cachedGraph) await buildAndCacheGraph();
  const graph = cachedGraph!;

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const node of graph.keys()) {
    inDeg.set(node, 0);
    outDeg.set(node, 0);
  }
  let totalEdges = 0;
  for (const [source, targets] of graph) {
    outDeg.set(source, targets.size);
    for (const t of targets) {
      inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
      totalEdges++;
    }
  }

  const allNodes = [...graph.keys()];
  const totalNodes = allNodes.length;
  const degOf = (n: string): number => (inDeg.get(n) ?? 0) + (outDeg.get(n) ?? 0);

  // limit <= 0 (or non-finite) means "no cap — return every node".
  const noLimit = !Number.isFinite(limit) || limit <= 0;
  const truncated = !noLimit && totalNodes > limit;
  const selected = truncated
    ? [...allNodes].sort((a, b) => degOf(b) - degOf(a)).slice(0, limit)
    : allNodes;
  const keep = new Set(selected);

  const nodes: GraphSnapshotNode[] = selected.map((id) => ({
    id,
    label: id.replace(/\.md$/, '').split('/').pop() || id,
    group: classifyPath(id),
    deg: degOf(id),
    inDeg: inDeg.get(id) ?? 0,
    outDeg: outDeg.get(id) ?? 0,
  }));

  const edges: Array<{ source: string; target: string }> = [];
  for (const [source, targets] of graph) {
    if (!keep.has(source)) continue;
    for (const t of targets) {
      if (keep.has(t)) edges.push({ source, target: t });
    }
  }

  return { nodes, edges, totalNodes, totalEdges, truncated };
}

/**
 * BFS traversal from a node up to a given depth, returning nodes and edges.
 */
export async function getNeighbors(
  nodePath: string,
  depth = 1,
): Promise<{ nodes: string[]; edges: Array<{ from: string; to: string }> }> {
  // Use cached graph if available, otherwise build and cache it
  if (!cachedGraph) {
    await buildAndCacheGraph();
  }
  const graph = cachedGraph!;
  const reverseGraph = cachedReverseGraph!;

  const visited = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  const queue: Array<{ node: string; currentDepth: number }> = [
    { node: nodePath, currentDepth: 0 },
  ];
  visited.add(nodePath);

  while (queue.length > 0) {
    const { node, currentDepth } = queue.shift()!;
    if (currentDepth >= depth) continue;

    // Outgoing links
    const outgoing = graph.get(node);
    const outgoingArr = outgoing ? [...outgoing] : [];
    for (const target of outgoingArr) {
      edges.push({ from: node, to: target });
      if (!visited.has(target)) {
        visited.add(target);
        queue.push({ node: target, currentDepth: currentDepth + 1 });
      }
    }

    // Incoming links (backlinks)
    const incoming = reverseGraph.get(node) ?? [];
    for (const source of incoming) {
      edges.push({ from: source, to: node });
      if (!visited.has(source)) {
        visited.add(source);
        queue.push({ node: source, currentDepth: currentDepth + 1 });
      }
    }
  }

  // Deduplicate edges
  const edgeSet = new Set(edges.map((e) => `${e.from}|${e.to}`));
  const uniqueEdges = [...edgeSet].map((e) => {
    const [from, to] = e.split('|');
    return { from, to };
  });

  return { nodes: [...visited], edges: uniqueEdges };
}

// ── Phase 7: Graph Traversal & Bridge Detection ─────────────────────────

/**
 * BFS traversal from a start node, tracking hop distance for each discovered node.
 * Uses a visited Set for O(V) tracking. Caps results at `limit` to prevent blowup.
 */
export async function bfsTraverse(
  startPath: string,
  maxHops: number,
  limit = 50,
): Promise<GraphTraversalResult> {
  if (!cachedGraph) {
    await buildAndCacheGraph();
  }
  const graph = cachedGraph!;
  const reverseGraph = cachedReverseGraph!;

  const visited = new Map<string, number>(); // path -> hops
  const edges: Array<{ source: string; target: string }> = [];
  const edgeSet = new Set<string>();
  const queue: Array<{ node: string; hops: number }> = [{ node: startPath, hops: 0 }];
  visited.set(startPath, 0);

  while (queue.length > 0 && visited.size <= limit) {
    const { node, hops } = queue.shift()!;
    if (hops >= maxHops) continue;

    const nextHops = hops + 1;

    // Outgoing links
    const outgoing = graph.get(node);
    if (outgoing) {
      for (const target of outgoing) {
        const edgeKey = `${node}|${target}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({ source: node, target });
        }
        if (!visited.has(target) && visited.size < limit) {
          visited.set(target, nextHops);
          queue.push({ node: target, hops: nextHops });
        }
      }
    }

    // Incoming links (backlinks)
    const incoming = reverseGraph.get(node) ?? [];
    for (const source of incoming) {
      const edgeKey = `${source}|${node}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({ source, target: node });
      }
      if (!visited.has(source) && visited.size < limit) {
        visited.set(source, nextHops);
        queue.push({ node: source, hops: nextHops });
      }
    }
  }

  const nodes: GraphTraversalNode[] = [];
  for (const [nodePath, hops] of visited) {
    const title = nodePath.replace(/\.md$/, '').split('/').pop() ?? nodePath;
    nodes.push({ path: nodePath, title, hops });
  }

  return { nodes, edges };
}

/**
 * Find bridge nodes: notes whose outgoing + incoming links span 2+ different collections.
 * Single-pass over the graph. If collectionA/B specified, only return bridges connecting those.
 */
export async function findBridgeNodes(
  collectionA?: string,
  collectionB?: string,
): Promise<BridgeNode[]> {
  if (!cachedGraph) {
    await buildAndCacheGraph();
  }
  const graph = cachedGraph!;
  const reverseGraph = cachedReverseGraph!;

  const bridges: BridgeNode[] = [];

  // Single pass: for each node, collect collections of all linked nodes
  for (const nodePath of graph.keys()) {
    const linkedCollections = new Set<string>();
    let linkCount = 0;

    // Outgoing links
    const outgoing = graph.get(nodePath);
    if (outgoing) {
      for (const target of outgoing) {
        linkedCollections.add(classifyPath(target));
        linkCount++;
      }
    }

    // Incoming links
    const incoming = reverseGraph.get(nodePath) ?? [];
    for (const source of incoming) {
      linkedCollections.add(classifyPath(source));
      linkCount++;
    }

    // A bridge must span 2+ collections
    if (linkedCollections.size < 2) continue;

    // If specific collections requested, the bridge must connect both
    if (collectionA && collectionB) {
      if (!linkedCollections.has(collectionA) || !linkedCollections.has(collectionB)) {
        continue;
      }
    } else if (collectionA) {
      if (!linkedCollections.has(collectionA)) continue;
    } else if (collectionB) {
      if (!linkedCollections.has(collectionB)) continue;
    }

    bridges.push({
      path: nodePath,
      collections: [...linkedCollections].sort(),
      linkCount,
    });
  }

  // Sort by linkCount descending
  bridges.sort((a, b) => b.linkCount - a.linkCount);
  return bridges;
}

/**
 * Extended graph stats: basic stats plus bridge count, connected components
 * (via union-find with path compression + rank), and sampled average path length.
 */
export async function getExtendedGraphStats(): Promise<ExtendedGraphStats | null> {
  const basic = getGraphStats();
  if (!basic || !cachedGraph) return null;

  const graph = cachedGraph;
  const reverseGraph = cachedReverseGraph!;
  const allNodes = [...graph.keys()];

  // --- Bridge count (single pass) ---
  let bridgeCount = 0;
  for (const nodePath of allNodes) {
    const linkedCollections = new Set<string>();
    const outgoing = graph.get(nodePath);
    if (outgoing) {
      for (const target of outgoing) {
        linkedCollections.add(classifyPath(target));
      }
    }
    const incoming = reverseGraph.get(nodePath) ?? [];
    for (const source of incoming) {
      linkedCollections.add(classifyPath(source));
    }
    if (linkedCollections.size >= 2) bridgeCount++;
  }

  // --- Connected components via Union-Find with path compression + rank ---
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = x;
    while (current !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const rankA = rank.get(rootA) ?? 0;
    const rankB = rank.get(rootB) ?? 0;
    if (rankA < rankB) {
      parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      parent.set(rootB, rootA);
    } else {
      parent.set(rootB, rootA);
      rank.set(rootA, rankA + 1);
    }
  }

  // Initialize each node as its own parent
  for (const node of allNodes) {
    parent.set(node, node);
    rank.set(node, 0);
  }

  // Union connected nodes
  for (const [source, targets] of graph) {
    for (const target of targets) {
      if (parent.has(target)) {
        union(source, target);
      }
    }
  }

  // Count components and find largest
  const componentSizes = new Map<string, number>();
  for (const node of allNodes) {
    const root = find(node);
    componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
  }

  const connectedComponents = componentSizes.size;
  let largestComponentSize = 0;
  for (const size of componentSizes.values()) {
    if (size > largestComponentSize) largestComponentSize = size;
  }

  // --- Average path length (sampled BFS, 100 random starts, max 10 hops each) ---
  const sampleCount = Math.min(100, allNodes.length);
  let totalPathLength = 0;
  let totalPairs = 0;

  for (let s = 0; s < sampleCount; s++) {
    const startIdx = Math.floor(Math.random() * allNodes.length);
    const startNode = allNodes[startIdx];

    // BFS from startNode, cap at 10 hops
    const distances = new Map<string, number>();
    distances.set(startNode, 0);
    const bfsQueue: string[] = [startNode];
    let head = 0;

    while (head < bfsQueue.length) {
      const current = bfsQueue[head++];
      const dist = distances.get(current)!;
      if (dist >= 10) continue;

      const outgoing = graph.get(current);
      if (outgoing) {
        for (const neighbor of outgoing) {
          if (!distances.has(neighbor)) {
            distances.set(neighbor, dist + 1);
            bfsQueue.push(neighbor);
          }
        }
      }

      const incoming = reverseGraph.get(current) ?? [];
      for (const neighbor of incoming) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, dist + 1);
          bfsQueue.push(neighbor);
        }
      }
    }

    // Sum up distances (exclude the start node itself)
    for (const [, dist] of distances) {
      if (dist > 0) {
        totalPathLength += dist;
        totalPairs++;
      }
    }
  }

  const avgPathLength = totalPairs > 0 ? totalPathLength / totalPairs : 0;

  return {
    ...basic,
    bridgeCount,
    connectedComponents,
    largestComponentSize,
    avgPathLength: Math.round(avgPathLength * 100) / 100,
  };
}

/**
 * Get KG-sourced neighbors for a note by matching its title/path against KG entity names.
 * Returns edges from the temporal knowledge graph that complement wiki-link neighbors.
 */
export function getKgNeighbors(
  nodePath: string,
): Array<{ entity: string; predicate: string; direction: 'outgoing' | 'incoming' }> {
  if (!isKgInitialized()) return [];

  // Derive entity name from path: "Projects/Acme.md" -> "Acme", "CRM/people/John Doe.md" -> "John Doe"
  const title = nodePath.replace(/\.md$/, '').split('/').pop() ?? nodePath;

  try {
    const result = kgQueryEntity(title, 'both');
    return result.triples.map(t => ({
      entity: t.subject === title ? t.object : t.subject,
      predicate: t.predicate,
      direction: t.subject === title ? 'outgoing' as const : 'incoming' as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Check if a node is a cross-collection bridge (links span 2+ collections).
 */
export function isBridgeNode(nodePath: string): { isBridge: boolean; collections: string[] } {
  if (!cachedGraph || !cachedReverseGraph) return { isBridge: false, collections: [] };

  const linkedCollections = new Set<string>();

  const outgoing = cachedGraph.get(nodePath);
  if (outgoing) {
    for (const target of outgoing) {
      linkedCollections.add(classifyPath(target));
    }
  }

  const incoming = cachedReverseGraph.get(nodePath) ?? [];
  for (const source of incoming) {
    linkedCollections.add(classifyPath(source));
  }

  const collections = [...linkedCollections].sort();
  return { isBridge: collections.length >= 2, collections };
}
