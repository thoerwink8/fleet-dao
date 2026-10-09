// 点名派单（母单 #1335 第 2 片，#1337）：「让 AI 接活」开关关着的时候，本机经 `fleet-api dispatch-issue` 把某一张单立刻交给引擎。
// 对这一张单跑一遍引擎拉单的准入（jobs/intake.ts 和 @fleet-dao/core 的 dispatch.ts 里现成的判法函数，这里只排顺序，不复制判法），
// 过了就起任务工作流（和拉单同一个 start：先建任务行，再用定死的编号起，REJECT_DUPLICATE，所以已派过的不会重复派）。
//
// 改这里之前必须知道：
// - 闸分两类。「硬闸」任何情况下都不放行（--force 也不行）：不是 issue / 已关、作者不在白名单、母单子单、本机做、已派过、碰 workflows、
//   已有 PR 挂着、版本认不出（没查成）、交代不全（任务工作流第一步会拒收，放行了只会起一条马上失败的工作流）。
//   「就绪度闸」--force 可以放行：不是当前版本（含未排期）、改动规模是最重档、历史失败超限。放行必须带 --note，进操作记录。
// - 硬闸遇到第一个就停（后面的不必读）；就绪度闸全部判完一次说全，让人看清 force 放行的是哪几样。
// - 不看「让 AI 接活」开关（这条命令就是给开关关着用的），但引擎总开关关着一律拒：关着的引擎不起会话，派了也只是排队。
// - 读不到、认不出的一律抛错（命令行打印「没查成」并非 0 退出），不当成「过了」。
// - 每次（派了、拒了、没查成）都写一条操作记录：谁、哪张单、force 与 note、结果。派出之后记录写不进要明说（工作流已经起了）。
// - 和 #1336（拉单挑单规则重做）并行改：这里只调 intake.ts 已经导出的 workflowPathIn、prClaimedIssues 这些，不改它们。
//   #1336 合并后如果加了新的准入闸（比如「验收条是 diff 里看得见的」），要把它也排进这里（硬还是就绪度，按 FORCEABLE 分），见 PR 说明。

import { familyGate, localGate, versionGate } from '@fleet-dao/core';
import { type EngineMasterState, engineMasterOf, type MasterSettingRow } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type GithubWhitelist, isTrusted } from '@fleet-dao/store';
import { masterOffNote } from '../engine-master.ts';
import { readTaskBrief, type TaskBrief } from '../runner/task-brief.ts';
import {
  type IntakeDeps,
  type IntakeIssue,
  type IntakePlan,
  type IntakeRepo,
  workflowPathIn,
} from './intake.ts';

/** 历史失败超过这么多次（即第 3 次起）就算超限。 */
export const MAX_FAILED_ATTEMPTS = 2;

/** 操作记录里这件事的名字；target 是 issue:<owner/仓>#<号>。 */
export const DISPATCH_ISSUE_AUDIT = 'dispatch.issue';

/** 没过的原因。就绪度那几个（FORCEABLE）--force 能放行，其余不能。 */
export type DispatchGateReason =
  | 'repo_not_found'
  | 'engine_off'
  | 'pull_request'
  | 'closed'
  | 'untrusted_author'
  | 'mother_ticket'
  | 'sub_issue'
  | 'reserved_local'
  | 'already_dispatched'
  | 'touches_workflows'
  | 'pr_claimed'
  | 'version_unreadable'
  | 'brief_incomplete'
  | 'unscheduled'
  | 'not_current_version'
  | 'heaviest_tier'
  | 'failure_history';

/** --force 能放行的就绪度闸。别的一律不放行：往这里加一个，就是放宽一道闸，要在 PR 里说清。 */
export const FORCEABLE: ReadonlySet<DispatchGateReason> = new Set([
  'unscheduled',
  'not_current_version',
  'heaviest_tier',
  'failure_history',
]);

export interface GateFailure {
  reason: DispatchGateReason;
  why: string;
  /** --force 能不能放行（reason 在 FORCEABLE 里）。 */
  forceable: boolean;
}

const fail = (reason: DispatchGateReason, why: string): GateFailure => ({
  reason,
  why,
  forceable: FORCEABLE.has(reason),
});

export interface DispatchIssueArgs {
  owner: string;
  name: string;
  issueNumber: number;
  force: boolean;
  /** --force 的理由，写进操作记录；force 时必有。 */
  note?: string | undefined;
}

export type DispatchIssueResult =
  | {
      outcome: 'started';
      /** --force 放行了的就绪度闸（没用上 force 时是空的）。 */
      forced: GateFailure[];
      tier: TaskBrief['tier'];
    }
  | { outcome: 'refused'; failures: GateFailure[] };

