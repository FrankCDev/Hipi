import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { '@benchmark-ui': `${process.env.HIPI_REPO_ROOT}/apps/hipi-work-ui/src` },
  },
  test: {
    include: ['render-cost.test.tsx'],
    environment: 'node',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 60000,
  },
});
