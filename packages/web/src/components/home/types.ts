// 新主页（/）三块卡片和三段流水线图的数据形状：一律从 @fleet-dao/shared 的 web-api.ts（zod）推导，不另写一份（#589）。
// HomeDone 多一个 link：后端不发网址（和 alert-work 一个规矩），由 useHome 按品牌拼好给卡片。
//
// 设计规矩（specs/509-需求梳理/流程重做方案.md 第五节）：
// - 「还没验」（verify_pending、verify_round、merge_queue…）不是失败，不画成红；
// - 额度、中转、engine_off 是持续状态，一直显示、不伪装成失败；
// - 数据读不出来用 LoadError、没接的用 NotBuilt，都不拿空数组或「暂无」冒充。

import type {
  HomeDecisionSchema,
  HomeDoneSchema,
  HomeFlowStageSchema,
  HomeHealthSchema,
  HomeRunningSchema,
  NotWired,
} from '@fleet-dao/shared';
import type { z } from 'zod';

/** 「要你拍的」一条：谁发起的、等什么、去哪答。 */
export type HomeDecision = z.infer<typeof HomeDecisionSchema>;

/** 「在跑的」一张单。 */
export type HomeRunning = z.infer<typeof HomeRunningSchema>;

/** 「做完的」一篇 PR：合约里的字段 + 前端拼好的链接（拼不出来是 undefined）。 */
export type HomeDone = z.infer<typeof HomeDoneSchema> & { link: string | undefined };

/** 三段流水线图头上的一格：这一段在途几张、近期平均耗时。 */
export type HomeFlowStage = z.infer<typeof HomeFlowStageSchema>;

/** 持续状态条（额度、中转、engine_off）。 */
export type HomeHealth = z.infer<typeof HomeHealthSchema>;

/** 一屏三块 + 状态条的整份数据。 */
export interface HomeData {
  decisions: HomeDecision[];
  running: HomeRunning[];
  done: HomeDone[];
  health: HomeHealth;
  /** 对题 → 动手 → 验收三格（固定三项、按这个先后）。 */
  flow: HomeFlowStage[];
}

/**
 * useHome() 的返回形状：loading（还没回来）/ error（读坏了）/ notWired（后端还没接这一块）/
 * data（home-api 真给数据了）。
 */
export type HomeState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown; retry?: () => void }
  | { status: 'notWired'; notWired: NotWired }
  | { status: 'data'; data: HomeData };
