/**
 * 繁育引擎:配子生成(减数分裂)、配种、基础群建立、表型结算。
 *
 * 建模约定:
 *  - 位点之间独立分配(无连锁),每个位点等概率传递一个等位;
 *  - Z 性连锁:雄性 ZZ 可传 Z(带基础色位点),雌性 ZW——
 *    传 Z 得雄性后代(基础色等位来自母方 Z),传 W 得雌性后代(基础色仅来自父方 Z);
 *  - 微效加性位点:后代每个位点的增效计数 = 父本贡献 + 母本贡献(各 0/1);
 *  - 有害隐性位点同理,纯合(计数 2)即发病。
 */
import { expressColor } from './color.ts';
import { inbreedingCoefficient } from './inbreeding.ts';
import {
  BASE_ALLELES,
  DILUTE_ALLELES,
  GRIZZLE_ALLELES,
  PATTERN_ALLELES,
  type ColorGenotype,
  type Sex,
  SPREAD_ALLELES,
  REC_RED_ALLELES,
} from './loci.ts';
import {
  alleleEffect,
  environmentalSd,
  HARMFUL_PENALTY_PER_LOCUS,
  LETHAL_LOCI,
  phenotypeValue,
  POLYGENIC_LOCI,
  TRAIT_CONFIG,
  TRAIT_KEYS,
  type TraitKey,
} from './quantitative.ts';
import { Rng } from './rng.ts';
import type { Genome, PedigreeStore, Pigeon, PhenotypeSummary } from './model.ts';

/** 从两个等位中等概率取一个 */
function transmit<T>(pair: readonly [T, T | null], rng: Rng): T {
  const [a, b] = pair;
  if (b === null) return a; // 半合子(雌 Z)只能传这一个
  return rng.chance(0.5) ? a : b;
}

/** 微效位点:给定亲本该位点增效计数(0/1/2),返回传给后代的增效计数 0/1 */
function transmitPlus(parentCount: number, rng: Rng): number {
  if (parentCount === 0) return 0;
  if (parentCount === 2) return 1;
  return rng.chance(0.5) ? 1 : 0;
}

/** 有害位点同理:计数 2 必传 1,计数 0 必传 0,杂合随机 */
function transmitHarmful(parentCount: number, rng: Rng): number {
  return transmitPlus(parentCount, rng);
}

export interface MatingInput {
  sire: Pigeon;
  dam: Pigeon;
  rng: Rng;
  /** 预计算的后代近交系数 F(避免重复计算);省略则现场按全谱系计算 */
  inbreeding?: number;
  generation?: number;
  id?: number;
  ringId?: string;
  /**
   * 批量模拟热路径:跳过 mate 内的表型结算,由调用方在补齐编号后统一结算,
   * 避免同一基因组重复计算两次。省略时正常结算。
   */
  deferPhenotype?: boolean;
}

/**
 * 执行一次配种,生成后代(含基因组与表型),但不写入谱系库。
 */
export function mate(input: MatingInput): Pigeon {
  const { sire, dam, rng } = input;
  if (sire.sex !== 'M' || dam.sex !== 'F') {
    throw new Error('配种需要一雄一雌:父本必须为雄性、母本必须为雌性');
  }

  // 性别:父方永远给 Z;母方 Z/W 各半
  const sex: Sex = rng.chance(0.5) ? 'M' : 'F';

  const genome = buildOffspringGenome(sire.genome, dam.genome, sex, rng);
  const inbreeding =
    input.inbreeding ?? computeInbreedingExternal(sire, dam);
  const envNoise = {} as Record<TraitKey, number>;
  for (const trait of TRAIT_KEYS) {
    envNoise[trait] = rng.gaussian(0, environmentalSd(trait));
  }
  const generation = input.generation ?? Math.max(sire.generation, dam.generation) + 1;
  const id = input.id ?? -1;
  const ringId = input.ringId ?? `OFF-${generation}-${id >= 0 ? id : 'X'}`;

  const phenotype = input.deferPhenotype
    ? // 占位,调用方稍后用 expressPhenotype 重算
      {
        speed: 0,
        stamina: 0,
        homing: 0,
        harmfulLoad: 0,
        colorName: '',
        colorCode: '',
      }
    : expressPhenotype(genome, sex, inbreeding, envNoise);
  return {
    id,
    ringId,
    sex,
    generation,
    sireId: sire.id,
    damId: dam.id,
    genome,
    inbreeding,
    phenotype,
    envNoise,
  };
}

/** 测试/独立调用场景下的近交计算兜底(正式流程由调用方注入) */
function computeInbreedingExternal(sire: Pigeon, dam: Pigeon): number {
  // 无 store 句柄时,个体自带的 inbreeding 字段无法直接推出双亲共祖,
  // 因此该兜底仅在「不关心 F 的隔离测试」里出现;生产路径始终注入。
  void sire;
  void dam;
  return 0;
}

