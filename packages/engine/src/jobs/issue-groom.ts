// 单子进门自动打标挂版本（#448）：新 issue 没类别标签问 Jev、没里程碑按规则挂、版本关了没做完的单挪到下一版、
// 未排期的单闲置够久照 Kubernetes 两段清理。GitHub 对账补漏每小时起一轮（github-reconcile.ts 的 issueGroomDue，
// 和关单对账同一种「按点起」）。判断全在 @fleet-dao/conventions 的 issue-groom.ts（categoryPlan、milestonePlan、
// handoffPlan、idlePlan），这里只按受管的仓读现状、调判断、把结果写回去，一个仓一个仓地记「查成了没有」。
//
// 挂版本和查闲置揉在同一个循环（都只看 milestone === null 的单）：这一轮刚挂上当前版本的单，同一轮不再查闲置——
// 不然一张单既被挂了当前版本、又被判「未排期闲置太久」，自相矛盾。milestonePlan 判「未排期」或「算不出当前版本」
// 才查闲置；判「挂当前版本」的直接跳过闲置这一步。
//
// 读不到、认不出、写不成都记没查成（unchecked），不拿「没有」顶；把握不够的、人摘过类别的、已经挂着版本的、
// 现在没到期的闲置单，都是正常状态，不算没查成。一轮的活动（贴了什么、没把握的、清了哪些）汇总成一条日报级的提醒
// （design 第七节，和关单对账的 alert 同一个口子，level=alert 不是要人拍的 decision）。
import {
  categoryPlan,
  categoryRemovedByHuman,
  DEFAULT_IDLE_POLICY,
  daysBetween,
  handoffComment,
  handoffPlan,
  IDLE_LABEL,
  type IdlePolicy,
  idleCloseComment,
  idlePlan,
  isKindLabel,
  type JevKindAnswer,
  type KindLabel,
  type LabelEvent,
  milestonePlan,
  staleSinceOf,
} from '@fleet-dao/conventions';
import { message, type ReconcileLog } from './reconcile-common.ts';

export interface IssueGroomRepo {
  owner: string;
  name: string;
}

export interface GroomIssueFacts {
  number: number;
  title: string;
  body: string;
  /** 开单人是不是我们自己的机器人：milestonePlan 判「机器人开的」用它。 */
  authorIsBot: boolean;
  updatedAt: string;
  labels: readonly string[];
  milestone: { number: number; title: string } | null;
}

export interface GroomMilestoneFacts {
  number: number;
  title: string;
  state: 'open' | 'closed';
}

export interface GroomFactsRead {
  milestones: readonly GroomMilestoneFacts[];
  issues: readonly GroomIssueFacts[];
}

export interface IssueGroomJobDeps {
  /** 受管的仓。读不出原样抛：这一步记成没跑成。 */
  repos(): Promise<IssueGroomRepo[]>;
  /** 这个仓开着的单加全部里程碑（@fleet-dao/github 的 readGroomFacts）。读不到、认不出抛错。 */
  facts(repo: IssueGroomRepo): Promise<GroomFactsRead>;
  /** 一张单的标签时间线。读不到抛错。 */
  labelEvents(repo: IssueGroomRepo, issueNumber: number): Promise<readonly LabelEvent[]>;
  /** 问 Jev 这张 issue 是哪一类（@fleet-dao/jev 的 issue-kind 题）。不抛：没问成也回一个没判出来的答案。 */
  askKind(issue: { number: number; title: string; body: string }): Promise<JevKindAnswer>;
  /** 给一张单加一个标签（类别标签或「过时」）。抛错＝没写成。 */
  addLabel(repo: IssueGroomRepo, issueNumber: number, label: string): Promise<void>;
  /** 给一张单挂里程碑。抛错＝没写成。 */
  setMilestone(repo: IssueGroomRepo, issueNumber: number, milestone: number): Promise<void>;
  /** 在单上留一条言（幂等，按 key 认）：版本交接用。 */
  comment(repo: IssueGroomRepo, issueNumber: number, key: string, body: string): Promise<void>;
  /** 关成「不做了」（@fleet-dao/github 的 closeIssue）。 */
  closeNotPlanned(repo: IssueGroomRepo, issueNumber: number, comment: string): Promise<void>;
  /** 这一轮的活动汇总成一条日报级提醒（同一个键，原地更新；design 第七节，不是要人拍的 decision）。 */
  digest(repo: IssueGroomRepo, title: string, body: string): Promise<void>;
  idlePolicy?: IdlePolicy;
  now: () => Date;
  log: ReconcileLog;
}

export interface IssueGroomResult {
  /** 查成了几个仓。 */
  scanned: number;
  /** 这一轮做了几个动作（贴的类别标签、挂的里程碑、交接挪的、标过时的、关掉的）。 */
  found: number;
  /** 没查成、没写成的，一条一句：照实写进这一轮的 why，这一轮不记 ok。 */
  unchecked: string[];
}

