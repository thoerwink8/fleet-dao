// 任务工作流（#632 S2-4；specs/632-三段总调度/方案.md §五）：一张单从被拉起到合并、关单，一条工作流走完。
// 纯编排：每个副作用（读单子、选路、建树、起会话、推分支、开 PR、等 CI、冷验收、合并、关单）都在活动里；这里只管顺序、
// 几轮、碰到失败怎么办、什么时候停下等人。重放安全：不取随机数、不生成编号（会话编号由活动自己起），判断失败怎么办经 decide('failure')。
//
// 一张单的路：读交代 → [选路 → 建树（第一轮）→ 动手会话 → 读交付 → 推分支 → 开 PR（第一轮）→ 等 CI → 冷验收] 最多 3 轮 →
// 碰没碰「改标准」「先审后合」→ 挂自动合并 → 等合并 → 关单、收树。
// 返工只有这几种：没产生提交、CI 红了、合并冲突、验收没过；返工意见带进下一轮动手会话。验收最多 2 轮（specs/555）。
//
// 停下等人（waiting.kind = human，驾驶舱点「继续」「放弃」发信号）只有这几处，而且每一处都写清卡在哪、要人干什么：
// - 交代不全（缺栏）；没有可用的路由；失败分流判「挂起」（同因连着两次再犯、额度要等很久、登录失效……）；
// - 动手 3 轮、验收 2 轮都没过；验收做不出来（读不到 diff、没有别家模型、会话没跑成）；
// - 改到了「改标准」的路径（人闸第四类，要创始人同意才挂自动合并）、先审后合的路径（合并闸要第二意见）；
// - PR 被关了、PR 的头被别人改了。
// 「继续」之后从头再试这一步；「放弃」收尾退出（工作树存档后删，PR 和单子不动，由人处理）。
//
// 改这里之前必须知道：
// - 挂自动合并一定在冷验收通过之后。合并闸认引擎任务流程的 PR（分支 fleet/<单号>-t<8 位>）头上通过的 cold-verify（#555-2、#625），
//   每小时对账的兜底不碰这些分支（jobs/auto-merge-check.ts）；拉单入口在闸或冷验收没接上时不让任何仓接活
//   （jobs/intake.ts 的 MERGE_GATE_REQUIRES_COLD_VERIFY）。头换了（人推过新提交）就对新的头重走 CI 和验收，不原样重新挂：
//   新头上没有 cold-verify，合并闸不会放行。
// - 动手会话只试一次（activity-options.ts 的 segment 档）：基础设施的失败由这里按失败分流重试、换路由、挂起，不靠 Temporal 自动再起一遍。
// - 切号停下的动手会话（码 org_switch，#59）不算失败：失败分流 OS1 马上接着干、不记账、不看上一次的原文（不会凑成「同因连挂」）；
//   选路照常选到切过去的那个池，同一棵树、同一个分支重跑这一段，提示词带上被停下的原因（interrupted）。
// - 「放弃」「叫停」都要把正在跑的长活动取消掉（runSegment、coldVerify、waitCi、waitMerged 都心跳，收得到取消）。

