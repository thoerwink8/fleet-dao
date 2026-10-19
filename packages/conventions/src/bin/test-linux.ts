// 单独验真 Linux 安全归档测试；与 check / test:changed 共用入口和本机测试槽。
import { fileURLToPath } from 'node:url';
import { LINUX_TESTS, runLocalVitest } from '../local-vitest.ts';
import { ENV_HELD, realSlotDeps, runInSlot } from '../test-slots.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
if (process.argv.length !== 2) {
  console.error('用法：pnpm test:linux（跑需要 Linux FD/进程语义的完整测试组）');
  process.exitCode = 2;
} else {
  const result = runInSlot(process.env, realSlotDeps(console.log), (held) =>
    runLocalVitest(
      root,
      ['run', ...LINUX_TESTS],
      held === undefined ? process.env : { ...process.env, [ENV_HELD]: held },
    ),
  );
  if (result.error) console.error(result.error.message);
  process.exitCode = result.error ? 2 : (result.status ?? 1);
}
