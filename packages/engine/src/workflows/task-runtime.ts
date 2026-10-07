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
  patched,
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
  PAUSED_BY_HUMAN,
  type PauseCommand,
  type RepinCommand,
  type TaskPhase,
  type TaskStatus,
  type TaskWait,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
  taskPauseSignal,
  taskRepinSignal,
  taskRouteWakeSignal,
  taskStatusQuery,
} from '../task-contract.ts';
import { conflictFilesOf, conflictPendingOf, failureOf, iso, judgeRetrying } from './kit.ts';
import {
  Abandoned,
  bump,
  ConflictHandoff,
  PausedInterrupt,
  RepinInterrupt,
  stripUndefined,
  ZERO,
} from './task-support.ts';

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
  /** 正在跑的这个长活动是不是「hard 暂停能取消的」（只有动手会话）。 */
  private runningPausable = false;
  /** 有人要暂停（#820 片 3）：停在下一个检查点（checkpoint），点「继续」才放；已经有一个在了，后来的不覆盖（谁点的、为什么保持第一次）。 */
  private pauseReq: PauseCommand | null = null;
  /** 暂停停着等「继续」的这一段（pauseReq 已经生效）。 */
  private holding = false;
  /** hard 暂停取消了正在跑的动手会话：cancellable 里看到取消时，分得清是暂停取消的还是别的。 */
  private pauseCancelled = false;
  /** 「现在就换」取消了正在跑的动手会话（#1216）：cancellable 里看到取消时，分得清是它取消的。 */
  private repinCancelled = false;
  private repinReq: RepinCommand | null = null;

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
      // 还没停下（没到检查点）就收到「继续」：撤掉这次暂停请求；已经停着的由 holdPaused 看 continued 放行
      if (!this.holding) this.pauseReq = null;
    });
    setHandler(taskPauseSignal, (command) => {
      if (this.pauseReq) return;
      this.pauseReq = command;
      if (command.mode === 'hard' && this.runningPausable) {
        this.pauseCancelled = true;
        this.cancelRunning?.();
      }
    });
    // 「现在就换」（#1216）：只有正在跑的动手会话能当场停（和 hard 暂停同一条取消的路）；没在跑就不理——新指定已经在库里，下一次选路照它。
    // hard 暂停已经把这一段取消了、或已经在放弃：不抢。
    setHandler(taskRepinSignal, (command) => {
      if (!this.runningPausable || this.pauseCancelled || this.repinCancelled || this.abandon) return;
      this.repinReq = command;
      this.repinCancelled = true;
      this.cancelRunning?.();
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

  /**
   * 换阶段：写内存状态，并把阶段落库（running）。只用 set() 的话库里的 phase/doing 停在开头那一句，
   * 驾驶舱和法国巡查看着像「卡在对题」，其实已经在动手、等 CI 了（#1150 过夜那次）。
   * 老历史重放时没有这个标记：patched() 为假，不多调那一步活动。
   */
  async advance(phase: TaskPhase, doing: string): Promise<void> {
    this.set(phase, doing);
    if (patched('mirror-phase')) await this.mirror('running');
  }

  guard(): void {
    if (this.abandon) throw new Abandoned(this.abandon);
  }

  /**
   * 检查点：放弃了就抛 Abandoned；有人要暂停（#820 片 3）就停在这里等「继续」，回来的时候已经继续了。
   * 起新会话、选路、起新一步之前都过这里：暂停之后不再起新会话（soft 手上这一段做完；hard 动手会话当场停，见 cancellable）。
   * 老历史重放走不到暂停那一支（没有 taskPause 信号），所以平时不多调任何活动。
   */
  async checkpoint(): Promise<void> {
    this.guard();
    if (this.pauseReq !== null) await this.holdPaused(this.pauseReq);
  }

  /** 暂停的原因怎么写给人看：谁、为什么（没写原因就只写谁）。 */
  pauseNote(command: PauseCommand): string {
    return `${PAUSED_BY_HUMAN}（${command.by}）${command.reason ? `：${command.reason}` : ''}`;
  }

  /** 「现在就换」停下的这一段重跑时，提示词里写的话：谁、为什么（没写原因就只写谁）。 */
  repinNote(command: RepinCommand): string {
    return `被人要求现在就换模型（${command.by}）${command.reason ? `：${command.reason}` : ''}`;
  }

  /** 停着等「继续」或「放弃」：库里 phase=paused、state 仍是 running，不报警（不是出了问题），继续后回到原来的阶段。 */
  private async holdPaused(command: PauseCommand): Promise<void> {
    // 老历史里没有这一支：patched() 为假就当没有（走不到：老历史没有 taskPause 信号）
    if (!patched('task-pause')) return;
    const before = this.continued;
    const previous = { phase: this.status.phase, doing: this.status.doing, waiting: this.status.waiting };
    this.holding = true;
    this.status.phase = 'paused';
    this.status.doing = `已暂停：${this.pauseNote(command)}`;
    // 状态和等待一起落下（驾驶舱、巡检一读就是完整的「已暂停，在等继续」），再写库
    this.status.waiting = {
      kind: 'paused',
      detail: `已暂停（等「继续」或「放弃」）：${this.pauseNote(command)}`,
      since: iso(Date.now()),
    };
    try {
      await this.mirror('running');
      await condition(() => this.continued > before || this.abandon !== null);
    } finally {
      this.holding = false;
    }
    this.pauseReq = null;
    this.guard();
    this.status.phase = previous.phase;
    this.status.doing = previous.doing;
    this.status.waiting = previous.waiting;
    await this.mirror('running');
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
    await this.waiting(kind, detail, () =>
      condition(() => this.abandon !== null || this.pauseReq !== null, `${seconds} seconds`),
    );
    await this.checkpoint();
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
      condition(
        () => this.abandon !== null || this.pauseReq !== null || this.routeWakes > mark,
        `${seconds} seconds`,
      ),
    );
    await this.checkpoint();
    return woken ? 'woken' : 'timeout';
  }

  /** 把一段长活动放进可取消的范围：放弃的信号一到就取消它（活动心跳，收得到），结果抛 Abandoned。 */
  async cancellable<T>(fn: () => Promise<T>, options: { pausable?: boolean } = {}): Promise<T> {
    // 放弃的信号可能在上一个 await（比如换阶段落库）期间就到了：那时还没有可取消的范围，cancelRunning 是空的，
    // 信号只记了下来；这里不先看一眼，长活动就照常起、再没人去取消它，一直跑到它自己的限时（#706）。
    // 老历史里这一步没有这道检查：patched() 为假就照旧。
    if (patched('cancellable-guard')) this.guard();
    // hard 暂停的信号在这一段起之前就到了（前面落库那一步期间）：不起，当场按被暂停处理
    if (options.pausable && this.pauseReq?.mode === 'hard') throw new PausedInterrupt(this.pauseReq);
    const scope = new CancellationScope({ cancellable: true });
    this.cancelRunning = () => scope.cancel();
    this.runningPausable = options.pausable === true;
    try {
      return await scope.run(fn);
    } catch (error) {
      if (this.abandon && isCancellation(error)) throw new Abandoned(this.abandon);
      if (this.pauseCancelled && this.pauseReq && isCancellation(error)) {
        throw new PausedInterrupt(this.pauseReq);
      }
      // 老历史里没有这一支：patched() 为假就当没有（走不到：老历史没有 taskRepin 信号）
      if (this.repinCancelled && this.repinReq && isCancellation(error) && patched('task-repin')) {
        throw new RepinInterrupt(this.repinReq);
      }
      throw error;
    } finally {
      this.cancelRunning = null;
      this.runningPausable = false;
      this.pauseCancelled = false;
      this.repinCancelled = false;
      this.repinReq = null;
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
      await this.checkpoint();
      try {
        return await fn();
      } catch (error) {
        if (error instanceof Abandoned) throw error;
        if (isCancellation(error)) throw error;
        const failure = failureOf(error, source);
        // 合并冲突不在这一步里原地重试：第二次原文必一字不差，会直接挂起，会话根本看不到冲突。
        // 老历史没有这个标记，照旧交给失败分流（重试这一步，再不行挂起）。
        if (failure.code.toLowerCase() === 'merge_conflict' && patched('conflict-handoff-keeps-tree')) {
          // 合并还没开始（没跟踪的文件挡着）没有冲突标记：原反馈里有要并的提交，不能改写成「树里留着冲突标记」。
          const pending = conflictPendingOf(error, failure.message);
          throw new ConflictHandoff(conflictFilesOf(error, failure.message), {
            pending,
            instruction: pending ? null : failure.message,
          });
        }
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
