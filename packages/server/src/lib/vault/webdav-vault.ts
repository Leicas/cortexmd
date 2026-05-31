import { Buffer } from 'node:buffer';
import { computeEtag } from '../hash.js';
import { logger } from '../logger.js';
import type { IVault, VaultEntry, VaultStat } from './ivault.js';

/**
 * WebDavVault — optional WebDAV source transport.
 *
 * Source vaults configured as `webdav+https://user:pass@host/path` (or
 * `webdav+http://...`) are read over WebDAV using the global `fetch` (Node 22,
 * no SDK dependency). `list()` issues a `PROPFIND` with `Depth: infinity` and
 * parses the multistatus XML for markdown hrefs; `read()`/`stat()` issue
 * `GET`/`HEAD`. `refresh()` revalidates the cached listing + per-path ETags so a
 * subsequent `list`/`read` reflects the latest upstream snapshot.
 *
 * Like every source transport this is READ-ONLY: the server never writes to a
 * source vault (all writes land in the brain vault via `resolveSafePath`), so
 * there is no PUT/MKCOL/DELETE path here and no merge logic — a refresh is a
 * plain "fetch the latest snapshot and re-index the diff".
 *
 * The XML parsing here is intentionally dependency-free — it extracts
 * `<d:href>` values and their `<d:getetag>` / `<d:getcontentlength>` /
 * `<d:getlastmodified>` props via regex rather than a full XML parser. It
 * tolerates the common `D:`/`d:`/no-prefix namespace shapes plus CDATA sections
 * and entity-escaped hrefs (see `parseMultiStatus`), and is covered by recorded
 * sample-payload unit tests.
 *
 * TODO(network): the parser has NOT been validated against a live server's full
 * behaviour matrix — specifically: sabredav-specific prop quirks, chunked /
 * streamed multistatus bodies (we buffer the whole response via res.text()),
 * lock-token (`<d:lockdiscovery>`) responses, and 401/digest-auth challenges
 * (only HTTP Basic is implemented). Validate against a real WebDAV server (and
 * consider an opt-in `webdav` dep) before relying on it in production.
 */
export class WebDavVault implements IVault {
  readonly name: string;
  /** `webdav+https://...` source spec (may embed `user:pass@`). */
  readonly url: string;
  /** Base URL the WebDAV collection is rooted at (scheme normalized, no creds). */
  readonly baseUrl: string;
  /** Authorization header value, if credentials were embedded in the spec. */
  private readonly authHeader: string | undefined;

  /** Cached listing (relPath -> stat-ish), populated lazily / on refresh(). */
  private listing = new Map<string, VaultStat>();
  /** Cached per-path ETags from the last PROPFIND, for refresh revalidation. */
  private etags = new Map<string, string>();
  private listed = false;

  constructor(name: string, spec: string) {
    this.name = name;
    this.url = spec;
    const { baseUrl, authHeader } = parseWebDavSpec(spec);
    this.baseUrl = baseUrl;
    this.authHeader = authHeader;
  }

  async *list(prefix?: string): AsyncIterable<VaultEntry> {
    await this.ensureListed();
    const norm = prefix ? normalizeRel(prefix) : '';
    for (const relPath of this.listing.keys()) {
      if (norm && !relPath.startsWith(norm.endsWith('/') ? norm : `${norm}/`)) continue;
      yield { relPath };
    }
  }

