import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  WebDavVault,
  parseWebDavSpec,
  parseMultiStatus,
  isWebDavSpec,
} from '../vault/webdav-vault.js';

/**
 * Recorded PROPFIND `Depth: infinity` multistatus payload modelled on real
 * Apache/Nextcloud output. It deliberately mixes the hardening cases the
 * TODO(network) called out:
 *  - the collection (root) <d:response> with <d:resourcetype><d:collection/>
 *  - a plain markdown file with a quoted ETag
 *  - a percent-escaped href ("My%20Note.md") -> should decode to a space
 *  - an entity-escaped href ("A&amp;B.md") -> should decode to "A&B.md"
 *  - a CDATA-wrapped href and etag
 *  - a non-markdown file that must be filtered out
 *  - the uppercase `D:` namespace prefix throughout
 */
const PROPFIND_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/vault/</D:href>
    <D:propstat>
      <D:prop>
        <D:getlastmodified>Mon, 12 May 2025 10:00:00 GMT</D:getlastmodified>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/vault/Notes/hello.md</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"abc123"</D:getetag>
        <D:getcontentlength>42</D:getcontentlength>
        <D:getlastmodified>Tue, 13 May 2025 12:30:00 GMT</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/vault/Notes/My%20Note.md</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>W/"weak-tag"</D:getetag>
        <D:getcontentlength>7</D:getcontentlength>
        <D:resourcetype/>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/vault/A&amp;B.md</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag><![CDATA["cdata-etag"]]></D:getetag>
        <D:getcontentlength>9</D:getcontentlength>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href><![CDATA[/dav/vault/CData%20Folder/cdata.md]]></D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>3</D:getcontentlength>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/vault/image.png</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>1000</D:getcontentlength></D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

/** A no-prefix multistatus variant (some servers emit a default DAV namespace). */
const PROPFIND_NO_PREFIX = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/dav/vault/plain.md</href>
    <propstat><prop>
      <getetag>"plain"</getetag>
      <getcontentlength>5</getcontentlength>
    </prop></propstat>
  </response>
</multistatus>`;

const BASE = 'webdav+https://user:pass@host.example/dav/vault/';

function mockFetchOnce(text: string, init?: { status?: number; headers?: Record<string, string> }) {
  const res = {
    ok: (init?.status ?? 207) < 400,
    status: init?.status ?? 207,
    statusText: 'Multi-Status',
    text: async () => text,
    headers: new Headers(init?.headers ?? {}),
    arrayBuffer: async () => Buffer.from(text),
  };
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(res as unknown as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseWebDavSpec', () => {
  it('strips the webdav+ prefix and lifts credentials into a Basic header', () => {
    const { baseUrl, authHeader } = parseWebDavSpec(BASE);
    expect(baseUrl).toBe('https://host.example/dav/vault/');
    expect(authHeader).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('isWebDavSpec recognizes the scheme', () => {
    expect(isWebDavSpec('webdav+https://h/x')).toBe(true);
    expect(isWebDavSpec('s3://b/p')).toBe(false);
    expect(isWebDavSpec('/local/path')).toBe(false);
  });
});

describe('parseMultiStatus (recorded PROPFIND payload)', () => {
  it('decodes percent- and entity-escaped hrefs, CDATA, weak/quoted ETags', () => {
    const responses = parseMultiStatus(PROPFIND_XML);
    const byHref = new Map(responses.map((r) => [r.href, r]));

    // Percent-escapes are left for hrefToRel()'s decodeURIComponent, but XML
    // entities are resolved here: "A&amp;B.md" -> "A&B.md".
    expect(byHref.has('/dav/vault/A&B.md')).toBe(true);

    // Quoted ETag has surrounding quotes stripped.
    expect(byHref.get('/dav/vault/Notes/hello.md')?.etag).toBe('abc123');
    expect(byHref.get('/dav/vault/Notes/hello.md')?.contentLength).toBe(42);

    // Weak validator (W/"...") is unwrapped to the bare tag.
    expect(byHref.get('/dav/vault/Notes/My%20Note.md')?.etag).toBe('weak-tag');

    // CDATA-wrapped etag is unwrapped then unquoted.
    expect(byHref.get('/dav/vault/A&B.md')?.etag).toBe('cdata-etag');

    // CDATA-wrapped href round-trips.
    expect(byHref.has('/dav/vault/CData%20Folder/cdata.md')).toBe(true);
  });
});

describe('WebDavVault.list / stat (via mocked fetch on recorded payload)', () => {
  it('list() yields markdown rel paths (prefix-stripped, percent-decoded), filtering non-md', async () => {
    mockFetchOnce(PROPFIND_XML);
    const v = new WebDavVault('wd', BASE);
    const rels = new Set<string>();
    for await (const e of v.list()) rels.add(e.relPath);

    expect(rels).toEqual(
      new Set([
        'Notes/hello.md',
        'Notes/My Note.md',
        'A&B.md',
        'CData Folder/cdata.md',
      ]),
    );
    // image.png filtered; the collection root href has no .md so dropped.
    expect([...rels].some((r) => r.endsWith('.png'))).toBe(false);
  });

  it('stat() returns the cached size/mtime parsed from the listing', async () => {
    mockFetchOnce(PROPFIND_XML);
    const v = new WebDavVault('wd', BASE);
    // Prime the cache: stat() is cache-first and only HEAD-falls-back for paths
    // not seen by a prior PROPFIND (matches the IVault contract).
    for await (const _ of v.list()) { /* drain */ }
    const st = await v.stat('Notes/hello.md');
    expect(st).not.toBeNull();
    expect(st?.relPath).toBe('Notes/hello.md');
    expect(st?.size).toBe(42);
    expect(st?.mtimeMs).toBe(Date.parse('Tue, 13 May 2025 12:30:00 GMT'));
  });

  it('list() with a prefix filters to that subtree', async () => {
    mockFetchOnce(PROPFIND_XML);
    const v = new WebDavVault('wd', BASE);
    const rels: string[] = [];
    for await (const e of v.list('Notes')) rels.push(e.relPath);
    expect(rels.sort()).toEqual(['Notes/My Note.md', 'Notes/hello.md']);
  });

  it('parses the no-namespace-prefix multistatus variant', async () => {
    mockFetchOnce(PROPFIND_NO_PREFIX);
    const v = new WebDavVault('wd', BASE);
    const rels: string[] = [];
    for await (const e of v.list()) rels.push(e.relPath);
    expect(rels).toEqual(['plain.md']);
  });
});
