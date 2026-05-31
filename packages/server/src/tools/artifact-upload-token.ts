import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { generateUploadToken } from '../lib/upload-tokens.js';
import { config } from '../config.js';

export function register(server: McpServer): void {
  server.tool(
    "artifact_upload_token",
    `Generate a single-use upload token for uploading files to the vault. The token is valid for 5 minutes. Use it with: POST ${config.publicUrl}/upload (multipart/form-data, field 'file', header 'X-Upload-Token: <token>'). The response returns the vault path to pass to artifact_ingest.`,
    {},
    wrapToolHandler("artifact_upload_token", async () => {
      const { token, expiresAt } = generateUploadToken();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            uploadUrl: `${config.publicUrl}/upload`,
            token,
            expiresAt: new Date(expiresAt).toISOString(),
            usage: `curl -X POST ${config.publicUrl}/upload -H "X-Upload-Token: ${token}" -F "file=@/path/to/file"`,
          }),
        }],
      };
    })
  );
}
