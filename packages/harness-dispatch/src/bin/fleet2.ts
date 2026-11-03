// fleet2：本机装法的命令行（#3858）。`fleet2 up [--open]`：一个进程起内核、驾驶舱口和页面，只听 127.0.0.1。
//   pnpm fleet2 up        页面没构建就先构建一次，起来后打印登录链接（一次性登录码，5 分钟、用一次就废）
// 数据在用户数据目录（FLEET2_DATA_DIR 可改），令牌在里面的 local-token（仅当前用户可读）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalDbBusyError } from '@fleet-dao/harness-store/local-db';
import { ConfigError } from '../profiles/config.ts';
import { assembleLocal } from '../profiles/local.ts';
import { runAssembly } from '../profiles/run.ts';

const [cmd, ...flags] = process.argv.slice(2);
if (cmd !== 'up' || flags.some((f) => f !== '--open')) {
  console.error('用法：fleet2 up [--open]');
  process.exit(2);
}

try {
  const env: Record<string, string | undefined> = { ...process.env, FLEET2_PROFILE: 'local' };
  const dist = env.FLEET2_WEB_DIST ? resolve(env.FLEET2_WEB_DIST) : undefined;
  if (!dist) {
    const def = new URL('../../../harness-web/dist-local', import.meta.url);
    const defDir = decodeURIComponent(def.pathname).replace(/^\/([A-Za-z]:)/, '$1');
    if (!existsSync(join(defDir, 'index.html'))) {
      console.log('页面还没构建，先构建一次（只在第一次）…');
      const r = spawnSync('pnpm --filter @fleet-dao/harness-web build:local', {
        stdio: 'inherit',
        shell: true,
      });
      if (r.status !== 0) throw new ConfigError('页面构建失败，不起');
    }
  }
  const assembly = await assembleLocal(env);
  const run = await runAssembly(assembly, { signals: true });
  const code = assembly.gateway.issueLoginCode();
  const base = (assembly.startedFields(run.apiPort).ui as string).replace(/\/$/, '');
  const url = `${base}/local-login?code=${code}`;
  console.log('');
  console.log(`fleet2 已起：${base}/`);
  console.log(`登录（一次性，5 分钟内有效）：${url}`);
  console.log('Ctrl-C 退出；数据在用户数据目录，下次再起事件还在。');
  if (flags.includes('--open')) {
    if (process.platform === 'win32')
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
        stdio: 'ignore',
        detached: true,
      }).unref();
  }
} catch (err) {
  if (err instanceof ConfigError || err instanceof LocalDbBusyError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
