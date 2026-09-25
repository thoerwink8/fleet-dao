// 演示版的构建与本机开发：把 --mode demo、FLEET_WEB_TARGET=demo、路径、输出目录一起定好再起 react-router，
// 构建完先查第三方许可证声明在不在（src/build/licenses.ts），再扫一遍产物（src/build/scan.ts，声明文件也扫），
// 声明缺了、扫出真名、内部叫法、GitHub 地址、源码对照文件，都算失败。
//   node scripts/demo.ts build   构建到 dist-demo/client（FLEET_WEB_BASE 默认 /demo/，FLEET_WEB_OUT 改输出目录）
//   node scripts/demo.ts dev     本机起演示版（假数据；没有范围文件，按内置的最严范围）
// 发布时额外要拦的词（真域名）经 FLEET_DEMO_FORBID 给，逗号或空白分隔；只写在服务器配置里，不进仓。
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLicenses } from '../src/build/licenses.ts';
import { forbiddenTerms, formatHits, scanDir } from '../src/build/scan.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(
  dirname(createRequire(import.meta.url).resolve('@react-router/dev/package.json')),
  'bin.cjs',
);
const cmd = process.argv[2];

function run(args: string[], env: NodeJS.ProcessEnv): number {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: pkg, env, stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

if (cmd === 'dev') {
  const env = { ...process.env, FLEET_WEB_TARGET: 'demo', FLEET_WEB_BASE: process.env.FLEET_WEB_BASE ?? '/' };
  process.exit(run(['dev', '--mode', 'demo'], env));
} else if (cmd === 'build') {
  const out = process.env.FLEET_WEB_OUT ?? 'dist-demo';
  const env = {
    ...process.env,
    FLEET_WEB_TARGET: 'demo',
    FLEET_WEB_BASE: process.env.FLEET_WEB_BASE ?? '/demo/',
    FLEET_WEB_OUT: out,
  };
  // 先清掉上一次的输出：扫的、发的都只能是这一次构建出来的东西。
  rmSync(join(pkg, out), { recursive: true, force: true });
  const status = run(['build', '--mode', 'demo'], env);
  if (status !== 0) {
    console.error(`演示版构建失败（退出码 ${status}）`);
    process.exit(status);
  }
  const client = join(pkg, out, 'client');
  if (!existsSync(join(client, 'index.html'))) {
    console.error(`演示版构建完没有 ${join(out, 'client', 'index.html')}`);
    process.exit(1);
  }
  let listed: number;
  try {
    listed = assertLicenses(client);
  } catch (e) {
    console.error(`演示版不能发：${(e as Error).message}`);
    process.exit(1);
  }
  const { files, hits } = scanDir(client, forbiddenTerms(process.env.FLEET_DEMO_FORBID));
  if (hits.length) {
    console.error(`演示版的产物里有不该出现的东西（${hits.length} 处），不能发：\n${formatHits(hits)}`);
    process.exit(1);
  }
  console.log(
    `演示版产物扫过了：${files} 个文件，没有真名、内部叫法、GitHub 地址、源码对照文件；第三方许可证声明列了 ${listed} 个库`,
  );
} else {
  console.error('用法：node scripts/demo.ts build | dev');
  process.exit(64);
}
