import { defineConfig } from 'vitest/config';
import { testWorkers } from './packages/conventions/src/test-run.ts';
import { TEST_INCLUDE } from './packages/conventions/src/test-split.ts';

// 开几个测试进程按本进程所在 cgroup 的内存上限算（引擎的会话被关在有上限的 scope 里），没有上限（本机、CI）照 vitest 默认；
// 读不到、认不出上限就报错，不猜。见 packages/conventions/src/test-run.ts。
const workers = testWorkers();
if (workers.note) console.warn(workers.note);

export default defineConfig({
  test: {
    // 收哪些测试文件只有一份（test-split.ts 的 TEST_INCLUDE）：CI 的 changes job 不装依赖，要自己在仓里按它枚举
    // （test-split.ts 的 listTestFiles），两边差一个都算错——test/test-split.test.ts 拿 vitest list 核对。
    include: [...TEST_INCLUDE],
    // 不开 passWithNoTests：CI 按改动只跑几个包（packages/conventions/src/ci-plan.ts），路径一个测试都没匹配上要红，不能当通过。
    ...(workers.maxWorkers === undefined ? {} : { maxWorkers: workers.maxWorkers }),
  },
});
// ci-soak 3/10：这张草稿 PR 只用来连跑完整 CI 测偶发红，不合（#654）
