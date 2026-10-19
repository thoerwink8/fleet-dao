// 看门狗提醒的受控修复（#3033，POST /api/notifications/:id/repair；列表上每条提醒带 repair）。
// 以前普通 watchdog 提醒只有「处理」和链接，通知完就完事；这里让创始人按当前证据点一个动作，并知道有没有真的做成。
// 改这里之前必须知道：
// - 可点的动作是读时现算的（planAlert），不存、不借 decision_reason 假装「要你拍」。动作编号 = 种类 + 证据摘要
//   （任务行更新时刻、当前工作流、发版进度……）：证据变了编号就变，旧编号点不动（409 action_expired）。
// - 点的时候只收三样：服务端给的动作编号、incident（提醒编号 + 键 + 本次 raisedAt 的摘要）、幂等身份 requestId。
//   提醒已撤、incident 对不上、动作过期、上一次还在执行或结果未知，都是 409，不发任何副作用。同一 requestId 重放回原结果。
// - 首批只接现有能力：idle-running 的「继续」两下信号（同任务页的继续）；发版的重试 / 恢复引擎开关 / 撤掉暂停
//   （同 /france/release-recover 的请求文件）；其余一律只能「交给修复」——在 fleet-dao 开一张四节单（同一 incident 只一张）。
//   不加任意 shell、重启、配置写口；定时任务通用「立刻重跑」没有现成接口，不虚构。
// - 发信号 / 写请求文件只记 accepted（收到了），不撤卡：完成判据是重读原检测条件（verifyRecord），条件没恢复、读不到、回执未知
//   都保持未修复。卡仍由看门狗自己撤。
// - 要人本人拍的动作（恢复引擎开关、撤掉暂停）带 choice：选项、推荐、自由输入沿用「要你拍」的形状；只有「执行」那一项会执行，
//   先不动、自己输入、不答都不执行。
// - 状态落在设置表 alert.repair:<提醒编号>（版本号做 CAS：先写 executing 再动手，动手后写结果；中断后不自动重放）。
//   最终结算没写上（CAS 冲突或持久读写失败）时，回执不采用内存里算出的终态。设置页只列 SETTING_SCHEMAS 里的键，这条不会出现在设置页。每次写都带操作记录。
//   交付本修复的 PR 在「需求」栏写 Closes #3208，合并进默认分支后由 GitHub 关掉这张单。
// - idle-running 和原检测器共用阈值（包括自测预算），并绑定任务、仓和工作流 run；仅更新了时间不等于恢复。
// - 明确关联已有单（#3100，POST /api/notifications/:id/repair/link）：可信登录操作者指定这次告警由哪张现有单处理。只收受管仓 + 单号 +
//   服务端关联版本 + incident + requestId；服务端现读单子必须是 fleet-dao 里开着的 issue，并记下当时的任务 / 开放 PR 事实，
//   只记绑定：不开单、不派工、不记 verified。读不到、非 issue、错仓、已关闭一律拒绝，不回退成开单。
//   交给修复沿用这条绑定：每次先重新核实，单子失效就标 failed、绑定标 invalid，不开新单；已有进行中的任务 / 开放 PR 不再派工
//   （409 link_already_handled，绑定原样留着），没有才经原准入派一次。和开单抢同一事故走同一个设置版本 CAS，输的一方 409。
//   标题正文相似不自动认同根因。
// - 线上契约不加枚举（#3100 评审）：关联在设置表里存成内部的 link-existing / linked（StoredRecordSchema，只在这个文件里认），
//   出口一律投影——last 只给 AlertRepairRecordSchema 原有的 kind / state，关联只走视图的 linked 和关联端点自己的回执。

import { createHash } from 'node:crypto';
import { checkIssueBody, domainLabel, issueBodyTooLong, natureLabel } from '@fleet-dao/conventions';
import { isIdleRunningStale } from '@fleet-dao/core/idle-running';
import { listRunningEngineTasks } from '@fleet-dao/db';
import {
  ALERT_REPAIR_KINDS,
  ALERT_REPAIR_STATES,
  type AlertRepairAction,
  type AlertRepairKind,
  type AlertRepairLink,
  AlertRepairLinkSchema,
  type AlertRepairRecord,
  AlertRepairRecordSchema,
  type AlertRepairView,
  DecisionOptionsSchema,
  ExecuteAlertRepairRequest,
  ExecuteAlertRepairResponse,
  LinkAlertRepairRequest,
  LinkAlertRepairResponse,
  RELEASE_RECOVER_ACTION,
  RELEASE_RECOVER_WORD,
  type ReleaseRecover,
  type ReleaseRecoverKind,
  type Task,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { continueSignals } from './continue-signals.ts';
import type { Deps } from './deps.ts';
import { readEngineMaster } from './engine-switch.ts';
import { parseTrainState } from './france-release.ts';
import { ApiError, readJson, reply } from './http.ts';
import {
  type Actor,
  type AuditVia,
  type NotificationRecord,
  type PullRequestRecord,
  type Store,
  WorkflowGoneError,
  WorkflowTargetNotFoundError,
} from './ports.ts';
import { readRecover } from './release-card.ts';
import { recoverRequestText, requestBy } from './release-request.ts';
import type { RequestIssuePort } from './request-issue.ts';
import { findSelfRepo } from './self-repo.ts';
import type { CockpitEnv } from './session.ts';
import { taskWorkflowIdForTask } from './temporal.ts';
import { isTaskFinished } from './views.ts';

export const REPAIR_SETTING_PREFIX = 'alert.repair:';
export const repairSettingKey = (notificationId: string): string =>
  `${REPAIR_SETTING_PREFIX}${notificationId}`;
const IDLE_PREFIX = 'watchdog:idle-running:';
const RELEASE_KEY = /^watchdog:release:train:([0-9a-f]{7,40}):(running|failed)$/;
/** 读 Temporal 查工作流最多等多久：列表页在等，连不上不能拖垮整页。 */
const READ_TIMEOUT_MS = 4_000;
/** 找一条提醒最多翻几页（每页 200 条）：先翻没处理的，再翻全部。 */
const FIND_PAGES = 25;
/** 「交给修复」开的单贴缺陷类别和引擎故障查询轴；不贴「要人拍」「本机做」，拉不拉由现有准入决定。 */
const REPAIR_ISSUE_LABELS = ['缺陷', domainLabel('engine'), natureLabel('bug')] as const;
const REPAIR_ISSUE_KEY_PREFIX = 'alert-repair:';

/**
 * 设置表里存的一条：线上契约的修复记录之外，还可能是一条明确关联（kind=link-existing、state=linked，只在这个文件里认），
 * 或带着关联元数据 link 的交给修复记录。出口一律经 wireLast 投影：last 只给线上原有的 kind / state，关联只进 linked。
 */
const LINK_KIND = 'link-existing';
const StoredRecordSchema = AlertRepairRecordSchema.extend({
  kind: z.enum([...ALERT_REPAIR_KINDS, LINK_KIND]),
  state: z.enum([...ALERT_REPAIR_STATES, 'linked']),
  link: AlertRepairLinkSchema.optional(),
});
type StoredRecord = z.infer<typeof StoredRecordSchema>;

/** 存的记录在线上 last 里长什么样：关联本身不是一次修复动作，不进 last；带的 link 也剥掉（它另走 linked）。 */
function wireLast(rec: StoredRecord | undefined): AlertRepairRecord | undefined {
  if (!rec || rec.kind === LINK_KIND) return undefined;
  const { link: _link, ...rest } = rec;
  const parsed = AlertRepairRecordSchema.safeParse(rest);
  return parsed.success ? parsed.data : undefined;
}

/** 修复端点回执里的 repair：只会是线上原有的 kind / state，内部的关联记录走不到这里（走到就是写错了，500 不冒充）。 */
function wireRepair(rec: StoredRecord): AlertRepairRecord {
  const wire = wireLast(rec);
  if (!wire) throw new ApiError(500, 'bad_response_shape', '内部的关联记录不能当修复结果回给页面');
  return wire;
}

/** 视图里的 last 和 linked：关联只给这一代事故的（上一代的绑定不沿用到新代次）。 */
function wireOf(rec: StoredRecord, incident: string): Pick<AlertRepairView, 'last' | 'linked'> {
  const last = wireLast(rec);
  return {
    ...(last ? { last } : {}),
    ...(rec.link && rec.incident === incident ? { linked: rec.link } : {}),
  };
}

/** idle-running 现读：这张任务现在是不是还「在干活、引擎做、没有开着的会话」。 */
export interface IdleTaskFact {
  taskId: string;
  updatedAt: string | null;
  doing: string | null;
  /** runs.ended_at 为空的行数。 */
  openRuns: number;
}

/** 修复动作要的、Store 之外的外部能力。main.ts 正式装配给真的；没给的那一项对应动作写「没接上」，不假装能做。 */
export interface AlertRepairPort {
  /** 这张任务是 running 且 executor=engine 的行就回它；不是（做完了、停了、本机领了）回 null；读不到抛错。 */
  idleTask?(taskId: string): Promise<IdleTaskFact | null>;
  /** 开单（引擎机器人，按 key 幂等）。 */
  openIssue?: RequestIssuePort['openIssue'];
  /** 现读一张单开没开着（明确关联已有单用；是 PR 抛 NOT_AN_ISSUE，404 抛 NOT_FOUND，没读到抛错）。 */
  readIssueState?: RequestIssuePort['readIssueState'];
  dispatchIssue?(
    repo: { owner: string; name: string },
    issueNumber: number,
    operator: string,
  ): Promise<{ ok: boolean; text: string }>;
}

export function pgAlertRepair(
  db: Parameters<typeof listRunningEngineTasks>[0],
  issues:
    | (Pick<RequestIssuePort, 'openIssue'> & Partial<Pick<RequestIssuePort, 'readIssueState'>>)
    | undefined,
  dispatchIssue?: AlertRepairPort['dispatchIssue'],
): AlertRepairPort {
  const readState = issues?.readIssueState;
  return {
    async idleTask(taskId) {
      const row = (await listRunningEngineTasks(db)).find((r) => r.taskId === taskId);
      if (!row) return null;
      return {
        taskId,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
        doing: row.doing,
        openRuns: row.openRuns,
      };
    },
    ...(issues ? { openIssue: (input) => issues.openIssue(input) } : {}),
    ...(readState ? { readIssueState: (input) => readState.call(issues, input) } : {}),
    ...(dispatchIssue ? { dispatchIssue } : {}),
  };
}

const digest = (...parts: (string | number | boolean | null | undefined)[]): string =>
  createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('\u0000'))
    .digest('hex')
    .slice(0, 12);

