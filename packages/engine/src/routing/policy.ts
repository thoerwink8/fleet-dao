// 选路的参数与能力表。全是起步值：驾驶舱「战绩」「额度」攒够真实数据后再调，每个数的理由写在旁边。
// 给了但不对的直接报错，不悄悄换成默认值。
import type { HostId, QuotaWindowKind, StageKind } from '@fleet-dao/shared';
import { RoutingInputError, type TaskWeight } from './types.ts';

/** 执行方式能做的事。answer = 只答题；read = 读仓库；edit = 改文件；shell = 跑命令和测试。 */
export type Ability = 'answer' | 'read' | 'edit' | 'shell';

/**
 * 执行方式 × 能力。命令行写码助手（含经 Mirasim 程序接口起的）四样都会。
 * 接口外壳（api-shell）的写码外壳还没做出来，眼下只接判断题；做好了把这一行改成四样。
 */
export const HOST_ABILITIES: Readonly<Record<HostId, readonly Ability[]>> = {
  'claude-code': ['answer', 'read', 'edit', 'shell'],
  codex: ['answer', 'read', 'edit', 'shell'],
  'cursor-agent': ['answer', 'read', 'edit', 'shell'],
  grok: ['answer', 'read', 'edit', 'shell'],
  mirasim: ['answer', 'read', 'edit', 'shell'],
  'api-shell': ['answer'],
};

/**
 * 阶段 × 要的能力。写码、UI 要改文件并跑测试；写需求文档、方案要读仓库并写进 specs/；
 * 审查要读代码、能跑测试；调研要读；分诊和判断题只答题（接口外壳或命令行都行）。
 */
export const STAGE_NEEDS: Readonly<Record<StageKind, readonly Ability[]>> = {
  triage: ['answer'],
  judge: ['answer'],
  spec: ['read', 'edit'],
  plan: ['read', 'edit'],
  execute: ['read', 'edit', 'shell'],
  ui: ['read', 'edit', 'shell'],
  review: ['read', 'shell'],
  research: ['read'],
};

export const ABILITY_NAMES: Readonly<Record<Ability, string>> = {
  answer: '答题',
  read: '读仓库',
  edit: '改文件',
  shell: '跑命令和测试',
};

export interface FastReset {
  /** 离清零不超过这么多小时算「快清零」。 */
  withinHours: number;
  /** 还剩不少于这个比例算「还剩很多」。 */
  minRemaining: number;
}

export interface RoutingPolicy {
  /**
   * 快清零提前：只看这些窗口。周窗、按月 / 按账期的窗口清零时没用完的就作废，所以要赶在清零前用掉。
   * 不看 5 小时窗：它几小时就轮一次，真正卡人的是周窗；拿 5 小时窗提前会让顺序每小时抖一次，还会替周窗多烧额度。
   * 周窗 24 小时 / 剩 30%：24 小时是创始人举的例子；剩 30% 以上才值得插队，少于这个数的快清零池本来就会被自然用完。
   * 月窗 / 账期 48 小时 / 剩 20%：账期长，剩两成就是不小的一笔钱。
   */
  fastReset: Partial<Record<QuotaWindowKind, FastReset>>;
  /**
   * 快清零提前还要求：这条路由的其余适用窗口都还剩不少于这个比例、而且都读成了。
   * 这是「不会把快用满的池顶到最前」的保证：周窗快清零、但 5 小时窗已经用了九成的池不提前（派过去也跑不完）。
   */
  othersMinRemaining: number;
  /** 战绩样本少于这个数不动（旧系统保底线同样是 10）。 */
  minSamples: number;
  /** 样本够、成功率低于这个数算「明显差」，往后放（旧系统保底线 0.5，只后置不淘汰）。 */
  poorSuccessRate: number;
  /** 试探开关；构建期关着（全用 Opus 5.5）。 */
  trialEnabled: boolean;
  /** 开着时约这么多比例的任务派给非首选的可用路由。 */
  trialRatio: number;
  /** 备池（拼车号）同时最多几个会话，和池自己的并发上限取小的（创始人 2026-09-25 定：不超过 2）。 */
  backupMaxConcurrency: number;
  /**
   * 备池剩余少于这个比例就不派（「剩余不够跑一个活」）。按窗口种类给：一个轻活大约占 5 小时窗的一成、周窗的百分之三。
   * 这是估的，没有量过；攒够会话用量后换成「该阶段在该池上的 p80 用量」。没列的种类按 other 算。
   */
  backupNeedPerTask: Partial<Record<QuotaWindowKind, number>>;
  /** 各阶段默认的轻重（任务没给轻重时用）：分诊、判断题、写需求文档算短而轻，其余算重。 */
  stageWeight: Record<StageKind, TaskWeight>;
}

