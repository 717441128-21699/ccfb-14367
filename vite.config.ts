import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// 多页应用:首页 / 血统书 / 配对预测 / 批量模拟
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        pedigree: resolve(__dirname, 'pedigree.html'),
        pairing: resolve(__dirname, 'pairing.html'),
        simulate: resolve(__dirname, 'simulate.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
