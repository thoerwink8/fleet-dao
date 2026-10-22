// agents-sync 可执行入口：接上真的参数、环境、输出和身份。
import { execFileSync, spawn } from 'node:child_process';
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

// 同步专用检出已取到主线；旧检出的 agents:sync 也能借这个入口迁移旧封装。
if (
  maintenanceEnabled &&
  process.exitCode === 0 &&
  process.argv.includes('--apply') &&
  !process.argv.includes('--help') &&
  process.platform !== 'linux'
) {
  const args = process.argv.slice(2);
  const argValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const migrationHome = argValue('--home') ?? homedir();
  if (existsSync(join(migrationHome, '.mirasim', 'setting.json')))
    try {
      const output = execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../../mirasim-reclaude/bin/migrate', import.meta.url)),
          '--auto',
          '--home',
          migrationHome,
          '--repo',
          argValue('--repo') ?? fileURLToPath(new URL('../../..', import.meta.url)),
        ],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true },
      );
      if (output.trim()) process.stdout.write(output);
    } catch (err) {
      // 退出 76：启动命令被改回裸 claude，迁移器只报告不改设置。按「✗ 漂移」行写出，开会话钩子才会把它带进会话上下文。
      const failed = err as { status?: number; stdout?: string };
      if (failed.status === 76 && failed.stdout?.trim()) {
        for (const line of failed.stdout.split(/\r?\n/).filter((l) => l.trim()))
          process.stdout.write(`  ✗ ${line.trim()}\n`);
        process.exitCode = 1;
      } else {
        process.stderr.write('Mirasim 旧封装自动迁移未确认；原配置保留，可用 pnpm mirasim:migrate 检查\n');
        process.exitCode = 1;
      }
    }
}

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

// reclaude 健康维护（预热 daemon、测速记录、更新检查）：后台脱离执行，不等它、不拖慢开会话；
// 失败只写 ~/.fleet-dao/mirasim-reclaude/health.log，不让同步失败。没装 reclaude 时子进程自己直接退出。
if (
  maintenanceEnabled &&
  process.argv.includes('--apply') &&
  !process.argv.includes('--help') &&
  process.platform !== 'linux'
) {
  try {
    const args = process.argv.slice(2);
    const at = args.indexOf('--home');
    const healthHome = (at >= 0 ? args[at + 1] : undefined) ?? homedir();
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../mirasim-reclaude/bin/health', import.meta.url)),
        '--sync',
        '--home',
        healthHome,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    // 起不来也不影响同步
  }
}