/** 同 key 重开用 raisedAt 区分事故；开放期间重复 raise 不换代。老记录以创建时刻保守兼容。 */
export const incidentOf = (
  n: Pick<NotificationRecord, 'id' | 'dedupeKey' | 'createdAt' | 'raisedAt'>,
): string => digest(n.id, n.dedupeKey, n.raisedAt ?? n.createdAt);

/** 只有看门狗报的 alert 级提醒有受控修复；「要你拍」走回答，日报不修。 */
export function isRepairable(n: Pick<NotificationRecord, 'level' | 'dedupeKey'>): boolean {
  return n.level === 'alert' && (n.dedupeKey?.startsWith('watchdog:') ?? false);
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what}超过 ${READ_TIMEOUT_MS / 1000} 秒没读到`)),
          READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function factTime(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('任务更新时间读不懂，不能核成恢复');
  return date;
}

// —— 动作计划（读时现算）——

interface RunContext {
  deps: Deps;
  n: NotificationRecord;
  actor: Actor;
  via: AuditVia;
  user: { displayName: string };
  at: string;
  priorIssue?: AlertRepairRecord['issue'];
  /** 同事故操作者明确关联的绑定：有它就不开新单，沿用前每次重新核实。 */
  priorLink?: AlertRepairLink;
}
interface Outcome {
  /** link-active：关联的单已有进行中的任务 / 开放 PR，什么都没做；路由把绑定原样放回去并回 409，不记成一次修复。 */
  state: 'accepted' | 'failed' | 'unknown' | 'handed' | 'link-active';
  text: string;
  baseline?: string;
  issue?: NonNullable<AlertRepairRecord['issue']>;
  link?: AlertRepairLink;
}
type Planned = AlertRepairAction & { run: (ctx: RunContext) => Promise<Outcome> };
interface Plan {
  actions: Planned[];
  problems: string[];
}

/** 一次请求里发版事实只读一遍（列表里几条发版提醒共用）。 */
interface Memo {
  release?: Promise<ReleaseSnap>;
}
type ReleaseSnap =
  | {
      ok: true;
      recover: ReleaseRecover;
      pending: boolean;
      marker: boolean;
      train: {
        status: string;
        phaseIndex: number | null;
        targetSha: string | null;
        updatedAt: string | null;
        startedAt: string | null;
      } | null;
    }
  | { ok: false; why: string };

function readReleaseSnap(deps: Deps, memo: Memo): Promise<ReleaseSnap> {
  memo.release ??= (async (): Promise<ReleaseSnap> => {
    const port = deps.releaseRequest;
    if (!port) return { ok: false, why: '这台后端没接上发布请求（开发、内存版），发版的恢复动作用不了' };
    try {
      const installed = await port.receiverInstalled();
      if (!installed.ok) return { ok: false, why: installed.why };
      const [recover, pending, files] = await Promise.all([
        readRecover(port, deps.franceRelease, deps.store),
        port.pendingRequest(),
        deps.franceRelease?.readStateFiles(),
      ]);
      let train: Extract<ReleaseSnap, { ok: true }>['train'] = null;
      if (files?.stateJson != null) {
        const parsed = parseTrainState(files.stateJson);
        if (!parsed.ok) return { ok: false, why: parsed.why };
        train = {
          status: parsed.status,
          phaseIndex: parsed.phaseIndex,
          targetSha: parsed.targetSha,
          updatedAt: parsed.updatedAt,
          startedAt: parsed.timeline?.startedAt ?? null,
        };
      }
      return { ok: true, recover, pending, marker: files?.marker ?? false, train };
    } catch (err) {
      return { ok: false, why: `读发版现状没成：${errMessage(err)}` };
    }
  })();
  return memo.release;
}

const sameSha = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
};

async function workflowIdOf(
  deps: Deps,
  task: { id: string; repoId: string; issueNumber: number },
): Promise<string> {
  const lookup = deps.workflows.runningTaskWorkflow;
  if (!lookup) return taskWorkflowIdForTask(deps.store, task.id);
  const repo = await deps.store.getRepo(task.repoId);
  if (!repo) return taskWorkflowIdForTask(deps.store, task.id);
  return within(lookup({ owner: repo.owner, name: repo.name }, task.issueNumber), '查在跑的任务工作流');
}

/** 任务继续：同任务页「继续」的两发信号，先继续、再叫醒。每发先记操作记录再发。 */
function runTaskRecover(taskId: string, workflowId: string, runId: string, baseline: string) {
  return async (ctx: RunContext): Promise<Outcome> => {
    const { deps } = ctx;
    const [cont, wake] = continueSignals(ctx.actor.id);
    if (!cont || !wake) return { state: 'failed', text: '继续信号没配全，没发出去' };
    const sent: string[] = [];
    for (const [signal, action] of [
      [cont, 'task.resume'],
      [wake, 'task.routeWake'],
    ] as const) {
      const { name: _name, by: _by, ...detail } = signal;
      const audit = {
        actor: ctx.actor,
        action,
        target: `task:${taskId}`,
        after: detail,
        reason: `看门狗提醒 ${ctx.n.dedupeKey} 的受控修复`,
        via: ctx.via,
        ok: true as const,
      };
      await deps.store.appendAudit(audit);
      try {
        await deps.workflows.signal(workflowId, signal, runId);
        sent.push(action);
      } catch (err) {
        const definite = err instanceof WorkflowGoneError || err instanceof WorkflowTargetNotFoundError;
        const error = definite ? err.message : `回执未知：${errMessage(err)}`;
        await deps.store.appendAudit({ ...audit, ok: false, error }).catch((auditErr: unknown) => {
          deps.log.error('修复信号没发成，这条失败记录也没写进去', {
            error,
            auditError: errMessage(auditErr),
          });
        });
        if (sent.length > 0) {
          return {
            state: 'accepted',
            baseline,
            text: `继续信号已受理，但路由叫醒没发出去：${error}。等任务行动起来才算修好`,
          };
        }
        return definite
          ? { state: 'failed', text: `信号没发出去：${error}` }
          : { state: 'unknown', text: `信号发出去了没有不知道（${error}），不自动重试，请先看任务现状` };
      }
    }
    return {
      state: 'accepted',
      baseline,
      text: '继续信号已受理（收到了，不等于修好）：任务行动起来、起了会话才算修好，卡由看门狗自己撤',
    };
  };
}

async function planIdle(deps: Deps, n: NotificationRecord, out: Plan): Promise<void> {
  const taskId = (n.dedupeKey ?? '').slice(IDLE_PREFIX.length);
  if (n.taskId && n.taskId !== taskId) {
    out.problems.push('提醒挂的任务和提醒键里的任务对不上，不猜是哪一张');
    return;
  }
  const task = await deps.store.getTask(taskId);
  if (!task) {
    out.problems.push(`提醒键里的任务 ${taskId} 不在库里`);
    return;
  }
  if (isTaskFinished(task)) {
    out.problems.push(`条件已变：任务已经结束（${task.state}）`);
    return;
  }
  const port = deps.alertRepair;
  if (!port?.idleTask) {
    out.problems.push('没接上任务现读（开发环境），「任务继续」用不了');
    return;
  }
  let fact: IdleTaskFact | null;
  try {
    fact = await within(port.idleTask(taskId), '读任务行');
  } catch (err) {
    out.problems.push(`任务现状读不到：${errMessage(err)}`);
    return;
  }
  if (fact === null) {
    out.problems.push('条件已变：任务现在不是「引擎做、在干活」了，等看门狗下一轮撤卡');
    return;
  }
  if (fact.taskId !== taskId) throw new Error('任务现读返回了另一张任务');
  if (
    !isIdleRunningStale(
      {
        ...fact,
        state: 'running',
        executor: 'engine',
        updatedAt: factTime(fact.updatedAt),
      },
      deps.now(),
    )
  ) {
    out.problems.push(
      fact.openRuns > 0
        ? '条件已变：任务现在有开着的会话了，等看门狗下一轮撤卡'
        : '条件已变：任务更新时间仍在原检测器允许范围内，等看门狗下一轮撤卡',
    );
    return;
  }
  if (task.paused !== undefined) {
    out.problems.push(`这张单被人暂停了（${task.paused}）：到任务页点「继续」，这里不替人解开`);
    return;
  }
  let workflowId: string;
  let runId: string;
  try {
    workflowId = await workflowIdOf(deps, task);
    if (!deps.workflows.taskWorkflowExecution) throw new Error('没有精确工作流 run 现读能力');
    const execution = await within(deps.workflows.taskWorkflowExecution(workflowId), '查任务工作流 run');
    if (execution.workflowId !== workflowId || !execution.runId || !execution.running)
      throw new Error('当前工作流没有在跑的具体 run');
    runId = execution.runId;
  } catch (err) {
    out.problems.push(`任务的工作流找不到：${errMessage(err)}`);
    return;
  }
  const repo = await deps.store.getRepo(task.repoId);
  out.actions.push({
    id: `task-recover:${digest(taskId, fact.updatedAt, workflowId, runId)}`,
    kind: 'task-recover',
    label: '叫醒任务继续',
    detail: `给任务 #${task.issueNumber} 的当前工作流发「继续」和路由叫醒（同任务页的继续）；任务行动起来才算修好`,
    target: {
      taskId,
      issueNumber: task.issueNumber,
      workflowId,
      workflowRunId: runId,
      ...(repo ? { repo: { owner: repo.owner, name: repo.name } } : {}),
    },
    run: runTaskRecover(taskId, workflowId, runId, fact.updatedAt ?? 'none'),
  });
}

