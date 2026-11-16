// 派子代理时落一行本机归属（单 #3911）：agentId → 会话 id → 进程号 → 工作树 → 派出时间。
// 文件在 ~/.fleet-dao/subagent-ownership.jsonl（FLEET_DAO_HOME 可换），不进仓。
// agentId 用这次调用的 tool_use_id：TaskStop 认的就是它。进程号是钩子的父进程（派出它的那个会话），不按启动时间猜。
// 停止请求写进 subagent-stop-inbox/<会话>.txt，归属会话下一次调工具时由 pretool 读走。
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @typedef {{ agentId: string, sessionId: string, pid: number, worktree: string, at: string }} Ownership */

/** 本机状态目录 */
export const fleetHome = () => process.env.FLEET_DAO_HOME || join(homedir(), '.fleet-dao');

/** @param {string} home */
export const ownershipPath = (home) => join(home, 'subagent-ownership.jsonl');

/**
 * @param {unknown} o
 * @param {string} k
 * @returns {unknown}
 */
const prop = (o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined);
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));
/** @param {unknown} e */
const errCode = (e) => prop(e, 'code');

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseInput(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(text);
}

/**
 * 放行一次 Agent / Task 派工就追加一行。不是派子代理、缺 agentId、缺会话、缺工作树都不写，并说明为什么。
 * 同一个 agentId 再记一次不覆盖第一行（读的时候取第一行）。
 * @param {string} raw 钩子的原始输入
 * @param {{ home?: string, pid?: number, now?: () => Date }} [deps]
 * @returns {{ recorded: boolean, why?: string }}
 */
export function recordDispatch(raw, { home = fleetHome(), pid = process.ppid, now = () => new Date() } = {}) {
  /** @type {unknown} */
  let input;
  try {
    input = parseInput(raw);
  } catch (e) {
    return { recorded: false, why: `输入认不出：${why(e)}` };
  }
  const tool = prop(input, 'tool_name') ?? prop(input, 'toolName');
  if (tool !== 'Agent' && tool !== 'Task') return { recorded: false, why: '不是派子代理' };
  const nested = prop(input, 'agent_id');
  if (typeof nested === 'string' && nested.trim() !== '')
    return { recorded: false, why: '子代理里的调用不另记' };
  const agentId = prop(input, 'tool_use_id') ?? prop(input, 'toolUseId');
  if (typeof agentId !== 'string' || !/^[\w.-]{4,128}$/.test(agentId))
    return { recorded: false, why: '没有 agentId（tool_use_id）' };
  const sessionId = prop(input, 'session_id') ?? prop(input, 'sessionId');
  if (typeof sessionId !== 'string' || !/^[\w-]{4,128}$/.test(sessionId))
    return { recorded: false, why: '没有会话号' };
  const worktree = prop(input, 'cwd');
  if (typeof worktree !== 'string' || worktree.trim() === '')
    return { recorded: false, why: '没有工作树（cwd）' };
  if (!Number.isInteger(pid) || pid <= 0) return { recorded: false, why: '没有进程号' };
  /** @type {Ownership} */
  const row = { agentId, sessionId, pid, worktree, at: now().toISOString() };
  try {
    const file = ownershipPath(home);
    mkdirSync(home, { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return { recorded: true };
  } catch (e) {
    return { recorded: false, why: `归属写不进去：${why(e)}` };
  }
}

/**
 * 读全部归属。没有文件是空；坏行跳过。读不了（不是没有）抛出去。
 * @param {string} home
 * @returns {Ownership[]}
 */
export function readOwnership(home) {
  const file = ownershipPath(home);
  /** @type {string} */
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    throw new Error(`归属记录读不了（${file}）：${why(e)}`);
  }
  /** @type {Ownership[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (
        typeof v?.agentId === 'string' &&
        typeof v?.sessionId === 'string' &&
        Number.isInteger(v?.pid) &&
        typeof v?.worktree === 'string' &&
        typeof v?.at === 'string'
      ) {
        out.push({ agentId: v.agentId, sessionId: v.sessionId, pid: v.pid, worktree: v.worktree, at: v.at });
      }
    } catch {
      // 坏行不算
    }
  }
  return out;
}

/**
 * 按 agentId 或工作树找第一行。没有是 null。
 * @param {string} home
 * @param {string} key
 * @returns {Ownership | null}
 */
export function findOwnership(home, key) {
  return readOwnership(home).find((r) => r.agentId === key || r.worktree === key) ?? null;
}

/**
 * 归属会话还没读走的停止请求。没有是 null。读到就删，避免每次调工具都重复一遍。
 * @param {string} raw
 * @param {{ home?: string }} [deps]
 * @returns {string | null}
 */
export function takeStopNote(raw, { home = fleetHome() } = {}) {
  /** @type {unknown} */
  let input;
  try {
    input = parseInput(raw);
  } catch {
    return null;
  }
  const sessionId = prop(input, 'session_id') ?? prop(input, 'sessionId');
  if (typeof sessionId !== 'string' || !/^[\w-]{4,128}$/.test(sessionId)) return null;
  const file = join(home, 'subagent-stop-inbox', `${sessionId}.txt`);
  /** @type {string} */
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    unlinkSync(file);
  } catch {
    // 删不掉也把这一次的原文交出去；下一次还会再读到
  }
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}
