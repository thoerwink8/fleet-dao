// 任务工作流的动手会话那一段：选路 → 起会话 → 没跑成按失败分流（原路重试 / 换路由 / 换模型 / 挂起）。
//
// 改这里之前必须知道：
// - 动手会话只试一次（activity-options.ts 的 segment 档）：基础设施的失败由这里按失败分流重试、换路由、挂起，不靠 Temporal 自动再起一遍。
// - 切号停下的动手会话（码 org_switch，#59）不算失败：失败分流 OS1 马上接着干、不记账、不看上一次的原文（不会凑成「同因连挂」）；
//   选路照常选到切过去的那个池，同一棵树、同一个分支重跑这一段，提示词带上被停下的原因（interrupted）。
// - 别在这里加判断条件：判断经 rt.classify（judgeRetrying），结果进历史。
// - 会话跑完却没有提交（#1408，patched('avoid-empty-commit-route')）：避让记在这张单的运行时上，下一轮选路带上。
//   滤光了候选就不再避开，点名原来的路由再选一次；还派不出就照旧用它，不死等。老历史没有这个标记，选路参数和原来一样。
// - patched('prefer-author-families')：曾让写码返工优先本单已有作者族，现在选路只按用途顺序、不再带这个字段；
//   调用留着只为带这个标记的老历史重放不报非确定性。
// - patched('route-by-tier')：动手选路带上这一单的派工档（rt.status.tier），按这一档的质量下界排模型（决定 0098）。
//   老历史没有这个标记，选路参数不带档，仍按整单战绩排。
// - 派之前再探一次选定的那条（#1409，patched('dispatch-probe')）：不通就先放掉这次预占（patched('dispatch-probe-release')，
//   没进起会话，不能占着池），再换下一条，每轮最多探 3 条；都探不通或都被挡就停下，不起会话。
//   没提交避让滤光之后改派原来的那条，也先探再派。老历史没有这个标记，不探、不改选路之后的那一步。
// - 暂停后继续，按会话号续上原会话（决定 0088，patched('segment-resume')）：hard 暂停取消的那一段记下起跑时刻和工作树，
//   继续后选好路由先问 planSegmentResume（找那一段在 runs 里记的会话号，比执行方式、账号池、会话用户）；同一棵树、能续就带
//   resumeSessionId 起，提示词只补被打断的原因。续不上（没会话号、换了执行方式或会话用户或树、没查成）照原来开新会话带
//   interrupted，原因写进任务进度。判一次就清掉：续起来没跑成的，下一次开新会话。切号、「现在就换」停下的这次不续。
// - 跑成的这一段记进 rt.lastSession（纯状态）：返工轮由 task.ts 决定续不续它（决定 0093，patched('rework-resume')），续法同上。
//   CI 红返工（cause=rework_ci，#3603，patched('ci-rework-prefer-route')）：第一次选路把上一段的 routeId 当 preferRouteId 点名，
//   同一条路由 planSegmentResume 才判得成续（以前每轮返工从空开始重选，落到别的执行方式就开新会话）。这张单要避开的路由不点名。
// - 单任务 token 预算（决定 0093，patched('task-token-budget')）：每次起会话之前查这张单花掉的 token，超了停下等人（rt.park），
//   点「继续」再给一份。开工时解析的上限里没有这一项（老历史）就不查；查不成照旧起会话，不挡干活。
//   只算当前这一代（patched('task-budget-this-generation')）：起算时间是这一代工作流的开工时刻，上一代烧掉的不算进去。
//   重做是另起一代，不该一开工就背着旧账被判超预算。点「继续」多给的份数按这一代已经花掉的算。
//   老历史没有这个标记，仍按整张单累计，活动入参不带起算时间。
// - 分档冷却和有界耐心（决定 0093，patched('route-patience')，借 magpie gateway-routing）：失败分流按错种给歇多久
//   （额度歇到清零、限流按 Retry-After、其他 1 分钟起翻倍）；上游临时故障判停下时先不停，歇一会儿重新选路再起，
//   从第一次该停下起最多 ROUTE_PATIENCE_SECONDS（默认 60 秒，上限 240 秒），歇掉的从这一段的会话时限里扣；用完照旧停下并写明。
//   重试、重派、耐心再起之前都先问 segmentSettled：上一段没收场就不起第二段（同一张单不并发两段），停下写明原因；
//   问不成（库一时不通）只记日志，照今天的做法接着走。
// - 停下之前先自动处理一次（决定 0093，patched('auto-redispatch-session')）：失败分流判停下、码是被引擎在时限上叫停（aborted）、
//   总时长到顶、起不来（AUTO_REDISPATCH_CODES）的，这一段里先换一条路由重派一次，进度里写一行；再判停下才停。
//   超时、起不来只避开这条路由，同一模型第二次再避开模型；中转欠费避开那个池。都不整族避开
//   （patched('avoid-scope-by-cause')，#2261）。老历史没有这个标记，仍避开这个模型和它那一族。
//   选路带着整族避让却回「等额度」或「等空位」：先放掉整族避让再选一次，还派不出才等。
//   总时长到顶（WT1）第一次仍原路续同一个会话：这一次有执行编号就记下，下一轮问 planSegmentResume，带上会话号再起
//   （patched('wall-clock-resume-session')，#2244）。没有编号、或老历史没有这个标记，只钉原路由、开新会话。
//   同一条路由上第二次不再原路续：换路由时把树上的进度写进提示词
//   （patched('wall-clock-carry-progress')），让下一轮接着做，不从头重来。老历史没有这个标记，只换路由、不改提示词。
//   写完「换路由续」之后若选路只剩等额度或等空位：不进 pauseForRoute 长睡（patched('wall-clock-switch-lands')，#2392）。
//   那一睡不写任务行，doing / updated_at 停在这一句，工作流仍 Running、没有新的 runs，拉单把它算进在干活。
//   新跑的当场停下等人。已经睡在里面的老历史：这一标记重放时为假（不能插在已记下的定时器前面），
//   叫醒之后走 patched('wall-clock-switch-wake')，下一轮再选不出就停下，不再睡第二觉。
// - 引擎活动超时（timeout_start_to_close 等，#2824，patched('en1-timeout-redispatch')）：失败分流 EN1 第二次原文一字不差会判挂起。
//   那一挂不起整单：停掉这一段，避开这条路由按点名再派；同一模型再撞上再避开模型，还撞上才停下等人。没有能派的路由仍挂起。
//   标了 engineRestarted 的仍原路重试，并按起跑时刻续可接回的会话。老历史没有这个标记，重放时仍把这一挂挂起。
// - 桥接连 Mirasim 超时（MB1，#2838，patched('mb1-bridge-redispatch')）：失败分流第一次原路重试、第二次判挂起
//   （「已重试 1 次」或原文一字不差）。那一挂和第一次的原路重试都不起整单：停掉这一段，避开这条路由按点名再派；
//   同一模型再撞上再避开模型，还撞上、或没有能派的路由，才停下等人。重派时 lastProblem 写成重派那一句，不留「挂起并报警」。
//   老历史没有这个标记，重放时仍原路重试、次数用完再挂起。
// - 上游 503 且原文是模型暂时不可用（MU1，patched('model-unavailable-redispatch')）：不原路重试、不钉在这条路由上睡。
//   停掉这一段，避开这条路由再派；进度和 lastProblem 写成「因 503 换了一条路由」。没有别的能马上派的，或换了还是这一句，
//   当场停下等人，任务行改成 stalled，写明是为了腾出名额。选路若只剩等，也不进 pauseForRoute 的长睡（那一睡
//   任务仍是 running、没有开着的会话，占着名额）。老历史没有这个标记，仍按上游出错（UP1）原路重试。
// - 出在账号池上的停（登录失效、封号、设备被撤销，patched('auth-reroute')）：池照旧暂停并报警，这张单马上回去选路避开这个池。
//   只凭一次 HTTP 401 不暂停整池，按临时失败换一条路由；同一个池短时间里（BARE_401_WINDOW_MS）第二次 401 才暂停整池。
//   第一次的时刻记在设置表里，别的任务再撞上同一次窗口也算第二次，不单记在这张单的内存里。
//   避开之后一条能派的路由都没有，才挂起，原因写「能派的池都停了」。老历史没有这个标记，仍把这张单挂起。
// - 点名和读回不是同一个模型（#2742）：失败分流 MD3 仍判停下。
//   #2742 是发版叫停后误续上一段 opus：续会话不比模型，同一 mirasim-relay 池点名 sonnet 仍续上 opus，快照还是
//   opus[1m]。不是比对串剥错 `[1m]`，不是 #1298 那种名单里没有才换模，也不是 #2797 的叫停本身。
//   新失败（patched('model-mismatch-redispatch')）不把整张单挂起：停这一段，换同一模型的另一条路由、开新会话
//   重派一次（清掉 resumeFrom，误续靠开新会话解开）。又对不上才停下等人。这次标题不沿用旧的「挂起并报警」，
//   看门狗不把它当成旧单叫醒。
//   已经按旧标题走进挂起的在途单：重放时 model-mismatch-redispatch 为假，必须再走进已经记下的 park
//   （跳过会 TMPRL1100）。看门狗发 taskContinue 之后，patched('model-mismatch-wake-reroute') 为真，按点名开新会话重派。
//   主线上先按点名路由重派、历史里已有 patched('model-mismatch-reroute') 的在途单：重放仍走那一条，不改步序。
//   这一版之前就已经点过继续、并且已经记下后面的选路：醒来这个标记为假，仍清零再选。