const RELEASE_LABEL: Record<ReleaseRecoverKind, { kind: AlertRepairKind; label: string }> = {
  retry: { kind: 'release-retry', label: '重试发版' },
  restore: { kind: 'release-restore', label: '恢复引擎开关' },
  abort: { kind: 'release-abort', label: '撤掉暂停' },
};

/** 要人本人拍的动作：选项、推荐、自由输入，沿用「要你拍」的形状；只有 do 执行。 */
function choiceFor(label: string, detail: string) {
  return {
    options: DecisionOptionsSchema.parse([
      { id: 'do', label: `执行：${label}`, detail, recommended: '提醒的条件已核实，这是现有的恢复入口' },
      { id: 'hold', label: '先不动', detail: '什么都不做，提醒留着', keepsOpen: true },
    ]),
    allowText: true as const,
  };
}

function runRelease(kind: ReleaseRecoverKind, sha: string | null, baseline: string) {
  return async (ctx: RunContext): Promise<Outcome> => {
    const port = ctx.deps.releaseRequest;
    if (!port) return { state: 'failed', text: '这台后端没接上发布请求，没写' };
    const by = requestBy(ctx.user.displayName);
    const entry = {
      actor: ctx.actor,
      action: RELEASE_RECOVER_ACTION[kind],
      target: sha === null ? 'release:train' : `commit:${sha.slice(0, 12)}`,
      after: { kind, by, ...(sha === null ? {} : { sha }) },
      reason: `${RELEASE_RECOVER_WORD[kind]}（看门狗提醒 ${ctx.n.dedupeKey} 的受控修复）`,
      via: ctx.via,
    } as const;
    await ctx.deps.store.appendAudit({ ...entry, ok: true });
    try {
      await port.writeRequest(recoverRequestText(kind, sha, ctx.at, by));
    } catch (err) {
      const exists = (err as { code?: string }).code === 'EEXIST';
      const error = exists ? 'request_pending' : errMessage(err);
      await ctx.deps.store.appendAudit({ ...entry, ok: false, error }).catch(() => undefined);
      return {
        state: 'failed',
        text: exists ? '上一份发布请求还没被法国接走，这次没写' : `请求没写出去：${error}`,
      };
    }
    return {
      state: 'accepted',
      baseline,
      text: '请求已写出（法国上的接活单元还没确认执行）：进度记录变了才算修好',
    };
  };
}

