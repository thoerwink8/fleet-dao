// 本机会话（#1991，母单 #1990）：创始人电脑上在跑的 AI 会话，让法国的看板看得见。
// 创始人 2026-10-13：「我本机其实在做的任务……就好像我们现在在 marysim 里面做的任务，只要是在做的，有没有办法感知到？」
//
// 本机没有常驻后端、法国也连不进本机。做法：本机的钩子（agents/local-sessions/heartbeat.mjs，SessionStart / PreToolUse / Stop /
// SessionEnd 各一条）每次触发就写一份这个会话的心跳文件；一个定时任务（agents/local-sessions/push.mjs，Windows 计划任务每 2 分钟）
// 把心跳凑成一份 LocalSessionsReport，POST 给法国的 /api/nodes/sessions（和看板多机同一套通行证 FLEET_NODE_KEYS，环境编号按对上的
// 那把钥匙认）。法国落进 node_sessions（一个环境一行、覆盖写），看板单开一块「本机会话」，不混进「在跑的」（那是引擎的单）。
//
// 改这里之前必须知道：
// - 只送元信息：会话编号、仓、分支、工作树目录名、是不是子代理、起止时刻、最后一次动、最后在调的工具名。不送提示词、代码、命令参数、
//   文件路径（工作树只送目录名）。schema 用 strict，多一个字段就拒收：推送方哪天手滑多带了内容，法国不收。
// - 新鲜度两层：整块（法国多久没收到这台推来的，按收到的时刻算，不信对方时钟）；每个会话（多久没动，按推送方自己的钟算差，
//   再加上推来以后过了多久——不比对两台的钟）。
// - 收不到就是「没上报」（写上次收到在多久前，或从没收到），不画成 0 个会话、不画成空。
import { z } from 'zod';
import { Time } from './internal.ts';
import { NodeIdSchema } from './nodes.ts';

export const LOCAL_SESSIONS_SCHEMA_VERSION = 1;
/** 收本机会话的路径（在 /api 下）。和 NODE_REPORT_PATH 同一个头、同一套钥匙。 */
export const LOCAL_SESSIONS_PATH = '/nodes/sessions';
/** 推送方多久推一次（Windows 计划任务）。 */
export const LOCAL_SESSIONS_PUSH_EVERY_MS = 2 * 60_000;
/** 收到后多久以内整块算「在上报」：错过两轮多一点才算没上报。 */
export const LOCAL_SESSIONS_FRESH_MS = 5 * 60_000;
/**
 * 一个会话多久没动（没调工具、没开新的一轮）算「超过阈值没动」：每次调工具都刷新心跳，所以跑了很久的会话不会被误判；
 * 长时间想、等子代理时不调工具，15 分钟留足余量。和法国 node_reports 的新鲜度（3 分钟）不是一回事：那是整机快照的推送节奏。
 */
export const LOCAL_SESSION_IDLE_MS = 15 * 60_000;
/** 一轮做完（Stop）或会话收场（SessionEnd）之后多久以内算「刚停」；再往前的推送方不再推。 */
export const LOCAL_SESSION_RECENT_STOP_MS = 2 * 60 * 60_000;
/** 一份最多带几个会话。 */
export const LOCAL_SESSIONS_MAX = 200;
/** 一份最多多大（字节）。 */
export const LOCAL_SESSIONS_MAX_BYTES = 128 * 1024;

const short = (max: number) => z.string().min(1).max(max);

/** 最后一件事：工具（PreToolUse）、开会话（start）、一轮做完（stop）、会话收场（end）。 */
export const LocalSessionLastSchema = z.enum(['tool', 'start', 'stop', 'end']);

export const LocalSessionSchema = z
  .object({
    /** Claude Code 的会话编号（不透明的 UUID）。 */
    id: short(100),
    /** owner/name（origin 是 GitHub 时）或仓的目录名；不在 git 仓里是 null。 */
    repo: short(200).nullable(),
    /** 当前分支；分离头是 null。 */
    branch: short(200).nullable(),
    /** 在工作树里时是工作树的目录名（不送整条路径）；在主检出里是 null。 */
    worktree: short(200).nullable(),
    /** 子代理发的调用（钩子输入带 agent_id）。 */
    subagent: z.boolean(),
    /** 子代理的类型（Explore、general-purpose……）；不是子代理没有。 */
    agentType: short(100).optional(),
    startedAt: Time,
    lastSeenAt: Time,
    last: LocalSessionLastSchema,
    /** 最后在调的工具名（只名字，不带参数）。 */
    lastTool: short(100).nullable(),
  })
  .strict();
