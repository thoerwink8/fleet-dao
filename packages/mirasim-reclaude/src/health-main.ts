import { homedir } from 'node:os';
import { defaultEnv, ensureDaemon, gatewayTest, runSync, summary, updateCheck } from './reclaude-health.ts';

const args = process.argv.slice(2);
const homeAt = args.indexOf('--home');
const home = homeAt >= 0 && args[homeAt + 1] ? (args[homeAt + 1] as string) : homedir();
const sync = args.includes('--sync');

if (args.includes('--help')) {
  console.log(
    'pnpm mirasim:health [--run]\n默认打 reclaude 健康汇总；--run 现在就预热 daemon、测速、检查更新（空闲才装）。',
  );
} else {
  const env = defaultEnv(home);
  if (!env) {
    // 同步钩子调用时没装 reclaude 就什么都不做；手动跑要明说
    if (!sync) {
      console.log('没查成：找不到 reclaude（~/.local/bin、Windows 安装目录、PATH 都没有）');
      process.exitCode = 1;
    }
  } else if (sync) {
    try {
      await runSync(env);
    } catch (error) {
      process.stderr.write(`reclaude 健康维护失败：${(error as Error).message}\n`);
    }
  } else {
    if (args.includes('--run')) {
      await ensureDaemon(env);
      await gatewayTest(env);
      await updateCheck(env);
    }
    console.log(await summary(env));
  }
}
