// fleet-api task continue|abandon|redo（#1402）：任务停下后，指挥官在命令行续、放弃、重做，不用再靠仓外脚本直接打 Temporal。
// 继续、放弃发的信号名和驾驶舱按钮一样（shared/task-signals.ts：taskContinue、taskAbandon）。
// 继续同时发 taskRouteWake：等选路的那一觉不看 taskContinue（#2392）。
// 重做不自己另起工作流，走 temporal.ts 现成的 taskRedo.redo；只在已叫停或挂起时允许，其余拒绝并说原因。
// 挂起且上一代还停在 parked：重做入口自己先叫停再另起。真在跑仍由入口拒绝。
// 继续次数用满（停住原因是「已继续 N 次仍没过」）时不发信号，退出码 1，写明要重开用 redo。
// 每条都写一条操作记录（谁、哪张单、note、结果）。找不到任务工作流时退出码 1，不把成功话交出去。
// correct-merged：已结束却误记 abandoned 的真实已合任务，受管纠正运行账，不发信号、不重做；预检只读不记，
// 执行成功的那条记录由 Store 在改任务的同一事务里写（见 task-correct-merged.ts）。
// 退出码：0 做成了；1 没做成（被拒、找不到、没查成）；2 参数不对（不连库）。

import { continueExhausted, TASK_SIGNAL_NAMES, type TaskState, taskWorkflowId } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { continueSignals } from './continue-signals.ts';
import type { TaskRedoPort } from './deps.ts';
import type { HistoricalAuditSource } from './historical-audit-cli.ts';
import { holdOffDiff, type LocalHoldPort } from './local-hold.ts';
import type { Store, TaskSignal, WorkflowControl } from './ports.ts';
import { WorkflowGoneError, WorkflowTargetNotFoundError, WorkflowUnavailableError } from './ports.ts';
import { correctMerged } from './task-correct-merged.ts';

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
  '继续同时发 taskRouteWake，把睡在等选路里的叫醒；' +
  '重做走现成的 taskRedo.redo，只在已叫停或挂起时另起一代，做完、失败和还在跑的拒绝并说原因。' +
  '--note 必填，写进操作记录。找不到任务工作流退出码 1，不打印成功。退出码：0 做成了；1 没做成；2 参数不对）' +
  '。体量关口重评：fleet-api task budget-remeasure <owner/仓名> <单号> --head <完整sha> --base <完整sha> --note "<为什么>"' +
  ' 默认只读预检（只重新测量、不放行、不写操作记录）；预检通过后加 --execute --run <完整runId> --park <停点编号>（都取自预检输出）' +
  '才放行这一份成果；不调用「继续」、不授权后续交付，测不全、超预算、换头换代都保留原停点' +
  '。已结束却误记 abandoned 的真实已合任务：fleet-api task correct-merged <owner/仓名> <单号> --pr <PR号> --head <完整sha> --merge <完整合并提交sha> --run <原Temporal runId> --note "<为什么>"' +
  ' 默认只读预检（现读 GitHub PR、Temporal 原 run、库里任务账，不写任何东西）；预检通过后加 --execute --task <任务编号> --seen <摘要>（取自预检输出）' +
  '才在一个事务里把任务改成 done 并记操作记录；保留原 abandoned 结论、原 run 和 Temporal 历史，不关 issue、不动验收责任，同一请求重复是幂等，换了任何身份或证据都拒绝';

const ACTIONS = ['continue', 'abandon', 'redo', 'budget-remeasure', 'correct-merged'] as const;
export type TaskAction = (typeof ACTIONS)[number];

