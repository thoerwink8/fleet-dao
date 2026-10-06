// ask.mjs、second-opinion.mjs（反方）共用：数据放哪、这台机器上本机工具在不在、cursor-agent 登没登录。
// 数据（题面、答案、讨论记录）放 ~/.local/share/second-opinion/，不放技能目录：同步见技能目录里多了文件，会把整个目录
// 换回仓里的样子，记录就没了。工具没装、没开、没登录都要说清是哪样（法国上就没有 cursor-agent、Mirasim），不当成答了。
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 这台机器上缺了本机工具（没装、没开、没登录）：这一家问不了，换下一家或照实报 */
export class NotInstalled extends Error {}

/** @param {string} [home] */
export function dataDir(home = homedir()) {
  return join(home, '.local', 'share', 'second-opinion');
}

/**
 * PATH 上找得到这个命令就返回它的路径（Windows 按 PATHEXT 补扩展名）
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string | undefined}
 */
export function findBin(name, env = process.env, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const exts =
    platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (platform !== 'win32') accessSync(file, constants.X_OK);
        return file;
      } catch {
        // 这个目录里没有
      }
    }
  }
  return undefined;
}

/**
 * 跑一个 PATH 上的命令（Windows 上 cursor-agent 是 .cmd，得经 shell；参数都是固定的简单词，直接拼）
 * @param {string} name
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer>}
 */
export function runTool(name, args, opts = {}) {
  if (process.platform === 'win32') return spawnSync([name, ...args].join(' '), { ...opts, shell: true });
  return spawnSync(name, args, opts);
}

// Windows 上 Git Bash 留下的几个环境变量：cursor-agent 靠它们猜「当前是不是 bash 环境」，猜完拿它跑钩子的 stdin 转发脚本，
// 那脚本本身是 PowerShell 语法，交给 bash 的 eval 直接语法错、钩子判失败＝把这次调用拦掉（fleet-dao#435；forum.cursor.com
// 和多个不相关项目的 GitHub issue 报过同一段崩溃文本，是 Cursor 自己未解决的上游 bug）。本机 2026-09-28 二次实测：单摘这几个
// 变量不够——只要父进程链里有 Git Bash，就算连 SHELL/MSYSTEM/TERM/SHLVL/_/EXEPATH/PWD/HOME 全摘、直接起 node.exe、甚至
// 经 powershell.exe 起，钩子照样按 bash 判、把工具调用拦掉；真正绕开的办法是题面走 stdin、不要它调工具去读文件
// （ask.mjs、second-opinion.mjs 都已经这样改）。这个函数留着当多一层保险（摘的是环境变量，不是钩子本身的判断——密钥
// 路径那些规矩照样生效），起 cursor-agent 的地方都带上，别漏一个，但别指望单靠它就能让读文件的工具调用畅通。
/**
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function cursorAgentEnv(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return env;
  const out = { ...env };
  for (const k of ['SHELL', 'MSYSTEM', 'MSYSTEM_PREFIX', 'MSYSTEM_CHOST', 'TERM']) delete out[k];
  return out;
}

/**
 * cursor-agent 能不能用：装了（PATH 上有）、登录了（status --format json 的 isAuthenticated 是 true）。
 * 返回 null 表示能用，否则是一句为什么（给人看）。
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof runTool }} [opts]
 * @returns {string | null}
 */
export function cursorAgentProblem({ env = process.env, run = runTool } = {}) {
  if (!findBin('cursor-agent', env)) return '这台机器没装 cursor-agent（PATH 上找不到）；讨论要它';
  const r = run('cursor-agent', ['status', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: cursorAgentEnv(process.platform, env),
  });
  if (r.error)
    return `查不了 cursor-agent 登没登录（${'code' in r.error && r.error.code === 'ETIMEDOUT' ? '30 秒没回' : r.error.message}）`;
  /** @type {unknown} */
  let status;
  try {
    status = JSON.parse(String(r.stdout ?? '').trim());
  } catch {
    // 原文不照抄：status 的文字输出里有登录的账号
    return `查不了 cursor-agent 登没登录（status --format json 的输出认不出，退出码 ${r.status}）`;
  }
  if (
    !(
      typeof status === 'object' &&
      status !== null &&
      'isAuthenticated' in status &&
      status.isAuthenticated === true
    )
  )
    return '这台机器上 cursor-agent 没登录（先在这台机器上跑 cursor-agent login）';
  return null;
}
