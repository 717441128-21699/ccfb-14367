/**
 * 羽色基因位点定义(参照家鸽真实羽色遗传体系)。
 *
 * 六个位点:
 *  1. base   — Z 性连锁基础色:红绛 ASH_RED > 蓝 BLUE > 褐 BROWN(雌鸽半合子)
 *  2. pattern— 常染色体 C 位点四等位显隐级序:T_PATTERN(深雨点)> CHECK(雨点)> BAR(灰杠)> BARLESS(无杠)
 *  3. spread — 黑羽覆盖:显性 S > 野生型 +
 *  4. recessiveRed — 隐性红 e:纯合 ee 时覆盖基础色表现
 *  5. dilute — 稀释:隐性 d,纯合 dd 时整体淡化
 *  6. grizzle— 石斑:不完全显性,Gg 石斑、GG 重石斑(近白)
 *
 * 基因型一律用两位等位数组表示(性连锁位点的雌鸽第二位为 null)。
 */

export type Sex = 'M' | 'F';

/** 基础色等位基因(Z 连锁),显隐级序用 rank 表达,rank 越大越显性 */
export type BaseAllele = 'ASH_RED' | 'BLUE' | 'BROWN';
export const BASE_ALLELES: readonly BaseAllele[] = ['ASH_RED', 'BLUE', 'BROWN'];
/** 显性级序:ASH_RED=2 > BLUE=1 > BROWN=0 */
export const BASE_DOMINANCE: Record<BaseAllele, number> = {
  ASH_RED: 2,
  BLUE: 1,
  BROWN: 0,
};

export type PatternAllele = 'T_PATTERN' | 'CHECK' | 'BAR' | 'BARLESS';
export const PATTERN_ALLELES: readonly PatternAllele[] = [
  'T_PATTERN',
  'CHECK',
  'BAR',
  'BARLESS',
];
/** C 位点显隐级序:深雨点 3 > 雨点 2 > 灰杠 1 > 无杠 0 */
export const PATTERN_DOMINANCE: Record<PatternAllele, number> = {
  T_PATTERN: 3,
  CHECK: 2,
  BAR: 1,
  BARLESS: 0,
};

export type SpreadAllele = 'S' | 'PLUS';
export const SPREAD_ALLELES: readonly SpreadAllele[] = ['S', 'PLUS'];
export type RecRedAllele = 'E' | 'e';
export const REC_RED_ALLELES: readonly RecRedAllele[] = ['E', 'e'];
export type DiluteAllele = 'D' | 'd';
export const DILUTE_ALLELES: readonly DiluteAllele[] = ['D', 'd'];
export type GrizzleAllele = 'G' | 'PLUS_G';
export const GRIZZLE_ALLELES: readonly GrizzleAllele[] = ['G', 'PLUS_G'];

/**
 * 一只鸽子的完整羽色基因型。
 * 性连锁 base 位点:雄性两个等位,雌性一个(second 为 null)。
 */
export interface ColorGenotype {
  /** Z 连锁基础色 */
  base: [BaseAllele, BaseAllele | null];
  pattern: [PatternAllele, PatternAllele];
  spread: [SpreadAllele, SpreadAllele];
  recessiveRed: [RecRedAllele, RecRedAllele];
  dilute: [DiluteAllele, DiluteAllele];
  grizzle: [GrizzleAllele, GrizzleAllele];
}

/** 中文名称表,供 UI 与血统书展示 */
export const ALLELE_LABELS: Record<string, string> = {
  ASH_RED: '红绛 Bᴬ',
  BLUE: '蓝 B⁺',
  BROWN: '褐 b',
  T_PATTERN: '深雨点 Cᵀ',
  CHECK: '雨点 C',
  BAR: '灰杠 c⁺',
  BARLESS: '无杠 c',
  S: '黑羽 S',
  PLUS: '野生型 +',
  E: '正常 E',
  e: '隐性红 e',
  D: '浓 D',
  d: '稀释 d',
  G: '石斑 G',
  PLUS_G: '非石斑 +',
};
