// 飞书网关最后一次来是什么时候：/healthz 的 feishu_gateway 一项（健康页写「飞书网关」）。
// 网关（香港）一直在长轮询意图卡（/feishu/intent-cards，一轮最多等 25 秒）；通行证验过的请求进来就记一笔
// （intent-routes.ts 的门口），读的时候现算：意图卡轮询 5 分钟没来就报红。
// 改这里之前必须知道：
// - 只记在进程里：后端重启后从起来那一刻算；起来后网关还没来过，报「没查成」（不当成好），网关一般几秒到半分钟就回来。
// - 会随时间自己变红（网关、隧道、香港出事都算，和这一版好不好无关）：发布脚本只标待处理、不退回
//   （deploy/release.sh 的 DRIFTING_HEALTH_ITEMS，health.test.ts 核对）。
// - 公网看得到 /healthz：只说多久没来，不带地址、内部名。src 里只有一处 new PublicHealthError，公开文字的测试造过它。
// - 网关那边自己也看着（packages/feishu/src/watch.ts）：它调不通后端时自己往飞书群报警；这一项管网关整个没了、它自己报不了的时候。
//   两边同一个 5 分钟。
import { IntentRoutes } from '@fleet-dao/shared';
import { PublicHealthError } from './health.ts';

/** 意图卡轮询这么久没来就报红：和网关自己报警同一个时限（packages/feishu/src/watch.ts 的 WATCH_LIMITS.alertAfterMs）。 */
export const GATEWAY_SILENT_MS = 5 * 60_000;
/** 没配网关通行证：网关的请求一律不认，这一项报「未接」（公网看得到）。 */
export const GATEWAY_NO_PASS = '没配飞书网关的通行证，网关的请求一律不认';

interface RouteKey {
  method: string;
  path: string;
}
const keyOf = (r: RouteKey) => `${r.method} ${r.path}`;
const CARDS = keyOf(IntentRoutes.cards);

export interface GatewaySeen {
  /** 通行证验过的网关请求进来了（intent-routes.ts 调）。 */
  saw(route: RouteKey): void;
  /** /healthz 的 feishu_gateway：意图卡轮询来得勤就回一句几秒前来过；太久没来、起来后还没来过都抛（PublicHealthError）。 */
  check(): Promise<string>;
}

/** 「12 秒」「7 分钟」「2 小时 5 分钟」。 */
function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

export function createGatewaySeen(now: () => Date, silentMs = GATEWAY_SILENT_MS): GatewaySeen {
  const startedAt = now().getTime();
  /** 意图卡轮询最后一次来的时刻。 */
  let cards: number | undefined;
  /** 别的网关请求（收原话、撤回、补漏游标、卡的回执）最后一次来的时刻：只拿来说「网关还在」，不顶替意图卡轮询。 */
  let other: number | undefined;

  return {
    saw(route) {
      if (keyOf(route) === CARDS) cards = now().getTime();
      else other = now().getTime();
    },

    async check() {
      const t = now().getTime();
      if (cards !== undefined && t - cards <= silentMs) return `意图卡轮询 ${span(t - cards)}前来过`;
      let code: string;
      let message: string;
      if (cards !== undefined) {
        code = 'silent';
        message = `意图卡轮询 ${span(t - cards)}没来过`;
      } else if (t - startedAt < silentMs) {
        code = 'unchecked';
        message = `没查成：后端起来才 ${span(t - startedAt)}，意图卡轮询还没来过`;
      } else {
        code = 'silent';
        message = `后端起来 ${span(t - startedAt)}了，意图卡轮询一次都没来过`;
      }
      // 原话还在送来、意图卡不来：网关在，是它意图卡那条循环没在跑
      throw new PublicHealthError(
        code,
        message,
        other !== undefined && t - other <= silentMs ? '网关还在（收原话在来），意图卡那条没在跑' : undefined,
      );
    },
  };
}
