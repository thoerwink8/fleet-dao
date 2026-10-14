// fleet-api release pause|continue（#2038、决定 0093）：发版切版本前，给手上有会话在跑的任务发 hard 暂停；新引擎起来后只对这一批发「继续」。
// release.sh 是唯一的调用方：pause 的名单（JSON）打到标准输出，release.sh 落成 $RELEASES/.release-paused.json；continue 从标准输入读回同一份。
// 改这里之前必须知道：
// - 暂停人固定写 RELEASE_PAUSE_BY（「发版」）：引擎把它写进 tasks.doing（「已暂停：被人暂停（发版）：…」），continue 凭它认出
//   「是发版暂停的」。人手暂停的（暂停时已经停着、或停着的原因不是发版）不暂停、不继续，名单里照实记 skipped。
// - 只给 release.sh 从引擎 drain.json 里读到的、手上有会话的任务发：在等 CI、等合并的单不打断（切版本那几十秒新引擎起来接着等）。
//   停下等人（stalled）的单不发：对它们发「继续」等于替人点了继续。
// - 续上原会话由引擎做（#2037：被 PausedInterrupt 停下的那一段工作流记下会话号，继续时按它 resume）。这里只发信号，
//   continue 时顺带把每张单最近一段收场时报的会话号（runs.session_id）记进名单，发版报告和事后排查看得到。
// - 发不出去的照实记 failed、退出码 1，不当成发成了。操作记录写不进不挡信号（pause 在迁移之前跑，库里可能还没有新的
//   操作者种类），只在名单里记 auditError。
// - 退出码：0 都发成了（或照规矩跳过）；1 有发不出去的（名单照样打出来）；2 参数或输入不对（不连库）。

import { TASK_SIGNAL_NAMES, type Task, taskWorkflowId } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Actor, Store, WorkflowControl } from './ports.ts';
import { WorkflowGoneError, WorkflowTargetNotFoundError, WorkflowUnavailableError } from './ports.ts';
import { isTaskFinished } from './views.ts';

/** 暂停人：引擎写进「已暂停：被人暂停（发版）」，continue 凭它认出是发版暂停的。 */
export const RELEASE_PAUSE_BY = '发版';
/** 引擎写的暂停原因里认「发版暂停的」那一段（task-runtime.ts 的 pauseNote：`被人暂停（<by>）`）。 */
export const RELEASE_PAUSE_MARK = `（${RELEASE_PAUSE_BY}）`;
export const PAUSE_LIST_SCHEMA = 1;

export const RELEASE_USAGE =
  '用法：fleet-api release pause --reason "<为什么>" <任务编号>…（给这些任务发 hard 暂停，暂停人写「发版」，名单 JSON 打到标准输出）；' +
  'fleet-api release continue < 名单.json（只对名单里发版暂停的任务发「继续」，结果 JSON 打到标准输出）。' +
  '由 deploy/release.sh 调。退出码：0 都发成了；1 有发不出去的；2 参数或输入不对';

/** 运维脚本（release.sh 经 fleet-api）写的操作记录：不是引擎自己做的。 */
const OPS_RELEASE: Actor = { kind: 'ops', id: 'ops:release' };

export type EntryResult = 'paused' | 'continued' | 'skipped' | 'failed';

export interface PauseEntry {
  taskId: string;
  /** owner/name；库里没这张单时是 null。 */
  repo: string | null;
  issueNumber: number | null;
  workflowId: string | null;
  /** pause 时：paused / skipped / failed；continue 之后改成 continued / skipped / failed。 */
  result: EntryResult;
  why?: string;
  /** pause 时发成了暂停（continue 只认这些）。 */
  pausedOk: boolean;
  /** 这张单最近一段收场时报的会话号（continue 时读；读不到是 null）。 */
  sessionId?: string | null;
  auditError?: string;
}

export interface PauseList {
  schema: typeof PAUSE_LIST_SCHEMA;
  by: typeof RELEASE_PAUSE_BY;
  reason: string;
  pausedAt: string;
  continuedAt?: string;
  entries: PauseEntry[];
}

export interface ReleaseCliDeps {
  store: Pick<Store, 'getTask' | 'getRepo' | 'appendAudit' | 'listSegmentRuns'>;
  workflows: WorkflowControl;
  operator: string;
  now(): Date;
}

export class ReleaseCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'ReleaseCliError';
    this.exitCode = exitCode;
  }
}

