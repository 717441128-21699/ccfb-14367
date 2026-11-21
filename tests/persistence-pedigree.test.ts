import { describe, expect, it } from 'vitest';
import {
  buildPedigreeBook,
  createFoundingPopulation,
  explainInbreeding,
  exportNdjson,
  importNdjson,
  mate,
  MemoryLineSink,
  MemoryLineSource,
  PedigreeStore,
  Rng,
  snapshotFromJson,
  snapshotToJson,
} from '../src/index.ts';

function makeStore(n: number, seed = 1): PedigreeStore {
  const store = new PedigreeStore();
  const rng = new Rng(seed);
  for (const p of createFoundingPopulation({ size: n, rng })) store.add(p);
  return store;
}

describe('JSON 快照持久化', () => {
  it('往返序列化后全字段一致', () => {
    const store = makeStore(30);
    const json = snapshotToJson(store);
    const restored = snapshotFromJson(json);
    expect(restored.size).toBe(store.size);
    for (const original of store.all()) {
      const copy = restored.getOrThrow(original.id);
      expect(copy.ringId).toBe(original.ringId);
      expect(copy.sex).toBe(original.sex);
      expect(copy.phenotype).toEqual(original.phenotype);
      expect([...copy.genome.polygenic.speed]).toEqual([...original.genome.polygenic.speed]);
      expect([...copy.genome.harmful]).toEqual([...original.genome.harmful]);
      expect(copy.genome.color).toEqual(original.genome.color);
      expect(copy.inbreeding).toBe(original.inbreeding);
    }
  });

  it('magic 与版本错误时拒绝加载', () => {
    expect(() => snapshotFromJson(JSON.stringify({ magic: 'WRONG', version: 1 }))).toThrow(/magic/);
    expect(() => snapshotFromJson(JSON.stringify({ magic: 'PIGEON-PEDIGREE-V1', version: 9 }))).toThrow(/版本/);
  });
});

describe('NDJSON 流式持久化', () => {
  it('导出再导入个体不丢失,条数清单校验生效', async () => {
    const store = makeStore(100, 8);
    const sink = new MemoryLineSink();
    await exportNdjson(store, sink);
    expect(sink.lines.length).toBe(101); // 头行 + 100 个体
    const restored = await importNdjson(new MemoryLineSource(sink.lines));
    expect(restored.size).toBe(100);

    // 破坏条数
    const broken = [...sink.lines];
    broken[0] = JSON.stringify({ magic: 'PIGEON-PEDIGREE-V1', kind: 'header', count: 999 });
    await expect(importNdjson(new MemoryLineSource(broken))).rejects.toThrow(/条数/);
  });
});

describe('五代血统书', () => {
  it('完整五代树覆盖 63 个槽位,查询带耗时指标', () => {
    // 构造深度 5 的完整二叉谱系:2+4+8+16+32 个祖先 + 根,共 63 节点
    const store = new PedigreeStore();
    const rng = new Rng(909);
    const base = createFoundingPopulation({ size: 64, rng });
    for (const b of base) store.add(b);

    // 每层两两配对,每对生 1 个(交替性别),输出数量严格减半,五层后收敛到 2 个个体
    let layer = base;
    let idCounter = 10000;
    const breedTargetSex = (
      sire: (typeof base)[number],
      dam: (typeof base)[number],
      sex: 'M' | 'F',
      generation: number,
    ): (typeof base)[number] => {
      let child = mate({ sire, dam, rng, id: idCounter, generation });
      let guard = 0;
      while (child.sex !== sex && guard++ < 100) {
        child = mate({ sire, dam, rng, id: idCounter, generation });
      }
      expect(child.sex).toBe(sex);
      child.ringId = `D${generation}-${idCounter}`;
      idCounter++;
      store.add(child);
      return child;
    };
    const nextLayer = (current: typeof base, depth: number): typeof base => {
      const out: typeof base = [];
      const males = current.filter((b) => b.sex === 'M');
      const females = current.filter((b) => b.sex === 'F');
      const pairs = Math.min(males.length, females.length);
      for (let i = 0; i < pairs; i++) {
        // 交替雄雌,保证新一层两性数量均衡
        const sex: 'M' | 'F' = i % 2 === 0 ? 'M' : 'F';
        out.push(breedTargetSex(males[i]!, females[i]!, sex, depth));
      }
      return out;
    };
    let depth = 1;
    while (layer.length > 2) {
      layer = nextLayer(layer, depth++);
    }
    // 最后两只(一雄一雌)产生根
    const rootSire = layer.find((b) => b.sex === 'M')!;
    const rootDam = layer.find((b) => b.sex === 'F')!;
    const root = breedTargetSex(rootSire, rootDam, 'M', depth);

    const book = buildPedigreeBook(store, root.id);
    expect(book.coveredCount).toBe(63);
    expect(book.missingCount).toBe(0);
    const slot1 = book.slots.get(1)!;
    const slot2 = book.slots.get(2)!;
    const slot3 = book.slots.get(3)!;
    expect(slot1.pigeon!.id).toBe(root.id);
    const sireId = root.sireId!;
    const damId = root.damId!;
    expect(slot2.pigeon!.id).toBe(store.getOrThrow(sireId).id);
    expect(slot3.pigeon!.id).toBe(store.getOrThrow(damId).id);
    // 第五层槽位(32..63)均有个体
    for (let slot = 32; slot <= 63; slot++) {
      expect(book.slots.get(slot)!.depth).toBe(5);
    }
    expect(book.queryMs).toBeGreaterThanOrEqual(0);
  });

  it('断代个体的缺失祖先不计入覆盖数', () => {
    const store = makeStore(2);
    const root = [...store.all()][0]!;
    const book = buildPedigreeBook(store, root.id);
    expect(book.coveredCount).toBe(1);
    expect(book.missingCount).toBe(62);
  });

  it('近交分解同时给出精确 F、Wright 明细与两法差值', () => {
    const store = new PedigreeStore();
    const rng = new Rng(202);
    const base = createFoundingPopulation({ size: 4, rng });
    for (const b of base) store.add(b);
    const sire0 = base.find((b) => b.sex === 'M')!;
    const dam0 = base.find((b) => b.sex === 'F')!;
    const breed = (sex: 'M' | 'F', id: number) => {
      let c = mate({ sire: sire0, dam: dam0, rng, id });
      while (c.sex !== sex) c = mate({ sire: sire0, dam: dam0, rng, id });
      c.ringId = `S-${id}`;
      store.add(c);
      return c;
    };
    const son = breed('M', 500);
    const daughter = breed('F', 501);
    const inbred = mate({ sire: son, dam: daughter, rng, id: 502, inbreeding: 0.25 });
    inbred.ringId = 'S-502';
    store.add(inbred);

    const breakdown = explainInbreeding(store, inbred.id);
    expect(breakdown.coefficient).toBeCloseTo(0.25, 10);
    expect(breakdown.wright.coefficient).toBeCloseTo(0.25, 10);
    expect(breakdown.delta).toBeLessThan(1e-9);
    expect(breakdown.wright.contributions.length).toBe(2);
    expect(breakdown.computationMs).toBeGreaterThanOrEqual(0);
  });
});
