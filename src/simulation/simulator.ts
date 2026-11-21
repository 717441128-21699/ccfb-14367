/**
 * 批量繁育模拟:大种群(默认 10,000 只)多世代(默认 50 代)演化。
 *
 * 工程策略:
 *  - 不把全部历史个体塞进亲缘矩阵——按「世代 flock」滚动:
 *    每代 flock 规模 = 种群规模,新一代诞生后旧代整体淘汰并压缩矩阵;
 *  - 近交系数通过 FlockKinship 的 O(n) 增量行计算,O(1) 查表配对;
 *  - 全量个体(每代 N 只)仍写入 PedigreeStore 做完整血统留档,
 *    模拟页可选「仅保留最近 k 代」以控制内存;
 *  - 选择:指数选择(三性状加权育种值排序,截断比例可配);
 *  - 交配:随机 / 同型选配 / 避近亲三种策略。
 */
import { expressPhenotype } from '../genetics/breeder.ts';
import { createFoundingPopulation, mate } from '../genetics/breeder.ts';
import { DensePoolKinship } from '../genetics/pool-kinship.ts';
import { Rng } from '../genetics/rng.ts';
import {
  LETHAL_LOCI,
  POLYGENIC_LOCI,
  TRAIT_CONFIG,
  TRAIT_KEYS,
  type TraitKey,
} from '../genetics/quantitative.ts';
import type { PedigreeStore, Pigeon } from '../genetics/model.ts';

/** 模拟器只依赖的亲缘能力:配对前查预期后代近交系数 */
interface KinshipEngine {
  matingInbreeding(sireId: number, damId: number): number;
}

export type MatingScheme = 'random' | 'assortative' | 'avoidKin';

export interface SimulationConfig {
  /** 每代繁殖种群规模(雌雄各半) */
  populationSize: number;
  generations: number;
  /** 每代参与繁殖的比例截断(1=全量随机,0.2=前 20% 精英) */
  selectionFraction: number;
  /** 选择指数权重,和为 1 */
  selectionWeights: Record<TraitKey, number>;
  matingScheme: MatingScheme;
  /** 避近亲策略下的配对尝试次数,取 F 最小者 */
  avoidKinTries: number;
  seed: number;
  /** 谱系库中保留的最近世代数;省略表示全量保留 */
  retainGenerations?: number;
}

export const DEFAULT_SIMULATION: SimulationConfig = {
  populationSize: 10000,
  generations: 50,
  // 留种比例 0.25 → 育种池 K≈2500,兼顾选择压与亲缘矩阵内存
  selectionFraction: 0.25,
  selectionWeights: { speed: 0.5, stamina: 0.25, homing: 0.25 },
  matingScheme: 'random',
  avoidKinTries: 6,
  seed: 20261122,
};

export interface GenerationStats {
  generation: number;
  population: number;
  mean: Record<TraitKey, number>;
  sd: Record<TraitKey, number>;
  /** 触顶比例(表型 ≥95) */
  ceilingRate: Record<TraitKey, number>;
  /** 触底比例(表型 ≤5) */
  floorRate: Record<TraitKey, number>;
  meanInbreeding: number;
  maxInbreeding: number;
  meanHarmfulLoad: number;
  /** 该代羽色表现型分布 Top 项 */
  colorDistribution: { name: string; rate: number }[];
}

export interface SimulationResult {
  config: SimulationConfig;
  totalBorn: number;
  elapsedMs: number;
  perGeneration: GenerationStats[];
  /** 最终世代个体 id(供血统书钻取) */
  finalGenerationIds: number[];
}

export interface SimulationHandlers {
  /** 每代完成回调,用于 UI 进度条 */
  onGeneration?: (stats: GenerationStats, index: number, total: number) => void;
}

/** 选择指数:加权育种值(不含环境噪声,反映可遗传部分) */
function selectionIndex(p: Pigeon, weights: Record<TraitKey, number>): number {
  let score = 0;
  for (const trait of TRAIT_KEYS) {
    const plus = [...p.genome.polygenic[trait]].reduce((a, b) => a + b, 0);
    const a = TRAIT_CONFIG[trait].geneticSd / Math.sqrt(POLYGENIC_LOCI * 2 * 0.25);
    score += weights[trait]! * (plus - POLYGENIC_LOCI) * a;
  }
  return score;
}

