// 任务工作流的动手会话那一段：选路 → 起会话 → 没跑成按失败分流（原路重试 / 换路由 / 换模型 / 挂起）。
//
// 改这里之前必须知道：
// - 动手会话只试一次（activity-options.ts 的 segment 档）：基础设施的失败由这里按失败分流重试、换路由、挂起，不靠 Temporal 自动再起一遍。
// - 切号停下的动手会话（码 org_switch，#59）不算失败：失败分流 OS1 马上接着干、不记账、不看上一次的原文（不会凑成「同因连挂」）；
//   选路照常选到切过去的那个池，同一棵树、同一个分支重跑这一段，提示词带上被停下的原因（interrupted）。
// - 别在这里加判断条件：判断经 rt.classify（judgeRetrying），结果进历史。
// - 会话跑完却没有提交（#1408，patched('avoid-empty-commit-route')）：避让记在这张单的运行时上，下一轮选路带上。
//   滤光了候选就不再避开，点名原来的路由再选一次；还派不出就照旧用它，不死等。老历史没有这个标记，选路参数和原来一样。

import { isCancellation, patched } from '@temporalio/workflow';
import type { FailedChannel, PickRouteResult, RouteChoice, Worktree } from '../ports.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import type { TierDecision } from '../runner/tier.ts';
import {
  ORG_SWITCH_CODE,
  ROUTE_RETRY_SECONDS,
  SEGMENT_MINUTES,
  SEGMENT_STAGE,
  type SegmentEvidence,
  UI_PURPOSE,
} from '../task-contract.ts';
import { judgeImplementUiWork, UI_UNRECOGNIZED_NOTE, type UiJudgement } from '../ui-work.ts';
import { failureOf } from './kit.ts';
import type { TaskRuntime } from './task-runtime.ts';
import {
  Abandoned,
  type Avoid,
  bump,
  mergeAvoid,
  NO_AVOID,
  NO_OTHER_ROUTE,
  PausedInterrupt,
  RepinInterrupt,
  widen,
  ZERO,
} from './task-support.ts';

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
  // 上一次渠道运行中失败、该换渠道（#1118）：交给下一次选路标成不可用并记顺到谁；选路问过一次就清掉
  let failedChannel: FailedChannel | undefined;
  // 动手前判这张单是不是界面活（#1264）：界面活按 ui 用途选路并带 uiWork，GPT 不派；判不出按界面活处理。
  // 判法是纯代码、不起活动；老历史（没有这个标记）重放照旧按 execute 选。
  const ui: UiJudgement | undefined = patched('ui-work-implement')
    ? judgeImplementUiWork({ touches: brief.touches, request: brief.request, changedFiles: rt.changedFiles })
    : undefined;
  const unrecognized = ui !== undefined && !ui.recognized ? `（${UI_UNRECOGNIZED_NOTE}）` : '';
  if (unrecognized) rt.set('implement', `动手第 ${rt.round} 轮${unrecognized}`);
  for (;;) {
    await rt.checkpoint(); // 被人暂停了就停在这儿，不起新会话（#820 片 3）
    const route = await pickRoute(rt, avoid, stick, failedChannel, ui?.uiWork === true);
    failedChannel = undefined;
    if (rt.fellBackToMissRoute) {
      rt.fellBackToMissRoute = false;
      const note = `${NO_OTHER_ROUTE}，这一轮仍用路由 ${route.routeId}。`;
      if (!rt.feedback.some((line) => line.includes(NO_OTHER_ROUTE))) rt.feedback = [...rt.feedback, note];
    }
    rt.families.add(route.family);
    rt.attemptSeq += 1;
    await rt.advance('implement', `第 ${rt.round} 轮：${route.modelId} 动手${unrecognized}`);
    let evidence: SegmentEvidence | null = null;
    let infra: unknown = null;
    try {
      // pausable：hard 暂停（#820 片 3）能把这一段取消掉；取消后回到循环头，停在检查点等「继续」，继续了在原树原分支上重跑
      const res = await rt.cancellable(
        () =>
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
        { pausable: true },
      );
      if (res.ok) {
        rt.lastImplementRoute = route;
        return;
      }
      evidence = res.evidence;
    } catch (error) {
      if (error instanceof Abandoned || isCancellation(error)) throw error;
      if (error instanceof PausedInterrupt) {
        // 被人暂停停下的这一段（借 org_switch 的位置，task-contract.ts 的 PAUSED_BY_HUMAN）：不算失败、不记账、不换模型；
        // 回到循环头停在检查点，继续后在原分支原树上重跑，提示词带上被停下的原因
        interrupted = rt.pauseNote(error.command);
        continue;
      }
      if (error instanceof RepinInterrupt) {
        // 被「现在就换」停下的这一段（#1216，也借 org_switch 的位置）：不算失败、不记账；不停下等人，直接回循环头重新选路——
        // 选路现读驾驶舱写好的指定，新模型原分支原树重跑，提示词带上被停下的原因。人明说要换，不粘上一条路由、
        // 也不带着之前失败攒下的避开（避开里要是有他指定的那个模型，选路就派不出了）
        interrupted = rt.repinNote(error.command);
        stick = undefined;
        avoid = NO_AVOID;
        continue;
      }
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
        ...(route.channelId ? { channelId: route.channelId } : {}),
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
      // 渠道运行中失败换渠道（#1118）：新渠道有自己的一轮原路重试，不带上旧渠道用掉的次数和原文；换渠道的次数照记（有上限，不死循环）
      if (next.failChannel && route.channelId) {
        failedChannel = {
          channelId: route.channelId,
          routeId: route.routeId,
          modelId: route.modelId,
          reason: `${next.reason}（上游原文：${failure.message.slice(0, 300)}）`,
        };
        counters = { ...counters, retries: 0 };
        previousMessage = undefined;
      }
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
async function pickRoute(
  rt: TaskRuntime,
  avoid: Avoid,
  stick?: string,
  failedChannel?: FailedChannel,
  uiWork = false,
): Promise<RouteChoice> {
  // 老历史重放时这一支为假：选路参数和原来一样，不多选一次。
  const avoidEmpty = patched('avoid-empty-commit-route');
  let prefer: string | undefined;
  let droppedDry = false;
  for (;;) {
    await rt.checkpoint();
    // 叫醒的记号要在问选路之前取（#194 方案 4.3）：问的这一下读的是切号完成之前的事实，期间到的叫醒要让下面的等待当场醒
    const mark = rt.routeWakeMark();
    // 原路重试（stick）和「没有别的路由」的再选一次，都不再叠没提交的避让：否则刚派回去的那条又被滤掉。
    const useDry = avoidEmpty && !droppedDry && !stick && prefer === undefined;
    const dry = useDry ? rt.commitAvoid : NO_AVOID;
    const merged = useDry ? mergeAvoid(avoid, dry) : avoid;
    const got: PickRouteResult = await rt.step('pickRoute', () =>
      rt.acts.pickRoute({
        taskId: rt.input.taskId,
        // 界面活按 ui 用途的模型顺序选，并带 uiWork：硬禁令 gpt-no-ui 按 UI 判，GPT 一条都不派（别的家都派不出就回「等」）
        stage: uiWork ? UI_PURPOSE : SEGMENT_STAGE.manual,
        ...(uiWork ? { uiWork: true } : {}),
        avoidRouteIds: merged.routeIds,
        avoidPoolIds: merged.poolIds,
        avoidModelIds: merged.modelIds,
        ...(stick ? { stickRouteId: stick } : {}),
        ...(prefer ? { preferRouteId: prefer } : {}),
        ...(failedChannel ? { failedChannel } : {}),
        reserve: { segment: 'manual' },
      }),
    );
    if (got.ok) return got.route;
    if (got.waitFor === 'none') {
      const blocked = dry.routeIds.length + dry.poolIds.length + dry.modelIds.length > 0;
      if (useDry && blocked && rt.commitMissRoute) {
        droppedDry = true;
        prefer = rt.commitMissRoute.routeId;
        rt.status.lastProblem = NO_OTHER_ROUTE;
        rt.fellBackToMissRoute = true;
        continue;
      }
      if (droppedDry && rt.commitMissRoute) {
        rt.status.lastProblem = NO_OTHER_ROUTE;
        rt.fellBackToMissRoute = true;
        return rt.commitMissRoute;
      }
      await rt.park('没有可用的路由', got.detail);
      avoid = NO_AVOID;
      prefer = undefined;
      droppedDry = false;
      continue;
    }
    // 避让放空之后还是要等（额度、空位）：不死等，照旧用原来的路由。
    if (droppedDry && rt.commitMissRoute) {
      rt.status.lastProblem = NO_OTHER_ROUTE;
      rt.fellBackToMissRoute = true;
      return rt.commitMissRoute;
    }
    // 睡到下一次选路，但路由那边变了（切号切完、切过去的池探通了）会被叫醒当场再选；信号丢了照样按这个时长醒
    await rt.pauseForRoute(got.waitFor, got.detail, got.retryAfterSeconds ?? ROUTE_RETRY_SECONDS, mark);
  }
}
