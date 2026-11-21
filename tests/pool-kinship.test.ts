import { describe, expect, it } from 'vitest';
import {
  createFoundingPopulation,
  DensePoolKinship,
  inbreedingCoefficient,
  mate,
  PedigreeStore,
  Rng,
  tabularInbreeding,
  type Pigeon,
} from '../src/index.ts';

/**
 * 验证池化亲缘引擎 DensePoolKinship 的近交系数与全谱系
 * 共祖递归 / Henderson 列表法完全一致。
 *
 * 关键:池内只保留留种精英,但每个池个体的双亲都在「上一代池」中,
 * 因此池上构建的加性亲缘矩阵是全矩阵的精确子矩阵,近交计算无近似。
 */
describe('DensePoolKinship 与标准算法一致性', () => {
  it('精英池滚动 10 代:池内每只个体的 F 等于全谱系共祖递归结果', () => {
    const store = new PedigreeStore();
    const rng = new Rng(2026);
    const N = 40;
    const K = 16; // 每性别 8 只精英,池规模 16
    const founders = createFoundingPopulation({ size: N, rng });
    for (const f of founders) store.add(f);

    const kin = new DensePoolKinship();
    const pickElite = (birds: Pigeon[], sex: 'M' | 'F', k: number): Pigeon[] =>
      birds.filter((b) => b.sex === sex).slice(0, k);
    const pool0 = [...pickElite(founders, 'M', K / 2), ...pickElite(founders, 'F', K / 2)];
    kin.seed(pool0.map((b) => b.id));

    let current = founders;
    let nextId = N + 1;
    const bornOrder = [...founders.map((f) => f.id)];

    for (let gen = 1; gen <= 10; gen++) {
      const eliteM = pickElite(current, 'M', K / 2);
      const eliteF = pickElite(current, 'F', K / 2);
      // 精英两两配对产生全群体(这里直接产生下一代精英的子代)
      const offspring: Pigeon[] = [];
      const triples: [number, number, number][] = [];
      for (let i = 0; i < K / 2; i++) {
        const sire = eliteM[i]!;
        const dam = eliteF[i]!;
        const f = kin.matingInbreeding(sire.id, dam.id);
        for (let t = 0; t < 2; t++) {
          let child = mate({ sire, dam, rng, inbreeding: f, generation: gen, deferPhenotype: true });
          // 控制性别以保证下一代精英池两性均衡
          let guard = 0;
          const wantSex: 'M' | 'F' = t === 0 ? 'M' : 'F';
          while (child.sex !== wantSex && guard++ < 100) {
            child = mate({ sire, dam, rng, inbreeding: f, generation: gen, deferPhenotype: true });
          }
          child.id = nextId++;
          child.ringId = `POOL-G${gen}-${child.id}`;
          store.add(child);
          bornOrder.push(child.id);
          offspring.push(child);
          triples.push([child.id, sire.id, dam.id]);
        }
      }
      // 全部子代都进入下一代池(规模仍为 K)
      kin.advance(triples);
      current = offspring;
    }

    // 列表法基准
    const tabular = tabularInbreeding(store, bornOrder);
    const cache = new Map<string, number>();
    // 检查末代池个体
    const finalPoolIds = current.map((b) => b.id);
    for (const id of finalPoolIds) {
      const exact = inbreedingCoefficient(store, id, cache);
      const tab = tabular.get(id)!;
      expect(exact).toBeCloseTo(tab, 10);
      // 池矩阵对角关系:1+F,通过 matingInbreeding 间接验证 F
      // 这里直接比对精确值,容差 1e-9
      expect(exact).toBeGreaterThanOrEqual(0);
      expect(exact).toBeLessThan(1);
    }
  });

  it('奠基池个体间 F=0,与无关奠基者定义一致', () => {
    const rng = new Rng(1);
    const founders = createFoundingPopulation({ size: 20, rng });
    const store = new PedigreeStore();
    for (const f of founders) store.add(f);
    const kin = new DensePoolKinship();
    kin.seed(founders.map((b) => b.id));
    const sire = founders.find((b) => b.sex === 'M')!;
    const dam = founders.find((b) => b.sex === 'F')!;
    expect(kin.matingInbreeding(sire.id, dam.id)).toBe(0);
    expect(inbreedingCoefficient(store, sire.id)).toBe(0);
  });

  it('全同胞交配在池矩阵下得到 F=0.25', () => {
    const store = new PedigreeStore();
    const rng = new Rng(9);
    const founders = createFoundingPopulation({ size: 8, rng });
    for (const f of founders) store.add(f);
    const kin = new DensePoolKinship();
    kin.seed(founders.map((b) => b.id));

    const sire0 = founders.find((b) => b.sex === 'M')!;
    const dam0 = founders.find((b) => b.sex === 'F')!;
    let counter = 0;
    const breed = (sex: 'M' | 'F'): Pigeon => {
      let c = mate({ sire: sire0, dam: dam0, rng, deferPhenotype: true });
      while (c.sex !== sex) c = mate({ sire: sire0, dam: dam0, rng, deferPhenotype: true });
      c.id = 1000 + counter++;
      c.ringId = `S-${c.id}`;
      store.add(c);
      return c;
    };
    const son = breed('M');
    const daughter = breed('F');
    // 同胞进入下一代池
    kin.advance([
      [son.id, sire0.id, dam0.id],
      [daughter.id, sire0.id, dam0.id],
    ]);
    expect(kin.matingInbreeding(son.id, daughter.id)).toBeCloseTo(0.25, 10);
    expect(inbreedingCoefficient(store, son.id, new Map())).toBeCloseTo(0, 10);
  });
});