async function planRelease(deps: Deps, n: NotificationRecord, memo: Memo, out: Plan): Promise<void> {
  const match = RELEASE_KEY.exec(n.dedupeKey ?? '');
  if (!match) {
    out.problems.push('这条发版提醒的键认不出是哪一趟，没有可自动执行的恢复');
    return;
  }
  const keySha = match[1] ?? '';
  const snap = await readReleaseSnap(deps, memo);
  if (!snap.ok) {
    out.problems.push(snap.why);
    return;
  }
  const { train, recover } = snap;
  if (!train?.startedAt || !train.targetSha || !sameSha(train.targetSha, keySha)) {
    out.problems.push('条件已变：发版进度记录里这一趟的提交和提醒对不上，不替另一趟动手');
    return;
  }
  if (snap.pending) {
    out.problems.push('上一份发布请求还没被法国接走，先等它');
    return;
  }
  const kinds = (['retry', 'restore', 'abort'] as const).filter((k) => recover[k] !== null);
  if (kinds.length === 0) {
    out.problems.push(
      `发版进度现在是 ${train.status}，现有的重试 / 恢复 / 撤掉暂停入口此刻都没开（进度在走时不替它动手）`,
    );
    return;
  }
  const baseline = `${train.status}|${train.phaseIndex ?? ''}|${train.targetSha}|${snap.marker}`;
  for (const kind of kinds) {
    const { kind: repairKind, label } = RELEASE_LABEL[kind];
    const sha = kind === 'retry' ? (recover.retry?.sha ?? null) : null;
    const detail =
      kind === 'retry'
        ? `从停下的那一步接着走（目标 ${train.targetSha.slice(0, 12)}）：写重试请求，法国上的单元接活`
        : kind === 'restore'
          ? '把引擎总开关恢复成发版前的样子：写恢复请求，法国上的单元接活'
          : (recover.abort?.text ?? '撤掉这一趟的暂停标记');
    out.actions.push({
      id: `${repairKind}:${digest(kind, train.status, train.phaseIndex, train.targetSha, train.startedAt, train.updatedAt, snap.marker)}`,
      kind: repairKind,
      label,
      detail: clip(detail, 300),
      target: { sha: train.targetSha, releaseStartedAt: train.startedAt },
      ...(kind === 'retry' ? {} : { choice: choiceFor(label, clip(detail, 280)) }),
      run: runRelease(kind, sha, baseline),
    });
  }
}

const SCENE_MAX = 3000;
const MODULES: [prefix: string, modules: string][] = [
  [IDLE_PREFIX, 'packages/engine/src/jobs/idle-running.ts、packages/engine/src/jobs/watchdog.ts'],
  ['watchdog:release:', 'packages/engine/src/jobs/release-watch.ts、packages/engine/src/jobs/watchdog.ts'],
  ['watchdog:job:', 'packages/engine/src/jobs/watchdog.ts'],
];

/** 交给修复开的单：四节齐，「怎么算做完」只写 diff 里看得见的条目。 */
export function repairIssueBody(n: Pick<NotificationRecord, 'id' | 'title' | 'body' | 'dedupeKey'>): string {
  const key = n.dedupeKey ?? n.id;
  const modules = MODULES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? '暂无';
  const plain = (s: string) => s.replace(/\r\n?/g, '\n');
  return [
    '## 场景',
    '',
    clip([plain(n.title), plain(n.body)].filter(Boolean).join('\n\n'), SCENE_MAX),
    '',
    `这条看门狗提醒（键 ${key}）没有可直接执行的修复，创始人在驾驶舱点了「交给修复」。`,
    '',
    '## 原话',
    '',
    `无（AI 发现：看门狗提醒 ${key}，创始人在驾驶舱点了「交给修复」）`,
    '',
    '## 已知的模块',
    '',
    modules,
    '',
    '## 怎么算做完',
    '',
    `- 提醒 ${key} 的触发条件不再成立（看门狗下一轮自己撤）`,
    '- 造成这条提醒的根因已改掉，diff 里看得到对应的代码、配置或测试改动',
    '',
  ].join('\n');
}

// —— 明确关联已有单（#3100）——

/** 一张单的开放 PR 最多读这么多条；满了就当没读全。 */
const LINK_PR_PAGE = 50;

const sameRepo = (a: { owner: string; name: string }, b: { owner: string; name: string }): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

const issueRef = (repo: { owner: string; name: string }, number: number): string =>
  `${repo.owner}/${repo.name}#${number}`;

/**
 * 现读核实关联目标：必须是受管 fleet-dao 里开着的 issue（PR、错仓、已关闭、404、没权限、读不到都抛 ApiError），
 * 并记下此刻的任务 / 开放 PR 事实。调用方遇到抛错只能拒绝或标失效，不能回退成开单。
 */
async function inspectLinkTarget(
  deps: Deps,
  target: { repo: { owner: string; name: string }; number: number },
): Promise<{
  issue: AlertRepairLink['issue'];
  facts: Pick<AlertRepairLink, 'stage' | 'taskId' | 'prNumber'>;
}> {
  const read = deps.alertRepair?.readIssueState;
  const self = await findSelfRepo(deps.store);
  if (!read || !self)
    throw new ApiError(
      409,
      'link_unavailable',
      '这台后端没接上 GitHub 读单，或受管的仓里没有 fleet-dao，不能关联已有单',
    );
  if (!sameRepo(target.repo, self))
    throw new ApiError(409, 'link_wrong_repo', `只能关联 ${self.owner}/${self.name} 里的单，不是这个仓`);
  const repo = { owner: self.owner, name: self.name };
  let state: Awaited<ReturnType<typeof read>>;
  try {
    state = await within(read({ repo, issueNumber: target.number }), '读关联的单');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'NOT_AN_ISSUE')
      throw new ApiError(409, 'link_not_issue', `${issueRef(repo, target.number)} 是 PR，不是 issue`);
    if (code === 'NOT_FOUND')
      throw new ApiError(404, 'link_issue_not_found', `${issueRef(repo, target.number)} 不存在`);
    if (code === 'FORBIDDEN' || code === 'AUTH_FAILED')
      throw new ApiError(502, 'link_issue_forbidden', `机器人没有权限读 ${issueRef(repo, target.number)}`);
    throw new ApiError(
      502,
      'link_issue_unreadable',
      `读 ${issueRef(repo, target.number)} 没成：${clip(errMessage(err), 200)}`,
    );
  }
  if (state.state !== 'open')
    throw new ApiError(409, 'link_issue_closed', `${issueRef(repo, target.number)} 已经关闭，不能当作在处理`);
  let facts: [Task | null, PullRequestRecord[]];
  try {
    facts = await Promise.all([
      deps.store.findTaskByIssue(self.id, target.number),
      // 在库里按仓和挂的单精确筛，不读全局前 N 条再筛（别的仓 PR 一多，目标 PR 会被截掉，误判成没有 PR 再派一次）
      deps.store.listPullRequests({
        state: 'open',
        repoId: self.id,
        issueNumber: target.number,
        limit: LINK_PR_PAGE,
      }),
    ]);
  } catch (err) {
    throw new ApiError(
      502,
      'link_facts_unreadable',
      `读 ${issueRef(repo, target.number)} 的任务 / PR 事实没成：${clip(errMessage(err), 200)}`,
    );
  }
  const [task, prs] = facts;
  // 满一页就是没读全：不当成「读到的就是全部」，按读不到处理（不派工）
  if (prs.length >= LINK_PR_PAGE)
    throw new ApiError(
      502,
      'link_facts_unreadable',
      `${issueRef(repo, target.number)} 的开放 PR 一页没读完（至少 ${LINK_PR_PAGE} 条），不能确认现场`,
    );
  const worker = task && !isTaskFinished(task) && task.state !== 'stalled' ? task : undefined;
  // 精确查询之外再核一遍仓和单：替身或老实现忽略了筛选条件，也不会把别处的 PR 当成这张单的
  const pr = prs.find((p) => p.repoId === self.id && p.issueRefs?.includes(target.number));
  return {
    issue: {
      repo,
      number: target.number,
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${target.number}`,
    },
    facts: {
      stage: pr ? 'pr-open' : worker ? 'worker-active' : 'linked',
      ...(worker ? { taskId: worker.id } : {}),
      ...(pr ? { prNumber: pr.number } : {}),
    },
  };
}

function linkText(link: Pick<AlertRepairLink, 'issue' | 'stage' | 'prNumber'>): string {
  const ref = issueRef(link.issue.repo, link.issue.number);
  const stage = {
    linked: '已关联，待处理',
    'worker-active': '已有进行中的任务',
    'pr-open': `已有开放 PR #${link.prNumber}`,
  }[link.stage];
  return `已明确关联 ${ref}（${stage}）：只绑定，没开单、没派工`;
}