export function buildOffspringGenome(
  sireGenome: Genome,
  damGenome: Genome,
  offspringSex: Sex,
  rng: Rng,
): Genome {
  // ---- Z 连锁基础色 ----
  const sireBase = transmit(sireGenome.color.base, rng); // 父 Z 上的等位
  let base: ColorGenotype['base'];
  if (offspringSex === 'M') {
    // 儿子:父 Z + 母 Z
    base = [sireBase, transmit(damGenome.color.base, rng)];
  } else {
    // 女儿:父 Z + 母 W(W 不带该位点)→ 半合子
    base = [sireBase, null];
  }

  const color: ColorGenotype = {
    base,
    pattern: [
      transmit(sireGenome.color.pattern, rng),
      transmit(damGenome.color.pattern, rng),
    ],
    spread: [
      transmit(sireGenome.color.spread, rng),
      transmit(damGenome.color.spread, rng),
    ],
    recessiveRed: [
      transmit(sireGenome.color.recessiveRed, rng),
      transmit(damGenome.color.recessiveRed, rng),
    ],
    dilute: [
      transmit(sireGenome.color.dilute, rng),
      transmit(damGenome.color.dilute, rng),
    ],
    grizzle: [
      transmit(sireGenome.color.grizzle, rng),
      transmit(damGenome.color.grizzle, rng),
    ],
  };

  const polygenic = {} as Record<TraitKey, Uint8Array>;
  for (const trait of TRAIT_KEYS) {
    const counts = new Uint8Array(POLYGENIC_LOCI);
    for (let i = 0; i < POLYGENIC_LOCI; i++) {
      counts[i] =
        transmitPlus(sireGenome.polygenic[trait][i]!, rng) +
        transmitPlus(damGenome.polygenic[trait][i]!, rng);
    }
    polygenic[trait] = counts;
  }

  const harmful = new Uint8Array(LETHAL_LOCI);
  for (let i = 0; i < LETHAL_LOCI; i++) {
    harmful[i] =
      transmitHarmful(sireGenome.harmful[i]!, rng) +
      transmitHarmful(damGenome.harmful[i]!, rng);
  }

  return { color, polygenic, harmful };
}

