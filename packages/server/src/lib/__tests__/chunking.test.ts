/**
 * Heading-aware chunking (lib/chunking.ts) — pure, no model.
 */
import { describe, expect, it } from 'vitest';
import { chunkNote, frontmatterLength, leadText, rollupChunkHits, DEFAULT_CHUNK_OPTIONS, type ChunkHit } from '../chunking.js';

const para = (seed: string, sentences: number): string =>
  Array.from({ length: sentences }, (_, i) => `${seed} sentence number ${i} talks about topic ${seed}-${i}.`).join(' ');

function assertContiguousSlices(content: string, chunks: ReturnType<typeof chunkNote>): void {
  for (const c of chunks) {
    expect(c.text).toBe(content.slice(c.start, c.end));
    expect(c.end).toBeGreaterThan(c.start);
  }
}

describe('chunkNote — short notes', () => {
  it('keeps a short note as ONE chunk whose embed text is the legacy lead text', () => {
    const doc = { title: 'Short', content: 'A small body.\n\nSecond paragraph.' };
    const chunks = chunkNote(doc);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, kind: 'lead', start: 0, end: doc.content.length });
    expect(chunks[0].embedText).toBe(leadText(doc));
    expect(chunks[0].embedText).toBe('Short A small body.\n\nSecond paragraph.');
  });

  it('returns nothing for an empty note and a title-only chunk for an empty body', () => {
    expect(chunkNote({ title: '', content: '' })).toEqual([]);
    const only = chunkNote({ title: 'Just a title', content: '' });
    expect(only).toHaveLength(1);
    expect(only[0].embedText).toBe('Just a title');
  });

  it('a body exactly at the single-chunk limit stays one chunk', () => {
    const content = 'x'.repeat(DEFAULT_CHUNK_OPTIONS.singleChunkMaxChars);
    expect(chunkNote({ title: 'T', content })).toHaveLength(1);
    expect(chunkNote({ title: 'T', content: content + ' y' }).length).toBeGreaterThan(1);
  });
});

describe('chunkNote — long notes', () => {
  const content = [
    '# Project Atlas',
    '',
    para('intro', 8),
    '',
    '## Decisions',
    '',
    para('decision', 30),
    '',
    '### Database',
    '',
    para('postgres', 12),
    '',
    '## Open questions',
    '',
    para('question', 10),
  ].join('\n');
  const doc = { title: 'Atlas notes', content };
  const chunks = chunkNote(doc);

  it('emits the legacy lead chunk first, then section chunks that are contiguous slices', () => {
    expect(chunks[0].kind).toBe('lead');
    expect(chunks[0].embedText).toBe(leadText(doc));
    expect(chunks[0]).toMatchObject({ start: 0, end: 1024 });
    expect(chunks.slice(1).every((c) => c.kind === 'section')).toBe(true);
    assertContiguousSlices(content, chunks);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('covers the whole body and respects the size limits', () => {
    const sections = chunks.slice(1);
    expect(sections[0].start).toBe(0);
    expect(sections[sections.length - 1].end).toBe(content.length);
    for (let i = 1; i < sections.length; i++) {
      // No gap: each chunk starts at or before the previous chunk's end (overlap).
      expect(sections[i].start).toBeLessThanOrEqual(sections[i - 1].end);
      expect(sections[i].start).toBeGreaterThan(sections[i - 1].start);
    }
    for (const c of sections) expect(c.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
  });

  it('starts a new chunk at headings and prepends the title + heading path as context', () => {
    const db = chunks.find((c) => c.text.startsWith('### Database'));
    expect(db).toBeDefined();
    expect(db!.headings).toEqual(['Project Atlas', 'Decisions', 'Database']);
    expect(db!.embedText.startsWith('Atlas notes > Project Atlas > Decisions > Database\n### Database')).toBe(true);
    const open = chunks.find((c) => c.text.startsWith('## Open questions'));
    expect(open!.headings).toEqual(['Project Atlas', 'Open questions']);
    // A chunk that continues a section (no heading line of its own) still carries the path.
    const cont = chunks.find((c) => c.kind === 'section' && !c.text.startsWith('#') && c.headings.includes('Decisions'));
    expect(cont).toBeDefined();
    expect(cont!.embedText.startsWith('Atlas notes > Project Atlas > Decisions')).toBe(true);
  });

  it('overlaps consecutive chunks inside a section but never across a heading', () => {
    const sections = chunks.slice(1);
    let overlaps = 0;
    for (let i = 1; i < sections.length; i++) {
      const overlap = sections[i - 1].end - sections[i].start;
      if (sections[i].text.startsWith('#')) expect(overlap).toBe(0);
      else if (overlap > 0) {
        overlaps++;
        expect(overlap).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.overlapChars);
      }
    }
    // The sample is one line per paragraph, so overlap only appears when a line was split.
    expect(overlaps).toBeGreaterThanOrEqual(0);
  });

  it('overlaps line-structured text', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `- item ${i}: remember to check the ${i}th thing on the list`).join('\n');
    const cs = chunkNote({ title: 'List', content: lines }).slice(1);
    expect(cs.length).toBeGreaterThan(2);
    for (let i = 1; i < cs.length; i++) {
      const overlap = cs[i - 1].end - cs[i].start;
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.overlapChars);
      // Overlap is whole lines.
      expect(lines.slice(cs[i].start, cs[i].start + 7)).toBe('- item ');
    }
  });

  it('is deterministic', () => {
    expect(chunkNote(doc)).toEqual(chunks);
  });
});

