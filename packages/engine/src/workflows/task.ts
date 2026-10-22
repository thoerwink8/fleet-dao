// 任务工作流（#632 S2-4；specs/632-三段总调度/方案.md §五）：一张单从被拉起到合并、关单，一条工作流走完。
// 纯编排：每个副作用（读单子、选路、建树、起会话、推分支、开 PR、等 CI、冷验收、合并、关单）都在活动里；这里只管顺序、
// 几轮、碰到失败怎么办、什么时候停下等人。重放安全：不取随机数、不生成编号（会话编号由活动自己起），判断失败怎么办经 decide('failure')。
//
// 按职责拆在同目录：task-runtime.ts（状态、等待、停下等人、失败分流的底座）、task-session.ts（选路 + 动手会话）、
// task-ci.ts（等 CI）、task-verify.ts（冷验收）、task-merge.ts（查路径、挂自动合并、等合并）、task-support.ts（无状态小零件）。
// 这里的 TaskFlow 只留：读交代、动手一轮（建树、读交付、推分支、开 PR）、推上去之后的顺序、收尾。
//
// 一张单的路：读交代 → [选路 → 建树（第一轮）→ 动手会话 → 读交付 → 推分支 → 开 PR（第一轮）→ 等 CI → 冷验收] 最多 3 轮 →
// 碰没碰「改标准」→ 挂自动合并 → 等合并 → 关单、收树。
// 不强制 CI 的仓（patched('repo-ci-policy')，每次走到等 CI 之前现读）：开完 PR 跳过等 CI 和冷验收，查完改标准路径后引擎直接合并。
// 返工只有这几种：没产生提交、CI 红了、合并冲突、验收没过、等合并时必过检查确认仍红；返工意见带进下一轮动手会话。验收最多 2 轮（specs/555）。
// 验收没过、验收还没到 2 轮时，那一轮返工照给，不算进动手 3 轮那一条（patched('verify-rework-own-round')，#1967）：CI 红花掉前两轮时，
// 验收意见也一定交到一轮会话手里，不在「动手 3 轮都没过」上停住。只多给这一次，第 2 轮验收再不过照旧停下。
//
// 停下等人（waiting.kind = human，驾驶舱点「继续」「放弃」发信号）只有这几处，而且每一处都写清卡在哪、要人干什么：
// - 交代不全（缺栏）；没有可用的路由；失败分流判「挂起」（同因连着两次再犯、额度要等很久、没权限……）；
//   登录失效、封号、设备被撤销停的是池不是这张单（patched('auth-reroute')，task-session.ts）：池暂停，单回去选路；
//   只有避开之后一条能派的路由都没有，才挂起，原因写「能派的池都停了」；
// - 动手 3 轮、验收 2 轮都没过；验收做不出来（读不到 diff、没有别家模型、会话没跑成）；
// - 等合并时必过检查连着红、返工 3 轮用完（报警级别 decision，进「要你拍的」，不再等）；
// - 改到了「改标准」的路径（人闸第四类，要创始人同意才挂自动合并）；
// - PR 被关了、PR 的头被别人改了。
// - 挂自动合并时这个头上的检查还在跑，按工作流时间记的 15 分钟期限到了仍没跑完（patched('merge-arm-pending-deadline')）：停下，写明 PR、头、检查名和原始原因。
//   还在等的时候状态写「等检查」，同头变绿后自己再挂，不用人点「继续」。真红仍确认后返工。头变了重走 CI、冷验收和批准。
//   落库和红确认也在这份期限里（patched('merge-arm-pending-bounded-waits')）：慢的那一下到点就停下，不按落库前记下的秒数再睡。
// 「继续」之后从头再试这一步；「放弃」收尾退出（工作树存档后删，PR 和单子不动，由人处理）。
// 动手或验收轮数用尽后再点「继续」（patched('continue-resets-rounds')，#1404）：两轮计数都从 0 再计，并重读单子正文，
// 下一次验收用新正文。同一次继续里上限仍在。这样继续累计超过 3 次就不再清零，停下交给指挥官；
// 再点「继续」由命令行和驾驶舱拒绝（不在工作流里吞掉信号）。老历史没有这个标记，
// 仍只把用尽的那一个计数清掉。
// 总轮数上限（#3603，patched('task-total-rounds')，task-runtime.ts 的 holdAtTotalRounds）：这一代累计动手到 MAX_TOTAL_ROUNDS，
// 再用尽时先贴「本机做」留言交还本机再停下；「继续」不清零累计，不带原因（ContinueCommand.note）的继续原样再停，带原因的才再放 3 轮。
// 停下之前先自动处理一次（决定 0093）：这张单头一回轮数用尽不停下（patched('auto-continue-rounds')，task-runtime.ts 的
// exhaustRounds 回 auto）：轮数清零、重读单子，下一轮动手避开最近的模型和它那一族（rt.avoidModel；别的族派不出退回只避开模型），直接再动手不先重走 CI；之后用尽照旧停下，
// 自动那一次算进 MAX_ROUND_RESETS。推的时候空交付（EMPTY_DELIVERY）这张单里先再派一轮（patched('auto-before-park')）。
// 冷验收和等 CI 同时起（patched('verify-parallel-ci')，deliver 的 startVerify / joinVerify）：CI 不绿就不认验收的结果（不加轮数），
// 并取消那一次验收（patched('verify-cancel-on-ci-red')，dropVerify：省一次验收会话的 token；老历史照旧让它自己跑完）；
// 第 2 轮验收只复核上轮没过的条和这一轮的增量（patched('verify-recheck')，coldVerifyInput 多带 recheck）：老历史没有这个标记，入参和原来一样。
// CI 绿了再等验收、认了才算一轮；两样都过才挂自动合并。
// CI 红了回动手之前（patched('ci-red-review-context')，task-ci.ts）：现读仍有效的正式评审，和失败的检查、摘要、日志一起交下一轮。
// 读不全未核实未交付，不放行、不把没交全的记成已消费。老历史没有这个标记，红了只交 CI 那几行。
// 停下前 PR 已开、头已记录，点「继续」先走 deliver（等 CI、验收、挂自动合并），不先起动手会话（patched('continue-redelivers-open-pr')，#1582）。
// 动手一轮会话跑完但没有提交（#1408，patched('avoid-empty-commit-route')）：下一轮选路避开这条路由；连着第二轮仍没提交，
// 再避开这个模型（认得出族的连这一族，patched('empty-commit-avoid-family')，别的族派不出退回只避开模型）。避开只在这张单里。没有别的候选就照旧用原来的路由，lastProblem 写「没有别的路由可换」，不死等。
// 轮数用尽后点「继续」把避开清掉（和上面的轮数清零同一处）。老历史没有这个标记，下一轮仍不避开。
//
// 改这里之前必须知道：
// - 挂自动合并一定在冷验收通过之后。合并闸认引擎任务流程的 PR（分支 fleet/<单号>-t<8 位>）头上通过的 cold-verify（#555-2、#625），
//   每小时对账的兜底不碰这些分支（jobs/auto-merge-check.ts）；拉单入口在闸或冷验收没接上时不让任何仓接活
//   （jobs/intake.ts 的 MERGE_GATE_REQUIRES_COLD_VERIFY）。头换了（人推过新提交）就对新的头重走 CI 和验收，不原样重新挂：
//   新头上没有 cold-verify，合并闸不会放行。
//   不强制 CI 的仓（patched('repo-ci-policy')）例外：跳过等 CI 和冷验收，查完改标准路径后引擎直接合并。
//   强制 CI 的仓仍是冷验收通过之后才挂自动合并。没把模式传进合并闸时，闸仍按强制拦。
// - 动手会话只试一次（activity-options.ts 的 segment 档）：基础设施的失败由 task-session.ts 按失败分流重试、换路由、挂起，不靠 Temporal 自动再起一遍。
// - 切号停下的动手会话（码 org_switch，#59）不算失败：失败分流 OS1 马上接着干、不记账、不看上一次的原文（不会凑成「同因连挂」）；
//   选路照常选到切过去的那个池，同一棵树、同一个分支重跑这一段，提示词带上被停下的原因（interrupted）。
// - 暂停（#820 片 3，taskPause 信号）只停这一张单、能「继续」：停在检查点（rt.checkpoint，起新会话、选路、起新一步之前），库里 phase=paused、
//   state 仍是 running，不报警；soft 手上这一段做完，hard 把动手会话取消、继续后在原树原分支上重跑（提示词带「被人暂停」，task-session.ts）。
//   检查点只在收到信号时才多调活动，老历史重放不受影响（patched('task-pause')，test/replay.test.ts 的夹具）。
// - 第 2 轮起、动手会话起之前先把最新主线并进任务分支（#1246，task-sync.ts；patched('sync-mainline-before-implement')）：并上了就推、树跟着快进；
//   并出冲突把文件名记进返工意见交给这一轮的会话；没查成记下照旧往下走。验收前不并（并了头就变）。
// - 推分支并主线撞上内容冲突（MERGE_CONFLICT，patched('conflict-handoff-keeps-tree')）：不在 push 这一步里原地重试。
//   内容冲突：树里留着合并的冲突标记，交回下一轮动手会话。合并还没开始（没跟踪的文件挡着）：原反馈留着，让会话自己 git merge 那个提交。
//   交回时 MERGE_HEAD 还在，或 git diff --check（工作区、暂存区，或这次提交进 HEAD 的）还有冲突标记，不算交活、不推。
//   上一轮没解就在反馈里补一句；反馈和上一轮一字不差才挂起，提醒里写冲突文件和工作树路径。
//   会话删掉标记并 git add、没提交时，这一轮可能只读到占位：文件名用上一轮反馈里的，不把占位当成文件名。
//   老历史没有这个标记，照旧在 step 里重试。
// - 推分支被卫生检查拦下（HYGIENE_BLOCKED，patched('hygiene-blocked-handoff')）：不在 push 这一步里原地重推。
//   命中处（文件:行 规则，不带命中原文）作为返工意见退回下一轮动手会话。同一处连续被拦（会话改过、命中处仍一字不差）才停下等人。
//   老历史没有这个标记，照旧在 step 里重推，第二次原文一字不差就挂起。
// - 「放弃」「叫停」都要把正在跑的长活动取消掉（runSegment、coldVerify、waitCi、waitMerged 都心跳，收得到取消）。
// - 返工续会话（决定 0093，patched('rework-resume')）：CI 红、验收没过、冲突、没提交……下一轮动手续上一轮跑成的那个会话
//   （同一棵树；同一路由的执行方式、池、会话用户由 planSegmentResume 判），提示词只补返工意见。连着 RESUME_STREAK_LIMIT 轮续着改
//   还没过，下一轮开新会话，返工意见精炼过（freshSessionFeedback）。轮数用尽点「继续」重读单子后也开新会话。
//   CI 红返工不受 RESUME_STREAK_LIMIT 限制（#3603，patched('ci-rework-keep-resume')），选路点名上一段的路由（task-session.ts）。
// - 冲突引擎先自己并（决定 0093，patched('conflict-self-sync')）：上一轮因「和主线有冲突」返工、树里没留冲突标记时，
//   动手前并最新主线并干净了（git 自动合并）就直接推上去重跑 CI，不派模型、不算一轮；并不干净才交给会话解。
// - 自测（决定 0093，patched('self-check')）：会话交活、交付核对过了，推之前引擎在会话的树里跑仓的测试命令和 tsc（selfCheck）。
//   红了把精炼输出续进同一个会话再改一次，再测一次就推（不论红绿，交给 CI）；没跑成照旧推。最近一次的输出交给冷验收
//   （ColdVerifyInput.testOutput，只给和验收的头对得上的那一份）。
// - PR 说明的「做了什么」取动手会话最后一条回复（#2723，taskPrDid / sessionDidLines，有截断上限）：开 PR 时写进去；
//   第 2 轮起推上去后改 PR 正文换成这一轮的回复（patched('pr-body-from-session')，updatePrBody，没改成不挡原流程）。
//   回复末尾的 fleet-delivery 交付声明（#3406，patched('pr-body-delivery-claim')，parseDeliveryClaim）定「还欠什么」和分片 Refs；
//   只认回复顶层末尾那一个块：没有、非法、截断、声明后面还有内容、在别的代码块/HTML 块/引用/缩进里的示例都写「交付范围未核」，不写「无」；回复里别的单的引用中和后才进「做了什么」（answerForPrDid）。
//   只让说明更保守，不改关单、合并。
// - 重活先出方案（#2755，patched('plan-first-heavy')，planFirst）：heavyweight 第一轮先跑一段只读会话，最后一条回复只回方案 JSON，
//   格式不对续进会话重出一次，还不对照常动手；认下了带进意见、动手续这个会话。
// - 体量预算（#2755，Limits.prLineBudget，0 = 关；patched('pr-line-budget')，withinLineBudget）：推之前看交的头相对主线新增几行，
//   超了第一次打回收窄，第二次停下等人并附拆单建议，人点「继续」照推。
//   体量关口重评（#3249，patched('line-budget-remeasure-v1') 只在 taskRemeasureLineBudget Update 处理里问）：停点身份由 park() 记（不改命令序，
//   旧历史里停下的单也有），可信重测通过只放行「这一次停点的这一份交付」，不设 budgetApproved、不增加继续数；人点「继续」优先，仍是原授权语义。
// - 每一轮收场记进库（#2762，patched('round-outcome')，startRound / endRound）：返工、合并、放弃叫停时各记一行 task_rounds
//   （怎么结束的按 lastProblem 认，roundOutcomeOf；档位、首派模型、PR 新增行数），每日简报「流程健康」按它算。记不成不挡原流程。
// - 交活没提交续一次（#2722，patched('commit-nudge-same-round')，nudgeCommit）：会话收场时没提交、或树里有剩（常见是把测试丢到后台就结束了），
//   读完交付先续同一个会话一次让它提交，不算一轮；续不上（planResume 判开新会话）就不续。续了还没交干净，照旧返工进下一轮。
// - 全程模式（#2826，patched('flow-mode')，task-flow.ts 定模式）：全程的单 CI 红、冲突、验收被拒都回到动手、续同一个会话
//   （不按 RESUME_STREAK_LIMIT 清空；续不上开新会话带同样的意见），不算新的一轮（rt.round 停在 1）；上限换成交付 MAX_FULL_PUSHES 次、
//   验收被拒 MAX_VERIFY_ROUNDS 次，到了停下等人（fullLimits，不走自动续）。推分支、开 PR、等 CI、冷验收、合并闸和三段一模一样。
//   三段的单（和老历史 rt.flowMode 为 null）走原来的路，一步不差。
// - 收树先核对界面截图（#2983，patched('shots-delivery')，cleanup 给 removeWorktree 带 shots）：远端 shots/<单号> 读不到就存进受限归档，
//   存不成不删树。合并后 PR 说明代码、图片分开写（shotsPrLines，多一次 updatePrBody），有欠项进「还欠什么」。老历史不带 shots，不多调。
// - 合并不等于关单（#3037，patched('acceptance-duty')，finish）：冷验收转给人的验收条（outOfScope）不挡合并，收尾读库里旧的验收责任
//   （acceptanceDuties 活动，只读）并上这条工作流记着的转人验收条，还有就不 closeIssue：单子留着，PR 说明「需求」改 Refs 标分片、原验收项进
//   「还欠什么」。#3591（决定 0113）起不再写 acceptance_duties（活动只读、record 恒空），步序不变。读不成按失败分流重试或停下，
//   不当成没有。没有 outOfScope 的单照旧关。老历史没有 acceptance-duty 标记，照旧直接关单。