/** 表型结算:数量性状 + 遗传负荷 + 羽色 */
export function expressPhenotype(
  genome: Genome,
  sex: Sex,
  inbreeding: number,
  envNoise: Record<TraitKey, number>,
): PhenotypeSummary {
  // 直接遍历 TypedArray,避免展开产生临时数组
  let load = 0;
  for (let i = 0; i < genome.harmful.length; i++) {
    if (genome.harmful[i] === 2) load++;
  }
  const colorPheno = expressColor(genome.color, sex);

  const out = {
    speed: 0,
    stamina: 0,
    homing: 0,
    harmfulLoad: load,
    colorName: colorPheno.name,
    colorCode: colorPheno.code,
  };
  for (const trait of TRAIT_KEYS) {
    const counts = genome.polygenic[trait];
    let plusCount = 0;
    for (let i = 0; i < counts.length; i++) plusCount += counts[i]!;
    let value = phenotypeValue(trait, plusCount, inbreeding, envNoise[trait]!);
    value -= load * HARMFUL_PENALTY_PER_LOCUS;
    const cfg = TRAIT_CONFIG[trait];
    value = Math.min(cfg.max, Math.max(cfg.min, value));
    out[trait] = round1(value);
  }
  return out;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ---------------------------------------------------------------- 基础群

export interface FoundingOptions {
  /** 基础群规模(雌雄各半或尽量接近) */
  size: number;
  rng: Rng;
  startId?: number;
  ringPrefix?: string;
}

/**
 * 建立哈迪–温伯格平衡的奠基群:
 *  - 羽色各位点等位按固定初始频率随机抽取;
 *  - 微效位点增效等位频率 0.5(遗传方差与配置 σ_A 自洽);
 *  - 有害位点稀有隐性(q=0.02),几乎全为携带者;
 *  - 奠基者 F=0、无亲本。
 */
export function createFoundingPopulation(options: FoundingOptions): Pigeon[] {
  const { size, rng } = options;
  const startId = options.startId ?? 1;
  const prefix = options.ringPrefix ?? 'CHN-2026';
  const pigeons: Pigeon[] = [];

  for (let k = 0; k < size; k++) {
    const id = startId + k;
    const sex: Sex = k % 2 === 0 ? 'M' : 'F';
    const genome = randomFounderGenome(sex, rng);
    const envNoise = {} as Record<TraitKey, number>;
    for (const trait of TRAIT_KEYS) {
      envNoise[trait] = rng.gaussian(0, environmentalSd(trait));
    }
    const phenotype = expressPhenotype(genome, sex, 0, envNoise);
    pigeons.push({
      id,
      ringId: `${prefix}-${String(id).padStart(6, '0')}`,
      sex,
      generation: 0,
      sireId: null,
      damId: null,
      genome,
      inbreeding: 0,
      phenotype,
      envNoise,
    });
  }
  return pigeons;
}

/** 奠基群羽色等位频率(可按运营需求调整) */
const FOUNDER_ALLELE_FREQ = {
  base: { ASH_RED: 0.12, BLUE: 0.78, BROWN: 0.1 },
  pattern: { T_PATTERN: 0.18, CHECK: 0.4, BAR: 0.35, BARLESS: 0.07 },
  spread: 0.12,
  recessiveRed: 0.08,
  dilute: 0.1,
  grizzle: 0.09,
  /** 有害隐性等位频率 q */
  harmfulQ: 0.02,
};

function drawFromFreq<T extends string>(
  freq: Record<T, number>,
  rng: Rng,
): T {
  const roll = rng.next();
  let acc = 0;
  for (const allele of Object.keys(freq) as T[]) {
    acc += freq[allele]!;
    if (roll < acc) return allele;
  }
  return Object.keys(freq).pop() as T;
}

function randomFounderGenome(sex: Sex, rng: Rng): Genome {
  const base: ColorGenotype['base'] =
    sex === 'F'
      ? [drawFromFreq(FOUNDER_ALLELE_FREQ.base, rng), null]
      : [
          drawFromFreq(FOUNDER_ALLELE_FREQ.base, rng),
          drawFromFreq(FOUNDER_ALLELE_FREQ.base, rng),
        ];

  const drawPair = <T extends string>(freq: Record<T, number>): [T, T] => [
    drawFromFreq(freq, rng),
    drawFromFreq(freq, rng),
  ];
  const drawBinary = <T extends string>(wild: T, mut: T, q: number): [T, T] => [
    rng.chance(q) ? mut : wild,
    rng.chance(q) ? mut : wild,
  ];

  const color: ColorGenotype = {
    base,
    pattern: drawPair(FOUNDER_ALLELE_FREQ.pattern),
    spread: drawBinary(SPREAD_ALLELES[1]!, SPREAD_ALLELES[0]!, FOUNDER_ALLELE_FREQ.spread),
    recessiveRed: drawBinary(
      REC_RED_ALLELES[0]!,
      REC_RED_ALLELES[1]!,
      FOUNDER_ALLELE_FREQ.recessiveRed,
    ),
    dilute: drawBinary(DILUTE_ALLELES[0]!, DILUTE_ALLELES[1]!, FOUNDER_ALLELE_FREQ.dilute),
    grizzle: drawBinary(
      GRIZZLE_ALLELES[1]!,
      GRIZZLE_ALLELES[0]!,
      FOUNDER_ALLELE_FREQ.grizzle,
    ),
  };

  const polygenic = {} as Record<TraitKey, Uint8Array>;
  for (const trait of TRAIT_KEYS) {
    const counts = new Uint8Array(POLYGENIC_LOCI);
    for (let i = 0; i < POLYGENIC_LOCI; i++) {
      // p=0.5:每个亲本等位独立,计数 ~ Binom(2,0.5)
      counts[i] = (rng.chance(0.5) ? 1 : 0) + (rng.chance(0.5) ? 1 : 0);
    }
    polygenic[trait] = counts;
  }

  const harmful = new Uint8Array(LETHAL_LOCI);
  for (let i = 0; i < LETHAL_LOCI; i++) {
    harmful[i] =
      (rng.chance(FOUNDER_ALLELE_FREQ.harmfulQ) ? 1 : 0) +
      (rng.chance(FOUNDER_ALLELE_FREQ.harmfulQ) ? 1 : 0);
  }

  return { color, polygenic, harmful };
}

// ---------------------------------------------------------------- 工具

/** 个体某性状的增效等位总数(0..20),供选择指数与展示 */
export function plusCountOf(pigeon: Pigeon, trait: TraitKey): number {
  return [...pigeon.genome.polygenic[trait]].reduce((a, b) => a + b, 0);
}

/** 理论育种值 A(无环境、无近交部分),配对预测用 */
export function breedingValueOf(pigeon: Pigeon, trait: TraitKey): number {
  return (plusCountOf(pigeon, trait) - POLYGENIC_LOCI) * alleleEffect(trait);
}

/** 供外部显式按 store 计算 F 的便捷封装 */
export function settleInbreeding(store: PedigreeStore, pigeonId: number): number {
  return inbreedingCoefficient(store, pigeonId);
}

export { BASE_ALLELES, PATTERN_ALLELES };