/** 绑定换上最新核实的事实：阶段、任务、PR 照现读的写，失效标记去掉；关联那一刻的版本、身份、操作者不动。 */
function refreshLink(link: AlertRepairLink, facts: Awaited<ReturnType<typeof inspectLinkTarget>>['facts']) {
  const { invalid: _invalid, taskId: _taskId, prNumber: _prNumber, ...keep } = link;
  const next = { ...keep, ...facts };
  return { ...next, text: linkText(next) };
}

/** 只存一条关联（kind=link-existing、state=linked，内部用）：不是一次修复动作，线上 last 不给它。 */
function linkRecord(link: AlertRepairLink): StoredRecord {
  return {
    incident: link.incident,
    actionId: link.actionId,
    kind: LINK_KIND,
    target: { repo: link.issue.repo, issueNumber: link.issue.number },
    requestId: link.requestId,
    at: link.at,
    by: link.by,
    state: 'linked',
    text: link.text,
    issue: { ...link.issue, created: false },
    link,
  };
}

/** 关联版本：事故、受管仓、同事故现有修复状态一变就变，旧编号点不动。 */
function linkVersion(incident: string, self: { owner: string; name: string }, last?: StoredRecord): string {
  return `link-existing:${digest(incident, self.owner, self.name, last?.state, last?.requestId)}`;
}

/** 同事故现有记录允许再关联吗：没有、或确定没做成且没绑过单的才行；其余（在途 / 已受理 / 已绑单 / 已开单）一律拒绝，不覆盖。 */
function linkBlocked(last: StoredRecord | undefined): ApiError | undefined {
  if (!last) return undefined;
  if (last.state === 'executing' || last.state === 'unknown')
    return new ApiError(409, 'repair_in_flight', '上一次还在执行或结果未知，不自动覆盖：请先核实现场');
  if (last.state === 'accepted')
    return new ApiError(409, 'repair_pending_verify', '上一次已经受理，还没核实恢复：不覆盖');
  if (last.issue || last.link || last.state === 'handed' || last.state === 'verified')
    return new ApiError(
      409,
      last.link ? 'already_linked' : 'link_has_issue',
      '这次事故已经绑定或开过修复单，不改绑：先核实原单',
    );
  return undefined;
}

function runHand(incident: string) {
  return async (ctx: RunContext): Promise<Outcome> => {
    const { deps, n } = ctx;
    const port = deps.alertRepair;
    const open = port?.openIssue;
    const self = await findSelfRepo(deps.store);
    if (!open || !self)
      return { state: 'failed', text: '开单没接上（缺机器人凭据或受管的仓里没有 fleet-dao），没开' };
    const body = repairIssueBody(n);
    const checked = checkIssueBody(body);
    if (!checked.ok) return { state: 'failed', text: `修复单正文不合格，没开：${checked.why}` };
    const tooLong = issueBodyTooLong(body);
    if (tooLong) return { state: 'failed', text: tooLong };
    try {
      const repo = { owner: self.owner, name: self.name };
      let link = ctx.priorLink;
      if (link) {
        // 操作者明确关联过：每次重新核实；失效就停，不回退成开新单，也不对失效的单派工
        const bound = { ...link.issue, created: false };
        const ref = issueRef(link.issue.repo, link.issue.number);
        try {
          link = refreshLink(
            link,
            (await inspectLinkTarget(deps, { repo: link.issue.repo, number: link.issue.number })).facts,
          );
        } catch (err) {
          const why = clip(errMessage(err), 300);
          // 读不到 / 没读全（GitHub 网络错误、任务 / PR 事实读不全）：现场不明，不派工，但不把绑定判成失效
          if (err instanceof ApiError && err.status === 502)
            return {
              state: 'failed',
              issue: bound,
              link,
              text: `关联的单 ${ref} 现场没读全：${why}；没开新单、没派工，读得到了再点`,
            };
          return {
            state: 'failed',
            issue: bound,
            link: { ...link, invalid: { at: deps.now().toISOString(), text: why } },
            text: `关联的单 ${ref} 已失效：${why}；没开新单、没派工`,
          };
        }
        if (link.stage !== 'linked')
          return {
            state: 'link-active',
            link,
            text: `关联的单 ${ref} 已有${link.stage === 'pr-open' ? `开放 PR #${link.prNumber}` : '进行中的任务'}在处理，不再派工`,
          };
      }
      const issue =
        (link ? { ...link.issue, created: false } : ctx.priorIssue) ??
        (await open({
          repo,
          key: `${REPAIR_ISSUE_KEY_PREFIX}${incident}`,
          title: clip(`看门狗：${n.title}`.replace(/\s+/g, ' '), 200),
          body,
          labels: [...REPAIR_ISSUE_LABELS],
        }));
      const linked = { repo, number: issue.number, url: issue.url, created: issue.created };
      try {
        if (!port.dispatchIssue)
          return {
            state: 'failed',
            issue: linked,
            ...(link ? { link } : {}),
            text: `修复单 #${issue.number} 已开，但派工入口没接上，没有派工`,
          };
        const operator = `${ctx.actor.id} ${ctx.user.displayName}`
          .replace(/[\r\n\0]/g, ' ')
          .trim()
          .slice(0, 64);
        const result = await port.dispatchIssue(repo, issue.number, operator);
        return {
          state: result.ok ? 'handed' : 'failed',
          issue: linked,
          ...(link ? { link } : {}),
          text: `修复单 #${issue.number}：${result.ok ? '已由 dispatch-issue 接手' : '派工失败，单保留'}：${clip(result.text, 350)}`,
        };
      } catch (err) {
        return {
          state: 'unknown',
          issue: linked,
          ...(link ? { link } : {}),
          text: `修复单 #${issue.number} 已开，派工回执未知：${clip(errMessage(err), 350)}，不能盲重试`,
        };
      }
    } catch (err) {
      return { state: 'failed', text: `修复单没开成：${errMessage(err)}` };
    }
  };
}

function planHand(
  deps: Deps,
  incident: string,
  self: { owner: string; name: string } | undefined,
  out: Plan,
): void {
  if (!deps.alertRepair?.openIssue || !deps.alertRepair.dispatchIssue) {
    out.problems.push('开单没接上或派工入口没接上（开发环境，或机器人凭据没读到），「交给修复」用不了');
    return;
  }
  if (!self) {
    out.problems.push('受管的仓里没有 fleet-dao，修复单不知道开在哪');
    return;
  }
  out.actions.push({
    id: `hand-to-repair:${digest(incident)}`,
    kind: 'hand-to-repair',
    label: '交给修复',
    detail: '在 fleet-dao 开一张四节修复单，立刻调用 dispatch-issue 准入派工；同一次事故只开一张',
    target: { repo: { owner: self.owner, name: self.name } },
    run: runHand(incident),
  });
}

async function planAlert(deps: Deps, n: NotificationRecord, memo: Memo): Promise<Plan> {
  const out: Plan = { actions: [], problems: [] };
  const key = n.dedupeKey ?? '';
  try {
    if (key.startsWith(IDLE_PREFIX)) await planIdle(deps, n, out);
    else if (key.startsWith('watchdog:release:')) await planRelease(deps, n, memo, out);
    else if (key.startsWith('watchdog:job:')) {
      out.problems.push('定时任务没有通用的「立刻重跑」接口，这里不虚构；可以交给修复');
    } else out.problems.push('这类看门狗提醒没有可直接执行的修复，可以交给修复');
    // 交给修复总是开在受管仓里叫 fleet-dao 的那个，不从正文猜仓
    planHand(deps, incidentOf(n), await findSelfRepo(deps.store), out);
  } catch (err) {
    out.problems.push(`算可点的动作没成：${errMessage(err)}`);
  }
  return out;
}

// —— 核验：重读原检测条件 ——

interface Check {
  ok: boolean | null;
  text: string;
}

