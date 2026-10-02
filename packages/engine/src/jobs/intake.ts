// 拉单（#632 S2-2；specs/632-三段总调度/方案.md §五）：每 5 分钟一轮，引擎自己到 GitHub 读「该做的单」，替掉 webhook 接活加认领。
// 一轮 = 记下开始 → 对每个开了「让 AI 接活」的仓：读开着的单 → 逐张过关 → 对过了关的单读一遍交代（readTaskBrief）→ 交代不全的
// 在单子上留一条言写清缺什么，齐的起任务工作流 → 把结局记进 schedule_runs。拉单本身不动单子（不贴「在做」、不抢认领）。
//
// 过关的顺序是先便宜的再贵的（列表里就有的，再多读一次 GitHub 的）：
//   开关打开以后开的（0003 第 2 条）→ 作者在白名单里（公开仓陌生人能开单，白名单是唯一的门）→ 挂在当前版本上（第 8 条）→
//   不是母单子单、没贴「本机做」→ 还没派过 → 现读一遍这张单（开着、不是 PR、版本和母单子单再核一遍）→ 交代齐不齐 → 容量。
// 每一道的判法都是 @fleet-dao/core 的 dispatch.ts 那几个纯函数（versionGate、familyGate、localGate），这里只排顺序。
//
// 改这里之前必须知道：
// - 读不到的不当成没有：读仓里的单失败、白名单读不出、现读一张单失败、起工作流失败，都记进 unchecked，这一轮记 partial / failed，
//   不记 ok（没跑成 ≠ 没问题）。「开关都关着」是正常的空闲，不是没扫到：scanned 里算上受管的仓，免得看门狗把空闲当成故障。
// - 同一张单任何时候最多一条任务工作流：工作流编号定死（taskWorkflowId），起的时候由真实现用 REJECT_DUPLICATE；这里再用
//   dispatched() 先挡一道，省得每 5 分钟为已经派出去的单多读一次 GitHub。重开的单不会自己重来，要人在驾驶舱点「继续」。
// - 交代不全的单只留一次言：留言的幂等键由缺的内容算出来，同一处缺法不会每 5 分钟再留一条；缺的变了才是新的一条。
// - 每轮最多起 MAX_STARTS_PER_ROUND 条、同时在跑的任务工作流不超过 MAX_RUNNING_TASKS 条：开关刚打开、一堆单同时合格时，
//   一批一批地起，不一次把机器的内存和额度吃满；没起的下一轮（5 分钟后）自然再来。
import { createHash } from 'node:crypto';
import type { GithubWhitelist } from '@fleet-dao/api/whitelist';
import { isTrusted } from '@fleet-dao/api/whitelist';
import {
  autoDispatchGate,
  familyGate,
  type IssueFamily,
  type IssueMilestones,
  localGate,
  type MilestoneRef,
  versionGate,
} from '@fleet-dao/core';
import type { ScheduleResult } from '@fleet-dao/db';
import { type BriefProblem, describeBriefProblems, readTaskBrief } from '../runner/task-brief.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { clip, message } from './reconcile-common.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来（看门狗按登记表查）。 */
export const INTAKE_JOB = {
  id: 'intake',
  name: '引擎拉单（读该做的单，起任务工作流）',
  schedule: '每 5 分钟',
  // 连着三轮没跑成才算过期：单子晚 15 分钟被拉起没关系，偶尔一轮慢不报。
  expectEveryMinutes: 15,
} as const;

export const INTAKE_EVERY_MINUTES = 5;
/** 每轮最多起几条任务工作流。 */
export const MAX_STARTS_PER_ROUND = 5;
/** 同时在跑的任务工作流最多几条（再多就等，不是丢）。 */
export const MAX_RUNNING_TASKS = 6;
/** why 最长多少字：没查成的一条一句，太多了截断（总数照写）。 */
export const INTAKE_WHY_MAX = 1500;

export interface IntakeRepo {
  id: string;
  owner: string;
  name: string;
  /** 「让 AI 接活」打开的时刻（ISO）；null＝关着。 */
  autoDispatchSince: string | null;
}

/** 列表里读到的一张开着的单（不含 PR）。 */
export interface IntakeIssue {
  number: number;
  title: string;
  body: string;
  /** 开单人；账号删了是 null（认不出的人不在白名单里）。 */
  author: { login: string; id: number; type: string } | null;
  createdAt: string;
  labels: string[];
  milestone: MilestoneRef | null;
}

