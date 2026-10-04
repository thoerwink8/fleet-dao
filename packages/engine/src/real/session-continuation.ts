// 续会话的两个决定：续的方式（resume / fork / 接力，decideContinuation）和续会话等第一帧放宽多久（resumeStartupMs）。
// 都是纯函数、不碰库和进程；从 sessions.ts 拆出来，函数体原样，sessions.ts 原样重新导出。

import type { SessionUser } from '@fleet-dao/adapters';
import type { SessionRunState } from '@fleet-dao/db';
import { hostName } from '../routing/names.ts';
import type { ContinueMode, HostDriver } from './hosts.ts';
import {
  RESUME_STARTUP_MAX_MS,
  RESUME_STARTUP_RUN_MS_PER_MINUTE,
  RESUME_STARTUP_TOKENS_PER_MINUTE,
  STARTUP_BASE_MS,
} from './session-codes.ts';
import { asSessionUser } from './session-util.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 续会话（resume、fork）等第一帧的时限，按会话已有的长度放宽：执行体要先把整段过程记录读进来才吐第一帧，会话越长读得越久。
 * 2026-09-28 02:01:47 #276 的 Grok 会话跑了 55 分钟，续的时候 3 分钟没第一帧（startup_timeout），退回去续了规划那一步的会话，
 * 55 分钟的上下文丢了。新开、接力的会话不读过程记录，照插头默认（undefined）。
 */
export function resumeStartupMs(
  mode: ContinueMode,
  prior: Pick<SessionRunState, 'contextTokens' | 'startedAt' | 'endedAt'> | null,
): number | undefined {
  if ((mode !== 'resume' && mode !== 'fork') || !prior) return undefined;
  let extraMinutes: number;
  if (prior.contextTokens !== null && prior.contextTokens > 0) {
    extraMinutes = Math.ceil(prior.contextTokens / RESUME_STARTUP_TOKENS_PER_MINUTE);
  } else if (prior.startedAt && prior.endedAt) {
    extraMinutes = Math.ceil(
      (prior.endedAt.getTime() - prior.startedAt.getTime()) / RESUME_STARTUP_RUN_MS_PER_MINUTE,
    );
  } else {
    // 多长都不知道：按放宽的一半给，不拿默认的 3 分钟赌
    return Math.round((STARTUP_BASE_MS + RESUME_STARTUP_MAX_MS) / 2);
  }
  return Math.min(RESUME_STARTUP_MAX_MS, STARTUP_BASE_MS + Math.max(0, extraMinutes) * 60_000);
}

export interface ContinuationFacts {
  /** 工作流要接着的会话号（可能是 cursor 的临时号）。 */
  resumeId: string;
  /**
   * 这个号最近一轮的记录（latestRunOfSession）；查不到 = null。
   * outcome、failureCode 不给就当上一轮没失败（调方在 #489 之前不带这两项时照旧同池 resume）。
   */
  prior:
    | (Pick<SessionRunState, 'runAsUser' | 'routeId' | 'worktreePath' | 'contextTokens'> &
        Partial<Pick<SessionRunState, 'outcome' | 'failureCode'>>)
    | null;
  /** 上一轮的路由现在的样子（routeLaunchFacts）；查不到 = null。 */
  before: { hostId: string; poolId: string } | null;
  /** 这次的路由。 */
  route: { poolId: string };
  driver: Pick<HostDriver, 'hostId' | 'canFork'>;
  user: SessionUser;
  /** 这次会话的工作目录。 */
  dir: string;
  forkMax: number;
}

/**
 * 续上一个会话的方式：同池、同会话用户、同执行方式、同一个目录、真号 → --resume；只换了池、执行方式能 fork、上一轮上下文还小
 * → fork；别的一律接力（开新会话带接力任务书），why 写清为什么续不上。先后就是判断的先后，每个分支都有测试。
 * 不硬续的理由：会话记录存在会话用户家里、按工作目录分（Claude 的 ~/.claude/projects/<目录>、cursor 的 ~/.cursor/chats/<目录的哈希>），
 * 换了用户、目录、执行方式都找不到；cursor 的临时号不是它的会话号；cursor 没有 fork，切了池原会话续不上。
 * 结构上续得上、却仍改接力的（#489）：这个号上一轮续起来没有第一帧（startup_timeout）——resume 和 fork 都是续这个号，不再连试；
 * 本来要同池 resume、执行方式是 Grok、上一轮判了停滞的：原样 -r 起不来，改开新会话带接力任务书。Claude 判了停滞仍续（失败分流 SL1）。
 */
export function decideContinuation(x: ContinuationFacts): { mode: ContinueMode; why: string } {
  const { resumeId, prior, before } = x;
  const relay = (why: string) => ({ mode: 'relay' as const, why });
  if (!prior) return relay(`上一个会话 ${resumeId} 的记录查不到`);
  if (asSessionUser(prior.runAsUser) !== x.user) {
    return relay(
      `上一个会话 ${resumeId} 跑在 ${prior.runAsUser ?? '没记'} 下，不是现在的会话用户 ${x.user}，续不上`,
    );
  }
  if (!before) {
    return relay(`上一个会话 ${resumeId} 的路由 ${prior.routeId} 已不在，不知道它是哪种执行方式、哪个账号池`);
  }
  if (before.hostId !== x.driver.hostId) {
    return relay(
      `上一个会话 ${resumeId} 是 ${hostName(before.hostId)} 的，这次是 ${hostName(x.driver.hostId)}：换了执行方式，续不上`,
    );
  }
  if (!UUID.test(resumeId)) {
    return relay(`上一个会话的号 ${resumeId} 不是执行体自己的会话号（会话在报出会话号之前就断了），续不上`);
  }
  if (prior.worktreePath !== x.dir) {
    return relay(
      `上一个会话 ${resumeId} 在 ${prior.worktreePath ?? '没记的目录'} 里跑，这次在 ${x.dir}：过程记录按目录存，换了目录续不上`,
    );
  }
  // 不给 failureCode / outcome 就当没失败：#489 之前记下的轮次、调用方没带这两项的，同池照旧 resume（上面各分支的「续不上」理由在先）。
  if (prior.failureCode === 'startup_timeout') {
    return relay(
      `上一个会话 ${resumeId} 续起来没有第一帧（startup_timeout），不再续这个号，开新会话带接力任务书`,
    );
  }
  if (before.poolId === x.route.poolId) {
    if (
      x.driver.hostId === 'grok' &&
      (prior.outcome === 'stalled' || prior.failureCode === 'SESSION_STALLED')
    ) {
      return relay(`上一个会话 ${resumeId} 上一轮判了停滞，原样续起不来，开新会话带接力任务书`);
    }
    return { mode: 'resume', why: '' };
  }
  const moved = `换了账号池（${before.poolId} → ${x.route.poolId}）`;
  if (!x.driver.canFork) return relay(`${moved}，${hostName(x.driver.hostId)} 不能 fork`);
  if (prior.contextTokens !== null && prior.contextTokens < x.forkMax) return { mode: 'fork', why: '' };
  return relay(
    prior.contextTokens === null
      ? `${moved}，上一轮的上下文大小不知道`
      : `${moved}，上一轮的上下文有 ${prior.contextTokens} 个 token，大了不 fork`,
  );
}
