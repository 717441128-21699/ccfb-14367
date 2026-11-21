/**
 * 配对预测:在实际配种前给出后代的完整概率分布。
 *
 *  - 羽色:六个位点的配子概率做精确枚举(非蒙特卡洛),按性别加权后
 *    汇总到表现型名称,概率总和严格为 1;
 *  - 数量性状:育种值分布用解析正态近似
 *      A_off ~ N( mid-parent A,  0.5·V_A·(1 - f_sd) + V_Mendelian ),
 *    叠加环境方差与固定近交衰退 -bF,输出分位点与 0–100 直方图;
 *  - 遗传负荷:每个有害位点的发病概率(隐性纯合)精确求和。
 */
import { expressColor } from './color.ts';
import { predictedOffspringInbreeding } from './inbreeding.ts';
import type { ColorGenotype, Sex } from './loci.ts';
import {
  environmentalSd,
  HARMFUL_PENALTY_PER_LOCUS,
  LETHAL_LOCI,
  POLYGENIC_LOCI,
  TRAIT_CONFIG,
  TRAIT_KEYS,
  TRAIT_LABELS,
  type TraitKey,
} from './quantitative.ts';
import type { PedigreeStore, Pigeon } from './model.ts';
import { breedingValueOf, plusCountOf } from './breeder.ts';

// ---------------------------------------------------------------- 配子概率

type Dist<T> = Map<T, number>;

/** 常染色体位点:由亲本二倍体(或半合子)基因型求配子等位分布 */
function gameteDist<T>(pair: readonly [T, T | null]): Dist<T> {
  const [a, b] = pair;
  const d = new Map<T, number>();
  if (b === null || a === b) {
    d.set(a, 1);
  } else {
    d.set(a, 0.5);
    d.set(b, 0.5);
  }
  return d;
}

