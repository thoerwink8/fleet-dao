// 任务工作流的运行底座：一张单的状态（驾驶舱查到的 status、轮数、头、PR 号……）、等待、停下等人、可取消的长活动、
// 失败分流。各阶段（task-session / task-ci / task-verify / task-merge）都拿同一个 TaskRuntime 干活，task.ts 的 TaskFlow 只管顺序。
//
// 改这里之前必须知道：
// - 这是工作流代码，会被重放：不取随机数、不生成编号；时间只用 Date.now()（工作流沙箱里它是确定的）；判断失败怎么办经 judgeRetrying。
//   改调度顺序（多调、少调、换顺序调活动）要用 patched()，见 test/replay.test.ts。
// - 「放弃」「叫停」都要把正在跑的长活动取消掉：长活动一律包在 cancellable() 里。
// - 停下等人 park() 回来＝人点了「继续」；放弃会在 park() 里抛 Abandoned，走不到下一行。

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
import type { FailureContext, LadderCounters, NextAction } from '../decisions/failure.ts';
import type { Limits } from '../limits.ts';
import type { Worktree } from '../ports.ts';
import {
  type AbandonCommand,
  type GuardedPaths,
  type TaskPhase,
  type TaskStatus,
  type TaskWait,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
  taskRouteWakeSignal,
  taskStatusQuery,
} from '../task-contract.ts';
import { failureOf, iso, judgeRetrying } from './kit.ts';
import { Abandoned, bump, stripUndefined, ZERO } from './task-support.ts';

export class TaskRuntime {
  readonly input: TaskWorkflowInput;
  readonly acts: EngineActivities;
  readonly limits: Limits;
  readonly status: TaskStatus;
  private continued = 0;
  private routeWakes = 0;
  private abandon: AbandonCommand | null = null;
  private parks = 0;
  private cancelRunning: (() => void) | null = null;

  // ---- 一张单走到哪了（各阶段读写）
  branch = '';
  worktree: Worktree | null = null;
  /** 动手会话交付检查的起点：第一轮是工作树的起点，之后是上一轮推上去的头。 */
  since = '';
  head: string | null = null;
  prNumber: number | null = null;
  /** 人在哪个头上批过哪些路径（点「继续」那一刻记下）；头换了就作废，新的内容要重新批。 */
  guardApproval: { head: string; paths: GuardedPaths } | null = null;
  changedFiles: string[] = [];
  feedback: string[] = [];
  readonly families = new Set<string>();
  round = 0;
  verifyRound = 0;
  attemptSeq = 0;

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
    setHandler(taskRouteWakeSignal, () => {
      this.routeWakes += 1;
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

  set(phase: TaskPhase, doing: string): void {
    this.status.phase = phase;
    this.status.doing = doing;
    this.status.round = this.round;
    this.status.verifyRound = this.verifyRound;
    this.status.prNumber = this.prNumber;
  }

  guard(): void {
    if (this.abandon) throw new Abandoned(this.abandon);
  }

  /** 把此刻的样子写给驾驶舱（读库的那一侧）。写不进去只记日志：驾驶舱晚一会儿看到，不挡干活。 */
  async mirror(state: TaskState): Promise<void> {
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

  async waiting<T>(kind: TaskWait['kind'], detail: string, fn: () => Promise<T>): Promise<T> {
    this.status.waiting = { kind, detail, since: iso(Date.now()) };
    try {
      return await fn();
    } finally {
      this.status.waiting = null;
    }
  }

  /** 睡 seconds 秒；放弃了马上醒、抛 Abandoned。 */
  async pause(kind: TaskWait['kind'], detail: string, seconds: number): Promise<void> {
    await this.waiting(kind, detail, () => condition(() => this.abandon !== null, `${seconds} seconds`));
    this.guard();
  }

  /**
   * 叫醒信号收到过几次（#194 方案 4.3）。等路由的那一步在**问选路之前**取一个记号，问完要等时交给 pauseForRoute：
   * 问的那一刻到睡下之间到的叫醒不丢（那次选路读的是切号完成之前的事实，得再选一次）。
   */
  routeWakeMark(): number {
    return this.routeWakes;
  }

  /**
   * 等路由：睡 seconds 秒，但路由那边变了（叫醒信号，记号之后到过一次就算）当场醒、放弃了马上醒（抛 Abandoned）。
   * 返回是不是被叫醒的（日志、测试看）；醒了调用方照旧重新选一次，选不到会拿新记号再来等，不空转。
   */
  async pauseForRoute(
    kind: TaskWait['kind'],
    detail: string,
    seconds: number,
    mark: number,
  ): Promise<'woken' | 'timeout'> {
    const woken = await this.waiting(kind, detail, () =>
      condition(() => this.abandon !== null || this.routeWakes > mark, `${seconds} seconds`),
    );
    this.guard();
    return woken ? 'woken' : 'timeout';
  }

  /** 把一段长活动放进可取消的范围：放弃的信号一到就取消它（活动心跳，收得到），结果抛 Abandoned。 */
  async cancellable<T>(fn: () => Promise<T>): Promise<T> {
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
  async park(title: string, detail: string): Promise<void> {
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
   * 不绑路由的步骤用它；动手会话在 task-session.ts 里自己带换路由、换模型。
   */
  async step<T>(source: string, fn: () => Promise<T>): Promise<T> {
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

  classify(
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
}
