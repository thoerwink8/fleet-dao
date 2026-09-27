// ask.mjs、second-opinion.mjs 共用：数据放哪、这台机器上本机工具在不在、cursor-agent 登没登录。
// 数据（题面、答案、审查记录）放 ~/.local/share/second-opinion/，不放技能目录：同步见技能目录里多了文件，会把整个目录
// 换回仓里的样子，记录就没了。工具没装、没开、没登录都要说清是哪样（法国上就没有 cursor-agent、Mirasim），不当成答了。
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 这台机器上缺了本机工具（没装、没开、没登录）：这一家问不了，换下一家或照实报 */
export class NotInstalled extends Error {}

export function dataDir(home = homedir()) {
  return join(home, '.local', 'share', 'second-opinion');
}

/** PATH 上找得到这个命令就返回它的路径（Windows 按 PATHEXT 补扩展名） */
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

/** 跑一个 PATH 上的命令（Windows 上 cursor-agent 是 .cmd，得经 shell；参数都是固定的简单词，直接拼） */
export function runTool(name, args, opts = {}) {
  if (process.platform === 'win32') return spawnSync([name, ...args].join(' '), { ...opts, shell: true });
  return spawnSync(name, args, opts);
}

/**
 * cursor-agent 能不能用：装了（PATH 上有）、登录了（status --format json 的 isAuthenticated 是 true）。
 * 返回 null 表示能用，否则是一句为什么（给人看）。
 */
export function cursorAgentProblem({ env = process.env, run = runTool } = {}) {
  if (!findBin('cursor-agent', env))
    return '这台机器没装 cursor-agent（PATH 上找不到）；讨论和 Cursor 那几家的第二意见都要它';
  const r = run('cursor-agent', ['status', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env,
  });
  if (r.error)
    return `查不了 cursor-agent 登没登录（${r.error.code === 'ETIMEDOUT' ? '30 秒没回' : r.error.message}）`;
  let status;
  try {
    status = JSON.parse(String(r.stdout ?? '').trim());
  } catch {
    // 原文不照抄：status 的文字输出里有登录的账号
    return `查不了 cursor-agent 登没登录（status --format json 的输出认不出，退出码 ${r.status}）`;
  }
  if (status?.isAuthenticated !== true)
    return '这台机器上 cursor-agent 没登录（先在这台机器上跑 cursor-agent login）';
  return null;
}
