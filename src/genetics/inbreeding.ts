/**
 * 近交系数与共祖系数(亲缘系数)。
 *
 * 三套独立实现,测试中互相校验结果一致:
 *  1. Wright 路径系数法 —— 血统书页展示用,可列出每个共同祖先的贡献明细;
 *     受限于祖先 DAG 路径枚举规模,仅用于五代深度的展示与小规模基准。
 *  2. Henderson 列表法(亲缘关系矩阵 A)—— 标准参考实现,测试基准。
 *  3. 共祖系数记忆化递归 —— 生产与配对预测热路径,支持深度剪枝。
 *
 * 定义:
 *  共祖系数 f(x,y):从 x、y 群体中各随机抽取一个等位基因,其同源相同(IBD)的概率。
 *    f(x,x) = (1 + F_x)/2
 *    f(x,y) = [f(x,s_y) + f(x,d_y)] / 2          (y 有双亲时)
 *    无亲本的奠基者之间 f = 0
 *  个体近交系数 F_x = f(sire_x, dam_x)。
 */
import type { PedigreeStore, Pigeon } from './model.ts';

export interface WrightContribution {
  ancestorId: number;
  ancestorRing: string;
  /** 父亲到共同祖先的世代数(路径边数) */
  n1: number;
  /** 母亲到共同祖先的世代数 */
  n2: number;
  /** 共同祖先自身的近交系数 F_A */
  ancestorInbreeding: number;
  /** 该路径对 F 的贡献 (1/2)^(n1+n2+1)·(1+F_A) */
  contribution: number;
}

export interface WrightResult {
  inbreeding: number;
  contributions: WrightContribution[];
}

// ---------------------------------------------------------------- 共祖递归

export interface CoancestryOptions {
  /** 递归深度剪枝:超过该世代的祖先视为无关奠基者;省略则精确计算 */
  maxDepth?: number;
}

/**
 * 记忆化共祖系数。cache 可跨个体复用(如一次配对预测会话)。
 */
