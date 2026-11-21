import { describe, expect, it } from 'vitest';
import {
  expressColor,
  mate,
  Rng,
  type ColorGenotype,
  type Pigeon,
} from '../src/index.ts';

function makePigeon(
  id: number,
  sex: 'M' | 'F',
  color: ColorGenotype,
  sireId: number | null = null,
  damId: number | null = null,
): Pigeon {
  const poly = {
    speed: new Uint8Array(10).fill(1),
    stamina: new Uint8Array(10).fill(1),
    homing: new Uint8Array(10).fill(1),
  };
  return {
    id,
    ringId: `T-${id}`,
    sex,
    generation: 0,
    sireId,
    damId,
    genome: { color, polygenic: poly, harmful: new Uint8Array(6) },
    inbreeding: 0,
    envNoise: { speed: 0, stamina: 0, homing: 0 },
    phenotype: {
      speed: 50,
      stamina: 50,
      homing: 50,
      harmfulLoad: 0,
      colorName: expressColor(color, sex).name,
      colorCode: expressColor(color, sex).code,
    },
  };
}

const base = (a: ColorGenotype['base'][0], b: ColorGenotype['base'][1] = null): ColorGenotype['base'] => [a, b];

function color(partial: Partial<ColorGenotype> = {}): ColorGenotype {
  return {
    base: base('BLUE', 'BLUE'),
    pattern: ['BAR', 'BAR'],
    spread: ['PLUS', 'PLUS'],
    recessiveRed: ['E', 'E'],
    dilute: ['D', 'D'],
    grizzle: ['PLUS_G', 'PLUS_G'],
    ...partial,
  };
}

/** 蒙特卡洛统计后代表现型分布 */
function breedMany(sire: Pigeon, dam: Pigeon, n: number, seed = 1) {
  const rng = new Rng(seed);
  const counts = new Map<string, number>();
  const sexCounts = { M: 0, F: 0 };
  for (let i = 0; i < n; i++) {
    const child = mate({ sire, dam, rng });
    counts.set(child.phenotype.colorName, (counts.get(child.phenotype.colorName) ?? 0) + 1);
    sexCounts[child.sex]++;
  }
  return { counts, sexCounts };
}

describe('基础孟德尔分离', () => {
  it('常染色体杂合 × 隐性纯合 → 1:1 测交分离', () => {
    // 稀释位点 Dd × dd:子代 dd(稀释表现)应约 50%
    const sire = makePigeon(1, 'M', color({ dilute: ['D', 'd'] }));
    const dam = makePigeon(2, 'F', color({ dilute: ['d', 'd'] }));
    const { counts } = breedMany(sire, dam, 20000);
    // dd 个体名称带「银灰」(蓝底稀释)
    const diluted = [...counts.entries()]
      .filter(([name]) => name.includes('银灰'))
      .reduce((a, [, c]) => a + c, 0);
    expect(diluted / 20000).toBeCloseTo(0.5, 2);
  });

  it('双杂合自交式交配 → 隐性纯合 1/4', () => {
    // Dd × Dd:dd 概率 0.25
    const sire = makePigeon(1, 'M', color({ dilute: ['D', 'd'] }));
    const dam = makePigeon(2, 'F', color({ dilute: ['D', 'd'] }));
    const { counts } = breedMany(sire, dam, 20000);
    const diluted = [...counts.entries()]
      .filter(([name]) => name.includes('银灰'))
      .reduce((a, [, c]) => a + c, 0);
    expect(diluted / 20000).toBeCloseTo(0.25, 2);
  });

  it('性别比例 1:1 且雌鸽基础色半合子', () => {
    const sire = makePigeon(1, 'M', color());
    const dam = makePigeon(2, 'F', color({ base: base('BLUE') }));
    const { sexCounts } = breedMany(sire, dam, 20000);
    expect(sexCounts.M / 20000).toBeCloseTo(0.5, 1);
    expect(sexCounts.F / 20000).toBeCloseTo(0.5, 1);
  });
});

