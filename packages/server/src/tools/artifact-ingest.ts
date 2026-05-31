import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote, resolveSafePathForRead, writeBinaryFile } from '../lib/vault.js';
import { stringifyFrontmatter, ensureId } from '../lib/frontmatter.js';
import { appendToContent } from '../lib/markdown.js';
import { appendJournalEntry } from '../lib/journal.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath, sanitizeContent } from '../lib/sanitize.js';
import { config } from '../config.js';

export function register(server: McpServer): void {
  server.tool(
    "artifact_ingest",
    `Ingest an artifact (image, audio, or URL) into the vault and optionally link it to a note. For image/audio: upload the file first via POST ${config.publicUrl}/upload (multipart/form-data, field 'file', API key auth), then pass the returned path here. Alternatively, provide base64Content for small files. When targetNotePath is provided, the artifact is embedded using Obsidian syntax: ![[path]] for files or a markdown link + [[wiki-link]] for URLs. This connects the artifact to the knowledge graph`,
    {
      artifactPath: z.string().describe("Original filename or path for the artifact. For url kind: the URL. For image/audio: the desired filename (e.g. 'screenshot.png') or existing vault path"),
      kind: z.enum(["image", "audio", "url"]).describe("Type of artifact"),
      metadata: z.record(z.string()).describe("Key-value metadata for the artifact"),
      targetNotePath: z.string().optional().describe("Vault-relative path to a note to link the artifact in"),
      base64Content: z.string().optional().describe("Base64-encoded file content for uploading image/audio artifacts into the vault"),
    },
    wrapToolHandler("artifact_ingest", async (params) => {
      const artifactPath = params.artifactPath as string;
      const kind = params.kind as "image" | "audio" | "url";
      const metadata = params.metadata as Record<string, string>;
      const base64Content = params.base64Content as string | undefined;
      const targetNotePath = params.targetNotePath
        ? sanitizePath(params.targetNotePath as string)
        : undefined;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const linkedIn: string[] = [];

      let storedPath: string;

      if (kind === 'url') {
        // Create a note for the URL
        const urlTitle = sanitizeContent(
          metadata.title || artifactPath.replace(/https?:\/\//, '').slice(0, 50),
          200,
        );
        const sanitized = urlTitle.replace(/[\\/:*?"<>|]/g, '-');
        storedPath = `Assets/url/${dateStr}/${sanitized}.md`;

        let fm: Record<string, any> = {
          type: 'artifact',
          kind: 'url',
          url: artifactPath,
          created: dateStr,
          ...metadata,
        };
        fm = ensureId(fm);

        const content = stringifyFrontmatter(fm, `\n# ${urlTitle}\n\nSource: ${artifactPath}\n`);
        await writeNote(storedPath, content);
      } else if (base64Content) {
        // Upload file from base64 content
        const filename = path.basename(artifactPath).replace(/[\\/:*?"<>|]/g, '-');
        storedPath = `Assets/${kind}/${dateStr}/${filename}`;
        await writeBinaryFile(storedPath, base64Content);
      } else {
        // File artifact already in vault -- validate it exists
        const sanitizedArtifactPath = sanitizePath(artifactPath);
        const resolvedArtifact = await resolveSafePathForRead(sanitizedArtifactPath, true);
        try {
          await stat(resolvedArtifact);
        } catch {
          throw new Error(`Artifact file not found and no base64Content provided for upload: ${artifactPath}`);
        }

        const filename = path.basename(sanitizedArtifactPath);
        storedPath = `Assets/${kind}/${dateStr}/${filename}`;
      }

      // Link to target note if provided
      if (targetNotePath) {
        try {
          const { content, etag } = await readNote(targetNotePath);
          const linkText = kind === 'url'
            ? `\n- [${metadata.title || 'Link'}](${artifactPath}) — [[${storedPath}]]\n`
            : `\n- ![[${storedPath}]]\n`;
          const updated = appendToContent(content, linkText);
          await writeNote(targetNotePath, updated, etag);
          linkedIn.push(targetNotePath);
        } catch {
          // Target note doesn't exist -- create it
          let fm: Record<string, any> = {
            type: 'note',
            created: dateStr,
          };
          fm = ensureId(fm);
          const linkText = kind === 'url'
            ? `- [${metadata.title || 'Link'}](${artifactPath}) — [[${storedPath}]]\n`
            : `- ![[${storedPath}]]\n`;
          const content = stringifyFrontmatter(fm, `\n# Artifacts\n\n${linkText}`);
          await writeNote(targetNotePath, content);
          linkedIn.push(targetNotePath);
        }
      }

      await appendJournalEntry(`Ingested ${kind} artifact: [[${storedPath}]]`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ storedPath, linkedIn }),
        }],
      };
    })
  );
}
