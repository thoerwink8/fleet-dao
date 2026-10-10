// 任务工作流的动手会话那一段：选路 → 起会话 → 没跑成按失败分流（原路重试 / 换路由 / 换模型 / 挂起）。
//
// 改这里之前必须知道：
// - 动手会话只试一次（activity-options.ts 的 segment 档）：基础设施的失败由这里按失败分流重试、换路由、挂起，不靠 Temporal 自动再起一遍。
// - 切号停下的动手会话（码 org_switch，#59）不算失败：失败分流 OS1 马上接着干、不记账、不看上一次的原文（不会凑成「同因连挂」）；
//   选路照常选到切过去的那个池，同一棵树、同一个分支重跑这一段，提示词带上被停下的原因（interrupted）。
// - 别在这里加判断条件：判断经 rt.classify（judgeRetrying），结果进历史。
// - 会话跑完却没有提交（#1408，patched('avoid-empty-commit-route')）：避让记在这张单的运行时上，下一轮选路带上。
//   滤光了候选就不再避开，点名原来的路由再选一次；还派不出就照旧用它，不死等。老历史没有这个标记，选路参数和原来一样。
// - 派之前再探一次选定的那条（#1409，patched('dispatch-probe')）：不通就先放掉这次预占（patched('dispatch-probe-release')，
//   没进起会话，不能占着池），再换下一条，每轮最多探 3 条；都探不通或都被挡就停下，不起会话。
//   没提交避让滤光之后改派原来的那条，也先探再派。老历史没有这个标记，不探、不改选路之后的那一步。

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
  afterDispatchProbe,
  bump,
  dispatchProbeBlockedLine,
  dispatchProbeLine,
  dispatchProbeStopText,
  EMPTY_DISPATCH_PROBE,
  mergeAvoid,
  NO_AVOID,
  NO_OTHER_ROUTE,
  PausedInterrupt,
  RepinInterrupt,
  widen,
  withDispatchProbeNote,
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
    const picked = await pickRoute(rt, avoid, stick, failedChannel, ui?.uiWork === true);
    failedChannel = undefined;
    const route = picked.route;
    if (picked.probeNote) rt.feedback = withDispatchProbeNote(rt.feedback, picked.probeNote);
    if (rt.fellBackToMissRoute) {
      rt.fellBackToMissRoute = false;
      const note = `${NO_OTHER_ROUTE}，这一轮仍用路由 ${route.routeId}。`;
      if (!rt.feedback.some((line) => line.includes(NO_OTHER_ROUTE))) rt.feedback = [...rt.feedback, note];
    }
    rt.families.add(route.family);
    rt.attemptSeq += 1;
    await rt.advance(
      'implement',
      `第 ${rt.round} 轮：${route.modelId} 动手${unrecognized}${picked.probeNote ? `；${picked.probeNote}` : ''}`,
    );
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
          issueNumber: rt.input.issueNumber,
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
 * 派之前再探一次选定的那条（#1409）：不通就先放掉这次预占（没进 runSegment，不能占着池），再换下一条，每轮最多探 3 条；
 * 都探不通、或候选一开始就被挡，就停下等探针恢复，不起会话，并沿用全熔断提醒。
 * 没提交的避让（#1408）和这一轮探不通的避让叠在一起。避让把候选滤光时，点名原来的路由再选；还派不出就用它，但派之前照样探。
 */
