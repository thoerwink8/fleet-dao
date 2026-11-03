// pnpm fleet2 up（= node packages/conventions/src/bin/fleet2.ts up，#3858）：本机一条命令起新内核（装配档案 local）。
// 页面没构建就先构建一次（harness-web 的 build:local，产物 dist-local），再起 packages/harness-dispatch/src/bin/kernel.ts，
// 只用环境变量和它交接（FLEET2_PROFILE=local、FLEET2_WEB_DIST）；本包是零安装区，不 import 新内核的包。
// 内核起来后自己打印登录链接（一次性登录码）。Ctrl-C 或结束本进程会转给内核，让它等工人收尾再退。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'up' || rest.length > 0) {
  console.error('用法：pnpm fleet2 up');
  process.exit(2);
}

const dist = process.env.FLEET2_WEB_DIST ?? join(root, 'packages', 'harness-web', 'dist-local');
if (!process.env.FLEET2_WEB_DIST && !existsSync(join(dist, 'index.html'))) {
  console.log('页面还没构建，先构建一次（只在第一次）…');
  const r = spawnSync('pnpm --filter @fleet-dao/harness-web build:local', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error('页面构建失败，不起');
    process.exit(2);
  }
}

const child = spawn(
  process.execPath,
  [join(root, 'packages', 'harness-dispatch', 'src', 'bin', 'kernel.ts')],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, FLEET2_PROFILE: 'local', FLEET2_WEB_DIST: dist },
  },
);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