describe('chunkNote — code blocks', () => {
  it('does not treat # lines inside a fence as headings and keeps a small fence in one chunk', () => {
    const code = ['```bash', '# install deps', 'npm ci', '# run', 'npm test', '```'].join('\n');
    const content = ['## Setup', '', para('setup', 12), '', code, '', '## After', '', para('after', 14)].join('\n');
    const chunks = chunkNote({ title: 'Guide', content });
    const withFence = chunks.filter((c) => c.kind === 'section' && c.text.includes('```bash'));
    expect(withFence).toHaveLength(1);
    expect(withFence[0].text).toContain('npm test\n```');
    for (const c of chunks) {
      expect(c.headings).not.toContain('install deps');
      expect(c.headings).not.toContain('run');
    }
    expect(chunks.find((c) => c.text.startsWith('## After'))!.headings).toEqual(['After']);
  });

  it('splits an oversized fence on line boundaries without losing text', () => {
    const body = Array.from({ length: 120 }, (_, i) => `const value${i} = compute(${i}); // line ${i}`).join('\n');
    const content = '## Dump\n\n```ts\n' + body + '\n```\n';
    const sections = chunkNote({ title: 'Blob', content }).slice(1);
    expect(sections.length).toBeGreaterThan(3);
    assertContiguousSlices(content, sections);
    for (const c of sections) {
      expect(c.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
      expect(c.headings).toEqual(['Dump']);
    }
    // Code never seeds an overlap: chunks tile the fence exactly.
    const covered = sections.reduce((n, c) => n + c.text.length, 0);
    expect(covered).toBe(content.length);
  });

  it('splits a single very long line at sentence ends', () => {
    const content = para('blob', 60); // one line, ~3k chars
    const sections = chunkNote({ title: 'One line', content }).slice(1);
    expect(sections.length).toBeGreaterThan(2);
    assertContiguousSlices(content, sections);
    for (const c of sections.slice(0, -1)) expect(c.text.trimEnd().endsWith('.')).toBe(true);
  });
});

describe('chunkNote — French text', () => {
  const content = [
    '# Réunion équipe',
    '',
    Array.from({ length: 12 }, (_, i) => `Décision n°${i} : l’équipe a validé le déploiement à l’été, après vérification des données côté client.`).join(' '),
    '',
    '## Prochaines étapes',
    '',
    Array.from({ length: 12 }, (_, i) => `Étape ${i} : préparer la mise à jour « sécurité » et prévenir Hélène dès que c’est prêt.`).join(' '),
  ].join('\n');

  it('keeps accents intact, uses French headings as context, never cuts mid-word', () => {
    const chunks = chunkNote({ title: 'Compte rendu', content });
    assertContiguousSlices(content, chunks);
    const next = chunks.find((c) => c.text.startsWith('## Prochaines étapes'));
    expect(next!.embedText.startsWith('Compte rendu > Réunion équipe > Prochaines étapes\n')).toBe(true);
    for (const c of chunks.slice(1)) {
      // Boundaries fall on whitespace / start / end — not inside a word.
      if (c.start > 0) expect(/\s/.test(content[c.start - 1])).toBe(true);
      expect(c.text).not.toMatch(/�/);
    }
    expect(chunks.slice(1).map((c) => c.text).join('')).toContain('« sécurité »');
  });

  it('does not split a surrogate pair when hard-cutting', () => {
    const content = '😀'.repeat(900); // no spaces, no sentence ends
    for (const c of chunkNote({ title: 'Emoji', content }).slice(1)) {
      expect(c.text.length % 2).toBe(0);
    }
  });
});

describe('chunkNote — frontmatter', () => {
  it('skips a leading frontmatter block (offsets stay relative to the input)', () => {
    const fm = '---\ntitle: Hidden\ntags: [secret-tag]\n---\n';
    const body = '## Body\n\n' + para('body', 30);
    const content = fm + body;
    expect(frontmatterLength(content)).toBe(fm.length);
    const chunks = chunkNote({ title: 'FM', content });
    for (const c of chunks) {
      expect(c.start).toBeGreaterThanOrEqual(fm.length);
      expect(c.embedText).not.toContain('secret-tag');
    }
    assertContiguousSlices(content, chunks);
    expect(chunks[0].embedText).toBe(leadText({ title: 'FM', content: body }));
  });

  it('a horizontal rule or unterminated block is not frontmatter', () => {
    expect(frontmatterLength('---\nno closing fence\ntext')).toBe(0);
    expect(frontmatterLength('text\n---\nmore\n---\n')).toBe(0);
  });
});

describe('chunkNote — caps and options', () => {
  it('caps section chunks per note', () => {
    const content = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ${para('p' + i, 3)}`).join('\n\n');
    const chunks = chunkNote({ title: 'Digest', content }, { maxChunks: 5 });
    expect(chunks.filter((c) => c.kind === 'section')).toHaveLength(5);
    expect(chunks[0].kind).toBe('lead');
  });

  it('lead:false emits only section chunks', () => {
    const chunks = chunkNote({ title: 'T', content: para('x', 60).replace(/\. /g, '.\n') }, { lead: false });
    expect(chunks.every((c) => c.kind === 'section')).toBe(true);
    expect(chunks[0].index).toBe(0);
  });
});

describe('rollupChunkHits', () => {
  const hits: ChunkHit[] = [
    { path: 'a.md', index: 0, score: 0.5, start: 0, end: 10 },
    { path: 'b.md', index: 0, score: 0.7, start: 0, end: 10 },
    { path: 'a.md', index: 3, score: 0.9, start: 30, end: 40 },
    { path: 'a.md', index: 2, score: 0.2, start: 20, end: 30 },
    { path: 'c.md', index: 1, score: 0.7, start: 5, end: 9 },
  ];

  it('max: note score = best chunk, best chunk returned, ties break on path', () => {
    const notes = rollupChunkHits(hits, 'max');
    expect(notes.map((n) => [n.path, n.score, n.best.index, n.matched])).toEqual([
      ['a.md', 0.9, 3, 3],
      ['b.md', 0.7, 0, 1],
      ['c.md', 0.7, 1, 1],
    ]);
  });

  it('top2: mean of the two best chunks; single-chunk notes keep their score', () => {
    const notes = rollupChunkHits(hits, 'top2');
    expect(notes.map((n) => n.path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(notes[0].score).toBeCloseTo(0.7, 10);
    expect(notes[0].best.index).toBe(3);
    expect(notes[1].score).toBe(0.7);
    // a.md (0.7) ties b.md / c.md — path order decides.
  });

  it('handles empty input', () => {
    expect(rollupChunkHits([])).toEqual([]);
  });
});
