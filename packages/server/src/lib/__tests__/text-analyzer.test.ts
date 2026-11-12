import { describe, it, expect } from 'vitest';
import {
  foldText, lightStem, analyzeTerm, analyzeText, fuzzyForTerm, prefixForTerm, STOPWORDS,
} from '../text-analyzer.js';

describe('foldText', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldText('Hébergé À Évry — Çà et là')).toBe('heberge a evry — ca et la');
    expect(foldText('cœur')).toBe('coeur');
  });

  it('leaves plain ASCII untouched apart from case', () => {
    expect(foldText('Deploy v1.7.1 to NAS')).toBe('deploy v1.7.1 to nas');
  });
});

describe('lightStem', () => {
  it('conflates English and French plurals', () => {
    expect(lightStem('servers')).toBe('server');
    expect(lightStem('serveurs')).toBe('serveur');
    expect(lightStem('policies')).toBe('policy');
    expect(lightStem('boxes')).toBe('box');
    expect(lightStem('reseaux')).toBe('reseau');
  });

  it('keeps identifiers, short tokens and -ss/-us/-is words', () => {
    expect(lightStem('v17s')).toBe('v17s');
    expect(lightStem('bus')).toBe('bus');
    expect(lightStem('access')).toBe('access');
    expect(lightStem('status')).toBe('status');
    expect(lightStem('analysis')).toBe('analysis');
  });
});

describe('analyzeTerm / analyzeText', () => {
  it('drops English and French stopwords and elision leftovers', () => {
    expect(analyzeTerm('the')).toBeNull();
    expect(analyzeTerm('est')).toBeNull();
    expect(analyzeTerm('l')).toBeNull();
    expect(STOPWORDS.has('les')).toBe(true);
  });

  it('keeps single digits and normalises a term to its index form', () => {
    expect(analyzeTerm('7')).toBe('7');
    expect(analyzeTerm('Réunions')).toBe('reunion');
  });

  it('matches an accented French query against unaccented text and vice versa', () => {
    const query = analyzeText("où est hébergé l'ordinateur des réunions ?");
    const noteAccented = analyzeText('Ordinateur de réunion hébergé au bureau');
    const noteAscii = analyzeText('ordinateur de reunion heberge au bureau');
    for (const t of ['heberge', 'ordinateur', 'reunion']) {
      expect(query).toContain(t);
      expect(noteAccented).toContain(t);
      expect(noteAscii).toContain(t);
    }
    expect(query).not.toContain('est');
    expect(query).not.toContain('des');
  });
});

describe('length-gated fuzzy / prefix', () => {
  it('no fuzzy on short terms or identifiers, bounded edits on longer words', () => {
    expect(fuzzyForTerm('api')).toBe(false);
    expect(fuzzyForTerm('nas2')).toBe(false);
    expect(fuzzyForTerm('port8080')).toBe(false);
    expect(fuzzyForTerm('deploy')).toBe(1);
    expect(fuzzyForTerm('kubernetes')).toBe(0.2);
  });

  it('prefix expansion only from 3 characters', () => {
    expect(prefixForTerm('db')).toBe(false);
    expect(prefixForTerm('dep')).toBe(true);
  });
});