const UUIDISH = /^[0-9a-zA-Z-]{1,64}$/;

export type ReleaseArgs = { action: 'pause'; reason: string; taskIds: string[] } | { action: 'continue' };

export function parseReleaseArgs(argv: readonly string[]): ReleaseArgs {
  const [action, ...rest] = argv;
  if (action === 'continue') {
    if (rest.length > 0) throw new ReleaseCliError(`continue 不带参数（名单从标准输入读）。${RELEASE_USAGE}`);
    return { action: 'continue' };
  }
  if (action !== 'pause')
    throw new ReleaseCliError(`认不出「${action ?? ''}」：只收 pause、continue。${RELEASE_USAGE}`);
  let reason = '';
  const taskIds: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '--reason') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--'))
        throw new ReleaseCliError(`--reason 后面要跟为什么。${RELEASE_USAGE}`);
      reason = v.trim().slice(0, 200);
    } else if (arg.startsWith('-')) {
      throw new ReleaseCliError(`认不出参数 ${arg}。${RELEASE_USAGE}`);
    } else if (UUIDISH.test(arg)) {
      if (!taskIds.includes(arg)) taskIds.push(arg);
    } else {
      throw new ReleaseCliError(`任务编号「${arg.slice(0, 80)}」认不出。${RELEASE_USAGE}`);
    }
  }
  if (reason === '') throw new ReleaseCliError(`--reason 必填。${RELEASE_USAGE}`);
  return { action: 'pause', reason, taskIds };
}

/** 读回 release.sh 落下的名单；哪一项不对都抛（退出码 2），不拿半份当全部。 */
export function parsePauseList(text: string): PauseList {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ReleaseCliError(`名单不是 JSON（${errMessage(err)}）`);
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (o.schema !== PAUSE_LIST_SCHEMA) throw new ReleaseCliError(`名单的 schema 不是 ${PAUSE_LIST_SCHEMA}`);
  if (o.by !== RELEASE_PAUSE_BY) throw new ReleaseCliError(`名单的暂停人不是「${RELEASE_PAUSE_BY}」`);
  if (!Array.isArray(o.entries)) throw new ReleaseCliError('名单里没有 entries');
  for (const e of o.entries as unknown[]) {
    const x = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    if (typeof x.taskId !== 'string' || typeof x.pausedOk !== 'boolean') {
      throw new ReleaseCliError('名单里有认不出的一条（缺 taskId 或 pausedOk）');
    }
  }
  return raw as PauseList;
}

/** 停下等人的：对它们发暂停再发「继续」等于替人点了继续，不碰。 */
const WAITING_FOR_HUMAN = new Set<Task['state']>(['stalled']);

async function locate(
  deps: ReleaseCliDeps,
  task: Task,
): Promise<{ repo: string; workflowId: string } | { why: string }> {
  const repo = await deps.store.getRepo(task.repoId);
  if (!repo) return { why: '库里没有这张单的仓' };
  try {
    const workflowId = deps.workflows.runningTaskWorkflow
      ? await deps.workflows.runningTaskWorkflow({ owner: repo.owner, name: repo.name }, task.issueNumber)
      : taskWorkflowId(repo, task.issueNumber);
    return { repo: `${repo.owner}/${repo.name}`, workflowId };
  } catch (err) {
    return { why: `查在跑的任务工作流没成：${errMessage(err)}` };
  }
}

function signalWhy(err: unknown): string {
  if (err instanceof WorkflowGoneError || err instanceof WorkflowTargetNotFoundError) {
    return '任务工作流已经结束或不存在';
  }
  if (err instanceof WorkflowUnavailableError) return `工作流服务连不上：${err.message}`;
  return `信号没发出去：${errMessage(err)}`;
}

async function audit(deps: ReleaseCliDeps, entry: PauseEntry, action: string, reason: string): Promise<void> {
  try {
    await deps.store.appendAudit({
      actor: OPS_RELEASE,
      action,
      target: `task:${entry.taskId}`,
      after: {
        who: deps.operator,
        result: entry.result,
        ...(entry.why ? { why: entry.why } : {}),
        ...(entry.workflowId ? { workflowId: entry.workflowId } : {}),
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      },
      reason: `${reason}（服务器上 ${deps.operator} 经 release.sh 跑的 fleet-api release）`,
      via: 'ops',
      ok: entry.result !== 'failed',
      ...(entry.result === 'failed' && entry.why ? { error: entry.why } : {}),
    });
  } catch (err) {
    entry.auditError = errMessage(err).slice(0, 300);
  }
}

