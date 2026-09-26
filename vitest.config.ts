import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.{ts,tsx}',
      'agents/test/**/*.test.ts',
    ],
    // 不开 passWithNoTests：CI 按改动只跑几个包（packages/conventions/src/ci-plan.ts），路径一个测试都没匹配上要红，不能当通过。
  },
});
