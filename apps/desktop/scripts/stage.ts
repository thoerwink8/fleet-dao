// 把装进安装包的东西备到 apps/desktop/build/（tauri.conf.json 的 bundle.resources 指到这里）：
//   build/kernel/      node.exe + kernel.mjs + PGlite 的 wasm/data（probes/desktop/bundle-kernel.ts 出）
//   build/migrations/  迁移目录（kernel.mjs 的上一级）
//   build/web/         本机版页面（harness-web 的 build:local，base=/）
//   build/bin/jobrun.exe  内核起工人时收整棵进程树用（crates/jobrun，release 版）
// 用法：node apps/desktop/scripts/stage.ts [--skip-web]（页面已经构建过就跳过那一步）
// node.exe 取当前运行它的 node（CI 里是 setup-node 装的官方版）。
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const root = join(here, '..', '..');
const build = join(here, 'build');
const skipWeb = process.argv.includes('--skip-web');

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd === 'pnpm',
  });
}

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });

if (!skipWeb) run('pnpm', ['--filter', '@fleet-dao/harness-web', 'build:local']);
const dist = join(root, 'packages', 'harness-web', 'dist-local');
if (!existsSync(join(dist, 'index.html'))) throw new Error(`本机版页面没构建出来：${dist}/index.html 不在`);
cpSync(dist, join(build, 'web'), { recursive: true });

run(process.execPath, [join(root, 'probes', 'desktop', 'bundle-kernel.ts'), join(build, 'kernel')]);

run('cargo', ['build', '--release', '-p', 'jobrun']);
mkdirSync(join(build, 'bin'), { recursive: true });
copyFileSync(join(root, 'target', 'release', 'jobrun.exe'), join(build, 'bin', 'jobrun.exe'));

console.log(`备好了：${build}`);
