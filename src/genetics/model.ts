/**
 * 领域模型:鸽子个体、基因组、谱系存储。
 *
 * 存储设计面向「几十万只、谱系查询快」:
 *  - 主索引 Map<id, Pigeon>,鸽环号二级索引 Map<ringId, id>,均为 O(1)
 *  - 基因组用定长 TypedArray 存微效位点,避免对象膨胀
 *  - 提供版本化 JSON 快照与 NDJSON 流式导出/导入,保证血统数据可持久化不丢失
 */
import type { ColorGenotype, Sex } from './loci.ts';
import type { TraitKey } from './quantitative.ts';
export interface Genome {
  color: ColorGenotype;
  /** key=性状,value 为 10 个位点各自的增效等位计数(0/1/2) */
  polygenic: Record<TraitKey, Uint8Array>;
  /** 6 个有害位点各自的有害等位计数(0/1/2) */
  harmful: Uint8Array;
}

export interface PhenotypeSummary {
  speed: number;
  stamina: number;
  homing: number;
  /** 发病的有害位点数量 */
  harmfulLoad: number;
  /** 羽色表现型名称缓存 */
  colorName: string;
  colorCode: string;
}

export interface Pigeon {
  id: number;
  /** 鸽环号,业务唯一标识(如 CHN-2026-000123) */
  ringId: string;
  sex: Sex;
  /** 出生世代(基础群为 0) */
  generation: number;
  sireId: number | null;
  damId: number | null;
  genome: Genome;
  /** 近交系数 Wright F(0..1) */
  inbreeding: number;
  phenotype: PhenotypeSummary;
  /** 诞生时的环境偏差存档,便于审计复算 E = P - μ - A + bF */
  envNoise: Record<TraitKey, number>;
}

export interface PedigreeNode {
  pigeon: Pigeon;
  /** 相对查询个体的世代深度(0=个体本身,1=父母...) */
  depth: number;
  /** 父节点 id */
  sireId: number | null;
  damId: number | null;
}

export class PedigreeStore {
  private readonly byId = new Map<number, Pigeon>();
  private readonly byRing = new Map<string, number>();
  private nextId = 1;

  /** 仅供恢复快照时使用 */
  reset(nextId: number): void {
    this.byId.clear();
    this.byRing.clear();
    this.nextId = nextId;
  }

  allocId(): number {
    return this.nextId++;
  }

  add(pigeon: Pigeon): void {
    if (this.byId.has(pigeon.id)) throw new Error(`个体 id 重复:${pigeon.id}`);
    if (this.byRing.has(pigeon.ringId)) throw new Error(`鸽环号重复:${pigeon.ringId}`);
    this.byId.set(pigeon.id, pigeon);
    this.byRing.set(pigeon.ringId, pigeon.id);
  }

  get(id: number): Pigeon | undefined {
    return this.byId.get(id);
  }

  getOrThrow(id: number): Pigeon {
    const p = this.byId.get(id);
    if (!p) throw new Error(`谱系中不存在个体 id=${id}`);
    return p;
  }

