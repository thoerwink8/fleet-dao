// 排空的提醒（驾驶舱看得到「在为发布排空、最晚几点照发」）：开始排空写一条，撤掉排空、新引擎起来时撤掉它并写明结果。
// 改这里之前必须知道：只在开始、结束各写一次，正文不带会变的倒计时（飞书卡片每改一次都算接口调用，design 15.4）；
// 「还剩几分钟」按正文里的截止算。
import { type Db, resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';
import type { DrainEvent } from '../drain-control.ts';

export const DRAIN_ALERT_KEY = 'engine-drain';
const ACTOR = 'engine:drain';

/** 开始排空时那一条提醒的标题和正文。 */
export function drainAlertText(
  event: Extract<DrainEvent, { kind: 'start' }>,
  machine: string,
  nowMs: number,
): { title: string; body: string } {
  const c = event.cordon;
  const minutes = Math.max(0, Math.round((Date.parse(c.until) - nowMs) / 60_000));
  const what = c.source === 'release' ? `要发新版本（${c.why}）` : `在停（${c.why}）`;
  const running =
    event.inFlight.length === 0
      ? '手上没有会话在跑'
      : `手上 ${event.inFlight.length} 个会话在跑（${event.inFlight.map((s) => s.stage).join('、')}）`;
  return {
    title: `${machine}的引擎在为发布排空：最晚 ${c.until} 照发`,
    body: [
      `${machine}的引擎${what}：${c.since} 起不起新会话。${running}，最晚做到 ${c.until}（约 ${minutes} 分钟），到点没做完的停下，新引擎起来按编号续上；发完马上接着派。`,
      '在等额度、等空位、等人的单子不受影响，发完照常派。排空结束（发完、或者发布没成撤了请求）这一条自己撤，撤的原因写在最前面。',
    ].join('\n'),
  };
}

/**
 * 排空是告知、不是要人修的事：到点自己照发、发完自己撤，没有谁该去认领。记成 alert 的话，当时还在的提醒派单（#394）
 * 20 分钟后会推「没人认领」、没挂单还开跟进单（09-28 第一次真排空就这么推了；提醒派单整层已在 #445 删掉，
 * 但 daily 级仍然对：不进每小时对账的 24 小时再提醒，也不进要人拍）。排空卡住另有「发布没成」那条报。
 */
export const DRAIN_ALERT_LEVEL = 'daily' as const;

/** 真的报法：写进 notifications（upsertAlert），撤掉时写明原因。写不进去照抛，由 drain-control 记日志、不挡排空。 */
export function drainNotifier(deps: { db: Db; machine: string; now?: () => Date }) {
  const clock = deps.now ?? (() => new Date());
  return async (event: DrainEvent): Promise<void> => {
    if (event.kind === 'start') {
      const { title, body } = drainAlertText(event, deps.machine, clock().getTime());
      await upsertAlert(deps.db, {
        dedupeKey: DRAIN_ALERT_KEY,
        level: DRAIN_ALERT_LEVEL,
        taskId: null,
        title,
        body,
      });
      return;
    }
    const why =
      event.kind === 'lift'
        ? `${event.why}，接着派`
        : `新引擎起来了（${event.ownSha ? event.ownSha.slice(0, 12) : '版本认不出'}），接着派`;
    // 本来就没有、撤过了都不算错（新引擎每次起来都撤一次）
    await resolveAlertWithReason(deps.db, { dedupeKey: DRAIN_ALERT_KEY, by: ACTOR, why, at: clock() });
  };
}
