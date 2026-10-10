// 路由探针的逐次历史（#1139）：routes 只留最近一次结论，渠道状态页要画每次的耗时和问题，得另有一张只追加的表。
// 不设外键：路由可以被删（探针这一轮里会碰到），历史不该挡住删除，也不该跟着被清掉。迁移只建这张表和索引。
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;

/** 通过 = 探通（含额度用满仍算通）；不通 = 探了没通；没探 = 这一轮按规矩没探（插头没接、跳过）。 */
export const ROUTE_PROBE_HISTORY_RESULTS = ['passed', 'failed', 'not_probed'] as const;
export type RouteProbeHistoryResult = (typeof ROUTE_PROBE_HISTORY_RESULTS)[number];

export const routeProbeHistory = pgTable(
  'route_probe_history',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    routeId: text('route_id').notNull(),
    /** 下这条结论的时刻。同一时刻再按 id，后写入的算更新。 */
    probedAt: timestamp('probed_at', tz).notNull(),
    result: text('result').$type<RouteProbeHistoryResult>().notNull(),
    /** 这一次真探的耗时（毫秒）。没探、或探针没量到，为空，不当 0。 */
    durationMs: integer('duration_ms'),
    /** 不通、没探的原因。通过必须为空：成功的那句话在路由的 probe_detail，不写成失败。 */
    failureReason: text('failure_reason'),
    /** 发出去的请求原文。没发出去为空。超长由写入方截断并标注。 */
    requestText: text('request_text'),
    /** 响应原文。没拿到为空。超长由写入方截断并标注。 */
    responseText: text('response_text'),
    /** 降智检测（#1637），全部可空，老行不动。题面、标准答案、实答超长由写入方截断并标注。 */
    checkQuestion: text('check_question'),
    checkExpected: text('check_expected'),
    checkAnswer: text('check_answer'),
    /** 判过：true 答对、false 答错或没写第二行；空 = 没判（没带题、回答里没有第一行 OK）。 */
    checkPassed: boolean('check_passed'),
    /** 模型自报的厂家和型号，只记不判。 */
    selfIdentity: text('self_identity'),
  },
  (t) => [
    index('route_probe_history_route_recent_idx').on(t.routeId, t.probedAt, t.id),
    check('route_probe_history_result_known', sql`${t.result} in ('passed', 'failed', 'not_probed')`),
    check('route_probe_history_duration_nonneg', sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
    check(
      'route_probe_history_reason_matches_result',
      sql`(${t.result} = 'passed' and ${t.failureReason} is null) or (${t.result} <> 'passed' and coalesce(${t.failureReason}, '') <> '')`,
    ),
  ],
);