/** 两个配子分布的笛卡尔积 → 基因型对及概率 */
function genotypePairs<T>(sireGametes: Dist<T>, damGametes: Dist<T>): [T, T, number][] {
  const rows: [T, T, number][] = [];
  for (const [a, pa] of sireGametes) {
    for (const [b, pb] of damGametes) {
      rows.push([a, b, pa * pb]);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- 羽色预测

export interface ColorOutcome {
  name: string;
  code: string;
  probability: number;
}

export interface ColorPrediction {
  /** 按表现型聚合的概率分布(已按性别 1:1 加权) */
  outcomes: ColorOutcome[];
  /** 儿子(ZZ)的基础色表现分布 */
  maleBase: Dist<string>;
  /** 女儿(半合子)的基础色表现分布 */
  femaleBase: Dist<string>;
}

export function predictColor(sire: Pigeon, dam: Pigeon): ColorPrediction {
  const aggregate = new Map<string, { name: string; code: string; probability: number }>();
  const maleBase = new Map<string, number>();
  const femaleBase = new Map<string, number>();

  // 常染色体位点的基因型对(雌雄共用)
  const autoPairs = {
    pattern: genotypePairs(
      gameteDist(sire.genome.color.pattern),
      gameteDist(dam.genome.color.pattern),
    ),
    spread: genotypePairs(
      gameteDist(sire.genome.color.spread),
      gameteDist(dam.genome.color.spread),
    ),
    recessiveRed: genotypePairs(
      gameteDist(sire.genome.color.recessiveRed),
      gameteDist(dam.genome.color.recessiveRed),
    ),
    dilute: genotypePairs(
      gameteDist(sire.genome.color.dilute),
      gameteDist(dam.genome.color.dilute),
    ),
    grizzle: genotypePairs(
      gameteDist(sire.genome.color.grizzle),
      gameteDist(dam.genome.color.grizzle),
    ),
  };

  // Z 连锁:父 Z 配子 × 母 Z 配子
  const sireBaseG = gameteDist(sire.genome.color.base);
  const damBaseG = gameteDist(dam.genome.color.base);

  for (const sex of ['M', 'F'] as Sex[]) {
    const sexWeight = 0.5;
    const baseRows: [string, string | null, number][] =
      sex === 'M'
        ? genotypePairs(sireBaseG, damBaseG).map(([a, b, p]) => [a, b, p])
        : [...sireBaseG.entries()].map(([a, p]) => [a, null, p]);

    for (const [b1, b2, bp] of baseRows) {
      for (const [p1, p2, pp] of autoPairs.pattern) {
        for (const [s1, s2, sp] of autoPairs.spread) {
          for (const [e1, e2, ep] of autoPairs.recessiveRed) {
            for (const [d1, d2, dp] of autoPairs.dilute) {
              for (const [g1, g2, gp] of autoPairs.grizzle) {
                const joint = sexWeight * bp! * pp! * sp! * ep! * dp! * gp!;
                const geno: ColorGenotype = {
                  base: [b1 as ColorGenotype['base'][0], b2 as ColorGenotype['base'][1]],
                  pattern: [p1 as ColorGenotype['pattern'][0], p2 as ColorGenotype['pattern'][1]],
                  spread: [s1 as ColorGenotype['spread'][0], s2 as ColorGenotype['spread'][1]],
                  recessiveRed: [
                    e1 as ColorGenotype['recessiveRed'][0],
                    e2 as ColorGenotype['recessiveRed'][1],
                  ],
                  dilute: [d1 as ColorGenotype['dilute'][0], d2 as ColorGenotype['dilute'][1]],
                  grizzle: [g1 as ColorGenotype['grizzle'][0], g2 as ColorGenotype['grizzle'][1]],
                };
                const pheno = expressColor(geno, sex);
                const prev = aggregate.get(pheno.code);
                if (prev) prev.probability += joint;
                else
                  aggregate.set(pheno.code, {
                    name: pheno.name,
                    code: pheno.code,
                    probability: joint,
                  });
                const baseTarget = sex === 'M' ? maleBase : femaleBase;
                baseTarget.set(
                  pheno.baseColor,
                  (baseTarget.get(pheno.baseColor) ?? 0) + joint,
                );
              }
            }
          }
        }
      }
    }
  }

  const outcomes = [...aggregate.values()]
    .map((o) => ({ ...o, probability: round6(o.probability) }))
    .sort((a, b) => b.probability - a.probability);
  return { outcomes, maleBase, femaleBase };
}

// ---------------------------------------------------------------- 数量性状预测

export interface TraitDistribution {
  trait: TraitKey;
  label: string;
  /** 分布均值(含近交衰退与遗传负荷期望) */
  mean: number;
  sd: number;
  /** 近交造成的固定下移量 b·F */
  inbreedingPenalty: number;
  /** 遗传负荷期望惩罚 E[L]·c */
  expectedLoadPenalty: number;
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number };
  /** 0–100 分箱直方图(每 5 分一箱,共 20 箱) */
  histogram: { binStart: number; probability: number }[];
  /** 触顶(≥95)与触底(≤5)概率,供策划判断天花板 */
  ceilingProbability: number;
  floorProbability: number;
}

/** 标准正态 CDF(Abramowitz 7.1.26 近似) */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

function invNorm(p: number): number {
  // Beasley–Springer–Moro 逆正态
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  );
}

/**
 * 单个加性位点的亲本配子增效等位概率 = 亲本计数/2;
 * 后代位点计数分布为两个独立伯努利之和。
 */
function offspringPlusVariance(sire: Pigeon, dam: Pigeon, trait: TraitKey): number {
  let mendelianVar = 0;
  for (let i = 0; i < POLYGENIC_LOCI; i++) {
    const ps = sire.genome.polygenic[trait][i]! / 2;
    const pd = dam.genome.polygenic[trait][i]! / 2;
    // 两个独立伯努利之和的方差
    mendelianVar += ps * (1 - ps) + pd * (1 - pd);
  }
  const cfg = TRAIT_CONFIG[trait];
  // 计数方差换算回表型量纲(每计数的等位效应)
  const a = cfg.geneticSd / Math.sqrt(POLYGENIC_LOCI * 2 * 0.25);
  return mendelianVar * a * a;
}

export function predictTrait(
  store: PedigreeStore,
  sire: Pigeon,
  dam: Pigeon,
  trait: TraitKey,
): TraitDistribution {
  const cfg = TRAIT_CONFIG[trait];
  const f = predictedOffspringInbreeding(store, sire.id, dam.id);

  const midParentA = (breedingValueOf(sire, trait) + breedingValueOf(dam, trait)) / 2;
  const mendelianVar = offspringPlusVariance(sire, dam, trait);
  // 近交降低等位分离的有效方差:乘 (1 - F)
  const geneticVar = mendelianVar * (1 - f);
  const envVar = environmentalSd(trait) ** 2;

  // 遗传负荷期望:逐位点求隐性纯合概率
  let expectedLoad = 0;
  for (let i = 0; i < LETHAL_LOCI; i++) {
    const qs = sire.genome.harmful[i]! / 2;
    const qd = dam.genome.harmful[i]! / 2;
    expectedLoad += qs * qd;
  }
  const loadPenalty = expectedLoad * HARMFUL_PENALTY_PER_LOCUS;
  const depression = cfg.depressionPerF * f;

  const mean = cfg.mean + midParentA - depression - loadPenalty;
  const sd = Math.sqrt(geneticVar + envVar);

  const clamp = (v: number) => Math.min(cfg.max, Math.max(cfg.min, v));
  const pct = (p: number) => round1(clamp(mean + sd * invNorm(p)));
  const percentiles = { p5: pct(0.05), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p95: pct(0.95) };

  const histogram: { binStart: number; probability: number }[] = [];
  for (let binStart = 0; binStart < 100; binStart += 5) {
    const lo = binStart;
    const hi = binStart + 5;
    const prob = normalCdf((hi - mean) / sd) - normalCdf((lo - mean) / sd);
    histogram.push({ binStart, probability: round6(prob) });
  }
  // 把截断到 [1,99] 之外的概率并入首尾箱
  const below = normalCdf((0 - mean) / sd);
  const above = 1 - normalCdf((100 - mean) / sd);
  histogram[0]!.probability = round6(histogram[0]!.probability + below);
  histogram[19]!.probability = round6(histogram[19]!.probability + above);

  return {
    trait,
    label: TRAIT_LABELS[trait],
    mean: round1(clamp(mean)),
    sd: round2(sd),
    inbreedingPenalty: round2(depression),
    expectedLoadPenalty: round2(loadPenalty),
    percentiles,
    histogram,
    ceilingProbability: round6(1 - normalCdf((95 - mean) / sd)),
    floorProbability: round6(normalCdf((5 - mean) / sd)),
  };
}

// ---------------------------------------------------------------- 配对报告

export interface PairingReport {
  sireId: number;
  damId: number;
  offspringInbreeding: number;
  color: ColorPrediction;
  traits: Record<TraitKey, TraitDistribution>;
  /** 任一有害位点发病的概率(至少一个纯合) */
  anyDisorderProbability: number;
  disorderLoci: { locus: number; probability: number }[];
}

export function predictPairing(
  store: PedigreeStore,
  sireId: number,
  damId: number,
): PairingReport {
  const sire = store.getOrThrow(sireId);
  const dam = store.getOrThrow(damId);
  const f = predictedOffspringInbreeding(store, sireId, damId);

  const traits = {} as Record<TraitKey, TraitDistribution>;
  for (const trait of TRAIT_KEYS) traits[trait] = predictTrait(store, sire, dam, trait);

  const disorderLoci: { locus: number; probability: number }[] = [];
  let healthyProduct = 1;
  for (let i = 0; i < LETHAL_LOCI; i++) {
    const qs = sire.genome.harmful[i]! / 2;
    const qd = dam.genome.harmful[i]! / 2;
    const p = qs * qd;
    disorderLoci.push({ locus: i, probability: round6(p) });
    healthyProduct *= 1 - p;
  }

  return {
    sireId,
    damId,
    offspringInbreeding: round6(f),
    color: predictColor(sire, dam),
    traits,
    anyDisorderProbability: round6(1 - healthyProduct),
    disorderLoci,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export { plusCountOf };