/** 这张单此刻的样子（GitHub 现读，@fleet-dao/github 的 readIssuePlan）：版本、母单子单、标签，加开没开着、是不是 PR。 */
export type IntakePlan = IssueMilestones & IssueFamily & { state: 'open' | 'closed'; pullRequest: boolean };

export type IntakeSkipReason =
  | 'created_at_unreadable'
  | 'opened_before_switch'
  | 'untrusted_author'
  | 'unscheduled'
  | 'not_current_version'
  | 'version_unreadable'
  | 'mother_ticket'
  | 'sub_issue'
  | 'reserved_local'
  | 'already_dispatched'
  | 'pull_request'
  | 'closed'
  | 'brief_incomplete'
  | 'round_cap'
  | 'at_capacity'
  | 'already_exists';

/** 这几种是「没查成」不是「不该派」：记进 unchecked，这一轮不记 ok。 */
const UNREADABLE: ReadonlySet<IntakeSkipReason> = new Set(['created_at_unreadable', 'version_unreadable']);

export interface IntakeSkip {
  reason: IntakeSkipReason;
  why: string;
}

/**
 * 只看列表里就有的东西能不能判掉（不再多读一次 GitHub）。回 null＝这一道都过了，往下走。
 * 判法的出处：开关打开以后开的（dispatchDecision，0003 第 2 条）；作者白名单（公开仓唯一的门）；版本（versionGate，第 8 条）；
 * 母单标签、本机做标签（familyGate、localGate 里只靠标签的那部分；子单、挂了子单要多读一次，在 screenPlan）。
 */
export function screenListed(input: {
  autoDispatchSince: string;
  issue: IntakeIssue;
  trusted: boolean;
  openMilestones: readonly MilestoneRef[];
}): IntakeSkip | null {
  const { issue } = input;
  const opened = Date.parse(issue.createdAt);
  if (!Number.isFinite(opened)) {
    return {
      reason: 'created_at_unreadable',
      why: `开单时间认不出（${issue.createdAt}），不当成开关打开以后开的`,
    };
  }
  if (opened < Date.parse(input.autoDispatchSince)) {
    return { reason: 'opened_before_switch', why: '开关打开以前就开着的单不自动派（要人明说交给 fleet）' };
  }
  if (!input.trusted) return { reason: 'untrusted_author', why: '开单人不在白名单里' };
  const version = versionGate({ milestone: issue.milestone, openMilestones: input.openMilestones });
  if (!version.ok) return { reason: version.reason, why: version.why };
  const family = familyGate({ labels: issue.labels, parent: null, subIssues: 0 });
  if (!family.ok) return { reason: family.reason, why: family.why };
  const local = localGate({ labels: issue.labels });
  if (!local.ok) return { reason: local.reason, why: local.why };
  return null;
}

/** 现读之后的最后一道：这个号开着、是 issue；版本、母单子单、本机做按这一刻读到的再核一遍（列表读到的可能早过时了）。 */
export function screenPlan(plan: IntakePlan): IntakeSkip | null {
  if (plan.pullRequest) return { reason: 'pull_request', why: '这个号是 PR，不是 issue' };
  if (plan.state !== 'open') return { reason: 'closed', why: '这张单已经关了' };
  const gate = autoDispatchGate(plan);
  if (!gate.ok) return { reason: gate.reason, why: gate.why };
  return null;
}

/** 交代不全时留在单子上的话。 */
export function incompleteComment(problems: readonly BriefProblem[]): string {
  return [
    '引擎想拉起这张单，可单子还缺东西，先没派：',
    '',
    describeBriefProblems(problems),
    '',
    `补齐后约 ${INTAKE_EVERY_MINUTES} 分钟内引擎会自动再看一遍；同一处缺法只留这一条话，缺的变了才会再留。`,
  ].join('\n');
}

/** 留言的幂等键：由缺的内容算出来，同一处缺法同一个键。 */
export function incompleteKey(problems: readonly BriefProblem[]): string {
  const digest = createHash('sha256').update(describeBriefProblems(problems)).digest('hex').slice(0, 12);
  return `intake-incomplete:${digest}`;
}