export interface TaskArgs {
  action: TaskAction;
  owner: string;
  name: string;
  issueNumber: number;
  note: string;
  /** budget-remeasure 专用：精确 head、固定测量 base；--execute 才放行，且必须带预检看到的 run 和停点编号。 */
  head?: string;
  base?: string;
  run?: string;
  park?: string;
  execute?: boolean;
  /** correct-merged 专用：精确 PR 号、真实合并提交、执行时预检打印的任务编号和摘要（--run 是原 Temporal run）。 */
  pr?: number;
  merge?: string;
  task?: string;
  seen?: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const TEMPORAL_RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = TEMPORAL_RUN;
const VALUE_FLAGS = ['--head', '--base', '--run', '--park', '--pr', '--merge', '--task', '--seen'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

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
  const flags: Partial<Record<ValueFlag, string>> = {};
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--note') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) usage('--note 后面要跟为什么');
      note = value.trim();
    } else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) usage(`${arg} 后面要跟值`);
      if (flags[arg as ValueFlag] !== undefined) usage(`${arg} 给了两次`);
      flags[arg as ValueFlag] = value.trim();
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg.startsWith('-')) {
      usage(`认不出参数 ${arg.split('=')[0]}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 3)
    usage('要三个参数：continue、abandon、redo、budget-remeasure 或 correct-merged，仓，单号');
  const [action = '', repo = '', num = ''] = positionals;
  if (!ACTIONS.includes(action as TaskAction))
    usage(`认不出「${action}」：只收 continue、abandon、redo、budget-remeasure、correct-merged`);
  const m = REPO_ARG.exec(repo);
  if (!m?.[1] || !m[2]) usage(`认不出仓「${repo}」：要写成 owner/仓名`);
  if (!/^[1-9]\d{0,8}$/.test(num)) usage(`单号「${num}」不是正整数`);
  if (note === undefined || note === '') usage('--note 必填（写进操作记录）');
  if (note.length > MAX_NOTE) usage(`--note 太长（最多 ${MAX_NOTE} 个字）`);
  const base = { action: action as TaskAction, owner: m[1], name: m[2], issueNumber: Number(num), note };
  if (action === 'correct-merged') {
    const {
      '--head': head,
      '--merge': merge,
      '--run': run,
      '--pr': pr,
      '--task': taskId,
      '--seen': seen,
    } = flags;
    if (flags['--base'] !== undefined || flags['--park'] !== undefined)
      usage('--base、--park 只给 budget-remeasure 用');
    if (pr === undefined || !/^[1-9]\d{0,8}$/.test(pr)) usage('--pr 要写精确的 PR 号（正整数）');
    if (head === undefined || !FULL_SHA.test(head)) usage('--head 要完整 40 位小写 sha（PR 合并时的最终头）');
    if (merge === undefined || !FULL_SHA.test(merge))
      usage('--merge 要完整 40 位小写 sha（GitHub 上真实合并提交）');
    if (run === undefined || !TEMPORAL_RUN.test(run)) usage('--run 要写原 Temporal run 编号（完整 uuid）');
    if (
      execute &&
      (taskId === undefined || !UUID.test(taskId) || seen === undefined || !/^[0-9a-f]{16}$/.test(seen))
    )
      usage('--execute 必须同时带预检打印的 --task（任务编号）和 --seen（16 位摘要）');
    if (!execute && (taskId !== undefined || seen !== undefined)) usage('--task、--seen 只在 --execute 时用');
    return {
      ...base,
      pr: Number(pr),
      head,
      merge,
      run,
      ...(taskId === undefined ? {} : { task: taskId }),
      ...(seen === undefined ? {} : { seen }),
      ...(execute ? { execute: true } : {}),
    };
  }
  if (action !== 'budget-remeasure') {
    if (execute || Object.keys(flags).length > 0)
      usage(
        '--head、--base、--run、--park、--pr、--merge、--task、--seen、--execute 只给 budget-remeasure 或 correct-merged 用',
      );
    return base;
  }
  if (
    flags['--pr'] !== undefined ||
    flags['--merge'] !== undefined ||
    flags['--task'] !== undefined ||
    flags['--seen'] !== undefined
  )
    usage('--pr、--merge、--task、--seen 只给 correct-merged 用');
  const { '--head': head, '--base': from, '--run': run, '--park': park } = flags;
  if (head === undefined || !FULL_SHA.test(head)) usage('--head 要完整 40 位小写 sha（精确的成果头）');
  if (from === undefined || !FULL_SHA.test(from)) usage('--base 要完整 40 位小写 sha（固定的测量基线）');
  if (park !== undefined && !/^\d+\.\d+\.\d+$/.test(park)) usage('--park 要写成预检打印的 停点编号 N.N.N');
  if (execute && (run === undefined || park === undefined))
    usage('--execute 必须同时带预检看到的 --run 和 --park，不凭当前最新状态放行');
  return {
    ...base,
    head,
    base: from,
    ...(run === undefined ? {} : { run }),
    ...(park === undefined ? {} : { park }),
    ...(execute ? { execute: true } : {}),
  };
}

export interface TaskRunDeps {
  store: Pick<
    Store,
    'findRepoByName' | 'findTaskByIssue' | 'appendAudit' | 'readMergedCorrection' | 'correctMergedAbandoned'
  >;
  workflows: WorkflowControl;
  /** correct-merged 现读 GitHub PR 用（只 GET，和 historical-audit 同一份引擎安装凭据）。没给就拒绝纠正。 */
  pulls?: HistoricalAuditSource | undefined;
  /** 真装配是 connectTemporal().taskRedo（temporal.ts 的 createTemporalTaskRedo）。没给就拒绝重做，不假装另起。 */
  taskRedo: TaskRedoPort;
  /**
   * 「继续」「重做」遇到诊断型 / diff 外验收条的单时，留言并贴「本机做」交回本机（#3602）。
   * 没给就只拒绝、在原因里请人手动贴。
   */
  localHold?: LocalHoldPort | undefined;
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

const OPS_TASK = { kind: 'ops', id: 'ops:task' } as const;

/** 做完、已叫停、失败：和 views.ts 的 isTaskFinished、驾驶舱按钮同一份终态。挂起（stalled）不在里面。 */
function isFinished(state: TaskState): boolean {
  return state === 'done' || state === 'stopped' || state === 'failed';
}

/** 重评、纠正的预检只读：不写操作记录；其余动作和它们的执行，成功失败都记。 */
function writesAudit(args: TaskArgs): boolean {
  return (args.action !== 'budget-remeasure' && args.action !== 'correct-merged') || args.execute === true;
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
      via: 'ops',
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
    // 重评、纠正的预检只读，不写操作记录
    if (writesAudit(args)) await record(deps, args, typed, { ok: false, result }).catch(() => undefined);
    throw new TaskCliError(`没做成：${typed}：${result}`, 1);
  }
}

/**
 * 体量关口重评（#3249）。默认只读预检：重新测量这一份成果，不放行、不写操作记录；--execute 才让工作流放行这一份交付，
 * 并写一条操作记录。不发 taskContinue、不增加继续次数、不授权后续交付。任何拒绝都保留原停点，原因照实说。
 */
async function budgetRemeasure(
  args: TaskArgs,
  deps: TaskRunDeps,
  repo: { owner: string; name: string },
  task: { id: string; issueNumber: number; state: TaskState },
  ref: string,
): Promise<string> {
  const execute = args.execute === true;
  const fail = async (result: string): Promise<never> => {
    // 预检只读，不写操作记录；执行的每个结果都记
    if (execute) await record(deps, args, ref, { ok: false, result, taskId: task.id });
    throw new TaskCliError(`没做成：${ref}：${result}`, 1);
  };
  if (isFinished(task.state)) return fail(`任务已经结束（${task.state}），没有可重评的停点`);
  const remeasure = deps.workflows.remeasureLineBudget;
  const execution = deps.workflows.taskWorkflowExecution;
  if (!remeasure || !execution)
    return fail('这个入口没接上可信重评能力（Temporal 控制缺 remeasureLineBudget），没放行');
  let workflowId: string;
  let runId: string;
  try {
    workflowId = deps.workflows.runningTaskWorkflow
      ? await deps.workflows.runningTaskWorkflow({ owner: repo.owner, name: repo.name }, task.issueNumber)
      : taskWorkflowId(repo, task.issueNumber);
    const current = await execution(workflowId);
    if (!current.running) return fail(`任务工作流 ${workflowId} 已经结束，没有可重评的停点`);
    runId = current.runId;
  } catch (err) {
    if (err instanceof TaskCliError) throw err;
    if (err instanceof WorkflowGoneError || err instanceof WorkflowTargetNotFoundError)
      return fail('这张单的任务工作流已经结束或不存在，没有可重评的停点');
    const why = err instanceof WorkflowUnavailableError ? err.message : errMessage(err);
    return fail(`查在跑的任务工作流没成：${why}`);
  }
  if (args.run !== undefined && args.run !== runId)
    return fail(`工作流已换代：现在的 run 是 ${runId}，不是请求的 ${args.run}，没放行`);
  let response: Awaited<ReturnType<typeof remeasure>>;
  try {
    response = await remeasure({
      workflowId,
      runId,
      repo: { owner: repo.owner, name: repo.name },
      taskId: task.id,
      head: args.head as string,
      base: args.base as string,
      mode: execute ? 'resume' : 'check',
      ...(args.park === undefined ? {} : { park: args.park }),
      by: deps.operator,
    });
  } catch (err) {
    if (err instanceof WorkflowGoneError) return fail('任务工作流已经结束，没放行');
    if (err instanceof WorkflowUnavailableError) return fail('工作流服务暂时连不上，结果未知，原停点保留');
    return fail(`重评没做成（结果未知，原停点保留）：${errMessage(err)}`);
  }
  if (!response.ok) {
    const where = response.park ? `；停点 ${response.park}` : '';
    const now = response.current
      ? `；停点上的交付头 ${response.current.head}，原始 ${response.current.rawAddedLines} 行，按预算计 ${response.current.chargeableAddedLines} 行，预算 ${response.current.budget} 行`
      : '';
    return fail(
      `体量重评被拒（${response.reason}）：${response.detail}${where}${now}；原停点保留，没放行任何成果`,
    );
  }
  const r = response.receipt;
  const facts =
    `run ${runId}，停点 ${response.park}，头 ${r.head}，基线 ${r.base}，原始 ${r.rawAddedLines} 行，` +
    `已核生成 ${r.verifiedGeneratedLines} 行，实际计量 ${r.chargeableAddedLines} 行，原预算 ${r.budget} 行`;
  if (!execute) {
    return (
      `预检通过（只读，没放行）：${ref}：${facts}。要放行这一份成果：` +
      `fleet-api task budget-remeasure ${repo.owner}/${repo.name} ${task.issueNumber} --head ${r.head} --base ${r.base} ` +
      `--execute --run ${runId} --park ${response.park} --note "<为什么>"`
    );
  }
  const text =
    response.outcome === 'already_resumed'
      ? `已放行过（幂等回执，不再放行别的头）：${ref}：${facts}`
      : `已放行这一份成果（不算「继续」，不授权后续交付）：${ref}：${facts}`;
  await record(deps, args, ref, { ok: true, result: text, taskId: task.id });
  return text;
}

async function decide(args: TaskArgs, deps: TaskRunDeps, typed: string): Promise<string> {
  const refuse = async (ref: string, result: string, taskId?: string): Promise<never> => {
    if (writesAudit(args)) await record(deps, args, ref, { ok: false, result, taskId });
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
    const held = await holdOffDiff(
      task,
      { repo: { owner: repo.owner, name: repo.name }, issueNumber: task.issueNumber },
      'task.redo',
      deps.localHold,
    );
    if (held) return refuse(ref, held.why, task.id);
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

  if (args.action === 'budget-remeasure') return budgetRemeasure(args, deps, repo, task, ref);

  if (args.action === 'correct-merged') {
    // 成功时操作记录已由 Store 在改任务的同一事务里写了，这里不再另记；拒绝照常由 refuse 记（预检不记）
    const outcome = await correctMerged(
      {
        repo,
        task,
        pr: args.pr as number,
        head: args.head as string,
        mergeCommit: args.merge as string,
        run: args.run as string,
        execute: args.execute === true,
        expectTask: args.task,
        seen: args.seen,
        note: args.note,
        operator: deps.operator,
      },
      { store: deps.store, workflows: deps.workflows, pulls: deps.pulls },
    );
    if (!outcome.ok) return refuse(ref, outcome.result, task.id);
    return outcome.text;
  }

  const word = args.action === 'continue' ? '继续' : '放弃';
  if (isFinished(task.state)) {
    return refuse(ref, `任务已经结束（${task.state}），不能再${word}`, task.id);
  }
  if (args.action === 'continue') {
    const exhausted = continueExhausted(task.stalled?.why);
    if (exhausted) return refuse(ref, exhausted, task.id);
    const held = await holdOffDiff(
      task,
      { repo: { owner: repo.owner, name: repo.name }, issueNumber: task.issueNumber },
      'continue',
      deps.localHold,
    );
    if (held) return refuse(ref, held.why, task.id);
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

  const signals: TaskSignal[] =
    args.action === 'continue'
      ? continueSignals(deps.operator)
      : [{ name: TASK_SIGNAL_NAMES.abandon, by: deps.operator, reason: args.note }];
  try {
    for (const signal of signals) await deps.workflows.signal(workflowId, signal);
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
  const text = `${verb}：${ref}（信号 ${signals.map((s) => s.name).join('、')}）`;
  await record(deps, args, ref, { ok: true, result: text, taskId: task.id });
  return text;
}
