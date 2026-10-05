// second-opinion.mjs 拆出来的共用底子（入口和同目录的 so-*.mjs 都用）：「没查成」这个错误、记录放哪、起 git 和 gh、
// 绕开代理直连。类型只写在 JSDoc 里（同步工具原样装到各台机器、纯 node 直接跑）；agents/tsconfig.json 用 checkJs 过严格检查。
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from './tools.mjs';

/** @typedef {{ family: string, agent: string, model: string | null, route: 'cloud' | 'local' | null }} Profile 一家执行体（族、起它的方式、模型、走不走中继） */
/** @typedef {{ text: string, sessionKey: string, model: string | null, ledgerNote: string, usage: string, fallbackNote?: string }} SessionResult 一次会话跑完的结果 */
/** @typedef {(s: string) => void} Log */
/** @typedef {(args: string[]) => string} GhRun 起 gh（失败抛错、成功回 stdout；测试里换成假的） */
/** @typedef {{ prompt: string, profile: Profile, workdir: string, timeoutMin: number, log: Log, pollMs?: number, effort?: string | undefined, discussion?: boolean }} SessionOpts runSession 要的 */
/**
 * 命令行参数（args() 整理出来的）。
 * @typedef {{ timeoutMin: number, ui: boolean, slot: number, pr?: number, repo?: string | undefined, roundGiven?: boolean, afterMergePending?: boolean, afterMergeSweep?: boolean, resolve?: number, resolveGiven?: boolean, by?: number, json?: boolean, noFetch?: boolean, slotGiven?: boolean, selftest?: boolean, ping?: boolean, noPost?: boolean, keepSession?: boolean, sessions?: boolean, stopStale?: boolean, text?: string | undefined, name?: string | undefined, effort?: string | undefined, agent?: string | undefined, authorFamily?: string, excludeFamily?: string | undefined, budgetSec?: number, blind?: boolean, slow?: boolean, highRisk?: boolean, postMerge?: boolean }} Options
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export const isObjectLike = (v) => typeof v === 'object' && v !== null;
/**
 * 抛出来的东西上的 code（ENOENT 这类）；不是对象就是 undefined。
 * @param {unknown} e
 */
export const errCode = (e) => (isObjectLike(e) ? e.code : undefined);
/**
 * 抛出来的东西上的 message；不是对象就是 undefined。
 * @param {unknown} e
 */
export const messageOf = (e) => (isObjectLike(e) ? e.message : undefined);

export class NotChecked extends Error {}

const DATA = dataDir();
export const RUNS = join(DATA, 'runs');
export const MIRA = join(homedir(), '.mirasim');

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function sh(cmd, args, cwd, env = process.env) {
  return execFileSync(cmd, args, {
    cwd,
    env,
    windowsHide: true,
    encoding: 'utf8',
    // 默认 1 MB：14 天的 git log --name-status、翻了几页的评论会超
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * 去掉代理变量的环境：本机代理对 github.com 时好时坏（2026-09-25 实测直连通、代理不通），git、gh 照常跑不成就拿它直连再试一次。
 * 取 PR、gh、取主线三处原来各写一份，并成这一处。
 * @returns {NodeJS.ProcessEnv}
 */
export function directEnv() {
  const { https_proxy, http_proxy, HTTPS_PROXY, HTTP_PROXY, ...direct } = process.env;
  return direct;
}

/**
 * gh 走代理时好时坏（2026-09-25 实测）：先照常，不行再绕开代理直连。
 * @param {string[]} args
 * @param {string} [cwd]
 */
export function gh(args, cwd) {
  try {
    return sh('gh', args, cwd);
  } catch {
    return sh('gh', args, cwd, directEnv());
  }
}

/**
 * 一次命令失败的原因：stderr 第一行（没有就用 message），最多 200 字。
 * @param {unknown} e
 */
export function errText(e) {
  const s = String((isObjectLike(e) ? e.stderr : undefined) ?? '').trim() || String(messageOf(e) ?? e).trim();
  const first = s.split(/\r?\n/).find((l) => l.trim()) ?? s;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}
