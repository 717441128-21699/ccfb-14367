/**
 * 前端共享应用状态:全局谱系库 + 示例种群引导 + 本地持久化。
 * 纯 TS,不依赖框架,各页面按需导入。
 */
import {
  createFoundingPopulation,
  expressPhenotype,
  mate,
  PedigreeStore,
  Rng,
  snapshotFromJson,
  snapshotToJson,
  type Pigeon,
} from '../index.ts';

const STORAGE_KEY = 'pigeon-pedigree-snapshot-v1';

export class AppState {
  readonly store = new PedigreeStore();
  private rng = new Rng(Date.now() >>> 0);

  /** 引导一个可玩的示例种群(默认 40 只奠基者 + 3 代繁育) */
  bootstrap(): void {
    if (this.store.size > 0) return;
    const founders = createFoundingPopulation({ size: 40, rng: new Rng(20261122) });
    for (const f of founders) this.store.add(f);
    let current = founders;
    let nextId = founders.length + 1;
    for (let gen = 1; gen <= 3; gen++) {
      const males = current.filter((b) => b.sex === 'M');
      const females = current.filter((b) => b.sex === 'F');
      const offspring: Pigeon[] = [];
      for (let i = 0; i < Math.min(males.length, females.length); i++) {
        for (let t = 0; t < 2; t++) {
          const child = mate({
            sire: males[i]!,
            dam: females[i]!,
            rng: this.rng,
            generation: gen,
          });
          child.id = nextId;
          child.ringId = `DEMO-G${gen}-${String(nextId).padStart(5, '0')}`;
          child.phenotype = expressPhenotype(child.genome, child.sex, child.inbreeding, child.envNoise);
          this.store.add(child);
          offspring.push(child);
          nextId++;
        }
      }
      current = offspring;
    }
  }

  /** 落盘到 localStorage(大种群时调用方应改用 NDJSON 文件导出) */
  saveLocal(): void {
    try {
      localStorage.setItem(STORAGE_KEY, snapshotToJson(this.store));
    } catch (err) {
      console.warn('localStorage 容量不足,请改用文件导出', err);
    }
  }

  loadLocal(): boolean {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return false;
    const restored = snapshotFromJson(text);
    this.store.reset(restored.size + 1);
    for (const p of restored.all()) this.store.add(p);
    return true;
  }

  clearLocal(): void {
    localStorage.removeItem(STORAGE_KEY);
  }

  /** 下载 JSON 快照文件 */
  exportFile(): void {
    const blob = new Blob([snapshotToJson(this.store)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pigeon-pedigree-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 从上传文件导入快照 */
  async importFile(file: File): Promise<void> {
    const text = await file.text();
    const restored = snapshotFromJson(text);
    this.store.reset(restored.size + 1);
    for (const p of restored.all()) this.store.add(p);
  }
}

export const appState = new AppState();
