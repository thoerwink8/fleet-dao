// 单子进门自动打标挂版本（#448：design 第七节「标签与里程碑」、第十一节 Jev）：新 issue 没类别标签就问 Jev、没里程碑按规则挂、
// 版本关了没做完的单挪到下一版、未排期的单闲置够久照 Kubernetes 两段清理。纯判断，不碰网络、不读钟（now、事件都由调用方给）：
// 法国的引擎（packages/engine 的 jobs/issue-groom.ts）读 GitHub、问 Jev，调这里判该怎么做，再去写。
//
// 四件事分不开揉在一个函数里判，是因为它们的「查不成就不猜」形状不一样：类别要看 Jev 的把握度和标签时间线，
// 版本要看仓里还开着哪些 v<N> 里程碑，交接要看下一个版本在不在，闲置要看「过时」是什么时候贴上的——每样都单独可测。
import {
  currentVersion,
  FROZEN_LABEL,
  IDLE_LABEL,
  isKindLabel,
  type KindLabel,
  MOTHER_LABEL,
} from './labels.ts';

// —— 一、类别：Jev 判、只贴不摘 ——

/**
 * Jev 问「这张 issue 是哪一类」问出来的结果，已经脱成这两种（调用方从 packages/jev 的 Verdict 转过来）：
 * judged=true 是把握够、真判出来了；judged=false 分两种原因——unreachable（连不上、库出错、题停用、到了每日上限……
 * 一类「没问成」，算没查成）和 low_confidence（问出去了、答了，但把握度没过线，算把握不够，是正常现象不是故障）。
 */
export type JevKindAnswer =
  | { judged: true; kind: KindLabel; confidence: number }
  | { judged: false; reason: 'unreachable' | 'low_confidence'; detail: string };

export type CategoryPlan =
  | { action: 'apply'; label: KindLabel }
  /** 人摘过这张单的类别标签：以后不再碰，什么都不报（这是稳定状态，不是要盯的问题）。 */
  | { action: 'skip'; report: 'none'; note: string }
  /** 没问成（连不上、库出错……）：记没查成，要有人看引擎日志。 */
  | { action: 'skip'; report: 'unchecked'; note: string }
  /** 问出去了但把握不够：进日报，不算故障。 */
  | { action: 'skip'; report: 'digest'; note: string };

/** 一张单标签加/摘的一条事件（标签时间线现读）。 */
export interface LabelEvent {
  label: string;
  action: 'labeled' | 'unlabeled';
  /** 动手的是不是我们自己的机器人。 */
  bot: boolean;
  /** 发生的时刻（ISO）。 */
  at: string;
}

/**
 * 类别标签是不是被人摘过：只看三个类别标签（需求/缺陷/杂项）的事件，别的标签（本机做、母单……）动过没关系；
 * 按最新一条事件判——这个函数只在「现在没有类别标签」的单上调用，最新一条要么是「人摘掉了」（算），要么是
 * 「机器人重新贴上又没再被摘」（不算，即便更早被人摘过一次）。一条都没有（从没贴过）算没有。
 */
export function categoryRemovedByHuman(events: readonly LabelEvent[]): boolean {
  const relevant = events.filter((e) => isKindLabel(e.label));
  const last = relevant[relevant.length - 1];
  return last?.action === 'unlabeled' && !last.bot;
}

/**
 * 该不该贴类别标签（只在「现在没有类别标签」的单上调用；已经有标签的——不管谁贴的——不在候选范围里，压根不会走到这）。
 * everRemovedByHuman 由调用方按 categoryRemovedByHuman 算（或者查不出历史时保守传 false：见 issue-groom 引擎层）。
 */
export function categoryPlan(answer: JevKindAnswer, everRemovedByHuman: boolean): CategoryPlan {
  if (everRemovedByHuman) {
    return { action: 'skip', report: 'none', note: '类别标签被人摘过，以后不再贴' };
  }
  if (!answer.judged) {
    return answer.reason === 'unreachable'
      ? { action: 'skip', report: 'unchecked', note: `Jev 没问成：${answer.detail}` }
      : { action: 'skip', report: 'digest', note: `Jev 把握不够：${answer.detail}` };
  }
  return { action: 'apply', label: answer.kind };
}

// —— 二、版本：创始人开的进当前版本，AI 发现的进未排期 ——

export type MilestoneDecision =
  /** 挂当前版本。 */
  | { action: 'assign'; milestone: { number: number; title: string } }
  /** 未排期＝不挂里程碑，什么都不用写（GitHub 没有「未排期」这个里程碑对象）。 */
  | { action: 'unscheduled' }
  /** 算不出当前版本（没有还开着的 v<N> 里程碑）：不挂、不猜，报没查成。 */
  | { action: 'unknown'; why: string };

/**
 * source 由调用方定（AGENTS.md「先后顺序」③④）：'bot' 是我们自己的机器人开的（引擎对账、提醒），照④进未排期；
 * 其余（人类账号，含创始人本人——本机 gh 登的也是他、公开仓万一有外人开单也在这一类）照③进当前版本。
 *
 * triaged：这一轮开始时单上已经有类别标签。改这里之前必须知道：「未排期」在仓里就是「没挂里程碑」（issue:new 的
 * `--milestone 未排期` 建单不带里程碑），光看 milestone === null 分不出「忘了挂」和「有意放未排期」。issue:new 开的单
 * 一定带类别标签（缺 --kind 它拒开），人手动归过类的也有——这些单的版本已经有人定过，没挂就是有意未排期，不碰。
 * 只有进门时类别、版本都没有的（网页上、gh issue create 直接开的）才照③挂当前版本。
 * 09-28 上线第一轮没有这一条，把 52 张有意未排期的单全挂进了 v1，引擎当场照版本接了活。
 */