import type { TaskState } from '@fleet-dao/shared';
import {
  CancellationScope,
  condition,
  isCancellation,
  log,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { EngineActivities } from '../activity-options.ts';
import type { AvoidScope, FailureContext, LadderCounters, NextAction } from '../decisions/failure.ts';
import type { CiResult, SyncResult } from '../decisions/types.ts';
import type { Limits } from '../limits.ts';
import type { PickRouteResult, RouteChoice, Worktree } from '../ports.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import type { TierDecision } from '../runner/tier.ts';
import {
  type AbandonCommand,
  MAX_IMPLEMENT_ROUNDS,
  MAX_VERIFY_ROUNDS,
  MERGE_POLL_MINUTES,
  type MergeWait,
  ORG_SWITCH_CODE,
  ROUTE_RETRY_SECONDS,
  SEGMENT_MINUTES,
  type SegmentEvidence,
  type TaskPhase,
  type TaskRun,
  type TaskStatus,
  type TaskWait,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskBranch,
  taskContinueSignal,
  taskStatusQuery,
} from '../task-contract.ts';
import { activitiesFor, failureOf, iso, judgeRetrying, limitsFor } from './kit.ts';

/** 放弃：从各处抛到最外层收尾。 */
class Abandoned extends Error {
  readonly command: AbandonCommand;
  constructor(command: AbandonCommand) {
    super(`被 ${command.by} 放弃：${command.reason}`);
    this.name = 'Abandoned';
    this.command = command;
  }
}

const ZERO: LadderCounters = { retries: 0, reworks: 0, routeSwaps: 0, modelSwaps: 0 };

interface Avoid {
  routeIds: string[];
  poolIds: string[];
  modelIds: string[];
}
const NO_AVOID: Avoid = { routeIds: [], poolIds: [], modelIds: [] };

/** 一轮 CI 等下来该干什么。 */
type CiStep = { kind: 'green' } | { kind: 'merged'; mergeCommit?: string | undefined } | { kind: 'rework' };

class TaskFlow {
  private readonly input: TaskWorkflowInput;
  private readonly acts: EngineActivities;
  private readonly limits: Limits;
  private readonly status: TaskStatus;
  private continued = 0;
  private abandon: AbandonCommand | null = null;
  private parks = 0;
  private cancelRunning: (() => void) | null = null;

  private branch = '';
  private worktree: Worktree | null = null;
  /** 动手会话交付检查的起点：第一轮是工作树的起点，之后是上一轮推上去的头。 */
  private since = '';
  private head: string | null = null;
  private prNumber: number | null = null;
  private changedFiles: string[] = [];
  private feedback: string[] = [];
  private readonly families = new Set<string>();
  private round = 0;
  private verifyRound = 0;
  private attemptSeq = 0;

  constructor(input: TaskWorkflowInput, acts: EngineActivities, limits: Limits) {
    this.input = input;
    this.acts = acts;
    this.limits = limits;
    this.status = {
      phase: 'brief',
      doing: '读单子和需求文档',
      round: 0,
      verifyRound: 0,
      prNumber: null,
      waiting: null,
      lastProblem: null,
      tier: null,
    };
    setHandler(taskContinueSignal, () => {
      this.continued += 1;
    });
    setHandler(taskAbandonSignal, (command) => {
      this.abandon ??= command;
      this.cancelRunning?.();
    });
    setHandler(taskStatusQuery, () => ({
      ...this.status,
      waiting: this.status.waiting ? { ...this.status.waiting } : null,
    }));
  }

  // ---- 状态、等待、停下等人

  private set(phase: TaskPhase, doing: string): void {
    this.status.phase = phase;
    this.status.doing = doing;
    this.status.round = this.round;
    this.status.verifyRound = this.verifyRound;
    this.status.prNumber = this.prNumber;
  }

  private guard(): void {
    if (this.abandon) throw new Abandoned(this.abandon);
  }

  /** 把此刻的样子写给驾驶舱（读库的那一侧）。写不进去只记日志：驾驶舱晚一会儿看到，不挡干活。 */
  private async mirror(state: TaskState): Promise<void> {
    try {
      await CancellationScope.nonCancellable(() =>
        this.acts.saveTaskState({
          taskId: this.input.taskId,
          repoId: this.input.repo.id,
          issueNumber: this.input.issueNumber,
          state,
          phase: this.status.phase,
          doing: this.status.doing,
          lastProblem: this.status.lastProblem,
          subtasks: [],
        }),
      );
    } catch (error) {
      log.warn('任务状态没写进库（驾驶舱晚一会儿才看到）', { error: String(error) });
    }
  }

  private async waiting<T>(kind: TaskWait['kind'], detail: string, fn: () => Promise<T>): Promise<T> {
    this.status.waiting = { kind, detail, since: iso(Date.now()) };
    try {
      return await fn();
    } finally {
      this.status.waiting = null;
    }
  }

  /** 睡 seconds 秒；放弃了马上醒、抛 Abandoned。 */
  private async pause(kind: TaskWait['kind'], detail: string, seconds: number): Promise<void> {
    await this.waiting(kind, detail, () => condition(() => this.abandon !== null, `${seconds} seconds`));
    this.guard();
  }

  /** 把一段长活动放进可取消的范围：放弃的信号一到就取消它（活动心跳，收得到），结果抛 Abandoned。 */
  private async cancellable<T>(fn: () => Promise<T>): Promise<T> {
    const scope = new CancellationScope({ cancellable: true });
    this.cancelRunning = () => scope.cancel();
    try {
      return await scope.run(fn);
    } catch (error) {
      if (this.abandon && isCancellation(error)) throw new Abandoned(this.abandon);
      throw error;
    } finally {
      this.cancelRunning = null;
    }
  }

  /** 停下等人：报警、写库、等「继续」或「放弃」。继续了回来，调用方从头再试这一步。 */
  private async park(title: string, detail: string): Promise<void> {
    this.guard();
    this.parks += 1;
    const before = this.continued;
    const previous = this.status.phase;
    this.status.lastProblem = title;
    this.status.phase = 'parked';
    this.status.doing = `停下等人：${title}`;
    await this.mirror('stalled');
    try {
      await CancellationScope.nonCancellable(() =>
        this.acts.raiseAlert({
          taskId: this.input.taskId,
          level: 'stuck',
          title,
          detail,
          dedupeKey: `${workflowInfo().workflowId}:park:${this.parks}`,
        }),
      );
    } catch (error) {
      log.warn('报警没发出去，照样停下等人', { title, error: String(error) });
    }
    await this.waiting('human', `${title}（等「继续」或「放弃」）`, () =>
      condition(() => this.continued > before || this.abandon !== null),
    );
    this.guard();
    this.status.phase = previous;
    this.status.lastProblem = null;
    await this.mirror('running');
  }

  // ---- 失败分流

  /**
   * 一步：活动自己的重试用完还失败，按失败分流走——有界重试（退避，或等上游给的时间）；再不行停下等人，「继续」之后从头再试。
   * 不绑路由的步骤用它；动手会话在 write() 里自己带换路由、换模型。
   */
  private async step<T>(source: string, fn: () => Promise<T>): Promise<T> {
    let counters = ZERO;
    let previousMessage: string | undefined;
    for (;;) {
      this.guard();
      try {
        return await fn();
      } catch (error) {
        if (error instanceof Abandoned) throw error;
        if (isCancellation(error)) throw error;
        const failure = failureOf(error, source);
        const next = await this.classify(failure, counters, false, { previousMessage });
        previousMessage = failure.message;
        this.status.lastProblem = next.reason;
        if (next.action === 'retry') {
          counters = bump(counters, next);
          await this.pause(next.wait === 'quota' ? 'quota' : 'retry', next.reason, next.delaySeconds);
        } else {
          await this.park(
            next.humanFix ? `${next.reason}；要人：${next.humanFix}` : next.reason,
            failure.message,
          );
          counters = ZERO;
          previousMessage = undefined;
        }
      }
    }
  }

  private classify(
    failure: { source: string; code: string; message: string; retryable: boolean | null },
    counters: LadderCounters,
    routeBound: boolean,
    context: FailureContext,
  ): Promise<NextAction> {
    return judgeRetrying('failure', {
      failure,
      counters,
      limits: this.limits,
      routeBound,
      context: { now: iso(Date.now()), ...stripUndefined(context) },
    });
  }

  // ---- 主线

  async run(): Promise<TaskRun> {
    const { brief, tier } = await this.readBrief();
    this.status.tier = tier;
    this.branch = taskBranch(this.input.issueNumber, workflowInfo().runId);
    await this.mirror('running');

    for (;;) {
      this.guard();
      if (this.round >= MAX_IMPLEMENT_ROUNDS) {
        await this.park(
          `动手 ${MAX_IMPLEMENT_ROUNDS} 轮都没过`,
          `最近的返工意见：${this.feedback.join('；') || '（没有）'}。点「继续」再给一整轮；或「放弃」。`,
        );
        this.round = 0;
      }
      this.round += 1;
      if (!(await this.implement(brief, tier))) continue;

      const delivered = await this.deliver(brief);
      if (delivered === 'rework') continue;
      return this.finish(delivered.commit);
    }
  }

  /**
   * 推上去以后的路：等 CI → 冷验收 → 查路径 → 挂自动合并、等合并。回 'rework'＝要回去再动手一轮（意见已记下）。
   * 等合并时 PR 的头被别人改了、人看过点「继续」：新的头上没有验收状态，合并闸（引擎任务流程的 PR 要有通过的 cold-verify）
   * 不会放行，原样重新挂只会永远等下去——所以回到等 CI，对新的头把这条路重走一遍。
   */
  private async deliver(brief: TaskBrief): Promise<'rework' | { commit?: string | undefined }> {
    for (;;) {
      const ci = await this.ci();
      if (ci.kind === 'merged') return { commit: ci.mergeCommit };
      if (ci.kind === 'rework') return 'rework';

      const verdict = await this.verify(brief);
      if (verdict === 'rework') return 'rework';
      if (verdict === 'head_moved') {
        this.verifyRound = 0; // 头换了，验收对新的头重新数轮
        continue;
      }

      await this.guardedPaths();
      const merged = await this.merge();
      if (merged.kind === 'merged') return { commit: merged.commit };
      this.verifyRound = 0; // 头换了，验收对新的头重新数轮
    }
  }

  /** 读交代：缺栏就停下等人补，补了点「继续」再读。 */
  private async readBrief(): Promise<{ brief: TaskBrief; tier: TierDecision }> {
    for (;;) {
      this.set('brief', '读单子和需求文档');
      const got = await this.step('readTaskBrief', () =>
        this.acts.readTaskBrief({
          schemaVersion: 1,
          repo: { owner: this.input.repo.owner, name: this.input.repo.name },
          issueNumber: this.input.issueNumber,
        }),
      );
      if (got.ok) return { brief: got.brief, tier: got.brief.tier };
      await this.park(
        '单子的交代不全，没法动手',
        got.problems.map((p) => `【${p.field}】${p.why}`).join('\n'),
      );
    }
  }

  /** 一轮动手：选路 → 建树 → 会话 → 读交付 → 推分支 → 开 PR。回 false＝这一轮要返工（意见已记下）。 */
  private async implement(brief: TaskBrief, tier: TierDecision): Promise<boolean> {
    this.set('implement', `动手第 ${this.round} 轮`);
    const wt = await this.ensureWorktree();
    await this.write(brief, tier, wt);

    const delivery = await this.step('readDelivery', () =>
      this.acts.readDelivery({
        schemaVersion: 1,
        taskId: this.input.taskId,
        repo: this.input.repo,
        worktreePath: wt.path,
        baseSha: this.since,
      }),
    );
    // 老历史里读交付的结果没有 leftover 这个字段：当作没有
    const leftover = delivery.leftover ?? [];
    if (delivery.commits === 0 || leftover.length > 0) {
      const left =
        leftover.length > 0 ? `工作树里还有没提交的改动：${leftover.slice(0, 10).join('、')}。` : '';
      this.feedback = [
        delivery.commits === 0
          ? `上一轮会话跑完了，但没有产生新的提交。改完之后要用 git commit 提交，不提交等于没做。${left}`
          : `${left}只有提交了的才会进 PR：要么 git add 再 git commit，要么删掉不要的文件。`,
      ];
      this.status.lastProblem =
        delivery.commits === 0 ? '会话跑完没有提交' : '会话跑完工作树里还有没提交的改动';
      return false;
    }
    const pushed = await this.step('pushBranch', () =>
      this.acts.pushBranch({
        taskId: this.input.taskId,
        repo: this.input.repo,
        worktreePath: wt.path,
        branch: this.branch,
        head: delivery.head,
      }),
    );
    this.head = pushed.head;
    this.since = delivery.head;
    this.changedFiles = pushed.changedFiles ?? delivery.changedFiles;
    if (this.prNumber === null) {
      const pr = await this.step('openPr', () =>
        this.acts.openPr({
          taskId: this.input.taskId,
          repo: this.input.repo,
          branch: this.branch,
          head: pushed.head,
          title: this.input.title,
          body: {
            requirement: this.input.issueNumber,
            did: [
              `按 #${this.input.issueNumber} 的要求动手（第 ${this.round} 轮）`,
              `改了 ${this.changedFiles.length} 个文件`,
            ],
            verified: ['CI 和冷验收的结果看这个 PR 的检查（验收通过才挂自动合并）'],
          },
        }),
      );
      this.prNumber = pr.prNumber;
    }
    this.set('implement', `第 ${this.round} 轮推上去了，PR #${this.prNumber}`);
    this.feedback = [];
    return true;
  }

  private async ensureWorktree(): Promise<Worktree> {
    if (this.worktree) return this.worktree;
    const wt = await this.step('createWorktree', () =>
      this.acts.createWorktree({
        taskId: this.input.taskId,
        repo: this.input.repo,
        branch: this.branch,
      }),
    );
    this.worktree = wt;
    this.since = wt.baseSha;
    return wt;
  }

  /**
   * 动手会话：选路 → 起 → 没跑成按失败分流（原路重试 / 换路由 / 换模型 / 挂起）。会话只试一次，换谁由这里定。
   * 回的时候会话是跑成了的（进程正常结束、终帧没报错）；有没有交付由调用方接着查。
   */
  private async write(brief: TaskBrief, tier: TierDecision, wt: Worktree): Promise<void> {
    let counters = ZERO;
    let avoid: Avoid = NO_AVOID;
    let previousMessage: string | undefined;
    let stick: string | undefined;
    // 这一段上一次被切号停下了（#59）：重跑时告诉新会话树里留着上一次的东西；一直带到这一段跑成（树里的东西一直在）
    let interrupted: string | undefined;
    for (;;) {
      this.guard();
      const route = await this.pick(avoid, stick);
      this.families.add(route.family);
      this.attemptSeq += 1;
      this.set('implement', `第 ${this.round} 轮：${route.modelId} 动手`);
      let evidence: SegmentEvidence | null = null;
      let infra: unknown = null;
      try {
        const res = await this.cancellable(() =>
          this.acts.runSegment({
            schemaVersion: 1,
            taskId: this.input.taskId,
            repo: this.input.repo,
            issueNumber: this.input.issueNumber,
            route,
            worktreePath: wt.path,
            branch: this.branch,
            baseSha: this.since,
            brief,
            tier,
            feedback: this.feedback,
            timeoutMinutes: SEGMENT_MINUTES,
            ...(interrupted ? { interrupted } : {}),
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
      const next = await this.classify(failure, counters, true, {
        stage: 'execute',
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
      previousMessage = failure.message;
      this.status.lastProblem = next.reason;
      counters = bump(counters, next);
      if (next.action === 'retry') {
        // 原路再试：还是这条路由（额度要等的，等到清零再来，不算墙钟）
        stick = route.routeId;
        await this.pause(next.wait === 'quota' ? 'quota' : 'retry', next.reason, next.delaySeconds);
      } else if (next.action === 'swapRoute' || next.action === 'swapModel') {
        stick = undefined;
        avoid = widen(avoid, route, next.avoid ?? (next.action === 'swapModel' ? 'model' : 'route'));
      } else {
        await this.park(
          next.humanFix ? `${next.reason}；要人：${next.humanFix}` : next.reason,
          failure.message,
        );
        counters = ZERO;
        avoid = NO_AVOID;
        stick = undefined;
        previousMessage = undefined;
      }
    }
  }

  /** 选路：排队（没空位、额度没读成）就隔一会儿再选；一条能用的都没有就停下等人。 */
  private async pick(avoid: Avoid, stick?: string): Promise<RouteChoice> {
    for (;;) {
      this.guard();
      const got: PickRouteResult = await this.step('pickRoute', () =>
        this.acts.pickRoute({
          taskId: this.input.taskId,
          stage: 'execute',
          avoidRouteIds: avoid.routeIds,
          avoidPoolIds: avoid.poolIds,
          avoidModelIds: avoid.modelIds,
          ...(stick ? { stickRouteId: stick } : {}),
        }),
      );
      if (got.ok) return got.route;
      if (got.waitFor === 'none') {
        await this.park('没有可用的路由', got.detail);
        avoid = NO_AVOID;
        continue;
      }
      await this.pause(got.waitFor, got.detail, got.retryAfterSeconds ?? ROUTE_RETRY_SECONDS);
    }
  }

  /** 等 CI。红了、有冲突：记下返工意见，回动手。读不到、头被改写：停下等人，继续后再等。 */
  private async ci(): Promise<CiStep> {
    const wt = this.worktree;
    if (!wt || this.prNumber === null || this.head === null) {
      throw new Error('等 CI 之前还没有 PR（工作流自己的状态乱了）');
    }
    for (;;) {
      this.set('ci', `等 PR #${this.prNumber} 的 CI`);
      const prNumber: number = this.prNumber;
      const head: string = this.head;
      const got: CiResult = await this.waiting('ci', `等 PR #${prNumber} 的 CI`, () =>
        this.step('waitCi', () =>
          this.cancellable(() =>
            this.acts.waitCi({
              taskId: this.input.taskId,
              repo: this.input.repo,
              prNumber,
              branch: this.branch,
              head,
              worktreePath: wt.path,
            }),
          ),
        ),
      );
      this.head = got.head;
      switch (got.state) {
        case 'green':
          return { kind: 'green' };
        case 'merged':
          return { kind: 'merged', mergeCommit: got.mergeCommit };
        case 'red':
          this.feedback = [
            `CI 红了：${got.failedChecks.join('、') || '（没写是哪项）'}`,
            ...(got.digest ? [got.digest] : []),
            ...(got.detail ? [got.detail] : []),
          ];
          this.status.lastProblem = 'CI 红了';
          return { kind: 'rework' };
        case 'conflict': {
          const sync: SyncResult = await this.step('syncMainline', () =>
            this.acts.syncMainline({
              taskId: this.input.taskId,
              repo: this.input.repo,
              prNumber,
              branch: this.branch,
              head: got.head,
              worktreePath: wt.path,
            }),
          );
          this.head = sync.head;
          if (sync.state === 'clean') continue;
          this.feedback = [`和最新主线有冲突，要解决：${sync.conflictFiles.join('、')}`];
          this.status.lastProblem = '和主线有冲突';
          return { kind: 'rework' };
        }
        case 'unknown':
          await this.park('CI 的结果没查成', got.detail ?? '没有检查，或超时读不到');
          continue;
        case 'diverged':
          await this.park(
            'PR 的头被改写了（新头不含老头）',
            got.detail ?? '像是被强推改写，自动并主线接不了',
          );
          continue;
      }
    }
  }

  /**
   * 冷验收。没过：记下问题表回动手（'rework'）；做不出来：停下等人，不让写代码的会话白改一轮；这会儿验不了、过一会儿就行：睡一会儿再来，
   * 不算一轮；要验的头已经被别人换了：停下等人看过，回 'head_moved'，由调用方对新的头重走一遍。
   */
  private async verify(brief: TaskBrief): Promise<'pass' | 'rework' | 'head_moved'> {
    const wt = this.worktree;
    if (!wt || this.prNumber === null || this.head === null) {
      throw new Error('验收之前还没有 PR（工作流自己的状态乱了）');
    }
    for (;;) {
      if (this.verifyRound >= MAX_VERIFY_ROUNDS) {
        await this.park(
          `验收 ${MAX_VERIFY_ROUNDS} 轮都没过`,
          `最近的问题：${this.feedback.join('；') || '（没有）'}。点「继续」再验一轮；或「放弃」。`,
        );
        this.verifyRound = 0;
      }
      this.verifyRound += 1;
      this.set('verify', `验收第 ${this.verifyRound} 轮`);
      const prNumber: number = this.prNumber;
      const headSha: string = this.head;
      const res = await this.step('coldVerify', () =>
        this.cancellable(() =>
          this.acts.coldVerify({
            schemaVersion: 1,
            taskId: this.input.taskId,
            repo: this.input.repo,
            issueNumber: this.input.issueNumber,
            prNumber,
            branch: this.branch,
            baseSha: wt.baseSha,
            headSha,
            what: brief.request,
            howToFinish: brief.acceptance,
            authorFamilies: [...this.families],
            round: this.verifyRound === 1 ? 1 : 2,
          }),
        ),
      );
      if (res.headMoved !== undefined) {
        this.verifyRound -= 1;
        await this.park('PR 的头被别人改了', headMovedDetail(res.headMoved, headSha));
        this.head = res.headMoved;
        return 'head_moved';
      }
      if (res.retry) {
        // 这会儿验不了、过一会儿就行（没空位、内存放不下、引擎在停机）：不算一轮，不停下报人
        this.verifyRound -= 1;
        await this.pause(res.retry.wait, res.retry.reason, res.retry.afterSeconds);
        continue;
      }
      if (res.unavailable) {
        this.verifyRound -= 1; // 没验成不算一轮
        await this.park('验收做不出来', res.unavailable);
        continue;
      }
      if (res.pass) return 'pass';
      this.feedback = res.problems.map((p) => `验收没过：${p}`);
      this.status.lastProblem = '验收没过';
      return 'rework';
    }
  }

  /** 碰了「改标准」「先审后合」的路径：停下等人（工作流不绕合并闸、不替创始人同意）。 */
  private async guardedPaths(): Promise<void> {
    const prNumber = this.prNumber;
    if (prNumber === null) throw new Error('查路径之前还没有 PR');
    for (;;) {
      const g = await this.step('checkGuarded', () =>
        this.acts.checkGuarded({
          schemaVersion: 1,
          taskId: this.input.taskId,
          repo: this.input.repo,
          prNumber,
        }),
      );
      if (g.standards.length > 0) {
        await this.park(
          '改到了标准路径，要创始人同意才挂自动合并（人闸：改标准）',
          `改到：${g.standards.join('、')}。创始人同意后点「继续」；不同意点「放弃」。`,
        );
        continue;
      }
      if (g.highRisk.length > 0) {
        await this.park(
          '碰了先审后合的路径，合并闸要通过第二意见',
          `改到：${g.highRisk.join('、')}。第二意见通过（second-opinion 状态）后点「继续」。`,
        );
        continue;
      }
      return;
    }
  }

  /**
   * 挂自动合并、等合并。PR 被关了、头被改了，停下等人。头被改了、人点「继续」之后回 head_moved，由调用方对新的头重走一遍
   * （等 CI、验收、查路径）再来；别的情况一直等到合并才回。
   */
  private async merge(): Promise<{ kind: 'merged'; commit?: string | undefined } | { kind: 'head_moved' }> {
    const prNumber = this.prNumber;
    if (prNumber === null || this.head === null) throw new Error('合并之前还没有 PR');
    for (;;) {
      this.set('merge', `PR #${prNumber} 挂自动合并，等合并`);
      const head: string = this.head;
      const armed = await this.step('armAutoMerge', () =>
        this.acts.armAutoMerge({ schemaVersion: 1, repo: this.input.repo, prNumber, expectedHead: head }),
      );
      if (armed.merged) return { kind: 'merged', commit: armed.mergeCommit };
      if (armed.headMoved !== undefined) {
        await this.park('PR 的头被别人改了', headMovedDetail(armed.headMoved, head));
        this.head = armed.headMoved;
        return { kind: 'head_moved' };
      }
      if (!armed.armed) {
        await this.park('自动合并没挂上', armed.why ?? 'GitHub 没说为什么');
        continue;
      }
      for (;;) {
        const w: MergeWait = await this.waiting(
          'merge',
          `等 PR #${prNumber} 合并（合并闸、必过检查都要绿）`,
          () =>
            this.step('waitMerged', () =>
              this.cancellable(() =>
                this.acts.waitMerged({
                  schemaVersion: 1,
                  repo: this.input.repo,
                  prNumber,
                  expectedHead: head,
                  minutes: MERGE_POLL_MINUTES,
                }),
              ),
            ),
        );
        if (w.state === 'merged') return { kind: 'merged', commit: w.mergeCommit };
        if (w.state === 'unarmed') {
          this.status.lastProblem = '自动合并被撤掉了，重新挂';
          break;
        }
        if (w.state === 'closed') {
          await this.park(
            'PR 被关了，没合并',
            `PR #${prNumber} 在 GitHub 上被关闭。要接着做，重开它后点「继续」；不做点「放弃」。`,
          );
          break;
        }
        if (w.state === 'head_moved') {
          await this.park('PR 的头被别人改了', headMovedDetail(w.head, head));
          this.head = w.head;
          return { kind: 'head_moved' };
        }
        // waiting：这一轮没合，接着等
      }
    }
  }

  /** 收尾：关单、收工作树、写库。 */
  private async finish(commit?: string): Promise<TaskRun> {
    this.set('done', `PR #${this.prNumber} 已合并`);
    this.status.lastProblem = null;
    await this.step('closeIssue', () =>
      this.acts.closeIssue({
        taskId: this.input.taskId,
        repo: this.input.repo,
        issueNumber: this.input.issueNumber,
        reason: 'completed',
        comment: `已合并：PR #${this.prNumber}${commit ? `（${commit.slice(0, 7)}）` : ''}`,
      }),
    );
    await this.cleanup(false);
    await this.mirror('done');
    return {
      outcome: 'merged',
      prNumber: this.prNumber,
      head: this.head,
      rounds: this.round,
      verifyRounds: this.verifyRound,
    };
  }

  /** 收工作树。没合并就收（放弃、叫停）的先存档。收不掉只记日志：占盘，每小时对账的工作树清扫会收。 */
  async cleanup(archive: boolean): Promise<void> {
    const wt = this.worktree;
    if (!wt) return;
    try {
      await CancellationScope.nonCancellable(() =>
        this.acts.removeWorktree({
          taskId: this.input.taskId,
          repo: this.input.repo,
          path: wt.path,
          branch: this.branch,
          archive,
        }),
      );
      this.worktree = null;
    } catch (error) {
      log.warn('工作树没收掉（每小时对账的工作树清扫会收）', { error: String(error) });
    }
  }

  async abandoned(command: AbandonCommand): Promise<TaskRun> {
    this.set('abandoned', `被 ${command.by} 放弃：${command.reason}`);
    await this.cleanup(true);
    await this.mirror('stopped');
    return {
      outcome: 'abandoned',
      prNumber: this.prNumber,
      head: this.head,
      rounds: this.round,
      verifyRounds: this.verifyRound,
    };
  }

  /** 工作流自己被取消（叫停）：先存档收树，再让取消往外抛。 */
  async cancelled(): Promise<void> {
    this.set('abandoned', '工作流被取消');
    await this.cleanup(true);
    await CancellationScope.nonCancellable(() => this.mirror('stopped'));
  }
}

/** 头被别人改了，停下等人时写的话：点「继续」之后引擎对新的头重跑 CI 和验收，不是原样接着等。 */
function headMovedDetail(now: string, pushed: string): string {
  return `现在的头是 ${now}，不是引擎验过、推上去的 ${pushed}。看过之后点「继续」：引擎会对新的头重跑 CI 和验收；不要这个 PR 了点「放弃」。`;
}

function bump(counters: LadderCounters, next: NextAction): LadderCounters {
  const key =
    next.counter === undefined
      ? ({ retry: 'retries', swapRoute: 'routeSwaps', swapModel: 'modelSwaps', park: null } as const)[
          next.action
        ]
      : next.counter;
  return key ? { ...counters, [key]: (counters[key] ?? 0) + 1 } : counters;
}

function widen(avoid: Avoid, route: RouteChoice, scope: AvoidScope): Avoid {
  const add = (list: string[], id: string) => (list.includes(id) ? list : [...list, id]);
  if (scope === 'pool') return { ...avoid, poolIds: add(avoid.poolIds, route.poolId) };
  if (scope === 'model') return { ...avoid, modelIds: add(avoid.modelIds, route.modelId) };
  return { ...avoid, routeIds: add(avoid.routeIds, route.routeId) };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export async function taskWorkflow(input: TaskWorkflowInput): Promise<TaskRun> {
  const limits = await limitsFor(undefined);
  const flow = new TaskFlow(input, activitiesFor(limits), limits);
  try {
    return await flow.run();
  } catch (error) {
    if (error instanceof Abandoned) return flow.abandoned(error.command);
    if (isCancellation(error)) await CancellationScope.nonCancellable(() => flow.cancelled());
    throw error;
  }
}
