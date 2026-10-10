// 账号池「额度读不到、凭据过期」这类要人动手的毛病，在路由页、渠道状态页、额度页怎么说（#1748）。
// 来源只有一处：引擎额度读取任务写的没处理提醒（去重键 quota-read:<池>，读不到；reconcile:quota:<池>，读数过期）。
// 页面不再各自猜「人把开关关了」：有提醒就把原因和要人做什么写在池旁边，读新了提醒自己撤、这里跟着消失。
// 改这里之前必须知道：
// - 只认没处理的（resolvedAt 为空）；提醒列表没读成时调用方照实写「没读成」，不拿「没有毛病」顶。
// - 原因取自提醒正文里引擎写的「<错误码>——<原话>」，认不出就用整段正文，不编；要人做什么按错误码和原话分，认不出的写「看提醒」。

import type { Notification } from '../api/types';

export const QUOTA_READ_PREFIX = 'quota-read:';
export const QUOTA_STALE_PREFIX = 'reconcile:quota:';
/** 额度读取的整份配置提醒不属于哪个池。 */
const QUOTA_CONFIG_KEY = 'quota-read:config';

export type PoolProblemKind = 'unreadable' | 'stale';

export interface PoolProblem {
  poolId: string;
  /** unreadable = 这一轮额度没读成（凭据、配置、上游）；stale = 读数超过 30 分钟没更新。读不到比过期更根本，两者都有时记 unreadable。 */
  kind: PoolProblemKind;
  /** 引擎给的错误码（auth、no_credentials……）；读数过期那条没有。 */
  code?: string;
  /** 为什么：引擎的原话。 */
  reason: string;
  /** 要人做什么。 */
  action: string;
  /** 提醒是什么时候报的。 */
  since: string;
}

const READ_FAIL = /没读成：([a-z_]+)——([\s\S]+?)。(?:这种要人动手|上次读成|库里从没|连着|旧读数)/;

/** 要人做什么：按错误码，再按原话里点名的登录命令。 */
export function actionOf(code: string | undefined, reason: string): string {
  const login = /grok login/.test(reason)
    ? 'grok login'
    : /cursor-agent login/.test(reason)
      ? 'cursor-agent login'
      : null;
  if (code === 'auth' || code === 'no_credentials') {
    if (/grok/i.test(reason)) return '在引擎所在的机器（法国）以会话用户重新 grok login';
    if (login) return `在引擎所在的机器（法国）以会话用户重新 ${login}`;
    return '重新登录这个账号，或换一份凭据';
  }
  if (code === 'config') return '改额度配置里这个池的写法';
  if (code === 'read_cost') return '查为什么读额度花了钱，读数不采信';
  if (code === 'bad_response') return '查上游是不是改了接口，读取器要跟着改';
  if (code === 'unreachable' || code === 'timeout' || code === 'upstream')
    return '先看网络和上游是否正常，连着几轮没读成再查读取器';
  return '看提醒里的原话再定';
}

function reasonOfBody(body: string): { code?: string; reason: string } {
  const m = READ_FAIL.exec(body);
  if (m?.[1] && m[2]) return { code: m[1], reason: m[2].trim() };
  return { reason: body.trim() || '提醒没写原因' };
}

/** 没处理的提醒 → 每个池一条毛病。 */
export function poolProblemsOf(items: readonly Notification[] | undefined): Map<string, PoolProblem> {
  const out = new Map<string, PoolProblem>();
  for (const n of items ?? []) {
    if (n.resolvedAt || !n.dedupeKey || n.dedupeKey === QUOTA_CONFIG_KEY) continue;
    let poolId: string;
    let problem: PoolProblem;
    if (n.dedupeKey.startsWith(QUOTA_READ_PREFIX)) {
      poolId = n.dedupeKey.slice(QUOTA_READ_PREFIX.length);
      const { code, reason } = reasonOfBody(n.body);
      problem = {
        poolId,
        kind: 'unreadable',
        ...(code ? { code } : {}),
        reason,
        action: actionOf(code, reason),
        since: n.createdAt,
      };
    } else if (n.dedupeKey.startsWith(QUOTA_STALE_PREFIX)) {
      poolId = n.dedupeKey.slice(QUOTA_STALE_PREFIX.length);
      problem = {
        poolId,
        kind: 'stale',
        reason: '额度读数超过 30 分钟没更新，调度不把它当「还够」',
        action: '看引擎的额度读取任务有没有在跑、这个池最近一次为什么没读成',
        since: n.createdAt,
      };
    } else continue;
    if (!poolId) continue;
    const have = out.get(poolId);
    if (!have || (have.kind === 'stale' && problem.kind === 'unreadable')) out.set(poolId, problem);
  }
  return out;
}

/** 一行话：「额度读不到：<原因>。要人做：<做什么>」。 */
export function problemLine(p: PoolProblem): string {
  const head = p.kind === 'unreadable' ? '额度读不到' : '额度读数过期';
  return `${head}：${p.reason}。要人做：${p.action}`;
}