  getByRing(ringId: string): Pigeon | undefined {
    const id = this.byRing.get(ringId);
    return id === undefined ? undefined : this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** 批量移除(模拟内存裁剪用)。返回实际删除条数 */
  removeMany(ids: readonly number[]): number {
    let removed = 0;
    for (const id of ids) {
      const p = this.byId.get(id);
      if (!p) continue;
      this.byId.delete(id);
      this.byRing.delete(p.ringId);
      removed++;
    }
    return removed;
  }

  all(): IterableIterator<Pigeon> {
    return this.byId.values();
  }

  /**
   * 向上查询 n 代祖先(含个体本身),BFS 截断重复节点。
   * 五代查询最多 2⁶-1=63 个节点;近交导致共同祖先重复出现时按 id 去重。
   * 返回 Map<id, PedigreeNode>,深度取最浅出现位置。
   */
  ancestors(rootId: number, depth: number): Map<number, PedigreeNode> {
    const result = new Map<number, PedigreeNode>();
    const root = this.byId.get(rootId);
    if (!root) return result;
    result.set(root.id, {
      pigeon: root,
      depth: 0,
      sireId: root.sireId,
      damId: root.damId,
    });
    let frontier = [rootId];
    for (let d = 1; d <= depth; d++) {
      const next: number[] = [];
      for (const pid of frontier) {
        const p = this.byId.get(pid);
        if (!p) continue;
        for (const parentId of [p.sireId, p.damId]) {
          if (parentId === null) continue;
          const parent = this.byId.get(parentId);
          if (!parent || result.has(parentId)) continue;
          result.set(parentId, {
            pigeon: parent,
            depth: d,
            sireId: parent.sireId,
            damId: parent.damId,
          });
          next.push(parentId);
        }
      }
      frontier = next;
    }
    return result;
  }

  /** 五代血统书:depth=5 */
  fiveGenPedigree(rootId: number): Map<number, PedigreeNode> {
    return this.ancestors(rootId, 5);
  }

  // ---- 持久化 ----------------------------------------------------------

  /** 紧凑 JSON 快照(TypedArray 展开为普通数组) */
  toJSON(): Snapshot {
    return {
      version: 1,
      nextId: this.nextId,
      pigeons: [...this.byId.values()].map(serializePigeon),
    };
  }

  static fromJSON(snapshot: Snapshot): PedigreeStore {
    const store = new PedigreeStore();
    store.reset(snapshot.nextId);
    for (const row of snapshot.pigeons) {
      store.add(deserializePigeon(row));
    }
    return store;
  }

  /** NDJSON 行序列化,适合大种群流式落盘 */
  toNdjsonLines(): string[] {
    return [...this.byId.values()].map((p) => JSON.stringify(serializePigeon(p)));
  }

  static fromNdjson(lines: Iterable<string>): PedigreeStore {
    const store = new PedigreeStore();
    let maxId = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const p = deserializePigeon(JSON.parse(trimmed) as PigeonRow);
      store.add(p);
      maxId = Math.max(maxId, p.id);
    }
    // 全部加入后再校准发号器;不能先 reset,否则会清空已加入的个体
    store.nextId = maxId + 1;
    return store;
  }
}

// ---- 序列化行格式(版本化) ---------------------------------------------

export interface Snapshot {
  version: number;
  nextId: number;
  pigeons: PigeonRow[];
}

interface PigeonRow {
  id: number;
  ringId: string;
  sex: Sex;
  generation: number;
  sireId: number | null;
  damId: number | null;
  inbreeding: number;
  envNoise: Record<TraitKey, number>;
  phenotype: PhenotypeSummary;
  genome: {
    color: ColorGenotype;
    polygenic: Record<TraitKey, number[]>;
    harmful: number[];
  };
}

function serializePigeon(p: Pigeon): PigeonRow {
  return {
    id: p.id,
    ringId: p.ringId,
    sex: p.sex,
    generation: p.generation,
    sireId: p.sireId,
    damId: p.damId,
    inbreeding: p.inbreeding,
    envNoise: p.envNoise,
    phenotype: p.phenotype,
    genome: {
      color: p.genome.color,
      polygenic: {
        speed: [...p.genome.polygenic.speed],
        stamina: [...p.genome.polygenic.stamina],
        homing: [...p.genome.polygenic.homing],
      },
      harmful: [...p.genome.harmful],
    },
  };
}

function deserializePigeon(row: PigeonRow): Pigeon {
  return {
    id: row.id,
    ringId: row.ringId,
    sex: row.sex,
    generation: row.generation,
    sireId: row.sireId,
    damId: row.damId,
    inbreeding: row.inbreeding,
    envNoise: { ...row.envNoise },
    phenotype: row.phenotype,
    genome: {
      color: row.genome.color,
      polygenic: {
        speed: Uint8Array.from(row.genome.polygenic.speed),
        stamina: Uint8Array.from(row.genome.polygenic.stamina),
        homing: Uint8Array.from(row.genome.polygenic.homing),
      },
      harmful: Uint8Array.from(row.genome.harmful),
    },
  };
}
