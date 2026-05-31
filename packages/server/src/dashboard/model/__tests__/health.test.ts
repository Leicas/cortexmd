import { describe, it, expect } from 'vitest';
import { computeHealthScore, computeTempBalance } from '../health.js';
import type { DreamReport } from '../../../lib/dream-engine.js';

const baseHealth = (over: Partial<DreamReport['health']> = {}): DreamReport['health'] => ({
  tagCoverage: 1,
  linkDensity: 3,
  orphanRatio: 0,
  avgHeatScore: 8,
  temperatureDistribution: { hot: 15, warm: 35, cold: 50 },
  ...over,
}) as DreamReport['health'];

describe('computeHealthScore', () => {
  it('returns 100 / grade A for ideal metrics', () => {
    const r = computeHealthScore(baseHealth());
    expect(r.score).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.factors).toHaveLength(5);
  });

  it('returns 0 / grade F for worst metrics', () => {
    const r = computeHealthScore(baseHealth({
      tagCoverage: 0,
      linkDensity: 0,
      orphanRatio: 1,
      avgHeatScore: 0,
      temperatureDistribution: { hot: 100, warm: 0, cold: 0 },
    }));
    expect(r.score).toBe(0);
    expect(r.grade).toBe('F');
  });

  it('clamps score to 0..100 and assigns a grade band', () => {
    const r = computeHealthScore(baseHealth({ tagCoverage: 0.5, orphanRatio: 0.5 }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(typeof r.grade).toBe('string');
  });
});

describe('computeTempBalance', () => {
  it('is 0 for an empty distribution', () => {
    expect(computeTempBalance({ hot: 0, warm: 0, cold: 0 })).toBe(0);
  });

  it('is 1 for a balanced distribution', () => {
    expect(computeTempBalance({ hot: 15, warm: 35, cold: 50 })).toBe(1);
  });

  it('penalizes all-hot and all-cold extremes', () => {
    expect(computeTempBalance({ hot: 100, warm: 0, cold: 0 })).toBeLessThan(1);
    expect(computeTempBalance({ hot: 0, warm: 0, cold: 100 })).toBeLessThan(1);
  });
});
