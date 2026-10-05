import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { applyPosixToolsPath } from './packages/conventions/src/test-posix-path.ts';
import { testWorkers } from './packages/conventions/src/test-run.ts';
import { TEST_INCLUDE } from './packages/conventions/src/test-split.ts';

// 开几个测试进程按本进程所在 cgroup 的内存上限算（引擎的会话被关在有上限的 scope 里），没有上限（本机、CI）照 vitest 默认；
// 读不到、认不出上限就报错，不猜。见 packages/conventions/src/test-run.ts。
// Windows 上从 PowerShell 跑时 PATH 里没有 Git 的 sh：把它排到最前面（见 test-posix-path.ts）；别的平台不动。
const posixNote = applyPosixToolsPath();
if (posixNote) console.warn(posixNote);

const workers = testWorkers();
if (workers.note) console.warn(workers.note);

export default defineConfig({
  test: {
    // 收哪些测试文件只有一份（test-split.ts 的 TEST_INCLUDE）：CI 的 changes job 不装依赖，要自己在仓里按它枚举
    // （test-split.ts 的 listTestFiles），两边差一个都算错——test/test-split.test.ts 拿 vitest list 核对。
    include: [...TEST_INCLUDE],
    // 钩子的测试会真起 pretool.mjs、stop.mjs：不隔开的话，它们读写的是跑测试的这个会话自己的无人值守状态
    // （2026-10-05：一条 pretool 测试把会话里「创始人的话还没送达」那次提醒吃掉了，自己也因此红）。要用真状态目录的测试自己传 env。
    env: { FLEET_UNATTENDED_DIR: join(tmpdir(), 'fleet-dao-test-unattended') },
    // 不开 passWithNoTests：CI 按改动只跑几个包（packages/conventions/src/ci-plan.ts），路径一个测试都没匹配上要红，不能当通过。
    ...(workers.maxWorkers === undefined ? {} : { maxWorkers: workers.maxWorkers }),
  },
});