async function pickRoute(
  rt: TaskRuntime,
  avoid: Avoid,
  stick?: string,
  failedChannel?: FailedChannel,
  uiWork = false,
): Promise<{ route: RouteChoice; probeNote: string | null }> {
  const stage = uiWork ? UI_PURPOSE : SEGMENT_STAGE.manual;
  // 老历史重放时这一支为假：选路参数和原来一样，不多选一次。要写在派前探测那个标记之前，已有历史里的标记顺序才对得上。
  const avoidEmpty = patched('avoid-empty-commit-route');
  let round = EMPTY_DISPATCH_PROBE;
  let probeAvoid: string[] = [];
  let stickTo = stick;
  let prefer: string | undefined;
  let droppedDry = false;
  let holdForProbe = false;
  let lastStopDetail = '';
  // 这一轮已经记下「全都探不通」。再选到能派的，把上次停下的原因清掉，别留在任务状态里。
  const clearProbeStop = () => {
    if (holdForProbe || rt.status.lastProblem?.startsWith('派前探测：')) rt.status.lastProblem = null;
    holdForProbe = false;
  };
  const stopForProbe = async (blocked: string, wakeMark: number) => {
    // 已经写下每条探不通的结果之后，醒来再选仍派不出：别用空名单把那几条盖掉。
    if (round.fails.length > 0 || lastStopDetail === '') {
      lastStopDetail = dispatchProbeStopText(round, blocked);
      const line =
        round.fails.length > 0 ? dispatchProbeLine(round.fails, null) : dispatchProbeBlockedLine(blocked);
      rt.feedback = withDispatchProbeNote(rt.feedback, line);
      rt.status.lastProblem = lastStopDetail;
      await rt.advance('implement', lastStopDetail);
      await rt.step('raiseAlert', () =>
        rt.acts.raiseAlert({
          taskId: rt.input.taskId,
          level: 'info',
          title: `「${stage}」阶段的路由全都熔断了`,
          detail: lastStopDetail,
          dedupeKey: `routing:all-open:${stage}`,
        }),
      );
    }
    holdForProbe = true;
    round = EMPTY_DISPATCH_PROBE;
    probeAvoid = [];
    stickTo = undefined;
    prefer = undefined;
    droppedDry = false;
    rt.fellBackToMissRoute = false;
    await rt.pauseForRoute('slot', lastStopDetail, ROUTE_RETRY_SECONDS, wakeMark);
  };
  // 选定的这一条：老历史不探，直接派。探通才派；探不通记下来换下一条，到了 3 条就停下。
  const consider = async (
    route: RouteChoice,
    probeOn: boolean,
    wakeMark: number,
  ): Promise<{ route: RouteChoice; probeNote: string | null } | null> => {
    if (!probeOn) return { route, probeNote: null };
    const probe = await rt.step('probeAssignedRoute', () =>
      rt.cancellable(() =>
        rt.acts.probeAssignedRoute({
          schemaVersion: 1,
          routeId: route.routeId,
          label: route.modelId,
        }),
      ),
    );
    if (probe.kind === 'pass') {
      clearProbeStop();
      return { route, probeNote: dispatchProbeLine(round.fails, probe.label) };
    }
    // 探不通不会进 runSegment。预占要在换下一条或停下之前放掉，不然这一段一直占着池。
    // 老历史没有这个标记：当时没放，重放不多调这一步。
    if (patched('dispatch-probe-release')) {
      const reservationId = route.reservationId;
      if (reservationId) {
        await rt.step('releaseReservation', () =>
          rt.acts.releaseReservation({ schemaVersion: 1, reservationId }),
        );
      }
    }
    const decided = afterDispatchProbe(round, {
      label: probe.label,
      detail: probe.detail,
      passed: false,
      counted: probe.counted,
    });
    round = decided.round;
    if (!probeAvoid.includes(route.routeId)) probeAvoid = [...probeAvoid, route.routeId];
    // 这一条刚探不通，别再粘着它，也别再点名它
    stickTo = undefined;
    if (prefer === route.routeId) prefer = undefined;
    if (decided.action === 'stop') await stopForProbe('', wakeMark);
    return null;
  };
  for (;;) {
    await rt.checkpoint();
    // 老历史没有这个标记：不探、不改选路之后的那一步。新跑的第一次记下，后面几次走同一条。
    const probeOn = patched('dispatch-probe');
    // 叫醒的记号要在问选路之前取（#194 方案 4.3）：问的这一下读的是切号完成之前的事实，期间到的叫醒要让下面的等待当场醒
    const mark = rt.routeWakeMark();
    // 原路重试（stick）和「没有别的路由」的再选一次，都不再叠没提交的避让：否则刚派回去的那条又被滤掉。
    const useDry = avoidEmpty && !droppedDry && !stickTo && prefer === undefined;
    const dry = useDry ? rt.commitAvoid : NO_AVOID;
    const merged = useDry ? mergeAvoid(avoid, dry) : avoid;
    const avoidRouteIds = [...merged.routeIds];
    for (const id of probeAvoid) if (!avoidRouteIds.includes(id)) avoidRouteIds.push(id);
    const got: PickRouteResult = await rt.step('pickRoute', () =>
      rt.acts.pickRoute({
        taskId: rt.input.taskId,
        // 界面活按 ui 用途的模型顺序选，并带 uiWork：硬禁令 gpt-no-ui 按 UI 判，GPT 一条都不派（别的家都派不出就回「等」）
        stage,
        ...(uiWork ? { uiWork: true } : {}),
        avoidRouteIds,
        avoidPoolIds: merged.poolIds,
        avoidModelIds: merged.modelIds,
        ...(stickTo ? { stickRouteId: stickTo } : {}),
        ...(prefer ? { preferRouteId: prefer } : {}),
        ...(failedChannel ? { failedChannel } : {}),
        reserve: { segment: 'manual' },
      }),
    );
    if (!got.ok) {
      const miss = rt.commitMissRoute;
      const missUsable = miss !== null && !probeAvoid.includes(miss.routeId) ? miss : null;
      if (got.waitFor === 'none') {
        const blocked = dry.routeIds.length + dry.poolIds.length + dry.modelIds.length > 0;
        if (useDry && blocked && missUsable) {
          droppedDry = true;
          prefer = missUsable.routeId;
          rt.status.lastProblem = NO_OTHER_ROUTE;
          rt.fellBackToMissRoute = true;
          continue;
        }
        // 点名再选仍派不出：照旧用原来的路由。派之前照样探，探不通就不拿它起会话。
        if (droppedDry && missUsable) {
          rt.status.lastProblem = NO_OTHER_ROUTE;
          rt.fellBackToMissRoute = true;
          const chosen = await consider(missUsable, probeOn, mark);
          if (chosen) return chosen;
          continue;
        }
        // 还没探过、候选一开始就被挡，也走同一条停下：写出原因，沿用全熔断提醒，等探针恢复再继续。
        if (probeOn) {
          await stopForProbe(got.detail, mark);
          continue;
        }
        await rt.park('没有可用的路由', got.detail);
        avoid = NO_AVOID;
        prefer = undefined;
        droppedDry = false;
        continue;
      }
      // 避让放空之后还是要等（额度、空位）：不死等，照旧用原来的路由，派之前照样探。
      if (droppedDry && missUsable) {
        rt.status.lastProblem = NO_OTHER_ROUTE;
        rt.fellBackToMissRoute = true;
        const chosen = await consider(missUsable, probeOn, mark);
        if (chosen) return chosen;
        continue;
      }
      if (probeOn && (round.fails.length > 0 || holdForProbe)) {
        await stopForProbe('', mark);
        continue;
      }
      // 睡到下一次选路，但路由那边变了（切号切完、切过去的池探通了）会被叫醒当场再选；信号丢了照样按这个时长醒
      await rt.pauseForRoute(got.waitFor, got.detail, got.retryAfterSeconds ?? ROUTE_RETRY_SECONDS, mark);
      continue;
    }
    const chosen = await consider(got.route, probeOn, mark);
    if (chosen) return chosen;
  }
}
