// 拉单（#632 S2-2；specs/632-三段总调度/方案.md §五）：每 5 分钟一轮，引擎自己到 GitHub 读「该做的单」，替掉 webhook 接活加认领。
// 一轮 = 记下开始 → 对每个开了「让 AI 接活」的仓：读开着的单 → 逐张过关 → 对过了关的单读一遍交代（readTaskBrief）→ 交代不全的
// 在单子上留一条言写清缺什么，齐的起任务工作流 → 把结局记进 schedule_runs。拉单本身不动单子（不贴「在做」、不抢认领）。
//
// 过关的顺序是先便宜的再贵的（列表里就有的，再多读一次 GitHub 的）：
//   开关打开以后开的（0003 第 2 条）→ 作者在白名单里（公开仓陌生人能开单，白名单是唯一的门）→ 挂在当前版本上（第 8 条）→
//   不是母单子单、没贴「本机做」→ 还没派过 → 现读一遍这张单（开着、不是 PR、版本和母单子单再核一遍）→ 没被开着的 PR 的
//   「需求」栏挂着（#1197：已经有人在做；挂着的贴一次「本机做」、留一句话）→ 正文没写 .github/workflows/ 路径（#1194：
//   引擎的令牌推不了改工作流的提交，写了的同样贴一次「本机做」、留一句话）→ 交代齐不齐 → 容量。
// 每一道的判法都是 @fleet-dao/core 的 dispatch.ts 那几个纯函数（versionGate、familyGate、localGate），这里只排顺序。
//
// 改这里之前必须知道：
// - 读不到的不当成没有：读仓里的单失败、白名单读不出、现读一张单失败、起工作流失败，都记进 unchecked，这一轮记 partial / failed，
//   不记 ok（没跑成 ≠ 没问题）。「开关都关着」是正常的空闲，不是没扫到：scanned 里算上受管的仓，免得看门狗把空闲当成故障。
// - 同一张单任何时候最多一条任务工作流：工作流编号定死（taskWorkflowId），起的时候由真实现用 REJECT_DUPLICATE；这里再用
//   dispatched() 先挡一道，省得每 5 分钟为已经派出去的单多读一次 GitHub。重开的单、被撤掉的单都不会自己重来：要再做，在驾驶舱点「重做」（jobs/redo.ts 另起一代）。
// - 交代不全的单只留一次言：留言的幂等键由缺的内容算出来，同一处缺法不会每 5 分钟再留一条；缺的变了才是新的一条。
// - 每轮最多起 MAX_STARTS_PER_ROUND 条、同时在跑的任务工作流不超过 MAX_RUNNING_TASKS 条：开关刚打开、一堆单同时合格时，
//   一批一批地起，不一次把机器的内存和额度吃满；没起的下一轮（5 分钟后）自然再来。

import { createHash } from 'node:crypto';
import { issueColumnRefs, LOCAL_LABEL, parseMd, sectionText } from '@fleet-dao/conventions';
import {
  autoDispatchGate,
  cleanBody,
  familyGate,
  type IssueFamily,
  type IssueMilestones,
  localGate,
  type MilestoneRef,
  versionGate,
} from '@fleet-dao/core';
import type { ScheduleResult } from '@fleet-dao/db';
import { humanPart } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import type { GithubWhitelist } from '@fleet-dao/store';
import { isTrusted } from '@fleet-dao/store';
import type { IntakeRun } from '../contract.ts';
import { type BriefProblem, describeBriefProblems, readTaskBrief } from '../runner/task-brief.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { clip } from './reconcile-common.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来（看门狗按登记表查）。 */
export const INTAKE_JOB = {
  id: 'intake',
  name: '引擎拉单（读该做的单，起任务工作流）',
  schedule: '每 5 分钟',
  // 连着三轮没跑成才算过期：单子晚 15 分钟被拉起没关系，偶尔一轮慢不报。
  expectEveryMinutes: 15,
} as const;

/**
 * 合并闸认冷验收的结论、冷验收的真活动也接上了没有（S2-5 的 #625 让合并闸认 cold-verify 提交状态，S2-5b 接上任务工作流的 coldVerify）。
 * 没接上之前拉单不起任务：任务工作流挂的自动合并不能绕过验收，而人手挂、别的路径挂要等合并闸那一层才拦得住；冷验收没接上，
 * 引擎自己的 PR 又永远得不到 cold-verify。S2-5b 把它改成 true。
 * 开着「让 AI 接活」的仓又碰上它是 false：这一轮记没跑成、一张单都不拉——开关开早了要看得见，不悄悄空转。
 * 改回 false 要同时改 intake.test.ts 里钉住它的那一条（故意的）。
 */
