import { describe, expect, it } from 'vitest';
import {
  createFoundingPopulation,
  FlockKinship,
  inbreedingCoefficient,
  mate,
  PedigreeStore,
  Rng,
  tabularInbreeding,
  wrightInbreeding,
  type Pigeon,
} from '../src/index.ts';

/** 用两只奠基者快速产一只后代并入库,F 由调用方给定计算方式 */
function breedInto(
  store: PedigreeStore,
  sire: Pigeon,
  dam: Pigeon,
  rng: Rng,
  id: number,
  f: number,
): Pigeon {
  const child = mate({ sire, dam, rng, inbreeding: f, id, generation: Math.max(sire.generation, dam.generation) + 1 });
  child.ringId = `P-${id}`;
  store.add(child);
  return child;
}

/** 反复配种直到得到指定性别的后代(测试构造谱系用;失败尝试不入库,同一 id 重试) */
function breedSex(
  store: PedigreeStore,
  sire: Pigeon,
  dam: Pigeon,
  rng: Rng,
  id: number,
  f: number,
  sex: 'M' | 'F',
): Pigeon {
  for (let attempt = 0; attempt < 200; attempt++) {
    const child = mate({ sire, dam, rng, inbreeding: f, id, generation: Math.max(sire.generation, dam.generation) + 1 });
    if (child.sex === sex) {
      child.ringId = `P-${id}`;
      store.add(child);
      return child;
    }
  }
  throw new Error('breedSex 未能得到目标性别');
}

function founders(store: PedigreeStore, n = 8, seed = 42): Pigeon[] {
  const rng = new Rng(seed);
  const birds = createFoundingPopulation({ size: n, rng });
  for (const b of birds) store.add(b);
  return birds;
}

describe('无亲缘奠基群', () => {
  it('奠基者与无关配对的 F 均为 0', () => {
    const store = new PedigreeStore();
    const birds = founders(store, 4);
    const a = birds.find((b) => b.sex === 'M')!;
    const b = birds.find((b) => b.sex === 'F')!;
    const c = birds.find((x) => x.sex === 'M' && x.id !== a.id)!;
    const d = birds.find((x) => x.sex === 'F' && x.id !== b.id)!;
    expect(inbreedingCoefficient(store, a.id)).toBe(0);
    const rng = new Rng(1);
    const child = breedInto(store, a, b, rng, 100, 0);
    expect(inbreedingCoefficient(store, child.id)).toBeCloseTo(0, 12);
    const child2 = breedInto(store, c, d, rng, 101, 0);
    // 两个无亲缘家庭的后代交配 → F=0(按性别确定父子角色)
    const grandSire = child.sex === 'M' ? child : child2;
    const grandDam = child.sex === 'F' ? child : child2;
    const grand = breedInto(store, grandSire, grandDam, rng, 102, 0);
    expect(inbreedingCoefficient(store, grand.id)).toBeCloseTo(0, 10);
  });
});

describe('标准近交谱系', () => {
  it('全同胞交配(一代):F = 0.25', () => {
    const store = new PedigreeStore();
    founders(store, 2);
    const sire0 = [...store.all()].find((p) => p.sex === 'M')!;
    const dam0 = [...store.all()].find((p) => p.sex === 'F')!;
    const rng = new Rng(2);
    const son = breedSex(store, sire0, dam0, rng, 100, 0, 'M');
    const daughter = breedSex(store, sire0, dam0, rng, 200, 0, 'F');
    const inbred = breedInto(store, son, daughter, rng, 300, 0);
    expect(inbreedingCoefficient(store, inbred.id)).toBeCloseTo(0.25, 10);
    const w = wrightInbreeding(store, inbred.id);
    expect(w.inbreeding).toBeCloseTo(0.25, 10);
    // 两个共同祖先(祖父母)各贡献 (1/2)^3 = 0.125
    expect(w.contributions).toHaveLength(2);
    expect(w.contributions.reduce((a, c) => a + c.contribution, 0)).toBeCloseTo(0.25, 10);
  });

  it('亲子回交:F = 0.25', () => {
    const store = new PedigreeStore();
    founders(store, 4);
    const sire0 = [...store.all()].find((p) => p.sex === 'M')!;
    const dam0 = [...store.all()].find((p) => p.sex === 'F')!;
    const rng = new Rng(3);
    const daughter = breedSex(store, sire0, dam0, rng, 100, 0, 'F');
    // 女儿 × 父(父雄、女儿雌)
    const backcross = breedInto(store, sire0, daughter, rng, 200, 0);
    expect(inbreedingCoefficient(store, backcross.id)).toBeCloseTo(0.25, 10);
  });

  it('半同胞交配(共享一个父本):F = 0.125', () => {
    const store = new PedigreeStore();
    const base = founders(store, 6);
    const sharedSire = base.find((p) => p.sex === 'M')!;
    const dams = base.filter((p) => p.sex === 'F');
    const rng = new Rng(4);
    const halfSon = breedSex(store, sharedSire, dams[0]!, rng, 100, 0, 'M');
    const halfDaughter = breedSex(store, sharedSire, dams[1]!, rng, 200, 0, 'F');
    const child = breedInto(store, halfSon, halfDaughter, rng, 300, 0);
    expect(inbreedingCoefficient(store, child.id)).toBeCloseTo(0.125, 10);
  });

  it('连续两代全同胞交配:第二代 F = 3/8 = 0.375', () => {
    const store = new PedigreeStore();
    founders(store, 4);
    const sire0 = [...store.all()].find((p) => p.sex === 'M')!;
    const dam0 = [...store.all()].find((p) => p.sex === 'F')!;
    const rng = new Rng(5);
    const g1m = breedSex(store, sire0, dam0, rng, 100, 0, 'M');
    const g1f = breedSex(store, sire0, dam0, rng, 200, 0, 'F');
    const g2m = breedSex(store, g1m, g1f, rng, 300, 0.25, 'M');
    const g2f = breedSex(store, g1m, g1f, rng, 400, 0.25, 'F');
    const g3 = breedInto(store, g2m, g2f, rng, 500, 0);
    // 标准结果 F=0.375
    expect(inbreedingCoefficient(store, g3.id)).toBeCloseTo(0.375, 9);
  });
});