export async function verifyRecord(
  deps: Deps,
  n: NotificationRecord,
  rec: AlertRepairRecord | StoredRecord,
  memo: Memo = {},
): Promise<Check> {
  try {
    if (rec.kind === 'task-recover') {
      const target = rec.target;
      const taskId = (n.dedupeKey ?? '').slice(IDLE_PREFIX.length);
      if (
        !target?.taskId ||
        target.taskId !== taskId ||
        (n.taskId && n.taskId !== taskId) ||
        !target.repo ||
        !target.workflowId ||
        !target.workflowRunId
      )
        return { ok: null, text: '缺少原任务 / 仓 / 工作流 run 身份，核实不了' };
      const task = await deps.store.getTask(taskId);
      const repo = task ? await deps.store.getRepo(task.repoId) : undefined;
      if (
        !task ||
        !repo ||
        repo.owner !== target.repo.owner ||
        repo.name !== target.repo.name ||
        task.issueNumber !== target.issueNumber
      )
        return { ok: null, text: '原任务或仓身份已变，不能用另一目标核验' };
      const workflowId = await workflowIdOf(deps, task);
      const execution = await deps.workflows.taskWorkflowExecution?.(workflowId);
      if (
        workflowId !== target.workflowId ||
        !execution ||
        execution.workflowId !== target.workflowId ||
        execution.runId !== target.workflowRunId
      )
        return { ok: null, text: '工作流 run 已变或读不到，不能用另一趟核验' };
      const port = deps.alertRepair;
      if (!port?.idleTask) return { ok: null, text: '没接上任务现读，核实不了' };
      const fact = await within(port.idleTask(taskId), '读任务行');
      if (fact !== null && fact.taskId !== taskId) return { ok: null, text: '现读返回另一张任务，核实不了' };
      const stale =
        fact !== null &&
        isIdleRunningStale(
          {
            ...fact,
            state: 'running',
            executor: 'engine',
            updatedAt: factTime(fact.updatedAt),
          },
          deps.now(),
        );
      return stale
        ? { ok: false, text: '同一任务仍没有会话，更新时间仍超过原检测阈值，没修好' }
        : { ok: true, text: '同一任务和工作流 run 的原检测条件已恢复' };
    }
    if (rec.kind === 'hand-to-repair') return { ok: null, text: '已交给修复单，等修好后看门狗撤卡' };
    if (rec.kind === LINK_KIND) return { ok: null, text: '已关联现有单，等修好后看门狗撤卡' };
    const snap = await readReleaseSnap(deps, memo);
    if (!snap.ok) return { ok: null, text: `核实不了：${snap.why}` };
    if (snap.pending) return { ok: false, text: '请求还没被法国接走，没修好' };
    const { train } = snap;
    if (
      !rec.target?.sha ||
      !rec.target.releaseStartedAt ||
      !train?.targetSha ||
      !sameSha(rec.target.sha, train.targetSha) ||
      train.startedAt !== rec.target.releaseStartedAt
    )
      return { ok: null, text: '发布 SHA 或 run 身份已变 / 缺失，不能用另一趟发布核验' };
    if (rec.kind === 'release-retry') {
      return train?.status === 'done'
        ? { ok: true, text: '发版进度记录已是 done' }
        : { ok: false, text: `发版进度现在是 ${train?.status ?? '（没有记录）'}，还没走完` };
    }
    if (rec.kind === 'release-restore') {
      const master = await readEngineMaster(deps.store);
      return master.on
        ? { ok: true, text: '引擎总开关已经开着' }
        : { ok: false, text: '引擎总开关还是关的，没恢复' };
    }
    return !snap.marker && train?.status !== 'running'
      ? { ok: true, text: '暂停标记已清掉' }
      : { ok: false, text: '暂停标记还在（或发版在走），没撤掉' };
  } catch (err) {
    return { ok: null, text: `核实没读成：${errMessage(err)}` };
  }
}

// —— 状态：设置表里一条一提醒 ——

async function readState(
  store: Store,
  notificationId: string,
): Promise<{ rec: StoredRecord | undefined; version: number }> {
  const row = (await store.listSettings()).find((s) => s.key === repairSettingKey(notificationId));
  if (!row) return { rec: undefined, version: 0 };
  const parsed = StoredRecordSchema.safeParse(row.value);
  if (!parsed.success)
    throw new ApiError(409, 'repair_state_unreadable', '已有修复状态读不懂，不能覆盖或重发：先核实原操作');
  return { rec: parsed.data, version: row.version };
}

function writeState(
  store: Store,
  ctx: { actor: Actor; via: AuditVia },
  n: NotificationRecord,
  rec: StoredRecord,
  expectedVersion: number,
  requireOpen = false,
): Promise<'ok' | 'conflict'> {
  return store.putSetting(
    {
      key: repairSettingKey(n.id),
      value: rec,
      expectedVersion,
      by: ctx.actor,
      expectedNotification: { id: n.id, raisedAt: n.raisedAt ?? n.createdAt, requireOpen },
    },
    {
      actor: ctx.actor,
      action: 'alert.repair',
      target: `notification:${n.id}`,
      after: {
        actionId: rec.actionId,
        kind: rec.kind,
        state: rec.state,
        requestId: rec.requestId,
        ...(rec.link
          ? {
              incident: rec.incident,
              issue: issueRef(rec.link.issue.repo, rec.link.issue.number),
              linkReason: rec.link.reason,
              linkStage: rec.link.stage,
              linkBy: rec.link.by,
              ...(rec.link.invalid ? { linkInvalid: rec.link.invalid.text } : {}),
            }
          : {}),
      },
      reason: rec.text,
      via: ctx.via,
      ok: true,
    },
  );
}

/** 同一事故（跨动作也不覆盖）的这几种状态不再给按钮：在执行 / 结果未知 / 已受理等核验 / 已修好。交给修复开了单就看单。 */
const UNSETTLED: readonly StoredRecord['state'][] = ['executing', 'unknown', 'accepted'];

const BLOCKING: readonly StoredRecord['state'][] = ['executing', 'unknown', 'accepted', 'verified', 'handed'];

/** 列表用：每条看门狗提醒的当前动作和最近一次修复结果（受理过的现算一次核验）。 */
export async function alertRepairViews(
  deps: Deps,
  items: readonly NotificationRecord[],
): Promise<Map<string, AlertRepairView>> {
  const out = new Map<string, AlertRepairView>();
  const eligible = items.filter(isRepairable);
  if (eligible.length === 0) return out;
  const settings = new Map((await deps.store.listSettings()).map((s) => [s.key, s] as const));
  const memo: Memo = {};
  await Promise.all(
    eligible.map(async (n) => {
      const incident = incidentOf(n);
      const saved = settings.get(repairSettingKey(n.id));
      const raw = saved?.value;
      const parsed = StoredRecordSchema.safeParse(raw);
      if (raw !== undefined && !parsed.success) {
        out.set(n.id, {
          incident,
          actions: [],
          problems: ['已有修复状态读不懂，不能覆盖或重发：先核实原操作'],
        });
        return;
      }
      if (parsed.success && parsed.data.incident !== incident && UNSETTLED.includes(parsed.data.state)) {
        out.set(n.id, {
          incident,
          actions: [],
          problems: ['上一代事故的操作仍在执行、结果未知或待核验，不能覆盖后重发；请先核实原操作'],
          ...wireOf(parsed.data, incident),
        });
        return;
      }
      let last = parsed.success && parsed.data.incident === incident ? parsed.data : undefined;
      if (last?.state === 'accepted') {
        const check = await verifyRecord(deps, n, last, memo);
        last = {
          ...last,
          check: { at: deps.now().toISOString(), ok: check.ok, text: clip(check.text, 400) },
        };
        if (check.ok === true && saved) {
          const verified = {
            ...last,
            state: 'verified' as const,
            text: clip(`核实恢复：${check.text}`, 600),
          };
          try {
            const settled = await writeState(
              deps.store,
              { actor: { kind: 'engine', id: 'watchdog-repair-verify' }, via: 'engine' },
              n,
              verified,
              saved.version,
            );
            last =
              settled === 'ok'
                ? verified
                : {
                    ...last,
                    check: {
                      at: deps.now().toISOString(),
                      ok: null,
                      text: '核验结算冲突：操作或事故代次已变，未覆盖，请刷新',
                    },
                  };
          } catch (err) {
            last = {
              ...last,
              check: {
                at: deps.now().toISOString(),
                ok: null,
                text: clip(`核验结果没写成，仍未结清：${errMessage(err)}`, 400),
              },
            };
          }
        }
      }
      if (n.resolvedAt !== undefined) {
        if (last) out.set(n.id, { incident, actions: [], problems: [], ...wireOf(last, incident) });
        return;
      }
      const plan = await planAlert(deps, n, memo);
      const actions = plan.actions
        .filter(() => !(last && BLOCKING.includes(last.state)))
        .map(({ run: _run, ...a }) => a);
      const self = deps.alertRepair?.readIssueState ? await findSelfRepo(deps.store) : undefined;
      const linkAction =
        self && !linkBlocked(last)
          ? { actionId: linkVersion(incident, self, last), repo: { owner: self.owner, name: self.name } }
          : undefined;
      out.set(n.id, {
        incident,
        actions,
        problems: plan.problems,
        ...(last ? wireOf(last, incident) : {}),
        ...(linkAction ? { linkAction } : {}),
      });
    }),
  );
  return out;
}

