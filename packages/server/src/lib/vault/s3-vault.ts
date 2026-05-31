import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { computeEtag } from '../hash.js';
import { logger } from '../logger.js';
import type { IVault, VaultEntry, VaultStat } from './ivault.js';

/**
 * S3Vault — optional S3 (and S3-compatible) source transport.
 *
 * Source vaults configured as `s3://bucket/prefix` are read over the S3 REST
 * API using the global `fetch` (Node 22) and AWS Signature V4 signing computed
 * with node's `crypto` — NO `aws-sdk` dependency. `list()` issues `ListObjectsV2`
 * (paginated) and yields markdown keys relative to the configured prefix;
 * `read()`/`stat()` issue `GET`/`HEAD` on the object. `refresh()` re-issues the
 * listing and caches per-key ETags so a subsequent list/read reflects the
 * latest bucket snapshot.
 *
 * Like every source transport this is READ-ONLY — no PutObject/DeleteObject —
 * so there is no merge logic, only "fetch latest snapshot, re-index the diff".
 *
 * Credentials and region are read from the standard AWS environment variables
 * (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`,
 * `AWS_REGION`/`AWS_DEFAULT_REGION`). A custom endpoint (MinIO, R2, etc.) and
 * region may be overridden per-vault via the query string of the spec, e.g.
 * `s3://bucket/prefix?region=us-east-1&endpoint=https://minio.local&forcePathStyle=1`.
 *
 * The SigV4 signer is covered by a unit test that reproduces AWS's documented
 * "GET Object" SigV4 test vector (the canonical example from the SigV4
 * test-suite / signing docs) and asserts the computed Authorization header
 * equals the published known-good value — so the signing math is verified
 * without a live endpoint. The ListObjectsV2 XML parser is likewise covered by
 * recorded-payload tests (Contents/Key/ETag/Size + IsTruncated pagination).
 *
 * TODO(network): SigV4 here is the minimal single-shot (non-chunked) signer for
 * GET/HEAD/list with empty-body hashing; it has NOT been exercised against live
 * S3/MinIO in CI. What remains manual: the actual virtual-host vs path-style
 * round-trip against a real bucket, presigned URLs, chunked/streaming uploads
 * (out of scope — read-only), and STS session-token (`x-amz-security-token`)
 * requests against a live endpoint. Validate these before production, or swap
 * in `@aws-sdk/client-s3` behind a lazy dynamic import.
 */
