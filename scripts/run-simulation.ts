/**
 * 端到端演示:程序化繁育测试种群 → 五代血统书 → 配对预测 → 近交校验。
 * 运行:npx tsx scripts/run-simulation.ts
 */
import {
  buildPedigreeBook,
  createFoundingPopulation,
  explainInbreeding,
  inbreedingCoefficient,
  mate,
  PedigreeStore,
  predictPairing,
  Rng,
  tabularInbreeding,
  TRAIT_KEYS,
  TRAIT_LABELS,
} from '../src/index.ts';

const store = new PedigreeStore();
const rng = new Rng(20261122);

// 1. 程序化生成 20 只奠基者(HWE 平衡)
const founders = createFoundingPopulation({ size: 20, rng });
for (const f of founders) store.add(f);
console.log(`① 奠基群:${founders.length} 只,羽色示例「${founders[0]!.phenotype.colorName}」`);

// 2. 封闭繁育 5 代,小群制造近交(每对固定生一雄一雌,保证不断代)
let current = founders;
let nextId = 21;
const breedSex = (sire: (typeof founders)[number], dam: (typeof founders)[number], sex: 'M' | 'F', gen: number) => {
  let child = mate({ sire, dam, rng, generation: gen });
  let guard = 0;
  while (child.sex !== sex && guard++ < 100) child = mate({ sire, dam, rng, generation: gen });
  child.id = nextId++;
  child.ringId = `DEMO-G${gen}-${child.id}`;
  store.add(child);
  return child;
};
for (let gen = 1; gen <= 5; gen++) {
  const males = current.filter((b) => b.sex === 'M');
  const females = current.filter((b) => b.sex === 'F');
  const offspring = [];
  for (let i = 0; i < Math.min(males.length, females.length); i++) {
    offspring.push(breedSex(males[i]!, females[i]!, 'M', gen));
    offspring.push(breedSex(males[i]!, females[i]!, 'F', gen));
  }
  current = offspring;
}
console.log(`② 封闭繁育 5 代后,谱系库共 ${store.size} 只`);

// 3. 近交算法交叉验证(列表法 vs 共祖递归)
const ordered = [...store.all()].map((p) => p.id);
const tabular = tabularInbreeding(store, ordered);
let maxDelta = 0;
for (const id of ordered) {
  const exact = inbreedingCoefficient(store, id, new Map());
  maxDelta = Math.max(maxDelta, Math.abs(exact - (tabular.get(id) ?? 0)));
}
console.log(`③ 近交系数:列表法 vs 共祖递归最大偏差 = ${maxDelta.toExponential(2)}(应≈0)`);

// 4. 末代个体五代血统书
const root = current[current.length - 1]!;
const book = buildPedigreeBook(store, root.id);
console.log(`④ ${root.ringId} 的五代血统书:覆盖 ${book.coveredCount}/63 槽位,查询 ${book.queryMs}ms`);

const breakdown = explainInbreeding(store, root.id);
console.log(`   近交 F = ${(breakdown.coefficient * 100).toFixed(3)}%,Wright 路径 ${breakdown.wright.contributions.length} 条`);

// 5. 配对预测
const sire = [...store.all()].find((p) => p.sex === 'M' && p.generation >= 4)!;
const dam = [...store.all()].find((p) => p.sex === 'F' && p.generation >= 4)!;
const report = predictPairing(store, sire.id, dam.id);
console.log(`⑤ 配对 ${sire.ringId} × ${dam.ringId}:`);
console.log(`   后代预期 F = ${(report.offspringInbreeding * 100).toFixed(2)}%`);
console.log(`   羽色 Top3: ${report.color.outcomes.slice(0, 3).map((o) => `${o.name} ${(o.probability * 100).toFixed(1)}%`).join(' / ')}`);
for (const t of TRAIT_KEYS) {
  const d = report.traits[t];
  console.log(
    `   ${TRAIT_LABELS[t]}: 均值 ${d.mean} ± ${d.sd},P5–P95 [${d.percentiles.p5}, ${d.percentiles.p95}],触顶 ${(d.ceilingProbability * 100).toFixed(1)}%`,
  );
}
console.log('\n演示完成 ✓');
