// agents-sync 可执行入口：接上真的参数、环境、输出和身份。
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
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
