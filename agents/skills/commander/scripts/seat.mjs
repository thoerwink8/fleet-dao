// 帅位只一个（#299）：接班、续约、现查、看现状、交接，经 ssh 调法国的 fleet-api seat。node seat.mjs 不带参数看用法。
// 法国的 ssh 主机名写在 ~/.fleet-dao/france-ssh（~/.ssh/config 里的别名）；逻辑都在 seat-lib.mjs。
// ssh 的标准错误交原字节，由 seat-lib 认编码。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { runSeat } from './seat-lib.mjs';

function ssh(args, input) {
  const r = spawnSync('ssh', args, { input, timeout: 90_000, windowsHide: true });
  return {
    status: r.status,
    stdout: r.stdout?.toString('utf8') ?? '',
    stderr: r.stderr ?? Buffer.alloc(0),
    error: r.error?.code ?? r.error?.message,
  };
}

process.exitCode = await runSeat(process.argv.slice(2), {
  ssh,
  env: process.env,
  home: homedir(),
  now: () => new Date(),
  readStdin: async () => readFileSync(0, 'utf8'),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