/**
 * 这一轮要不要跑单子打标挂版本：每小时一次（GitHub 对账补漏每 15 分钟一轮，整点起的那一轮触发，和关单对账
 * 「北京时间 9:00 起」同一种「按点起」，只是这个功能不按北京时间——「新开的 issue 一小时内有类别和版本」是绝对时长，
 * 不用等到某个钟点）。那一轮没起来（引擎停着、上一轮还没完被跳过）就等下一个整点：新开的单不会等太久，最多多等 15 分钟。
 */
export function issueGroomDue(at: Date): boolean {
  return at.getUTCMinutes() < 15;
}

/** 一个仓这一轮的活动，渲染日报用（不算没查成的正常动作和没把握的都记在这）。 */
interface RepoActivity {
  labeled: { issue: number; label: KindLabel }[];
  lowConfidence: { issue: number; note: string }[];
  milestoned: { issue: number; milestone: string }[];
  handedOff: { issue: number; from: string; to: string }[];
  staleMarked: number[];
  closed: number[];
}

const emptyActivity = (): RepoActivity => ({
  labeled: [],
  lowConfidence: [],
  milestoned: [],
  handedOff: [],
  staleMarked: [],
  closed: [],
});

const MAX_LINES = 20;
function lines(items: string[]): string[] {
  if (items.length <= MAX_LINES) return items;
  return [...items.slice(0, MAX_LINES), `……另有 ${items.length - MAX_LINES} 条`];
}

/** 渲染这一轮的日报正文；什么都没做也留一句，不是「读不到」。 */
export function renderDigest(a: RepoActivity): string {
  const parts: string[] = [];
  if (a.labeled.length) {
    parts.push(
      `贴了类别（${a.labeled.length}）：${lines(a.labeled.map((x) => `#${x.issue} → ${x.label}`)).join('、')}`,
    );
  }
  if (a.lowConfidence.length) {
    parts.push(
      `Jev 把握不够，没贴（${a.lowConfidence.length}）：${lines(a.lowConfidence.map((x) => `#${x.issue}（${x.note}）`)).join('、')}`,
    );
  }
  if (a.milestoned.length) {
    parts.push(
      `挂了当前版本（${a.milestoned.length}）：${lines(a.milestoned.map((x) => `#${x.issue} → ${x.milestone}`)).join('、')}`,
    );
  }
  if (a.handedOff.length) {
    parts.push(
      `版本交接（${a.handedOff.length}）：${lines(a.handedOff.map((x) => `#${x.issue} ${x.from} → ${x.to}`)).join('、')}`,
    );
  }
  if (a.staleMarked.length)
    parts.push(
      `闲置贴「过时」（${a.staleMarked.length}）：${lines(a.staleMarked.map((n) => `#${n}`)).join('、')}`,
    );
  if (a.closed.length)
    parts.push(
      `闲置太久，关成「不做了」（${a.closed.length}）：${lines(a.closed.map((n) => `#${n}`)).join('、')}`,
    );
  return parts.length ? parts.join('\n') : '这一轮没有要处理的（类别、版本都齐了，没有闲置到期的）。';
}

