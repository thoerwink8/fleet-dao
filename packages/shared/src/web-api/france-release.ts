// 法国发版一键（/france 页 #618）：这一台后端自己跑的 release-train 状态 + 点「发版预检」起 pnpm release:onekey preflight。
// 只到预检；不发版。这里只定义能给页面看的形状：状态三态（在走/暂停中/没在走、读不到），预检一次一回（命令、退出码、输出、读了多久）。
// 每一项各自带「查成了 / 没查成 + 原因」（同 env 页的 EnvFact）；读不到就写读不到，不拿空、0 或假 ok 顶（仓的底线）。
// 这一节只在正式环境接得上（驾驶舱后端真的起在一份检出的仓里、~/.fleet-dao/ 下有 release-train 的状态文件）；
// 开发、内存版后端 deps 没挂上时一律回 unreadable，页面画「没查成 + 原因」，不显示假数据。
import { z } from 'zod';
import { Time } from './internal.ts';

/**
 * release-train 现在的状态：靠两个文件判——
 * - ~/.fleet-dao/release-train.json（一趟的记录；在走、卡住、没成都会在）；
 * - ~/.fleet-dao/release-train.paused（暂停标记；在走 + 已写过 = 暂停了本机和法国的派活）。
 * 三个 state 各说各的：
 * - running：状态文件在 → 正在走 or 卡住（marker + phase 给页面看是哪一段）；
 * - paused：状态文件不在、暂停标记在 → 之前暂停过、这一趟没人收（孤儿标记）。这是状态机外的情况，要让页面标出来；
 * - idle：两个文件都不在 → 没在走、也没暂停。
 * 读不到（不是这台 backend 的 home、读盘错）走 unreadable，页面画「没查成 + 原因」。
 */
export const FranceReleaseStateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('running'),
    /** state 文件里 phase 的中文名（走到第几步了；release-train 自己写的）。 */
    phase: z.string(),
    /** 目标提交或版本号，原样 show（sha 截 12 位，tag 全 show）。 */
    target: z.string(),
    /** 暂停标记在不在（在 = 派活正在停着）。 */
    marker: z.boolean(),
    asOf: Time,
  }),
  z.object({ state: z.literal('paused'), asOf: Time }),
  z.object({ state: z.literal('idle'), asOf: Time }),
  z.object({ state: z.literal('unreadable'), why: z.string(), asOf: Time }),
]);

/**
 * 发版预检一次一回：起子进程 `pnpm release:onekey preflight`（命令固定写死，不收参数），最多 60 秒、512KB。
 * code：0 = 预检过了；非 0 原样回（1 用法不对、2 预检没过、3 卡住），页面给不同颜色。起进程都没起来时 code 给 null，另写 spawnError。
 * stdout / stderr 全回，前端原样分块展示；超长的后端已经截断（truncated 标 true）。
 */
export const FrancePreflightResponseSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('done'),
    command: z.string(),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    /** 后端 ms 单位的耗时（前端给一个「跑了 12 秒」的小字）。 */
    durationMs: z.number().int().min(0),
    /** 60 秒超时被杀了；这种情况 code/signal 由 Node 给，原样透出。 */
    timedOut: z.boolean(),
    truncated: z.boolean(),
    asOf: Time,
  }),
  /** 起子进程都没起来：这台后端没接这一节（开发、内存版），或 pnpm 不在 PATH 里。 */
  z.object({ state: z.literal('unreadable'), why: z.string(), asOf: Time }),
]);

export type FranceReleaseState = z.infer<typeof FranceReleaseStateSchema>;
export type FrancePreflightResponse = z.infer<typeof FrancePreflightResponseSchema>;