describe('三套算法一致性', () => {
  it('随机近亲繁育 12 代:共祖递归 = 列表法,Wright 为五代窗口下界', () => {
    const store = new PedigreeStore();
    const base = founders(store, 12, 99);
    const rng = new Rng(99);
    const males = base.filter((b) => b.sex === 'M');
    const females = base.filter((b) => b.sex === 'F');
    let currentM = males;
    let currentF = females;
    let nextId = 1000;
    const bornOrder: number[] = base.map((b) => b.id);

    for (let gen = 0; gen < 12; gen++) {
      // 每对固定生一雄一雌,保证下一代两性池非空
      const nextM: Pigeon[] = [];
      const nextF: Pigeon[] = [];
      for (let k = 0; k < 6; k++) {
        const sire = rng.pick(currentM);
        const dam = rng.pick(currentF);
        const son = breedSex(store, sire, dam, rng, nextId++, 0, 'M');
        const daughter = breedSex(store, sire, dam, rng, nextId++, 0, 'F');
        bornOrder.push(son.id, daughter.id);
        nextM.push(son);
        nextF.push(daughter);
      }
      currentM = nextM;
      currentF = nextF;
    }

    // 列表法需要亲本先于子代的顺序——bornOrder 满足
    const tabular = tabularInbreeding(store, bornOrder);
    const cache = new Map<string, number>();
    let checked = 0;
    for (const id of bornOrder) {
      const exact = inbreedingCoefficient(store, id, cache);
      const tab = tabular.get(id)!;
      expect(exact).toBeCloseTo(tab, 9);
      // Wright 仅枚举五代窗口,故其值 ≤ 精确值(窗口外更深共同祖先被截断)
      const w = wrightInbreeding(store, id);
      expect(w.inbreeding).toBeLessThanOrEqual(exact + 1e-9);
      checked++;
    }
    expect(checked).toBe(bornOrder.length);
    // 小群封闭繁育 12 代必然积累出可观近交
    const finalF = inbreedingCoefficient(store, bornOrder[bornOrder.length - 1]!, cache);
    expect(finalF).toBeGreaterThan(0.2);
  });

  it('FlockKinship 滚动矩阵与全谱系递归在 flock 存活期内完全一致', () => {
    const store = new PedigreeStore();
    const base = founders(store, 8, 7);
    // 容量取 2 倍 flock 规模,容纳一代墓碑而不触发压缩,验证纯滚动路径
    const kin = new FlockKinship(32);
    for (const b of base) kin.addFounder(b.id);
    const rng = new Rng(7);
    let males = base.filter((b) => b.sex === 'M');
    let females = base.filter((b) => b.sex === 'F');
    let id = 500;

    /** 确定性得到目标性别:同一 id 重试,失败个体不入库 */
    const breedSex = (sire: Pigeon, dam: Pigeon, sex: 'M' | 'F', f: number): Pigeon => {
      let child = mate({ sire, dam, rng, id, generation: sire.generation + 1, inbreeding: f });
      let guard = 0;
      while (child.sex !== sex && guard++ < 50) {
        child = mate({ sire, dam, rng, id, generation: sire.generation + 1, inbreeding: f });
      }
      expect(child.sex).toBe(sex);
      child.ringId = `K-${id}`;
      store.add(child);
      const bornF = kin.addOffspring(id, sire.id, dam.id);
      expect(bornF).toBeCloseTo(inbreedingCoefficient(store, child.id), 10);
      expect(child.inbreeding).toBeCloseTo(inbreedingCoefficient(store, child.id), 10);
      id++;
      return child;
    };

    for (let gen = 0; gen < 6; gen++) {
      const nextAll: Pigeon[] = [];
      // 4 对,每对固定一雄一雌 → 下一代 4 雄 4 雌
      for (let k = 0; k < 4; k++) {
        const sire = rng.pick(males);
        const dam = rng.pick(females);
        const fMatrix = kin.matingInbreeding(sire.id, dam.id);
        nextAll.push(breedSex(sire, dam, 'M', fMatrix));
        nextAll.push(breedSex(sire, dam, 'F', fMatrix));
      }
      for (const old of [...males, ...females]) kin.remove(old.id);
      males = nextAll.filter((b) => b.sex === 'M');
      females = nextAll.filter((b) => b.sex === 'F');
      expect(males).toHaveLength(4);
      expect(females).toHaveLength(4);
    }
  });
});
