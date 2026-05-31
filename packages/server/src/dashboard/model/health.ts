/**
 * Pure vault-health scoring helpers. Extracted verbatim from the legacy
 * `dashboard.ts`. No I/O, no Express — easy to unit test.
 */
import type { DreamReport } from '../../lib/dream-engine.js';
import type { HealthScore } from '../payload.types.js';

/** Compute a composite vault health score (0-100) from dream health metrics. */
export function computeHealthScore(health: DreamReport['health']): HealthScore {
  const factors = [
    { name: 'Tag Coverage', value: health.tagCoverage, weight: 0.25, contribution: 0 },
    { name: 'Link Density', value: Math.min(health.linkDensity / 3, 1), weight: 0.25, contribution: 0 },
    { name: 'Low Orphan Ratio', value: 1 - Math.min(health.orphanRatio, 1), weight: 0.25, contribution: 0 },
    { name: 'Heat Activity', value: Math.min(health.avgHeatScore / 8, 1), weight: 0.15, contribution: 0 },
    { name: 'Temp Balance', value: computeTempBalance(health.temperatureDistribution), weight: 0.10, contribution: 0 },
  ];

  let score = 0;
  for (const f of factors) {
    f.contribution = f.value * f.weight * 100;
    score += f.contribution;
  }
  score = Math.round(Math.min(100, Math.max(0, score)));

  let grade: string;
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'A-';
  else if (score >= 70) grade = 'B+';
  else if (score >= 60) grade = 'B';
  else if (score >= 50) grade = 'C+';
  else if (score >= 40) grade = 'C';
  else if (score >= 30) grade = 'D';
  else grade = 'F';

  return { score, grade, factors };
}

export function computeTempBalance(dist: { hot: number; warm: number; cold: number }): number {
  const total = dist.hot + dist.warm + dist.cold;
  if (total === 0) return 0;
  // Ideal: hot ~15%, warm ~35%, cold ~50%. Score how close we are.
  const hotRatio = dist.hot / total;
  // Penalize extremes (all hot or all cold)
  const hotPenalty = Math.max(0, hotRatio - 0.4) * 2;
  const coldPenalty = Math.max(0, (dist.cold / total) - 0.8) * 2;
  return Math.max(0, 1 - hotPenalty - coldPenalty);
}
