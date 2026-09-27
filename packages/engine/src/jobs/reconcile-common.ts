// 每小时对账（jobs/hourly-reconcile.ts）这几部分共用的：读 Temporal 的口子、读写提醒的口子、每部分的结局，
// 写给人看的北京时间和时长。
import type { AlertRow } from '@fleet-dao/db';
import type { StageKind } from '@fleet-dao/shared';
import { STAGE_NAMES } from '../routing/names.ts';

/** 撤提醒、写再提醒时记的「谁」（notifications.resolved_by、操作记录的 actor_id）。 */
export const RECONCILE_ACTOR = 'engine:hourly-reconcile';

/** 是不是一个阶段的名字（目录名、报警标题里读出来的）：和选路给人看的阶段名同一张表。 */
export const isStage = (s: string): s is StageKind => Object.hasOwn(STAGE_NAMES, s);

/** 一条工作流此刻怎样：在跑；结束了（Temporal 的状态名：COMPLETED、FAILED、TERMINATED……）；没有这条（从没起过、结束太久被清掉）。 */
export type WorkflowState = { state: 'running' } | { state: 'closed'; status: string } | { state: 'missing' };

/** 在跑的工作流的 status 查询里要用的几样（需求、子任务都有）。 */
export interface WorkflowView {
  parked: boolean;
  /** 在等什么；挂起时 kind = human、detail 以「挂起：」开头、since 是挂起那一刻。 */
  waiting: { kind: string; detail: string; since: string } | null;
  doing: string;
  /** 子任务在等的人闸批准；需求没有这一项（null）。 */
  approval: { approvalId: string; state: string } | null;
}

export interface WorkflowReader {
  /** 查不了（连不上 Temporal、没权限）照抛：调用方记「没查成」，不当成「不在跑」。 */
  state(workflowId: string): Promise<WorkflowState>;
  /** 只对在跑的查；查不了、回的东西认不出照抛。 */
  view(workflowId: string): Promise<WorkflowView>;
}

/** 提醒的读写（真实现是 @fleet-dao/db 的同名查询）。 */
export interface AlertStore {
  listOpen(limit: number): Promise<{ alerts: AlertRow[]; truncated: boolean }>;
  byKey(dedupeKey: string): Promise<AlertRow | null>;
  /** 前缀对上的最新一条（处理没处理都算）。 */
  latestByPrefix(prefix: string): Promise<AlertRow | null>;
  /** 条件没了撤掉：正文开头写「已撤：why」、记操作记录。auditActor 不给就是 by。 */
  resolve(input: {
    dedupeKey: string;
    by: string;
    why: string;
    auditActor?: string;
  }): Promise<'ok' | 'already_resolved' | 'not_found'>;
  /** 报（没有就建、有了原地更新、处理过的重新打开）。 */
  raise(input: {
    dedupeKey: string;
    level: 'alert' | 'decision';
    taskId: string | null;
    title: string;
    body: string;
    link?: string | undefined;
  }): Promise<void>;
  /** 只在这个键还没有时插一条；有了（开着、处理过都算）不动。 */
  insertOnce(input: {
    dedupeKey: string;
    level: 'alert' | 'decision';
    taskId: string | null;
    title: string;
    body: string;
    link: string | null;
  }): Promise<{ created: boolean }>;
  /** 只改还开着的；已经处理掉的不替人打开。 */
  updateOpen(input: { dedupeKey: string; title?: string; body?: string }): Promise<'ok' | 'not_open'>;
}

/** 对账的一部分（工作树、两处核对、提醒）跑下来的样子。 */
export interface SweepPart {
  /** 这一部分整个没跑成（读不了工作树的根、列不了提醒）。 */
  failed?: string;
  /** 看了几个对象。 */
  scanned: number;
  /** 发现、处理了几个问题（删掉的残留树、改成要人拍的树、撤掉的过时提醒、再推的提醒）。 */
  found: number;
  /** 没查成的，一条一句：照实写进这一轮的 why，这一轮不记 ok。 */
  unchecked: string[];
}

export type ReconcileLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

export const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间的日子，例如 2026-09-26（再提醒一天一条按它分）。 */
export function beijingDate(at: Date): string {
  return new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时间「09-26 14:02」。 */
export function stamp(at: Date): string {
  const s = new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  COMPLETED: '跑完了',
  FAILED: '失败了',
  CANCELLED: '被取消了',
  TERMINATED: '被强行终止了',
  TIMED_OUT: '超时了',
  CONTINUED_AS_NEW: '换了新的一轮',
};

/** 不在跑的工作流怎么了（写进撤提醒的原因）。 */
export function notRunningWords(st: Exclude<WorkflowState, { state: 'running' }>): string {
  return st.state === 'missing'
    ? '这条工作流已经不在了（结束太久被清掉，或者从没起过）'
    : `工作流已经结束（${STATUS_WORDS[st.status] ?? st.status}）`;
}