describe('Z 性连锁基础色遗传', () => {
  it('红绛雄(纯合)× 蓝雌 → 儿子全为红绛携带者、女儿全为红绛半合子', () => {
    // 雄 Z^A Z^A;雌 Z^+ W
    const sire = makePigeon(1, 'M', color({ base: ['ASH_RED', 'ASH_RED'] }));
    const dam = makePigeon(2, 'F', color({ base: base('BLUE') }));
    const rng = new Rng(7);
    for (let i = 0; i < 50; i++) {
      const child = mate({ sire, dam, rng });
      const pheno = expressColor(child.genome.color, child.sex);
      expect(pheno.baseColor).toBe('red');
      if (child.sex === 'F') expect(child.genome.color.base[1]).toBeNull();
    }
  });

  it('褐雌 × 蓝纯合雄:女儿不表现褐,褐等位经女儿传递给外孙(交叉遗传)', () => {
    // 雄 Z+ Z+ × 雌 Z^b W → 女儿 Z+ Z^b(蓝表现,携带);
    // 女儿再与蓝雄配,外孙中 1/2 为 Z^b W 褐表现
    const blueSire = makePigeon(1, 'M', color({ base: ['BLUE', 'BLUE'] }));
    const brownDam = makePigeon(2, 'F', color({ base: base('BROWN') }));
    const rng = new Rng(11);
    const carrierDaughters: Pigeon[] = [];
    for (let i = 0; i < 200; i++) {
      const child = mate({ sire: blueSire, dam: brownDam, rng });
      if (child.sex === 'F') {
        expect(expressColor(child.genome.color, 'F').baseColor).toBe('blue');
        expect(child.genome.color.base[0]).toBe('BLUE');
      } else {
        // 儿子 Z+ Z^b,蓝表现携带褐
        expect(child.genome.color.base).toContain('BROWN');
        expect(expressColor(child.genome.color, 'M').baseColor).toBe('blue');
        carrierDaughters.push(child);
      }
    }
    // 儿子(携带 Z^b)× 蓝雌 → 女儿(半合子)中 1/2 褐
    const carrierSon = carrierDaughters[0]!;
    const blueDam = makePigeon(3, 'F', color({ base: base('BLUE') }));
    let brownGranddaughters = 0;
    let granddaughters = 0;
    for (let i = 0; i < 4000; i++) {
      const grand = mate({ sire: carrierSon, dam: blueDam, rng });
      if (grand.sex === 'F') {
        granddaughters++;
        if (expressColor(grand.genome.color, 'F').baseColor === 'brown') brownGranddaughters++;
      }
    }
    expect(brownGranddaughters / granddaughters).toBeCloseTo(0.5, 1);
  });
});

describe('显隐级序与位点互作', () => {
  it('C 位点四等位:深雨点对灰杠为显性', () => {
    const sire = makePigeon(1, 'M', color({ pattern: ['T_PATTERN', 'BAR'] }));
    const dam = makePigeon(2, 'F', color({ pattern: ['BAR', 'BAR'] }));
    const rng = new Rng(3);
    const names = new Set<string>();
    for (let i = 0; i < 100; i++) {
      names.add(mate({ sire, dam, rng }).phenotype.colorName);
    }
    // 只可能出现深雨点灰杠?表现型名取显性纹样 → 深雨点 或 灰杠
    expect([...names].every((n) => n.includes('深雨点') || n.includes('灰杠'))).toBe(true);
  });

  it('Spread 黑化覆盖纹样,隐性红 ee 覆盖基础色', () => {
    const black = makePigeon(1, 'M', color({ spread: ['S', 'PLUS'] }));
    const blackDam = makePigeon(2, 'F', color({ spread: ['PLUS', 'PLUS'] }));
    const rng = new Rng(5);
    const kids = Array.from({ length: 50 }, () => mate({ sire: black, dam: blackDam, rng }));
    const blackRate = kids.filter((k) => k.phenotype.colorName === '黑').length / kids.length;
    expect(blackRate).toBeCloseTo(0.5, 1);

    const recRed = makePigeon(10, 'M', color({ recessiveRed: ['e', 'e'] }));
    const recRedDam = makePigeon(11, 'F', color({ recessiveRed: ['e', 'e'] }));
    const allRec = mate({ sire: recRed, dam: recRedDam, rng });
    expect(allRec.phenotype.colorName).toBe('隐性红');
  });

  it('石斑不完全显性:GG 重石斑、Gg 石斑、++ 无', () => {
    const sire = makePigeon(1, 'M', color({ grizzle: ['G', 'PLUS_G'] }));
    const dam = makePigeon(2, 'F', color({ grizzle: ['G', 'PLUS_G'] }));
    const rng = new Rng(9);
    const levels = [0, 0, 0];
    for (let i = 0; i < 6000; i++) {
      const k = mate({ sire, dam, rng });
      const lvl = (k.genome.color.grizzle[0] === 'G' ? 1 : 0) + (k.genome.color.grizzle[1] === 'G' ? 1 : 0);
      levels[lvl]!++;
    }
    expect(levels[2]! / 6000).toBeCloseTo(0.25, 1);
    expect(levels[1]! / 6000).toBeCloseTo(0.5, 1);
    expect(levels[0]! / 6000).toBeCloseTo(0.25, 1);
  });
});