/** 给这些任务发 hard 暂停（暂停人「发版」）。逐条记结果；一条没成不影响别的。 */
export async function pauseTasks(
  taskIds: readonly string[],
  reason: string,
  deps: ReleaseCliDeps,
): Promise<PauseList> {
  const entries: PauseEntry[] = [];
  for (const taskId of taskIds) {
    const entry: PauseEntry = {
      taskId,
      repo: null,
      issueNumber: null,
      workflowId: null,
      result: 'failed',
      pausedOk: false,
    };
    entries.push(entry);
    let task: Task | null;
    try {
      task = await deps.store.getTask(taskId);
    } catch (err) {
      entry.why = `库里读这张单没成：${errMessage(err)}`;
      await audit(deps, entry, 'task.pause', reason);
      continue;
    }
    if (!task) {
      entry.why = '库里没有这个任务';
      await audit(deps, entry, 'task.pause', reason);
      continue;
    }
    entry.issueNumber = task.issueNumber;
    if (isTaskFinished(task)) {
      entry.result = 'skipped';
      entry.why = `已经结束（${task.state}）`;
    } else if (task.paused !== undefined) {
      entry.result = 'skipped';
      entry.why = `本来就停着（${task.paused}）：不是发版暂停的，发完也不替人继续`;
    } else if (WAITING_FOR_HUMAN.has(task.state)) {
      entry.result = 'skipped';
      entry.why = `在等人（${task.state}）：不发暂停，免得发完替人点了继续`;
    }
    if (entry.result === 'skipped') {
      await audit(deps, entry, 'task.pause', reason);
      continue;
    }
    const where = await locate(deps, task);
    if ('why' in where) {
      entry.why = where.why;
      await audit(deps, entry, 'task.pause', reason);
      continue;
    }
    entry.repo = where.repo;
    entry.workflowId = where.workflowId;
    try {
      await deps.workflows.signal(where.workflowId, {
        name: TASK_SIGNAL_NAMES.pause,
        by: RELEASE_PAUSE_BY,
        mode: 'hard',
        reason,
      });
      entry.result = 'paused';
      entry.pausedOk = true;
    } catch (err) {
      entry.why = signalWhy(err);
    }
    await audit(deps, entry, 'task.pause', reason);
  }
  return {
    schema: PAUSE_LIST_SCHEMA,
    by: RELEASE_PAUSE_BY,
    reason,
    pausedAt: deps.now().toISOString(),
    entries,
  };
}