export interface IntakeDeps {
  /** 受管的仓（开关关着的也列出来：全关是正常的空闲，不是没扫到东西）。读不到照抛：这一轮记没跑成。 */
  repos(): Promise<IntakeRepo[]>;
  /** 作者白名单。读不到照抛：不当成「没有可信的人」。 */
  whitelist(): Promise<GithubWhitelist>;
  /** 这个仓开着的单加仓里还开着的里程碑。读不到照抛。 */
  openIssues(repo: IntakeRepo): Promise<{ issues: IntakeIssue[]; openMilestones: MilestoneRef[] }>;
  /** 这张单此刻的样子。读不到照抛。 */
  plan(repo: IntakeRepo, issueNumber: number): Promise<IntakePlan>;
  /** 这张单是不是已经派出过（库里有任务行且不在排队，或者工作流编号用过）。读不到照抛：不当成「没派过」。 */
  dispatched(repo: IntakeRepo, issueNumber: number): Promise<boolean>;
  /** 读主线上的需求文档；文件不在回 null，读失败照抛。 */
  readSpecDoc(input: { repo: IntakeRepo; path: string }): Promise<{ content: string } | null>;
  /** 现在在跑的任务工作流有几条。读不到照抛：不当成「一条没有」。 */
  runningTasks(): Promise<number>;
  /** 起任务工作流（编号定死、REJECT_DUPLICATE）：编号已经用过回 already_exists。 */
  start(input: {
    repo: IntakeRepo;
    issueNumber: number;
    title: string;
  }): Promise<'started' | 'already_exists'>;
  /** 在单子上留言（同一个键只留一条）；以前留过回 created: false。 */
  comment(input: {
    repo: IntakeRepo;
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{ created: boolean }>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /** 测试用：换掉每轮上限。 */
  limits?: { maxStartsPerRound?: number; maxRunningTasks?: number };
}

export interface IntakeRun {
  runId: number;
  outcome: 'ok' | 'partial' | 'unscanned' | 'failed';
  scanned: number;
  found: number;
  why?: string | undefined;
}

/** 这一轮没跑成：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class IntakeFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'IntakeFailedError';
    this.runId = runId;
  }
}

interface Tally {
  scanned: number;
  started: number;
  commented: number;
  skipped: Map<IntakeSkipReason, number>;
  unchecked: string[];
  /** 开着开关的仓里，列单子就失败了的有几个（全都失败＝这一轮没跑成）。 */
  reposFailed: number;
  reposOn: number;
  /** 这一轮开头读到的在跑条数，起一条加一。 */
  running: number;
}

function skip(t: Tally, slug: string, issue: number, s: IntakeSkip): void {
  t.skipped.set(s.reason, (t.skipped.get(s.reason) ?? 0) + 1);
  if (UNREADABLE.has(s.reason)) t.unchecked.push(`${slug}#${issue}：没查成：${s.why}`);
}

async function intakeIssue(
  deps: IntakeDeps,
  repo: IntakeRepo,
  autoDispatchSince: string,
  issue: IntakeIssue,
  listed: { openMilestones: MilestoneRef[] },
  whitelist: GithubWhitelist,
  t: Tally,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const early = screenListed({
    autoDispatchSince,
    issue,
    trusted: isTrusted(issue.author, whitelist),
    openMilestones: listed.openMilestones,
  });
  if (early) return skip(t, slug, issue.number, early);
  if (await deps.dispatched(repo, issue.number)) {
    return skip(t, slug, issue.number, { reason: 'already_dispatched', why: '已经派出过' });
  }
  const late = screenPlan(await deps.plan(repo, issue.number));
  if (late) return skip(t, slug, issue.number, late);

  // 单子正文就用列表里读到的这份，不再读一遍；指着的需求文档要读主线上的
  const brief = await readTaskBrief(
    {
      readIssue: async () => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: 'open',
      }),
      readSpecDoc: ({ path }) => deps.readSpecDoc({ repo, path }),
    },
    { repo: { owner: repo.owner, name: repo.name }, issueNumber: issue.number },
  );
  if (!brief.ok) {
    const posted = await deps.comment({
      repo,
      issueNumber: issue.number,
      key: incompleteKey(brief.problems),
      body: incompleteComment(brief.problems),
    });
    if (posted.created) {
      t.commented += 1;
      deps.log('info', `拉单：${slug}#${issue.number} 交代不全，已在单子上留言`, {
        problems: brief.problems.map((p) => p.field),
      });
    }
    return skip(t, slug, issue.number, {
      reason: 'brief_incomplete',
      why: brief.problems.map((p) => p.field).join('、'),
    });
  }

  const maxStarts = deps.limits?.maxStartsPerRound ?? MAX_STARTS_PER_ROUND;
  const maxRunning = deps.limits?.maxRunningTasks ?? MAX_RUNNING_TASKS;
  if (t.started >= maxStarts) {
    return skip(t, slug, issue.number, {
      reason: 'round_cap',
      why: `这一轮已经起了 ${maxStarts} 条，其余下一轮`,
    });
  }
  if (t.running >= maxRunning) {
    return skip(t, slug, issue.number, {
      reason: 'at_capacity',
      why: `在跑的任务已经 ${t.running} 条（上限 ${maxRunning}），等有空的`,
    });
  }
  const got = await deps.start({ repo, issueNumber: issue.number, title: brief.brief.title });
  if (got === 'already_exists') {
    return skip(t, slug, issue.number, { reason: 'already_exists', why: '任务工作流的编号已经用过' });
  }
  t.started += 1;
  t.running += 1;
  deps.log('info', `拉单：起了 ${slug}#${issue.number} 的任务工作流`, {
    tier: brief.brief.tier.tier,
    why: brief.brief.tier.reason,
  });
}

