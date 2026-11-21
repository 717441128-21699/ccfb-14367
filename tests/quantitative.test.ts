import { describe, expect, it } from 'vitest';
import {
  alleleEffect,
  environmentalSd,
  phenotypeValue,
  POLYGENIC_LOCI,
  TRAIT_CONFIG,
  TRAIT_KEYS,
} from '../src/index.ts';

describe('数量性状参数自洽', () => {
  it('h²、σ_A、σ_E 满足 h² = σ_A²/(σ_A²+σ_E²)', () => {
    for (const trait of TRAIT_KEYS) {
      const cfg = TRAIT_CONFIG[trait];
      const se = environmentalSd(trait);
      const h2 = cfg.geneticSd ** 2 / (cfg.geneticSd ** 2 + se ** 2);
      expect(h2).toBeCloseTo(cfg.heritability, 10);
    }
  });

  it('p=0.5 基础群加性方差等于 σ_A²', () => {
    // 20 个伯努利(0.5)之和的方差 = 20·0.25 = 5;乘 a² 后应等于 σ_A²
    for (const trait of TRAIT_KEYS) {
      const a = alleleEffect(trait);
      const varCounts = POLYGENIC_LOCI * 2 * 0.25;
      expect(a * a * varCounts).toBeCloseTo(TRAIT_CONFIG[trait].geneticSd ** 2, 8);
    }
  });

  it('表型被截断在硬上下限内', () => {
    expect(phenotypeValue('speed', 20, 0, 1000)).toBe(TRAIT_CONFIG.speed.max);
    expect(phenotypeValue('speed', 0, 1, -1000)).toBe(TRAIT_CONFIG.speed.min);
  });

  it('近交衰退线性作用:F 每增加 0.1,表型下降 0.1·b', () => {
    const f0 = phenotypeValue('speed', 10, 0, 0);
    const f1 = phenotypeValue('speed', 10, 0.5, 0);
    expect(f0 - f1).toBeCloseTo(0.5 * TRAIT_CONFIG.speed.depressionPerF, 8);
  });
});
