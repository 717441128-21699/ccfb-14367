/**
 * 血统数据持久化仓储。
 *
 * 提供两种落盘形态:
 *  - JSON 快照(中小种群,一次加载):带版本号与计数校验;
 *  - NDJSON 流式(几十万级大种群):逐行写、逐行读,内存占用恒定;
 *    Web 端用 Blob/File,Node 端用 node:fs,本模块只依赖字符串行接口,
 *    两端各自适配 IO。
 */
import { PedigreeStore, type Snapshot } from '../genetics/model.ts';

export interface LineSink {
  writeLine(line: string): void;
  close(): Promise<void> | void;
}

export interface LineSource {
  readLines(): AsyncIterable<string>;
}

export const SNAPSHOT_MAGIC = 'PIGEON-PEDIGREE-V1';

interface SnapshotEnvelope extends Snapshot {
  magic: string;
}

export function snapshotToJson(store: PedigreeStore): string {
  const envelope: SnapshotEnvelope = { magic: SNAPSHOT_MAGIC, ...store.toJSON() };
  return JSON.stringify(envelope);
}

export function snapshotFromJson(text: string): PedigreeStore {
  const parsed = JSON.parse(text) as Partial<SnapshotEnvelope>;
  if (parsed.magic !== SNAPSHOT_MAGIC) {
    throw new Error('快照格式不匹配:magic 校验失败,拒绝加载非本系统血统文件');
  }
  if (parsed.version !== 1) throw new Error(`不支持的快照版本:${parsed.version}`);
  if (!Array.isArray(parsed.pigeons) || typeof parsed.nextId !== 'number') {
    throw new Error('快照内容不完整:缺少 pigeons/nextId');
  }
  const store = PedigreeStore.fromJSON(parsed as Snapshot);
  if (store.size !== parsed.pigeons.length) {
    throw new Error('快照计数校验失败:存在重复 id 或环号');
  }
  return store;
}

/** 流式导出 NDJSON,首行为清单头(含 magic 与条数) */
export async function exportNdjson(store: PedigreeStore, sink: LineSink): Promise<void> {
  sink.writeLine(JSON.stringify({ magic: SNAPSHOT_MAGIC, kind: 'header', count: store.size }));
  for (const line of store.toNdjsonLines()) {
    sink.writeLine(line);
  }
  await sink.close();
}

export async function importNdjson(source: LineSource): Promise<PedigreeStore> {
  const lines: string[] = [];
  let header: { magic?: string; count?: number } | null = null;
  for await (const line of source.readLines()) {
    if (!line.trim()) continue;
    if (!header) {
      header = JSON.parse(line) as { magic?: string; count?: number };
      if (header.magic !== SNAPSHOT_MAGIC) {
        throw new Error('NDJSON 格式不匹配:magic 校验失败');
      }
      continue;
    }
    lines.push(line);
  }
  if (header?.count !== undefined && header.count !== lines.length) {
    throw new Error(`NDJSON 条数校验失败:清单 ${header.count},实际 ${lines.length}`);
  }
  return PedigreeStore.fromNdjson(lines);
}

// ---- 内存实现(测试与浏览器 Blob 适配共用) -------------------------------

export class MemoryLineSink implements LineSink {
  readonly lines: string[] = [];
  writeLine(line: string): void {
    this.lines.push(line);
  }
  close(): void {}
}

export class MemoryLineSource implements LineSource {
  constructor(private readonly lines: string[]) {}
  async *readLines(): AsyncIterable<string> {
    for (const line of this.lines) yield line;
  }
}
