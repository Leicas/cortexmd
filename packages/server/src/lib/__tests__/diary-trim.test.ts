import { describe, it, expect } from 'vitest';
import {
  trimWords,
  countWords,
  DIARY_WORD_LIMIT,
  DIARY_WORD_LIMIT_TOPIC,
} from '../../tools/diary-trim.js';

const words = (n: number, prefix = 'w'): string => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join(' ');

describe('countWords', () => {
  it('counts whitespace-delimited words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('one')).toBe(1);
    expect(countWords('one  two\tthree\nfour')).toBe(4);
    expect(countWords('[[Projects/cortexmd]] @ [[Machines/Ao]]')).toBe(3);
  });
});

describe('trimWords', () => {
  it('limits are 60 (recap) and 120 (topic / handoff)', () => {
    expect(DIARY_WORD_LIMIT).toBe(60);
    expect(DIARY_WORD_LIMIT_TOPIC).toBe(120);
  });

  it('leaves an entry within budget untouched', () => {
    const r = trimWords(words(60), 60);
    expect(r.truncated).toBe(false);
    expect(r.words).toBe(60);
    expect(r.text).toBe(words(60));
    expect(r.limit).toBe(60);
  });

  it('trims a 150-word entry to 60 words + ellipsis and reports the original count', () => {
    const r = trimWords(words(150), DIARY_WORD_LIMIT);
    expect(r.truncated).toBe(true);
    expect(r.words).toBe(150);
    expect(r.text.endsWith('…')).toBe(true);
    expect(countWords(r.text.slice(0, -1))).toBe(60);
    expect(r.text.startsWith('w1 w2 w3')).toBe(true);
    expect(r.text).not.toContain('w61');
  });

  it('uses the 120-word budget when a topic is set', () => {
    const r = trimWords(words(150), DIARY_WORD_LIMIT_TOPIC);
    expect(r.truncated).toBe(true);
    expect(countWords(r.text.slice(0, -1))).toBe(120);
  });

  it('never cuts inside a [[wiki-link]]', () => {
    // Link spans words 60-61: "[[Projects/a" "b]]"
    const src = `${words(59)} [[Projects/a b]] ${words(20, 'x')}`;
    const r = trimWords(src, 60);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[[Projects/a b]]');
    expect(r.text).not.toContain('x1');
    expect(r.text.endsWith(']]…')).toBe(true);
  });

  it('strips trailing punctuation before the ellipsis', () => {
    const src = `${words(59)} end, ${words(5, 'y')}`;
    const r = trimWords(src, 60);
    expect(r.text.endsWith('end…')).toBe(true);
  });

  it('tolerates empty / whitespace input', () => {
    expect(trimWords('', 60)).toEqual({ text: '', truncated: false, words: 0, limit: 60 });
    expect(trimWords('  \n ', 60).text).toBe('');
  });
});