import { isCancellation, log, patched, workflowInfo } from '@temporalio/workflow';
import type { FailedChannel, PickRouteResult, RouteChoice, Worktree } from '../ports.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import type { TierDecision } from '../runner/tier.ts';
import {
  ORG_SWITCH_CODE,
  PARK_CODE_NO_ROUTE,
  PARK_CODE_ROUTE_SWITCH,
  ROUTE_RETRY_SECONDS,
  type RunSegmentInput,
  SEGMENT_DETACHED,
  SEGMENT_MINUTES,
  SEGMENT_STAGE,
  type SegmentEvidence,
  type TaskSpendResult,
  UI_PURPOSE,
} from '../task-contract.ts';
import { judgeImplementUiWork, UI_UNRECOGNIZED_NOTE, type UiJudgement } from '../ui-work.ts';
import { failureOf, iso } from './kit.ts';
import { decideFlowOnce } from './task-flow.ts';
import { stepParkKind, type TaskRuntime } from './task-runtime.ts';
import {
  Abandoned,
  AUTO_REDISPATCH_CODES,
  type Avoid,
  afterDispatchProbe,
  avoidHits,
  bump,
  dispatchProbeBlockedLine,
  dispatchProbeLine,
  dispatchProbeStopText,
  EMPTY_DISPATCH_PROBE,
  EN1_ACTIVITY_TIMEOUT_CODES,
  failureLooksLikeBare401,
  isDispatchProbePassOnly,
  MergedTask,
  mergeAvoid,
  NO_AVOID,
  NO_OTHER_FAMILY,
  NO_OTHER_ROUTE,
  PausedInterrupt,
  POOLS_ALL_HELD,
  patienceStep,
  poolAuthHoldTitle,
  poolHoldDedupeKey,
  RELEASE_FAMILY_WAIT,
  RESUME_STARTED_SLACK_MS,
  RepinInterrupt,
  type ResumeFrom,
  reworkCauseOf,
  type SegmentCauseNote,
  segmentMinutesAfterPatience,
  tokenBudgetStop,
  WALL_CLOCK_SWITCH_STALL,
  wallClockSwitchLine,
  wallClockSwitchStallDetail,
  widen,
  withDispatchProbeNote,
  withoutFamilies,
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
  opts: { plan?: boolean; cause?: SegmentCauseNote } = {},
): Promise<void> {
  // 下一笔为什么起（#3140，runs.cause）：第一笔按调用方说的（补提交、自测红了再改……）、出方案、或这一轮是不是返工；
  // 之后每一笔由上一笔怎么没成/被停下定（下面各处赋值），人点过「继续」的算「人点了继续」。只记账，不影响任何走向。
  let nextCause: SegmentCauseNote =
    opts.cause ?? (opts.plan ? { cause: 'plan' } : reworkCauseOf(rt.status.lastProblem, rt.feedback));
  let attempts = 0;
  let parksAtAttempt = rt.parks;
  let counters = ZERO;
  let avoid: Avoid = NO_AVOID;
  let previousMessage: string | undefined;
  let stick: string | undefined;
  // 这一段上一次被切号停下了（#59）：重跑时告诉新会话树里留着上一次的东西；一直带到这一段跑成（树里的东西一直在）
  let interrupted: string | undefined;
  // 上一次渠道运行中失败、该换渠道（#1118）：交给下一次选路标成不可用并记顺到谁；选路问过一次就清掉
  let failedChannel: FailedChannel | undefined;
  // 这一段已经自动换路由重派过一次（决定 0093）：再判停下就真停下
  let redispatched = false;
  // model_mismatch 的第一次重派只在同一个模型下找另一条路由，不能因该路由失效而悄悄换成别的模型。
  let mismatchModel: string | undefined;
  // 有界耐心（决定 0093）：第一次该停下的时刻、歇了几次、一共歇了多少秒（从会话时限里扣）
  let patienceFrom: number | null = null;
  let patienceRounds = 0;
  let patienceWaited = 0;
  // 账号池上的停（patched('auth-reroute')）：第一次失败才问标记，问过就记住。老历史这一支为假，仍挂起这张单。
  let authOn = false;
  /** 已经因登录失效、封号、设备被撤销避开了池：选路一条都没有才挂起。 */
  let authPoolsDown = false;
  /** 这张单记下只凭 401 的次数：活动重试用同一个身份，不会把自己数成第二次。 */
  let bare401Seq = 0;
  /** 这一次只凭 401 避开的路由：没有别的路由可换时，选路放它再试一次，好凑第二次。 */
  let bare401RouteId: string | undefined;
  /** 点名和读回对不上、已经按点名重派过一次的路由（#2742）。同一条再对不上就避开，不在原会话上续。 */
  const mismatchRetried = new Set<string>();
  /** 已经因模型对不上避开了路由：选路一条都没有才挂起，不改去等探针。 */
  let mismatchRoutesDown = false;
  // 动手前判这张单是不是界面活（#1264）：界面活按 ui 用途选路并带 uiWork，GPT 不派；判不出按界面活处理。
  // 判法是纯代码、不起活动；老历史（没有这个标记）重放照旧按 execute 选。
  let ui: UiJudgement | undefined = patched('ui-work-implement')
    ? judgeImplementUiWork({ touches: brief.touches, request: brief.request, changedFiles: rt.changedFiles })
    : undefined;
  let unrecognized = ui !== undefined && !ui.recognized ? `（${UI_UNRECOGNIZED_NOTE}）` : '';
  if (unrecognized) rt.set('implement', `动手第 ${rt.round} 轮${unrecognized}`);
  // CI 红返工粘住上一段的路由（#3603，patched('ci-rework-prefer-route')）：第一次选路点名上一段跑成的那条，
  // planSegmentResume 比得上执行方式、池、会话用户，才续得上原会话。点名的用不了照常选（选路自己退回）。
  // 只管这一段的第一次选路：之后的重试、换路由按失败分流走。这张单记着要避开它（轮数用完自动换模型、没提交）的不点名。
  // 标记只在 CI 红返工、有上一段路由、没被避开时才问，老历史重放为假。
  const lastRoute = rt.lastImplementRoute;
  let preferLast =
    nextCause.cause === 'rework_ci' &&
    lastRoute !== null &&
    !avoidHits(rt.commitAvoid, lastRoute) &&
    patched('ci-rework-prefer-route')
      ? lastRoute.routeId
      : undefined;
  for (;;) {
    await rt.checkpoint(); // 被人暂停了就停在这儿，不起新会话（#820 片 3）
    await rt.refreshContract('新动手/续会话派前');
    if (rt.contractVersioned && rt.brief) {
      brief = rt.brief;
      tier = brief.tier;
      ui = judgeImplementUiWork({
        touches: brief.touches,
        request: brief.request,
        changedFiles: rt.changedFiles,
      });
      unrecognized = !ui.recognized ? `（${UI_UNRECOGNIZED_NOTE}）` : '';
    }
    await holdForBudget(rt);
    const picked = await pickRoute(
      rt,
      avoid,
      stick,
      failedChannel,
      ui?.uiWork === true,
      authOn && authPoolsDown,
      authOn ? bare401RouteId : undefined,
      mismatchModel,
      mismatchRoutesDown,
      preferLast,
    );
    preferLast = undefined;
    mismatchRoutesDown = false;
    bare401RouteId = undefined;
    failedChannel = undefined;
    const route = picked.route;
    // 选路等待期间可能修订。不能拿按旧档预占的路由启动新版合同。
    if (await rt.refreshContract('选路完成、会话启动前')) {
      if (route.reservationId)
        await rt.step('releaseReservation', () =>
          rt.acts.releaseReservation({ schemaVersion: 1, reservationId: route.reservationId as string }),
        );
      continue;
    }
    if (picked.probeNote) {
      // 探通且没换路不进返工意见：下一轮提示词把意见里每一条都当成必改。动手状态那一行仍写这句。
      // 老历史没有这个标记：重放时意见里照旧留着「通」，活动入参不变。只在探通没换路时记标记。
      const dropPass =
        isDispatchProbePassOnly(picked.probeNote) && patched('dispatch-probe-pass-not-feedback');
      rt.feedback = dropPass
        ? rt.feedback.filter((item) => !item.startsWith('派前探测：'))
        : withDispatchProbeNote(rt.feedback, picked.probeNote);
    }
    if (rt.fellBackToMissRoute) {
      rt.fellBackToMissRoute = false;
      const note = `${NO_OTHER_ROUTE}，这一轮仍用路由 ${route.routeId}。`;
      if (!rt.feedback.some((line) => line.includes(NO_OTHER_ROUTE))) rt.feedback = [...rt.feedback, note];
    }
    // 交给冷验收的作者族按作者族记（决定 0093，patched('author-family-of-route')）：目录记成 unclassified、按模型 id 认得出的
    // （`cursor:gpt-…`）记成那一族，验收换族才换得对。选路没给作者族（老历史、假端口）照 family；老历史没有这个标记，照旧记 family
    rt.families.add(
      route.authorFamily !== undefined && patched('author-family-of-route')
        ? route.authorFamily
        : route.family,
    );
    rt.attemptSeq += 1;
    // 定模式（#2826）：第一次选路之后、第一段动手之前定一次，结果进历史（task-flow.ts）
    await decideFlowOnce(rt, brief, tier, route);
    // 续会话（决定 0088）：上一段留了要续的记号才问；判一次就清掉
    let resumeSessionId: string | undefined;
    let resumeNote = '';
    const from = rt.resumeFrom;
    if (from) {
      rt.resumeFrom = null;
      const plan = await planResume(rt, from, route, wt.path);
      if (plan.kind === 'resume') {
        resumeSessionId = plan.sessionId;
        resumeNote = '；续上一段的会话';
      } else {
        resumeNote = `；没续上会话（${plan.reason}），开新会话`;
      }
    }
    // 新会话的原因：新历史（run-cause-fields）经 runSegment 入参的 resumeReason 字段直接带到 one-shot（#3140）；
    // 老历史当年的活动合约里没有这个字段，借 route.why 的内部标记（fleet-resume-new:…）带，落库时再拆回真正的
    // routeWhy 和 resumeReason——在途任务重放要认，所以老写法留着，只在没有这个标记时才走。
    const newSessionReason =
      resumeSessionId === undefined && resumeNote.startsWith('；没续上会话')
        ? resumeNote.slice('；没续上会话（'.length, -'），开新会话'.length)
        : undefined;
    const explicitReason = newSessionReason !== undefined && patched('run-cause-fields');
    const segmentRoute =
      newSessionReason !== undefined && !explicitReason
        ? {
            ...route,
            why: `fleet-resume-new:${JSON.stringify({
              reason: newSessionReason,
              ...(route.why?.trim() ? { routeWhy: route.why } : {}),
            })}`,
          }
        : route;
    await rt.advance(
      'implement',
      `第 ${rt.round} 轮：${route.modelId} 动手${unrecognized}${resumeNote}${picked.probeNote ? `；${picked.probeNote}` : ''}`,
    );
    // 这一轮第一个派上的模型（#2762 流程健康记账，纯状态）
    rt.roundFirstModel ??= route.modelId;
    // 这一段的起跑时刻：被暂停取消时拿不到执行编号，续会话凭它去库里找这一段
    const attemptAt = Date.now();
    // 人点过「继续」才回到这里的这一笔，起因记「人点了继续」（#3140）；第一笔前的停不算
    if (attempts > 0 && rt.parks > parksAtAttempt) {
      nextCause = { cause: 'human_continue', ...(nextCause.summary ? { summary: nextCause.summary } : {}) };
    }
    const stamp = rt.runStamp(nextCause.cause, nextCause.summary);
    parksAtAttempt = rt.parks;
    attempts += 1;
    let evidence: SegmentEvidence | null = null;
    // 没跑成时的执行编号：总时长到顶第一次拿它去续同一个会话。没起成就没有
    let failedRunId: string | null = null;
    let infra: unknown = null;
    try {
      const segmentInput: RunSegmentInput = {
        schemaVersion: 1,
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        issueNumber: rt.input.issueNumber,
        route: segmentRoute,
        worktreePath: wt.path,
        branch: rt.branch,
        baseSha: rt.since,
        brief,
        tier,
        ...(rt.contractRevision ? { contractRevision: rt.contractRevision } : {}),
        feedback: rt.feedback,
        timeoutMinutes:
          patienceWaited > 0 ? segmentMinutesAfterPatience(SEGMENT_MINUTES, patienceWaited) : SEGMENT_MINUTES,
        ...(interrupted ? { interrupted } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(explicitReason && newSessionReason ? { resumeReason: newSessionReason } : {}),
        // 为什么起这一笔、属于第几个回合（#3140，只记账；老历史不带）
        ...stamp,
        // 只记账（runs.pr_number，#216）：第一轮会话交付之后才开 PR，这时还没有
        ...(rt.prNumber !== null ? { prNumber: rt.prNumber } : {}),
        // 重活先出方案的那一段（#2755）：提示词另说只读、只回方案 JSON
        ...(opts.plan ? { mode: 'plan' as const } : {}),
        // 全程的单（#2826）：提示词多一节「到合并都归你」。三段、老历史不带
        ...(rt.flowMode === 'full' ? { flowMode: 'full' as const } : {}),
      };
      // pausable：hard 暂停（#820 片 3）能把这一段取消掉；取消后回到循环头，停在检查点等「继续」，继续了在原树原分支上重跑
      let res = await rt.cancellable(() => rt.acts.runSegment(segmentInput), { pausable: true });
      // 引擎换版本、重启时会话没停、脱开接着跑（#2238）：隔一会儿带上 attach 接回，等它收场——不算失败、不换路由、不重起。
      // 老引擎还在排空时接回会当场再交回 detached，所以隔一会儿再接。老历史没有这个标记（也不会有 detached）
      const wasDetached = !res.ok && res.outcome === SEGMENT_DETACHED && !!res.detached;
      await rt.reattachExisting(async () => {
        while (!res.ok && res.outcome === SEGMENT_DETACHED && res.detached && patched('segment-reattach')) {
          const attach = res.detached;
          await rt.pause(
            'retry',
            '引擎在换版本：动手会话脱开引擎接着跑，等新引擎接回',
            SEGMENT_REATTACH_SECONDS,
          );
          res = await rt.cancellable(() => rt.acts.runSegment({ ...segmentInput, attach }), {
            pausable: true,
          });
        }
      });
      if (wasDetached && patched('settle-merged-task-checkpoint')) await rt.checkpoint();
      if (res.ok) {
        if (rt.contractVersioned) rt.contractRevision = null;
        rt.lastImplementRoute = route;
        const resumed = resumeSessionId !== undefined;
        rt.lastSession = { runId: res.runId, worktreePath: wt.path, resumed };
        // 最后一条回复进 PR 说明（#2723）：纯状态，不多调活动。老版活动回的可能没带，当没有
        rt.lastAnswer = typeof res.answer === 'string' ? res.answer : null;
        rt.resumeStreak = resumed ? rt.resumeStreak + 1 : 0;
        return;
      }
      evidence = res.evidence;
      failedRunId = res.runId;
    } catch (error) {
      if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
      if (error instanceof PausedInterrupt) {
        // 被人暂停停下的这一段（借 org_switch 的位置，task-contract.ts 的 PAUSED_BY_HUMAN）：不算失败、不记账、不换模型；
        // 回到循环头停在检查点，继续后在原分支原树上重跑，提示词带上被停下的原因
        interrupted = rt.pauseNote(error.command);
        nextCause = { cause: 'pause_resume', summary: interrupted };
        // 继续后按会话号续上这一段（决定 0088）。老历史没有这个标记：照旧开新会话
        if (patched('segment-resume')) {
          rt.resumeFrom = {
            previous: { startedAfter: iso(attemptAt - RESUME_STARTED_SLACK_MS) },
            worktreePath: wt.path,
          };
        }
        continue;
      }
      if (error instanceof RepinInterrupt) {
        // 被「现在就换」停下的这一段（#1216，也借 org_switch 的位置）：不算失败、不记账；不停下等人，直接回循环头重新选路——
        // 选路现读驾驶舱写好的指定，新模型原分支原树重跑，提示词带上被停下的原因。人明说要换，不粘上一条路由、
        // 也不带着之前失败攒下的避开（避开里要是有他指定的那个模型，选路就派不出了）
        interrupted = rt.repinNote(error.command);
        nextCause = { cause: 'repin', summary: interrupted };
        stick = undefined;
        avoid = NO_AVOID;
        continue;
      }
      infra = error;
    }
    let failure = infra
      ? failureOf(infra, 'session:execute')
      : {
          source: 'session:execute',
          code: evidence?.code ?? 'failed',
          message: evidence?.message ?? '会话没跑成',
          retryable: null,
        };
    // Temporal 只凭 StartToClose timeout 不知道活动是不是被旧 worker 丢了。
    // 有旧心跳时比较两个启动时刻；旧心跳被服务端丢掉时，用当前引擎启动时刻和这一段起跑时刻比较。
    // 两种凭据都不足时保守地按真实超时。
    if (patched('engine-restart-timeout') && failure.code.toLowerCase().startsWith('timeout_')) {
      try {
        const current = await rt.cancellable(() => rt.acts.engineStartedAt({ schemaVersion: 1 }));
        const currentStartedAt = Date.parse(current.startedAt);
        const changed =
          failure.engineStartedAt !== undefined
            ? current.startedAt !== failure.engineStartedAt
            : Number.isFinite(currentStartedAt) && currentStartedAt > attemptAt;
        if (changed) {
          failure = {
            ...failure,
            currentEngineStartedAt: current.startedAt,
            engineRestarted: true,
          };
        }
      } catch (error) {
        if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
        log.warn('超时活动的引擎启动代次没查成，按真实超时处理', {
          error: failureOf(error, 'engineStartedAt').message,
        });
      }
    }
    // 切号停下的（失败分流 OS1：不算失败、不记账、马上接着干）：选路照常选到切过去的那个池，在原分支上重跑这一段
    if (failure.code === ORG_SWITCH_CODE) interrupted = failure.message;
    // 写在问分流之前：老历史重放时这一支为假，不多一次记 401 的活动，分流的入参也不带 priorBare401。
    authOn = patched('auth-reroute');
    let priorBare401 = false;
    if (
      authOn &&
      failureLooksLikeBare401({
        code: failure.code,
        message: failure.message,
        ...(evidence?.httpStatus !== undefined ? { httpStatus: evidence.httpStatus } : {}),
      })
    ) {
      const seq = bare401Seq;
      bare401Seq += 1;
      const noted = await rt.acts.noteBare401({
        schemaVersion: 1,
        poolId: route.poolId,
        now: iso(Date.now()),
        claim: `${workflowInfo().workflowId}:${route.poolId}:${seq}`,
      });
      priorBare401 = noted.repeated;
    }
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
      ...(priorBare401 ? { priorBare401: true as const } : {}),
    });
    // 切号停下的不是这一段的失败：不当「上一次的原文」——既不凑成「和上一次一字不差」，也不打断切号前后两次真失败的比对
    if (failure.code !== ORG_SWITCH_CODE) previousMessage = failure.message;
    // 下一笔为什么起（#3140）：切号停下的是「切号重跑」，分流说原路再试的是「原路重试」，其余（换路由、换模型、自动重派、停下等人
    // 后继续）先记「换路由重派」；人点了继续的在下一笔起跑前按停下次数改记。只记账。
    nextCause =
      failure.code === ORG_SWITCH_CODE
        ? { cause: 'org_switch', summary: failure.message }
        : next.action === 'retry'
          ? { cause: 'retry', summary: next.reason }
          : { cause: 'reroute', summary: next.reason };
    rt.status.lastProblem = next.reason;
    counters = bump(counters, next);
    // 出在账号池上（登录失效、封号、设备被撤销）：不挂起这张单。标记在问分流时已经记下（老历史为假，仍走下面的挂起）。
    if (authOn && next.authReroute) {
      stick = undefined;
      avoid = widen(avoid, route, next.authReroute);
      previousMessage = undefined;
      if (next.authReroute === 'pool') {
        authPoolsDown = true;
        bare401RouteId = undefined;
        try {
          await rt.acts.raiseAlert({
            taskId: rt.input.taskId,
            level: 'decision',
            title: `账号池 ${route.poolId} 整池暂停：${poolAuthHoldTitle(next.rule)}`,
            detail: next.reason,
            dedupeKey: poolHoldDedupeKey(route.poolId),
          });
        } catch (error) {
          if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
          log.warn('整池暂停的提醒没发出去，这张单照旧换池', { poolId: route.poolId, error: String(error) });
        }
      } else {
        bare401RouteId = route.routeId;
      }
      await rt.note(next.reason);
      continue;
    }
    // 老历史没有这个标记：不问上一段收场没有、不耐心等，照旧
    const patienceOn = patched('route-patience');
    // 桥接连 Mirasim 超时（#2838）：标记只在 MB1 上打，别的失败重放不多这一下。老历史为假，仍走原来的原路重试 / 挂起。
    const mb1Redispatch = next.rule === 'MB1' && patched('mb1-bridge-redispatch');
    // 模型暂时不可用（MU1）：标记只在这条规则上打。老历史重放时记下的规则不是 MU1，不多一次标记。
    const modelDown = next.rule === 'MU1' && patched('model-unavailable-redispatch');
    if (next.action === 'retry' && !mb1Redispatch) {
      // 原路再试：还是这条路由（额度要等的，等到清零再来，不算墙钟）
      stick = route.routeId;
      // 总时长到顶第一次：原路续同一个会话（#2244）。有执行编号才问续不续；会话没起成就没有编号，照旧开新会话。
      // 老历史没有这个标记：重放时为假，只钉原路由，不多一次 planSegmentResume。
      if (failure.code.toLowerCase() === 'wall_clock_timeout' && patched('wall-clock-resume-session')) {
        if (failedRunId) rt.resumeFrom = { previous: { runId: failedRunId }, worktreePath: wt.path };
      }
      // 活动超时发生在旧引擎（#2824）：原路再试时按起跑时刻续可接回的会话。续不上就开新会话。
      // 写在 wall-clock 那个标记之后：超时码走不到上面那一支，老历史重放不会多打 wall-clock 的标记。
      // 没标 engineRestarted 的不在这里续，同因挂起走下面的重派。
      if (
        failure.engineRestarted === true &&
        EN1_ACTIVITY_TIMEOUT_CODES.includes(failure.code.toLowerCase()) &&
        patched('en1-timeout-redispatch')
      ) {
        rt.resumeFrom = {
          previous: { startedAfter: iso(attemptAt - RESUME_STARTED_SLACK_MS) },
          worktreePath: wt.path,
        };
      }
      if (patienceOn && !(await settledBeforeRestart(rt, attemptAt))) continue;
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
      // 上游临时故障（限流、繁忙……）次数用完：先有界耐心地歇一会儿、重新选路再起（决定 0093），预算用完才照旧停下
      if (patienceOn && next.transient === true) {
        const now = Date.now();
        if (patienceFrom === null) patienceFrom = now;
        const step = patienceStep({ sinceSeconds: (now - patienceFrom) / 1000, round: patienceRounds });
        if (step.kind === 'pause') {
          if (!(await settledBeforeRestart(rt, attemptAt))) continue;
          patienceRounds += 1;
          patienceWaited += step.seconds;
          nextCause = { cause: 'retry', summary: next.reason };
          stick = undefined;
          await rt.note(
            `第 ${rt.round} 轮：${route.modelId} ${next.reason}；所有路由都在忙，耐心等 ${step.seconds} 秒再选路（第 ${patienceRounds} 次，从会话时限里扣）`,
          );
          await rt.pause('retry', next.reason, step.seconds);
          continue;
        }
        await rt.park(`${next.reason}；${step.reason}`, failure.message, 'stuck', 'transient');
        patienceFrom = null;
        patienceRounds = 0;
        counters = ZERO;
        avoid = NO_AVOID;
        stick = undefined;
        previousMessage = undefined;
        continue;
      }
      // 被引擎在时限上叫停、总时长到顶、起不来（决定 0093）：先自动换一条路由重派一次，进度里写一行，不停下等人。
      // 引擎活动超时（EN1 的 timeout_*，#2824）同一条：分流判挂起也不挂整单，停掉这一段再派。
      // 桥接连 Mirasim 超时（MB1，#2838）也进这里：第一次的原路重试和第二次的挂起都不挂整单。上面的 mb1 标记为真时，
      // retry 分支被跳过，第一次失败直接落到这一支。
      // 超时、起不来只避开这条路由，同一模型第二次再避开模型；中转欠费避开那个池。都不整族避开（#2261）。
      // 第一次按路由避开之后，同一模型再撞上还可以再自动一次（升到避开模型）。除此之外这一段里只自动一次，再撞上照旧停下。
      // 只有人能修的码不在名单里。老历史没有 auto-redispatch-session，照旧停下；没有 avoid-scope-by-cause，仍避开模型和它那一族。
      const code = failure.code.toLowerCase();
      // 引擎活动超时（#2824）：分流因原文一字不差判的挂起不挂整单。标记只对这几个码打，别的码重放不多这一下。
      // 写在 auto-redispatch-session 之前：老历史重放时这一支为假，listed 仍只看原来那张表。
      // MB1 用上面已经打过的标记，这里不再打一次（重放不多一个 marker）。
      // MU1 同样用上面已经打过的标记。老历史这一支为假，listed 仍只看原来那张表。
      const listed =
        AUTO_REDISPATCH_CODES.includes(code) ||
        (EN1_ACTIVITY_TIMEOUT_CODES.includes(code) && patched('en1-timeout-redispatch')) ||
        mb1Redispatch ||
        modelDown;
      // model_mismatch 是新增的自动换路行为；单独加标记，避免在途任务重放时把原本要报人的失败改成重派。
      const modelMismatchRedispatch = code === 'model_mismatch' && patched('model-mismatch-redispatch');
      const eligible = listed && (code !== 'model_mismatch' || modelMismatchRedispatch);
      // 写在 auto-redispatch-session 之前、且 redispatched 为假时短路：老历史重派过一次之后不会多调这个标记。
      const escalate =
        redispatched && eligible && patched('avoid-scope-by-cause') && rt.infraCanEscalate(route, code);
      if ((escalate || !redispatched) && eligible && patched('auto-redispatch-session')) {
        if (patienceOn && !(await settledBeforeRestart(rt, attemptAt))) continue;
        redispatched = true;
        nextCause = { cause: 'reroute', summary: next.reason };
        stick = undefined;
        if (code === 'model_mismatch') {
          mismatchModel = route.modelId;
          // 不续上一段。#2742 就是续会话不比模型，同池点名 sonnet 仍接回 opus。
          rt.resumeFrom = null;
        }
        // 避让记在这张单上（没提交的避让那一处）：没有别的候选时选路照旧派原来那条，不死等。
        // 老历史没有 avoid-scope-by-cause：重放时为假，仍避开模型（认得出族的连这一族），活动入参和原来一样。
        if (patched('avoid-scope-by-cause')) rt.avoidInfra(route, code);
        else rt.avoidModel(route);
        counters = ZERO;
        previousMessage = undefined;
        // 同一条路由第二次总时长到顶：不再原路续。提示词带上树上的进度，下一轮换路由接着做。
        // 第一次到顶走不到这里（WT1 还在原路重试）。老历史没有这个标记：只换路由，提示词和进度那一行照旧。
        const carryProgress = code === 'wall_clock_timeout' && patched('wall-clock-carry-progress');
        if (carryProgress) {
          const line = wallClockSwitchLine(route.modelId);
          interrupted = line;
          if (!rt.feedback.includes(line)) rt.feedback = [...rt.feedback, line];
          // 只记在内存里，不调活动：下一轮选路若只剩等，不进长睡。已经写过这行、正睡着的老历史重放时也会置上。
          rt.landSwitch = true;
        }
        const redispatchLine = carryProgress
          ? `第 ${rt.round} 轮：${route.modelId} 同一条路由第二次总时长到顶，换一条路由带上进度续一次，不停下等人`
          : modelDown
            ? `第 ${rt.round} 轮：${route.modelId} 上游 503 模型暂时不可用，换一条可用路由重派，不停下等人`
            : `第 ${rt.round} 轮：${route.modelId} ${next.reason}（${failure.code}），自动换一条路由重派一次，不停下等人`;
        // 桥接超时、模型暂时不可用的挂起句（「挂起并报警」）已经写进 lastProblem。重派不是挂起：落库前换成重派这一句。
        // 老历史标记为假，不改 lastProblem，saveTaskState 的入参和原来一样。
        if (mb1Redispatch || modelDown) rt.status.lastProblem = redispatchLine;
        // 下一轮选路若只剩等、或只剩刚才那条：不睡，停下腾出名额。派上了由 landed 清掉。
        if (modelDown) rt.modelDownLand = true;
        await rt.note(redispatchLine);
        continue;
      }
      // 写在挂起之前：已经走进挂起的老历史重放时这一支为假，下一步仍是原来的 park，活动序列不变。
      // 只在 model_mismatch 上打标记。MB1 走上面的重派，到不了这里，重放不多一个 marker。
      // 新失败已经由 model-mismatch-redispatch 换过同一模型的另一条路由：这里不再打标记，第二次直接挂起。
      // 主线上已经记下 model-mismatch-reroute 的在途单，重放时上一支为假，仍走下面这一条。
      if (code === 'model_mismatch' && !modelMismatchRedispatch && patched('model-mismatch-reroute')) {
        if (patienceOn && !(await settledBeforeRestart(rt, attemptAt))) continue;
        counters = ZERO;
        previousMessage = undefined;
        if (!mismatchRetried.has(route.routeId)) {
          mismatchRetried.add(route.routeId);
          // 钉住点名的这条，开新会话。不写 resumeFrom：#2742 就是续会话不比模型，把上一段 opus 接了回来。
          stick = route.routeId;
          const line = `第 ${rt.round} 轮：${route.modelId} 回话的模型不是点名的，停掉这一段，按点名路由重派一次（开新会话，不续上一段），不停下等人`;
          rt.status.lastProblem = line;
          await rt.note(line);
          continue;
        }
        stick = undefined;
        avoid = widen(avoid, route, 'route');
        mismatchRoutesDown = true;
        const line = `第 ${rt.round} 轮：${route.modelId} 这条路由再次读回的不是点名的模型，避开它再选；还有能派的就继续`;
        rt.status.lastProblem = line;
        await rt.note(line);
        continue;
      }
      await rt.park(
        code === 'model_mismatch' && modelMismatchRedispatch
          ? MODEL_MISMATCH_AGAIN_STALL
          : modelDown
            ? MODEL_UNAVAILABLE_STALL
            : mb1Redispatch && next.action !== 'park'
              ? '桥接连 Mirasim 超时：同一原因连败到重派预算，停下等人'
              : next.humanFix
                ? `${next.reason}；要人：${next.humanFix}`
                : next.reason,
        modelDown ? modelUnavailableStallDetail(failure.message) : failure.message,
        'stuck',
        code === 'model_mismatch' || modelDown || mb1Redispatch ? 'other' : stepParkKind('runSegment', next),
        undefined,
        // 只进查询（#3423）：指挥官按码和规则认运行环境类停法，不改 kind、不进命令序
        { code: failure.code, rule: next.rule },
      );
      // 已经按旧标题挂上的在途单：上面两支重放都为假，所以走进了这次 park。
      // 人点「继续」或看门狗发 taskContinue 之后才到这里。这一支是新执行（标记为真）：按点名开新会话重派。
      // 新失败换过同档路由之后的第二次挂起不走这里（model-mismatch-redispatch 已为真）：点「继续」仍清零再选。
      // 这一版之前就已经点过继续、历史里已经有后面的选路：标记为假，仍清零再选，不多一次 note。
      if (code === 'model_mismatch' && !modelMismatchRedispatch && patched('model-mismatch-wake-reroute')) {
        rt.resumeFrom = null;
        counters = ZERO;
        previousMessage = undefined;
        failedChannel = undefined;
        if (!mismatchRetried.has(route.routeId)) {
          mismatchRetried.add(route.routeId);
          avoid = NO_AVOID;
          stick = route.routeId;
          const line = `第 ${rt.round} 轮：${route.modelId} 回话的模型不是点名的，这次挂起已解开，按点名路由重派一次（开新会话，不续上一段），不停下等人`;
          rt.status.lastProblem = line;
          await rt.note(line);
          continue;
        }
        stick = undefined;
        avoid = widen(avoid, route, 'route');
        mismatchRoutesDown = true;
        const line = `第 ${rt.round} 轮：${route.modelId} 这条路由再次读回的不是点名的模型，避开它再选；还有能派的就继续`;
        rt.status.lastProblem = line;
        await rt.note(line);
        continue;
      }
      counters = ZERO;
      avoid = NO_AVOID;
      stick = undefined;
      mismatchModel = undefined;
      previousMessage = undefined;
    }
  }
}