export class S3Vault implements IVault {
  readonly name: string;
  readonly url: string;
  readonly bucket: string;
  /** Key prefix (no leading slash, no trailing slash), '' for the whole bucket. */
  readonly prefix: string;
  readonly region: string;
  /** Base endpoint origin (no bucket), e.g. `https://s3.us-east-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly forcePathStyle: boolean;

  private listing = new Map<string, VaultStat>();
  private etags = new Map<string, string>();
  private listed = false;

  constructor(name: string, spec: string) {
    this.name = name;
    this.url = spec;
    const parsed = parseS3Spec(spec);
    this.bucket = parsed.bucket;
    this.prefix = parsed.prefix;
    this.region = parsed.region;
    this.endpoint = parsed.endpoint;
    this.forcePathStyle = parsed.forcePathStyle;
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
    const res = await this.s3('GET', this.keyFor(rel));
    if (!res.ok) {
      throw new Error(`S3Vault GET ${rel} failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Match LocalVault/readNote: ETag hashes the UTF-8 string content (NOT the
    // S3 object ETag, which is an MD5/multipart digest) for transport parity.
    const etag = computeEtag(buf.toString('utf-8'));
    return { content: buf, etag };
  }

  async stat(relPath: string): Promise<VaultStat | null> {
    const rel = normalizeRel(relPath);
    const cached = this.listing.get(rel);
    if (cached) return cached;
    const res = await this.s3('HEAD', this.keyFor(rel));
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3Vault HEAD ${rel} failed: ${res.status} ${res.statusText}`);
    }
    const size = Number(res.headers.get('content-length') ?? 0);
    const lastMod = res.headers.get('last-modified');
    const mtimeMs = lastMod ? Date.parse(lastMod) : Date.now();
    return { relPath: rel, size, mtimeMs: Number.isNaN(mtimeMs) ? Date.now() : mtimeMs };
  }

  /**
   * Re-list the bucket and cache per-key ETags. On failure the previous
   * snapshot is kept (logged, not thrown), mirroring GitPullVault.refresh().
   */
  async refresh(): Promise<void> {
    try {
      await this.listObjects();
      logger.info('S3Vault refreshed', { name: this.name, entries: this.listing.size });
    } catch (err) {
      logger.warn('S3Vault refresh (ListObjectsV2) failed — keeping previous snapshot', {
        name: this.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ensureListed(): Promise<void> {
    if (this.listed) return;
    await this.listObjects();
  }

  /** Paginated ListObjectsV2 → populate `listing` + `etags` for markdown keys. */
  private async listObjects(): Promise<void> {
    const listing = new Map<string, VaultStat>();
    const etags = new Map<string, string>();
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2' };
      if (this.prefix) query.prefix = this.prefix.endsWith('/') ? this.prefix : `${this.prefix}/`;
      if (token) query['continuation-token'] = token;
      const res = await this.s3('GET', '', query);
      if (!res.ok) {
        throw new Error(`S3Vault list failed: ${res.status} ${res.statusText}`);
      }
      const xml = await res.text();
      for (const obj of parseListXml(xml)) {
        if (!obj.key.toLowerCase().endsWith('.md')) continue;
        const rel = this.keyToRel(obj.key);
        if (rel === null) continue;
        listing.set(rel, { relPath: rel, size: obj.size ?? 0, mtimeMs: obj.lastModifiedMs ?? Date.now() });
        if (obj.etag) etags.set(rel, obj.etag);
      }
      token = nextContinuationToken(xml);
    } while (token);
    this.listing = listing;
    this.etags = etags;
    this.listed = true;
  }

  /** Full object key for a vault-relative path (prepends the configured prefix). */
  private keyFor(rel: string): string {
    if (!this.prefix) return rel;
    const p = this.prefix.endsWith('/') ? this.prefix : `${this.prefix}/`;
    return `${p}${rel}`;
  }

  /** Strip the configured prefix from an object key → vault-relative path. */
  private keyToRel(key: string): string | null {
    if (!this.prefix) return normalizeRel(key);
    const p = this.prefix.endsWith('/') ? this.prefix : `${this.prefix}/`;
    if (!key.startsWith(p)) return null;
    return normalizeRel(key.slice(p.length));
  }

  /**
   * Issue a signed S3 request. `key` is empty for bucket-level operations
   * (list); `query` carries query-string params (also signed).
   */
  private async s3(method: string, key: string, query?: Record<string, string>): Promise<Response> {
    const creds = readAwsCreds();
    const { url, host } = this.requestTarget(key, query);
    const headers = signRequestV4({
      method,
      url,
      host,
      region: this.region,
      service: 's3',
      creds,
    });
    return fetch(url, { method, headers });
  }

  /** Compose the request URL (virtual-host or path-style) and the Host header. */
  private requestTarget(key: string, query?: Record<string, string>): { url: string; host: string } {
    const ep = new URL(this.endpoint);
    let host: string;
    let pathname: string;
    if (this.forcePathStyle) {
      host = ep.host;
      pathname = `/${this.bucket}/${encodeKey(key)}`;
    } else {
      host = `${this.bucket}.${ep.host}`;
      pathname = `/${encodeKey(key)}`;
    }
    const u = new URL(`${ep.protocol}//${host}${pathname}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    }
    return { url: u.toString(), host };
  }
}

/** True if a SOURCE_VAULTS path entry is an S3 spec. */
export function isS3Spec(specPath: string): boolean {
  return /^s3:\/\//i.test(specPath.trim());
}

interface S3Spec {
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
}

/**
 * Parse `s3://bucket/prefix?region=&endpoint=&forcePathStyle=` into its parts.
 * Region/endpoint fall back to AWS env vars and the standard regional endpoint.
 */
export function parseS3Spec(spec: string): S3Spec {
  const trimmed = spec.trim();
  const u = new URL(trimmed);
  const bucket = u.hostname;
  const prefix = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const region =
    u.searchParams.get('region') ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    'us-east-1';
  const endpointOverride = u.searchParams.get('endpoint');
  const endpoint = endpointOverride || `https://s3.${region}.amazonaws.com`;
  const forcePathStyle =
    isTrue(u.searchParams.get('forcePathStyle')) ||
    // Custom endpoints (MinIO/R2) usually need path-style addressing.
    (endpointOverride !== null && !isTrue(u.searchParams.get('virtualHost')));
  return { bucket, prefix, region, endpoint, forcePathStyle };
}

function isTrue(v: string | null): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function readAwsCreds(): AwsCreds {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3Vault requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment',
    );
  }
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
}

/** Percent-encode an S3 key path-segment-wise (slashes preserved). */
function encodeKey(key: string): string {
  return key.split('/').map((seg) => encodeRfc3986(seg)).join('/');
}

/** RFC 3986 encoding as required by SigV4 canonicalization. */
function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Compute AWS Signature V4 headers for a GET/HEAD/list request with an empty
 * body (`UNSIGNED-PAYLOAD` is avoided in favor of the empty-string SHA so the
 * header is deterministic). Returns the headers to attach to `fetch`.
 *
 * TODO(network): single-shot signer only — no chunked uploads, no presigning.
 */
export function signRequestV4(opts: {
  method: string;
  url: string;
  host: string;
  region: string;
  service: string;
  creds: AwsCreds;
  /**
   * Injectable signing time (tests pass AWS's documented vector timestamp).
   * Defaults to `new Date()`.
   */
  now?: Date;
  /**
   * Override the payload hash. Defaults to the SHA-256 of the empty body, which
   * is what GET/HEAD/list use. AWS's GET-object test vector uses the same value.
   */
  payloadHashOverride?: string;
  /**
   * Extra headers to fold into the signature (lowercased + signed). Lets tests
   * reproduce AWS vectors that sign a `range` header, etc.
   */
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const { method, url, host, region, service, creds } = opts;
  const u = new URL(url);
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = opts.payloadHashOverride ?? sha256Hex('');

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  // Canonical query string: sorted, RFC-3986 encoded key=value pairs.
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders =
    signedHeaderNames.map((h) => `${h}:${headers[h].trim()}`).join('\n') + '\n';
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    u.pathname, // already RFC-3986 encoded by encodeKey()
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(Buffer.from(`AWS4${creds.secretAccessKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  headers.Authorization =
    `${algorithm} Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export interface S3Object {
  key: string;
  size?: number;
  etag?: string;
  lastModifiedMs?: number;
}

/**
 * Minimal, dependency-free ListObjectsV2 XML parser: splits on `<Contents>`
 * and extracts Key/Size/ETag/LastModified. Tolerant of an optional namespace
 * prefix on each element (some S3-compatible servers emit one) and of CDATA /
 * entity-escaped keys. Exported for recorded-payload unit tests.
 */
export function parseListXml(xml: string): S3Object[] {
  const out: S3Object[] = [];
  const re = /<(?:[a-z0-9]+:)?Contents\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?Contents>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const key = inner(block, 'Key');
    if (!key) continue;
    const size = inner(block, 'Size');
    const etag = inner(block, 'ETag');
    const mod = inner(block, 'LastModified');
    const modMs = mod ? Date.parse(mod.trim()) : NaN;
    out.push({
      key: decodeXml(key.trim()),
      size: size ? Number(size.trim()) : undefined,
      // S3 wraps the ETag in literal quotes, often XML-escaped (&quot;).
      etag: decodeXml(etag?.trim() ?? '').replace(/^"|"$/g, '') || undefined,
      lastModifiedMs: Number.isNaN(modMs) ? undefined : modMs,
    });
  }
  return out;
}

/**
 * Return the continuation token for the next page, or undefined when the
 * listing is complete. Honors `<IsTruncated>true</IsTruncated>` (with optional
 * namespace prefix) and the `<NextContinuationToken>` value. Exported for tests.
 */
export function nextContinuationToken(xml: string): string | undefined {
  const truncated = inner(xml, 'IsTruncated');
  if (truncated?.trim().toLowerCase() !== 'true') return undefined;
  const token = inner(xml, 'NextContinuationToken');
  return token ? decodeXml(token.trim()) : undefined;
}

/**
 * Inner text of `<*:name>...</*:name>` (optional namespace prefix), CDATA
 * unwrapped. First match within `block`.
 */
function inner(block: string, name: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-z0-9]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)<\\/(?:[a-z0-9]+:)?${name}>)`,
    'i',
  );
  const m = re.exec(block);
  if (!m || m[1] === undefined) return undefined;
  return unwrapCdata(m[1]);
}

/** Strip a single wrapping `<![CDATA[ ... ]]>` if present. */
function unwrapCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1] : s;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // Ampersand last so `&amp;quot;` does not double-decode.
    .replace(/&amp;/g, '&');
}
