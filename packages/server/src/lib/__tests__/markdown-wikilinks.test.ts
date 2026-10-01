import { describe, expect, it } from 'vitest';
import { extractWikilinks, extractWikilinksWithLines } from '../markdown.js';

describe('extractWikilinks', () => {
  it('extracts plain, aliased and heading links', () => {
    expect(extractWikilinks('[[A]] [[B|b]] [[C#H]]')).toEqual(['A', 'B', 'C#H']);
  });

  it('strips the trailing backslash of table-escaped aliases', () => {
    expect(extractWikilinks('| [[Homelab/Proxmox Cluster\\|Proxmox]] |')).toEqual(['Homelab/Proxmox Cluster']);
  });

  it('ignores fenced code and inline code', () => {
    const md = ['[[Real]]', '```bash', 'if [[ -f x ]]; then [[Fake]]; fi', '```', 'run `[[Inline]]` now'].join('\n');
    expect(extractWikilinks(md)).toEqual(['Real']);
  });

  it('skips shell syntax outside code', () => {
    expect(extractWikilinks('[[ -f x ]] and [[cd /d && git push]]')).toEqual([]);
  });

  it('reports 1-based line numbers', () => {
    expect(extractWikilinksWithLines('x\n[[A]]')).toEqual([{ target: 'A', line: 2 }]);
  });

  it('handles ~~~ fences, longer closers and unterminated fences', () => {
    expect(extractWikilinks(['~~~', '[[A]]', '```', '[[B]]', '~~~', '[[C]]'].join('\n'))).toEqual(['C']);
    expect(extractWikilinks(['````', '```', '[[A]]', '````', '[[B]]'].join('\n'))).toEqual(['B']);
    expect(extractWikilinks(['[[A]]', '```', '[[B]]'].join('\n'))).toEqual(['A']);
  });

  it('ignores double-backtick inline code', () => {
    expect(extractWikilinks('``[[X]]`` [[Y]]')).toEqual(['Y']);
  });

  it('keeps real names containing $ or ;', () => {
    expect(extractWikilinks('[[Pricing $99]] [[A; B]]')).toEqual(['Pricing $99', 'A; B']);
  });

  it('skips bash tests, expansions and control flow', () => {
    expect(
      extractWikilinks('[[ $x == y ]] [[ ! -d d ]] [[$HOME/x]] [[x; then y]] [[ a != b ]]'),
    ).toEqual([]);
  });

  it('accepts balanced square brackets inside a target', () => {
    expect(extractWikilinks('see [[Tasks/[P1] Reply to Luqia — confirm receipt.md]] and [[[P0] Fix|fix]]')).toEqual([
      'Tasks/[P1] Reply to Luqia — confirm receipt.md',
      '[P0] Fix',
    ]);
  });

  it('table-escaped alias with bracketed target', () => {
    expect(extractWikilinks('| [[Tasks/[P2] X\\|X]] |')).toEqual(['Tasks/[P2] X']);
  });
});
