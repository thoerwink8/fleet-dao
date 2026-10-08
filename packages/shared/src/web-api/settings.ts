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

/** 北京时间的一个日期（YYYY-MM-DD）：格式对、日历上真有这一天才算（2026-02-30 不算）。 */
export const BeijingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式是 YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, '日历上没有这一天');

const HoldText = z.string().trim().min(1, '不能留空').max(500, '最多 500 字');

/**
 * 一条整池暂停（#746）：通用段里「临时调整」的五列（内容 = 哪个池，下面四项），缺一项写不进去，多一项也不收（认不出明确失败）。
 * reason 为什么停；decidedBy 谁拍的（原话加日期）；revokeWhen 撤回条件；reviewBy 最迟复查日期（北京时间）。
 * owner 负责人（#954）：没写按「指挥官」（展示时补，不写进库）；空字符串不收。老数据没有这一项，仍算认得出。
 */
export const PoolHoldSchema = z.strictObject({
  reason: HoldText,
  decidedBy: HoldText,
  revokeWhen: HoldText,
  reviewBy: BeijingDateSchema,
  owner: HoldText.optional(),
});
/** 账号池编号 → 这个池的整池暂停。没有这个池的条目 = 没暂停；撤回 = 把这个池的条目删掉（撤回原因写在这次改动的 reason，进操作记录）。 */
export const PoolHoldsSettingSchema = z.record(z.string().min(1), PoolHoldSchema);

/**
 * 整池暂停的现状（现算）：设置里认得出的、认不出的、还靠旧提醒顶着的、到期没复查的。
 * owner 在这里是必填：库里没写的，视图补成「指挥官」（resolvePoolHolds）。不从 PoolHoldSchema 上 extend，
 * 免得可选的 owner 盖住必填。
 */
export const PoolHoldViewSchema = z.strictObject({
  reason: HoldText,
  decidedBy: HoldText,
  revokeWhen: HoldText,
  reviewBy: BeijingDateSchema,
  owner: HoldText,
  poolId: z.string(),
  /** 到了最迟复查日期（当天及以后）还开着：标红，不自动撤，等人撤或续期。 */
  overdue: z.boolean(),
  /** 过了复查日期几天；当天为 0，没到期为 0 且 overdue=false。 */
  overdueDays: z.number().int().min(0),
});
export const PoolHoldProblemSchema = z.object({
  /** 哪个池的那一项认不出；整份认不出为 null（所有池都按暂停办）。 */
  poolId: z.string().nullable(),
  why: z.string(),
});
/** 还靠 `pool-hold:<池>` 提醒顶着的暂停（兼容读法，保留一版）：请迁成上面的开关。 */
export const LegacyPoolHoldSchema = z.object({
  poolId: z.string(),
  title: z.string(),
  since: Time,
  /** 这个池同时已经有开关了：提醒是多余的，等它自己撤或手动处理。 */
  alsoSwitched: z.boolean(),
});
export const PoolHoldsResponse = z.object({
  holds: z.array(PoolHoldViewSchema),
  problems: z.array(PoolHoldProblemSchema),
  /** 设置整份认不出：引擎对所有池按暂停办。 */
  holdAll: z.boolean(),
  legacy: z.array(LegacyPoolHoldSchema),
  /** 读旧提醒没读成：为什么（不拿「没有旧提醒」顶）。读成了没有这一项。 */
  legacyProblem: z.string().optional(),
  /** 设置的版本号（0 = 还没设过）：新建、撤回时带回来。 */
  version: z.number().int().min(0),
  /** 这次算「今天」用的北京日期。 */
  today: BeijingDateSchema,
  asOf: Time,
});

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
  /**
   * 整池暂停（#746，创始人 2026-10-02 拍开关留在库里当指令）：{池编号: {reason, decidedBy, revokeWhen, reviewBy, owner?}}。
   * 选路、切号整池避开；探针探通、会话跑通都撤不掉它，只有人撤（驾驶舱设置页撤回、续期、改负责人要写原因，进操作记录）。
   * 过了 reviewBy 标红、不自动撤。负责人没写按「指挥官」，空着不收。
   * 没设过 = 没有暂停；认不出（整份或某个池的那一项）按暂停办并报警，不当成能用。
   */
  'engine.poolHolds': PoolHoldsSettingSchema,
  /**
   * 引擎总开关（#1086，创始人 2026-10-05：「每次更上去处于关闭状态，点击开启，引擎开始运转，ai开始派活」）。
   * true = 引擎接活；false = 全停：不拉单、不派活、不起任何「干活」的模型会话；探针、路由探针、驾驶舱健康这些看家检查照跑
   * （同日约 22:40：关着也要能看到渠道是否通）。和按项目的「让 AI 接活」（repos.auto_dispatch_since）是串联：
   * 总开关关＝全停；总开关开＝只有接活开着的项目才派。没设过 = 关（默认关）；谁在什么时候改的看 settings 行的 updatedBy/updatedAt。
   */
  'engine.master': z.boolean(),
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
