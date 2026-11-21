/**
 * 育种池稠密亲缘引擎:大种群定向选择模拟的性能方案。
 *
 * 原理:每代真正交配的只有被指数截断的育种池(规模 K,默认远小于普查数 N)。
 * 在该池上维护标准 Henderson 加性亲缘矩阵 A 的稠密 Float64Array:
 *   - 类型化数组连续内存,元素访问比稀疏 Map 快约一个数量级;
 *   - 配对近交 F = 0.5·A[sire,dam],O(1);
 *   - 新池个体 x(亲本 s,d∈旧池)对新池成员 k:
 *       A[x,k] = 0.25·[A(s,sk)+A(s,dk)+A(d,sk)+A(d,dk)],对角 1+F_x。
 *
 * 内存 O(K²),K = 实际参与繁殖的雌雄精英总数。普查 N=10000、选择比例 0.25 时
 * K≈2500,矩阵约 50MB;浏览器环境可通过更小的选择比例控制。
 * 池外个体不参与亲缘计算,符合「只有精英留种」的育种业务语义。
 */
export class DensePoolKinship {
  private ids: number[] = [];
  private index = new Map<number, number>();
  /** 行主序稠密矩阵,长度 cap*cap */
  private a: Float64Array = new Float64Array(0);
  private cap = 0;

  /** 奠基育种池:个体间无关,A 为单位矩阵 */
  seed(poolIds: readonly number[]): void {
    this.ids = [...poolIds];
    this.cap = this.ids.length;
    this.index = new Map();
    this.a = new Float64Array(this.cap * this.cap);
    this.ids.forEach((id, i) => {
      this.index.set(id, i);
      this.a[i * this.cap + i] = 1;
    });
  }

  /** 配对预期后代近交 F = 0.5·a_{sire,dam};池外亲本按断代奠基者(F=0) */
  matingInbreeding(sireId: number, damId: number): number {
    const si = this.index.get(sireId);
    const di = this.index.get(damId);
    if (si === undefined || di === undefined) return 0;
    return 0.5 * this.a[si * this.cap + di]!;
  }

  /**
   * 世代推进:由下一代育种池重建矩阵。
   * @param next 每项 = [新池个体 id, 父本 id(旧池), 母本 id(旧池)]
   */
  advance(next: readonly [number, number, number][]): void {
    const newCap = next.length;
    const nextA = new Float64Array(newCap * newCap);
    const sireIdx = new Int32Array(newCap);
    const damIdx = new Int32Array(newCap);
    const known = new Uint8Array(newCap);
    for (let i = 0; i < newCap; i++) {
      const si = this.index.get(next[i]![1]);
      const di = this.index.get(next[i]![2]);
      known[i] = si !== undefined && di !== undefined ? 1 : 0;
      sireIdx[i] = si ?? -1;
      damIdx[i] = di ?? -1;
    }

    for (let i = 0; i < newCap; i++) {
      const si = sireIdx[i]!;
      const di = damIdx[i]!;
      // 对角 1 + F_x
      const fx = known[i] ? 0.5 * this.a[si * this.cap + di]! : 0;
      nextA[i * newCap + i] = 1 + fx;
      if (!known[i]) continue;
      const siRow = si * this.cap;
      const diRow = di * this.cap;
      for (let j = i + 1; j < newCap; j++) {
        if (!known[j]) continue;
        const sj = sireIdx[j]!;
        const dj = damIdx[j]!;
        const v =
          0.25 *
          (this.a[siRow + sj]! +
            this.a[siRow + dj]! +
            this.a[diRow + sj]! +
            this.a[diRow + dj]!);
        // 对称写入
        nextA[i * newCap + j] = v;
        nextA[j * newCap + i] = v;
      }
    }

    this.ids = next.map((row) => row[0]);
    this.cap = newCap;
    this.index = new Map();
    this.ids.forEach((id, i) => this.index.set(id, i));
    this.a = nextA;
  }

  get poolSize(): number {
    return this.cap;
  }
}
