// 子代理归属：agentId → 会话 id → 进程号 → 工作树 → 派出时间。
// 只写本机 ~/.fleet-dao/subagent-owners.jsonl（FLEET_DAO_HOME 可换，测试用），不进仓。
// 派出成功由 PostToolUse（continuation-progress.mjs）记一行。pnpm agents:stop <工作树|agentId>
// 按这行找到归属会话，把停止写给那个会话；记录没有、会话已不在就退出码 1，并写「停不了：原因」。
// 不按启动时间猜进程。进程号只用来问还在不在（signal 0），不发会杀掉进程的信号。
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMainModule } from './is-main.mjs';

/** @typedef {{ agentId: string, sessionId: string, pid: number, worktree: string, at: string }} Owner */

/** @param {unknown} e */
const errCode = (e) => (typeof e === 'object' && e !== null && 'code' in e ? Reflect.get(e, 'code') : undefined);
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/** 本机状态目录 */
export const fleetHome = () => process.env.FLEET_DAO_HOME || join(homedir(), '.fleet-dao');
/** @param {string} home */
export const ownersPath = (home) => join(home, 'subagent-owners.jsonl');

/** @param {string} sessionId */
function safeSession(sessionId) {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'session';
  return cleaned.slice(0, 180);
}

/** @param {string} home @param {string} sessionId */
export const stopPath = (home, sessionId) => join(home, 'subagent-stop', `${safeSession(sessionId)}.json`);

/**
 * @param {string} line
 * @returns {Owner | null}
 */
function parseOwner(line) {
  try {
    const v = JSON.parse(line);
    if (typeof v !== 'object' || v === null) return null;
    const agentId = Reflect.get(v, 'agentId');
    const sessionId = Reflect.get(v, 'sessionId');
    const pid = Reflect.get(v, 'pid');
    const worktree = Reflect.get(v, 'worktree');
    const at = Reflect.get(v, 'at');
    if (typeof agentId !== 'string' || agentId === '') return null;
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (typeof worktree !== 'string' || worktree === '') return null;
    if (typeof at !== 'string' || at === '') return null;
    return { agentId, sessionId, pid, worktree, at };
  } catch {
    return null;
  }
}

/**
 * 读归属。没有文件是空；读不了（不是没有）→ { error }。坏行跳过。
 * @param {string} home
 * @returns {Owner[] | { error: string }}
 */
export function readOwners(home) {
  const file = ownersPath(home);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    return { error: `归属记录读不了（${file}）：${why(e)}` };
  }
  /** @type {Owner[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = parseOwner(line);
    if (row) out.push(row);
  }
  return out;
}

/**
 * 追加一行归属。
 * @param {string} home
 * @param {Owner} row
 */