/** 这个仓一轮的处理：读现状、按判断做事，回活动记录和没查成的清单。读现状本身失败由调用方 catch。 */
async function groomRepo(
  deps: IssueGroomJobDeps,
  repo: IssueGroomRepo,
  facts: GroomFactsRead,
): Promise<{ activity: RepoActivity; unchecked: string[]; found: number }> {
  const now = deps.now();
  const policy = deps.idlePolicy ?? DEFAULT_IDLE_POLICY;
  const activity = emptyActivity();
  const unchecked: string[] = [];
  let found = 0;
  const slug = `${repo.owner}/${repo.name}`;
  const openMilestones = facts.milestones.filter((m) => m.state === 'open');
  const milestoneByNumber = new Map(facts.milestones.map((m) => [m.number, m]));

  // 一、类别：没有类别标签的单，看标签时间线判「人摘过没有」，没摘过才问 Jev。
  for (const issue of facts.issues) {
    if (issue.labels.some(isKindLabel)) continue;
    let events: readonly LabelEvent[];
    try {
      events = await deps.labelEvents(repo, issue.number);
    } catch (err) {
      unchecked.push(`${slug}#${issue.number} 标签时间线没查成（${message(err)}），这一轮不问 Jev`);
      continue;
    }
    if (categoryRemovedByHuman(events)) continue; // 只贴不摘，以后不再碰，不报
    const answer = await deps.askKind({ number: issue.number, title: issue.title, body: issue.body });
    const plan = categoryPlan(answer, false);
    if (plan.action === 'apply') {
      try {
        await deps.addLabel(repo, issue.number, plan.label);
        activity.labeled.push({ issue: issue.number, label: plan.label });
        found += 1;
      } catch (err) {
        unchecked.push(`${slug}#${issue.number} 贴类别标签「${plan.label}」没写成（${message(err)}）`);
      }
      continue;
    }
    if (plan.report === 'unchecked') unchecked.push(`${slug}#${issue.number} ${plan.note}`);
    else if (plan.report === 'digest') activity.lowConfidence.push({ issue: issue.number, note: plan.note });
  }

  // 二、版本 + 四、闲置（同一个循环：milestone === null 的单；挂了当前版本的这一轮不再查闲置）。
  for (const issue of facts.issues) {
    if (issue.milestone !== null) continue;
    // 归没归过类看这一轮读到的标签（第一步刚贴上类别的不算：它进门时类别、版本都没有）。
    const triaged = issue.labels.some(isKindLabel);
    const decision = milestonePlan(issue.authorIsBot ? 'bot' : 'human', triaged, openMilestones);
    if (decision.action === 'assign') {
      try {
        await deps.setMilestone(repo, issue.number, decision.milestone.number);
        activity.milestoned.push({ issue: issue.number, milestone: decision.milestone.title });
        found += 1;
      } catch (err) {
        unchecked.push(
          `${slug}#${issue.number} 挂里程碑「${decision.milestone.title}」没写成（${message(err)}）`,
        );
      }
      continue;
    }
    if (decision.action === 'unknown') {
      unchecked.push(`${slug}#${issue.number} ${decision.why}`);
      continue;
    }
    // decision.action === 'unscheduled'：真未排期，查闲置
    const stale = issue.labels.includes(IDLE_LABEL);
    let staleSince: Date | null = null;
    if (stale) {
      try {
        staleSince = staleSinceOf(await deps.labelEvents(repo, issue.number));
      } catch (err) {
        unchecked.push(`${slug}#${issue.number} 标签时间线没查成（${message(err)}），这一轮不查闲置`);
        continue;
      }
    }
    const idle = idlePlan(
      { labels: issue.labels, idleDays: daysBetween(new Date(issue.updatedAt), now), staleSince },
      now,
      policy,
    );
    if (idle.action === 'mark_stale') {
      try {
        await deps.addLabel(repo, issue.number, IDLE_LABEL);
        activity.staleMarked.push(issue.number);
        found += 1;
      } catch (err) {
        unchecked.push(`${slug}#${issue.number} 贴「过时」没写成（${message(err)}）`);
      }
    } else if (idle.action === 'close') {
      try {
        await deps.closeNotPlanned(repo, issue.number, idleCloseComment(policy));
        activity.closed.push(issue.number);
        found += 1;
      } catch (err) {
        unchecked.push(`${slug}#${issue.number} 关成「不做了」没成（${message(err)}）`);
      }
    }
  }

  // 三、版本交接：挂着的里程碑已经关了、单还开着——挪到下一个版本。
  for (const issue of facts.issues) {
    if (issue.milestone === null) continue;
    const target = milestoneByNumber.get(issue.milestone.number);
    if (!target) {
      unchecked.push(`${slug}#${issue.number} 挂着的里程碑「${issue.milestone.title}」不在这次读到的列表里`);
      continue;
    }
    if (target.state !== 'closed') continue;
    const decision = handoffPlan(openMilestones);
    if (decision.action === 'stuck') {
      unchecked.push(`${slug}#${issue.number} 挂着已关闭的「${issue.milestone.title}」，${decision.why}`);
      continue;
    }
    try {
      await deps.setMilestone(repo, issue.number, decision.to.number);
      await deps.comment(
        repo,
        issue.number,
        `issue-groom:handoff:${issue.milestone.number}`,
        handoffComment(issue.milestone, decision.to),
      );
      activity.handedOff.push({ issue: issue.number, from: issue.milestone.title, to: decision.to.title });
      found += 1;
    } catch (err) {
      unchecked.push(`${slug}#${issue.number} 版本交接没写成（${message(err)}）`);
    }
  }

  return { activity, unchecked, found };
}

/** 跑一轮：按受管的仓各处理一遍。一个仓读现状没成，这个仓记没查成、跳过，别的仓照跑。 */
export async function sweepIssueGroom(deps: IssueGroomJobDeps): Promise<IssueGroomResult> {
  const result: IssueGroomResult = { scanned: 0, found: 0, unchecked: [] };
  const repos = await deps.repos();
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    let facts: GroomFactsRead;
    try {
      facts = await deps.facts(repo);
    } catch (err) {
      result.unchecked.push(`${slug} 单子打标没查成（${message(err)}）`);
      continue;
    }
    result.scanned += 1;
    const { activity, unchecked, found } = await groomRepo(deps, repo, facts);
    result.found += found;
    result.unchecked.push(...unchecked);
    try {
      await deps.digest(repo, `${slug}：单子打标挂版本`, renderDigest(activity));
    } catch (err) {
      result.unchecked.push(`${slug} 单子打标的日报没写成（${message(err)}）`);
    }
    deps.log('info', '单子打标挂版本查完一个仓', {
      repo: slug,
      labeled: activity.labeled.length,
      lowConfidence: activity.lowConfidence.length,
      milestoned: activity.milestoned.length,
      handedOff: activity.handedOff.length,
      staleMarked: activity.staleMarked.length,
      closed: activity.closed.length,
      unchecked: unchecked.length,
    });
  }
  return result;
}
