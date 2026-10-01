import { describe, it, expect, vi } from 'vitest';

// Index: an EmailLog capture (slugged path, "Email - …" title) and a CRM note
// the entity registry points "Haply" at.
const docMeta = new Map<string, { title: string }>([
  ['EmailLog/observation/2026/09/2026-09-30-email-quote-request.md', { title: 'Email - Quote request' }],
  ['CRM/Haply Robotics.md', { title: 'Haply Robotics' }],
  ['Notes/Dup A.md', { title: 'Same' }],
  ['Notes/Dup B.md', { title: 'Same' }],
]);

vi.mock('../search.js', () => ({ getDocMeta: () => docMeta }));
vi.mock('../entity-registry.js', () => ({
  findEntity: (q: string) =>
    q.toLowerCase() === 'haply' ? { name: 'Haply Robotics', notePath: 'CRM/Haply Robotics.md' } : undefined,
  registerEntity: () => undefined,
}));
vi.mock('../knowledge-graph.js', () => ({ kgAddTriple: () => undefined, isKgInitialized: () => false }));

const { repairWikilinks } = await import('../auto-link.js');
const { noteLink } = await import('../memory-stack.js');
const { addWikiLinks } = await import('../../tools/conversations-mine.js');

describe('repairWikilinks', () => {
  it('re-points a title link at the slugged EmailLog path', () => {
    expect(repairWikilinks('see [[Email - Quote request]]')).toBe(
      'see [[EmailLog/observation/2026/09/2026-09-30-email-quote-request|Email - Quote request]]',
    );
  });

  it('resolves registry entities and keeps aliases', () => {
    expect(repairWikilinks('[[Haply|the company]]')).toBe('[[CRM/Haply Robotics|the company]]');
  });

  it('leaves resolving, ambiguous and unknown links alone', () => {
    const md = '[[Haply Robotics]] [[Same]] [[Nobody]] `[[Email - Quote request]]`';
    expect(repairWikilinks(md)).toBe(md);
  });
});

describe('noteLink (wake-up layers)', () => {
  it('links by path with the title as display', () => {
    expect(noteLink('EmailLog/x/2026-email-a.md', 'Email - A')).toBe('[[EmailLog/x/2026-email-a|Email - A]]');
  });
});

describe('conversations_mine addWikiLinks', () => {
  const resolve = (e: string) => (e === 'Haply' ? 'CRM/Haply Robotics.md' : undefined);

  it('links only entities with a note and never inside an existing link', () => {
    expect(addWikiLinks('Antoine met Haply about [[Haply Robotics]]. Haply again.', ['Antoine', 'Haply'], resolve)).toBe(
      'Antoine met [[CRM/Haply Robotics|Haply]] about [[Haply Robotics]]. Haply again.',
    );
  });
});