async function lastSessionId(deps: ReleaseCliDeps, taskId: string): Promise<string | null> {
  try {
    const runs = await deps.store.listSegmentRuns(taskId);
    for (let i = runs.length - 1; i >= 0; i--) {
      const id = runs[i]?.sessionId;
      if (id) return id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 只对名单里发版暂停成了的发「继续」：已结束的跳过；停着、但停着的原因不是发版（人在发版期间又手动暂停过）的不动；
 * 没停着（还没走到检查点、暂停请求还挂着）照发：「继续」会撤掉还没生效的暂停。
 */
export async function continueTasks(list: PauseList, deps: ReleaseCliDeps): Promise<PauseList> {
  const reason = `发版完成，接着做（${list.reason}）`;
  const entries: PauseEntry[] = [];
  for (const old of list.entries) {
    const entry: PauseEntry = { ...old };
    delete entry.auditError;
    entries.push(entry);
    if (!old.pausedOk) continue; // 没暂停过的不继续（原样留着 skipped / failed）
    entry.sessionId = await lastSessionId(deps, old.taskId);
    let task: Task | null;
    try {
      task = await deps.store.getTask(old.taskId);
    } catch (err) {
      entry.result = 'failed';
      entry.why = `库里读这张单没成，没发「继续」：${errMessage(err)}`;
      await audit(deps, entry, 'task.continue', reason);
      continue;
    }
    if (!task) {
      entry.result = 'failed';
      entry.why = '库里没有这个任务了，没发「继续」';
      await audit(deps, entry, 'task.continue', reason);
      continue;
    }
    if (isTaskFinished(task)) {
      entry.result = 'skipped';
      entry.why = `已经结束（${task.state}），不用继续`;
      await audit(deps, entry, 'task.continue', reason);
      continue;
    }
    if (task.paused !== undefined && !task.paused.includes(RELEASE_PAUSE_MARK)) {
      entry.result = 'skipped';
      entry.why = `停着的原因不是发版（${task.paused}）：人手暂停的不动`;
      await audit(deps, entry, 'task.continue', reason);
      continue;
    }
    const where = old.workflowId ? { workflowId: old.workflowId } : await locate(deps, task);
    if ('why' in where) {
      entry.result = 'failed';
      entry.why = where.why;
      await audit(deps, entry, 'task.continue', reason);
      continue;
    }
    try {
      await deps.workflows.signal(where.workflowId, {
        name: TASK_SIGNAL_NAMES.continue,
        by: RELEASE_PAUSE_BY,
        note: reason,
      });
      entry.result = 'continued';
      delete entry.why;
    } catch (err) {
      entry.result = 'failed';
      entry.why = `没发出「继续」：${signalWhy(err)}`;
    }
    await audit(deps, entry, 'task.continue', reason);
  }
  return { ...list, continuedAt: deps.now().toISOString(), entries };
}

/** 给人看的一行（release.sh 原样打进发版日志）。 */
export function entryLine(e: PauseEntry): string {
  const who = e.repo && e.issueNumber !== null ? `${e.repo}#${e.issueNumber}` : `任务 ${e.taskId}`;
  const sid = e.sessionId ? `，会话 ${e.sessionId}` : '';
  return `${e.result} ${who}${e.why ? `：${e.why}` : ''}${sid}`;
}

export interface ReleaseCommandDeps {
  out(text: string): void;
  err(text: string): void;
  now(): Date;
  operator: string;
  readStdin(): Promise<string>;
  /** 连库（参数和输入都认过了才连）。 */
  openStore(): Promise<{ store: ReleaseCliDeps['store']; close(): Promise<void> }>;
  /** 懒连 Temporal（同 task 命令）。 */
  openWorkflows(): Promise<{ workflows: WorkflowControl; close(): Promise<void> }>;
}

/** release 命令：参数、输入不对不连库（退出码 2）；结果 JSON 打到标准输出最后一行，给人看的逐条打到标准错误。 */
export async function runReleaseCommand(argv: readonly string[], deps: ReleaseCommandDeps): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.out(RELEASE_USAGE);
    return 0;
  }
  let args: ReleaseArgs;
  let list: PauseList | null = null;
  try {
    args = parseReleaseArgs(argv);
    if (args.action === 'continue') list = parsePauseList(await deps.readStdin());
  } catch (err) {
    deps.err(err instanceof ReleaseCliError ? err.message : `没做成：${errMessage(err)}`);
    return err instanceof ReleaseCliError ? err.exitCode : 1;
  }
  const work = args.action === 'pause' ? args.taskIds : (list?.entries.filter((e) => e.pausedOk) ?? []);
  if (work.length === 0) {
    const empty: PauseList =
      args.action === 'pause'
        ? {
            schema: PAUSE_LIST_SCHEMA,
            by: RELEASE_PAUSE_BY,
            reason: args.reason,
            pausedAt: deps.now().toISOString(),
            entries: [],
          }
        : { ...(list as PauseList), continuedAt: deps.now().toISOString() };
    deps.err(args.action === 'pause' ? '没有要暂停的任务' : '名单里没有发版暂停成了的任务，不用继续');
    deps.out(JSON.stringify(empty));
    return 0;
  }
  let opened: Awaited<ReturnType<ReleaseCommandDeps['openStore']>> | undefined;
  let wf: Awaited<ReturnType<ReleaseCommandDeps['openWorkflows']>> | undefined;
  try {
    opened = await deps.openStore();
    wf = await deps.openWorkflows();
    const run: ReleaseCliDeps = {
      store: opened.store,
      workflows: wf.workflows,
      operator: deps.operator,
      now: deps.now,
    };
    const result =
      args.action === 'pause'
        ? await pauseTasks(args.taskIds, args.reason, run)
        : await continueTasks(list as PauseList, run);
    for (const e of result.entries) deps.err(entryLine(e));
    deps.out(JSON.stringify(result));
    return result.entries.some((e) => e.result === 'failed') ? 1 : 0;
  } catch (err) {
    deps.err(`没做成：${errMessage(err)}`);
    return 1;
  } finally {
    await wf?.close().catch(() => undefined);
    await opened?.close().catch(() => undefined);
  }
}