export const MERGE_GATE_REQUIRES_COLD_VERIFY = true;

export const INTAKE_EVERY_MINUTES = 5;
/** 和对账补漏（整点起每 15 分钟）、路由探针（7、22、37、52 分）、看门狗（4、9、14…分）、每小时对账（41 分）错开：每小时 3、8、13……分。 */
export const INTAKE_OFFSET_MINUTES = 3;
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
  defaultBranch: string;
  testCommand: string;
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
  | 'pr_claimed'
  | 'touches_workflows'
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

/**
 * 开着的 PR 的「需求」栏（Closes / Refs #号，同仓的）挂着哪些单：单号 → 挂着它的 PR 号（同一张单有几个 PR 挂，取号最小的）。
 * 认法是 conventions 的 issueColumnRefs（pr-open 拒开没挂单的 PR 用的同一份）。
 */
export function prClaimedIssues(pulls: readonly { number: number; body: string }[]): Map<number, number> {
  const claimed = new Map<number, number>();
  for (const pr of [...pulls].sort((a, b) => a.number - b.number)) {
    const { closes, refs } = issueColumnRefs(pr.body);
    for (const n of [...closes, ...refs]) {
      if (!claimed.has(n)) claimed.set(n, pr.number);
    }
  }
  return claimed;
}

/** 单子已有 PR 在做、引擎不拉时留在单子上的话。 */
export function prClaimedComment(prNumber: number): string {
  return [
    `引擎想拉起这张单，可开着的 PR #${prNumber} 的「需求」栏已经挂着它，说明已有人在做，先没派。`,
    '',
    `已给这张单贴了「${LOCAL_LABEL}」，引擎以后不再拉它。要交给引擎做的话，另开一张新单（不要和现有 PR 重复）。`,
  ].join('\n');
}

/** 单正文里认「要改工作流」的三节（不含「原话」：创始人的原话里顺口提到路径不算这张单要改它）。 */
const WORKFLOW_SECTIONS = ['场景', '已知的模块', '怎么算做完'] as const;
const WORKFLOW_PATH = /\.github\/workflows\/[\w.*-]*/;

/**
 * 单正文的场景、已知的模块、怎么算做完三节里写到的第一个 `.github/workflows/` 路径；没写回 null。
 * 引擎的 GitHub 令牌不能推改了工作流的提交（workflows_permission），这种单拉了只会白烧一轮（#1186 烧了约 35 万输入 token）。
 * 正文不是文字（读不到）就抛：不当成「没写工作流路径」。正文是空的不在这里管（交代齐不齐那一道会留言）。
 */
export function workflowPathIn(body: unknown): string | null {
  if (typeof body !== 'string')
    throw new Error(`单正文读不到（拿到的是 ${body === null ? 'null' : typeof body}）`);
  const text = cleanBody(humanPart(body));
  if (!text) return null;
  const doc = parseMd('单正文', text);
  for (const name of WORKFLOW_SECTIONS) {
    const hit = WORKFLOW_PATH.exec(sectionText(doc, name) ?? '');
    if (hit) return hit[0];
  }
  return null;
}

