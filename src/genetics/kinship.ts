/**
 * 滚动种群亲缘矩阵:批量模拟专用。
 *
 * 列表法的增量版本——只维护「当前存活 flock」成员之间的加性亲缘关系 a_ij,
 * 新个体入群时 O(n) 算一行,近交系数 O(1) 查表得到;淘汰个体做墓碑标记并周期压缩。
 * 相比全谱系递归,把 10k×50 代模拟的近交计算从树遍历降为数组访问。
 */
export class FlockKinship {
  /** 亲缘矩阵(仅填 [index*cap + j],index<=j 上三角 + 对角) */
  private matrix: Float64Array;
  private indexOf = new Map<number, number>();
  private ids: number[] = [];
  private alive: boolean[] = [];
  private cap: number;
  private liveCount = 0;

  constructor(initialCapacity = 256) {
    this.cap = initialCapacity;
    this.matrix = new Float64Array(initialCapacity * initialCapacity);
  }

  get size(): number {
    return this.liveCount;
  }

  private at(i: number, j: number): number {
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    return this.matrix[lo * this.cap + hi]!;
  }

  private setAt(i: number, j: number, v: number): void {
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    this.matrix[lo * this.cap + hi] = v;
  }

  private grow(): void {
    const newCap = this.cap * 2;
    const next = new Float64Array(newCap * newCap);
    // 迁移旧上三角:旧 (i,j) i<=j 映射到新矩阵同坐标,新矩阵步长改变需逐行拷贝
    for (let i = 0; i < this.cap; i++) {
      for (let j = i; j < this.cap; j++) {
        next[i * newCap + j] = this.matrix[i * this.cap + j]!;
      }
    }
    this.matrix = next;
    this.cap = newCap;
  }
  /** 奠基者入群:与群内现存个体无关,a_ii=1,其余为 0 */
  addFounder(id: number): void {
    if (this.indexOf.has(id)) throw new Error(`亲缘矩阵已含个体 ${id}`);
    this.ensureCapacity();
    const idx = this.ids.length;
    this.indexOf.set(id, idx);
    this.ids.push(id);
    this.alive.push(true);
    this.setAt(idx, idx, 1);
    this.liveCount++;
  }

  /**
   * 后代入群。双亲必须都在矩阵中(奠基者或此前入群的个体)。
   * @returns 后代近交系数 F = 0.5·a_{sire,dam}
   */
  addOffspring(id: number, sireId: number, damId: number): number {
    if (this.indexOf.has(id)) throw new Error(`亲缘矩阵已含个体 ${id}`);
    this.ensureCapacity();
    const si = this.indexOf.get(sireId);
    const di = this.indexOf.get(damId);
    if (si === undefined || di === undefined) {
      throw new Error('双亲必须先于后代加入亲缘矩阵');
    }
    const inbreeding = 0.5 * this.at(si, di);
    const idx = this.ids.length;
    this.indexOf.set(id, idx);
    this.ids.push(id);
    this.alive.push(true);
    this.liveCount++;

    for (let k = 0; k < idx; k++) {
      if (!this.alive[k]) continue;
      const v = 0.5 * (this.at(k, si) + this.at(k, di));
      this.setAt(k, idx, v);
    }
    // a_ii = 1 + F_i
    this.setAt(idx, idx, 1 + inbreeding);
    return inbreeding;
  }

  /**
   * 容量保障:物理槽满时,若有墓碑先压缩回收;压缩后仍满(全存活)才扩容。
   * 这样滚动世代下矩阵规模始终贴近「当前存活 flock」而非累计出生数。
   */
  private ensureCapacity(): void {
    if (this.ids.length < this.cap) return;
    if (this.liveCount < this.ids.length) {
      this.compact();
    } else {
      this.grow();
    }
  }

  /** 配对前查询预期后代近交系数 */
  matingInbreeding(sireId: number, damId: number): number {
    const si = this.indexOf.get(sireId);
    const di = this.indexOf.get(damId);
    if (si === undefined || di === undefined) {
      throw new Error('配对个体不在当前 flock 中');
    }
    return 0.5 * this.at(si, di);
  }

  /** 淘汰个体(墓碑标记);实际槽位回收由下次 ensureCapacity → compact 完成 */
  remove(id: number): void {
    const idx = this.indexOf.get(id);
    if (idx === undefined || !this.alive[idx]) return;
    this.alive[idx] = false;
    this.indexOf.delete(id);
    this.liveCount--;
  }

  /**
   * 压缩:剔除墓碑,按存活顺序紧凑重建矩阵与全部索引。
   * 重建后物理长度 = 存活数,indexOf 同步重映射,外部 id 引用仍然有效。
   */
  compact(): void {
    const oldCap = this.cap;
    const oldMatrix = this.matrix;
    const oldIds = this.ids;
    const oldAlive = this.alive;

    // 旧物理下标 → 新物理下标(仅存活者)
    const remap = new Map<number, number>();
    const newIds: number[] = [];
    for (let oldIdx = 0; oldIdx < oldIds.length; oldIdx++) {
      if (oldAlive[oldIdx]) {
        remap.set(oldIdx, newIds.length);
        newIds.push(oldIds[oldIdx]!);
      }
    }
    const n = newIds.length;
    // 容量保持不变(调用方保证 n < cap),零填充的新矩阵天然清掉墓碑数据
    const next = new Float64Array(oldCap * oldCap);
    const aliveOldIdx = [...remap.keys()];
    for (let ii = 0; ii < n; ii++) {
      const oldI = aliveOldIdx[ii]!;
      for (let jj = ii; jj < n; jj++) {
        const oldJ = aliveOldIdx[jj]!;
        const [olo, ohi] = oldI <= oldJ ? [oldI, oldJ] : [oldJ, oldI];
        next[ii * oldCap + jj] = oldMatrix[olo * oldCap + ohi]!;
      }
    }
    this.matrix = next;
    this.ids = newIds;
    this.alive = new Array<boolean>(n).fill(true);
    this.indexOf = new Map<number, number>(newIds.map((id, i) => [id, i]));
  }

  liveIds(): number[] {
    return this.ids.filter((_, i) => this.alive[i]);
  }
}