export interface DispatchIssueDeps {
  /** 受管的仓里按名字找（不分大小写）；没有回 null。读不到照抛。 */
  findRepo(owner: string, name: string): Promise<IntakeRepo | null>;
  /** 引擎总开关那一行（real 里是 @fleet-dao/db 的 readEngineMasterRow）；没设过回 null；读不到照抛。 */
  engineMasterRow(): Promise<MasterSettingRow | null>;
  whitelist(): Promise<GithubWhitelist>;
  /** 这张单此刻的样子（版本、母单子单、标签、开没开着、是不是 PR）。读不到照抛。 */
  plan: IntakeDeps['plan'];
  /** 这张单在仓里开着的单列表里的样子（标题、正文、作者）；列表里没有回 null。读不到照抛。 */
  listIssue(repo: IntakeRepo, issueNumber: number): Promise<IntakeIssue | null>;
  dispatched: IntakeDeps['dispatched'];
  openPrClaims: IntakeDeps['openPrClaims'];
  readSpecDoc: IntakeDeps['readSpecDoc'];
  /** 这张单以前的任务工作流里失败收场的有几条。读不到照抛：不当成 0。 */
  failedAttempts(repo: IntakeRepo, issueNumber: number): Promise<number>;
  start: IntakeDeps['start'];
  /** 写一条操作记录。 */
  audit(entry: DispatchIssueAudit): Promise<void>;
}

export interface DispatchIssueAudit {
  repo: string;
  issueNumber: number;
  force: boolean;
  note?: string | undefined;
  ok: boolean;
  /** 结果一句话（派了 / 哪一道没过 / 没查成）。 */
  result: string;
  forced: DispatchGateReason[];
}

/** 派出去了，可是操作记录写不进：工作流已经起了，要让人看见。 */
export class DispatchAuditError extends Error {
  readonly result: DispatchIssueResult;
  constructor(result: DispatchIssueResult, cause: unknown) {
    super(`已经派出去了，但操作记录写不进（${errMessage(cause)}）：请手工核对这张单的任务`);
    this.name = 'DispatchAuditError';
    this.result = result;
  }
}

function masterNote(row: MasterSettingRow | null): { on: true } | { on: false; why: string } {
  const state: EngineMasterState = engineMasterOf(row);
  return state.on ? { on: true } : { on: false, why: masterOffNote(state) };
}

/** 版本这一道：判法是 core 的 versionGate；没挂、不是当前版本能 force，认不出版本号是没查成不能 force。 */
function versionFailure(plan: IntakePlan): GateFailure | null {
  const gate = versionGate({ milestone: plan.milestone, openMilestones: plan.openMilestones });
  return gate.ok ? null : fail(gate.reason, gate.why);
}

/** 硬闸，按便宜的先判；回第一个没过的。读不到的照抛。 */
async function hardFailure(
  deps: DispatchIssueDeps,
  repo: IntakeRepo,
  issueNumber: number,
): Promise<
  { failure: GateFailure } | { failure: null; issue: IntakeIssue; plan: IntakePlan; brief: TaskBrief }
> {
  const master = masterNote(await deps.engineMasterRow());
  if (!master.on) return { failure: fail('engine_off', master.why) };

  const plan = await deps.plan(repo, issueNumber);
  if (plan.pullRequest) return { failure: fail('pull_request', '这个号是 PR，不是 issue') };
  if (plan.state !== 'open') return { failure: fail('closed', '这张单已经关了') };

  const issue = await deps.listIssue(repo, issueNumber);
  if (issue === null) {
    throw new Error(`#${issueNumber} 现读是开着的 issue，可开着的单列表里找不到它：读不全，没查成`);
  }
  if (!isTrusted(issue.author, await deps.whitelist())) {
    return { failure: fail('untrusted_author', '开单人不在白名单里') };
  }
  const family = familyGate(plan);
  if (!family.ok) return { failure: fail(family.reason, family.why) };
  const local = localGate(plan);
  if (!local.ok) return { failure: fail(local.reason, local.why) };

  if (await deps.dispatched(repo, issueNumber)) {
    return {
      failure: fail(
        'already_dispatched',
        '已经派出过（要再做，跑 fleet-api task redo <owner/仓> <单号> --note "<为什么>"，或在驾驶舱点「重做」）',
      ),
    };
  }
  const workflowPath = workflowPathIn(issue.body);
  if (workflowPath !== null) {
    return {
      failure: fail(
        'touches_workflows',
        `正文写了 ${workflowPath}，引擎的令牌推不了改工作流的提交，派了只会白烧一轮`,
      ),
    };
  }
  const prNumber = (await deps.openPrClaims(repo)).get(issueNumber);
  if (prNumber !== undefined) {
    return { failure: fail('pr_claimed', `已有 PR #${prNumber} 在做，别并行再写一遍`) };
  }

  // 版本号认不出是「没查成」，不是「不是当前版本」：不让 force 顶过去
  const version = versionGate({ milestone: plan.milestone, openMilestones: plan.openMilestones });
  if (!version.ok && version.reason === 'version_unreadable') {
    return { failure: fail('version_unreadable', version.why) };
  }

  const brief = await readTaskBrief(
    {
      readIssue: async () => ({ number: issue.number, title: issue.title, body: issue.body, state: 'open' }),
      readSpecDoc: ({ path }) => deps.readSpecDoc({ repo, path }),
    },
    { repo: { owner: repo.owner, name: repo.name }, issueNumber },
  );
  if (!brief.ok) {
    const what = brief.problems.map((p) => `【${p.field}】${p.why}`).join('；');
    return {
      failure: fail('brief_incomplete', `交代不全（任务工作流第一步会拒收，force 也派不了）：${what}`),
    };
  }
  return { failure: null, issue, plan, brief: brief.brief };
}

