// 路由、模型、账号池、额度窗的查询与白话名。各页都从这里拿名字，不各拼各的。

import { hardBanFor, windowAppliesTo } from '@fleet-dao/shared';
import { brand } from '#brand';
import type {
  BillingKind,
  HostId,
  Model,
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
  { id: 'judge', label: '判断', hint: `${brand.terms.judgeQuiz}：选择题 + 把握度` },
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
  mirasim: brand.terms.relay,
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
  other: '其他窗口',
};

/**
 * 各时间窗的长度，用来判断「快清零」。契约里的额度窗没带窗口起点，先按种类估；
 * 后端给出真实起止时间后改用真实值。other（上游新出的、还归不了类的窗）长度不知道：不据此喊「先用它」。
 */
export const windowLength: Record<QuotaWindowKind, number | undefined> = {
  '5h': 5 * TIME.HOUR,
  '7d': 7 * TIME.DAY,
  '7d_model': 7 * TIME.DAY,
  month_usd: 30 * TIME.DAY,
  points: 30 * TIME.DAY,
  period_usd: 7 * TIME.DAY,
  other: undefined,
};

/** 额度页矩阵的列序。写成全量映射：契约里加了新的窗口种类而这里没写，tsc 当场报错，不会悄悄少一列。 */
export const windowRank: Record<QuotaWindowKind, number> = {
  '5h': 0,
  '7d': 1,
  '7d_model': 2,
  month_usd: 3,
  period_usd: 4,
  points: 5,
  other: 6,
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

/**
 * 用了几成（0–1）。没读到就是 undefined：上游只报了清零时间、或只有已用没有上限（估算读法没配上限）时都会这样。
 * 不拿 0 冒充——0% 会被当成「最空的池」，把人引向其实可能快满的池。
 */
export function utilOf(w: QuotaWindowView): number | undefined {
  if (w.utilization !== undefined) return w.utilization;
  if (w.used !== undefined && w.limit) return w.used / w.limit;
  return undefined;
}

/** 额度窗的名字：归得了类的用中文名，归不了类（other）的用上游原名；只扣一组模型的窗后面写组名。 */
export function windowTitle(w: Pick<QuotaWindowView, 'window' | 'label' | 'scope'>): string {
  const base = w.window === 'other' ? w.label : windowLabel[w.window];
  return w.scope ? `${base} · ${w.scope}` : base;
}

/**
 * 上游自己说这个窗已用满（limit_reached）。以上游为准：Claude 撞到限额时只报「这个窗满了」、不给比例，
 * 实测 99% 也可能已经满了。上游这次没报的窗（staleSince）不算。
 */
export function isUpstreamFull(w: QuotaWindowView): boolean {
  return !w.staleSince && w.upstreamStatus === 'limit_reached';
}

/**
 * 一个池的额度概况，按紧的程度分四堆：上游说已用满的（最紧，排最前面）、读到用量的里用得最满的那个、
 * 用量没读到的、上游这次没报的。后两堆不参与比较，但要让人看见。
 */
export interface PoolUsage {
  full: QuotaWindowView[];
  tightest: { w: QuotaWindowView; util: number } | undefined;
  unknown: QuotaWindowView[];
  /** 读成过、但上游这次没再报的窗（staleSince）：照样显示，不参与比较。 */
  unreported: QuotaWindowView[];
}

export function poolUsage(windows: QuotaWindowView[]): PoolUsage {
  const full: QuotaWindowView[] = [];
  let tightest: PoolUsage['tightest'];
  const unknown: QuotaWindowView[] = [];
  const unreported: QuotaWindowView[] = [];
  for (const w of windows) {
    const util = utilOf(w);
    if (w.staleSince) unreported.push(w);
    else if (isUpstreamFull(w)) full.push(w);
    else if (util === undefined) unknown.push(w);
    else if (!tightest || util > tightest.util) tightest = { w, util };
  }
  return { full, tightest, unknown, unreported };
}

/**
 * 一个池的额度说成一句话。调度台、换模型对话框、渠道页都用这一句，不各说各的：
 * 从没读成过 → 额度没查成；有窗已用满 → 已用满（哪怕别的窗才用了一半）；其次才是最满的窗用了几成。
 */
export type QuotaHeadline =
  | { kind: 'unread' }
  | { kind: 'full'; w: QuotaWindowView; util: number | undefined }
  | { kind: 'util'; w: QuotaWindowView; util: number }
  | { kind: 'unknown'; w: QuotaWindowView }
  | { kind: 'unreported'; w: QuotaWindowView }
  | { kind: 'empty' }
  /** 按路由看时：池里有窗，但都是只扣别的模型组的（routeQuotaHeadline）。 */
  | { kind: 'unscoped' };

/** pool 为 undefined 表示额度表里查不到这个池，和「一次都没读成过」一样说「额度没查成」。 */
export function quotaHeadline(pool: Pick<PoolView, 'quotaStatus' | 'windows'> | undefined): QuotaHeadline {
  if (!pool || pool.quotaStatus === 'unread') return { kind: 'unread' };
  const u = poolUsage(pool.windows);
  const [full] = u.full;
  if (full) return { kind: 'full', w: full, util: utilOf(full) };
  if (u.tightest) return { kind: 'util', ...u.tightest };
  const [unknown] = u.unknown;
  if (unknown) return { kind: 'unknown', w: unknown };
  const [unreported] = u.unreported;
  if (unreported) return { kind: 'unreported', w: unreported };
  return { kind: 'empty' };
}

/**
 * 一条路由的额度概况：只算扣它的窗。账号级窗都扣；只扣一组模型的窗按 shared 的 windowAppliesTo 判
 * （和读额度、选路由同一套判法）——只有 fable 组满了时，同池的 Kimi 不算满。
 * 驾驶舱拿不到池的组成员表，按组名和模型名比；模型在目录里查不到时整池一起算（宁可说紧，不说松）。
 */
export function routeQuotaHeadline(
  pool: Pick<PoolView, 'quotaStatus' | 'windows'> | undefined,
  model: Pick<Model, 'id' | 'family'> | undefined,
): QuotaHeadline {
  if (!pool || !model) return quotaHeadline(pool);
  const windows = pool.windows.filter(
    (w) =>
      windowAppliesTo(w.scope ? { scope: w.scope } : {}, { id: model.id, family: model.family }) !== 'no',
  );
  if (pool.quotaStatus !== 'unread' && pool.windows.length && !windows.length) return { kind: 'unscoped' };
  return quotaHeadline({ ...pool, windows });
}

export function headlineText(h: QuotaHeadline): string {
  switch (h.kind) {
    case 'unread':
      return '额度没查成';
    case 'full':
      // 只扣一组模型的窗满了，写明是哪一组满了，别让人以为整个池都用不了。
      return h.w.scope ? `${h.w.scope} 组已用满` : '已用满';
    case 'unscoped':
      return '没有扣它的窗';
    case 'util':
      return formatUtil(h.util);
    case 'unknown':
      return '用量没读到';
    case 'unreported':
      return '上游这次没报';
    case 'empty':
      return '上游没报额度窗';
  }
}

/** 这句话用什么颜色：已用满红；没查成、没读到、没报黄；读到的数字照常。 */
export function headlineInk(h: QuotaHeadline): string {
  switch (h.kind) {
    case 'full':
      return 'text-ink-fail';
    case 'util':
    case 'unscoped':
      return '';
    default:
      return 'text-ink-stall';
  }
}

/** 额度条要画多满：已用满画满；读到的照实；其余不知道（画虚线空槽）。 */
export function headlineBar(h: QuotaHeadline): number | undefined {
  if (h.kind === 'full') return h.util ?? 1;
  if (h.kind === 'util') return h.util;
  return undefined;
}

/** 快清零、还剩不少——该先用它。用量没读到、窗口长度不知道、上游这次没报、上游说已用满的都不算。 */
export function isUseItOrLoseIt(w: QuotaWindowView, now: number): boolean {
  const util = utilOf(w);
  const length = windowLength[w.window];
  if (util === undefined || length === undefined || !w.resetsAt) return false;
  if (w.staleSince || w.upstreamStatus === 'limit_reached') return false;
  const left = Date.parse(w.resetsAt) - now;
  if (left <= 0) return false;
  return left < length * 0.2 && util < 0.7;
}

/** 快用完：上游自己说用满了（以它为准，实测 99% 就可能已经满了），或者用了九成以上。上游这次没报的不算。 */
export function isNearlyExhausted(w: QuotaWindowView): boolean {
  if (w.staleSince) return false;
  if (isUpstreamFull(w)) return true;
  const util = utilOf(w);
  return util !== undefined && util >= 0.9;
}

/** 上游自己说的状态，白话；没说就是 undefined。 */
export const upstreamStatusLabel: Record<NonNullable<QuotaWindowView['upstreamStatus']>, string> = {
  allowed: '上游说还能用',
  warning: '上游提醒快满了',
  limit_reached: '上游说已用满',
};

/** 百分比；没读到写「用量没读到」。 */
export function formatUtil(util: number | undefined): string {
  return util === undefined ? '用量没读到' : `${Math.round(util * 100)}%`;
}