/** 单子要改工作流、引擎不拉时留在单子上的话。 */
export function workflowPathComment(path: string): string {
  return [
    `引擎想拉起这张单，可正文里写到了 \`${path}\`：引擎的 GitHub 令牌不能推改了 \`.github/workflows/\` 的提交（workflows_permission），拉了只会白烧一轮后卡在推送，先没派。`,
    '',
    `已给这张单贴了「${LOCAL_LABEL}」，留给本机做，引擎以后不再拉它。`,
  ].join('\n');
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
  /** 这个仓开着的 PR 的「需求」栏挂着的单（单号 → PR 号，见 prClaimedIssues）。读不到（含 PR 列表翻不完）照抛：不当成「没有 PR」。 */
  openPrClaims(repo: IntakeRepo): Promise<Map<number, number>>;
  /** 给单子贴「本机做」标签（幂等）。 */
  markLocal(input: { repo: IntakeRepo; issueNumber: number }): Promise<void>;
  /** 读主线上的需求文档；文件不在回 null，读失败照抛。 */
  readSpecDoc(input: { repo: IntakeRepo; path: string }): Promise<{ content: string } | null>;
  /** 现在在跑的任务工作流有几条。读不到照抛：不当成「一条没有」。 */
  runningTasks(): Promise<number>;
  /** 起任务工作流（编号定死、REJECT_DUPLICATE）：编号已经用过回 already_exists。 */
  start(input: {
    repo: IntakeRepo;
    issueNumber: number;
    title: string;
    /** 单子正文原样（建任务行的「原话」）。 */
    body: string;
    author: IntakeIssue['author'];
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
  /** 测试用：换掉「合并闸认冷验收了没有」（默认 MERGE_GATE_REQUIRES_COLD_VERIFY）。 */
  gateLive?: boolean;
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

/**
 * 这张单引擎不该拉、要留给本机：先在单子上留一句话（幂等键只留一次），再贴「本机做」（幂等），下一轮起 localGate 就在列表里
 * 把它挡掉。先留言后贴标签：留言失败时标签没贴，下一轮整件事重来；标签失败时下一轮留言是幂等的，只重贴标签。
 */
async function holdForLocal(
  deps: IntakeDeps,
  t: Tally,
  repo: IntakeRepo,
  issue: IntakeIssue,
  hold: { reason: IntakeSkipReason; why: string; key: string; comment: string },
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const posted = await deps.comment({
    repo,
    issueNumber: issue.number,
    key: hold.key,
    body: hold.comment,
  });
  await deps.markLocal({ repo, issueNumber: issue.number });
  if (posted.created) {
    t.commented += 1;
    deps.log('info', `拉单：${slug}#${issue.number} 不拉（${hold.why}），已贴「${LOCAL_LABEL}」并留言`, {
      reason: hold.reason,
    });
  }
  skip(t, slug, issue.number, { reason: hold.reason, why: hold.why });
}

async function intakeIssue(
  deps: IntakeDeps,
  repo: IntakeRepo,
  autoDispatchSince: string,
  issue: IntakeIssue,
  listed: { openMilestones: MilestoneRef[] },
  whitelist: GithubWhitelist,
  prClaims: () => Promise<Map<number, number>>,
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
  // 正文要改 .github/workflows/：引擎推不上去，不拉（#1194）。正文读不到就抛，这张单这一轮记没查成
  const workflowPath = workflowPathIn(issue.body);
  if (workflowPath !== null) {
    return holdForLocal(deps, t, repo, issue, {
      reason: 'touches_workflows',
      why: `正文写了 ${workflowPath}，引擎推不了改工作流的提交`,
      key: 'intake-touches-workflows',
      comment: workflowPathComment(workflowPath),
    });
  }
  // 已有开着的 PR 的「需求」栏挂着它：有人在做，别并行再写一遍（#1197，#1182 就是这样和已合的 PR 撞车的）。读不到 PR 列表就抛，
  // 这张单这一轮不拉、记没查成，不当成「没有 PR」
  const prNumber = (await prClaims()).get(issue.number);
  if (prNumber !== undefined) {
    return holdForLocal(deps, t, repo, issue, {
      reason: 'pr_claimed',
      why: `已有 PR #${prNumber} 在做`,
      key: `intake-pr-claimed:${prNumber}`,
      comment: prClaimedComment(prNumber),
    });
  }

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
  const got = await deps.start({
    repo,
    issueNumber: issue.number,
    title: brief.brief.title,
    body: issue.body,
    author: issue.author,
  });
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
    t.unchecked.push(`${slug}：开着的单读不到（${errMessage(err)}）`);
    return;
  }
  // 开着的 PR 的挂单表：这一轮这个仓里第一张走到这道关的单才读，读一次（读失败的话，后面的单拿到的是同一个错，各自记没查成）
  let claims: Promise<Map<number, number>> | undefined;
  const prClaims = () => {
    claims ??= deps.openPrClaims(repo);
    return claims;
  };
  for (const issue of listed.issues) {
    t.scanned += 1;
    try {
      await intakeIssue(deps, repo, since, issue, listed, whitelist, prClaims, t);
    } catch (err) {
      // 这张单没处理成（现读、留言、起工作流出错）：记下，别的单照做
      t.unchecked.push(`${slug}#${issue.number}：${errMessage(err)}`);
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
    return { outcome: 'failed', why: `受管的仓读不到：${errMessage(err)}` };
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
    if (!(deps.gateLive ?? MERGE_GATE_REQUIRES_COLD_VERIFY)) {
      return {
        outcome: 'failed',
        why: '「让 AI 接活」开着，但合并闸还没认冷验收的结论（S2-5，#625）：这一轮一张单都没拉。把项目的开关关掉，或等 S2-5 合进来',
        scanned: repos.length,
      };
    }
    let whitelist: GithubWhitelist | undefined;
    try {
      whitelist = await deps.whitelist();
      t.running = await deps.runningTasks();
    } catch (err) {
      return {
        outcome: 'failed',
        why: `白名单或在跑的任务数读不到，这一轮一张单都没拉：${errMessage(err)}`,
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
    result = { outcome: 'failed', why: `拉单没跑成：${errMessage(err)}` };
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