/** 就绪度闸：全部判完一次说全。 */
async function readinessFailures(
  deps: DispatchIssueDeps,
  repo: IntakeRepo,
  issueNumber: number,
  plan: IntakePlan,
  brief: TaskBrief,
): Promise<GateFailure[]> {
  const out: GateFailure[] = [];
  const version = versionFailure(plan);
  if (version) out.push(version);
  if (brief.tier.tier === 'heavyweight') {
    out.push(fail('heaviest_tier', `改动规模是最重档：${brief.tier.reason}`));
  }
  const failed = await deps.failedAttempts(repo, issueNumber);
  if (failed > MAX_FAILED_ATTEMPTS) {
    out.push(fail('failure_history', `以前已经失败过 ${failed} 次，超过 ${MAX_FAILED_ATTEMPTS} 次`));
  }
  return out;
}

function summarize(result: DispatchIssueResult): string {
  if (result.outcome === 'started') {
    return result.forced.length > 0
      ? `已派（force 放行了：${result.forced.map((f) => f.reason).join('、')}）`
      : '已派';
  }
  return `没派：${result.failures.map((f) => `${f.reason}（${f.why}）`).join('；')}`;
}

/**
 * 对一张单跑准入，过了就起任务工作流。任何情况下都写操作记录。
 * 没过回 refused（不抛）；读不到、起工作流出错抛错（也写一条 ok=false 的记录）。
 */
export async function dispatchIssue(
  deps: DispatchIssueDeps,
  args: DispatchIssueArgs,
): Promise<DispatchIssueResult> {
  const slug = `${args.owner}/${args.name}`;
  const audit = (ok: boolean, result: string, forced: DispatchGateReason[]) =>
    deps.audit({
      repo: slug,
      issueNumber: args.issueNumber,
      force: args.force,
      note: args.note,
      ok,
      result,
      forced,
    });

  let result: DispatchIssueResult;
  try {
    result = await decide(deps, args);
  } catch (err) {
    // 没查成也留一条记录；这条写不进就算了，不盖掉原来的错
    await audit(false, `没查成：${errMessage(err)}`, []).catch(() => undefined);
    throw err;
  }
  try {
    await audit(
      result.outcome === 'started',
      summarize(result),
      result.outcome === 'started' ? result.forced.map((f) => f.reason) : [],
    );
  } catch (err) {
    // 拒了，记录写不进：照常返回拒绝（什么都没起）；派了，记录写不进：明说
    if (result.outcome === 'started') throw new DispatchAuditError(result, err);
    throw err;
  }
  return result;
}

async function decide(deps: DispatchIssueDeps, args: DispatchIssueArgs): Promise<DispatchIssueResult> {
  const repo = await deps.findRepo(args.owner, args.name);
  if (repo === null) {
    return {
      outcome: 'refused',
      failures: [
        fail('repo_not_found', `库里没有仓 ${args.owner}/${args.name}（受管的仓就是 repos 表的行）`),
      ],
    };
  }
  const hard = await hardFailure(deps, repo, args.issueNumber);
  if (hard.failure) return { outcome: 'refused', failures: [hard.failure] };

  const { issue, plan, brief } = hard;
  const soft = await readinessFailures(deps, repo, args.issueNumber, plan, brief);
  if (soft.length > 0 && !args.force) return { outcome: 'refused', failures: soft };

  const got = await deps.start({
    repo,
    issueNumber: args.issueNumber,
    title: brief.title,
    body: issue.body,
    author: issue.author,
  });
  if (got === 'already_exists') {
    return {
      outcome: 'refused',
      failures: [
        fail(
          'already_dispatched',
          '任务工作流的编号已经用过，不重复派（要再做，跑 fleet-api task redo，或在驾驶舱点「重做」）',
        ),
      ],
    };
  }
  return { outcome: 'started', forced: soft, tier: brief.tier };
}

// —— 命令行参数和打印 ——

