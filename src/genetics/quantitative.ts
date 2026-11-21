/**
 * 数量性状:速度、耐力、归巢性。
 *
 * 模型(标准数量遗传学):
 *  P(表型) = μ + A(育种值,10 个加性微效位点) + I(近交衰退 -b·F) + E(环境偏差)
 * 其中 E ~ N(0, σ_E²),遗传力 h² = σ_A² / (σ_A² + σ_E²)。
 *
 * 每个微效位点为二等位(+ 增效 / - 减效),纯合 ++ 记 2 个增效计数,
 * 杂合记 1 个,-- 记 0 个;等位效应 a 由目标遗传力反推。
 */

export type TraitKey = 'speed' | 'stamina' | 'homing';

export const TRAIT_KEYS: readonly TraitKey[] = ['speed', 'stamina', 'homing'];

export const TRAIT_LABELS: Record<TraitKey, string> = {
  speed: '速度',
  stamina: '耐力',
  homing: '归巢',
};

/** 每个性状的微效加性位点数量 */
export const POLYGENIC_LOCI = 10;

export interface TraitConfig {
  /** 群体均值 μ(0–100 量表) */
  mean: number;
  /** 目标遗传力 h²(基础群、随机交配下) */
  heritability: number;
  /** 基础群遗传标准差 σ_A,决定加性方差规模 */
  geneticSd: number;
  /** 近交衰退斜率:每单位 F 的表型下降量(表型标准差倍数在代码中换算) */
  depressionPerF: number;
  /** 表型硬上下限(天花板/地板) */
  min: number;
  max: number;
}

export const TRAIT_CONFIG: Record<TraitKey, TraitConfig> = {
  speed: { mean: 60, heritability: 0.4, geneticSd: 8, depressionPerF: 12, min: 1, max: 99 },
  stamina: { mean: 58, heritability: 0.35, geneticSd: 7, depressionPerF: 10, min: 1, max: 99 },
  homing: { mean: 62, heritability: 0.45, geneticSd: 9, depressionPerF: 14, min: 1, max: 99 },
};

/** 有害隐性位点数量(遗传负荷):纯合发病,影响生活力并小幅拖累全部性状 */
export const LETHAL_LOCI = 6;

/**
 * 单个加性位点的等位效应。
 * 基础群等位频率 p=0.5 时,增效计数 k ~ Binom(20, 0.5),Var(k)=20·0.25=5,
 * 故 a = σ_A / sqrt(5),使 σ_A 与配置一致。
 */
export function alleleEffect(trait: TraitKey): number {
  const cfg = TRAIT_CONFIG[trait];
  return cfg.geneticSd / Math.sqrt(POLYGENIC_LOCI * 2 * 0.25);
}

/** 环境标准差 σ_E,由 h² 与 σ_A 反推:h² = σ_A²/(σ_A²+σ_E²) */
export function environmentalSd(trait: TraitKey): number {
  const cfg = TRAIT_CONFIG[trait];
  return cfg.geneticSd * Math.sqrt((1 - cfg.heritability) / cfg.heritability);
}

/**
 * 由增效等位计数(0..20)计算育种值 A(相对群体均值的加性偏离)。
 */
export function breedingValue(trait: TraitKey, plusCount: number): number {
  // 10 位点杂合基准计数为 10,居中后乘以等位效应
  return (plusCount - POLYGENIC_LOCI) * alleleEffect(trait);
}

/**
 * 完整表型值:μ + A - b·F + E,并截断到硬上下限。
 * @param plusCount  该性状增效等位计数
 * @param inbreeding 个体近交系数 F(0..1)
 * @param envNoise   预生成的环境偏差 N(0, σ_E²),由 Rng 注入保证可复现
 */
export function phenotypeValue(
  trait: TraitKey,
  plusCount: number,
  inbreeding: number,
  envNoise: number,
): number {
  const cfg = TRAIT_CONFIG[trait];
  const raw =
    cfg.mean + breedingValue(trait, plusCount) - cfg.depressionPerF * inbreeding + envNoise;
  return Math.min(cfg.max, Math.max(cfg.min, raw));
}

/**
 * 遗传负荷:有害位点纯合数量。
 * @param homozygousHarmful 长度 LETHAL_LOCI 的布尔数组,true 表示该位点隐性纯合发病
 */
export function harmfulLoad(homozygousHarmful: readonly boolean[]): number {
  return homozygousHarmful.filter(Boolean).length;
}

/** 每个发病有害位点对全部数量性状的额外惩罚 */
export const HARMFUL_PENALTY_PER_LOCUS = 4;
