// 看门狗的「主线 N 小时没合 PR」报警（决定 0093：删掉每 6 小时真跑一整张单的全流程巡检，改成这一条）。
// 每个开着「让 AI 接活」的仓：从最近一次合并（没合过就从开关打开那一刻）算起超过 MERGE_STALL_HOURS 小时没合任何 PR，
// 而且这段时间引擎手上有单在做或有过了准入、只因没空位没起的单（不是没活干），就往提醒中心推一条卡住报警
// （飞书照现有的推送发，一件事一张卡）；合了、没有待做的单了、开关关了就自己撤，正文开头写「已撤：为什么」——
// 报一次、恢复撤一次，不刷屏。
// 改这里之前必须知道：
// - 一段一条：键是 watchdog:merge:<owner/name>:<段>，段是 after-<最近合的 PR 号>，没合过是 since-<开关打开时刻的毫秒>。
//   同一段里人点了「处理」的不再打开（人接手了，和看门狗的定时任务那几条同一个 raiseOnce）；合了一个就是新的一段。
// - 标题正文不带每轮会变的数（多久了、几张单）：只写最近合的是哪个、几点合的，没变就不改卡（飞书免费版每月 1 万次接口调用）。
// - 读不到事实：这一轮记没查成，开着的一条都不撤（不当成「合过」「没有待做的单」）。
// - N 的依据：2026-09-30 到 10-14 主线 999 个合并间隔，p50 0.11 小时、p95 1.10、p99 5.09、最长 9.96；超过 4 小时的 11 次，
//   多在夜里没活的时候——加「有待做的单」这个条件把那些滤掉。取 4 小时（约 p99），PR 正文里有原始数据。
import type { MergeStallFacts, RepoMergeFacts } from '@fleet-dao/db';
import { clip, stamp } from './reconcile-common.ts';

/** 多少小时没合 PR 算断了（依据见文件头）。 */
export const MERGE_STALL_HOURS = 4;
/** watchdog:merge:<owner/name>:<after-<号> | since-<毫秒>>。 */
export const MERGE_STALL_ALERT_PREFIX = 'watchdog:merge:';
/** 提醒点进去看驾驶舱的任务页。 */
export const MERGE_STALL_LINK = '/tasks';

export type MergeStallVerdict =
  /** 不用报：why 是撤掉之前那条时写的原因。 */
  | { kind: 'fine'; repo: string; why: string }
  | { kind: 'alert'; repo: string; key: string; title: string; body: string };

/** 这一段的键。 */
export function mergeStallKey(f: Pick<RepoMergeFacts, 'repo' | 'lastMerged' | 'dispatchSince'>): string {
  const seg = f.lastMerged ? `after-${f.lastMerged.number}` : `since-${f.dispatchSince.getTime()}`;
  return `${MERGE_STALL_ALERT_PREFIX}${f.repo}:${seg}`;
}

/** 键里的仓（owner/name；最后一段是 after-… 或 since-…）。 */
export function repoOfMergeStallKey(key: string): string {
  return key.slice(MERGE_STALL_ALERT_PREFIX.length, key.lastIndexOf(':'));
}

/** 一个仓要不要报（纯函数）。 */
export function judgeMergeStall(f: RepoMergeFacts, now: Date): MergeStallVerdict {
  const name = `「${f.repo}」`;
  // 开关是后来打开的：从打开那一刻算（关着的那段没合不算断）
  const fromMerge = f.lastMerged !== null && f.lastMerged.at.getTime() >= f.dispatchSince.getTime();
  const from = fromMerge && f.lastMerged ? f.lastMerged.at : f.dispatchSince;
  const pending = f.inFlight + (f.waiting ?? 0);
  const limitMs = MERGE_STALL_HOURS * 3_600_000;
  if (now.getTime() - from.getTime() <= limitMs) {
    const why = f.lastMerged
      ? `${name}${stamp(f.lastMerged.at)} 合了 #${f.lastMerged.number}，没超过 ${MERGE_STALL_HOURS} 小时`
      : `${name}${stamp(f.dispatchSince)} 才打开「让 AI 接活」，没超过 ${MERGE_STALL_HOURS} 小时`;
    return { kind: 'fine', repo: f.repo, why };
  }
  if (pending === 0) {
    return {
      kind: 'fine',
      repo: f.repo,
      why: `${name}引擎手上没有在做的单，也没有在等空位的单（没活干，不算断）`,
    };
  }
  const since =
    fromMerge && f.lastMerged
      ? `最近合的是 #${f.lastMerged.number}（${stamp(f.lastMerged.at)}）`
      : `${stamp(f.dispatchSince)} 打开「让 AI 接活」以来一个都没合过`;
  return {
    kind: 'alert',
    repo: f.repo,
    key: mergeStallKey(f),
    title: clip(`${name}超过 ${MERGE_STALL_HOURS} 小时没合 PR`, 300),
    body: [
      `${since}，之后超过 ${MERGE_STALL_HOURS} 小时没合任何 PR，而引擎手上有单在做或在等空位：链路可能断了（会话、CI、合并、发版哪一步卡住）。`,
      '看驾驶舱任务页卡在哪一步、定时任务页有没有没跑成的；合了一个、或者没有待做的单了，这条自己撤。',
    ].join('\n'),
  };
}

/** 为什么撤一条（它这一轮不在要报的里面）。 */
export function mergeStallRetireWhy(repo: string, verdict: MergeStallVerdict | undefined): string {
  if (!verdict) return `「${repo}」的「让 AI 接活」关了（不再看它合没合）`;
  if (verdict.kind === 'fine') return verdict.why;
  return `「${repo}」这一段过去了（中间合过一个），现在的情况另报了一条`;
}

/** 这一轮的事实里每个仓判一遍；按仓给出判法（撤的时候查）。 */
export function judgeMergeStalls(facts: MergeStallFacts, now: Date): Map<string, MergeStallVerdict> {
  return new Map(facts.repos.map((f) => [f.repo, judgeMergeStall(f, now)]));
}