export const DISPATCH_ISSUE_USAGE =
  '用法：fleet-api dispatch-issue <owner/仓名> <单号> [--force --note "<为什么>"]（开关关着时点名把一张单交给引擎：先跑一遍拉单的准入，过了才派。' +
  '--force 只放行就绪度闸〔不是当前版本、规模最重档、历史失败超限〕，必须带 --note；作者白名单、母单子单、本机做、已有 PR、碰 workflows、已派过任何情况下都不放行。' +
  '不受「让 AI 接活」开关限制，但引擎总开关关着会拒。每次都写操作记录。退出码：0 派了；1 没派或没查成；2 参数不对）';

export class DispatchIssueUsageError extends Error {
  constructor(message: string) {
    super(`${message}。${DISPATCH_ISSUE_USAGE}`);
    this.name = 'DispatchIssueUsageError';
  }
}

const REPO_ARG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;
const MAX_NOTE = 300;

/** 恰好：仓、单号，加可选的 --force --note <为什么>。认不出的一律拒，不猜。 */
export function parseDispatchIssueArgs(argv: readonly string[]): DispatchIssueArgs {
  const positionals: string[] = [];
  let force = false;
  let note: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--force') {
      force = true;
    } else if (arg === '--note') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--'))
        throw new DispatchIssueUsageError('--note 后面要跟理由');
      note = value.trim();
    } else if (arg.startsWith('-')) {
      throw new DispatchIssueUsageError(`认不出参数 ${arg.split('=')[0]}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 2) throw new DispatchIssueUsageError('要两个参数：仓和单号');
  const [repo = '', num = ''] = positionals;
  const m = REPO_ARG.exec(repo);
  if (!m?.[1] || !m[2]) throw new DispatchIssueUsageError(`认不出仓「${repo}」：要写成 owner/仓名`);
  if (!/^[1-9]\d{0,8}$/.test(num)) throw new DispatchIssueUsageError(`单号「${num}」不是正整数`);
  if (force && (note === undefined || note === '')) {
    throw new DispatchIssueUsageError('--force 必须带 --note "<为什么>"（理由写进操作记录）');
  }
  if (!force && note !== undefined) throw new DispatchIssueUsageError('--note 只配 --force 用');
  if (note !== undefined && note.length > MAX_NOTE) {
    throw new DispatchIssueUsageError(`--note 太长（最多 ${MAX_NOTE} 个字）`);
  }
  return {
    owner: m[1],
    name: m[2],
    issueNumber: Number(num),
    force,
    ...(note === undefined ? {} : { note }),
  };
}

export interface DispatchIssueIo {
  out(text: string): void;
  err(text: string): void;
  /** 连库、GitHub、Temporal（参数对了才连）；close 在用完后关连接。 */
  open(): Promise<{ deps: DispatchIssueDeps; close(): Promise<void> }>;
}

/** 命令行本体：返回退出码。0 派了；1 没派或没查成；2 参数不对。 */
export async function runDispatchIssue(argv: readonly string[], io: DispatchIssueIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(DISPATCH_ISSUE_USAGE);
    return 0;
  }
  let args: DispatchIssueArgs;
  try {
    args = parseDispatchIssueArgs(argv);
  } catch (err) {
    if (!(err instanceof DispatchIssueUsageError)) throw err;
    io.err(err.message);
    return 2;
  }
  let opened: Awaited<ReturnType<DispatchIssueIo['open']>> | undefined;
  try {
    opened = await io.open();
    const result = await dispatchIssue(opened.deps, args);
    const text = describeDispatchIssue(args, result);
    if (result.outcome === 'started') {
      io.out(text);
      return 0;
    }
    io.err(text);
    return 1;
  } catch (err) {
    io.err(err instanceof DispatchAuditError ? err.message : `没查成：${errMessage(err)}`);
    return 1;
  } finally {
    await opened?.close().catch(() => undefined);
  }
}

/** 给人看的结果。 */
export function describeDispatchIssue(args: DispatchIssueArgs, result: DispatchIssueResult): string {
  const ref = `${args.owner}/${args.name}#${args.issueNumber}`;
  if (result.outcome === 'started') {
    const lines = [`已派：${ref} 的任务工作流已经起了（${result.tier.reason}）`];
    for (const f of result.forced)
      lines.push(`  force 放行：${f.reason}（${f.why}）；理由：${args.note ?? ''}`);
    return lines.join('\n');
  }
  const lines = [`没派：${ref}`];
  for (const f of result.failures) {
    const hint = f.forceable
      ? args.force
        ? ''
        : '（就绪度闸，确认没问题可以加 --force --note "<为什么>"）'
      : '（硬闸，force 也不放行）';
    lines.push(`  ${f.reason}：${f.why}${hint}`);
  }
  return lines.join('\n');
}
