/**
 * OAuth Clients tab — server-rendered HTML fragment for #tab-oauth.
 *
 * A self-service console for the OAuth 2.0 stack the server already ships
 * (oauth.ts): see the endpoint values an external client (n8n's "Generic
 * OAuth2 API" credential) needs, register a new client and grab its
 * client_id/secret once, and review/revoke existing clients.
 *
 * All values are filled client-side by `assets/tabs/oauth.js` from
 * `GET /dashboard/api/oauth/clients` (NOT over SSE — this tab has its own
 * one-shot fetch). Mutations go through `cortex.oauthCreate` / `cortex.oauthDelete`.
 */
import { card, sectionHead, statusPill } from '../components.js';

/** One "key : copyable mono value" row for the connection-settings panel. */
function settingRow(label: string, valueHtml: string): string {
  return `<div style="display:grid;grid-template-columns:13rem 1fr;gap:.5rem;align-items:baseline;padding:.3rem 0;border-bottom:1px solid var(--line-faint)">
    <div class="card-label" style="margin:0">${label}</div>
    <div>${valueHtml}</div>
  </div>`;
}

/** A click-to-copy mono span (reuses core's cortex.copyLogLine). */
function copyVal(id: string): string {
  return `<span class="mono" id="${id}" title="Click to copy" style="cursor:pointer;word-break:break-all" onclick="cortex.copyLogLine(this)">—</span>`;
}

export function renderOAuthTab(): string {
  // ── Connection settings (filled client-side) ──────────────────────────────
  const connect = card(`
    ${sectionHead('Connect n8n (or any OAuth2 client)', statusPill('scope: mcp:tools', 'muted', { dot: false }))}
    <div class="sowhat" style="margin-top:0">
      <span><b>Two steps.</b> ① In n8n, add a <b>Generic OAuth2 API</b> credential and copy the
      <b>OAuth Redirect URL</b> it shows you. ② Paste that URL in <b>Register a client</b> below,
      click <b>Create client</b>, then copy the generated <b>Client ID</b> &amp; <b>Secret</b> back into
      n8n along with the URLs here. Use <b>Authentication: Body</b> and <b>Grant Type: Authorization Code</b>.</span>
    </div>
    <div style="margin-top:.75rem">
      ${settingRow('Grant Type', '<span class="mono">Authorization Code</span>')}
      ${settingRow('Authorization URL', copyVal('oauthAuthUrl'))}
      ${settingRow('Access Token URL', copyVal('oauthTokenUrl'))}
      ${settingRow('Scope', '<span class="mono">mcp:tools</span>')}
      ${settingRow('Authentication', '<span class="mono">Body (client_secret_post)</span>')}
    </div>
  `);

  // ── Register a new client ─────────────────────────────────────────────────
  const register = card(`
    ${sectionHead('Register a client', '')}
    <div class="field" style="margin-bottom:.6rem">
      <label class="field-label" for="oauthClientName">Client name</label>
      <input class="input" id="oauthClientName" type="text" value="n8n" autocomplete="off" />
    </div>
    <div class="field" style="margin-bottom:.6rem">
      <label class="field-label" for="oauthRedirectUris">Redirect URL(s) — one per line</label>
      <textarea class="textarea mono" id="oauthRedirectUris" rows="2"
        placeholder="https://your-n8n-host/rest/oauth2-credential/callback"></textarea>
    </div>
    <button type="button" class="btn btn-primary" onclick="cortex.oauthCreate()">Create client</button>
    <div id="oauthCreateResult" style="margin-top:.75rem"></div>
  `);

  // ── Existing clients ──────────────────────────────────────────────────────
  const list = card(`
    ${sectionHead('Registered clients', statusPill('live', 'muted', { dot: false }))}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Client ID</th>
            <th>Redirect URIs</th>
            <th>Registered</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="oauthClientsBody"></tbody>
      </table>
    </div>
  `);

  return `<div class="grid">
    <div class="col-6">${connect}</div>
    <div class="col-6">${register}</div>
    <div class="col-12">${list}</div>
  </div>`;
}