/** 动手会话脱开引擎跑着、引擎在换版本（#2238）：隔多久去接回一次（老引擎还在排空时接回会再交回 detached）。 */
export const SEGMENT_REATTACH_SECONDS = 20;

/** 上游 503 模型暂时不可用、换不了路由或换了还是这一句：停下等人，腾出 running 名额。写进 lastProblem。 */
export const MODEL_UNAVAILABLE_STALL = '上游 503：模型暂时不可用，已停下腾出名额';

/**
 * 同一模型已经换过一条路由，回话仍不是点名的那个。
 * 不沿用「回话的模型不是点名的那个（model_mismatch）：挂起并报警」：看门狗靠那一句叫醒已经挂上的旧单，
 * 新的这次停下不该被马上解开。
 */
export const MODEL_MISMATCH_AGAIN_STALL = '回话的模型不是点名的那个：换了一条同档路由仍对不上，停下等人';

/** 停下时写给人的原因：选路或上游的原话，加上为什么不能在这里接着睡。 */
export function modelUnavailableStallDetail(detail: string): string {
  const why = detail.trim() || '没有别的能马上派的路由';
  return `${why}。上游回了 503，这个模型暂时不可用。不在这里接着睡：睡着时任务仍是 running、没有开着的会话，占着进单名额。点「继续」再选一次；不要了点「放弃」。`;
}