import { CHECKS_RED_PREFIX } from '@fleet-dao/shared/checks-red';
import { clipCauseSummary } from '@fleet-dao/shared/run-cause';
import { parseTaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import {
  allHandlersFinished,
  CancellationScope,
  condition,
  isCancellation,
  log,
  patched,
  workflowInfo,
} from '@temporalio/workflow';
import type { EngineActivities } from '../activity-options.ts';
import type { Limits } from '../limits.ts';
import type {
  AcceptanceDuty,
  PrBody,
  RecordRoundInput,
  RemoveWorktreeResult,
  RoundOutcome,
  Worktree,
} from '../ports.ts';
import { reviewFeedbackLines } from '../review-feedback.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import type { TierDecision } from '../runner/tier.ts';
import { SELF_CHECK_DOING } from '../self-check-budget.ts';
import {
  type AbandonCommand,
  type DeliveryRead,
  MAX_FULL_PUSHES,
  MAX_IMPLEMENT_ROUNDS,
  MAX_MAIN_SYNCS,
  MAX_VERIFY_ROUNDS,
  type TaskRun,
  type TaskWorkflowInput,
  taskBranch,
} from '../task-contract.ts';
import { activitiesFor, iso, limitsFor } from './kit.ts';
import { parkedMeasurementBase } from './task-budget-remeasure.ts';
import { readRepoCiPolicy, waitForCi, waitForCiPolicy } from './task-ci.ts';
import { armAndWaitMerged, guardedPaths } from './task-merge.ts';
import { PermissionPushHandback, TaskRuntime } from './task-runtime.ts';
import { planResume, writeSession } from './task-session.ts';
import {
  Abandoned,
  AutoEscape,
  answerForPrDid,
  avoidableFamily,
  ConflictHandoff,
  commitNudgeFeedback,
  conflictFilesForHandoff,
  conflictHandoffLine,
  deliveryClaimForPrBody,
  deliveryClaimPrFields,
  EMPTY_DELIVERY_CODE,
  emptyCommitFeedback,
  freshSessionFeedback,
  HygieneHandoff,
  hygieneFeedbackLine,
  hygieneSpotKey,
  hygieneSpots,
  MergedTask,
  noteEmptyCommit,
  overBudgetLine,
  parsePlan,
  planGoLine,
  planRetryLine,
  RESUME_STREAK_LIMIT,
  reworkCauseOf,
  roundOutcomeOf,
  SELF_CHECK_RED_LINE,
  type SegmentCauseNote,
  SKIP_CI_PR_VERIFIED,
  SKIP_CI_SELF_VERIFY,
  selfCheckText,
  shotsPrLines,
  splitSuggestion,
  stoppedOutcomeOf,
  type TaskPlan,
  taskPrDid,
  withFamily,
} from './task-support.ts';
import { syncMainlineBeforeImplement } from './task-sync.ts';
import { coldVerifyPr, handReviewChanges, verifyAlongsideCi } from './task-verify.ts';

/** 和等 CI 同时起的那一次冷验收：结果（不抛）和起的时候的头。 */
interface EarlyVerify {
  run: ReturnType<typeof verifyAlongsideCi>;
  head: string | null;
  contract?: string | undefined;
}

class TaskFlow {
  private readonly rt: TaskRuntime;
  /** 这个仓现在的 CI 模式。只在 patched('repo-ci-policy') 里更新；老历史保持 force，开 PR 的验证句不变。 */
  private ciMode: 'force' | 'off' = 'force';
  /** 刚从冷验收没过回来返工（下一轮动手开头读一次就清掉）：验收没到上限时这一轮动手不受动手轮数上限（#1967）。 */
  private verifyRework = false;
  /** 上一轮的冲突留在了树里（冲突标记交给会话解）：这时并主线不算引擎自己解掉了。 */
  private conflictInTree = false;
  /** 冲突返工轮引擎自己并干净、没派模型的次数（决定 0093）：到 MAX_MAIN_SYNCS 就交给会话，不无限转。 */
  private conflictSelfSyncs = 0;
  /** 推分支撞上空交付、已经自动重派过一次动手（决定 0093）：再撞上就停下等人。 */
  private emptyDeliveryRedone = false;
  /** 上一回推分支被卫生检查拦下的命中处（排好序）。同一处再拦才停下；推上去了就清掉。 */
  private lastHygieneSpots: string | null = null;
  /** 有一轮开始了、还没记收场（#2762）：一轮只记一次。 */
  private roundOpen = false;
  /** 重活先出方案（#2755）：这张单试过没有、认下的方案。 */
  private planTried = false;
  private plan: TaskPlan | null = null;
  /** 体量预算（#2755）：打回过一次没有；人看过点「继续」后这张单不再判。 */
  private budgetBounced = false;
  private budgetApproved = false;

  constructor(input: TaskWorkflowInput, acts: EngineActivities, limits: Limits) {
    this.rt = new TaskRuntime(input, acts, limits);
  }

  async run(): Promise<TaskRun> {
    const rt = this.rt;
    let { brief, tier } = await this.readBrief();
    rt.status.tier = tier;
    rt.reloadBrief = async () => {
      // 耗尽后继续也走同一接纳口；先覆盖 brief 会让下一边界认不出合同修订。
      if (patched('task-contract-revisions-v1')) {
        await rt.refreshContract('轮数耗尽后重读');
        return;
      }
      brief = (await this.readBrief()).brief;
    };
    // before 必须由调用方明说，不能给默认值：旧历史最初读到的交代没有合同（before 为 undefined），
    // 默认参数会把显式传入的 undefined 换成刚读回的新合同，把「第一次接纳」误判成没变，少调度一次 readCiReviews（#3402）。
    const acceptContract = (got: TaskBrief, boundary: string, before: TaskBrief['contract'] | undefined) => {
      const next = got.contract;
      if (next?.version !== 1 || !/^[a-f0-9]{64}$/.test(next.sha256))
        throw new Error('正式合同版本或摘要未核实');
      rt.contractVersioned = true;
      rt.status.contract = next;
      rt.brief = got;
      brief = got;
      tier = got.tier;
      rt.status.tier = tier;
      const changed = before?.version !== next.version || before?.sha256 !== next.sha256;
      if (!changed) return false;
      rt.verifyRecheck = null;
      rt.verifyProblems = [];
      rt.guardApproval = null;
      rt.contractRevision = { reviews: [] };
      this.plan = null;
      this.budgetApproved = false;
      const revision = `正式需求已修订（合同 v1 ${next.sha256}；${boundary}）。当前交代替代旧需求和旧验收条，仍有效正式评审继续遵守。`;
      rt.feedback = [
        ...rt.feedback.filter(
          (line) => !line.startsWith('验收没过：') && !line.startsWith('正式需求已修订（合同'),
        ),
        revision,
      ];
      return true;
    };
    rt.acceptHandbackContract = (got) => {
      acceptContract(got, '权限推送原停点返工', rt.brief?.contract);
    };
    rt.refreshContract = async (boundary) => {
      if (!patched('task-contract-revisions-v1')) return false;
      const before = rt.brief?.contract;
      const got = await this.readBrief(true);
      if (!acceptContract(got.brief, boundary, before)) return false;
      const next = got.brief.contract;
      if (!next) throw new Error('正式合同摘要未核实');
      if (rt.prNumber !== null && rt.head !== null) {
        for (;;) {
          const snapshot = await rt.step('readCiReviews', () =>
            rt.acts.readCiReviews({
              schemaVersion: 1,
              taskId: rt.input.taskId,
              repo: rt.input.repo,
              prNumber: rt.prNumber as number,
              branch: rt.branch,
              expectedHead: rt.head as string,
            }),
          );
          if (!snapshot.delivered) {
            await rt.park('正式评审未核实、未交付', snapshot.reason);
            if (snapshot.headMoved) rt.head = snapshot.headMoved;
            continue;
          }
          // 修订不清 reviewsHanded；仍有效的正式 CR 连原文再交付，不能把“交过”当“解决”。
          const lines = snapshot.reviews.flatMap((review) => reviewFeedbackLines(review, rt.head, false));
          rt.contractRevision = { reviews: lines };
          rt.feedback = [...lines, ...rt.feedback];
          break;
        }
      }
      await rt.note(
        `安全边界接纳正式合同 v1 ${next.sha256}（${boundary}），旧冷验收和批准资格失效；累计预算与轮数保留`,
      );
      return true;
    };
    rt.branch = taskBranch(rt.input.issueNumber, workflowInfo().runId);
    await rt.mirror('running');

    for (;;) {
      // v2 在 park 内接纳快照后才离开。收场 IO 期间外部又改正文，先过既有合同边界再有新动作。
      if (rt.handbackContractBoundary) {
        await rt.refreshContract('原位返工动手前');
        rt.handbackContractBoundary = false;
      }
      await rt.checkpoint();
      await rt.refreshContract('动手前');
      // 验收没过要返工、验收还没到 2 轮的上限：这一轮动手照给（#1967：CI 红了 2 轮、第 3 轮才验，验收意见还没交给会话就因
      // 动手轮数用完停下等了 8 小时）。只多给一次：第 2 轮验收再不过 verifyRound 就到顶，照旧停下。老历史没有这个标记。
      const verifyGrace =
        this.verifyRework && rt.verifyRound < MAX_VERIFY_ROUNDS && patched('verify-rework-own-round');
      this.verifyRework = false;
      // 全程（#2826）：CI 红、冲突、验收被拒回来续同一个会话、不算新的一轮；上限是交付 MAX_FULL_PUSHES 次、验收被拒 2 次
      const full = rt.flowMode === 'full';
      if (full) {
        await this.fullLimits();
      } else if (rt.round >= MAX_IMPLEMENT_ROUNDS && !verifyGrace) {
        const problems = rt.feedback.join('；') || '（没有）';
        // 等合并检查红了交回的意见以「检查红了：」开头。轮数用完进「要你拍的」。
        // 前缀不在就不问 patched：CI 红了仍是「动手 N 轮都没过」，老历史重放不多一个标记。
        const mergeChecksRed =
          rt.feedback.some((line) => line.startsWith(CHECKS_RED_PREFIX)) && patched('merge-wait-red-checks');
        const mode = await rt.exhaustRounds(
          mergeChecksRed
            ? `检查红了，返工 ${MAX_IMPLEMENT_ROUNDS} 轮用完`
            : `动手 ${MAX_IMPLEMENT_ROUNDS} 轮都没过`,
          `最近的返工意见：${problems}。点「继续」再给一整轮；或「放弃」。`,
          `最近的返工意见：${problems}。点「继续」后动手和验收轮数都从 0 再计；或「放弃」。`,
          mergeChecksRed ? 'decision' : 'stuck',
        );
        if (mode === 'legacy') rt.round = 0;
        // 自动续的那一次（决定 0093）：没停下等人，意见还在手上，直接换路由再动手，不先重走 CI 和验收
        // 停下前 PR 已开、头已记录：代码多半已经完整（停下常是 CI 台的基础设施问题）。点「继续」先看这个 PR 现在的 CI 和验收，
        // 不再起一轮没东西可交的动手会话。老历史没有这个标记，照旧先起会话。
        if (
          mode !== 'auto' &&
          rt.prNumber !== null &&
          rt.head !== null &&
          patched('continue-redelivers-open-pr')
        ) {
          // 继续后先重走交付的这一次也算一轮收场（#2762）：合了记 merged，又返工记返工的原因
          this.startRound();
          const redelivered = await this.deliver(brief);
          if (redelivered !== 'rework') return this.finish(redelivered.commit);
          await this.endRound(roundOutcomeOf('deliver', rt.status.lastProblem, rt.feedback));
          continue;
        }
      }
      if (!full) rt.round += 1;
      // 累计轮数（#3603）：每回到动手一次算一轮，三段、全程都算，继续不清零（引擎自己并掉冲突、不派模型的那一轮在 implement 里退回）
      rt.totalRounds += 1;
      this.startRound();
      const implemented = await this.implement(brief, tier);
      // 全程的单（第一段里才定模式，所以在动手之后数）：回到动手一次算交付一次
      if (rt.flowMode === 'full') rt.fullPushes += 1;
      if (!implemented) {
        await this.endRound(roundOutcomeOf('implement', rt.status.lastProblem, rt.feedback));
        rt.acceptPushHandback();
        continue;
      }

      const delivered = await this.deliver(brief);
      if (delivered === 'rework') {
        await this.endRound(roundOutcomeOf('deliver', rt.status.lastProblem, rt.feedback));
        continue;
      }
      return this.finish(delivered.commit);
    }
  }

  /**
   * 全程的单回来再修之前看上限（#2826）：冷验收被拒到 MAX_VERIFY_ROUNDS 次、或已经交付 MAX_FULL_PUSHES 次，停下等人（token 预算照旧在起会话前查）。
   * 人点「继续」：两样都清零、重读单子，接着续同一个会话；不要了点「放弃」。没到上限什么都不做。
   */
  private async fullLimits(): Promise<void> {
    const rt = this.rt;
    const rejected = rt.status.lastProblem === '验收没过' && rt.verifyRound >= MAX_VERIFY_ROUNDS;
    if (!rejected && rt.fullPushes < MAX_FULL_PUSHES) return;
    const problems = rt.feedback.join('；') || '（没有）';
    const title = rejected
      ? `全程：冷验收被拒 ${MAX_VERIFY_ROUNDS} 次`
      : `全程：推送 ${MAX_FULL_PUSHES} 次还没合`;
    const detail = `最近的意见：${problems}。点「继续」两样都从 0 再计、重读单子，接着续同一个会话修；或「放弃」。`;
    // 累计动手到了总轮数上限（#3603）：交还本机，等带原因的「继续」，不走下面的普通停下
    if (!(await rt.holdAtTotalRounds(title, detail, 'stuck'))) {
      await rt.park(title, detail, 'stuck', 'rounds');
    }
    rt.fullPushes = 0;
    rt.verifyRound = 0;
    await rt.reloadBrief();
  }

  /** 一轮开始（#2762）：清掉上一轮的首派模型，记下有一轮没收场。纯状态。 */
  private startRound(): void {
    this.rt.roundFirstModel = null;
    this.rt.roundStartedAt = iso(Date.now());
    this.roundOpen = true;
  }

  /**
   * 一轮收场（#2762，patched('round-outcome')）：怎么结束的、档位、首派模型、PR 新增行数记进库（task_rounds），每日简报「流程健康」按它算。
   * 一轮只记一次；记不成只写日志，不挡原流程。放弃、叫停时也要记，所以不进可取消的范围。老历史没有这个标记，不记。
   */
  private async endRound(outcome: RoundOutcome): Promise<void> {
    const rt = this.rt;
    if (!this.roundOpen) return;
    this.roundOpen = false;
    if (!patched('round-outcome')) return;
    rt.roundSeq += 1;
    const input: RecordRoundInput = {
      taskId: rt.input.taskId,
      workflowId: workflowInfo().workflowId,
      seq: rt.roundSeq,
      round: rt.round,
      outcome,
      ...(rt.status.tier ? { tier: rt.status.tier.tier } : {}),
      ...(rt.roundFirstModel ? { firstModel: rt.roundFirstModel } : {}),
      ...(rt.addedLines !== null ? { addedLines: rt.addedLines } : {}),
      // 这张单走的流程（#2826）：定过模式才有（老历史没有）
      ...(rt.flowMode !== null ? { flowMode: rt.flowMode } : {}),
      // 回合视图要的开始时刻、为什么返工（#3140）：标记 run-cause-fields 在新历史里才为真，老历史入参和原来一样
      ...this.roundExtras(outcome),
    };
    try {
      await CancellationScope.nonCancellable(() => rt.acts.recordRound(input));
    } catch (error) {
      log.warn('这一轮怎么收场的没记进库，照旧往下走', { error: String(error), outcome });
    }
  }

  /**
   * 一轮的开始时刻和返工摘要（#3140）。返工摘要只在这一轮是为返工收场时写（做成了、放弃叫停、超时没有「下一轮要改什么」）：
   * 取返工意见（rt.feedback）逐条连起来，没有意见退回写 lastProblem。
   */
  private roundExtras(outcome: RoundOutcome): Pick<RecordRoundInput, 'startedAt' | 'reworkSummary'> {
    const rt = this.rt;
    if (!patched('run-cause-fields')) return {};
    const rework = outcome !== 'merged' && outcome !== 'stopped' && outcome !== 'timeout';
    const text = rt.feedback.join('；').trim() || (rt.status.lastProblem ?? '').trim();
    return {
      ...(rt.roundStartedAt !== null ? { startedAt: rt.roundStartedAt } : {}),
      ...(rework && text ? { reworkSummary: clipCauseSummary(text) } : {}),
    };
  }

  /**
   * 推上去以后的路：等 CI → 冷验收 → 查路径 → 挂自动合并、等合并。回 'rework'＝要回去再动手一轮（意见已记下）。
   * 等合并时 PR 的头被别人改了、人看过点「继续」：新的头上没有验收状态，合并闸（引擎任务流程的 PR 要有通过的 cold-verify）
   * 不会放行，原样重新挂只会永远等下去——所以回到等 CI，对新的头把这条路重走一遍。
   */
  private async deliver(brief: TaskBrief): Promise<'rework' | { commit?: string | undefined }> {
    const rt = this.rt;
    for (;;) {
      await rt.checkpoint();
      await rt.refreshContract('交付/冷验收前');
      // 老历史没有这个标记：下面这一支的活动顺序和原来一字不差。
      if (!patched('repo-ci-policy')) {
        const ci = await waitForCi(rt);
        if (ci.kind === 'merged') return { commit: ci.mergeCommit };
        if (ci.kind === 'rework') return 'rework';

        const verdict = await this.verifyOnce(brief);
        if (verdict === 'rework') return 'rework';
        if (verdict === 'head_moved') {
          rt.verifyRound = 0; // 头换了，验收对新的头重新数轮
          continue;
        }

        await guardedPaths(rt);
        await this.prepareAcceptance();
        const merged = await armAndWaitMerged(rt);
        if (merged.kind === 'merged') return { commit: merged.commit };
        // 等合并时 PR 和主线真有冲突（#1838）：返工意见已记下，交回下一轮动手会话解冲突，不回等 CI。
        // 检查红了交回动手（#1983）：上一轮验收是过的。轮数留着的话，下一轮会在验收上限上被误判成「验收没过」。
        if (merged.kind === 'rework') {
          if (rt.feedback.some((line) => line.startsWith(CHECKS_RED_PREFIX))) rt.verifyRound = 0;
          return 'rework';
        }
        rt.verifyRound = 0; // 头换了，验收对新的头重新数轮
        continue;
      }

      const mode = await readRepoCiPolicy(rt);
      this.ciMode = mode;
      if (mode === 'off') {
        const direct = await this.mergeNowAndFinish(rt);
        if (direct === 'rework') return 'rework';
        if (direct === 'head_moved') continue;
        return direct;
      }

      // 冷验收和等 CI 同时起（决定 0093）：CI 不绿就不认验收那一边（取消它、不加轮数）；CI 绿了再等验收的结果
      // 验收轮数已经到顶（要先自动续或停下等人）的那一回不并行：用尽的处理不该和 CI 搅在一起
      const early =
        rt.verifyRound < MAX_VERIFY_ROUNDS && patched('verify-parallel-ci') ? this.startVerify(brief) : null;
      const ci = await waitForCiPolicy(rt);
      if (ci.kind === 'merged' && early && patched('settle-merged-task-checkpoint')) {
        // 外部合并不杀仍活的验收；只接同一个会话到终态，再核真实 merged/idle 与保全。
        await early.run.result;
        await rt.checkpoint();
        return { commit: ci.mergeCommit };
      }
      if (ci.kind !== 'green' && early && patched('settle-merged-task-checkpoint')) {
        // CI 红/未知也可能落后于外部合并；真正取消旧验收前现读，已合则自然等原会话。
        const prNumber = rt.prNumber;
        const expectedHead = rt.head;
        if (prNumber === null || expectedHead === null) throw new Error('并行验收缺少 PR 身份');
        const observed = await rt.step('readMergedTask', () =>
          rt.acts.readMergedTask({
            schemaVersion: 1,
            repo: { owner: rt.input.repo.owner, name: rt.input.repo.name },
            prNumber,
            expectedHead,
          }),
        );
        if (!observed) this.dropVerify(early);
        await early.run.result;
        await rt.checkpoint();
      } else if (ci.kind !== 'green') {
        this.dropVerify(early);
      }
      if (ci.kind === 'merged') return { commit: ci.mergeCommit };
      if (ci.kind === 'rework') return 'rework';
      if (ci.kind === 'skip') {
        const direct = await this.mergeNowAndFinish(rt);
        if (direct === 'rework') return 'rework';
        if (direct === 'head_moved') continue;
        return direct;
      }

      // 等 CI 的这段时间里仓可能切成不强制：绿了也不再做冷验收。
      const again = await readRepoCiPolicy(rt);
      this.ciMode = again;
      if (again === 'off') {
        if (early && patched('settle-merged-task-checkpoint')) {
          const prNumber = rt.prNumber;
          const expectedHead = rt.head;
          if (prNumber === null || expectedHead === null) throw new Error('并行验收缺少 PR 身份');
          const observed = await rt.step('readMergedTask', () =>
            rt.acts.readMergedTask({
              schemaVersion: 1,
              repo: { owner: rt.input.repo.owner, name: rt.input.repo.name },
              prNumber,
              expectedHead,
            }),
          );
          if (!observed) this.dropVerify(early);
          await early.run.result;
          await rt.checkpoint();
        } else {
          this.dropVerify(early);
        }
        const direct = await this.mergeNowAndFinish(rt);
        if (direct === 'rework') return 'rework';
        if (direct === 'head_moved') continue;
        return direct;
      }

      const verdict = early ? await this.joinVerify(early, brief) : await this.verifyOnce(brief);
      if (verdict === 'rework') {
        this.verifyRework = true;
        return 'rework';
      }
      if (verdict === 'head_moved') {
        rt.verifyRound = 0;
        continue;
      }

      await guardedPaths(rt);
      await this.prepareAcceptance();
      const merged = await armAndWaitMerged(rt);
      if (merged.kind === 'merged') return { commit: merged.commit };
      // 等合并时 PR 和主线真有冲突（#1838）：返工意见已记下，交回下一轮动手会话解冲突，不回等 CI。
      // 检查红了交回动手（#1983）：上一轮验收是过的。轮数留着的话，下一轮会在验收上限上被误判成「验收没过」。
      if (merged.kind === 'rework') {
        if (rt.feedback.some((line) => line.startsWith(CHECKS_RED_PREFIX))) rt.verifyRound = 0;
        return 'rework';
      }
      rt.verifyRound = 0; // 头换了，验收对新的头重新数轮
    }
  }

  /** 和等 CI 同时起的冷验收（决定 0093）：只调一次活动、不动状态；记下起的时候的头，CI 收场后据此认不认。 */
  private startVerify(brief: TaskBrief): EarlyVerify {
    const head = this.rt.head;
    return { run: verifyAlongsideCi(this.rt, brief), head, contract: this.rt.brief?.contract?.sha256 };
  }

  /**
   * CI 不绿（红了、冲突、已合、仓切成不强制）：旁边那一次验收的结果反正不认，取消它，省一次验收会话的 token（决定 0093）。
   * 已经跑完的再取消不发命令（见 AlongsideVerify.cancel）。老历史没有这个标记：照旧让它自己跑完。
   */
  private dropVerify(early: EarlyVerify | null): void {
    if (early && patched('verify-cancel-on-ci-red')) early.run.cancel();
  }

  /**
   * CI 绿了，认验收那一边的结果。头在等 CI 时被引擎并主线换掉了：验的是旧头，不认，对新头串行再验一次（CI 那一边最后等绿的就是新头）。
   * 认了的结果交给串行验收当第一轮用：别人换了头、做不出来、这会儿验不了，都和串行时一样停下或等（不再白调一次活动）。认了才算一轮。
   */
  private async joinVerify(early: EarlyVerify, brief: TaskBrief): Promise<'pass' | 'rework' | 'head_moved'> {
    const got = await early.run.result;
    if (!got.ok) {
      if (got.error instanceof Abandoned || got.error instanceof MergedTask || isCancellation(got.error))
        throw got.error;
      return this.verifyOnce(brief);
    }
    if (this.rt.head !== early.head) return this.verifyOnce(brief);
    await this.rt.refreshContract('并行验收接纳前');
    if (this.rt.contractVersioned && this.rt.brief?.contract?.sha256 !== early.contract) {
      this.rt.verifyRound += 1; // 已实际启动的旧合同验收照算，修订不能重新领取轮数。
      return this.verifyOnce(this.rt.brief ?? brief);
    }
    return coldVerifyPr(this.rt, brief, got.res);
  }

  /** 串行验一次（头被换了当场停下等人，没过当场记返工意见）。 */
  private verifyOnce(brief: TaskBrief): Promise<'pass' | 'rework' | 'head_moved'> {
    return coldVerifyPr(this.rt, brief);
  }

  /** 不强制 CI：查改标准路径（碰到照旧停下等人），然后引擎直接合并。冲突交回动手会话。 */
  private async mergeNowAndFinish(
    rt: TaskRuntime,
  ): Promise<'rework' | 'head_moved' | { commit?: string | undefined }> {
    await this.prepareAcceptance();
    await guardedPaths(rt);
    const prNumber = rt.prNumber;
    if (prNumber === null || rt.head === null) throw new Error('合并之前还没有 PR');
    for (;;) {
      if (await rt.refreshContract('直接合并前')) return 'rework';
      await rt.advance('merge', `PR #${prNumber} 不强制 CI，直接合并`);
      const head: string = rt.head;
      const r = await rt.step('mergeNow', () =>
        rt.acts.mergeNow({
          schemaVersion: 1,
          repo: rt.input.repo,
          prNumber,
          expectedHead: head,
          ...rt.contractGuard(),
          ...(rt.mainSyncs > 0 ? { syncedBehind: rt.mainSyncs } : {}),
        }),
      );
      if (r.contractChanged) {
        await rt.refreshContract('直接合并活动发现修订');
        return 'rework';
      }
      if (r.merged) return { commit: r.mergeCommit };
      // 不强制 CI 也不跑冷验收：合之前现读到还挂着的正式「要求改」（#2991）就不合，交给工人或停下等审查者（点「继续」回来再读再合）。
      // 老历史的活动结果里没有 reviewChanges，进不了这一支、不打标记
      if ((r.reviewChanges?.length ?? 0) > 0 && patched('merge-review-changes')) {
        const next = await handReviewChanges(
          rt,
          r.reviewChanges ?? [],
          { pass: true, problems: [] },
          'merge',
        );
        if (next === 'rework') return 'rework';
        continue;
      }
      if (r.reason === 'conflict') {
        rt.feedback = [r.detail ?? `PR #${prNumber} 和主线冲突，解完再交`];
        rt.status.lastProblem = '和主线有冲突';
        return 'rework';
      }
      if (r.headMoved !== undefined && r.syncedMain === true) {
        rt.mainSyncs += 1;
        rt.status.lastProblem = r.detail ?? `PR #${prNumber} 落后主线，已同步`;
        rt.head = r.headMoved;
        return 'head_moved';
      }
      if (r.headMoved !== undefined || r.reason === 'head_moved') {
        const moved = r.headMoved ?? head;
        await rt.park(
          'PR 的头被别人改了',
          `现在的头是 ${moved}，不是引擎推上去的 ${head}。点「继续」后按这个仓现在的 CI 模式接着做；不要了点「放弃」。`,
        );
        if (r.headMoved !== undefined) rt.head = r.headMoved;
        return 'head_moved';
      }
      if (await rt.parkMainSyncBudget(r.mainSyncBudgetExhausted, r.detail ?? '同步主线次数已到上限'))
        continue;
      // 结构化拒绝（关了、基线不对、合到了别的头）不是「自动合并没挂上」：法国发了新版也不续。
      // 抛出去的错仍走上面 step 的失败分流（认证、权限是 other，其余合并步是 unarmed）。
      // 停法只进查询，不改报警活动的入参，老历史重放不变。
      await rt.park('直接合并没成', r.detail ?? 'GitHub 没说为什么', 'stuck', 'other');
    }
  }

  /** 读交代：缺栏就停下等人补，补了点「继续」再读。 */
  private async readBrief(boundary = false): Promise<{ brief: TaskBrief; tier: TierDecision }> {
    const rt = this.rt;
    for (;;) {
      rt.set('brief', '读单子和需求文档');
      const got = await rt.step('readTaskBrief', () =>
        rt.acts.readTaskBrief({
          schemaVersion: 1,
          repo: { owner: rt.input.repo.owner, name: rt.input.repo.name },
          issueNumber: rt.input.issueNumber,
          ...(boundary ? { checkContract: true as const } : {}),
          ...(boundary && rt.prNumber !== null
            ? {
                contractGuard: {
                  prNumber: rt.prNumber,
                  ...(rt.brief?.contract ? { expected: rt.brief.contract } : {}),
                },
              }
            : {}),
        }),
      );
      if (got.ok) {
        if (
          boundary &&
          (got.brief.contract?.version !== 1 || !/^[a-f0-9]{64}$/.test(got.brief.contract.sha256))
        ) {
          await rt.park(
            '正式合同未核实',
            '安全边界读回的正式合同缺摘要或规范版本未知，不动手、不验收、不合并',
          );
          continue;
        }
        rt.brief = got.brief;
        return { brief: got.brief, tier: got.brief.tier };
      }
      await rt.park('单子的交代不全，没法动手', got.problems.map((p) => `【${p.field}】${p.why}`).join('\n'));
    }
  }

  /** 一轮动手：选路 → 建树 → 会话 → 读交付 → 推分支 → 开 PR。回 false＝这一轮要返工（意见已记下）。 */
  private async implement(brief: TaskBrief, tier: TierDecision): Promise<boolean> {
    const rt = this.rt;
    // 老历史没有这个标记：不读模式、不改提示、开 PR 的验证句仍是原来那句。
    if (patched('repo-ci-policy')) {
      this.ciMode = await readRepoCiPolicy(rt);
      if (this.ciMode === 'off' && !rt.feedback.includes(SKIP_CI_SELF_VERIFY)) {
        rt.feedback = [SKIP_CI_SELF_VERIFY, ...rt.feedback];
      }
    }
    rt.set('implement', `动手第 ${rt.round} 轮`);
    const wt = await this.ensureWorktree();
    // 上一轮因为和主线冲突返工、冲突没留在树里：先看引擎自己并不并得干净
    const conflictRework = rt.status.lastProblem === '和主线有冲突' && !this.conflictInTree;
    this.conflictInTree = false;
    // 机械解（#3428）和自己并共用 MAX_MAIN_SYNCS 的上限：次数到了就不再试，交给会话
    const attempt = await syncMainlineBeforeImplement(rt, {
      mechanical: conflictRework && this.conflictSelfSyncs < MAX_MAIN_SYNCS,
    });
    const synced = attempt.result;
    if (
      conflictRework &&
      synced === 'merged' &&
      this.conflictSelfSyncs < MAX_MAIN_SYNCS &&
      patched('conflict-self-sync')
    ) {
      // 并干净了、已经推上去（syncMainline 并完就推）：不派模型，直接重跑 CI；这一轮不算动手的轮数
      this.conflictSelfSyncs += 1;
      rt.round -= 1;
      rt.totalRounds -= 1;
      rt.feedback = [];
      rt.status.lastProblem = null;
      await rt.advance(
        'implement',
        `和主线的冲突引擎自己并掉了（${attempt.mechanicalNote ?? 'git 自动合并'}），不派模型，PR #${rt.prNumber} 重跑 CI`,
      );
      return true;
    }
    // 这一轮第一笔动手为什么起（#3140）：上一轮留下了问题就是返工，按问题认哪一类；方案那几笔另记「出方案」
    const startCause = reworkCauseOf(rt.status.lastProblem, rt.feedback);
    this.planReworkResume(startCause);
    // 重活第一轮先出方案（#2755）。老历史没有这个标记，照旧直接动手
    if (tier.tier === 'heavyweight' && rt.round === 1 && !this.planTried && patched('plan-first-heavy')) {
      await this.planFirst(brief, tier, wt);
    }
    await writeSession(rt, brief, tier, wt, { cause: startCause });

    let delivery = await this.readDelivery(wt);
    delivery = await this.nudgeCommit(brief, tier, wt, delivery);
    // 自测：交付核对过了再跑（没提交、有冲突的照旧返工，不白跑测试）
    if (this.deliveredClean(delivery) && patched('self-check')) {
      const first = await this.selfCheck(wt, delivery.head);
      const last = rt.lastSession;
      if (first === 'red' && last) {
        // 红了：精炼输出续进刚收场的那个会话再改一次。这一次不算返工的一轮，也不算连着续的次数
        const streak = rt.resumeStreak;
        rt.feedback = [`${SELF_CHECK_RED_LINE}\n${rt.selfCheckOutput?.text ?? ''}`];
        rt.resumeFrom = { previous: { runId: last.runId }, worktreePath: last.worktreePath };
        await rt.advance('implement', `第 ${rt.round} 轮：自测没过，续进会话再改一次`);
        await writeSession(rt, brief, tier, wt, {
          cause: { cause: 'self_check_fix', summary: rt.selfCheckOutput?.text ?? SELF_CHECK_RED_LINE },
        });
        rt.resumeStreak = streak;
        delivery = await this.readDelivery(wt);
        // 改完再测一次只为把输出交给验收：不论红绿都推，交给 CI
        if (this.deliveredClean(delivery)) await this.selfCheck(wt, delivery.head);
      }
    }
    // 老历史里读交付的结果没有 leftover、conflicts：当作没有
    const conflicts = delivery.conflicts ?? [];
    if (conflicts.length > 0) return this.conflictStillThere(wt, conflicts);
    const leftover = delivery.leftover ?? [];
    if (delivery.commits === 0 || leftover.length > 0) {
      const left =
        leftover.length > 0 ? `工作树里还有没提交的改动：${leftover.slice(0, 10).join('、')}。` : '';
      const missed = rt.lastImplementRoute;
      // 老历史没有这个标记：返工意见和选路参数都和原来一样。有提交的一轮不进这里，不触发避让。
      if (delivery.commits === 0 && missed && patched('avoid-empty-commit-route')) {
        const noted = noteEmptyCommit(rt.commitAvoid, missed, rt.commitMisses);
        rt.commitAvoid = noted.avoid;
        // 连着第二轮没提交、避开模型时连它那一族一起避开（决定 0093，patched('empty-commit-avoid-family')；别的族派不出退回只避开模型）。
        // 老历史没有这个标记，只避开模型
        const family = noted.streak >= 2 ? avoidableFamily(missed) : null;
        const byFamily = family !== null && patched('empty-commit-avoid-family');
        if (byFamily && family !== null) rt.commitAvoid = withFamily(rt.commitAvoid, family);
        rt.commitMisses = noted.streak;
        rt.commitMissRoute = missed;
        rt.feedback = [emptyCommitFeedback(missed, noted.streak >= 2, left, byFamily ? family : null)];
      } else {
        if (delivery.commits !== 0 && patched('avoid-empty-commit-route')) rt.commitMisses = 0;
        rt.feedback = [
          delivery.commits === 0
            ? `上一轮会话跑完了，但没有产生新的提交。改完之后要用 git commit 提交，不提交等于没做。${left}`
            : `${left}只有提交了的才会进 PR：要么 git add 再 git commit，要么删掉不要的文件。`,
        ];
      }
      rt.status.lastProblem =
        delivery.commits === 0 ? '会话跑完没有提交' : '会话跑完工作树里还有没提交的改动';
      return false;
    }
    if (patched('avoid-empty-commit-route')) rt.commitMisses = 0;
    if (!(await this.withinLineBudget(delivery, wt))) return false;
    let pushed: Awaited<ReturnType<typeof rt.acts.pushBranch>>;
    // 这个头改了哪些文件记进库（#3140，pr_head_files）：只给活动多带可选入参，不改步序；老历史没有这个标记，入参和原来一样
    const recordHeadFiles = patched('pr-head-files');
    try {
      pushed = await rt.step(
        'pushBranch',
        () =>
          rt.acts.pushBranch({
            taskId: rt.input.taskId,
            repo: rt.input.repo,
            worktreePath: wt.path,
            branch: rt.branch,
            head: delivery.head,
            ...(recordHeadFiles && rt.prNumber !== null ? { prNumber: rt.prNumber } : {}),
          }),
        // 空交付先自动重派一次动手会话（决定 0093），这张单里只一次；再撞上照旧停下
        this.emptyDeliveryRedone ? [] : [EMPTY_DELIVERY_CODE],
      );
    } catch (error) {
      if (error instanceof PermissionPushHandback) {
        rt.feedback = error.acceptedContract ? [error.feedback, ...rt.feedback] : [error.feedback];
        rt.resumeFrom = null;
        rt.lastSession = null;
        rt.resumeStreak = 0;
        rt.selfCheckOutput = null;
        rt.status.lastProblem = '推送权限问题已交回返工';
        return false;
      }
      if (error instanceof HygieneHandoff) return this.hygieneHandback(error.detail);
      if (error instanceof ConflictHandoff) {
        return this.conflictStillThere(wt, error.files, error.pending ? null : error.instruction);
      }
      if (error instanceof AutoEscape) {
        this.emptyDeliveryRedone = true;
        rt.feedback = [
          `上一轮推的时候发现没有新的提交（${error.detail}）。改完之后要用 git commit 提交，不提交等于没做。`,
        ];
        rt.status.lastProblem = '推的时候没有新提交';
        await rt.note(`第 ${rt.round} 轮：推的时候没有新提交（空交付），自动再派一轮动手，不停下等人`);
        return false;
      }
      throw error;
    }
    this.lastHygieneSpots = null;
    rt.head = pushed.head;
    // 自测测的是会话交的这个头；推的时候并了主线，头换成推上去的那个，输出照样交给验收
    if (rt.selfCheckOutput?.head === delivery.head)
      rt.selfCheckOutput = { ...rt.selfCheckOutput, head: pushed.head };
    rt.since = delivery.head;
    rt.changedFiles = pushed.changedFiles ?? delivery.changedFiles;
    // PR 新增行数（#2762 流程健康记账）：推分支没数成就是没量到，不拿 0 顶
    rt.addedLines = pushed.addedLines ?? null;
    if (rt.prNumber === null) {
      // 代数只在新历史里传给开 PR：重做的新一代才能关掉自己上一代留下的 PR。老历史重放不传，活动入参对得上。
      const generation = patched('redo-supersede-pr')
        ? parseTaskWorkflowId(workflowInfo().workflowId)?.generation
        : undefined;
      const pr = await rt.step('openPr', () =>
        rt.acts.openPr({
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          branch: rt.branch,
          head: pushed.head,
          title: rt.input.title,
          body: this.prBody(),
          ...(generation === undefined ? {} : { generation }),
          ...(recordHeadFiles && pushed.numstat !== undefined ? { numstat: pushed.numstat } : {}),
          ...(recordHeadFiles && pushed.numstatSnapshot !== undefined
            ? { numstatSnapshot: pushed.numstatSnapshot }
            : {}),
        }),
      );
      rt.prNumber = pr.prNumber;
    } else if (patched('pr-body-from-session')) {
      // 第 2 轮起：PR 早开了，「做了什么」换成这一轮会话的回复（#2723）。老历史没有这个标记，不改
      await this.updatePrBody(rt.prNumber);
    }
    await rt.advance('implement', `第 ${rt.round} 轮推上去了，PR #${rt.prNumber}`);
    rt.feedback = [];
    return true;
  }

  /** PR 正文的结构：「做了什么」带最近一次动手会话的最后一条回复（#2723，有截断上限）。 */
  private prBody(
    shots?: { verified: string[]; owed: string[] },
    duties: readonly AcceptanceDuty[] = [],
  ): PrBody {
    const rt = this.rt;
    if (duties.length > 0) {
      // 验收责任还开着（#3037）：「需求」栏写 Refs 标分片，原验收项进「还欠什么」，合并收口、每日对账都不关它
      const base = this.prBody(shots);
      const owed = [...new Set(duties.flatMap((d) => d.items))].map((item) => `待人验：${item}`);
      return { ...base, requirementRefs: true, owed: [...(base.owed ?? []), ...owed] };
    }
    // 交付声明（#3406）：回复末尾的 fleet-delivery 块定「还欠什么」和分片，缺失、非法、截断都写未核，不写「无」。
    // 只让说明更保守，不碰关单和合并。老结果没有可核验元数据也必须写未知，不能落成「无」。
    const claimed = patched('pr-body-delivery-claim');
    const answer = answerForPrDid(rt.lastAnswer, rt.input.issueNumber);
    const claim = deliveryClaimPrFields(deliveryClaimForPrBody(rt.lastAnswer, claimed));
    const body: PrBody = {
      requirement: rt.input.issueNumber,
      did: taskPrDid(rt.input.issueNumber, rt.round, rt.changedFiles.length, answer),
      verified: [
        patched('repo-ci-policy') && this.ciMode === 'off'
          ? SKIP_CI_PR_VERIFIED
          : 'CI 和冷验收的结果看这个 PR 的检查（验收通过才挂自动合并）',
      ],
      ...claim,
    };
    // 合并收树后（#2983）：代码一句、图片一句分开写，图片有欠项进「还欠什么」
    if (!shots) return body;
    const owed = [...shots.owed, ...(claim.owed ?? [])];
    return { ...body, verified: shots.verified, ...(owed.length > 0 ? { owed } : {}) };
  }

  /**
   * 第 2 轮起推上去后改 PR 正文（#2723）；合并收树后写图片交付结局（#2983）。不抛、不停下：没改成只记日志，PR 和后面的 CI、
   * 验收照旧（说明旧一点不挡合并）。放弃、叫停照常往外抛。
   */
  private async updatePrBody(
    prNumber: number,
    shots?: { verified: string[]; owed: string[] },
    duties: readonly AcceptanceDuty[] = [],
  ): Promise<void> {
    const rt = this.rt;
    try {
      await rt.cancellable(() =>
        rt.acts.updatePrBody({
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          prNumber,
          body: this.prBody(shots, duties),
        }),
      );
    } catch (error) {
      if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
      log.warn('PR 说明没改成，照旧往下走', { error: String(error) });
    }
  }

  /**
   * 卫生检查拦下了这次推送：命中处退回下一轮动手会话。同一处（排好序后一字不差）再拦才停下等人。
   * 命中处换了就再退一轮，不算连续同一处。
   */
  private async hygieneHandback(detail: string): Promise<boolean> {
    const rt = this.rt;
    const spots = hygieneSpots(detail);
    const key = hygieneSpotKey(spots);
    const line = hygieneFeedbackLine(spots);
    if (this.lastHygieneSpots !== null && key === this.lastHygieneSpots) {
      await rt.park(`卫生检查拦下了同一处，会话改过仍一字不差。${line}`, line);
      return false;
    }
    this.lastHygieneSpots = key;
    rt.feedback = [line];
    rt.status.lastProblem = '卫生检查拦下了新增内容';
    return false;
  }

  /**
   * 冲突还在：交给下一轮会话。反馈和上一轮一字不差就挂起，提醒里写冲突文件和树的位置。
   * blocked 有值：合并没开始，用原反馈（含要并的提交），不说树里留着冲突标记。
   */
  private async conflictStillThere(
    wt: Worktree,
    files: readonly string[],
    blocked?: string | null,
  ): Promise<boolean> {
    const rt = this.rt;
    // 合并还没开始：文件名在原反馈里，不改写成占位。标记删了没提交：这一轮可能只剩占位，沿用上一轮的文件名。
    this.conflictInTree = true;
    const names = blocked != null ? files : conflictFilesForHandoff(files, rt.feedback);
    const line = conflictHandoffLine(names, rt.feedback, blocked);
    if (rt.feedback.includes(line)) {
      const shown = names.join('、') || '（没读到冲突文件名）';
      const where = `冲突文件：${shown}。工作树：${wt.path}`;
      await rt.park(`和上一次的原文一字不差，原路再试不会变。${where}`, where);
      return false;
    }
    rt.feedback = [line];
    rt.status.lastProblem = '和主线有冲突';
    return false;
  }

  private async readDelivery(wt: Worktree): Promise<DeliveryRead> {
    const rt = this.rt;
    return rt.step('readDelivery', () =>
      rt.acts.readDelivery({
        schemaVersion: 1,
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        worktreePath: wt.path,
        baseSha: rt.since,
      }),
    );
  }

  /**
   * 交活时没提交、或树里有剩（#2722，patched('commit-nudge-same-round')）：续刚收场的那个会话一次，让它把改动提交了。
   * 不算一轮、不算连着续的次数，一轮只续一次；续了还没交干净，照旧走下面的返工。有冲突标记的不续（走冲突那条）。
   * 先问续不续得上（planResume，按刚跑的那条路由）：续不上就不在这一轮另开会话，照旧返工。老历史没有这个标记，不续。
   */
  private async nudgeCommit(
    brief: TaskBrief,
    tier: TierDecision,
    wt: Worktree,
    delivery: DeliveryRead,
  ): Promise<DeliveryRead> {
    const rt = this.rt;
    const leftover = delivery.leftover ?? [];
    if (delivery.commits > 0 && leftover.length === 0) return delivery;
    if ((delivery.conflicts ?? []).length > 0) return delivery;
    const last = rt.lastSession;
    const route = rt.lastImplementRoute;
    if (!last || !route || !patched('commit-nudge-same-round')) return delivery;
    const from = { previous: { runId: last.runId }, worktreePath: last.worktreePath };
    const plan = await planResume(rt, from, route, wt.path);
    if (plan.kind !== 'resume') return delivery;
    const streak = rt.resumeStreak;
    rt.feedback = [commitNudgeFeedback(delivery.commits, leftover)];
    rt.resumeFrom = from;
    await rt.advance('implement', `第 ${rt.round} 轮：会话交活时没提交完，续进会话补提交一次`);
    await writeSession(rt, brief, tier, wt, {
      cause: { cause: 'commit_nudge', summary: commitNudgeFeedback(delivery.commits, leftover) },
    });
    rt.resumeStreak = streak;
    return this.readDelivery(wt);
  }

  /**
   * 重活先出方案（#2755，patched('plan-first-heavy')）：先跑一段只读会话，最后一条回复只回方案 JSON（改哪些文件、预计新增行、对应哪几条验收）。
   * 格式不对续进同一个会话重出一次；还不对照常动手（不停下）。认下了，方案带进这一轮的意见，动手那一段续这个会话（读过的代码不再读）。
   * 方案这几段不算返工、不算连着续的次数。
   */
  private async planFirst(brief: TaskBrief, tier: TierDecision, wt: Worktree): Promise<void> {
    const rt = this.rt;
    this.planTried = true;
    const keep = rt.feedback;
    await rt.advance('implement', `第 ${rt.round} 轮：重活，先出方案（只读）`);
    await writeSession(rt, brief, tier, wt, { plan: true });
    let parsed = parsePlan(rt.lastAnswer);
    const first = rt.lastSession;
    if (!parsed.ok && first) {
      rt.feedback = [planRetryLine(parsed.why)];
      rt.resumeFrom = { previous: { runId: first.runId }, worktreePath: first.worktreePath };
      await rt.advance('implement', `第 ${rt.round} 轮：方案格式不对（${parsed.why}），续进会话重出一次`);
      await writeSession(rt, brief, tier, wt, {
        plan: true,
        cause: { cause: 'plan', summary: `方案格式不对（${parsed.why}），续进会话重出一次` },
      });
      parsed = parsePlan(rt.lastAnswer);
    }
    if (parsed.ok) {
      this.plan = parsed.plan;
      rt.feedback = [planGoLine(parsed.plan, this.lineBudget()), ...keep];
      await rt.advance(
        'implement',
        `第 ${rt.round} 轮：方案认下了（${parsed.plan.files.length} 个文件、预计新增 ${parsed.plan.addedLines} 行），照方案动手`,
      );
    } else {
      rt.feedback = keep;
      await rt.advance('implement', `第 ${rt.round} 轮：方案两次都没认出（${parsed.why}），照常动手`);
    }
    const last = rt.lastSession;
    if (last) rt.resumeFrom = { previous: { runId: last.runId }, worktreePath: last.worktreePath };
    rt.resumeStreak = 0;
  }

  /** 这张单的体量预算（#2755）：老历史开工时解析的上限里没有这一项、或设成 0，都是不判。 */
  private lineBudget(): number {
    const budget: unknown = this.rt.limits.prLineBudget;
    return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : 0;
  }

  /**
   * 推之前比体量预算（#2755，patched('pr-line-budget')）：交的头相对主线新增行超了预算，第一次打回让会话收窄（意见带上方案和方案外的文件）；
   * 收窄过还超就停下等人，附拆单建议，人点「继续」照这一版推、这张单后面不再判。没量到新增行（老历史、没数成）不判。回 false＝这一轮返工。
   */
  private async withinLineBudget(delivery: DeliveryRead, wt: Worktree): Promise<boolean> {
    const rt = this.rt;
    const budget = this.lineBudget();
    const rawAdded = delivery.addedLines;
    const measurement = delivery.lineBudgetMeasurement;
    const measured =
      measurement &&
      patched('verified-migration-budget-v1') &&
      measurement.version === 1 &&
      measurement.verified &&
      measurement.head === delivery.head &&
      measurement.rawAddedLines === rawAdded &&
      Number.isSafeInteger(measurement.verifiedGeneratedLines) &&
      measurement.verifiedGeneratedLines >= 0 &&
      Number.isSafeInteger(measurement.chargeableAddedLines) &&
      measurement.chargeableAddedLines >= 0 &&
      measurement.chargeableAddedLines + measurement.verifiedGeneratedLines === rawAdded;
    const added = measured ? measurement.chargeableAddedLines : rawAdded;
    const detail = measurement
      ? `原始新增 ${rawAdded} 行；已核生成快照 ${measured ? measurement.verifiedGeneratedLines : 0} 行；${measurement.reason}`
      : '';
    if (budget === 0 || added === undefined || added <= budget || this.budgetApproved) return true;
    if (!patched('pr-line-budget')) return true;
    if (!this.budgetBounced) {
      this.budgetBounced = true;
      rt.feedback = [
        overBudgetLine(added, budget, this.plan, delivery.changedFiles),
        ...(detail ? [detail] : []),
      ];
      rt.status.lastProblem = '改动超出体量预算';
      return false;
    }
    // 停点身份（#3249）：不改命令序。可信重评只放行这一份交付（budgetResume 绑停点编号），不设 budgetApproved。
    const parks = rt.parks + 1;
    await rt.park(
      `改动超出体量预算：新增 ${added} 行，预算 ${budget} 行，收窄过一次仍超`,
      `${splitSuggestion(delivery.changedFiles)}${detail ? ` ${detail}` : ''} 点「继续」照这一版推（这张单后面不再按预算打回）；不要了点「放弃」，拆成几张单再开。管理入口 fleet-api task budget-remeasure 可只重新核这一份成果的体量（不授权后续）。`,
      'stuck',
      'size',
      rawAdded === undefined
        ? undefined
        : {
            head: delivery.head,
            rawAddedLines: rawAdded,
            chargeableAddedLines: added,
            budget,
            base: parkedMeasurementBase(delivery),
            worktreePath: wt.path,
          },
    );
    if (rt.takeLineBudgetResume(parks)) return true;
    this.budgetApproved = true;
    return true;
  }

  /** 交付核对过得去：有新提交、树里没剩没提交的、没有冲突标记。 */
  private deliveredClean(delivery: DeliveryRead): boolean {
    return (
      delivery.commits > 0 &&
      (delivery.leftover ?? []).length === 0 &&
      (delivery.conflicts ?? []).length === 0
    );
  }

  /**
   * 返工轮续上一轮跑成的会话（决定 0093）：只定续谁，能不能续由 writeSession 问 planSegmentResume。
   * 连着 RESUME_STREAK_LIMIT 轮续着改还没过：这一轮开新会话，返工意见精炼过。上一段被暂停、已经记了要续的，不覆盖。
   * CI 红返工（cause=rework_ci）不受这个上限限制（#3603）。
   */
  private planReworkResume(cause: SegmentCauseNote): void {
    const rt = this.rt;
    const last = rt.lastSession;
    if (!last || rt.resumeFrom !== null || !patched('rework-resume')) return;
    // 全程的单（#2826）一直续同一个会话：不按「连着续两轮开新会话」清空；续不上由 writeSession 开新会话、带同样的意见
    // CI 红返工（#3603，patched('ci-rework-keep-resume')）也不清：修的是同一处失败，原会话读过的代码和上下文最有用。
    // 标记只在「到了上限、又是 CI 红」这一刻才问：老历史在这一刻没有标记，重放为假，照旧清空开新会话。
    if (
      rt.resumeStreak >= RESUME_STREAK_LIMIT &&
      rt.flowMode !== 'full' &&
      !(cause.cause === 'rework_ci' && patched('ci-rework-keep-resume'))
    ) {
      rt.resumeStreak = 0;
      rt.feedback = freshSessionFeedback(rt.feedback);
      return;
    }
    rt.resumeFrom = { previous: { runId: last.runId }, worktreePath: last.worktreePath };
  }

  /**
   * 引擎自己跑一遍测试和 tsc（决定 0093）。不抛、不停下：活动没跑成（含活动限时到了）当没跑。
   * 活动只试一次，限时到了不会整段重跑。输出记在 rt.selfCheckOutput（绑着这个头），交给冷验收。
   * 回 red / green / skipped。
   */
  private async selfCheck(wt: Worktree, head: string): Promise<'red' | 'green' | 'skipped'> {
    const rt = this.rt;
    await rt.advance('implement', `第 ${rt.round} 轮：${SELF_CHECK_DOING}`);
    try {
      const result = await rt.cancellable(() =>
        rt.acts.selfCheck({
          schemaVersion: 1,
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          worktreePath: wt.path,
          ...(patched('self-check-ci-coverage') && typeof rt.prNumber === 'number'
            ? { expectedHead: head, prNumber: rt.prNumber }
            : {}),
        }),
      );
      rt.selfCheckOutput = { head, text: selfCheckText(result) };
      return result.state;
    } catch (error) {
      if (error instanceof Abandoned || error instanceof MergedTask || isCancellation(error)) throw error;
      log.warn('自测没跑成，照旧推', { error: String(error) });
      rt.selfCheckOutput = null;
      return 'skipped';
    }
  }

  private async ensureWorktree(): Promise<Worktree> {
    const rt = this.rt;
    if (rt.worktree) return rt.worktree;
    const wt = await rt.step('createWorktree', () =>
      rt.acts.createWorktree({
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        branch: rt.branch,
      }),
    );
    rt.worktree = wt;
    rt.since = wt.baseSha;
    return wt;
  }

  /**
   * 收尾：关单、收工作树、写库。
   * 验收还欠着（#3037，patched('acceptance-duty')）：代码已合（决定 0093：不归我验不挡合并），可单子不关——读库里旧的验收责任
   * （只读，#3591 起不再写），并上这条工作流见过的转人验收条（openDuties）；
   * 有就留着原单，PR 说明「需求」栏改成 Refs 标分片，原验收项写进「还欠什么」。读不成按失败分流重试或停下，不当成没有、不关单。
   * 老历史没有这个标记，照旧直接关单。
   */
  private async finish(commit?: string, preserve = false): Promise<TaskRun> {
    const rt = this.rt;
    if (patched('settle-merged-task-checkpoint')) rt.finishingMerged = true;
    await this.endRound('merged');
    rt.set('done', `PR #${rt.prNumber} 已合并`);
    rt.status.lastProblem = null;
    const duties = patched('acceptance-duty') ? await this.openDuties(commit) : [];
    if (duties.length === 0) {
      await rt.step('closeIssue', () =>
        rt.acts.closeIssue({
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          issueNumber: rt.input.issueNumber,
          reason: 'completed',
          comment: `已合并：PR #${rt.prNumber}${commit ? `（${commit.slice(0, 7)}）` : ''}`,
        }),
      );
    } else {
      const items = duties.reduce((n, d) => n + d.items.length, 0);
      rt.set('done', `PR #${rt.prNumber} 已合并；验收责任 ${items} 条待人验，单子留着`);
      log.info('代码已合，验收责任还开着：不关单', {
        taskId: rt.input.taskId,
        issueNumber: rt.input.issueNumber,
        prNumber: rt.prNumber,
        commit,
        duties: duties.map((d) => ({ prNumber: d.prNumber, head: d.head, items: d.items.length })),
      });
    }
    const removed = await this.cleanup(preserve);
    // 界面截图的交付结局写进 PR 说明（#2983）：代码合并和图片交付分开写，有欠项不写「无」。只有带了 shots 的新历史才有
    const prNumber = rt.prNumber;
    const shots = removed?.shots && prNumber !== null ? shotsPrLines(prNumber, commit, removed.shots) : null;
    if (shots && prNumber !== null) {
      if (shots.owed[0] && duties.length === 0) rt.set('done', `PR #${prNumber} 已合并；${shots.owed[0]}`);
      await this.updatePrBody(prNumber, shots, duties);
    } else if (duties.length > 0 && prNumber !== null) {
      await this.updatePrBody(prNumber, undefined, duties);
    }
    await rt.mirror('done');
    return {
      outcome: 'merged',
      prNumber: rt.prNumber,
      head: rt.head,
      rounds: rt.round,
      verifyRounds: rt.verifyRound,
      ...(duties.length > 0 ? { acceptanceOpen: duties.length } : {}),
    };
  }

  async finishMerged(receipt: import('../task-contract.ts').MergedTaskReceipt): Promise<TaskRun> {
    this.rt.finishingMerged = true;
    this.rt.head = receipt.head;
    // 外部合并可能发生在返工会话期间；已合的头以外还有未推成果，必须先存档。
    return this.finish(receipt.mergeCommit, true);
  }

  /** 合并前把持久待验责任写进分片正文；写不成不挂自动合并。旧历史保留原步序。 */
  private async prepareAcceptance(): Promise<void> {
    if (!patched('acceptance-duty-before-merge')) return;
    const duties = await this.openDuties();
    const rt = this.rt;
    if (duties.length === 0 || rt.prNumber === null) return;
    await rt.step('updatePrBody', () =>
      rt.acts.updatePrBody({
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        prNumber: rt.prNumber!,
        body: this.prBody(undefined, duties),
      }),
    );
  }

  /**
   * 这张单还欠着的转人验收条：库里旧的验收责任（#3037 时期记下的，只读）并上这条工作流自己见过的「不归我验」。
   * #3591（决定 0113）起不再写库：record 恒为空，活动只读；转人验收条只活在工作流状态里，靠留着原单、PR 说明写 Refs 交给人。
   * 步序没变（照旧一次 acceptanceDuties），不用新标记。读不成由 step 按失败分流重试或停下等人：不回空数组冒充「没有待验的」。
   */
  private async openDuties(commit?: string): Promise<AcceptanceDuty[]> {
    const rt = this.rt;
    const read = await rt.step('acceptanceDuties', () =>
      rt.acts.acceptanceDuties({
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        issueNumber: rt.input.issueNumber,
        record: [],
      }),
    );
    const repo = `${rt.input.repo.owner}/${rt.input.repo.name}`;
    const open = [...read.open];
    for (const d of rt.handedOver) {
      // 老历史写过库：读回来的已经带着这一条（同 PR 同头），不重复算
      if (open.some((o) => o.prNumber === d.prNumber && o.head === d.head)) continue;
      open.push({
        repo,
        issueNumber: rt.input.issueNumber,
        prNumber: d.prNumber,
        head: d.head,
        items: [...d.items],
        source: d.prNumber === 0 ? 'coordination' : 'cold_verify',
        mergeCommit: commit && d.prNumber === rt.prNumber ? commit : null,
      });
    }
    return open;
  }

  /**
   * 收工作树。没合并就收（放弃、叫停）的先存档。收不掉只记日志：占盘，每小时对账的工作树清扫会收。
   * 推上去过的（有头）先核对界面截图（#2983，patched('shots-delivery')）：没交付也没存档成，端口不删树、kept 写原因。
   * 没带 shots 的（没推过、老历史）端口按树的 HEAD 过同一道；kept 的树清扫删之前也再存一次，存不成照旧留着。
   */
  async cleanup(archive: boolean): Promise<RemoveWorktreeResult | null> {
    const rt = this.rt;
    const wt = rt.worktree;
    if (!wt) return null;
    const head = rt.head;
    const shots =
      head !== null && patched('shots-delivery') ? { issueNumber: rt.input.issueNumber, head } : null;
    try {
      const r = await CancellationScope.nonCancellable(() =>
        rt.acts.removeWorktree({
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          path: wt.path,
          branch: rt.branch,
          archive,
          ...(shots ? { shots } : {}),
        }),
      );
      if (r.kept) log.warn('工作树留着没删', { kept: r.kept, path: wt.path });
      else rt.worktree = null;
      return r;
    } catch (error) {
      log.warn('工作树没收掉（每小时对账的工作树清扫会收）', { error: String(error) });
      return null;
    }
  }

  async abandoned(command: AbandonCommand): Promise<TaskRun> {
    const rt = this.rt;
    await this.endRound(stoppedOutcomeOf(rt.status.lastProblem));
    rt.set('abandoned', `被 ${command.by} 放弃：${command.reason}`);
    await this.cleanup(true);
    await rt.mirror('stopped');
    return {
      outcome: 'abandoned',
      prNumber: rt.prNumber,
      head: rt.head,
      rounds: rt.round,
      verifyRounds: rt.verifyRound,
    };
  }

  /** 工作流自己被取消（叫停）：先存档收树，再让取消往外抛。 */
  async cancelled(): Promise<void> {
    const rt = this.rt;
    await this.endRound(stoppedOutcomeOf(rt.status.lastProblem));
    rt.set('abandoned', '工作流被取消');
    await this.cleanup(true);
    await CancellationScope.nonCancellable(() => rt.mirror('stopped'));
  }

  stopPushHandbacks(): void {
    this.rt.stopPushHandbacks();
  }
}

export async function taskWorkflow(input: TaskWorkflowInput): Promise<TaskRun> {
  const limits = await limitsFor(undefined);
  const flow = new TaskFlow(input, activitiesFor(limits), limits);
  try {
    return await flow.run();
  } catch (error) {
    if (error instanceof MergedTask) return await flow.finishMerged(error.receipt);
    if (error instanceof Abandoned) return await flow.abandoned(error.command);
    if (isCancellation(error)) await CancellationScope.nonCancellable(() => flow.cancelled());
    throw error;
  } finally {
    flow.stopPushHandbacks();
    await condition(allHandlersFinished);
  }
}
