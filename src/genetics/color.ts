/**
 * 羽色基因型 → 表现型。
 * 位点互作层级:隐性红 ee(覆盖基础色)→ Spread 黑化 → 基础色 + 纹样 → 稀释 → 石斑。
 */
import {
  BASE_DOMINANCE,
  PATTERN_DOMINANCE,
  type BaseAllele,
  type ColorGenotype,
  type PatternAllele,
  type Sex,
} from './loci.ts';

export interface ColorPhenotype {
  /** 内部稳定标识,可用于统计分组 */
  code: string;
  /** 中文羽色名,如「绛雨点」「深斑黑」「银灰无杠」 */
  name: string;
  /** 基础色表现 */
  baseColor: 'red' | 'blue' | 'brown';
  /** 是否黑羽覆盖 */
  spread: boolean;
  /** 是否隐性红 */
  recessiveRed: boolean;
  /** 是否稀释表现 */
  diluted: boolean;
  /** 石斑等级 0/1/2 */
  grizzleLevel: 0 | 1 | 2;
}

function dominantBase(geno: ColorGenotype, sex: Sex): BaseAllele {
  const [a, b] = geno.base;
  if (sex === 'F' || b === null) return a;
  return BASE_DOMINANCE[a] >= BASE_DOMINANCE[b] ? a : b;
}

function dominantPattern(geno: ColorGenotype): PatternAllele {
  const [a, b] = geno.pattern;
  return PATTERN_DOMINANCE[a] >= PATTERN_DOMINANCE[b] ? a : b;
}

const BASE_NAME: Record<'red' | 'blue' | 'brown', string> = {
  red: '绛',
  blue: '',
  brown: '褐',
};

const PATTERN_NAME: Record<PatternAllele, string> = {
  T_PATTERN: '深雨点',
  CHECK: '雨点',
  BAR: '灰杠',
  BARLESS: '无杠',
};

/** 稀释后的基础色调称呼 */
const DILUTED_BASE_NAME: Record<'red' | 'blue' | 'brown', string> = {
  red: '银绛',
  blue: '银灰',
  brown: '浅褐',
};

export function expressColor(geno: ColorGenotype, sex: Sex): ColorPhenotype {
  const base = dominantBase(geno, sex);
  const baseColor: ColorPhenotype['baseColor'] =
    base === 'ASH_RED' ? 'red' : base === 'BROWN' ? 'brown' : 'blue';

  const spread = geno.spread[0] === 'S' || geno.spread[1] === 'S';
  const recessiveRed = geno.recessiveRed[0] === 'e' && geno.recessiveRed[1] === 'e';
  const diluted = geno.dilute[0] === 'd' && geno.dilute[1] === 'd';
  const grizzleCount =
    (geno.grizzle[0] === 'G' ? 1 : 0) + (geno.grizzle[1] === 'G' ? 1 : 0);
  const grizzleLevel = grizzleCount as 0 | 1 | 2;
  const pattern = dominantPattern(geno);

  let name: string;
  if (recessiveRed) {
    // 隐性红覆盖基础色与纹样,稀释下呈奶油色
    name = diluted ? '奶油隐性红' : '隐性红';
  } else if (spread) {
    // 黑羽覆盖纹样;基础色仍影响色调(红底黑羽呈古铜、褐底呈深棕)
    const tone = baseColor === 'red' ? '古铜黑' : baseColor === 'brown' ? '深棕' : '黑';
    name = diluted ? `淡${tone}` : tone;
  } else {
    const basePart = diluted
      ? DILUTED_BASE_NAME[baseColor]
      : `${BASE_NAME[baseColor]}${PATTERN_NAME[pattern]}`;
    name = diluted && baseColor === 'blue'
      ? `${DILUTED_BASE_NAME.blue}${PATTERN_NAME[pattern]}`
      : basePart;
  }
  if (grizzleLevel === 1) name = `石斑${name}`;
  if (grizzleLevel === 2) name = `重石斑(${name})`;

  return {
    code: `${baseColor}-${pattern}-${spread ? 'S' : 's'}-${recessiveRed ? 'e' : 'E'}-${
      diluted ? 'd' : 'D'
    }-g${grizzleLevel}`,
    name,
    baseColor,
    spread,
    recessiveRed,
    diluted,
    grizzleLevel,
  };
}
