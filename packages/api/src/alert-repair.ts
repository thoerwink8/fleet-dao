// 看门狗提醒的受控修复（#3033，POST /api/notifications/:id/repair；列表上每条提醒带 repair）。
// 以前普通 watchdog 提醒只有「处理」和链接，通知完就完事；这里让创始人按当前证据点一个动作，并知道有没有真的做成。
// 改这里之前必须知道：
// - 可点的动作是读时现算的（planAlert），不存、不借 decision_reason 假装「要你拍」。动作编号 = 种类 + 证据摘要
//   （任务行更新时刻、当前工作流、发版进度……）：证据变了编号就变，旧编号点不动（409 action_expired）。
// - 点的时候只收三样：服务端给的动作编号、incident（提醒编号 + 键 + 建立时刻的摘要）、幂等身份 requestId。
//   提醒已撤、incident 对不上、动作过期、上一次还在执行或结果未知，都是 409，不发任何副作用。同一 requestId 重放回原结果。
// - 首批只接现有能力：idle-running 的「继续」两下信号（同任务页的继续）；发版的重试 / 恢复引擎开关 / 撤掉暂停
//   （同 /france/release-recover 的请求文件）；其余一律只能「交给修复」——在 fleet-dao 开一张四节单（同一 incident 只一张）。
//   不加任意 shell、重启、配置写口；定时任务通用「立刻重跑」没有现成接口，不虚构。
// - 发信号 / 写请求文件只记 accepted（收到了），不撤卡：完成判据是重读原检测条件（verifyRecord），条件没恢复、读不到、回执未知
//   都保持未修复。卡仍由看门狗自己撤。
// - 要人本人拍的动作（恢复引擎开关、撤掉暂停）带 choice：选项、推荐、自由输入沿用「要你拍」的形状；只有「执行」那一项会执行，
//   先不动、自己输入、不答都不执行。
// - 状态落在设置表 alert.repair:<提醒编号>（版本号做 CAS：先写 executing 再动手，动手后写结果；中断后不自动重放）。
//   设置页只列 SETTING_SCHEMAS 里的键，这条不会出现在设置页。每次写都带操作记录。
// - idle-running 的验证不用时长阈值：点的时候记下任务行更新时刻，之后任务行动了、有了开着的会话或不再是 running 就算恢复。

import { createHash } from 'node:crypto';
import { checkIssueBody, domainLabel, issueBodyTooLong, natureLabel } from '@fleet-dao/conventions';
import { listRunningEngineTasks } from '@fleet-dao/db';
import {
  type AlertRepairAction,
  type AlertRepairKind,
  type AlertRepairRecord,
  AlertRepairRecordSchema,
  type AlertRepairView,
  DecisionOptionsSchema,
  ExecuteAlertRepairRequest,
  ExecuteAlertRepairResponse,
  RELEASE_RECOVER_ACTION,
  RELEASE_RECOVER_WORD,
  type ReleaseRecover,
  type ReleaseRecoverKind,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Context, Hono } from 'hono';
import { continueSignals } from './continue-signals.ts';
import type { Deps } from './deps.ts';
import { readEngineMaster } from './engine-switch.ts';
import { parseTrainState } from './france-release.ts';
import { ApiError, readJson, reply } from './http.ts';
import {
  type Actor,
  type AuditVia,
  type NotificationRecord,
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
}

export function pgAlertRepair(
  db: Parameters<typeof listRunningEngineTasks>[0],
  issues: Pick<RequestIssuePort, 'openIssue'> | undefined,
): AlertRepairPort {
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
  };
}

const digest = (...parts: (string | number | boolean | null | undefined)[]): string =>
  createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('\u0000'))
    .digest('hex')
    .slice(0, 12);

/** 这一次事故的版本：提醒编号 + 键 + 建立时刻。提醒撤了再开不改它，证据变化靠动作编号里的摘要。 */
export const incidentOf = (n: Pick<NotificationRecord, 'id' | 'dedupeKey' | 'createdAt'>): string =>
  digest(n.id, n.dedupeKey, n.createdAt);

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

// —— 动作计划（读时现算）——

