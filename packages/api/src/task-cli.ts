// fleet-api task continue|abandon|redo（#1402）：任务停下后，指挥官在命令行续、放弃、重做，不用再靠仓外脚本直接打 Temporal。
// 继续、放弃发的信号名和驾驶舱按钮一样（shared/task-signals.ts：taskContinue、taskAbandon）。
// 重做不自己另起工作流，走 temporal.ts 现成的 taskRedo.redo；只在已叫停或挂起时允许，其余拒绝并说原因。
// 每条都写一条操作记录（谁、哪张单、note、结果）。找不到任务工作流时退出码 1，不把成功话交出去。
// 退出码：0 做成了；1 没做成（被拒、找不到、没查成）；2 参数不对（不连库）。

import { TASK_SIGNAL_NAMES, type TaskState, taskWorkflowId } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { TaskRedoPort } from './deps.ts';
import type { Store, TaskSignal, WorkflowControl } from './ports.ts';
import { WorkflowGoneError, WorkflowTargetNotFoundError, WorkflowUnavailableError } from './ports.ts';

export class TaskCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'TaskCliError';
    this.exitCode = exitCode;
  }
}

export const TASK_USAGE =
  '用法：fleet-api task continue|abandon|redo <owner/仓名> <单号> --note "<为什么>"' +
  '（继续、放弃发给任务工作流，信号名和驾驶舱「继续」「叫停」一样：taskContinue、taskAbandon；' +
  '重做走现成的 taskRedo.redo，只在已叫停或挂起时另起一代，做完、失败和还在跑的拒绝并说原因。' +
  '--note 必填，写进操作记录。找不到任务工作流退出码 1，不打印成功。退出码：0 做成了；1 没做成；2 参数不对）';

const ACTIONS = ['continue', 'abandon', 'redo'] as const;
export type TaskAction = (typeof ACTIONS)[number];

export interface TaskArgs {
  action: TaskAction;
  owner: string;
  name: string;
  issueNumber: number;
  note: string;
}

/** GitHub 的写法：owner 是字母、数字、连字符，仓名再加 . 和 _。和 dispatch 同一条。 */
const REPO_ARG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;
const MAX_NOTE = 300;

function usage(message: string): never {
  throw new TaskCliError(`${message}。${TASK_USAGE}`, 2);
}

