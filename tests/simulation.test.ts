import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMULATION,
  PedigreeStore,
  runSimulation,
  type SimulationConfig,
} from '../src/index.ts';

function smallConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    ...DEFAULT_SIMULATION,
    populationSize: 200,
    generations: 15,
    selectionFraction: 0.5,
    retainGenerations: undefined,
    ...overrides,
  };
}

describe('批量繁育模拟', () => {
  it('每代种群规模恒定,世代编号连续', () => {
    const store = new PedigreeStore();
    const result = runSimulation(store, smallConfig({ seed: 1 }));
    expect(result.perGeneration).toHaveLength(16); // 奠基代 + 15 代
    for (const stats of result.perGeneration) {
      expect(stats.population).toBe(200);
    }
    expect(result.perGeneration[0]!.generation).toBe(0);
    expect(result.perGeneration[15]!.generation).toBe(15);
    expect(result.finalGenerationIds).toHaveLength(200);
    // 总出生数 = 奠基 200 + 15 代 × 200
    expect(result.totalBorn).toBe(3200);
  });

  it('同一 seed 两次运行结果完全可复现', () => {
    const cfg = smallConfig({ seed: 424242 });
    const r1 = runSimulation(new PedigreeStore(), cfg);
    const r2 = runSimulation(new PedigreeStore(), cfg);
    expect(r1.perGeneration.map((s) => s.mean.speed)).toEqual(
      r2.perGeneration.map((s) => s.mean.speed),
    );
    expect(r1.finalGenerationIds).toEqual(r2.finalGenerationIds);
  });

  it('定向选择使目标性状代际上升(育种增益),且存在天花板反馈', () => {
    const store = new PedigreeStore();
    const result = runSimulation(
      store,
      smallConfig({
        seed: 7,
        generations: 15,
        selectionWeights: { speed: 1, stamina: 0, homing: 0 },
        selectionFraction: 0.25,
      }),
    );
    const first = result.perGeneration[0]!.mean.speed;
    const last = result.perGeneration[15]!.mean.speed;
    // 强选择压下速度均值应明显抬升
    expect(last).toBeGreaterThan(first + 3);
    // 后期触顶比例应高于初期(天花板信号)
    const earlyCeiling = result.perGeneration[2]!.ceilingRate.speed;
    const lateCeiling = result.perGeneration[15]!.ceilingRate.speed;
    expect(lateCeiling).toBeGreaterThanOrEqual(earlyCeiling);
  });

  it('封闭小群随机交配导致近交系数逐代累积', () => {
    const store = new PedigreeStore();
    const result = runSimulation(
      store,
      smallConfig({ seed: 11, matingScheme: 'random', selectionFraction: 1 }),
    );
    const f0 = result.perGeneration[0]!.meanInbreeding;
    const fEnd = result.perGeneration[15]!.meanInbreeding;
    expect(f0).toBe(0);
    // N=200 封闭群 15 代,理论每代 ΔF≈1/(2N_e)≈0.0025,累积约 0.02~0.04
    expect(fEnd).toBeGreaterThan(0.015);
    // 有限群体抽样波动下允许短期回落,但后半程均值应高于前半程(整体累积趋势)
    const firstHalf = result.perGeneration.slice(1, 8);
    const secondHalf = result.perGeneration.slice(8);
    const avg = (arr: typeof firstHalf) => arr.reduce((a, s) => a + s.meanInbreeding, 0) / arr.length;
    expect(avg(secondHalf)).toBeGreaterThan(avg(firstHalf));
  });

  it('避近亲交配策略的末代近交水平低于随机交配', () => {
    const baseCfg = smallConfig({ seed: 23, selectionFraction: 1, generations: 12 });
    const randomRun = runSimulation(new PedigreeStore(), { ...baseCfg, matingScheme: 'random' });
    const avoidRun = runSimulation(
      new PedigreeStore(),
      { ...baseCfg, matingScheme: 'avoidKin' },
    );
    expect(
      avoidRun.perGeneration[12]!.meanInbreeding,
    ).toBeLessThan(randomRun.perGeneration[12]!.meanInbreeding);
  });

  it('所有表型值始终落在硬上下限内', () => {
    const store = new PedigreeStore();
    runSimulation(store, smallConfig({ seed: 5 }));
    for (const p of store.all()) {
      for (const trait of ['speed', 'stamina', 'homing'] as const) {
        expect(p.phenotype[trait]).toBeGreaterThanOrEqual(1);
        expect(p.phenotype[trait]).toBeLessThanOrEqual(99);
      }
    }
  });

  it('进度回调按世代触发', () => {
    const ticks: number[] = [];
    runSimulation(new PedigreeStore(), smallConfig({ seed: 3 }), {
      onGeneration: (_s, index, total) => ticks.push(index / total),
    });
    expect(ticks).toHaveLength(16);
    expect(ticks[0]).toBe(0);
    expect(ticks[15]).toBe(1);
  });
});
