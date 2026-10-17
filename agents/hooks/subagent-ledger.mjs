// Haiku 改代码的本机账本和收回策略（单 #2821，规矩在 agents/subagents/README.md「护栏」）。
// 两个本机文件，都在 ~/.fleet-dao/（环境变量 FLEET_DAO_HOME 可换，测试用）：
// - subagent-ledger.jsonl：账本，一行一次 Haiku 派工 {"at":"<ISO 时刻>","issue":<单号>}，调工具前钩子（pretool.mjs）派工放行时追加；
// - subagent-policy.json：收回策略 {"revoked":true,"reason":"…","at":"<ISO 时刻>","liftedAt":"…"}，`pnpm subagent:stats --enforce` 写、
//   `--lift` 恢复；钩子只读它。
// 钩子里不联网、只读这两个本机文件，要快。判法：
// 1. 「general-purpose 加 model: haiku」的派工（subagent_type 不写也算 general-purpose；斥候 Explore 等只读的不算）；
// 2. 策略写着收回 → 拦下，提示改派 Sonnet，附原因和时刻；策略文件读不懂 → 也拦并明说（不当成没收回）；
// 3. 交代里认出单号（先认「## 活：#N」，再认 `pnpm work claim N`），账本里这张单已有一次 Haiku 派工 → 拦下，提示换 Sonnet。
// 纯 node，agents-sync 原样装到 ~/.fleet-dao/hooks/，pretool.mjs 引它；packages/conventions 的 subagent-stats 也按路径动态引它读写策略。
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** @typedef {{ code: 2, message: string }} Block */
/** @typedef {{ revoked: boolean, reason?: string, at?: string, liftedAt?: string }} Policy */

/** 本机状态目录 */
export const fleetHome = () => process.env.FLEET_DAO_HOME || join(homedir(), '.fleet-dao');
/** @param {string} home */
export const policyPath = (home) => join(home, 'subagent-policy.json');
/** @param {string} home */
export const ledgerPath = (home) => join(home, 'subagent-ledger.jsonl');

/**
 * @param {unknown} o
 * @param {string} k
 * @returns {unknown}
 */
const prop = (o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined);
/** @param {unknown} e */
const errCode = (e) => prop(e, 'code');
/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * 派工交代里的单号：先认「## 活：#N」（行首），再认 pnpm work claim N。认不出 null。
 * @param {string} prompt
 * @returns {number | null}
 */
export function briefIssue(prompt) {
  const text = String(prompt ?? '');
  const heading = /^\s*#{1,6}\s*活\s*[:：]\s*#(\d+)/m.exec(text);
  const claim = /pnpm\s+work\s+claim\s+#?(\d+)/.exec(text);
  const m = heading ?? claim;
  const n = m?.[1] ? Number(m[1]) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 这次调用是不是「general-purpose 加 model haiku」的派工：是就回 { prompt }，不是 null。
 * 认不出输入、不是 Agent、没写 model、model 不是 haiku、subagent_type 不是工人（斥候等）都是 null。
 * @param {string} raw 钩子的原始输入
 * @returns {{ prompt: string } | null}
 */
export function haikuDispatch(raw) {
  /** @type {unknown} */
  let input;
  try {
    input = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  const tool = prop(input, 'tool_name') ?? prop(input, 'toolName');
  if (tool !== 'Agent' && tool !== 'Task') return null;
  const ti = prop(input, 'tool_input') ?? prop(input, 'toolInput');
  const model = prop(ti, 'model');
  if (typeof model !== 'string' || !/haiku/i.test(model)) return null;
  const type = prop(ti, 'subagent_type');
  if (type !== undefined && type !== 'general-purpose') return null;
  const prompt = prop(ti, 'prompt');
  return { prompt: typeof prompt === 'string' ? prompt : '' };
}

/**
 * 读收回策略。没有文件 → { revoked: false }；读不了或读不懂 → { error }。
 * @param {string} home
 * @returns {Policy | { error: string }}
 */
export function readPolicy(home) {
  const file = policyPath(home);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { revoked: false };
    return { error: `策略文件读不了（${file}）：${why(e)}` };
  }
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || typeof v.revoked !== 'boolean')
      throw new Error('不是 {"revoked": 布尔…}');
    /** @type {Policy} */
    const p = { revoked: v.revoked };
    for (const k of /** @type {const} */ (['reason', 'at', 'liftedAt']))
      if (typeof v[k] === 'string') p[k] = v[k];
    return p;
  } catch (e) {
    return { error: `策略文件读不懂（${file}）：${why(e)}` };
  }
}

/**
 * @param {string} home
 * @param {Policy} p
 */
