// 路由、模型、账号池、额度窗的查询与白话名。各页都从这里拿名字，不各拼各的。
import { hardBanFor } from '@fleet-dao/shared';
import type {
  BillingKind,
  HostId,
  PoolView,
  QuotaWindowKind,
  QuotaWindowView,
  Route,
  Routing,
  StageKind,
} from '../api/types';
import { TIME } from './format';

export const STAGES: { id: StageKind; label: string; hint: string }[] = [
  { id: 'triage', label: '分诊', hint: '判断是哪类活、说没说清、多大、碰不碰人闸' },
  { id: 'spec', label: '需求文档', hint: '按原话写「要什么、怎么算做完」' },
  { id: 'plan', label: '方案', hint: '怎么做、拆几块、各改哪里、先后依赖' },
  { id: 'execute', label: '写码', hint: '改文件、跑测试、开 PR；执行方式要能改文件' },
  { id: 'ui', label: 'UI', hint: '界面类写码；GPT 族不碰' },
  { id: 'review', label: '第二意见', hint: '全新会话看改动，最多 2 轮' },
  { id: 'research', label: '调研', hint: '查资料、比方案' },
  { id: 'judge', label: '判断', hint: 'Jev 判断题：选择题 + 把握度' },
];

export const stageLabel: Record<StageKind, string> = {
  triage: '分诊',
  spec: '需求文档',
  plan: '方案',
  execute: '写码',
  ui: 'UI',
  review: '第二意见',
  research: '调研',
  judge: '判断',
};

export const hostLabel: Record<HostId, string> = {
  'claude-code': 'Claude Code',
  codex: 'codex',
  'cursor-agent': 'cursor-agent',
  grok: 'Grok 命令行',
  mirasim: 'Mirasim',
  'api-shell': '接口 + 自研外壳',
};

export const billingLabel: Record<BillingKind, string> = {
  subscription: '套餐内',
  metered: '按量',
};

export const windowLabel: Record<QuotaWindowKind, string> = {
  '5h': '5 小时窗',
  '7d': '周窗',
  '7d_model': '周窗 · 单模型',
  month_usd: '月度美元',
  points: '点数',
  period_usd: '周期美元',
};

/**
 * 各时间窗的长度，用来判断「快清零」。契约里的额度窗没带窗口起点，先按种类估；
 * 后端给出真实起止时间后改用真实值。
 */
export const windowLength: Record<QuotaWindowKind, number> = {
  '5h': 5 * TIME.HOUR,
  '7d': 7 * TIME.DAY,
  '7d_model': 7 * TIME.DAY,
  month_usd: 30 * TIME.DAY,
  points: 30 * TIME.DAY,
  period_usd: 7 * TIME.DAY,
};

export interface RouteInfo {
  route: Route;
  model: string;
  family: string;
  channel: string;
  poolId: string;
  host: string;
  /** null = 渠道在库里查不到，计费方式未知（不猜成套餐内）。 */
  billing: BillingKind | null;
  channelEnabled: boolean;
  /** 模型已下架。 */
  retired: boolean;
}

export function routeInfo(routing: Routing, routeId: string): RouteInfo | undefined {
  const route = routing.routes.find((r) => r.id === routeId);
  if (!route) return undefined;
  const model = routing.models.find((m) => m.id === route.modelId);
  const channel = routing.channels.find((c) => c.id === route.channelId);
  return {
    route,
    model: model?.displayName ?? '未知模型',
    family: model?.family ?? '',
    channel: channel?.name ?? route.channelId,
    poolId: route.poolId,
    host: hostLabel[route.hostId],
    billing: channel?.billing ?? null,
    channelEnabled: channel?.enabled ?? false,
    retired: Boolean(model?.retiredAt),
  };
}

/**
 * 这条路由能不能用在这个阶段；能就返回 null，不能就返回白话原因。
 * 和后端的 routeProblem 同一套判据：先过写死的硬禁令（shared/bans.ts），再过库里的禁令，再看下架。
 */
export function routeProblem(
  routing: Routing,
  routeId: string,
  stage: StageKind | undefined,
  now: number,
): string | null {
  const route = routing.routes.find((r) => r.id === routeId);
  if (!route) return `路由 ${routeId} 不存在`;
  const model = routing.models.find((m) => m.id === route.modelId);
  if (!model) return `路由 ${routeId} 用的模型 ${route.modelId} 不在模型目录里`;
  const hard = hardBanFor(model, stage);
  if (hard) return `禁令：${hard.reason}`;
  const ban = routing.bans.find((b) => {
    if (b.family === undefined && b.modelId === undefined) return false;
    if (b.family !== undefined && b.family.toLowerCase() !== model.family.toLowerCase()) return false;
    if (b.modelId !== undefined && b.modelId !== model.id) return false;
    if (b.stage !== undefined && b.stage !== stage) return false;
    return true;
  });
  if (ban) return `禁令：${ban.reason}`;
  if (model.retiredAt && Date.parse(model.retiredAt) <= now) return '模型已下架';
  return null;
}

/** 账号池的名字：契约里账号池只有编号，显示成「渠道 · 编号」。 */
export function poolTitle(pool: Pick<PoolView, 'id' | 'channelName'>): string {
  return `${pool.channelName} · ${pool.id}`;
}

export function utilOf(w: QuotaWindowView): number {
  if (w.utilization !== undefined) return w.utilization;
  if (w.used !== undefined && w.limit) return w.used / w.limit;
  return 0;
}

/** 用得最满的那个窗。 */
export function tightestWindow(windows: QuotaWindowView[]): QuotaWindowView | undefined {
  let best: QuotaWindowView | undefined;
  for (const w of windows) if (!best || utilOf(w) > utilOf(best)) best = w;
  return best;
}

/** 快清零、还剩不少——该先用它。 */
export function isUseItOrLoseIt(w: QuotaWindowView, now: number): boolean {
  if (!w.resetsAt) return false;
  const left = Date.parse(w.resetsAt) - now;
  if (left <= 0) return false;
  return left < windowLength[w.window] * 0.2 && utilOf(w) < 0.7;
}

export function isNearlyExhausted(w: QuotaWindowView): boolean {
  return utilOf(w) >= 0.9;
}
