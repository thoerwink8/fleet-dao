// 驾驶舱接口约定（web-api）：环境页（#820 片 1）：这一台环境现在怎样，一页看全。
// 每一项各自带「查成了 / 没查成 + 原因」：读不到就是读不到，不拿空或 0 冒充正常（通用段「底线」）。一项读失败
// 不连累别的项（后端一项一个 try/catch 包住）；页面把「没查成」如实画出来，不画成「没事」。
// 只读、不跨环境、不开口子：这一页读的全是本后端自己库里的现成读法（/healthz、主页、额度页用的是同一份）。
// 演示版没有这一页（导航不给 module，路由表也不放）：这里不写演示版要用的形状。
import { z } from 'zod';
import { StageKindSchema } from './enums.ts';
import { Time } from './internal.ts';

/** 一项的成败。ok=true 带值；ok=false 带一句给人的原因，这一项没查成、别的项照常。 */
export type EnvFact<T> = { ok: true; value: T } | { ok: false; reason: string };

function factOf<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), reason: z.string().min(1) }),
  ]);
}

/**
 * 环境名（api.env 的 FLEET_MACHINE_NAME，和引擎那边同一项）：顶栏徽标和这一页的标题都用它。
 * 没配、读不出时 name 给明确占位（「认不出」），problem 写原因——不拿「法国」这种猜的值冒充。
 */
export const EnvNameSchema = z.object({
  name: z.string().min(1),
  problem: z.string().min(1).optional(),
});

/** 引擎那一格：和主页同一个探法（home-engine.ts）。off = 按 FLEET_SERVICES 没开（临时调整，不标红）。 */
export const EnvEngineSchema = z.object({
  state: z.enum(['on', 'off', 'down', 'unknown']),
  detail: z.string().optional(),
});

/** 在用版本、落后主线没有、最近一次发布。只在法国的正式机器上有；别的环境读不到标记，照实报到 problems / reason。 */
export const EnvVersionSchema = z.object({
  /** 在用的提交号；还没发布过是 null。 */
  current: z.string().nullable(),
  /** 落后主线几个提交；读不出、没发布过是 null。 */
  behind: z.number().int().min(0).nullable(),
  /** 一句给人的话（在用哪版、落后多少、还没发布过）。 */
  detail: z.string(),
  /** 判出来的问题（没查成、卡住），空数组 = 没查出问题。 */
  problems: z.array(z.string()),
});

/** 在跑几个会话、各自在哪一段。 */
export const EnvSessionsSchema = z.object({
  total: z.number().int().min(0),
  byStage: z.record(StageKindSchema, z.number().int().min(0)),
});

export const EnvPoolsSchema = z.object({
  count: z.number().int().min(0),
  /** 正在跑的会话数合计（各池相加）。 */
  running: z.number().int().min(0),
  /** 一次都没读成额度的池数：没查成，不是「没用量」。 */
  unread: z.number().int().min(0),
  /** 读成过、但读数已过期的池数。 */
  stale: z.number().int().min(0),
});

export const EnvHealthSchema = z.object({
  ok: z.boolean(),
  total: z.number().int().min(0),
  /** 红了的项名（真没连上）；「未接」不算进来。 */
  failing: z.array(z.string()),
  /** 没接上的项名（这台机器没有这一项功能，不算坏）。 */
  notWired: z.array(z.string()),
});

export const EnvScheduleSchema = z.object({
  /** 最近一轮拉单（intake）：上次跑成、结局、扫了几个。 */
  lastSuccessAt: Time.optional(),
  status: z.enum(['fresh', 'overdue', 'never']),
  outcome: z.enum(['ok', 'partial', 'unscanned', 'failed']).optional(),
  scanned: z.number().int().min(0).optional(),
  why: z.string().optional(),
});

export const EnvResponseSchema = z.object({
  name: EnvNameSchema,
  asOf: Time,
  facts: z.object({
    engine: factOf(EnvEngineSchema),
    version: factOf(EnvVersionSchema),
    sessions: factOf(EnvSessionsSchema),
    pools: factOf(EnvPoolsSchema),
    health: factOf(EnvHealthSchema),
    schedule: factOf(EnvScheduleSchema),
  }),
});

export type EnvEngine = z.infer<typeof EnvEngineSchema>;
export type EnvVersion = z.infer<typeof EnvVersionSchema>;
export type EnvSessions = z.infer<typeof EnvSessionsSchema>;
export type EnvPools = z.infer<typeof EnvPoolsSchema>;
export type EnvHealth = z.infer<typeof EnvHealthSchema>;
export type EnvSchedule = z.infer<typeof EnvScheduleSchema>;
export type EnvResponse = z.infer<typeof EnvResponseSchema>;
/** 一整份环境页事实清单里的每一项（后端拼好、前端逐项画，每项各自带「查成了 / 没查成 + 原因」）。 */
export type EnvFacts = EnvResponse['facts'];
