// 任务工作流的动手会话那一段：选路 → 起会话 → 没跑成按失败分流（原路重试 / 换路由 / 换模型 / 挂起）。
//
// 改这里之前必须知道：
// - 动手会话只试一次（activity-options.ts 的 segment 档）：基础设施的失败由这里按失败分流重试、换路由、挂起，不靠 Temporal 自动再起一遍。
// - 切号停下的动手会话（码 org_switch，#59）不算失败：失败分流 OS1 马上接着干、不记账、不看上一次的原文（不会凑成「同因连挂」）；
//   选路照常选到切过去的那个池，同一棵树、同一个分支重跑这一段，提示词带上被停下的原因（interrupted）。
// - 别在这里加判断条件：判断经 rt.classify（judgeRetrying），结果进历史。

import { isCancellation } from '@temporalio/workflow';
import type { PickRouteResult, RouteChoice, Worktree } from '../ports.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import type { TierDecision } from '../runner/tier.ts';
import {
  ORG_SWITCH_CODE,
  ROUTE_RETRY_SECONDS,
  SEGMENT_MINUTES,
  SEGMENT_STAGE,
  type SegmentEvidence,
} from '../task-contract.ts';
import { failureOf } from './kit.ts';
import type { TaskRuntime } from './task-runtime.ts';
import { Abandoned, type Avoid, bump, NO_AVOID, widen, ZERO } from './task-support.ts';

/**
 * 动手会话：选路 → 起 → 没跑成按失败分流（原路重试 / 换路由 / 换模型 / 挂起）。会话只试一次，换谁由这里定。
 * 回的时候会话是跑成了的（进程正常结束、终帧没报错）；有没有交付由调用方接着查。
 */
export async function writeSession(
  rt: TaskRuntime,
  brief: TaskBrief,
  tier: TierDecision,
  wt: Worktree,
): Promise<void> {
  let counters = ZERO;
  let avoid: Avoid = NO_AVOID;
  let previousMessage: string | undefined;
  let stick: string | undefined;
  // 这一段上一次被切号停下了（#59）：重跑时告诉新会话树里留着上一次的东西；一直带到这一段跑成（树里的东西一直在）
  let interrupted: string | undefined;
  for (;;) {
    rt.guard();
    const route = await pickRoute(rt, avoid, stick);
    rt.families.add(route.family);
    rt.attemptSeq += 1;
    rt.set('implement', `第 ${rt.round} 轮：${route.modelId} 动手`);
    let evidence: SegmentEvidence | null = null;
    let infra: unknown = null;
    try {
      const res = await rt.cancellable(() =>
        rt.acts.runSegment({
          schemaVersion: 1,
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          issueNumber: rt.input.issueNumber,
          route,
          worktreePath: wt.path,
          branch: rt.branch,
          baseSha: rt.since,
          brief,
          tier,
          feedback: rt.feedback,
          timeoutMinutes: SEGMENT_MINUTES,
          ...(interrupted ? { interrupted } : {}),
          // 只记账（runs.pr_number，#216）：第一轮会话交付之后才开 PR，这时还没有
          ...(rt.prNumber !== null ? { prNumber: rt.prNumber } : {}),
        }),
      );
      if (res.ok) return;
      evidence = res.evidence;
    } catch (error) {
      if (error instanceof Abandoned || isCancellation(error)) throw error;
      infra = error;
    }
    const failure = infra
      ? failureOf(infra, 'session:execute')
      : {
          source: 'session:execute',
          code: evidence?.code ?? 'failed',
          message: evidence?.message ?? '会话没跑成',
          retryable: null,
        };
    // 切号停下的（失败分流 OS1：不算失败、不记账、马上接着干）：选路照常选到切过去的那个池，在原分支上重跑这一段
    if (failure.code === ORG_SWITCH_CODE) interrupted = failure.message;
    const next = await rt.classify(failure, counters, true, {
      stage: SEGMENT_STAGE.manual,
      route: {
        routeId: route.routeId,
        poolId: route.poolId,
        modelId: route.modelId,
        hostId: route.hostId,
        ...(route.orgKind ? { orgKind: route.orgKind } : {}),
      },
      ...(evidence?.resetsAt ? { resetsAt: evidence.resetsAt } : {}),
      ...(evidence?.httpStatus !== undefined ? { httpStatus: evidence.httpStatus } : {}),
      ...(evidence?.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
      previousMessage,
    });
    // 切号停下的不是这一段的失败：不当「上一次的原文」——既不凑成「和上一次一字不差」，也不打断切号前后两次真失败的比对
    if (failure.code !== ORG_SWITCH_CODE) previousMessage = failure.message;
    rt.status.lastProblem = next.reason;
    counters = bump(counters, next);
    if (next.action === 'retry') {
      // 原路再试：还是这条路由（额度要等的，等到清零再来，不算墙钟）
      stick = route.routeId;
      await rt.pause(next.wait === 'quota' ? 'quota' : 'retry', next.reason, next.delaySeconds);
    } else if (next.action === 'swapRoute' || next.action === 'swapModel') {
      stick = undefined;
      avoid = widen(avoid, route, next.avoid ?? (next.action === 'swapModel' ? 'model' : 'route'));
    } else {
      await rt.park(next.humanFix ? `${next.reason}；要人：${next.humanFix}` : next.reason, failure.message);
      counters = ZERO;
      avoid = NO_AVOID;
      stick = undefined;
      previousMessage = undefined;
    }
  }
}

/**
 * 选路：排队（没空位、额度没读成）就隔一会儿再选；一条能用的都没有就停下等人。派得出就当场给动手这一段预占池的名额（#757），
 * 交回的路由带着它进 runSegment：开跑时换成开跑那一行，没开跑就收场的由 runSegment 放掉。
 */
async function pickRoute(rt: TaskRuntime, avoid: Avoid, stick?: string): Promise<RouteChoice> {
  for (;;) {
    rt.guard();
    const got: PickRouteResult = await rt.step('pickRoute', () =>
      rt.acts.pickRoute({
        taskId: rt.input.taskId,
        stage: SEGMENT_STAGE.manual,
        avoidRouteIds: avoid.routeIds,
        avoidPoolIds: avoid.poolIds,
        avoidModelIds: avoid.modelIds,
        ...(stick ? { stickRouteId: stick } : {}),
        reserve: { segment: 'manual' },
      }),
    );
    if (got.ok) return got.route;
    if (got.waitFor === 'none') {
      await rt.park('没有可用的路由', got.detail);
      avoid = NO_AVOID;
      continue;
    }
    await rt.pause(got.waitFor, got.detail, got.retryAfterSeconds ?? ROUTE_RETRY_SECONDS);
  }
}