export function milestonePlan(
  source: 'bot' | 'human',
  triaged: boolean,
  openMilestones: readonly { number: number; title: string }[],
): MilestoneDecision {
  if (source === 'bot' || triaged) return { action: 'unscheduled' };
  const current = currentVersion(openMilestones);
  if (!current) return { action: 'unknown', why: '现在没有还开着的 v<N> 里程碑，没有当前版本' };
  return { action: 'assign', milestone: current.milestone };
}

// —— 三、版本交接：里程碑关了，没做完的单挪到下一个版本 ——

export type HandoffDecision =
  | { action: 'move'; to: { number: number; title: string } }
  /** 没有下一个版本：不挪，报出来（留在原里程碑上，等有下一个版本再交接）。 */
  | { action: 'stuck'; why: string };

/** 下一个版本＝这一刻仓里还开着的当前版本（原来那个已经关了，算出来的自然是下一个）。 */
export function handoffPlan(openMilestones: readonly { number: number; title: string }[]): HandoffDecision {
  const current = currentVersion(openMilestones);
  if (!current) return { action: 'stuck', why: '现在没有还开着的 v<N> 里程碑，没有下一个版本可挪' };
  return { action: 'move', to: current.milestone };
}

// —— 四、闲置清理（照 Kubernetes 的 stale → rotten 两段式） ——

export interface IdlePolicy {
  /** 未排期的单闲置几天贴「过时」。 */
  staleAfterDays: number;
  /** 贴了「过时」之后再闲置几天，关成「不做了」。 */
  closeAfterDays: number;
}

/** 默认天数（#448 需求：30 天贴过时、再 14 天关）。 */
export const DEFAULT_IDLE_POLICY: IdlePolicy = { staleAfterDays: 30, closeAfterDays: 14 };

export interface IdleFacts {
  /** 现在贴着的标签（只关心「冻结」「母单」「过时」三个）。 */
  labels: readonly string[];
  /** 距离最近一次有人动过（评论、编辑，不算我们自己机器人的操作）过了多少天；调用方按 issue-groom 引擎层的算法给。 */
  idleDays: number;
  /** 「过时」是什么时候贴上的（标签时间线现读）；没贴过、或者查不出是 null。 */
  staleSince: Date | null;
}

export type IdleDecision =
  | { action: 'none' }
  | { action: 'mark_stale' }
  | { action: 'close' }
  | { action: 'skip_frozen' }
  | { action: 'skip_mother' };

/**
 * 只在「未排期（没挂里程碑）」的单上调用：挂在当前版本、别的版本上的单不归这条规矩管。
 * 「冻结」「母单」绕开不动；贴了「过时」的单只看 staleSince 够不够 closeAfterDays，不再看 idleDays
 * （人在过时之后随手碰了一下评论区不算「又活了」——这条规矩不做「碰一下就解冻」，母单和冻结才是解法，
 * 真要保留就贴「冻结」）。staleSince 查不出（时间线读不到、认不出）时不硬关，等下次查得到再说，不当成「刚贴」。
 */
export function idlePlan(
  facts: IdleFacts,
  now: Date,
  policy: IdlePolicy = DEFAULT_IDLE_POLICY,
): IdleDecision {
  if (facts.labels.includes(FROZEN_LABEL)) return { action: 'skip_frozen' };
  if (facts.labels.includes(MOTHER_LABEL)) return { action: 'skip_mother' };
  if (facts.labels.includes(IDLE_LABEL)) {
    if (facts.staleSince === null) return { action: 'none' };
    const days = daysBetween(facts.staleSince, now);
    return days >= policy.closeAfterDays ? { action: 'close' } : { action: 'none' };
  }
  return facts.idleDays >= policy.staleAfterDays ? { action: 'mark_stale' } : { action: 'none' };
}

/** 两个时刻相差几天（向下取整；负数说明 now 早于 from，当 0 天）。 */
export function daysBetween(from: Date, now: Date): number {
  const ms = now.getTime() - from.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/**
 * 「过时」最近一次是什么时候被贴上的：找它的标签事件里最后一条，是「贴上」就是那一刻；一条都没有，或者最后一条是
 * 「摘掉」（不该发生——这条规矩不摘过时，防御一下），都算查不出，回 null（调用方不猜、等下次查得到再说）。
 */
export function staleSinceOf(events: readonly LabelEvent[]): Date | null {
  const relevant = events.filter((e) => e.label === IDLE_LABEL);
  const last = relevant[relevant.length - 1];
  if (last?.action !== 'labeled') return null;
  const t = Date.parse(last.at);
  return Number.isNaN(t) ? null : new Date(t);
}

/** 关成「不做了」时留的言（closeIssue 的 comment）。 */
export function idleCloseComment(policy: IdlePolicy = DEFAULT_IDLE_POLICY): string {
  return [
    `未排期，贴「${IDLE_LABEL}」之后又过了 ${policy.closeAfterDays} 天没人动，自动关成「不做了」。`,
    `这事还要做的话，重开并挂上版本（或者贴「${FROZEN_LABEL}」防止再被清理）。`,
  ].join('\n\n');
}

/** 版本交接（里程碑关了）时留的言。 */
export function handoffComment(from: { title: string }, to: { title: string }): string {
  return `里程碑「${from.title}」关了，这张单还没做完，挪到了「${to.title}」。`;
}