export const DEFAULT_ROUTING_POLICY: Readonly<RoutingPolicy> = Object.freeze<RoutingPolicy>({
  fastReset: {
    '7d': { withinHours: 24, minRemaining: 0.3 },
    '7d_model': { withinHours: 24, minRemaining: 0.3 },
    month_usd: { withinHours: 48, minRemaining: 0.2 },
    period_usd: { withinHours: 48, minRemaining: 0.2 },
  },
  othersMinRemaining: 0.2,
  minSamples: 10,
  poorSuccessRate: 0.5,
  trialEnabled: false,
  trialRatio: 0.1,
  backupMaxConcurrency: 2,
  backupNeedPerTask: {
    '5h': 0.1,
    '7d': 0.03,
    '7d_model': 0.03,
    month_usd: 0.02,
    period_usd: 0.02,
    points: 0.05,
    other: 0.05,
  },
  stageWeight: {
    triage: 'light',
    judge: 'light',
    spec: 'light',
    plan: 'heavy',
    execute: 'heavy',
    ui: 'heavy',
    review: 'heavy',
    research: 'heavy',
  },
});

/** 缺的取默认值，给了但不对的报错。 */
export function resolveRoutingPolicy(partial?: Partial<RoutingPolicy>): RoutingPolicy {
  // fastReset 整张换（换了就能去掉某种窗口）；另两张表按项合并，只改给了的那几项。
  const p: RoutingPolicy = {
    ...DEFAULT_ROUTING_POLICY,
    ...(partial ?? {}),
    backupNeedPerTask: { ...DEFAULT_ROUTING_POLICY.backupNeedPerTask, ...partial?.backupNeedPerTask },
    stageWeight: { ...DEFAULT_ROUTING_POLICY.stageWeight, ...partial?.stageWeight },
  };
  const bad = (key: string, want: string, got: unknown) =>
    new RoutingInputError(`选路策略的 ${key} 不对：要${want}，给的是 ${JSON.stringify(got)}`);
  const ratio = (key: string, v: unknown, { zeroOk = true } = {}) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v > 1 || (zeroOk ? v < 0 : v <= 0)) {
      throw bad(key, zeroOk ? ' 0 到 1 之间的数' : '大于 0、不超过 1 的数', v);
    }
  };
  for (const [kind, f] of Object.entries(p.fastReset)) {
    if (f === undefined) continue;
    if (typeof f.withinHours !== 'number' || !Number.isFinite(f.withinHours) || f.withinHours <= 0) {
      throw bad(`fastReset.${kind}.withinHours`, '大于 0 的小时数', f.withinHours);
    }
    ratio(`fastReset.${kind}.minRemaining`, f.minRemaining, { zeroOk: false });
  }
  ratio('othersMinRemaining', p.othersMinRemaining);
  if (!Number.isInteger(p.minSamples) || p.minSamples < 1)
    throw bad('minSamples', '不小于 1 的整数', p.minSamples);
  ratio('poorSuccessRate', p.poorSuccessRate);
  if (typeof p.trialEnabled !== 'boolean') throw bad('trialEnabled', ' true 或 false', p.trialEnabled);
  ratio('trialRatio', p.trialRatio, { zeroOk: false });
  if (!Number.isInteger(p.backupMaxConcurrency) || p.backupMaxConcurrency < 1) {
    throw bad('backupMaxConcurrency', '不小于 1 的整数', p.backupMaxConcurrency);
  }
  for (const [kind, need] of Object.entries(p.backupNeedPerTask)) {
    if (need !== undefined) ratio(`backupNeedPerTask.${kind}`, need);
  }
  for (const [stage, w] of Object.entries(p.stageWeight)) {
    if (w !== 'light' && w !== 'heavy') throw bad(`stageWeight.${stage}`, ' light 或 heavy', w);
  }
  return p;
}