interface RunContext {
  deps: Deps;
  n: NotificationRecord;
  actor: Actor;
  via: AuditVia;
  user: { displayName: string };
  at: string;
}
interface Outcome {
  state: 'accepted' | 'failed' | 'unknown' | 'handed';
  text: string;
  baseline?: string;
  issue?: NonNullable<AlertRepairRecord['issue']>;
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
function runTaskRecover(taskId: string, workflowId: string, baseline: string) {
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
        await deps.workflows.signal(workflowId, signal);
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
  if (fact.openRuns > 0) {
    out.problems.push('条件已变：任务现在有开着的会话了，等看门狗下一轮撤卡');
    return;
  }
  if (task.paused !== undefined) {
    out.problems.push(`这张单被人暂停了（${task.paused}）：到任务页点「继续」，这里不替人解开`);
    return;
  }
  let workflowId: string;
  try {
    workflowId = await workflowIdOf(deps, task);
  } catch (err) {
    out.problems.push(`任务的工作流找不到：${errMessage(err)}`);
    return;
  }
  const repo = await deps.store.getRepo(task.repoId);
  out.actions.push({
    id: `task-recover:${digest(taskId, fact.updatedAt, workflowId)}`,
    kind: 'task-recover',
    label: '叫醒任务继续',
    detail: `给任务 #${task.issueNumber} 的当前工作流发「继续」和路由叫醒（同任务页的继续）；任务行动起来才算修好`,
    target: {
      taskId,
      issueNumber: task.issueNumber,
      workflowId,
      ...(repo ? { repo: { owner: repo.owner, name: repo.name } } : {}),
    },
    run: runTaskRecover(taskId, workflowId, fact.updatedAt ?? 'none'),
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
  if (!train?.targetSha || !sameSha(train.targetSha, keySha)) {
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
      id: `${repairKind}:${digest(kind, train.status, train.phaseIndex, train.targetSha, train.updatedAt, snap.marker)}`,
      kind: repairKind,
      label,
      detail: clip(detail, 300),
      target: { sha: train.targetSha },
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

function runHand(incident: string) {
  return async (ctx: RunContext): Promise<Outcome> => {
    const { deps, n } = ctx;
    const open = deps.alertRepair?.openIssue;
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
      const issue = await open({
        repo,
        key: `${REPAIR_ISSUE_KEY_PREFIX}${incident}`,
        title: clip(`看门狗：${n.title}`.replace(/\s+/g, ' '), 200),
        body,
        labels: [...REPAIR_ISSUE_LABELS],
      });
      return {
        state: 'handed',
        issue: { repo, number: issue.number, url: issue.url, created: issue.created },
        text: `${issue.created ? '已开' : '已有'}修复单 ${repo.owner}/${repo.name}#${issue.number}，引擎按准入拉单`,
      };
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
  if (!deps.alertRepair?.openIssue) {
    out.problems.push('开单没接上（开发环境，或机器人凭据没读到），「交给修复」用不了');
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
    detail: '在 fleet-dao 开一张四节修复单，引擎按准入拉单；同一次事故只开一张',
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
  rec: AlertRepairRecord,
  memo: Memo = {},
): Promise<Check> {
  try {
    if (rec.kind === 'task-recover') {
      const taskId = (n.dedupeKey ?? '').slice(IDLE_PREFIX.length);
      const port = deps.alertRepair;
      if (!port?.idleTask) return { ok: null, text: '没接上任务现读，核实不了' };
      const fact = await within(port.idleTask(taskId), '读任务行');
      if (fact === null) return { ok: true, text: '任务已经不是「引擎做、在干活」了，原条件不再成立' };
      if (fact.openRuns > 0) return { ok: true, text: '任务有了开着的会话，原条件不再成立' };
      if ((fact.updatedAt ?? 'none') !== (rec.baseline ?? 'none')) {
        return { ok: true, text: '任务行有了新的更新，原条件不再成立' };
      }
      return { ok: false, text: '任务行还没动、也没有会话：原条件仍成立，没修好' };
    }
    if (rec.kind === 'hand-to-repair') return { ok: null, text: '已交给修复单，等修好后看门狗撤卡' };
    const snap = await readReleaseSnap(deps, memo);
    if (!snap.ok) return { ok: null, text: `核实不了：${snap.why}` };
    if (snap.pending) return { ok: false, text: '请求还没被法国接走，没修好' };
    const { train } = snap;
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
): Promise<{ rec: AlertRepairRecord | undefined; version: number }> {
  const row = (await store.listSettings()).find((s) => s.key === repairSettingKey(notificationId));
  if (!row) return { rec: undefined, version: 0 };
  const parsed = AlertRepairRecordSchema.safeParse(row.value);
  return { rec: parsed.success ? parsed.data : undefined, version: row.version };
}

function writeState(
  store: Store,
  ctx: { actor: Actor; via: AuditVia },
  n: NotificationRecord,
  rec: AlertRepairRecord,
  expectedVersion: number,
): Promise<'ok' | 'conflict'> {
  return store.putSetting(
    { key: repairSettingKey(n.id), value: rec, expectedVersion, by: ctx.actor },
    {
      actor: ctx.actor,
      action: 'alert.repair',
      target: `notification:${n.id}`,
      after: { actionId: rec.actionId, kind: rec.kind, state: rec.state, requestId: rec.requestId },
      reason: rec.text,
      via: ctx.via,
      ok: true,
    },
  );
}

/** 同一个动作的这几种状态不再给按钮：在执行 / 结果未知 / 已受理等核验 / 已修好。交给修复开了单就看单。 */
const BLOCKING: readonly AlertRepairRecord['state'][] = [
  'executing',
  'unknown',
  'accepted',
  'verified',
  'handed',
];

/** 列表用：每条看门狗提醒的当前动作和最近一次修复结果（受理过的现算一次核验）。 */
export async function alertRepairViews(
  deps: Deps,
  items: readonly NotificationRecord[],
): Promise<Map<string, AlertRepairView>> {
  const out = new Map<string, AlertRepairView>();
  const eligible = items.filter(isRepairable);
  if (eligible.length === 0) return out;
  const settings = new Map((await deps.store.listSettings()).map((s) => [s.key, s.value] as const));
  const memo: Memo = {};
  await Promise.all(
    eligible.map(async (n) => {
      const incident = incidentOf(n);
      const parsed = AlertRepairRecordSchema.safeParse(settings.get(repairSettingKey(n.id)));
      let last = parsed.success && parsed.data.incident === incident ? parsed.data : undefined;
      if (last?.state === 'accepted') {
        const check = await verifyRecord(deps, n, last, memo);
        last = {
          ...last,
          check: { at: deps.now().toISOString(), ok: check.ok, text: clip(check.text, 400) },
          ...(check.ok === true ? { state: 'verified' as const } : {}),
        };
      }
      if (n.resolvedAt !== undefined) {
        if (last) out.set(n.id, { incident, actions: [], problems: [], last });
        return;
      }
      const plan = await planAlert(deps, n, memo);
      const actions = plan.actions
        .filter((a) => !(last && last.actionId === a.id && BLOCKING.includes(last.state)))
        .map(({ run: _run, ...a }) => a);
      out.set(n.id, { incident, actions, problems: plan.problems, ...(last ? { last } : {}) });
    }),
  );
  return out;
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
    // 同一幂等身份：回原结果，不再动手（放在所有现状检查前面——动完之后证据变了，重放也要认得）
    if (prior && prior.incident === incident && prior.requestId === body.requestId) {
      if (prior.actionId !== body.actionId) {
        throw new ApiError(409, 'request_reused', '这个请求编号已经用在另一个动作上，换个新编号');
      }
      return reply(c, ExecuteAlertRepairResponse, { ok: true, repair: prior, replayed: true });
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
    if (prior && prior.incident === incident && prior.actionId === action.id) {
      if (prior.state === 'handed' && prior.kind === 'hand-to-repair') {
        return reply(c, ExecuteAlertRepairResponse, { ok: true, repair: prior, replayed: true });
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
    const base: Omit<AlertRepairRecord, 'state' | 'text'> = {
      incident,
      actionId: action.id,
      kind: action.kind,
      requestId: body.requestId,
      at: deps.now().toISOString(),
      by: actor.id,
    };
    const write = async (rec: AlertRepairRecord, expected: number) => {
      const result = await writeState(deps.store, { actor, via }, n, rec, expected);
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
        const rec: AlertRepairRecord = {
          ...base,
          state: 'declined',
          text: picked
            ? `你选了「${picked.label}」，没有执行`
            : `你自己写了一句，没有执行：${clip(body.text ?? '', 300)}`,
          ...(picked ? { optionId: picked.id } : {}),
        };
        await write(rec, version);
        return reply(c, ExecuteAlertRepairResponse, { ok: true, repair: rec, replayed: false });
      }
    } else if (body.optionId !== undefined || body.text !== undefined) {
      throw new ApiError(400, 'choice_not_offered', '这个动作不带选项，不用选');
    }
    const claim: AlertRepairRecord = {
      ...base,
      state: 'executing',
      text: '已接活，正在执行（中断后不会自动重放）',
      ...(body.optionId ? { optionId: body.optionId } : {}),
    };
    await write(claim, version);
    const outcome = await action
      .run({ deps, n, actor, via, user: c.get('user'), at: claim.at })
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
    let rec: AlertRepairRecord = {
      ...claim,
      state: outcome.state,
      text: clip(outcome.text, 600),
      at: deps.now().toISOString(),
      ...(outcome.baseline ? { baseline: outcome.baseline } : {}),
      ...(outcome.issue ? { issue: outcome.issue } : {}),
    };
    if (outcome.state === 'accepted') {
      const check = await verifyRecord(deps, n, rec);
      rec = {
        ...rec,
        check: { at: deps.now().toISOString(), ok: check.ok, text: clip(check.text, 400) },
        ...(check.ok === true ? { state: 'verified' as const } : {}),
      };
    }
    const settled = await writeState(deps.store, { actor, via }, n, rec, version + 1);
    if (settled === 'conflict') {
      deps.log.error('修复动作已执行，结果没写上（状态被别处改过）', { notification: id, action: action.id });
    }
    return reply(c, ExecuteAlertRepairResponse, { ok: true, repair: rec, replayed: false });
  });
}
