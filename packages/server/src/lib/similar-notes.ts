import { hybridSearch } from './search.js';
import { logger } from './logger.js';

export interface SimilarNote {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

export interface SimilarNotesResult {
  similarNotes: SimilarNote[];
  suggestion: string | null;
}

/**
 * Find notes similar to the given content, excluding a specific path.
 * Uses the existing hybrid search (lexical + semantic via RRF).
 *
 * @param text       The content to search for similar notes
 * @param excludePath  Path to exclude from results (the note just created/updated)
 * @param limit      Max number of similar notes to return (default 5)
 * @param minScore   Minimum fused score threshold to avoid noise (default 0.005)
 * @param rerank     Whether to apply the LLM reranking pass. Defaults to false:
 *                   internal similarity enrichment does not need (and should not
 *                   pay for) an LLM rerank. Callers may pass true to opt back in.
 */
export async function findSimilarNotes(
  text: string,
  excludePath: string,
  limit = 5,
  minScore = 0.005,
  rerank = false,
): Promise<SimilarNotesResult> {
  try {
    // Use a truncated version of the content as the query to keep it focused
    const queryText = text.slice(0, 500).replace(/^---[\s\S]*?---\s*/, '');
    if (queryText.trim().length < 10) {
      return { similarNotes: [], suggestion: null };
    }

    const results = await hybridSearch(queryText, { limit: limit + 5, rerank });

    const similarNotes: SimilarNote[] = results
      .filter(r => r.path !== excludePath && r.fusedScore >= minScore)
      .slice(0, limit)
      .map(r => ({
        path: r.path,
        title: r.title,
        score: Math.round(r.fusedScore * 1000) / 1000,
        snippet: r.snippet.slice(0, 150),
      }));

    const suggestion = similarNotes.length > 0
      ? `Found ${similarNotes.length} similar note${similarNotes.length > 1 ? 's' : ''} -- consider consolidating or linking related content.`
      : null;

    return { similarNotes, suggestion };
  } catch (err) {
    logger.warn('Failed to find similar notes', { error: String(err) });
    return { similarNotes: [], suggestion: null };
  }
}
