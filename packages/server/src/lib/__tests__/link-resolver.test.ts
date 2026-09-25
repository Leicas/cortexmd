import { describe, it, expect } from 'vitest';
import { buildLinkLookup, resolveWikilink } from '../link-resolver.js';

describe('wiki-link resolution', () => {
  const lookup = buildLinkLookup([
    'Projects/Phoenix.md',
    'Archive/Phoenix.md',
    'People/Alice.md',
  ]);

  it('resolves exact paths and unique bare names', () => {
    expect(resolveWikilink('Projects/Phoenix', lookup)).toBe('Projects/Phoenix.md');
    expect(resolveWikilink('Alice#Work', lookup)).toBe('People/Alice.md');
  });

  it('never guesses an ambiguous basename or missing explicit path', () => {
    expect(resolveWikilink('Phoenix', lookup)).toBeUndefined();
    expect(resolveWikilink('People/Phoenix', lookup)).toBeUndefined();
  });

  it('resolves a relative link against its source', () => {
    expect(resolveWikilink('../People/Alice', lookup, 'Projects/Phoenix.md')).toBe('People/Alice.md');
  });
});