/**
 * 模型暂时不可用、还没派上新会话（rt.modelDownLand）：停下等人，回 true。
 * 标记为假时不调活动，回 false。调用方接着走原来的等路由。
 */
async function parkIfModelDown(rt: TaskRuntime, detail: string): Promise<boolean> {
  if (!rt.modelDownLand) return false;
  await rt.park(MODEL_UNAVAILABLE_STALL, modelUnavailableStallDetail(detail), 'stuck', 'other', undefined, {
    rule: 'MU1',
  });
  return true;
}

/**
 * 重试、重派之前确认上一段真停了（决定 0093）：没收场就停下等人、写明原因，回 false（调用方回循环头，人点继续后再选再起）；
 * 收场了回 true。问不成（活动没装、库一时不通）只记日志、回 true：照今天的做法接着走，不把「没查成」当成「还在跑」。
 */
async function settledBeforeRestart(rt: TaskRuntime, attemptAt: number): Promise<boolean> {
  let got: { settled: true } | { settled: false; runId: string; detail: string };
  try {
    got = await rt.cancellable(() =>
      rt.acts.segmentSettled({
        schemaVersion: 1,
        taskId: rt.input.taskId,
        startedAfter: iso(attemptAt - RESUME_STARTED_SLACK_MS),
      }),
    );
  } catch (error) {
    if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
    log.warn('上一段收场没有没查成，照旧接着走', { error: failureOf(error, 'segmentSettled').message });
    return true;
  }
  if (got.settled) return true;
  await rt.park(
    '上一段会话还没收场，不起第二段（同一张单不并发两段）',
    `${got.detail}；确认那个会话停了再点「继续」`,
  );
  return false;
}