export function coancestry(
  store: PedigreeStore,
  xId: number,
  yId: number,
  cache: Map<string, number> = new Map(),
  opts: CoancestryOptions = {},
): number {
  if (xId === yId) {
    const x = store.get(xId);
    if (!x || x.sireId === null || x.damId === null) return 0.5; // 奠基者:F=0
    const f = 0.5 * (1 + coancestry(store, x.sireId, x.damId, cache, opts));
    return f;
  }
  const [lo, hi] = xId < yId ? [xId, yId] : [yId, xId];
  const key = `${lo}:${hi}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const value = computeCoancestry(store, lo, hi, cache, opts, 0);
  cache.set(key, value);
  return value;
}

function computeCoancestry(
  store: PedigreeStore,
  xId: number,
  yId: number,
  cache: Map<string, number>,
  opts: CoancestryOptions,
  depth: number,
): number {
  if (opts.maxDepth !== undefined && depth > opts.maxDepth) return 0;
  const y = store.get(yId);
  if (!y || y.sireId === null || y.damId === null) {
    // y 是奠基者:换 x 一侧展开(若两侧都是奠基者则为 0)
    const x = store.get(xId);
    if (!x || x.sireId === null || x.damId === null) return 0;
    return (
      0.5 *
      (computeCoancestry(store, yId, x.sireId, cache, opts, depth + 1) +
        computeCoancestry(store, yId, x.damId, cache, opts, depth + 1))
    );
  }
  return (
    0.5 *
    (coancestry(store, xId, y.sireId, cache, opts) +
      coancestry(store, xId, y.damId, cache, opts))
  );
}

/** 个体近交系数 F = f(父, 母),单亲或双亲未知时为 0 */
export function inbreedingCoefficient(
  store: PedigreeStore,
  pigeonId: number,
  cache: Map<string, number> = new Map(),
  opts: CoancestryOptions = {},
): number {
  const p = store.get(pigeonId);
  if (!p || p.sireId === null || p.damId === null) return 0;
  return coancestry(store, p.sireId, p.damId, cache, opts);
}

/** 一对候选配对的预期后代近交系数(即双亲的共祖系数) */
export function predictedOffspringInbreeding(
  store: PedigreeStore,
  sireId: number,
  damId: number,
  cache: Map<string, number> = new Map(),
  opts: CoancestryOptions = {},
): number {
  return coancestry(store, sireId, damId, cache, opts);
}

// ---------------------------------------------------------------- Wright 路径法

/**
 * Wright 路径系数法:
 *   F_X = Σ_A Σ_路径对  (1/2)^(n1+n2+1) · (1 + F_A)
 * 仅枚举双亲五代内共同祖先(血统书场景),路径对要求除 A 外无其他共同节点。
 */
export function wrightInbreeding(store: PedigreeStore, pigeonId: number): WrightResult {
  const x = store.get(pigeonId);
  if (!x || x.sireId === null || x.damId === null) {
    return { inbreeding: 0, contributions: [] };
  }
  const cache = new Map<string, number>();
  const sireTree = store.ancestors(x.sireId, 5);
  const damTree = store.ancestors(x.damId, 5);
  const common: number[] = [];
  for (const id of sireTree.keys()) {
    if (damTree.has(id)) common.push(id);
  }

  const contributions: WrightContribution[] = [];
  let total = 0;
  for (const ancestorId of common) {
    const sirePaths = enumeratePaths(store, x.sireId, ancestorId, 5);
    const damPaths = enumeratePaths(store, x.damId, ancestorId, 5);
    const ancestor = store.getOrThrow(ancestorId);
    const fA = inbreedingCoefficient(store, ancestorId, cache);
    for (const p1 of sirePaths) {
      for (const p2 of damPaths) {
        // 路径除共同祖先外不得相交
        const interior1 = new Set(p1.slice(0, -1));
        const overlap = p2.slice(0, -1).some((id) => interior1.has(id));
        if (overlap) continue;
        const n1 = p1.length - 1;
        const n2 = p2.length - 1;
        const contribution = Math.pow(0.5, n1 + n2 + 1) * (1 + fA);
        total += contribution;
        contributions.push({
          ancestorId,
          ancestorRing: ancestor.ringId,
          n1,
          n2,
          ancestorInbreeding: fA,
          contribution,
        });
      }
    }
  }
  return { inbreeding: total, contributions };
}

/** 枚举 from→to 的全部简单路径(沿亲本链接,长度 ≤ maxLen) */
function enumeratePaths(
  store: PedigreeStore,
  from: number,
  to: number,
  maxLen: number,
): number[][] {
  const paths: number[][] = [];
  const walk = (current: number, trail: number[]): void => {
    if (current === to) {
      paths.push([...trail, current]);
      return;
    }
    if (trail.length >= maxLen) return;
    const node = store.get(current);
    if (!node) return;
    for (const parentId of [node.sireId, node.damId]) {
      if (parentId === null || trail.includes(parentId)) continue;
      walk(parentId, [...trail, current]);
    }
  };
  walk(from, []);
  return paths;
}

// ---------------------------------------------------------------- Henderson 列表法

/**
 * 列表法构建亲缘关系矩阵的对角与必要元素,按传入 id 顺序(要求亲本先于子代)。
 * 规则:
 *   a_ii = 1 + F_i = 1 + 0.5·a_{s_i d_i}
 *   a_ij = 0.5·(a_{i,s_j} + a_{i,d_j})   (j 有双亲)
 *   奠基者 a_ii = 1
 * 返回每个 id 的近交系数 F_i = 0.5·a_{s_i d_i}。
 */
export function tabularInbreeding(store: PedigreeStore, orderedIds: number[]): Map<number, number> {
  const a = new Map<string, number>();
  const get = (i: number, j: number): number => {
    if (i === j) return a.get(`d:${i}`) ?? 0;
    const [lo, hi] = i < j ? [i, j] : [j, i];
    return a.get(`${lo}:${hi}`) ?? 0;
  };
  const setOff = (i: number, j: number, v: number): void => {
    const [lo, hi] = i < j ? [i, j] : [j, i];
    a.set(`${lo}:${hi}`, v);
  };

  const result = new Map<number, number>();
  for (const id of orderedIds) {
    const p: Pigeon = store.getOrThrow(id);
    let f = 0;
    if (p.sireId !== null && p.damId !== null) {
      f = 0.5 * get(p.sireId, p.damId);
      for (const earlier of orderedIds) {
        if (earlier === id) break;
        const v = 0.5 * (get(earlier, p.sireId) + get(earlier, p.damId));
        setOff(earlier, id, v);
      }
    }
    a.set(`d:${id}`, 1 + f);
    result.set(id, f);
  }
  return result;
}
