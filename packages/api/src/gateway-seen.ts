// 飞书网关最后一次来是什么时候：/healthz 的 feishu_gateway 一项（健康页写「飞书网关」）。
// 网关（香港）一直在长轮询待推送（一轮最多等 25 秒）、每 30 秒取一次盘面快照；通行证验过的请求进来就记一笔
// （feishu-routes.ts 的门口），读的时候现算：推送轮询 5 分钟没来就报红。
// 改这里之前必须知道：
// - 只记在进程里：后端重启后从起来那一刻算；起来后网关还没来过，报「没查成」（不当成好），网关一般几秒到半分钟就回来。
// - 会随时间自己变红（网关、隧道、香港出事都算，和这一版好不好无关）：发布脚本只标待处理、不退回
//   （deploy/release.sh 的 DRIFTING_HEALTH_ITEMS，health.test.ts 核对）。
// - 公网看得到 /healthz：只说多久没来，不带地址、内部名。src 里只有一处 new PublicHealthError，公开文字的测试造过它。
// - 网关那边自己也看着（packages/feishu/src/watch.ts）：它调不通后端时自己往飞书群报警；这一项管网关整个没了、它自己报不了的时候。
//   两边同一个 5 分钟。
import { FeishuRoutes } from '@fleet-dao/shared';
import { PublicHealthError } from './health.ts';

/** 推送轮询这么久没来就报红：和网关自己报警同一个时限（packages/feishu/src/watch.ts 的 WATCH_LIMITS.alertAfterMs）。 */
export const GATEWAY_SILENT_MS = 5 * 60_000;
/** 没配网关通行证：网关的请求一律不认，这一项报「未接」（公网看得到）。 */
export const GATEWAY_NO_PASS = '没配飞书网关的通行证，网关的请求一律不认';

interface RouteKey {
  method: string;
  path: string;
}
const keyOf = (r: RouteKey) => `${r.method} ${r.path}`;

export interface GatewaySeen {
  /** 通行证验过的网关请求进来了（feishu-routes.ts 调）。 */
  saw(route: RouteKey): void;
  /** /healthz 的 feishu_gateway：推送轮询来得勤就回一句几秒前来过；太久没来、起来后还没来过都抛（PublicHealthError）。 */
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
  const last = new Map<string, number>();

  return {
    saw(route) {
      last.set(keyOf(route), now().getTime());
    },

    async check() {
      const t = now().getTime();
      const push = last.get(keyOf(FeishuRoutes.outbox));
      const board = last.get(keyOf(FeishuRoutes.board));
      const boardText = board === undefined ? '盘面快照也没来取过' : `盘面快照 ${span(t - board)}前来过`;
      if (push !== undefined && t - push <= silentMs) return `推送轮询 ${span(t - push)}前来过，${boardText}`;
      let code: string;
      let message: string;
      if (push !== undefined) {
        code = 'silent';
        message = `推送轮询 ${span(t - push)}没来过（${boardText}）`;
      } else if (t - startedAt < silentMs) {
        code = 'unchecked';
        message = `没查成：后端起来才 ${span(t - startedAt)}，推送轮询还没来过（${boardText}）`;
      } else {
        code = 'silent';
        message = `后端起来 ${span(t - startedAt)}了，推送轮询一次都没来过（${boardText}）`;
      }
      // 盘面快照还在来、推送不来：网关在，是它推送那条循环没在跑
      throw new PublicHealthError(
        code,
        message,
        board !== undefined && t - board <= silentMs ? '网关还在（盘面快照在来），推送那条没在跑' : undefined,
      );
    },
  };
}
