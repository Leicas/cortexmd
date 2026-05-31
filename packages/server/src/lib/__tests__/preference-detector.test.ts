import { describe, it, expect } from 'vitest';
import { extractPreferences } from '../preference-detector.js';

describe('preference-detector', () => {
  describe('preference detection', () => {
    it('should detect "I prefer" statements', () => {
      const text = 'I prefer TypeScript over JavaScript for large projects.';
      const prefs = extractPreferences(text);
      const preferences = prefs.filter((p) => p.type === 'preference');
      expect(preferences.length).toBeGreaterThanOrEqual(1);
      expect(preferences[0].statement).toContain('TypeScript');
    });

    it('should detect "I always" statements', () => {
      const text = 'I always use dark mode when coding at night.';
      const prefs = extractPreferences(text);
      const preferences = prefs.filter((p) => p.type === 'preference');
      expect(preferences.length).toBeGreaterThanOrEqual(1);
      expect(preferences[0].statement).toContain('dark mode');
    });

    it('should detect "I like to" statements', () => {
      const text = 'I like to write tests before implementing features in any project.';
      const prefs = extractPreferences(text);
      const preferences = prefs.filter((p) => p.type === 'preference');
      expect(preferences.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "I never" statements', () => {
      const text = 'I never commit directly to main without a pull request review.';
      const prefs = extractPreferences(text);
      const preferences = prefs.filter((p) => p.type === 'preference');
      expect(preferences.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "I tend to" statements', () => {
      const text = 'I tend to use functional components rather than class components in React.';
      const prefs = extractPreferences(text);
      const preferences = prefs.filter((p) => p.type === 'preference');
      expect(preferences.length).toBeGreaterThanOrEqual(1);
    });

    it('should extract entity from "X over Y" pattern', () => {
      const text = 'I prefer TypeScript over JavaScript for large projects.';
      const prefs = extractPreferences(text);
      const pref = prefs.find((p) => p.type === 'preference');
      expect(pref).toBeDefined();
      expect(pref!.entity).toBe('TypeScript');
    });
  });

  describe('convention detection', () => {
    it('should detect "the convention is" statements', () => {
      const text = 'The convention is to use camelCase for variable names in our codebase.';
      const prefs = extractPreferences(text);
      const conventions = prefs.filter((p) => p.type === 'convention');
      expect(conventions.length).toBeGreaterThanOrEqual(1);
      expect(conventions[0].statement).toContain('camelCase');
    });

    it('should detect "we always" statements', () => {
      const text = 'We always run linting before committing code to the repository.';
      const prefs = extractPreferences(text);
      const conventions = prefs.filter((p) => p.type === 'convention');
      expect(conventions.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "our team uses" statements', () => {
      const text = 'Our team uses ESLint with strict configuration for all projects.';
      const prefs = extractPreferences(text);
      const conventions = prefs.filter((p) => p.type === 'convention');
      expect(conventions.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "the standard is" statements', () => {
      const text = 'The standard is that all API endpoints must return JSON responses.';
      const prefs = extractPreferences(text);
      const conventions = prefs.filter((p) => p.type === 'convention');
      expect(conventions.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "we never" statements', () => {
      const text = 'We never deploy on Fridays to avoid weekend incidents and breakages.';
      const prefs = extractPreferences(text);
      const conventions = prefs.filter((p) => p.type === 'convention');
      expect(conventions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('pain point detection', () => {
    it('should detect "is frustrating" statements', () => {
      const text = 'The build process is really frustrating when it takes more than 10 minutes.';
      const prefs = extractPreferences(text);
      const painPoints = prefs.filter((p) => p.type === 'pain_point');
      expect(painPoints.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "doesn\'t work well" statements', () => {
      const text = "The current CI pipeline doesn't work well under heavy load conditions.";
      const prefs = extractPreferences(text);
      const painPoints = prefs.filter((p) => p.type === 'pain_point');
      expect(painPoints.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "struggling with" statements', () => {
      const text = 'I have been struggling with the deployment scripts failing intermittently.';
      const prefs = extractPreferences(text);
      const painPoints = prefs.filter((p) => p.type === 'pain_point');
      expect(painPoints.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect "the problem with" statements', () => {
      const text = 'The problem with our test suite is that it takes too long to run.';
      const prefs = extractPreferences(text);
      const painPoints = prefs.filter((p) => p.type === 'pain_point');
      expect(painPoints.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('false positive prevention', () => {
    it('should not detect preferences in normal prose', () => {
      const text = 'The database stores records efficiently. Each record has a unique ID.';
      const prefs = extractPreferences(text);
      expect(prefs).toHaveLength(0);
    });

    it('should not match very short extractions (< 10 chars)', () => {
      const text = 'I prefer X.';
      const prefs = extractPreferences(text);
      expect(prefs).toHaveLength(0);
    });

    it('should deduplicate identical statements', () => {
      const text = 'I prefer TypeScript over JavaScript for large projects. I prefer TypeScript over JavaScript for large projects.';
      const prefs = extractPreferences(text);
      const tsPrefs = prefs.filter((p) => p.statement.includes('TypeScript'));
      expect(tsPrefs).toHaveLength(1);
    });
  });
});
