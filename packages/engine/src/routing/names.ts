// 给人看的名字与白话：阶段、执行方式、额度窗、时长、比例。「为什么派给它」一句话由这些拼成。
import type { HostId, OrgKind, StageKind } from '@fleet-dao/shared';
import type { RouteFacts, RouteWindow } from './types.ts';

export const STAGE_NAMES: Readonly<Record<StageKind, string>> = {
  triage: '分诊',
  spec: '需求文档',
  plan: '规划',
  execute: '写码',
  ui: 'UI',
  review: '审查',
  research: '调研',
  judge: '判断题',
};

export const HOST_NAMES: Readonly<Record<HostId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'cursor-agent': 'Cursor Agent',
  grok: 'Grok 命令行',
  mirasim: 'Mirasim',
  'api-shell': '接口外壳',
};

/** reclaude 组织类型的白话名。 */
export const ORG_NAMES: Readonly<Record<OrgKind, string>> = { solo: '独享', carpool: '拼车' };

export function hostName(hostId: string): string {
  return (HOST_NAMES as Record<string, string>)[hostId] ?? hostId;
}

/** 「独享号 · Opus 5.5 · Claude Code」。 */
export function routeLabel(r: Pick<RouteFacts, 'poolName' | 'modelName' | 'hostId'>): string {
  return `${r.poolName} · ${r.modelName} · ${hostName(r.hostId)}`;
}

/** 「周额度」「claude 周额度」「5 小时额度」「月额度（auto）」。 */
export function windowName(w: Pick<RouteWindow, 'window' | 'scope' | 'label'>): string {
  switch (w.window) {
    case '5h':
      return scoped('5 小时额度', w.scope);
    case '7d':
      return scoped('周额度', w.scope);
    case '7d_model':
      return `${w.scope ?? w.label} 周额度`;
    case 'month_usd':
      return scoped('月额度', w.scope);
    case 'period_usd':
      return scoped('账期额度', w.scope);
    case 'points':
      return scoped('点数额度', w.scope);
    default:
      return `额度窗 ${w.label}`;
  }
}

function scoped(name: string, scope: string | null): string {
  return scope ? `${name}（${scope}）` : name;
}

/** 「20 小时」「2 天 3 小时」「40 分钟」。 */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} 天` : `${days} 天 ${rest} 小时`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** 还剩几成；已用比例算不出来为空。 */
export function remaining(w: Pick<RouteWindow, 'used'>): number | null {
  return w.used === null ? null : Math.max(0, 1 - w.used);
}
