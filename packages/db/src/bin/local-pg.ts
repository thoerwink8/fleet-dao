// pnpm pg:local [status|start|stop]：本机测试用的 Postgres，start 脱离会话起（判法和为什么在 ../local-pg.ts）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { localPg, localPgConfig } from '../local-pg.ts';

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

// 不用 process.exit：Windows 上它和后台线程抢着关句柄，偶发崩成 0xC0000409、退出码丢了（nodejs/node#56645）
try {
  const config = localPgConfig(process.env);
  process.exitCode = await localPg(process.argv.slice(2), config, {
    platform: process.platform,
    exists: existsSync,
    listening,
    powershell: (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]),
    pgCtl: (args) => run(config.pgCtl, args),
    sleep: (ms) => sleep(ms),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}
