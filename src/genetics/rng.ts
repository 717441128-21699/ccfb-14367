/**
 * 可种子化随机数引擎。
 * 全部繁育逻辑只依赖此模块,保证同一 seed 下结果可复现(测试与模拟审计用)。
 */

export class Rng {
  private state: number;
  /** 缓存的正态分布余值(Box–Muller) */
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) 均匀分布,基于 mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 整数 [min, max] 闭区间 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 以概率 p 返回 true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 从数组等概率取一项 */
  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick 作用于空数组');
    return item;
  }

  /**
   * 标准正态分布 N(0,1),Box–Muller 极坐标法,一次生成两个缓存复用。
   */
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return u * mul;
  }

  /** N(mean, sd²) */
  gaussian(mean: number, sd: number): number {
    return mean + this.normal() * sd;
  }

  /** 字符串 seed 哈希为 32 位无符号整数(FNV-1a 变体) */
  static hashSeed(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}
