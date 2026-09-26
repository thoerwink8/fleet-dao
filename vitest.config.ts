import { defineConfig } from 'vitest/config';
import { testWorkers } from './packages/conventions/src/test-run.ts';

// 开几个测试进程按本进程所在 cgroup 的内存上限算（引擎的会话被关在有上限的 scope 里），没有上限（本机、CI）照 vitest 默认；
// 读不到、认不出上限就报错，不猜。见 packages/conventions/src/test-run.ts。
const workers = testWorkers();
if (workers.note) console.warn(workers.note);

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.{ts,tsx}',
      'agents/test/**/*.test.ts',
    ],
    // 不开 passWithNoTests：CI 按改动只跑几个包（packages/conventions/src/ci-plan.ts），路径一个测试都没匹配上要红，不能当通过。
    ...(workers.maxWorkers === undefined ? {} : { maxWorkers: workers.maxWorkers }),
  },
});