function summarize(generation: number, birds: Pigeon[]): GenerationStats {
  const n = birds.length;
  // 单遍扫描累加,避免 map/filter/spread 产生的 O(性状数) 个临时大数组
  const sum = { speed: 0, stamina: 0, homing: 0 } as Record<TraitKey, number>;
  const sqSum = { speed: 0, stamina: 0, homing: 0 } as Record<TraitKey, number>;
  const ceiling = { speed: 0, stamina: 0, homing: 0 } as Record<TraitKey, number>;
  const floor = { speed: 0, stamina: 0, homing: 0 } as Record<TraitKey, number>;
  let fSum = 0;
  let fMax = 0;
  let loadSum = 0;
  const colors = new Map<string, number>();

  for (const b of birds) {
    for (const trait of TRAIT_KEYS) {
      const v = b.phenotype[trait];
      sum[trait] += v;
      sqSum[trait] += v * v;
      if (v >= 95) ceiling[trait]++;
      if (v <= 5) floor[trait]++;
    }
    fSum += b.inbreeding;
    if (b.inbreeding > fMax) fMax = b.inbreeding;
    loadSum += b.phenotype.harmfulLoad;
    colors.set(b.phenotype.colorName, (colors.get(b.phenotype.colorName) ?? 0) + 1);
  }

  const mean = {} as Record<TraitKey, number>;
  const sd = {} as Record<TraitKey, number>;
  const ceilingRate = {} as Record<TraitKey, number>;
  const floorRate = {} as Record<TraitKey, number>;
  for (const trait of TRAIT_KEYS) {
    const m = sum[trait] / n;
    // Var = E[X²] - E[X]²,夹取非负防止浮点误差
    const variance = Math.max(0, sqSum[trait] / n - m * m);
    mean[trait] = round2(m);
    sd[trait] = round2(Math.sqrt(variance));
    ceilingRate[trait] = round4(ceiling[trait] / n);
    floorRate[trait] = round4(floor[trait] / n);
  }

  const colorDistribution = [...colors.entries()]
    .map(([name, count]) => ({ name, rate: round4(count / n) }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 8);

  return {
    generation,
    population: n,
    mean,
    sd,
    ceilingRate,
    floorRate,
    meanInbreeding: round4(fSum / n),
    maxInbreeding: round4(fMax),
    meanHarmfulLoad: round2(loadSum / n),
    colorDistribution,
  };
}

/**
 * 执行模拟。store 用于完整留档;返回逐代统计与末代 id。
 */
export function runSimulation(
  store: PedigreeStore,
  config: SimulationConfig = DEFAULT_SIMULATION,
  handlers: SimulationHandlers = {},
): SimulationResult {
  const started = performance.now();
  const rng = new Rng(config.seed);
  const N = config.populationSize;
  if (N % 2 !== 0) throw new Error('populationSize 必须为偶数(雌雄各半)');

  // ---- 奠基代 ----
  const founders = createFoundingPopulation({ size: N, rng });
  // 亲缘只追踪「实际留种的育种池」精英,矩阵规模随选择比例而非普查数
  const kinship = new DensePoolKinship();
  const selectK = Math.max(2, Math.floor((N / 2) * config.selectionFraction));
  for (const f of founders) store.add(f);
  // 奠基代育种池:指数最高的各性别 selectK 只
  const founderMales = founders.filter((b) => b.sex === 'M');
  const founderFemales = founders.filter((b) => b.sex === 'F');
  const founderPoolMales = topByIndex(founderMales, selectK, config.selectionWeights);
  const founderPoolFemales = topByIndex(founderFemales, selectK, config.selectionWeights);
  kinship.seed([...founderPoolMales.map((b) => b.id), ...founderPoolFemales.map((b) => b.id)]);

  let current = founders;
  let nextId = N + 1;
  const perGeneration: GenerationStats[] = [summarize(0, current)];
  handlers.onGeneration?.(perGeneration[0]!, 0, config.generations);

  let totalBorn = N;
  const retainedByGeneration: number[][] = [founders.map((f) => f.id)];

  for (let gen = 1; gen <= config.generations; gen++) {
    // ---- 选择:从当代选出留种精英(其亲本都在上一代育种池中) ----
    const males = current.filter((b) => b.sex === 'M');
    const females = current.filter((b) => b.sex === 'F');
    const chosenMales = topByIndex(males, selectK, config.selectionWeights);
    const chosenFemales = topByIndex(females, selectK, config.selectionWeights);

    // ---- 配对(在当前育种池矩阵上查近交,O(1)) ----
    const pairs = buildPairs(
      chosenMales,
      chosenFemales,
      kinship,
      config.matingScheme,
      config.avoidKinTries,
      rng,
    );

    // ---- 繁殖:配额在配对间均匀分摊,维持每代 N 只 ----
    const offspring: Pigeon[] = [];
    const baseQuota = Math.floor(N / pairs.length);
    let extra = N - baseQuota * pairs.length;
    // 记录每个子代的亲本,供下一代育种池矩阵构建
    const lineageOf = new Map<number, [number, number]>();
    for (const [sire, dam] of pairs) {
      const f = kinship.matingInbreeding(sire.id, dam.id);
      const take = baseQuota + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      for (let k = 0; k < take; k++) {
        const child = mate({
          sire,
          dam,
          rng,
          inbreeding: f,
          generation: gen,
          deferPhenotype: true,
        });
        const id = nextId++;
        child.id = id;
        child.ringId = `SIM-G${gen}-${String(id).padStart(7, '0')}`;
        // 延迟的表型在此统一结算一次(含近交衰退与遗传负荷)
        child.phenotype = expressPhenotype(child.genome, child.sex, f, child.envNoise);
        store.add(child);
        lineageOf.set(id, [sire.id, dam.id]);
        offspring.push(child);
      }
    }
    totalBorn += offspring.length;

    // ---- 构建下一代育种池矩阵:只对新精英调用,池外子代不参与亲缘 ----
    const nextMales = topByIndex(
      offspring.filter((b) => b.sex === 'M'),
      selectK,
      config.selectionWeights,
    );
    const nextFemales = topByIndex(
      offspring.filter((b) => b.sex === 'F'),
      selectK,
      config.selectionWeights,
    );
    const nextPool = [...nextMales, ...nextFemales];
    kinship.advance(
      nextPool.map((b) => {
        const parents = lineageOf.get(b.id)!;
        return [b.id, parents[0], parents[1]] as [number, number, number];
      }),
    );

    // ---- 世代轮换与留档裁剪 ----
    pruneOldGenerations(store, retainedByGeneration, gen, config.retainGenerations);
    retainedByGeneration.push(offspring.map((b) => b.id));
    current = offspring;

    const stats = summarize(gen, offspring);
    perGeneration.push(stats);
    handlers.onGeneration?.(stats, gen, config.generations);
  }

  return {
    config,
    totalBorn,
    elapsedMs: round2(performance.now() - started),
    perGeneration,
    finalGenerationIds: current.map((b) => b.id),
  };
}

/**
 * 取选择指数最高的 K 只。K≪n 时用最小堆做部分选择 O(n log K),
 * 避免对全群体 O(n log n) 全排序;K 接近 n 时退回排序。
 */
function topByIndex(birds: Pigeon[], k: number, weights: Record<TraitKey, number>): Pigeon[] {
  if (k >= birds.length) return [...birds];
  if (k > 64 || k > birds.length / 2) {
    return [...birds]
      .map((b) => ({ b, score: selectionIndex(b, weights) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, k)
      .map((x) => x.b);
  }
  // 最小堆:堆顶是当前 K 个里分数最低的,便于淘汰
  const heap: { b: Pigeon; score: number }[] = [];
  const siftUp = (): void => {
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.score <= heap[i]!.score) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const siftDown = (): void => {
    let i = 0;
    const last = heap.length - 1;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let smallest = i;
      if (l <= last && heap[l]!.score < heap[smallest]!.score) smallest = l;
      if (r <= last && heap[r]!.score < heap[smallest]!.score) smallest = r;
      if (smallest === i) break;
      [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
      i = smallest;
    }
  };
  for (const b of birds) {
    const entry = { b, score: selectionIndex(b, weights) };
    if (heap.length < k) {
      heap.push(entry);
      siftUp();
    } else if (entry.score > heap[0]!.score) {
      heap[0] = entry;
      siftDown();
    }
  }
  return heap.map((x) => x.b);
}

function buildPairs(
  males: Pigeon[],
  females: Pigeon[],
  kinship: KinshipEngine,
  scheme: MatingScheme,
  avoidTries: number,
  rng: Rng,
): [Pigeon, Pigeon][] {
  const pairs: [Pigeon, Pigeon][] = [];
  const usedDams = new Set<number>();
  const damPool = [...females];
  // 同型选配只需一次性排序,避免每只雄鸽重复 O(n log n)
  const equalWeights: Record<TraitKey, number> = { speed: 1, stamina: 1, homing: 1 };
  const damsByIndex = [...females].sort(
    (a, b) => selectionIndex(b, equalWeights) - selectionIndex(a, equalWeights),
  );

  for (const sire of males) {
    let dam: Pigeon | undefined;
    if (scheme === 'random') {
      dam = drawUnused(damPool, usedDams, rng);
    } else if (scheme === 'assortative') {
      // 同型选配:按指数排序的雌雄一一对应
      dam = damsByIndex.find((d) => !usedDams.has(d.id));
    } else {
      // 避近亲:多次随机尝试取 F 最小
      let best: { bird: Pigeon; f: number } | null = null;
      for (let t = 0; t < avoidTries; t++) {
        const candidate = drawUnused(damPool, usedDams, rng);
        if (!candidate) break;
        const f = kinship.matingInbreeding(sire.id, candidate.id);
        if (!best || f < best.f) best = { bird: candidate, f };
      }
      dam = best?.bird ?? drawUnused(damPool, usedDams, rng);
    }
    if (!dam) break;
    usedDams.add(dam.id);
    pairs.push([sire, dam]);
  }
  return pairs;
}

function drawUnused(pool: Pigeon[], used: Set<number>, rng: Rng): Pigeon | undefined {
  const available = pool.filter((d) => !used.has(d.id));
  if (available.length === 0) return undefined;
  return rng.pick(available);
}

/**
 * 谱系留档裁剪:只保留最近 retainGenerations 代 + 其可追溯祖先。
 * 注意:裁剪后被删个体的后代仍保留 id 引用,查询时按「断代奠基者」处理。
 */
function pruneOldGenerations(
  store: PedigreeStore,
  generations: number[][],
  currentGen: number,
  retainGenerations?: number,
): void {
  if (retainGenerations === undefined) return;
  const cutoff = currentGen - retainGenerations;
  if (cutoff <= 0) return;
  const stale = generations[cutoff - 1];
  if (!stale) return;
  store.removeMany(stale);
  generations[cutoff - 1] = [];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export { LETHAL_LOCI };
