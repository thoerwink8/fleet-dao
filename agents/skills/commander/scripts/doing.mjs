// 单上的「在做」评论：node doing.mjs <命令> …；不带参数看用法。在项目仓的检出里跑（gh 从当前目录认仓），
// 在别处跑加 --repo <owner/repo>。要装好、登录好 gh。逻辑都在 doing-lib.mjs。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { runDoing } from './doing-lib.mjs';

function gh(args, input) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.error) throw new Error(`gh 没跑起来（${r.error.code ?? r.error.message}）`);
  if (r.status !== 0)
    throw new Error(`gh 退出码 ${r.status}：${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
  return r.stdout;
}

process.exitCode = await runDoing(process.argv.slice(2), {
  gh,
  env: process.env,
  home: homedir(),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