  async read(relPath: string): Promise<{ content: Buffer; etag: string }> {
    const rel = normalizeRel(relPath);
    const res = await this.dav('GET', rel);
    if (!res.ok) {
      throw new Error(`WebDavVault GET ${rel} failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Match LocalVault/readNote: ETag hashes the UTF-8 string content, so the
    // same content yields the same ETag regardless of transport.
    const etag = computeEtag(buf.toString('utf-8'));
    return { content: buf, etag };
  }

  async stat(relPath: string): Promise<VaultStat | null> {
    const rel = normalizeRel(relPath);
    const cached = this.listing.get(rel);
    if (cached) return cached;
    const res = await this.dav('HEAD', rel);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`WebDavVault HEAD ${rel} failed: ${res.status} ${res.statusText}`);
    }
    const size = Number(res.headers.get('content-length') ?? 0);
    const lastMod = res.headers.get('last-modified');
    const mtimeMs = lastMod ? Date.parse(lastMod) : Date.now();
    return { relPath: rel, size, mtimeMs: Number.isNaN(mtimeMs) ? Date.now() : mtimeMs };
  }

  /**
   * Revalidate the listing + ETags by re-issuing the PROPFIND. On failure the
   * previous snapshot is kept (logged, not thrown) so a transient network
   * blip doesn't crash the refresh job — mirroring GitPullVault.refresh().
   */
  async refresh(): Promise<void> {
    try {
      await this.propfind();
      logger.info('WebDavVault refreshed', { name: this.name, entries: this.listing.size });
    } catch (err) {
      logger.warn('WebDavVault refresh (PROPFIND) failed — keeping previous snapshot', {
        name: this.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ensureListed(): Promise<void> {
    if (this.listed) return;
    await this.propfind();
  }

  /** PROPFIND Depth: infinity → populate `listing` + `etags` for markdown files. */
  private async propfind(): Promise<void> {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop>' +
      '<D:getetag/><D:getcontentlength/><D:getlastmodified/><D:resourcetype/>' +
      '</D:prop></D:propfind>';
    const res = await this.dav('PROPFIND', '', {
      headers: { Depth: 'infinity', 'Content-Type': 'application/xml' },
      body,
    });
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDavVault PROPFIND failed: ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    const listing = new Map<string, VaultStat>();
    const etags = new Map<string, string>();
    for (const resp of parseMultiStatus(xml)) {
      if (!resp.href.toLowerCase().endsWith('.md')) continue;
      const rel = this.hrefToRel(resp.href);
      if (rel === null) continue;
      listing.set(rel, {
        relPath: rel,
        size: resp.contentLength ?? 0,
        mtimeMs: resp.lastModifiedMs ?? Date.now(),
      });
      if (resp.etag) etags.set(rel, resp.etag);
    }
    this.listing = listing;
    this.etags = etags;
    this.listed = true;
  }

  /** Build the absolute request URL for a vault-relative path. */
  private urlFor(rel: string): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    return rel ? new URL(rel.split('/').map(encodeURIComponent).join('/'), base).toString() : base;
  }

  /** Convert an absolute/relative WebDAV href back to a vault-relative path. */
  private hrefToRel(href: string): string | null {
    let basePath: string;
    try {
      basePath = new URL(this.baseUrl).pathname;
    } catch {
      basePath = '/';
    }
    let hrefPath = href;
    try {
      hrefPath = new URL(href, this.baseUrl).pathname;
    } catch {
      /* href is already a path */
    }
    const decoded = decodeURIComponent(hrefPath);
    const decodedBase = decodeURIComponent(basePath);
    if (!decoded.startsWith(decodedBase)) return null;
    return normalizeRel(decoded.slice(decodedBase.length));
  }

  private async dav(
    method: string,
    rel: string,
    init?: { headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (this.authHeader) headers.Authorization = this.authHeader;
    return fetch(this.urlFor(rel), { method, headers, body: init?.body });
  }
}

/** True if a SOURCE_VAULTS path entry is a WebDAV spec. */
export function isWebDavSpec(specPath: string): boolean {
  return /^webdav\+https?:\/\//i.test(specPath.trim());
}

/**
 * Parse `webdav+https://[user:pass@]host/path` into a clean base URL (the
 * `webdav+` scheme prefix stripped, credentials lifted out of the URL) and an
 * optional HTTP Basic `Authorization` header.
 */
export function parseWebDavSpec(spec: string): { baseUrl: string; authHeader: string | undefined } {
  const trimmed = spec.trim().replace(/^webdav\+/i, '');
  const u = new URL(trimmed);
  let authHeader: string | undefined;
  if (u.username) {
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    authHeader = `Basic ${Buffer.from(creds).toString('base64')}`;
    u.username = '';
    u.password = '';
  }
  return { baseUrl: u.toString(), authHeader };
}

/** Collapse leading/duplicate slashes; POSIX separators; vault-relative form. */
function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export interface DavResponse {
  href: string;
  etag?: string;
  contentLength?: number;
  lastModifiedMs?: number;
}

/**
 * Minimal, dependency-free multistatus parser. Splits on `<response>` elements
 * (any namespace prefix) and extracts the href + common props via regex.
 *
 * Hardened for the common real-world shapes: `D:`/`d:`/no-prefix (and any
 * arbitrary alphanumeric) namespace prefixes, CDATA-wrapped text, and
 * percent-/entity-escaped hrefs (`%20`, `&amp;`, `&#38;`). It is NOT a full XML
 * parser — see the class doc TODO(network) for what remains unvalidated.
 *
 * Exported for unit tests that feed recorded PROPFIND payloads.
 */
export function parseMultiStatus(xml: string): DavResponse[] {
  const out: DavResponse[] = [];
  // Any (or no) namespace prefix: `<d:response>`, `<D:response>`, `<response>`.
  const responseRe = /<(?:[a-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?response>/gi;
  let m: RegExpExecArray | null;
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[1];
    const href = tag(block, 'href');
    if (!href) continue;
    const etag = tag(block, 'getetag');
    const len = tag(block, 'getcontentlength');
    const mod = tag(block, 'getlastmodified');
    const modMs = mod ? Date.parse(mod) : NaN;
    out.push({
      // hrefToRel() later runs decodeURIComponent for percent-escapes; here we
      // only resolve XML entities so an `&amp;` in a filename round-trips.
      href: decodeXmlEntities(href.trim()),
      etag: etag?.trim().replace(/^(?:W\/)?"|"$/g, '') || undefined,
      contentLength: len ? Number(len.trim()) : undefined,
      lastModifiedMs: Number.isNaN(modMs) ? undefined : modMs,
    });
  }
  return out;
}

/**
 * Extract the inner text of `<*:name>...</*:name>` (first match), or undefined.
 * Tolerates any namespace prefix and unwraps a CDATA section if present.
 */
function tag(block: string, name: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-z0-9]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)<\\/(?:[a-z0-9]+:)?${name}>)`,
    'i',
  );
  const m = re.exec(block);
  if (!m) return undefined;
  const raw = m[1];
  if (raw === undefined) return undefined; // self-closing `<d:getetag/>`
  return unwrapCdata(raw);
}

/** Strip a single wrapping `<![CDATA[ ... ]]>` (common around hrefs/etags). */
function unwrapCdata(s: string): string {
  const t = s.trim();
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  return m ? m[1] : s;
}

/** Resolve the XML entities a WebDAV server may emit inside an href/etag. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // Ampersand last so a literal `&amp;amp;` does not over-decode.
    .replace(/&amp;/g, '&');
}