async function intakeRepo(
  deps: IntakeDeps,
  repo: IntakeRepo,
  whitelist: GithubWhitelist,
  t: Tally,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const since = repo.autoDispatchSince;
  if (since === null) return;
  t.reposOn += 1;
  if (!Number.isFinite(Date.parse(since))) {
    t.reposFailed += 1;
    t.unchecked.push(`${slug}：「让 AI 接活」打开的时刻认不出（${since}），这个仓这一轮没拉`);
    return;
  }
  let listed: Awaited<ReturnType<IntakeDeps['openIssues']>>;
  try {
    listed = await deps.openIssues(repo);
  } catch (err) {
    t.reposFailed += 1;
    t.unchecked.push(`${slug}：开着的单读不到（${message(err)}）`);
    return;
  }
  for (const issue of listed.issues) {
    t.scanned += 1;
    try {
      await intakeIssue(deps, repo, since, issue, listed, whitelist, t);
    } catch (err) {
      // 这张单没处理成（现读、留言、起工作流出错）：记下，别的单照做
      t.unchecked.push(`${slug}#${issue.number}：${message(err)}`);
    }
  }
}

function summarize(t: Tally): string {
  const skipped = [...t.skipped].map(([reason, n]) => `${reason}×${n}`).join('、') || '无';
  return `起了 ${t.started} 条，留言 ${t.commented} 条；没派的：${skipped}`;
}

async function round(deps: IntakeDeps): Promise<ScheduleResult> {
  let repos: IntakeRepo[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { outcome: 'failed', why: `受管的仓读不到：${message(err)}` };
  }
  if (repos.length === 0) return { outcome: 'unscanned', why: '库里没有受管的仓' };
  const t: Tally = {
    scanned: repos.length,
    started: 0,
    commented: 0,
    skipped: new Map(),
    unchecked: [],
    reposFailed: 0,
    reposOn: 0,
    running: 0,
  };
  if (repos.some((r) => r.autoDispatchSince !== null)) {
    let whitelist: GithubWhitelist | undefined;
    try {
      whitelist = await deps.whitelist();
      t.running = await deps.runningTasks();
    } catch (err) {
      return {
        outcome: 'failed',
        why: `白名单或在跑的任务数读不到，这一轮一张单都没拉：${message(err)}`,
        scanned: repos.length,
      };
    }
    for (const repo of repos) await intakeRepo(deps, repo, whitelist, t);
  }
  const found = t.started + t.commented;
  deps.log('info', `拉单这一轮：${summarize(t)}`, { scanned: t.scanned, found });
  if (t.unchecked.length > 0) {
    const n = t.unchecked.length;
    const why = clip(`${n > 1 ? `${n} 处没查成：` : ''}${t.unchecked.join('；')}`, INTAKE_WHY_MAX);
    // 开着开关的仓全都没读成：这一轮等于没拉
    if (t.reposOn > 0 && t.reposFailed === t.reposOn)
      return { outcome: 'failed', why, scanned: t.scanned, found };
    return { outcome: 'partial', why, scanned: t.scanned, found };
  }
  return { outcome: 'ok', scanned: t.scanned, found };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，看门狗照样看得见。
 * 没跑成：记成 failed 再抛 IntakeFailedError。记结局失败：原样抛出。
 */
export async function runIntakeJob(deps: IntakeDeps): Promise<IntakeRun> {
  const runId = await deps.runs.start(INTAKE_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = { outcome: 'failed', why: `拉单没跑成：${message(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  const run: IntakeRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, why: run.why };
  if (run.outcome === 'failed') {
    deps.log('error', '拉单这一轮没跑成', fields);
    throw new IntakeFailedError(runId, run.why ?? '拉单没跑成');
  }
  if (run.outcome !== 'ok') deps.log('warn', '拉单这一轮没查全', fields);
  return run;
}
