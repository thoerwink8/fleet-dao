// 驾驶舱接口约定（web-api）：实时推送（SSE）。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { type ChangeEvent, REALTIME_TABLES } from '../realtime.ts';
import type { Same } from './internal.ts';

// —— 实时推送（SSE：GET /api/events）——

/**
 * 事件名。ready：连上了，前端全量拉一次；change：某张表的某一行变了，前端重拉受影响的数据；
 * resync：中间可能漏了变化（后端和数据库之间断过线，或者浏览器断开太久），前端全部重拉。
 * change 和 resync 都带 SSE 的 id；浏览器断线重连时（EventSource 自动带 Last-Event-ID）后端补发断开期间的变化，
 * 补不全（后端重启过、断开太久）就先发一条 resync。
 */
export const SSE_EVENTS = { ready: 'ready', change: 'change', resync: 'resync' } as const;

/** change 事件的 data，也是数据库 NOTIFY fleet_changes 的载荷（形状定义在 realtime.ts）。 */
export const ChangeEventSchema = z.object({
  table: z.enum(REALTIME_TABLES),
  id: z.string().min(1).max(200),
});

/** 编译期闸：ChangeEventSchema 和 realtime.ts 的 ChangeEvent 必须同形。 */
export const CHANGE_EVENT_MATCHES_REALTIME: Same<z.infer<typeof ChangeEventSchema>, ChangeEvent> = true;
