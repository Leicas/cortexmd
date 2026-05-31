import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  S3Vault,
  parseS3Spec,
  parseListXml,
  nextContinuationToken,
  signRequestV4,
  isS3Spec,
} from '../vault/s3-vault.js';

/**
 * Recorded ListObjectsV2 page 1 (truncated) modelled on real AWS output:
 *  - standard <Contents>/<Key>/<ETag>/<Size>/<LastModified> shape
 *  - a quoted, XML-escaped ETag (&quot;...&quot;)
 *  - a key with an XML entity (&amp;) and a percent-style folder
 *  - a CDATA-wrapped key
 *  - a non-markdown key that must be filtered out
 *  - IsTruncated=true + NextContinuationToken -> page 2 must be fetched
 */
const LIST_PAGE1 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name>
  <Prefix>vault/</Prefix>
  <KeyCount>4</KeyCount>
  <MaxKeys>3</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYToken==</NextContinuationToken>
  <Contents>
    <Key>vault/Notes/hello.md</Key>
    <LastModified>2025-05-13T12:30:00.000Z</LastModified>
    <ETag>&quot;9bb58f26192e4ba00f01e2e7b136bbd8&quot;</ETag>
    <Size>42</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>vault/Notes/A&amp;B.md</Key>
    <LastModified>2025-05-13T12:31:00.000Z</LastModified>
    <ETag>"abc"</ETag>
    <Size>10</Size>
  </Contents>
  <Contents>
    <Key><![CDATA[vault/cdata note.md]]></Key>
    <LastModified>2025-05-13T12:32:00.000Z</LastModified>
    <Size>3</Size>
  </Contents>
  <Contents>
    <Key>vault/image.png</Key>
    <Size>1000</Size>
  </Contents>
</ListBucketResult>`;

const LIST_PAGE2 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>my-bucket</Name>
  <Prefix>vault/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>vault/page2.md</Key>
    <LastModified>2025-05-13T12:33:00.000Z</LastModified>
    <ETag>"def"</ETag>
    <Size>5</Size>
  </Contents>
</ListBucketResult>`;

const SPEC = 's3://my-bucket/vault?region=us-east-1';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
});

describe('parseS3Spec', () => {
  it('parses bucket/prefix/region and default endpoint', () => {
    const s = parseS3Spec(SPEC);
    expect(s.bucket).toBe('my-bucket');
    expect(s.prefix).toBe('vault');
    expect(s.region).toBe('us-east-1');
    expect(s.endpoint).toBe('https://s3.us-east-1.amazonaws.com');
    expect(s.forcePathStyle).toBe(false);
  });

  it('uses path-style for a custom endpoint (MinIO/R2)', () => {
    const s = parseS3Spec('s3://b/p?endpoint=https://minio.local:9000&region=us-east-1');
    expect(s.endpoint).toBe('https://minio.local:9000');
    expect(s.forcePathStyle).toBe(true);
  });

  it('isS3Spec recognizes the scheme', () => {
    expect(isS3Spec('s3://b/p')).toBe(true);
    expect(isS3Spec('webdav+https://h/x')).toBe(false);
  });
});

describe('parseListXml (recorded ListObjectsV2 payload)', () => {
  it('extracts keys, decodes entities/CDATA, and unquotes escaped ETags', () => {
    const objs = parseListXml(LIST_PAGE1);
    const byKey = new Map(objs.map((o) => [o.key, o]));

    expect(byKey.get('vault/Notes/hello.md')?.etag).toBe('9bb58f26192e4ba00f01e2e7b136bbd8');
    expect(byKey.get('vault/Notes/hello.md')?.size).toBe(42);
    expect(byKey.get('vault/Notes/hello.md')?.lastModifiedMs).toBe(
      Date.parse('2025-05-13T12:30:00.000Z'),
    );

    // &amp; decoded to & ; quoted ETag unquoted.
    expect(byKey.has('vault/Notes/A&B.md')).toBe(true);
    expect(byKey.get('vault/Notes/A&B.md')?.etag).toBe('abc');

    // CDATA-wrapped key round-trips.
    expect(byKey.has('vault/cdata note.md')).toBe(true);
  });
});

describe('nextContinuationToken (pagination)', () => {
  it('returns the token when IsTruncated is true', () => {
    expect(nextContinuationToken(LIST_PAGE1)).toBe('1ueGcxLPRx1Tr/XYToken==');
  });
  it('returns undefined when the listing is complete', () => {
    expect(nextContinuationToken(LIST_PAGE2)).toBeUndefined();
  });
});

describe('S3Vault.list (mocked fetch, truncated + continuation pagination)', () => {
  it('walks both pages and yields prefix-stripped markdown rel paths', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const pages = [LIST_PAGE1, LIST_PAGE2];
    let call = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      // The second page request must carry the continuation token (URL-encoded).
      if (call === 1) {
        expect(url).toContain('continuation-token=');
      }
      const body = pages[call++];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => body,
      } as unknown as Response;
    });

    const v = new S3Vault('s3', SPEC);
    const rels = new Set<string>();
    for await (const e of v.list()) rels.add(e.relPath);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(rels).toEqual(
      new Set(['Notes/hello.md', 'Notes/A&B.md', 'cdata note.md', 'page2.md']),
    );
    expect([...rels].some((r) => r.endsWith('.png'))).toBe(false);
  });
});

/**
 * AWS's documented SigV4 "GET Object" test vector
 * (AWS General Reference, "Examples of how to derive a signing key" /
 * "Example: GET Object"). This is the canonical known-good vector.
 *
 *   Region:  us-east-1
 *   Service: s3
 *   Date:    20130524T000000Z
 *   Access:  AKIAIOSFODNN7EXAMPLE
 *   Secret:  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
 *   Request: GET https://examplebucket.s3.amazonaws.com/test.txt
 *            with header `Range: bytes=0-9`
 *   Signed headers: host;range;x-amz-content-sha256;x-amz-date
 *   Expected signature:
 *     f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41
 */
describe('signRequestV4 (AWS documented GET Object vector)', () => {
  const EXPECTED_SIGNATURE =
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41';
  const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('reproduces the published Authorization header byte-for-byte', () => {
    const headers = signRequestV4({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      host: 'examplebucket.s3.amazonaws.com',
      region: 'us-east-1',
      service: 's3',
      creds: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2013-05-24T00:00:00.000Z'),
      payloadHashOverride: EMPTY_SHA,
      extraHeaders: { range: 'bytes=0-9' },
    });

    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_SHA);
    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 ' +
        'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        `Signature=${EXPECTED_SIGNATURE}`,
    );
  });
});
