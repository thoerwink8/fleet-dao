// 钩子里跑 git 的唯一一份：开会话钩子（session-start.mjs）、收尾钩子（stop.mjs）、同步专用检出（sync-source.mjs，
// pnpm agents:sync 经 packages/agents-sync/src/sync-now.ts 也走它）、起子代理前取远端（pretool.mjs → fresh-main.mjs）共用。
// 原来四个文件各抄一份跑法、三份「为什么没成」、两份「git 没起来」（全仓审查第 4 路 R3），口径一改就漏一处。
// 同步工具把 agents/hooks/ 整个目录拷到 ~/.fleet-dao/hooks/，这份跟着装过去，同目录相对 import 照样找得到。
//
// 改这里之前必须知道：
// - 一律 `git -C <目录>` 跑、不用 spawn 的 cwd：目录不在时 git 自己说「cannot change to」（退出码 128，当成「不是仓」），
//   用 cwd 的话 spawn 直接报 ENOENT，和「git 不在」分不开。
// - 超时、起不来、Windows 上 0xC0000xxx 那类大退出码都是「git 没跑起来」（gitBroken），和「git 说这里不是仓」分开：
//   2026-09-30 本机 git 缺 DLL（退出码 3221225781）被说成「不是 git 仓」，把真毛病盖住了。

import { spawnSync } from 'node:child_process';

/** @typedef {{ status: number | null, stdout: string, stderr: string, error?: (Error & { code?: string }) | undefined, timeoutMs?: number }} GitResult 一次 git 命令的结果 */
/** @typedef {{ direct?: boolean, timeoutMs?: number }} GitOpts direct：去掉代理跑；timeoutMs：这一次单独的超时 */
/** @typedef {(dir: string, args: string[], opts?: GitOpts) => GitResult} Git */

/** 默认超时：Windows 上起一个 git 就要一两秒，读本地的命令给 15 秒 */
export const GIT_MS = 15_000;

/** 直连时要从环境里拿掉的变量（大小写、ALL_PROXY 都算） */
export const PROXY_VARS = [
  'https_proxy',
  'http_proxy',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'all_proxy',
  'ALL_PROXY',
];

/** 环境里有没有设代理（任一个非空） */
export function hasProxy(env = process.env) {
  return PROXY_VARS.some((k) => typeof env[k] === 'string' && env[k] !== '');
}

/** 去掉代理变量的环境副本（NO_PROXY 不动：它只说哪些地址不走代理，留着无害） */
export function withoutProxy(env = process.env) {
  const out = { ...env };
  for (const k of PROXY_VARS) delete out[k];
  return out;
}

/**
 * git 跑法：`git(dir, args, opts)` 在 dir 里跑一条，返回 { status, stdout, stderr, error, timeoutMs }（timeoutMs 是这一次实际用的）。
 * opts.direct 为 true 时去掉代理、超时用 directTimeoutMs；opts.timeoutMs 给了就用它。
 * @param {number} [timeoutMs]
 * @param {number} [directTimeoutMs]
 * @returns {Git}
 */
export function gitRunner(timeoutMs = GIT_MS, directTimeoutMs = timeoutMs) {
  return (dir, args, opts = {}) => {
    const timeout = opts.timeoutMs ?? (opts.direct ? directTimeoutMs : timeoutMs);
    const r = spawnSync('git', ['-C', dir, ...args], {
      ...(opts.direct ? { env: withoutProxy() } : {}),
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error,
      timeoutMs: timeout,
    };
  };
}

/** 一次 git 成没成 */
export const gitOk = (/** @type {GitResult} */ r) => r.status === 0 && !r.error;

/**
 * git 自己没跑起来：起不来、超时、被系统叫停（没有退出码），或者 Windows 上程序没起来给的那类大退出码（0xC0000xxx）。
 * 「git 说这里不是仓、没有 origin、没这个 ref」不算：那些 git 是说了话的（0、128 之类的退出码）。
 * @param {GitResult} r
 */
export function gitBroken(r) {
  if (r.error || typeof r.status !== 'number') return true;
  return r.status !== 0 && r.status !== 128 && r.status > 0x7fffffff;
}

/**
 * 一次命令为什么没成：超时、起不来、输出的第一行，或者 Windows 上程序没起来给的大退出码
 * （0xC0000135 = 缺 DLL；本机 2026-09-30 撞过，光写十进制看不出来）。不只 git：跑 node、gh 的结果同一个形状也用它。
 * @param {GitResult} r
 */
export function gitWhy(r) {
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT')
      return typeof r.timeoutMs === 'number' ? `超过 ${Math.round(r.timeoutMs / 1000)} 秒没完` : '超时没完';
    return `起不来：${r.error.message}`;
  }
  const first = `${r.stderr ?? ''}\n${r.stdout ?? ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (first) return first;
  if (typeof r.status === 'number' && r.status > 0x7fffffff)
    return `退出码 ${r.status}（0x${r.status.toString(16).toUpperCase()}，Windows 上程序没起来，多半缺 DLL）`;
  return `退出码 ${r.status}`;
}
