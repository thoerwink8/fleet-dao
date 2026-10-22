// agents-sync 可执行入口：接上真的参数、环境、输出和身份。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PasswdEntry, runCli } from './cli.ts';

/** getent passwd <名>：用户名:口令:uid:gid:说明:家目录:shell */
function lookupUser(name: string): PasswdEntry | undefined {
  let line: string;
  try {
    line = execFileSync('getent', ['passwd', name], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
  const f = line.split(':');
  const uid = Number(f[2]);
  const gid = Number(f[3]);
  const home = f[5];
  if (f[0] !== name || !Number.isInteger(uid) || !Number.isInteger(gid) || !home) return undefined;
  return { uid, gid, home };
}

/** 先附加组、再组、最后用户（反过来就没权限改组了）；换完读回，对不上就抛 */
function becomeUser(name: string, entry: PasswdEntry): void {
  // Node 在 POSIX 上一直有 process.initgroups，@types/node 22 的声明里没写
  const proc = process as { initgroups?: (user: string, extraGroup: number) => void };
  if (!proc.initgroups || !process.setgid || !process.setuid || !process.getuid || !process.getgid) {
    throw new Error('这个平台换不了身份');
  }
  proc.initgroups(name, entry.gid);
  process.setgid(entry.gid);
  process.setuid(entry.uid);
  if (process.getuid() !== entry.uid || process.geteuid?.() !== entry.uid || process.getgid() !== entry.gid) {
    throw new Error(`换完读回是 uid ${process.getuid()}、gid ${process.getgid()}`);
  }
}

process.exitCode = runCli(process.argv.slice(2), {
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  os: process.platform,
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  now: () => new Date(),
  homedir,
  defaultRepo: fileURLToPath(new URL('../../..', import.meta.url)),
  getuid: () => process.getuid?.(),
  lookupUser,
  becomeUser,
});

const maintenanceEnabled = !process.argv.includes('--no-maintenance');

// 本机会话心跳（agents/local-sessions）：装过的机器顺手换新脚本和钩子登记（install.mjs refresh；没装过它自己说一句、不动）。
// 调工具前不再挂心跳、其余改 async：不经这一步，各台要等有人重跑 pnpm local-sessions install 才换。
if (
  maintenanceEnabled &&
  process.argv.includes('--apply') &&
  !process.argv.includes('--user') &&
  !process.argv.includes('--help')
) {
  const args = process.argv.slice(2);
  const argValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repo = argValue('--repo') ?? fileURLToPath(new URL('../../..', import.meta.url));
  const script = join(repo, 'agents', 'local-sessions', 'install.mjs');
  if (existsSync(script)) {
    try {
      const output = execFileSync(
        process.execPath,
        [script, 'refresh', '--home', argValue('--home') ?? homedir()],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      process.stdout.write(`本机会话心跳（agents/local-sessions）\n${output}`);
    } catch (err) {
      const out = (err as { stdout?: string }).stdout ?? '';
      process.stdout.write(`本机会话心跳（agents/local-sessions）\n${out}`);
      process.stderr.write(`本机会话心跳换新没做成：${(err as Error).message.split('\n')[0]}\n`);
      process.exitCode = 1;
    }
  }
}
