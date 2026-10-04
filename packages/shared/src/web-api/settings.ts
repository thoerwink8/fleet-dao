// 驾驶舱接口约定（web-api）：设置。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import type { QuotaWindowKind } from '../domain.ts';
import { type Same, Time } from './internal.ts';

// —— 设置 ——

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '格式是 HH:MM');

/**
 * 额度留量线的一个比例（#194 方案 4.8）：已用到这个比例，引擎就不再往这个渠道派新活、也不切过去。0–1，不收负数、大于 1、
 * 不是数字的值。null = 明确不限；不写这个窗口 = 未配置（也是不限）。
 */
const ReserveRatioSchema = z.number().min(0, '留量线不能小于 0').max(1, '留量线不能大于 1（100%）');
export const PoolReserveLinesSchema = z.strictObject({
  '5h': ReserveRatioSchema.nullable().optional(),
  '7d': ReserveRatioSchema.nullable().optional(),
  '7d_model': ReserveRatioSchema.nullable().optional(),
  month_usd: ReserveRatioSchema.nullable().optional(),
  points: ReserveRatioSchema.nullable().optional(),
  period_usd: ReserveRatioSchema.nullable().optional(),
  other: ReserveRatioSchema.nullable().optional(),
});
/** 账号池编号 → 这个池各额度窗的留量线（按池配，池就是额度页上的「渠道」一行）。 */
export const QuotaReserveSettingSchema = z.record(z.string().min(1), PoolReserveLinesSchema);
// 窗口种类加了一种、这里漏了，tsc 当场报错
export const RESERVE_KEYS_MATCH_WINDOWS: Same<keyof z.infer<typeof PoolReserveLinesSchema>, QuotaWindowKind> =
  true;

/** 驾驶舱能改的全局设置。新增一项就在这里加一行；不在表里的键一律拒收。 */
export const SETTING_SCHEMAS = {
  /** 同时跑的 AI 会话上限（设计文档第四节：起步 6 个）。 */
  'sessions.maxConcurrent': z.number().int().min(1).max(32),
  /** 飞书免打扰时段（北京时间）；null = 不设。 */
  'notify.quietHours': z.object({ start: HHMM, end: HHMM }).nullable(),
  /** Jev 每天最多调用多少次。 */
  'judge.dailyCallLimit': z.number().int().min(0).max(100_000),
  /**
   * 引擎暂不用独享（#194 方案 v2 4.8）：开着时拼车用不了也不切独享，Claude 的活等拼车恢复或交给别家模型——创始人自己要大用
   * 独享时一键关掉引擎这一路。已经挂着独享时不受影响（该切回照切回）。没设过 = false。
   */
  'engine.soloPaused': z.boolean(),
  /**
   * 每个渠道（账号池）的额度留量线（#194 方案 4.8，创始人 2026-10-04：「到了配置额度，这个渠道就不能用了……是全渠道配置项」）：
   * {池编号: {窗口: 比例 | null}}。已用到线，选路不再派新活到这个池、切号也不切过去。代码里没有任何默认值：起始值在种子文件
   * packages/db/quota-reserve.default.json（装载器只补缺装进库），之后在驾驶舱改。这个池没写 = 不限（驾驶舱写「未配置」）；
   * 库里没有这一行 = 种子没装上，明确失败（引擎不派、不切），不当成不限。
   */
  'engine.quotaReserve': QuotaReserveSettingSchema,
} as const;
export type SettingKey = keyof typeof SETTING_SCHEMAS;

export const SettingSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  /** 0 = 还没设过。 */
  version: z.number().int().min(0),
  updatedAt: Time.optional(),
  updatedBy: z.string().optional(),
});
export const SettingsResponse = z.object({ settings: z.array(SettingSchema) });

/** version 填你改之前看到的；别人先改了就返回 409。 */
export const UpdateSettingRequest = z.object({
  value: z.unknown(),
  version: z.number().int().min(0),
  reason: z.string().max(500).optional(),
});
export const UpdateSettingResponse = z.object({ setting: SettingSchema });