function writePolicy(home, p) {
  const file = policyPath(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * 写收回。已经收回着就不覆盖（留第一次的原因和时刻）。策略文件读不懂时抛错，不盖掉它。
 * @param {string} home
 * @param {{ reason: string, at: string }} w
 * @returns {{ written: boolean, already: boolean }}
 */
export function revokePolicy(home, { reason, at }) {
  const cur = readPolicy(home);
  if ('error' in cur) throw new Error(cur.error);
  if (cur.revoked) return { written: false, already: true };
  writePolicy(home, { revoked: true, reason, at, ...(cur.liftedAt ? { liftedAt: cur.liftedAt } : {}) });
  return { written: true, already: false };
}

/**
 * 恢复：revoked 改 false，记下恢复时刻（之后 --enforce 只算这个时刻以后合并的 PR）。
 * @param {string} home
 * @param {string} at
 * @returns {{ lifted: boolean }}
 */
export function liftPolicy(home, at) {
  const cur = readPolicy(home);
  if ('error' in cur) throw new Error(cur.error);
  writePolicy(home, { revoked: false, liftedAt: at });
  return { lifted: cur.revoked };
}

/** @param {string} home */
export const stampPath = (home) => join(home, 'subagent-stats-stamp.json');

/**
 * 收轮前对账顺手跑 --enforce 的便条（subagent-stats-stamp.json）：startedAt、pid 记录上次已创建的进程，attemptedAt 控制失败重试，
 * at 和 ok 是 --enforce 上次跑完的时刻和成没成，report 是还没给人看的一句话（看过就清成 null）。读不了、读不懂都当没有。
 * @param {string} home
 * @returns {{ startedAt?: string, attemptedAt?: string, pid?: number, at?: string, ok?: boolean, report?: string | null }}
 */
export function readStamp(home) {
  try {
    const v = JSON.parse(readFileSync(stampPath(home), 'utf8'));
    return typeof v === 'object' && v !== null ? v : {};
  } catch {
    return {};
  }
}

/**
 * 把几项并进便条（别的项留着）。
 * @param {string} home
 * @param {Record<string, unknown>} patch
 */
export function mergeStamp(home, patch) {
  mkdirSync(home, { recursive: true });
  writeFileSync(stampPath(home), `${JSON.stringify({ ...readStamp(home), ...patch }, null, 2)}\n`);
}

/**
 * 读账本：{ at, issue } 的列表，坏行跳过。没有文件是空；读不了（不是没有）→ { error }。
 * @param {string} home
 * @returns {{ at: string, issue: number }[] | { error: string }}
 */
export function readLedger(home) {
  const file = ledgerPath(home);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    return { error: `账本读不了（${file}）：${why(e)}` };
  }
  /** @type {{ at: string, issue: number }[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (typeof v?.at === 'string' && Number.isSafeInteger(v?.issue)) out.push({ at: v.at, issue: v.issue });
    } catch {
      // 坏行不算
    }
  }
  return out;
}

/**
 * Haiku 派工要不要拦：收回了、策略读不懂、账本读不了、这张单已经派过一次，都拦。不是 Haiku 派工、没事都 null。
 * @param {string} raw
 * @param {{ home?: string }} [deps]
 * @returns {Block | null}
 */
export function haikuVerdict(raw, { home = fleetHome() } = {}) {
  const d = haikuDispatch(raw);
  if (!d) return null;
  const pol = readPolicy(home);
  if ('error' in pol) {
    return {
      code: 2,
      message: `fleet-guard：${pol.error}。没查成，不当成没收回：这次先改派 Sonnet（去掉 model 或写 "sonnet"），再修策略文件或 pnpm subagent:stats --lift。`,
    };
  }
  if (pol.revoked) {
    return {
      code: 2,
      message:
        `fleet-guard：Haiku 改代码已收回放宽（${pol.at ?? '时刻没记'}）：${pol.reason ?? '原因没记'}。改派 Sonnet：` +
        'general-purpose 去掉 model 或写 "sonnet"。恢复要看过原因再 pnpm subagent:stats --lift（规矩见 agents/subagents/README.md「护栏」）。',
    };
  }
  const issue = briefIssue(d.prompt);
  if (issue === null) return null;
  const rows = readLedger(home);
  if (!Array.isArray(rows)) {
    return {
      code: 2,
      message: `fleet-guard：${rows.error}。没查成这张单有没有派过 Haiku，不当成没派过：这次改派 Sonnet。`,
    };
  }
  const prev = rows.find((r) => r.issue === issue);
  if (prev) {
    return {
      code: 2,
      message:
        `fleet-guard：单 #${issue} 已在 ${prev.at} 派过一次 Haiku，不给 Haiku 第二次（护栏：Haiku 一次没过就换 Sonnet）。` +
        '改派 Sonnet：general-purpose 去掉 model 或写 "sonnet"。',
    };
  }
  return null;
}

/**
 * Haiku 派工放行之后记一行账本。不是 Haiku 派工、认不出单号都不记，说明为什么。记不上也不抛（只说原因）。
 * @param {string} raw
 * @param {{ home?: string, now?: () => Date }} [deps]
 * @returns {{ recorded: boolean, issue?: number, why?: string }}
 */
export function recordHaikuDispatch(raw, { home = fleetHome(), now = () => new Date() } = {}) {
  const d = haikuDispatch(raw);
  if (!d) return { recorded: false, why: '不是 Haiku 派工' };
  const issue = briefIssue(d.prompt);
  if (issue === null)
    return { recorded: false, why: '交代里认不出单号（要写「## 活：#N」或 pnpm work claim N）' };
  try {
    const file = ledgerPath(home);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: now().toISOString(), issue })}\n`);
    return { recorded: true, issue };
  } catch (e) {
    return { recorded: false, issue, why: `账本写不进去：${why(e)}` };
  }
}
