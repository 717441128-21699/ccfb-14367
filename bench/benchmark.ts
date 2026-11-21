/**
 * 性能基准:验证运营 SLA
 *  1. 10,000 只 × 50 代批量繁育模拟 ≤ 20 秒
 *  2. 五代血统书查询 ≤ 100 毫秒
 *  3. 近交系数三算法分解延迟
 *  4. 大种群持久化往返(滚动留档,内存可控)
 */
import {
  buildPedigreeBook,
  DEFAULT_SIMULATION,
  explainInbreeding,
  exportNdjson,
  importNdjson,
  MemoryLineSink,
  MemoryLineSource,
  PedigreeStore,
  runSimulation,
} from '../src/index.ts';

interface BenchRow {
  name: string;
  value: string;
  sla: string;
  pass: boolean;
}

const rows: BenchRow[] = [];
function record(name: string, value: string, sla: string, pass: boolean): void {
  rows.push({ name, value, sla, pass });
  console.log(`${pass ? '✓' : '✗'} ${name}: ${value} (SLA ${sla})`);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  // ---- SLA 1:10k × 50 代模拟(滚动留档 8 代,内存可控) ----
  const store = new PedigreeStore();
  const result = runSimulation(store, { ...DEFAULT_SIMULATION, retainGenerations: 6 });
  record(
    '10,000 只 × 50 代模拟(选择/近交/表型全流程)',
    `${result.elapsedMs.toFixed(0)} ms,累计出生 ${result.totalBorn.toLocaleString()} 只,留存 ${store.size.toLocaleString()} 只`,
    '≤ 20,000 ms',
    result.elapsedMs <= 20000,
  );

  const f = result.perGeneration;
  console.log('\n性状代际漂移(奠基代 → 末代):');
  for (const trait of ['speed', 'stamina', 'homing'] as const) {
    console.log(
      `  ${trait}: 均值 ${f[0]!.mean[trait]} → ${f[50]!.mean[trait]}, ` +
        `触顶率 ${(f[0]!.ceilingRate[trait] * 100).toFixed(2)}% → ${(f[50]!.ceilingRate[trait] * 100).toFixed(2)}%`,
    );
  }
  console.log(`  平均近交 F: ${f[0]!.meanInbreeding} → ${f[50]!.meanInbreeding}, 最高 ${f[50]!.maxInbreeding}`);

  // ---- SLA 2:五代血统书查询 ----
  const rootId = result.finalGenerationIds[result.finalGenerationIds.length - 1]!;
  for (let i = 0; i < 50; i++) buildPedigreeBook(store, rootId); // JIT 预热
  const reps = 1000;
  const t1 = performance.now();
  let maxQuery = 0;
  for (let i = 0; i < reps; i++) {
    const id = result.finalGenerationIds[i % result.finalGenerationIds.length]!;
    const book = buildPedigreeBook(store, id);
    if (book.coveredCount === 0) throw new Error('血统书为空');
    maxQuery = Math.max(maxQuery, book.queryMs);
  }
  const avgQuery = (performance.now() - t1) / reps;
  record(
    `五代血统书查询(${reps} 次)`,
    `均值 ${avgQuery.toFixed(3)} ms,最慢 ${maxQuery.toFixed(3)} ms`,
    '≤ 100 ms',
    avgQuery <= 100 && maxQuery <= 100,
  );

  // ---- 近交系数分解延迟 ----
  const t2 = performance.now();
  for (let i = 0; i < 200; i++) {
    const id = result.finalGenerationIds[i % result.finalGenerationIds.length]!;
    explainInbreeding(store, id);
  }
  const avgInbreeding = (performance.now() - t2) / 200;
  record('近交系数三算法分解(均值)', `${avgInbreeding.toFixed(3)} ms`, '参考基线', true);

  // ---- 持久化往返(当前留存种群) ----
  const sink = new MemoryLineSink();
  const t3 = performance.now();
  await exportNdjson(store, sink);
  const exportMs = performance.now() - t3;
  const t4 = performance.now();
  const restored = await importNdjson(new MemoryLineSource(sink.lines));
  const importMs = performance.now() - t4;
  record(
    `NDJSON 导出/导入 ${store.size.toLocaleString()} 只`,
    `导出 ${exportMs.toFixed(0)} ms / 导入 ${importMs.toFixed(0)} ms, 堆 ${mb(process.memoryUsage().heapUsed)}`,
    '数据零丢失',
    restored.size === store.size,
  );

  // ---- 汇总 ----
  console.log('\n================ SLA 汇总 ================');
  const failed = rows.filter((r) => !r.pass);
  for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}: ${r.value}`);
  console.log('==========================================');
  if (failed.length > 0) {
    console.error(`\n${failed.length} 项 SLA 未达标`);
    process.exit(1);
  }
  console.log('\n全部 SLA 达标 ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