export type LocalSession = z.infer<typeof LocalSessionSchema>;

export const LocalSessionsReportSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_SESSIONS_SCHEMA_VERSION),
    /** 推送方的时钟。只拿来算「多久没动」的差，不和收的一方的钟比。 */
    reportedAt: Time,
    /** 那台机器给人看的名字。 */
    machine: short(60),
    sessions: z.array(LocalSessionSchema).max(LOCAL_SESSIONS_MAX),
    /** 推送方这边没读成的（心跳文件坏了、读不了），照实带上。 */
    problems: z.array(z.string().max(300)).max(20),
  })
  .strict();
export type LocalSessionsReport = z.infer<typeof LocalSessionsReportSchema>;

/** 一个会话此刻的状态：running 在跑；stopped 刚停（这一轮做完或会话收场）；idle 超过阈值没动。 */
export type LocalSessionState = 'running' | 'stopped' | 'idle';

/**
 * 这个会话此刻多久没动、算哪一态。age = 推送方的钟上「推的时刻 − 最后一次动」，再加收到以后过了多久（收的一方的钟）。
 * 时刻读不出抛错，不猜。
 */
export function localSessionState(
  s: Pick<LocalSession, 'lastSeenAt' | 'last'>,
  report: { reportedAt: string; receivedAt: string },
  now: Date,
): { state: LocalSessionState; idleMs: number } {
  const seen = Date.parse(s.lastSeenAt);
  const reported = Date.parse(report.reportedAt);
  const received = Date.parse(report.receivedAt);
  if ([seen, reported, received].some(Number.isNaN)) {
    throw new Error(`本机会话的时刻读不出：${s.lastSeenAt} / ${report.reportedAt} / ${report.receivedAt}`);
  }
  const idleMs = Math.max(0, reported - seen) + Math.max(0, now.getTime() - received);
  if (s.last === 'stop' || s.last === 'end') return { state: 'stopped', idleMs };
  return { state: idleMs >= LOCAL_SESSION_IDLE_MS ? 'idle' : 'running', idleMs };
}

// —— 接口形状 ——

const LocalSessionViewSchema = LocalSessionSchema.extend({
  state: z.enum(['running', 'stopped', 'idle']),
  idleMs: z.number().int().min(0),
});
export type LocalSessionView = z.infer<typeof LocalSessionViewSchema>;

/**
 * GET /nodes/sessions：每台推过本机会话的机器一项，加配了钥匙却从没推过的（never）。
 * - fresh：收到不到 LOCAL_SESSIONS_FRESH_MS，sessions 可信；
 * - stale：收到过，但已经过了——写「没上报」和上次收到在多久前，sessions 是那时候的（页面灰着画、写明是旧的）；
 * - never：配了钥匙、一次都没收到——写「没上报：从没收到」，没有 sessions。
 */
export const LocalSessionsNodeSchema = z.object({
  id: NodeIdSchema,
  freshness: z.enum(['fresh', 'stale', 'never']),
  machine: z.string().optional(),
  receivedAt: Time.optional(),
  reportedAt: Time.optional(),
  sessions: z.array(LocalSessionViewSchema),
  problems: z.array(z.string()),
});
export type LocalSessionsNode = z.infer<typeof LocalSessionsNodeSchema>;

export const LocalSessionsResponseSchema = z.object({
  asOf: Time,
  /** 这台（法国）没配 FLEET_NODE_KEYS：不收任何环境推来的，写原因，不当成「没有本机会话」。 */
  notWired: z.string().optional(),
  nodes: z.array(LocalSessionsNodeSchema),
});
export type LocalSessionsResponse = z.infer<typeof LocalSessionsResponseSchema>;