export function appendOwner(home, row) {
  const file = ownersPath(home);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/**
 * 从工具回执里认 agentId。认 object 的 agentId / agent_id，或正文里的同名写法。
 * @param {unknown} response
 * @returns {string | null}
 */
export function agentIdOf(response) {
  if (typeof response === 'string') {
    const m = /(?:agentId|agent_id)\s*[:=]\s*["']?([A-Za-z0-9_.-]{1,120})/.exec(response);
    return m?.[1] ?? null;
  }
  if (Array.isArray(response)) {
    for (const item of response) {
      const id = agentIdOf(item);
      if (id) return id;
    }
    return null;
  }
  if (typeof response !== 'object' || response === null) return null;
  for (const key of ['agentId', 'agent_id']) {
    const v = Reflect.get(response, key);
    if (typeof v === 'string' && v !== '') return v;
  }
  for (const key of ['content', 'output', 'text']) {
    const id = agentIdOf(Reflect.get(response, key));
    if (id) return id;
  }
  return null;
}

/**
 * PostToolUse 里这一次是不是主会话派出的 Agent/Task，并且回执里已经有 agentId。
 * 子代理自己的工具调用（带 agent_id）不记。
 * @param {unknown} input
 * @param {{ pid: number, now?: () => Date }} deps
 * @returns {Owner | null}
 */
export function ownerFromTool(input, deps) {
  if (typeof input !== 'object' || input === null) return null;
  if (Reflect.get(input, 'agent_id')) return null;
  const tool = Reflect.get(input, 'tool_name') ?? Reflect.get(input, 'toolName');
  if (tool !== 'Agent' && tool !== 'Task') return null;
  const agentId = agentIdOf(Reflect.get(input, 'tool_response') ?? Reflect.get(input, 'toolResponse'));
  const sessionId = Reflect.get(input, 'session_id');
  const worktree = Reflect.get(input, 'cwd');
  const pid = deps.pid;
  if (typeof agentId !== 'string' || agentId === '') return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof worktree !== 'string' || worktree === '') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { agentId, sessionId, pid, worktree, at: (deps.now ?? (() => new Date()))().toISOString() };
}

/**
 * 派出成功就落一行。不是这种调用、写不进去都不抛。
 * @param {unknown} input
 * @param {{ home?: string, pid?: number, now?: () => Date }} [deps]
 * @returns {{ recorded: boolean, why?: string }}
 */
export function recordDispatch(input, deps = {}) {
  try {
    const row = ownerFromTool(input, { pid: deps.pid ?? process.ppid, now: deps.now ?? (() => new Date()) });
    if (!row) return { recorded: false, why: '不是带 agentId 的派工' };
    appendOwner(deps.home ?? fleetHome(), row);
    return { recorded: true };
  } catch (e) {
    return { recorded: false, why: why(e) };
  }
}

/**
 * 会话进程还在不在。signal 0 只询问，不杀进程。
 * @param {Owner} row
 */
export function sessionAlive(row) {
  try {
    process.kill(row.pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}

/**
 * 把停止写给归属会话（本机一份，由那个会话的 PostToolUse 读走）。不向进程发信号。
 * @param {string} home
 * @param {Owner} row
 * @param {() => Date} now
 */
export function deliverStop(home, row, now) {
  const file = stopPath(home, row.sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ agentId: row.agentId, sessionId: row.sessionId, at: now().toISOString() })}\n`);
}

/**
 * 本会话若有一份待执行的停止，读走并返回要告诉模型的那一句。没有就是 null。
 * @param {unknown} sessionId
 * @param {string} [home]
 * @returns {string | null}
 */
export function takeStopNotice(sessionId, home = fleetHome()) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const file = stopPath(home, sessionId);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    return null;
  }
  try {
    unlinkSync(file);
  } catch {
    // 读到了就交出去；删不掉的话下一次工具调用还会再说一遍
  }
  try {
    const v = JSON.parse(text);
    const agentId = typeof v === 'object' && v !== null ? Reflect.get(v, 'agentId') : undefined;
    if (typeof agentId !== 'string' || agentId === '') return null;
    return `归属会话收到停止：用 TaskStop 停掉 ${agentId}。不要按启动时间猜进程，不要杀整个进程。`;
  } catch {
    return null;
  }
}

/**
 * @param {string[]} argv
 * @param {{ home: string, alive?: (row: Owner) => boolean, send?: (row: Owner) => void, now?: () => Date }} deps
 * @returns {{ code: number, message: string }}
 */
export function agentsStop(argv, deps) {
  /** @param {string} message */
  const fail = (message) => ({ code: 1, message });
  const key = argv[0];
  if (typeof key !== 'string' || key.trim() === '') return fail('停不了：要给工作树或 agentId');
  const rows = readOwners(deps.home);
  if (!Array.isArray(rows)) return fail(`停不了：${rows.error}`);
  const hits = rows.filter((row) => row.agentId === key || row.worktree === key);
  if (hits.length === 0) return fail('停不了：没有这条归属记录');
  const alive = deps.alive ?? sessionAlive;
  const now = deps.now ?? (() => new Date());
  const send = deps.send ?? ((row) => deliverStop(deps.home, row, now));
  /** @type {Owner[]} */
  const live = [];
  for (const row of hits) if (alive(row)) live.push(row);
  if (live.length === 0) return fail('停不了：会话已不在');
  for (const row of live) send(row);
  return {
    code: 0,
    message: live.map((row) => `已向会话 ${row.sessionId} 发出停止（${row.agentId}）`).join('\n'),
  };
}

if (isMainModule(import.meta)) {
  const result = agentsStop(process.argv.slice(2), { home: fleetHome() });
  if (result.code === 0) process.stdout.write(`${result.message}\n`);
  else process.stderr.write(`${result.message}\n`);
  process.exit(result.code);
}