/** 已经落库、可以当回执的终态。executing 只是动手前的接活，结算没写上时不能拿它冒充结果。 */
const RECEIPT_STATES = new Set<StoredRecord['state']>([
  'accepted',
  'verified',
  'failed',
  'unknown',
  'declined',
  'handed',
]);

/** 重读到的记录必须是这次事故、这次请求、这个动作，而且已经是落库的终态。对不上就当没有，免得串事故或盖掉并发赢家。 */
function persistedReceipt(
  stored: StoredRecord | undefined,
  want: StoredRecord,
): AlertRepairRecord | undefined {
  if (!stored || stored.kind === LINK_KIND || stored.kind !== want.kind) return undefined;
  if (
    stored.incident !== want.incident ||
    stored.requestId !== want.requestId ||
    stored.actionId !== want.actionId
  )
    return undefined;
  if (!RECEIPT_STATES.has(stored.state)) return undefined;
  return wireLast(stored);
}

async function readPersistedReceipt(
  deps: Deps,
  notificationId: string,
  want: StoredRecord,
): Promise<AlertRepairRecord | undefined> {
  try {
    const { rec } = await readState(deps.store, notificationId);
    return persistedReceipt(rec, want);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    deps.log.error('修复结算之后持久状态没读到', {
      notification: notificationId,
      error: errMessage(err),
    });
    throw new ApiError(
      409,
      'repair_state_unreadable',
      '修复动作已经发出，持久状态没读到：不把没落库的结果当成功，请先核实现场',
    );
  }
}

/**
 * 动作已经发出去之后才结算。只有写进设置表的那条能当回执。
 * 冲突或写入失败时不再回内存里的 verified 等终态，也不再写第二笔：重读只采纳精确同一事故、请求、动作的已落库结果。
 */