/**
 * 单任务 token 预算（决定 0093）：这张单花掉的超了已给的份数就停下等人，点「继续」再给到够用。
 * 开工时解析的上限里没有这一项（老历史）或是 0 就不查；查不成只记日志，照旧起会话。放弃、叫停照常往外抛。
 * 当前这一代（patched('task-budget-this-generation')）只算这一代工作流开工之后的会话：重做另起的一代不背上一代。
 * 老历史没有这个标记，重放时不带起算时间，活动入参和原来一样。
 */
async function holdForBudget(rt: TaskRuntime): Promise<void> {
  const budget: unknown = rt.limits.taskTokenBudget;
  if (typeof budget !== 'number' || budget <= 0) return;
  if (!patched('task-token-budget')) return;
  // 写在查花费之前、估用量那个标记之前：老历史重放时这一支为假，不多一个字段，后面的标记顺序也对得上。
  const thisGeneration = patched('task-budget-this-generation');
  let spent: TaskSpendResult;
  try {
    spent = await rt.cancellable(() =>
      rt.acts.taskSpend({
        schemaVersion: 1,
        taskId: rt.input.taskId,
        // 起算时间是这一代的开工时刻（Temporal 记的，重放不变）。上一代的会话都在这之前。
        ...(thisGeneration ? { since: iso(workflowInfo().startTime.getTime()) } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
    log.warn('查这张单花掉的 token 没查成，照旧起会话', { error: failureOf(error, 'taskSpend').message });
    return;
  }
  // 被叫停、超时杀掉的会话多半到不了 CLI 的收尾用量帧，用量就空着；按这张单别的行估出来的下限一起算进预算，
  // 不然一张单反复被叫停可以一直换会话、账面一次都不超。老历史没有这个字段，估出来的是 0，照旧（patched('task-budget-unmetered-estimate')）。
  // #2859：判超没超用活动算好的输入当量（inputEquivalent）；#2830 那一版记的是 weighted / weightedEstimated，照读；
  // 再老的结果两样都没有，用原来的 tokens / estimated。当量不在这里重算：历史里记的是活动当时的结果，重放读到的数不变。
  // 没动步序，所以不用新标记。
  const equivalent = spent.inputEquivalent !== undefined;
  const measured = spent.inputEquivalent ?? spent.weighted ?? spent.tokens;
  const estimatedPart =
    spent.inputEquivalent !== undefined
      ? (spent.inputEquivalentEstimated ?? 0)
      : spent.weighted !== undefined
        ? (spent.weightedEstimated ?? 0)
        : (spent.estimated ?? 0);
  const counted = measured + (patched('task-budget-unmetered-estimate') ? estimatedPart : 0);
  if (counted <= budget * rt.budgetGrants) return;
  const stop = tokenBudgetStop({ tokens: counted, unmetered: spent.unmetered }, budget, rt.budgetGrants, {
    measured,
    estimated: counted - measured,
    ...(equivalent ? { raw: spent } : {}),
  });
  await rt.park(stop.title, stop.detail, 'stuck', 'quota');
  // 人看过、点了「继续」：再给到比花掉的多一份
  // 指挥官判了不是空转（#3294 第 2 片）：多放宽的那几档一起加上，用掉就清
  rt.budgetGrants = Math.floor(counted / budget) + 1 + rt.budgetWiden;
  rt.budgetWiden = 0;
}

/**
 * 这一段能不能续上一段的会话：换了工作树不续（会话记录按目录存）；别的交给 planSegmentResume 现查。
 * 查不成（活动没装、库一时不通）不挂起、不重试：退回开新会话，原因照写。放弃、叫停照常往外抛。
 * task.ts 交活没提交续一次之前也先问它（#2722）：续不上就不在这一轮另开会话。
 */
export async function planResume(
  rt: TaskRuntime,
  from: ResumeFrom,
  route: RouteChoice,
  worktreePath: string,
): Promise<{ kind: 'resume'; sessionId: string } | { kind: 'new'; reason: string }> {
  if (from.worktreePath !== worktreePath) return { kind: 'new', reason: '换了工作树' };
  try {
    const plan = await rt.cancellable(() =>
      rt.acts.planSegmentResume({
        schemaVersion: 1,
        taskId: rt.input.taskId,
        routeId: route.routeId,
        previous: from.previous,
      }),
    );
    return plan.kind === 'resume' ? { kind: 'resume', sessionId: plan.sessionId } : plan;
  } catch (error) {
    if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
    return { kind: 'new', reason: `续会话没查成：${failureOf(error, 'planSegmentResume').message}` };
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
  /** 已经因登录失效、封号、设备被撤销避开了池：一条能派的都没有就挂起，不改去等探针。 */
  authPoolsDown = false,
  /** 只凭一次 401 避开的路由。没有别的路由时放它再试一次，好让第二次 401 暂停整池。 */
  bare401RouteId?: string,
  /** model_mismatch 的第一次自动重派只允许同一个模型的其他路由。 */
  mismatchModel?: string,
  /**
   * 点名和读回的模型对不上，能派的都避开了（主线上已经记下的重派）。一条都没有就挂起，不改去等探针，
   * 也不把刚证实会换模的那条再派出去。不给 = 照旧。新失败的同档重派不置这个标志。
   */
  mismatchRoutesDown = false,
  /** CI 红返工点名上一段的路由（#3603）：用不了由选路照常选。不给 = 照旧。 */
  preferRouteId?: string,
): Promise<{ route: RouteChoice; probeNote: string | null }> {
  const stage = uiWork ? UI_PURPOSE : SEGMENT_STAGE.manual;
  // 老历史重放时这一支为假：选路参数和原来一样，不多选一次。要写在派前探测那个标记之前，已有历史里的标记顺序才对得上。
  const avoidEmpty = patched('avoid-empty-commit-route');
  let round = EMPTY_DISPATCH_PROBE;
  let probeAvoid: string[] = [];
  let stickTo = stick;
  let prefer: string | undefined = preferRouteId;
  let droppedDry = false;
  // 没提交的避让里整族避开的那一层已经去掉（别的族一条都派不出，或只剩等额度、等空位，#2261）：只避开模型再选
  let droppedFamilies = false;
  let holdForProbe = false;
  let lastStopDetail = '';
  // 只凭 401 的那条路由已经放回去再试过一次：再派不出就不再放，免得来回选。
  let releasedBare401 = false;
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
    droppedFamilies = false;
    rt.fellBackToMissRoute = false;
    // 模型暂时不可用之后没有能探的路由：不在这里睡。睡着时任务仍是 running、没有开着的会话。
    if (await parkIfModelDown(rt, lastStopDetail)) return;
    await rt.pauseForRoute('slot', lastStopDetail, ROUTE_RETRY_SECONDS, wakeMark);
  };
  // 派上了会话：换路由续这一记清掉，后面正常的等额度不再被当成「续不上」。
  const landed = (chosen: { route: RouteChoice; probeNote: string | null }) => {
    rt.landSwitch = false;
    rt.switchWake = false;
    rt.modelDownLand = false;
    return chosen;
  };
  // 选定的这一条：老历史不探，直接派。探通才派；探不通记下来换下一条，到了 3 条就停下。
  const consider = async (
    route: RouteChoice,
    probeOn: boolean,
    wakeMark: number,
  ): Promise<{ route: RouteChoice; probeNote: string | null } | null> => {
    if (!probeOn) return landed({ route, probeNote: null });
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
      return landed({ route, probeNote: dispatchProbeLine(round.fails, probe.label) });
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
    const dry = useDry ? (droppedFamilies ? withoutFamilies(rt.commitAvoid) : rt.commitAvoid) : NO_AVOID;
    const merged = useDry ? mergeAvoid(avoid, dry) : avoid;
    const avoidRouteIds = [...merged.routeIds];
    for (const id of probeAvoid) if (!avoidRouteIds.includes(id)) avoidRouteIds.push(id);
    // 选路不再带「优先本单已有作者族」（选路只按用途顺序）。调用留着、不加字段：带这个标记的老历史重放时命令序列不变。
    patched('prefer-author-families');
    // 紧挨在上一个标记后面：老历史重放时这里为假，选路参数不带档，后面的活动入参和原来一样。
    const routeByTier = patched('route-by-tier');
    const tierName = routeByTier ? rt.status.tier?.tier : undefined;
    const got: PickRouteResult = await rt.step('pickRoute', () =>
      rt.acts.pickRoute({
        taskId: rt.input.taskId,
        // 界面活按 ui 用途的模型顺序选，并带 uiWork：硬禁令 gpt-no-ui 按 UI 判，GPT 一条都不派（别的家都派不出就回「等」）
        stage,
        ...(uiWork ? { uiWork: true } : {}),
        avoidRouteIds,
        avoidPoolIds: merged.poolIds,
        avoidModelIds: merged.modelIds,
        // 整族避开（决定 0093）：只有自动换路由加过族才带，老历史里没有，选路参数和原来一样
        ...(merged.families && merged.families.length > 0 ? { avoidFamilies: merged.families } : {}),
        ...(stickTo ? { stickRouteId: stickTo } : {}),
        ...(prefer ? { preferRouteId: prefer } : {}),
        ...(mismatchModel ? { models: [mismatchModel] } : {}),
        ...(failedChannel ? { failedChannel } : {}),
        ...(tierName ? { tier: tierName } : {}),
        reserve: { segment: 'manual' },
      }),
    );
    if (!got.ok) {
      const miss = rt.commitMissRoute;
      const missUsable = miss !== null && !probeAvoid.includes(miss.routeId) ? miss : null;
      if (got.waitFor === 'none') {
        // 整族避开之后别的族一条都派不出：先退回只避开模型再选一次（同族换个模型），还不行再照旧派原来那条
        if (useDry && (dry.families?.length ?? 0) > 0) {
          droppedFamilies = true;
          rt.status.lastProblem = NO_OTHER_FAMILY;
          continue;
        }
        const blocked = dry.routeIds.length + dry.poolIds.length + dry.modelIds.length > 0;
        if (useDry && blocked && missUsable) {
          // 模型暂时不可用：别退回刚才那条。退回去还是这个模型，任务又会 running 着空转。
          if (await parkIfModelDown(rt, got.detail)) continue;
          droppedDry = true;
          prefer = missUsable.routeId;
          rt.status.lastProblem = NO_OTHER_ROUTE;
          rt.fellBackToMissRoute = true;
          continue;
        }
        // 点名再选仍派不出：照旧用原来的路由。派之前照样探，探不通就不拿它起会话。
        // 模型对不上的不走这里：那条刚证实读回的不是点名的，再派回去还会挂。
        // 模型暂时不可用也不退回刚才那条：退回去还是这个模型，任务又会 running 着空转。
        if (droppedDry && missUsable && !mismatchRoutesDown) {
          if (await parkIfModelDown(rt, got.detail)) continue;
          rt.status.lastProblem = NO_OTHER_ROUTE;
          rt.fellBackToMissRoute = true;
          const chosen = await consider(missUsable, probeOn, mark);
          if (chosen) return chosen;
          continue;
        }
        // 登录失效、封号、设备被撤销把能派的池都避开了：挂起这张单，不改去等探针（探针恢复不了要人重新登录的池）。
        // 人点「继续」之后避让清掉再选：生产上池的提醒还在，选路仍是一条都没有，再挂起。
        if (authPoolsDown) {
          await rt.park(POOLS_ALL_HELD, got.detail);
          avoid = NO_AVOID;
          continue;
        }
        // 只凭一次 401、没有别的路由：放回这条再试一次。第二次仍是 401 才暂停整池。已经放过、或同时还避开了池，就不再放。
        if (
          bare401RouteId &&
          !releasedBare401 &&
          merged.poolIds.length === 0 &&
          avoidRouteIds.includes(bare401RouteId)
        ) {
          releasedBare401 = true;
          avoid = { ...avoid, routeIds: avoid.routeIds.filter((id) => id !== bare401RouteId) };
          continue;
        }
        // 模型对不上把能派的路由都避开了：挂起。探针恢复不了「读回的不是点名的」。
        // 人点「继续」之后这一轮的避让清掉再选。不给这个标志时，下面两步和原来一样。
        if (mismatchRoutesDown) {
          await rt.park(
            '没有还能派的路由：点名和读回的模型对不上',
            `${got.detail}。这一段已停。按点名路由重派过一次仍对不上，避开这些路由之后没有还能派的。点「继续」再选一次；不要了点「放弃」。`,
          );
          avoid = NO_AVOID;
          prefer = undefined;
          droppedDry = false;
          continue;
        }
        // 还没探过、候选一开始就被挡，也走同一条停下：写出原因，沿用全熔断提醒，等探针恢复再继续。
        if (probeOn) {
          await stopForProbe(got.detail, mark);
          continue;
        }
        await rt.park('没有可用的路由', got.detail, 'stuck', 'other', undefined, {
          code: PARK_CODE_NO_ROUTE,
        });
        avoid = NO_AVOID;
        prefer = undefined;
        droppedDry = false;
        continue;
      }
      // 避让放空之后还是要等（额度、空位）：不死等，照旧用原来的路由，派之前照样探。
      if (droppedDry && missUsable) {
        if (await parkIfModelDown(rt, got.detail)) continue;
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
      // 带着整族避让，选路却只剩等额度或等空位（#2261）：别族在线的路由还空着，先放掉整族避让再选一次。
      // 还派不出才照旧等。老历史没有这个标记：重放时为假，照旧睡到清零，不多一次选路。
      if (
        (got.waitFor === 'quota' || got.waitFor === 'slot') &&
        (merged.families?.length ?? 0) > 0 &&
        !droppedFamilies &&
        patched('avoid-scope-by-cause')
      ) {
        droppedFamilies = true;
        rt.status.lastProblem = RELEASE_FAMILY_WAIT;
        continue;
      }
      // #2392 钉在这里：总时长第二次到顶、rt.note 写完「换一条路由带上进度续一次」之后 continue 回到本循环。
      // 上一段已经收场（不然走不到 note），holdForBudget 的 taskSpend 是 quick 档，撑不到十几个小时。
      // 能冻住 tasks.doing / updated_at、又不插入 runs 的，就是下面这次 pauseForRoute：condition 睡着。
      // 等额度 retryAfterSeconds 封顶 4 小时，连睡几觉就是十几个小时。
      // 现在睡之前先 mirrorRouteWait（#2863，patched('route-wait-mirror')）：把「等路由：<原因>」落库，
      // 原因不变不重复写、变了再写一次；选到路由起会话时 advance 换回动手那一句。
      // taskContinue 不在这个条件里（在途重放不能改谓词）；叫醒靠 taskRouteWake。
      // 新跑的（wall-clock-switch-lands）：不睡，当场停下等人。已经睡在这一觉里的老历史重放时这一标记为假，
      // 仍睡原来那一觉；醒了（继续附带的叫醒、或定时器）再走 wall-clock-switch-wake，下一轮选不出就停下，不睡第二觉。
      // switchWake 为假时不调用 wake 那个标记，避免在途的这一觉把它记成永久的假。
      if (rt.landSwitch && rt.switchWake && patched('wall-clock-switch-wake')) {
        await rt.park(
          WALL_CLOCK_SWITCH_STALL,
          wallClockSwitchStallDetail(got.detail),
          'stuck',
          'other',
          undefined,
          {
            code: PARK_CODE_ROUTE_SWITCH,
          },
        );
        continue;
      }
      if (rt.landSwitch && !rt.switchWake && patched('wall-clock-switch-lands')) {
        await rt.park(
          WALL_CLOCK_SWITCH_STALL,
          wallClockSwitchStallDetail(got.detail),
          'stuck',
          'other',
          undefined,
          {
            code: PARK_CODE_ROUTE_SWITCH,
          },
        );
        continue;
      }
      // 模型暂时不可用之后选路只剩等：不睡。这一睡可以到几小时，任务仍是 running、没有开着的会话，占着名额。
      // 标记为假时这里不调活动，老历史重放的命令和原来一样。
      if (await parkIfModelDown(rt, got.detail)) continue;
      // 睡到下一次选路。等额度且选路给了清零时刻：秒数按那个时刻（上限几小时），不是每 120 秒醒一次。
      // 等空位、熔断仍是短间隔。路由变了（切号切完、切过去的池探通了）会被叫醒当场再选；信号丢了照样按这个时长醒。
      // 步序没变（秒数是选路活动的结果）：老历史重放不用新的 patched 标记。
      // 多张单同时停在这里时，测试不要 await result()（会 unlockTimeSkipping，见 #1764）。
      await rt.mirrorRouteWait(got.detail);
      await rt.pauseForRoute(got.waitFor, got.detail, got.retryAfterSeconds ?? ROUTE_RETRY_SECONDS, mark);
      if (rt.landSwitch && patched('wall-clock-switch-wake')) rt.switchWake = true;
      continue;
    }
    const chosen = await consider(got.route, probeOn, mark);
    if (chosen) return chosen;
  }
}
