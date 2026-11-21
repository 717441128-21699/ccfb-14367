import { describe, expect, it } from 'vitest';
import {
  createFoundingPopulation,
  mate,
  PedigreeStore,
  predictColor,
  predictPairing,
  Rng,
} from '../src/index.ts';

function buildStore(n: number, seed = 55): PedigreeStore {
  const store = new PedigreeStore();
  const rng = new Rng(seed);
  for (const p of createFoundingPopulation({ size: n, rng })) store.add(p);
  return store;
}

describe('羽色预测精确枚举', () => {
  it('任意配对的羽色概率总和为 1,且与蒙特卡洛实测频率吻合', () => {
    const store = buildStore(20);
    const birds = [...store.all()];
    const sire = birds.find((b) => b.sex === 'M')!;
    const dam = birds.find((b) => b.sex === 'F')!;

    const prediction = predictColor(sire, dam);
    const total = prediction.outcomes.reduce((a, o) => a + o.probability, 0);
    expect(total).toBeCloseTo(1, 9);

    // 蒙特卡洛 4 万只实测
    const rng = new Rng(123);
    const observed = new Map<string, number>();
    const N = 40000;
    for (let i = 0; i < N; i++) {
      const child = mate({ sire, dam, rng });
      observed.set(child.phenotype.colorCode, (observed.get(child.phenotype.colorCode) ?? 0) + 1);
    }
    for (const outcome of prediction.outcomes) {
      const emp = (observed.get(outcome.code) ?? 0) / N;
      expect(emp).toBeCloseTo(outcome.probability, 1);
    }
  });

  it('隐性纯合 × 隐性纯合:后代 100% 该隐性表现', () => {
    const store = buildStore(8);
    const birds = [...store.all()];
    const sire = birds.find((b) => b.sex === 'M')!;
    const dam = birds.find((b) => b.sex === 'F')!;
    // 人工固定为 dd × dd
    sire.genome.color.dilute = ['d', 'd'];
    dam.genome.color.dilute = ['d', 'd'];
    const prediction = predictColor(sire, dam);
    expect(prediction.outcomes.every((o) => o.name.includes('银') || o.name.includes('淡') || o.name.includes('奶油'))).toBe(true);
    expect(prediction.outcomes.reduce((a, o) => a + o.probability, 0)).toBeCloseTo(1, 9);
  });
});

describe('配对报告', () => {
  it('全同胞配对的预测 F = 0.25,且各性状给出完整分布', () => {
    const store = buildStore(4, 31);
    const sire0 = [...store.all()].find((b) => b.sex === 'M')!;
    const dam0 = [...store.all()].find((b) => b.sex === 'F')!;
    const rng = new Rng(31);
    // 生成一儿一女
    let son = mate({ sire: sire0, dam: dam0, rng, id: 100 });
    while (son.sex !== 'M') son = mate({ sire: sire0, dam: dam0, rng, id: 100 });
    son.ringId = 'SON';
    store.add(son);
    let daughter = mate({ sire: sire0, dam: dam0, rng, id: 101 });
    while (daughter.sex !== 'F') daughter = mate({ sire: sire0, dam: dam0, rng, id: 101 });
    daughter.ringId = 'DAUGHTER';
    store.add(daughter);

    const report = predictPairing(store, son.id, daughter.id);
    expect(report.offspringInbreeding).toBeCloseTo(0.25, 10);
    for (const trait of ['speed', 'stamina', 'homing'] as const) {
      const dist = report.traits[trait];
      expect(dist.histogram.reduce((a, h) => a + h.probability, 0)).toBeCloseTo(1, 5);
      expect(dist.percentiles.p5).toBeLessThan(dist.percentiles.p50);
      expect(dist.percentiles.p50).toBeLessThan(dist.percentiles.p95);
      expect(dist.inbreedingPenalty).toBeGreaterThan(0);
      expect(dist.ceilingProbability).toBeGreaterThanOrEqual(0);
      expect(dist.floorProbability).toBeGreaterThanOrEqual(0);
    }
    // 颜色概率和为 1
    expect(report.color.outcomes.reduce((a, o) => a + o.probability, 0)).toBeCloseTo(1, 9);
  });

  it('预测分布均值与蒙特卡洛实测均值在容差内一致', () => {
    const store = buildStore(12, 77);
    const sire = [...store.all()].find((b) => b.sex === 'M')!;
    const dam = [...store.all()].find((b) => b.sex === 'F')!;
    const report = predictPairing(store, sire.id, dam.id);
    const rng = new Rng(777);
    const N = 20000;
    const sums = { speed: 0, stamina: 0, homing: 0 };
    for (let i = 0; i < N; i++) {
      const child = mate({ sire, dam, rng, inbreeding: report.offspringInbreeding });
      sums.speed += child.phenotype.speed;
      sums.stamina += child.phenotype.stamina;
      sums.homing += child.phenotype.homing;
    }
    for (const trait of ['speed', 'stamina', 'homing'] as const) {
      const empirical = sums[trait] / N;
      // 截断与离散化带来少量偏差,容差 0.6 分
      expect(Math.abs(empirical - report.traits[trait].mean)).toBeLessThan(0.6);
    }
  });

  it('有害位点发病概率:双杂合携带者配对为 0.25', () => {
    const store = buildStore(4, 13);
    const sire = [...store.all()].find((b) => b.sex === 'M')!;
    const dam = [...store.all()].find((b) => b.sex === 'F')!;
    sire.genome.harmful[0] = 1;
    dam.genome.harmful[0] = 1;
    const report = predictPairing(store, sire.id, dam.id);
    expect(report.disorderLoci[0]!.probability).toBeCloseTo(0.25, 10);
  });
});
