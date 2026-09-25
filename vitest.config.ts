import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.{ts,tsx}',
      'agents/test/**/*.test.ts',
    ],
    // 骨架期各包还没有测试；各包补上测试后删掉这一行。
    passWithNoTests: true,
  },
});
