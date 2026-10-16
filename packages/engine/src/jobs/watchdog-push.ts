// 看门狗的「提醒真的推到飞书了」（决定 0090 的手机通知；2026-10-05 推送整条被删、断了 9 天没人发现才加的这一条）。
// 纯库检查：读后端记下的推送状态（设置表 feishu.push）和送达记录（notification_deliveries），判法是 @fleet-dao/db 的 feishuPushProblem
// （指挥官巡检 patrol 的 SQL 照它写）。推送渠道自己坏了，靠推送报不出来：这一条进驾驶舱「要你拍」（decision），巡检也报 ALERT。
// 改这里之前必须知道：
// - 不通 = 后端记了「没配」；或者有该推的到点超过 1 小时没送到、而且最近 1 小时一条都没送成。没东西要推不算不通。
// - 一段一条，键 watchdog:push:feishu：同一段里人点了「处理」不再打开（人接手了）；推通了看门狗自己撤（正文开头「已撤：为什么」），
//   之后再不通是新的一段，照样打开。
// - 读不到状态、送达记录：这一轮这一步记没查成（看门狗这一轮记没跑成），开着的不撤，不当成通着。
import type { FeishuPushFacts } from '@fleet-dao/db';
import { feishuPushProblem } from '@fleet-dao/db';
import type { DecisionOption } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { clip } from './reconcile-common.ts';

export const PUSH_ALERT_KEY = 'watchdog:push:feishu';
/** 点进去看驾驶舱的提醒页（没送到的那几条在那里看得到）。 */
export const PUSH_ALERT_LINK = '/notifications';
/** 看门狗自己撤的处理人（和 watchdog.ts 的 WATCHDOG_ACTOR 同一个）。 */
const ACTOR = 'engine:watchdog';

export interface PushWatchDeps {
  /** 推送的事实（@fleet-dao/db 的 feishuPushFacts）。读不到照抛。 */
  facts(now: Date): Promise<FeishuPushFacts>;
  alerts: {
    byKey(dedupeKey: string): Promise<{
      title: string;
      body: string;
      resolvedAt: Date | null;
      resolvedBy: string | null;
    } | null>;
    raise(input: {
      dedupeKey: string;
      title: string;
      body: string;
      link: string;
      level: 'decision';
      options?: readonly DecisionOption[];
    }): Promise<void>;
    resolve(input: { dedupeKey: string; why: string }): Promise<'ok' | 'already_resolved' | 'not_found'>;
  };
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface PushWatchResult {
  scanned: number;
  found: number;
  problems: string[];
}

/** 飞书推送不通的两个选项：再查一次（推荐），或者交给指挥官。 */
export function pushWatchOptions(): DecisionOption[] {
  return [
    {
      id: 'recheck',
      label: '我修好了，再查一次',
      detail: '再读推送状态；通了这条才转已处理',
      recommended: '推通了就不用再找人',
      action: { kind: 'recheck', what: 'feishu-push' },
    },
    {
      id: 'handoff',
      label: '交给指挥官去修',
      detail: '记下交给指挥官；交出去了这条转已处理，看门狗这一段不再打开',
      action: { kind: 'note-only' },
    },
  ];
}

/** 要人拍的那条长什么样（纯函数）。 */
export function pushAlert(problem: string): { title: string; body: string } {
  return {
    title: '飞书推送不通：手机上收不到提醒',
    body: clip(
      [
        `${problem}。`,
        '驾驶舱的提醒（要你拍、卡住报警、主线红）靠驾驶舱后端用飞书应用机器人推进团队群；现在推不出去，手机上收不到，只能在驾驶舱里看。',
        '先在法国跑 `bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api feishu-push status` 看缺什么：' +
          '「没配」照它说的补（api.env 的 FEISHU_APP_ID / FEISHU_APP_SECRET；机器人只留在团队群一个群里）；' +
          '「不通」看最近一次没送成的原因，再 `journalctl -u fleet-api --since -1h | grep 飞书推送`。' +
          '修好后跑 `… fleet-api feishu-push test` 真发一条，送到了这条自己撤。',
      ].join('\n'),
      2000,
    ),
  };
}

export async function watchFeishuPush(deps: PushWatchDeps, now: Date): Promise<PushWatchResult> {
  const out: PushWatchResult = { scanned: 0, found: 0, problems: [] };
  let problem: string | null;
  try {
    const facts = await deps.facts(now);
    // 有东西可看才算扫过一项：后端记过推送状态，或有到点该推的（都没有时这一步什么都没看，不让一轮「一个都没扫到」变成看过了）
    if (facts.status !== null || facts.undelivered > 0) out.scanned = 1;
    problem = feishuPushProblem(facts, now);
  } catch (err) {
    out.problems.push(`读飞书推送的状态、送达记录没成，推送通不通这一轮没查：${errMessage(err)}`);
    return out;
  }
  let existing: Awaited<ReturnType<PushWatchDeps['alerts']['byKey']>>;
  try {
    existing = await deps.alerts.byKey(PUSH_ALERT_KEY);
  } catch (err) {
    out.problems.push(`读「飞书推送不通」那一条没成：${errMessage(err)}`);
    return out;
  }
  if (problem === null) {
    if (existing && existing.resolvedAt === null) {
      try {
        await deps.alerts.resolve({
          dedupeKey: PUSH_ALERT_KEY,
          why: '飞书推送通了：该推的都送到了，或最近 1 小时有送成的',
        });
        deps.log('info', '看门狗：撤了一条', { dedupeKey: PUSH_ALERT_KEY });
      } catch (err) {
        out.problems.push(`「飞书推送不通」通了却没撤掉：${errMessage(err)}`);
      }
    }
    return out;
  }
  out.found = 1;
  // 同一段里人点了「处理」：不再打开（看门狗自己撤的才算这一段过去了）
  if (existing && existing.resolvedAt !== null && existing.resolvedBy !== ACTOR) return out;
  const want = pushAlert(problem);
  if (
    existing &&
    existing.resolvedAt === null &&
    existing.title === want.title &&
    existing.body === want.body
  ) {
    return out;
  }
  try {
    await deps.alerts.raise({
      dedupeKey: PUSH_ALERT_KEY,
      ...want,
      link: PUSH_ALERT_LINK,
      level: 'decision',
      options: pushWatchOptions(),
    });
    deps.log('warn', '看门狗：飞书推送不通', { problem });
  } catch (err) {
    out.problems.push(`飞书推送不通，报「要你拍」没报成：${errMessage(err)}`);
  }
  return out;
}