/** 恰好：动作、仓、单号，加必填的 --note。认不出的一律拒，不猜。 */
export function parseTaskArgs(argv: readonly string[]): TaskArgs {
  const positionals: string[] = [];
  let note: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--note') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) usage('--note 后面要跟为什么');
      note = value.trim();
    } else if (arg.startsWith('-')) {
      usage(`认不出参数 ${arg.split('=')[0]}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 3) usage('要三个参数：continue、abandon 或 redo，仓，单号');
  const [action = '', repo = '', num = ''] = positionals;
  if (!ACTIONS.includes(action as TaskAction)) usage(`认不出「${action}」：只收 continue、abandon、redo`);
  const m = REPO_ARG.exec(repo);
  if (!m?.[1] || !m[2]) usage(`认不出仓「${repo}」：要写成 owner/仓名`);
  if (!/^[1-9]\d{0,8}$/.test(num)) usage(`单号「${num}」不是正整数`);
  if (note === undefined || note === '') usage('--note 必填（写进操作记录）');
  if (note.length > MAX_NOTE) usage(`--note 太长（最多 ${MAX_NOTE} 个字）`);
  return { action: action as TaskAction, owner: m[1], name: m[2], issueNumber: Number(num), note };
}

export interface TaskRunDeps {
  store: Pick<Store, 'findRepoByName' | 'findTaskByIssue' | 'appendAudit'>;
  workflows: WorkflowControl;
  /** 真装配是 connectTemporal().taskRedo（temporal.ts 的 createTemporalTaskRedo）。没给就拒绝重做，不假装另起。 */
  taskRedo: TaskRedoPort;
  /** 谁跑的（FLEET_OPS_OPERATOR）。写进操作记录，也放进信号的 by。 */
  operator: string;
}

export interface OpenedTaskControl {
  workflows: WorkflowControl;
  taskRedo: TaskRedoPort;
  close(): Promise<void>;
}

/** 真 Temporal：懒连接，这一步不探网络。地址和后端 main.ts 同一套默认（temporalSettings）。 */
export async function openTaskControl(
  env: Readonly<Record<string, string | undefined>>,
): Promise<OpenedTaskControl> {
  const { connectTemporal } = await import('./temporal.ts');
  const { temporalSettings } = await import('./config.ts');
  const settings = temporalSettings(env);
  const temporal = connectTemporal({
    address: settings.temporalAddress,
    namespace: settings.temporalNamespace,
    taskQueue: settings.fleetTaskQueue,
  });
  return {
    workflows: temporal.control,
    taskRedo: temporal.taskRedo,
    close: () => temporal.close(),
  };
}

const OPS_TASK = { kind: 'engine', id: 'ops:task' } as const;

/** 做完、已叫停、失败：和 views.ts 的 isTaskFinished、驾驶舱按钮同一份终态。挂起（stalled）不在里面。 */
function isFinished(state: TaskState): boolean {
  return state === 'done' || state === 'stopped' || state === 'failed';
}

interface Recorded {
  ok: boolean;
  result: string;
  taskId?: string | undefined;
}

async function record(deps: TaskRunDeps, args: TaskArgs, ref: string, entry: Recorded): Promise<void> {
  const by = `服务器上 ${deps.operator} 跑的 fleet-api task ${args.action} ${ref}`;
  try {
    await deps.store.appendAudit({
      actor: OPS_TASK,
      action: `task.${args.action}`,
      target: `issue:${ref}`,
      after: {
        who: deps.operator,
        issue: ref,
        note: args.note,
        result: entry.result,
        ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
      },
      reason: `${args.note}（${by}）`,
      via: 'engine',
      ok: entry.ok,
      ...(entry.ok ? {} : { error: entry.result }),
    });
  } catch (err) {
    if (err instanceof TaskCliError) throw err;
    const why = errMessage(err);
    throw new TaskCliError(
      entry.ok
        ? `已经做成了，但操作记录写不进（${why}）：请核对 ${ref}`
        : `没做成：${ref}：${entry.result}；操作记录也没写进去（${why}）`,
      1,
    );
  }
}

/**
 * 做成了回给人看的那一句（调用方打到标准输出）。没做成就抛 TaskCliError（退出码 1），标准输出不要打这一句。
 * 每条路恰好写一条操作记录，记的是做成之后的结果。
 */
export async function runTask(args: TaskArgs, deps: TaskRunDeps): Promise<string> {
  const typed = `${args.owner}/${args.name}#${args.issueNumber}`;
  try {
    return await decide(args, deps, typed);
  } catch (err) {
    if (err instanceof TaskCliError) throw err;
    const result = `没查成：${errMessage(err)}`;
    await record(deps, args, typed, { ok: false, result }).catch(() => undefined);
    throw new TaskCliError(`没做成：${typed}：${result}`, 1);
  }
}

async function decide(args: TaskArgs, deps: TaskRunDeps, typed: string): Promise<string> {
  const refuse = async (ref: string, result: string, taskId?: string): Promise<never> => {
    await record(deps, args, ref, { ok: false, result, taskId });
    throw new TaskCliError(`没做成：${ref}：${result}`, 1);
  };

  const repo = await deps.store.findRepoByName(args.owner, args.name);
  if (!repo) return refuse(typed, `库里没有仓 ${typed.split('#')[0]}，找不到对应的任务工作流`);
  const ref = `${repo.owner}/${repo.name}#${args.issueNumber}`;

  const task = await deps.store.findTaskByIssue(repo.id, args.issueNumber);
  if (!task) return refuse(ref, '库里没有这张单的任务，找不到对应的任务工作流');

  if (args.action === 'redo') {
    if (task.state !== 'stopped' && task.state !== 'stalled') {
      return refuse(ref, `这张单现在是${task.state}，只有已叫停或挂起的才能重做`, task.id);
    }
    let outcome: Awaited<ReturnType<TaskRedoPort['redo']>>;
    try {
      outcome = await deps.taskRedo.redo({
        taskId: task.id,
        issueNumber: task.issueNumber,
        title: task.title,
        repo,
      });
    } catch (err) {
      return refuse(ref, `重做没起成：${errMessage(err)}`, task.id);
    }
    if (!outcome.ok) return refuse(ref, outcome.why, task.id);
    const text = `已重做：${ref}（${outcome.workflowId}，第 ${outcome.generation} 代）`;
    await record(deps, args, ref, { ok: true, result: text, taskId: task.id });
    return text;
  }

  const word = args.action === 'continue' ? '继续' : '放弃';
  if (isFinished(task.state)) {
    return refuse(ref, `任务已经结束（${task.state}），不能再${word}`, task.id);
  }

  let workflowId: string;
  try {
    workflowId = deps.workflows.runningTaskWorkflow
      ? await deps.workflows.runningTaskWorkflow({ owner: repo.owner, name: repo.name }, task.issueNumber)
      : taskWorkflowId(repo, task.issueNumber);
  } catch (err) {
    const why = err instanceof WorkflowUnavailableError ? err.message : errMessage(err);
    return refuse(ref, `查在跑的任务工作流没成：${why}`, task.id);
  }

  const signal: TaskSignal =
    args.action === 'continue'
      ? { name: TASK_SIGNAL_NAMES.continue, by: deps.operator }
      : { name: TASK_SIGNAL_NAMES.abandon, by: deps.operator, reason: args.note };
  try {
    await deps.workflows.signal(workflowId, signal);
  } catch (err) {
    if (err instanceof WorkflowGoneError || err instanceof WorkflowTargetNotFoundError) {
      return refuse(
        ref,
        '这张单的任务工作流已经结束或不存在（做完了、已被叫停，或引擎还没拉起它），没有谁能收到这个操作',
        task.id,
      );
    }
    if (err instanceof WorkflowUnavailableError) {
      return refuse(ref, '工作流服务暂时连不上，信号没发出去', task.id);
    }
    return refuse(ref, `信号没发出去：${errMessage(err)}`, task.id);
  }

  const verb = args.action === 'continue' ? '已继续' : '已放弃';
  const text = `${verb}：${ref}（信号 ${signal.name}）`;
  await record(deps, args, ref, { ok: true, result: text, taskId: task.id });
  return text;
}
