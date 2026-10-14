// 「同一个定时任务连着没跑全」（看门狗的一项检查）：看门狗原来只报「最近一次 failed」和「停了」，而 partial 在 scheduleHealth 里算跑成——
// 一个任务可以连着几百次每次只跑一半，一直没有人知道（过去 30 天 cli-versions 43 次、usage-backfill 288 次同一笔、github-reconcile
// 64 次「机器人没装到某个仓」都是这样静默过去的）。这一项把「最近一次跑成之后连着 N 次 partial / failed」报成一张卡，
// 进提醒中心（驾驶舱「要你拍的」、飞书），不静默。判法是纯函数；读记录在 db 的 scheduleRedStreaks，推、撤在 watchdog.ts。
// 改这里之前必须知道：
// - 门槛是「连着 RED_STREAK_MIN_RUNS 次、而且从第一次红到最近一次红跨过 RED_STREAK_MIN_SPAN_MS」两条都到：每分钟一轮的任务不会因为连着
//   三分钟抖一下就报，一天一轮的任务也不用等一个月。ok 和 unscanned（没东西可扫）都打断这一段。
// - 一段一条：键里带「从哪次跑成之后算」，人点了「处理」的同一段不再打开；之后跑成一次再红是新的一段、新的一张卡。
// - 标题正文不带每轮都变的数（几次、多久了）：只写这一段从几点开始红、最近一次的原因，没变就不改卡（飞书免费版有接口次数限额）。
// - 任务本身已经因为「最近一次没跑成 / 停了」被看门狗报过的，这一项不再为同一个任务报第二张（看门狗的 judgeJob 优先）。

import type { RedStreak } from '@fleet-dao/db';
import { clip, stamp } from './reconcile-common.ts';

/** 提醒的键前缀：watchdog:red:<任务>:<after-<编号> | no-ok>。 */
export const RED_STREAK_ALERT_PREFIX = 'watchdog:red:';
/** 至少连着几次没跑全。 */
export const RED_STREAK_MIN_RUNS = 3;
/** 第一次红到最近一次红至少隔多久。 */
export const RED_STREAK_MIN_SPAN_MS = 2 * 60 * 60_000;
/** 原因最长多少字。 */
export const RED_STREAK_WHY_MAX = 400;
/** 提醒点进去看驾驶舱「定时任务」页。 */
export const RED_STREAK_LINK = '/schedules';

export const redStreakKey = (s: Pick<RedStreak, 'job' | 'afterRunId'>): string =>
  `${RED_STREAK_ALERT_PREFIX}${s.job}:${s.afterRunId === null ? 'no-ok' : `after-${s.afterRunId}`}`;

/** 键里的任务编号（任务编号里有冒号也认得出：最后一段是 after-<编号> 或 no-ok）。 */
export function jobIdOfRedKey(key: string): string {
  return key.slice(RED_STREAK_ALERT_PREFIX.length, key.lastIndexOf(':'));
}

export type RedStreakVerdict = { kind: 'fine' } | { kind: 'alert'; key: string; title: string; body: string };

/** 这一段够不够报。jobName 是登记表上的任务名。 */
export function judgeRedStreak(s: RedStreak, jobName: string): RedStreakVerdict {
  const span = s.lastStartedAt.getTime() - s.firstStartedAt.getTime();
  if (s.runs < RED_STREAK_MIN_RUNS || span < RED_STREAK_MIN_SPAN_MS) return { kind: 'fine' };
  const name = `「${jobName}」`;
  const what = s.lastOutcome === 'failed' ? '没跑成' : '只跑了一部分';
  return {
    kind: 'alert',
    key: redStreakKey(s),
    title: clip(`定时任务${name}连着${what}`, 300),
    body: [
      `${stamp(s.firstStartedAt)} 起，每一次都没有跑全（只跑了一部分或没跑成），中间一次跑全的都没有。`,
      `最近一次：${clip(s.lastWhy?.trim() || '没写原因', RED_STREAK_WHY_MAX)}`,
      `这个任务：${s.job}。看驾驶舱「定时任务」页这一行；跑全一次，这条自己撤。`,
    ].join('\n'),
  };
}
