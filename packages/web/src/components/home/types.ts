// 新主页（/home3）三块卡片的数据形状。
// 来源：驾驶舱 home-api 切片（#556 下）会出一份「要你拍的 / 在跑的 / 做完的 + 持续状态」的聚合接口；
// 这里先把形状钉住，home-api 出来之前 home.tsx 用 NotWired 占位、卡片组件按这四种状态直接接收 props。
//
// 设计规矩（specs/509-需求梳理/流程重做方案.md 第五节）：
// - 「还没验」（verify_pending、verify_round、merge_queue…）不是失败，不画成红；
// - 额度、中转、engine_off 是持续状态，一直显示、不伪装成失败；
// - 数据读不出来用 LoadError、没接的用 NotBuilt，都不拿空数组或「暂无」冒充。

import type { NotWired } from '@fleet-dao/shared';

/** 「要你拍的」一条：谁发起的、等什么、去哪答。 */
export interface HomeDecision {
  /** 来源：decision 通知 / approvals / 未答的 asks。 */
  kind: 'notification' | 'approval' | 'ask';
  id: string;
  title: string;
  /** 来源需求 / PR / 会话的一句话背景。 */
  context?: string;
  /** 提出时刻（ISO）。 */
  since: string;
  /** 答它的去处：通知详情 / 任务详情 / PR。 */
  link: string;
}

/** 「在跑的」一张单。 */
export interface HomeRunning {
  issueNumber: number;
  title: string;
  /** 仓：owner/name。 */
  repo: string;
  /** 卡在哪一段。verify_pending 是「合完在等 CI 绿 / 合完还没验」，不是失败。 */
  segment: 'scoping' | 'doing' | 'verifying' | 'verify_pending' | 'merge';
  /** 为什么停在这一秒没进展。nothing = 在正常跑，没在等什么。 */
  waitingReason:
    | 'queue'
    | 'memory'
    | 'quota_reset'
    | 'ci'
    | 'verify_round'
    | 'founder_decision'
    | 'merge_queue'
    | 'nothing';
  /** 从什么时候起在等（ISO）；waitingReason === 'nothing' 时可没有。 */
  waitingSince?: string;
  /** 打开任务详情。 */
  link: string;
}

/** 「做完的」一篇 PR。 */
export interface HomeDone {
  prNumber: number;
  title: string;
  /** 仓：owner/name。 */
  repo: string;
  /** 合进去的时刻（ISO）。 */
  mergedAt: string;
  /** 打开 PR。 */
  link: string;
}

/** 持续状态条（额度、中转、engine_off）。有问题就一直显示、不闪不跳，但不画成红色失败。 */
export interface HomeHealth {
  /**
   * 额度池的状态汇总。empty = 一块池都没配；ok = 都在限度内；tight = 有池快清零（提醒，不是失败）；
   * unknown = 还没读到（刚启动时）。
   */
  quota: { state: 'ok' | 'tight' | 'empty' | 'unknown'; detail: string };
  /**
   * 中转 / 路由探针的状态。ok = 探针在跑且有在线路由；degraded = 探针在跑、但有路由探不通（持续显示）；
   * unknown = 探针还没出过结论。
   */
  routes: { state: 'ok' | 'degraded' | 'unknown'; detail: string };
  /**
   * 引擎的开关：off = 临时调整停了（一直显示，直到把开关改回去）；on = 正常。
   */
  engine: { state: 'on' | 'off'; detail?: string };
}

/** 一屏三块 + 状态条的整份数据。 */
export interface HomeData {
  decisions: HomeDecision[];
  running: HomeRunning[];
  done: HomeDone[];
  health: HomeHealth;
}

/**
 * useHome() 的返回形状：loading（还没回来）/ error（读坏了）/ notWired（后端还没接这一块）/
 * data（home-api 真给数据了）。home-api 切片出来后只需要改 useHome 的实现，这一层的形状不变。
 */
export type HomeState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'notWired'; notWired: NotWired }
  | { status: 'data'; data: HomeData };
