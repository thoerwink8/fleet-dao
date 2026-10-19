import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { applyPosixToolsPath } from './packages/conventions/src/test-posix-path.ts';
import { testWorkers } from './packages/conventions/src/test-run.ts';
import { TEST_INCLUDE } from './packages/conventions/src/test-split.ts';
import { assetServingAllow } from './packages/web/src/build/asset-access.ts';

// 开几个测试进程按本进程所在 cgroup 的内存上限算（引擎的会话被关在有上限的 scope 里），CI、引擎的会话里没有上限照 vitest 默认；
// 本机人手跑的再按核数和整机负载降一档。读不到、认不出上限就报错，不猜。见 packages/conventions/src/test-run.ts。
// Windows 上从 PowerShell 跑时 PATH 里没有 Git 的 sh：把它排到最前面（见 test-posix-path.ts）；别的平台不动。
const posixNote = applyPosixToolsPath();
if (posixNote) console.warn(posixNote);

const workers = testWorkers();
if (workers.note) console.warn(workers.note);

export default defineConfig({
  // web 的测试会读依赖里的 ?url 资源（elkjs worker）；全局虚拟仓下包的真实路径在工作区外，vite 默认的 strict allow 会拒绝。
  // 只补 web 声明依赖的真实包目录，strict 照开（packages/web/src/build/asset-access.ts）。
  server: {
    fs: { allow: assetServingAllow(resolve(import.meta.dirname, 'packages/web'), import.meta.dirname) },
  },
  test: {
    // 收哪些测试文件只有一份（test-split.ts 的 TEST_INCLUDE）：CI 的 changes job 不装依赖，要自己在仓里按它枚举
    // （test-split.ts 的 listTestFiles），两边差一个都算错——test/test-split.test.ts 拿 vitest list 核对。
    include: [...TEST_INCLUDE],
    // 钩子的测试会真起 pretool.mjs、stop.mjs：不隔开的话，它们读写的是跑测试的这个会话自己的无人值守状态
    // （2026-10-05：一条 pretool 测试把会话里「创始人的话还没送达」那次提醒吃掉了，自己也因此红）。要用真状态目录的测试自己传 env。
    // 收尾钩子数「在跑的工人」读 ~/.fleet-dao/workers：同样指到临时目录（空 = 没有在跑的工人）。
    env: {
      FLEET_UNATTENDED_DIR: join(tmpdir(), 'fleet-dao-test-unattended'),
      FLEET_WORKERS_DIR: join(tmpdir(), 'fleet-dao-test-workers'),
      // Haiku 账本和收回策略（subagent-ledger.mjs）也读写 ~/.fleet-dao/：指到临时目录；收轮前对账不顺手起后台的 subagent:stats --enforce
      FLEET_DAO_HOME: join(tmpdir(), 'fleet-dao-test-home'),
      FLEET_SUBAGENT_ENFORCE: 'off',
    },
    // 不开 passWithNoTests：CI 按改动只跑几个包（packages/conventions/src/ci-plan.ts），路径一个测试都没匹配上要红，不能当通过。
    ...(workers.maxWorkers === undefined ? {} : { maxWorkers: workers.maxWorkers }),
  },
});