async function settleExecuted(
  deps: Deps,
  ctx: { actor: Actor; via: AuditVia },
  n: NotificationRecord,
  rec: StoredRecord,
  expectedVersion: number,
): Promise<AlertRepairRecord> {
  try {
    const settled = await writeState(deps.store, ctx, n, rec, expectedVersion);
    if (settled === 'ok') return wireRepair(rec);
    deps.log.error('修复动作已执行，结果没写上（状态被别处改过）', {
      notification: n.id,
      action: rec.actionId,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    deps.log.error('修复动作已执行，结果没写上（持久写入失败）', {
      notification: n.id,
      action: rec.actionId,
      error: errMessage(err),
    });
    const winner = await readPersistedReceipt(deps, n.id, rec);
    if (winner) return winner;
    throw new ApiError(
      409,
      'repair_conflict',
      '修复动作已经发出，结果没写上（持久写入失败）：不把没落库的结果当成功，请先核实现场',
    );
  }
  const winner = await readPersistedReceipt(deps, n.id, rec);
  if (winner) return winner;
  throw new ApiError(
    409,
    'repair_conflict',
    '修复动作已经发出，结果没写上（状态被别处改过）：不把没落库的结果当成功，请刷新后再看',
  );
}

async function findNotification(store: Store, id: string): Promise<NotificationRecord | undefined> {
  for (const status of ['open', 'all'] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < FIND_PAGES; page += 1) {
      const got = await store.listNotifications({ status, limit: 200, ...(cursor ? { cursor } : {}) });
      const hit = got.items.find((n) => n.id === id);
      if (hit) return hit;
      cursor = got.nextCursor;
      if (!cursor) break;
    }
  }
  return undefined;
}

export function registerAlertRepairRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  app.post(WebRoutes.executeAlertRepair.path, async (c) => {
    const id = c.req.param('notificationId');
    const body = await readJson(c, ExecuteAlertRepairRequest);
    const n = await findNotification(deps.store, id);
    if (!n) throw new ApiError(404, 'notification_not_found', '没有这条通知');
    const incident = incidentOf(n);
    if (body.incident !== incident) {
      throw new ApiError(
        409,
        'incident_mismatch',
        '这不是这条提醒现在的这次事故（提醒已重开或页面太旧）：刷新后再点',
      );
    }
    const actor = actorOf(c);
    const via = c.get('via');
    const { rec: prior, version } = await readState(deps.store, id);
    if (prior && prior.incident !== incident && UNSETTLED.includes(prior.state)) {
      throw new ApiError(
        409,
        'repair_prior_incident_pending',
        '上一代事故的操作仍在执行、结果未知或待核验，不能覆盖后重发：先核实原操作',
      );
    }
    // 同一幂等身份：回原结果，不再动手（放在所有现状检查前面——动完之后证据变了，重放也要认得）
    if (
      prior &&
      prior.incident === incident &&
      (prior.requestId === body.requestId || prior.link?.requestId === body.requestId)
    ) {
      const replay = wireLast(prior);
      if (prior.actionId !== body.actionId || prior.requestId !== body.requestId || !replay) {
        throw new ApiError(409, 'request_reused', '这个请求编号已经用在另一个动作上，换个新编号');
      }
      return reply(c, ExecuteAlertRepairResponse, { ok: true, repair: replay, replayed: true });
    }
    if (!isRepairable(n))
      throw new ApiError(409, 'alert_not_repairable', '这条不是看门狗的卡住报警，没有可点的修复');
    if (n.resolvedAt !== undefined)
      throw new ApiError(409, 'alert_resolved', '这条提醒已经撤了，没动任何东西');
    const plan = await planAlert(deps, n, {});
    const action = plan.actions.find((a) => a.id === body.actionId);
    if (!action) {
      throw new ApiError(
        409,
        'action_expired',
        '这个动作已经过期（现场条件变了，或不是服务端给的动作）：刷新后看当前能点的',
        {
          problems: plan.problems,
        },
      );
    }
    if (prior && prior.incident === incident) {
      if (prior.actionId === action.id && prior.state === 'handed' && prior.kind === 'hand-to-repair') {
        return reply(c, ExecuteAlertRepairResponse, { ok: true, repair: wireRepair(prior), replayed: true });
      }
      if (BLOCKING.includes(prior.state)) {
        throw new ApiError(
          409,
          prior.state === 'executing' || prior.state === 'unknown'
            ? 'repair_in_flight'
            : 'repair_pending_verify',
          prior.state === 'accepted'
            ? '上一次已经受理，还没核实恢复：不重复发，等原条件变化'
            : '上一次还在执行或结果未知，不自动重放：请先核实现场',
        );
      }
    }
    const base: Omit<StoredRecord, 'state' | 'text'> = {
      incident,
      actionId: action.id,
      kind: action.kind,
      target: action.target,
      requestId: body.requestId,
      at: deps.now().toISOString(),
      by: actor.id,
    };
    const write = async (rec: StoredRecord, expected: number) => {
      const result = await writeState(deps.store, { actor, via }, n, rec, expected, true);
      if (result === 'conflict') {
        throw new ApiError(409, 'repair_conflict', '这条提醒的修复状态刚被别处改过：刷新后再看');
      }
    };
    // 要人拍的动作：只有选「执行」才动手；先不动、自己输入、拒绝都只记下，不执行
    if (action.choice) {
      if (body.optionId === undefined && body.text === undefined) {
        throw new ApiError(
          409,
          'choice_required',
          '这个动作要你选一项（执行 / 先不动）或自己写一句，没选就不执行',
        );
      }
      const picked = action.choice.options.find((o) => o.id === body.optionId);
      if (body.optionId !== undefined && !picked) {
        throw new ApiError(400, 'unknown_option', '这个动作里没有这个选项');
      }
      if (picked?.id !== 'do') {
        const rec: StoredRecord = {
          ...base,
          state: 'declined',
          text: picked
            ? `你选了「${picked.label}」，没有执行`
            : `你自己写了一句，没有执行：${clip(body.text ?? '', 300)}`,
          ...(picked ? { optionId: picked.id } : {}),
        };
        await write(rec, version);
        return reply(c, ExecuteAlertRepairResponse, { ok: true, repair: wireRepair(rec), replayed: false });
      }
    } else if (body.optionId !== undefined || body.text !== undefined) {
      throw new ApiError(400, 'choice_not_offered', '这个动作不带选项，不用选');
    }
    // 同事故操作者明确关联过已有单：沿用绑定（claim 也带着，中断后绑定不丢）
    const same = prior?.incident === incident ? prior : undefined;
    const bound = same?.link ? { issue: { ...same.link.issue, created: false }, link: same.link } : undefined;
    const claim: StoredRecord = {
      ...base,
      state: 'executing',
      text: '已接活，正在执行（中断后不会自动重放）',
      ...(body.optionId ? { optionId: body.optionId } : {}),
      ...(bound ?? {}),
    };
    await write(claim, version);
    const outcome = await action
      .run({
        deps,
        n,
        actor,
        via,
        user: c.get('user'),
        at: claim.at,
        ...(same?.kind === 'hand-to-repair' && same.issue ? { priorIssue: same.issue } : {}),
        ...(same?.link ? { priorLink: same.link } : {}),
      })
      .catch((err: unknown): Outcome => {
        deps.log.error('看门狗提醒的修复执行抛错', {
          notification: id,
          action: action.id,
          error: errMessage(err),
        });
        return {
          state: 'unknown',
          text: `执行结果未知（${clip(errMessage(err), 200)}），不自动重试，请先核实现场`,
        };
      });
    if (outcome.state === 'link-active') {
      // 关联的单已有人在处理：这次什么都没做，把绑定（带上刚核实的阶段）原样放回去，不记成一次修复，回 409
      if (outcome.link) {
        const settled = await writeState(
          deps.store,
          { actor, via },
          n,
          linkRecord(outcome.link),
          version + 1,
        );
        if (settled === 'conflict')
          deps.log.error('关联的单已有人处理，绑定没放回去（状态被别处改过）', { notification: id });
      }
      throw new ApiError(409, 'link_already_handled', clip(outcome.text, 600), {
        ...(outcome.link ? { linked: outcome.link } : {}),
      });
    }
    let rec: StoredRecord = {
      ...claim,
      state: outcome.state,
      text: clip(outcome.text, 600),
      at: deps.now().toISOString(),
      ...(outcome.baseline ? { baseline: outcome.baseline } : {}),
      ...(outcome.issue ? { issue: outcome.issue } : {}),
      ...(outcome.link ? { link: outcome.link } : {}),
    };
    if (outcome.state === 'accepted') {
      const check = await verifyRecord(deps, n, rec);
      rec = {
        ...rec,
        check: { at: deps.now().toISOString(), ok: check.ok, text: clip(check.text, 400) },
        ...(check.ok === true ? { state: 'verified' as const } : {}),
      };
    }
    const repair = await settleExecuted(deps, { actor, via }, n, rec, version + 1);
    return reply(c, ExecuteAlertRepairResponse, { ok: true, repair, replayed: false });
  });

  // 明确关联已有单：只记绑定，不开单、不派工；操作者身份只认登录会话（请求里没有 actor 字段，多写就 400）
  app.post(WebRoutes.linkAlertRepair.path, async (c) => {
    const id = c.req.param('notificationId');
    const body = await readJson(c, LinkAlertRepairRequest);
    const n = await findNotification(deps.store, id);
    if (!n) throw new ApiError(404, 'notification_not_found', '没有这条通知');
    const incident = incidentOf(n);
    if (body.incident !== incident) {
      throw new ApiError(
        409,
        'incident_mismatch',
        '这不是这条提醒现在的这次事故（提醒已重开或页面太旧）：刷新后再点',
      );
    }
    const actor = actorOf(c);
    const via = c.get('via');
    const { rec: prior, version } = await readState(deps.store, id);
    if (prior && prior.incident !== incident && UNSETTLED.includes(prior.state)) {
      throw new ApiError(
        409,
        'repair_prior_incident_pending',
        '上一代事故的操作仍在执行、结果未知或待核验，不能覆盖后重发：先核实原操作',
      );
    }
    if (prior && (prior.requestId === body.requestId || prior.link?.requestId === body.requestId)) {
      const link = prior.link;
      if (
        !link ||
        prior.incident !== incident ||
        link.requestId !== body.requestId ||
        link.actionId !== body.actionId ||
        link.issue.number !== body.issueNumber ||
        !sameRepo(link.issue.repo, body.repo)
      )
        throw new ApiError(409, 'request_reused', '这个请求编号已经用在另一个动作或另一张单上，换个新编号');
      return reply(c, LinkAlertRepairResponse, { ok: true, linked: link, replayed: true });
    }
    if (!isRepairable(n))
      throw new ApiError(409, 'alert_not_repairable', '这条不是看门狗的卡住报警，没有可点的修复');
    if (n.resolvedAt !== undefined)
      throw new ApiError(409, 'alert_resolved', '这条提醒已经撤了，没动任何东西');
    const last = prior?.incident === incident ? prior : undefined;
    const blocked = linkBlocked(last);
    if (blocked) throw blocked;
    const self = await findSelfRepo(deps.store);
    if (!deps.alertRepair?.readIssueState || !self)
      throw new ApiError(
        409,
        'link_unavailable',
        '这台后端没接上 GitHub 读单，或受管的仓里没有 fleet-dao，不能关联已有单',
      );
    if (body.actionId !== linkVersion(incident, self, last)) {
      throw new ApiError(
        409,
        'action_expired',
        '这个关联版本已经过期（这次事故的修复状态变了，或不是服务端给的）：刷新后再关联',
      );
    }
    const checked = await inspectLinkTarget(deps, { repo: body.repo, number: body.issueNumber });
    const facts = { issue: checked.issue, ...checked.facts };
    const link: AlertRepairLink = {
      incident,
      reason: 'operator-explicit',
      ...facts,
      actionId: body.actionId,
      requestId: body.requestId,
      by: actor.id,
      at: deps.now().toISOString(),
      text: linkText(facts),
    };
    const settled = await writeState(deps.store, { actor, via }, n, linkRecord(link), version, true);
    if (settled === 'conflict')
      throw new ApiError(409, 'repair_conflict', '这条提醒的修复状态刚被别处改过：刷新后再看');
    return reply(c, LinkAlertRepairResponse, { ok: true, linked: link, replayed: false });
  });
}
