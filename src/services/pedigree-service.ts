/**
 * 血统书应用服务:五代祖先树、近交系数路径分解、性能计时。
 * 纯查询逻辑,不碰 DOM,UI 与脚本共用。
 */
import {
  predictedOffspringInbreeding,
  wrightInbreeding,
  type WrightContribution,
} from '../genetics/inbreeding.ts';
import { ALLELE_LABELS } from '../genetics/loci.ts';
import type { PedigreeStore, Pigeon } from '../genetics/model.ts';
import { TRAIT_KEYS, TRAIT_LABELS, type TraitKey } from '../genetics/quantitative.ts';

export interface PedigreeTreeSlot {
  /** 在标准五代血统书中的槽位编号(根=1,父=2,母=3,父之父=4...) */
  slot: number;
  depth: number;
  pigeon: Pigeon | null;
  sireSlot: number | null;
  damSlot: number | null;
}

export interface PedigreeBook {
  root: Pigeon;
  /** slot → 节点;缺失祖先不出现在 Map 中 */
  slots: Map<number, PedigreeTreeSlot>;
  /** 实际覆盖到的祖先数量(含根) */
  coveredCount: number;
  /** 理论容量 63,缺失数量 */
  missingCount: number;
  /** 查询耗时毫秒(运营 100ms SLA 用) */
  queryMs: number;
}

const FIVE_GEN_CAPACITY = 63;

/**
 * 生成五代血统书槽位树。编号遵循标准谱系惯例:
 * 根 1;个体 i 的父槽 2i、母槽 2i+1。
 */
export function buildPedigreeBook(store: PedigreeStore, rootId: number): PedigreeBook {
  const started = performance.now();
  const root = store.get(rootId);
  if (!root) throw new Error(`血统书查询失败:个体 ${rootId} 不存在`);

  const slots = new Map<number, PedigreeTreeSlot>();
  const place = (pigeon: Pigeon, slot: number, depth: number): void => {
    const sireSlot = depth < 5 ? slot * 2 : null;
    const damSlot = depth < 5 ? slot * 2 + 1 : null;
    slots.set(slot, { slot, depth, pigeon, sireSlot, damSlot });
    if (depth >= 5) return;
    if (pigeon.sireId !== null) {
      const sire = store.get(pigeon.sireId);
      if (sire) place(sire, slot * 2, depth + 1);
    }
    if (pigeon.damId !== null) {
      const dam = store.get(pigeon.damId);
      if (dam) place(dam, slot * 2 + 1, depth + 1);
    }
  };
  place(root, 1, 0);

  return {
    root,
    slots,
    coveredCount: slots.size,
    missingCount: FIVE_GEN_CAPACITY - slots.size,
    queryMs: round3(performance.now() - started),
  };
}

export interface InbreedingBreakdown {
  /** 精确值(全谱系记忆化共祖) */
  coefficient: number;
  /** Wright 路径法结果(五代窗口) */
  wright: {
    coefficient: number;
    contributions: WrightContribution[];
  };
  /** 两算法差值(测试 SLA:|Δ| ≤ 1e-9,五代窗口外路径除外) */
  delta: number;
  computationMs: number;
}

export function explainInbreeding(
  store: PedigreeStore,
  rootId: number,
): InbreedingBreakdown {
  const started = performance.now();
  const cache = new Map<string, number>();
  const coefficient = coancestryFromRoot(store, rootId, cache);
  const wright = wrightInbreeding(store, rootId);
  return {
    coefficient: round9(coefficient),
    wright: {
      coefficient: round9(wright.inbreeding),
      contributions: wright.contributions
        .map((c) => ({ ...c, contribution: round9(c.contribution), ancestorInbreeding: round9(c.ancestorInbreeding) }))
        .sort((a, b) => b.contribution - a.contribution),
    },
    delta: round9(Math.abs(coefficient - wright.inbreeding)),
    computationMs: round3(performance.now() - started),
  };
}

function coancestryFromRoot(
  store: PedigreeStore,
  rootId: number,
  cache: Map<string, number>,
): number {
  const p = store.get(rootId);
  if (!p || p.sireId === null || p.damId === null) return 0;
  return predictedOffspringInbreeding(store, p.sireId, p.damId, cache);
}

/** 基因型的人类可读描述(血统书每个位点一栏) */
export function describeGenotype(pigeon: Pigeon): string[] {
  const g = pigeon.genome.color;
  const pair = (a: string, b: string | null): string =>
    b === null ? ALLELE_LABELS[a]! : `${ALLELE_LABELS[a]} / ${ALLELE_LABELS[b]}`;
  return [
    `基础色:${pair(g.base[0], g.base[1])}`,
    `纹样:${pair(g.pattern[0], g.pattern[1])}`,
    `黑羽:${pair(g.spread[0], g.spread[1])}`,
    `隐性红:${pair(g.recessiveRed[0], g.recessiveRed[1])}`,
    `稀释:${pair(g.dilute[0], g.dilute[1])}`,
    `石斑:${pair(g.grizzle[0], g.grizzle[1])}`,
  ];
}

export interface AncestorSummary {
  generation: number;
  count: number;
  traitAverages: Record<TraitKey, number | null>;
}

/** 逐代祖先汇总(选择配种参考) */
export function ancestorSummaries(store: PedigreeStore, rootId: number): AncestorSummary[] {
  const out: AncestorSummary[] = [];
  for (let depth = 0; depth <= 5; depth++) {
    const nodes = [...store.ancestors(rootId, depth).values()].filter((n) => n.depth === depth);
    const traitAverages = {} as Record<TraitKey, number | null>;
    for (const trait of TRAIT_KEYS) {
      traitAverages[trait] =
        nodes.length === 0
          ? null
          : round1(nodes.reduce((a, n) => a + n.pigeon.phenotype[trait], 0) / nodes.length);
    }
    out.push({ generation: depth, count: nodes.length, traitAverages });
  }
  return out;
}

export function traitLabel(trait: TraitKey): string {
  return TRAIT_LABELS[trait];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function round9(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
