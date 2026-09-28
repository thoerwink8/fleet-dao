// 帅位只一个（#299）：帅位认领单、工人报进度和结束、推前查认领，经 ssh 调法国的 fleet-api claim。node claim.mjs 不带参数看用法。
// 在项目仓的检出里跑（仓从 origin 认，别处加 --repo）；库里成了再改单上的「在做」镜子（doing-lib.mjs）。逻辑都在 seat-lib.mjs。
// ssh 的标准错误交原字节，由 seat-lib 认编码。git、gh 仍按 UTF-8 字符串。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { runClaim } from './seat-lib.mjs';

function run(bin, args, input, timeout) {
  const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout, windowsHide: true });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.code ?? r.error?.message,
  };
}

function ssh(args, input) {
  const r = spawnSync('ssh', args, { input, timeout: 90_000, windowsHide: true });
  return {
    status: r.status,
    stdout: r.stdout?.toString('utf8') ?? '',
    stderr: r.stderr ?? Buffer.alloc(0),
    error: r.error?.code ?? r.error?.message,
  };
}

function gh(args, input) {
  const r = run('gh', args, input, 60_000);
  if (r.error) throw new Error(`gh 没跑起来（${r.error}）`);
  if (r.status !== 0)
    throw new Error(`gh 退出码 ${r.status}：${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  return r.stdout;
}

process.exitCode = await runClaim(process.argv.slice(2), {
  ssh,
  git: (args) => run('git', args, undefined, 30_000),
  gh,
  env: process.env,
  home: homedir(),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readStdin: async () => readFileSync(0, 'utf8'),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
