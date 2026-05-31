import { describe, it, expect } from 'vitest';
import { detectEntities } from '../entity-detector.js';

describe('entity-detector', () => {
  describe('person detection', () => {
    it('should detect names near relationship verbs + possessive (2 signals)', () => {
      const text = "I met with John Smith yesterday. John Smith's proposal was excellent.";
      const entities = detectEntities(text);
      const people = entities.filter((e) => e.type === 'person');
      expect(people.length).toBeGreaterThanOrEqual(1);
      expect(people.some((p) => p.name === 'John Smith')).toBe(true);
    });

    it('should detect names with title + possessive (2 signals)', () => {
      const text = "Dr. Sarah Johnson presented findings. Sarah Johnson's research was groundbreaking.";
      const entities = detectEntities(text);
      const people = entities.filter((e) => e.type === 'person');
      expect(people.length).toBeGreaterThanOrEqual(1);
      expect(people.some((p) => p.name === 'Sarah Johnson')).toBe(true);
    });

    it('should detect names with verb + attribution (2 signals)', () => {
      const text = 'I spoke with Alice Cooper about the deadline. I got feedback from Alice Cooper.';
      const entities = detectEntities(text);
      const people = entities.filter((e) => e.type === 'person');
      expect(people.some((p) => p.name === 'Alice Cooper')).toBe(true);
    });

    it('should include confidence between 0 and 1', () => {
      const text = "Dr. Jane Doe presented findings. Jane Doe's paper was published.";
      const entities = detectEntities(text);
      const person = entities.find((e) => e.type === 'person');
      expect(person).toBeDefined();
      expect(person!.confidence).toBeGreaterThan(0);
      expect(person!.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('project detection', () => {
    it('should detect project with keyword + version signals', () => {
      const text = 'Phoenix v2.0 is great. We use project Phoenix. It is very good.';
      const entities = detectEntities(text);
      const projects = entities.filter((e) => e.type === 'project');
      expect(projects.some((p) => p.name === 'Phoenix')).toBe(true);
    });

    it('should detect project with repo URL + building signals', () => {
      const text = 'Check github.com/acme/Dataflow for code. We are building Dataflow.';
      const entities = detectEntities(text);
      const projects = entities.filter((e) => e.type === 'project');
      expect(projects.some((p) => p.name === 'Dataflow')).toBe(true);
    });

    it('should detect project with keyword + building signals', () => {
      const text = 'We started project Nexus. The team is building Nexus.';
      const entities = detectEntities(text);
      const projects = entities.filter((e) => e.type === 'project');
      expect(projects.some((p) => p.name === 'Nexus')).toBe(true);
    });
  });

  describe('organization detection', () => {
    it('should detect org with legal suffix + team pattern (2 signals)', () => {
      const text = 'Acme Corp is expanding. The Acme team is growing fast.';
      const entities = detectEntities(text);
      const orgs = entities.filter((e) => e.type === 'organization');
      expect(orgs.some((o) => o.name.includes('Acme'))).toBe(true);
    });

    it('should detect org with keyword + team pattern (2 signals)', () => {
      const text = 'The company Globex. The Globex team is talented.';
      const entities = detectEntities(text);
      const orgs = entities.filter((e) => e.type === 'organization');
      expect(orgs.some((o) => o.name.includes('Globex'))).toBe(true);
    });

    it('should detect org with legal suffix + keyword (2 signals)', () => {
      const text = 'She works at Acme. Acme Corp was founded in 2010.';
      const entities = detectEntities(text);
      const orgs = entities.filter((e) => e.type === 'organization');
      expect(orgs.some((o) => o.name.includes('Acme'))).toBe(true);
    });
  });

  describe('false positive prevention', () => {
    it('should not trigger on common stop words', () => {
      const text = 'The weather is nice today. However, it might rain tomorrow.';
      const entities = detectEntities(text);
      const names = entities.map((e) => e.name.toLowerCase());
      expect(names).not.toContain('the');
      expect(names).not.toContain('however');
    });

    it('should require 2+ distinct signal types for detection', () => {
      const text = 'I saw Bob at the store.';
      const entities = detectEntities(text);
      expect(entities).toHaveLength(0);
    });

    it('should not detect day/month names as entities', () => {
      const text = 'The meeting is on Monday. We plan to ship in January.';
      const entities = detectEntities(text);
      const names = entities.map((e) => e.name.toLowerCase());
      expect(names).not.toContain('monday');
      expect(names).not.toContain('january');
    });

    it('should return results sorted by confidence descending', () => {
      const text = [
        "Dr. Jane Doe presented findings. Jane Doe's paper was cited.",
        "I spoke with Bob Lee. Feedback from Bob Lee was positive. Bob Lee's talk was great.",
      ].join(' ');
      const entities = detectEntities(text);
      for (let i = 1; i < entities.length; i++) {
        expect(entities[i].confidence).toBeLessThanOrEqual(entities[i - 1].confidence);
      }
    });
  });
});
