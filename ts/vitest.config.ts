import { defineConfig } from 'vitest/config';

// Máy dev RAM trống ~1 GB: MỘT worker, không chạy song song file.
export default defineConfig({
  test: {
    // apps/web không có src/ (Next App Router: app/ + lib/) — test logic web ở lib/.
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/web/lib/**/*.test.ts',
    ],
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
