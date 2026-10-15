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
import type { RouteChoice, Worktree } from '../ports.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import {
  type AbandonCommand,
  CI_POLICY_POLL_SECONDS,
  type GuardedPaths,
  MAX_ROUND_RESETS,
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
  AutoEscape,
  type Avoid,
  avoidableFamily,
  bump,
  ConflictHandoff,
  type LastSession,
  NO_AVOID,
  PausedInterrupt,
  RepinInterrupt,
  type ResumeFrom,
  stripUndefined,
  widen,
  withFamily,
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
  /**
   * 正在跑的长活动的取消钩子。冷验收和等 CI 并行（决定 0093）时同时有好几个（和 CI 同时起的那次验收没被认时让它自己跑完，
   * 可能一直跑到下一轮动手）：放弃要全取消，所以是一组、不是一个。
   */
  private readonly running = new Set<() => void>();
  /** 动手会话那一段的取消钩子：hard 暂停、「现在就换」只取消它，不碰旁边还在跑的验收。 */
  private cancelPausable: (() => void) | null = null;
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
  /** 直接合被拒、因为落后主线，引擎已经自动把这张 PR 同步过几次主线（上限 MAX_MAIN_SYNCS，之后停下报人）。 */
  mainSyncs = 0;
  /** 等合并这一轮已经见过一次必过检查红（#1983）。确认窗口里再红一次才返工；中间变回还在跑就清掉。 */
  mergeRedNoted = false;
  changedFiles: string[] = [];
  feedback: string[] = [];
  /**
   * 最近一次冷验收没过的原话。推上去之后 feedback 会被清掉，验收轮数用尽时通知还要靠它，不能跟着清。
   */
  verifyProblems: string[] = [];
  /** 当前单子正文读出来的交代。点「继续」重读之后换掉，验收用这一份，不用起任务时的旧版。 */
  brief: TaskBrief | null = null;
  /** 轮数用尽、人点「继续」之后重读单子。由 TaskFlow 接上。 */
  reloadBrief: () => Promise<void> = async () => {
    throw new Error('重读单子还没接上（工作流自己的状态乱了）');
  };
  readonly families = new Set<string>();
  /**
   * 这张单里，动手会话跑完却没有提交时攒下的避让（#1408）。只活在这次运行里，下张单是新的运行时，不带着走。
   * 轮数用尽后点「继续」清掉。
   */
  commitAvoid: Avoid = NO_AVOID;
  /** 连着多少轮动手会话跑完没有提交。中间有了提交就从 0 再计。 */
  commitMisses = 0;
  /** 最近一轮没提交时用的路由。避让之后没有别的候选，就照旧派它。 */
  commitMissRoute: RouteChoice | null = null;
  /** 这一轮动手会话实际跑完时用的路由。没跑成的不算。 */
  lastImplementRoute: RouteChoice | null = null;
  /** 这一轮选路时避让把候选滤光了，改派了原来的路由。 */
  fellBackToMissRoute = false;
  /**
   * 下一次动手会话打算续哪一段（决定 0088，task-session.ts）：判一次就清掉，续不上的不再试。
   * 只在 patched('segment-resume') 之后才会被写上，老历史一直是 null。
   */
  resumeFrom: ResumeFrom | null = null;
  /** 上一次跑成的动手会话（决定 0093）：返工轮续它（task.ts 的 implement，patched('rework-resume')）。 */
  lastSession: LastSession | null = null;
  /** 连着几次跑成的动手会话是续起来的：到 RESUME_STREAK_LIMIT 下一轮开新会话。 */
  resumeStreak = 0;
  /** 最近一次自测（决定 0093）的精炼输出：交给冷验收当材料（ColdVerifyInput.testOutput）。没跑过、头换了就是 null。 */
  selfCheckOutput: { head: string; text: string } | null = null;
  /** 单任务 token 预算给了几份（决定 0093）：超了停下，点「继续」再给。 */
  budgetGrants = 1;
  round = 0;
  verifyRound = 0;
  /** 因轮数用尽点过几次「继续」（清零的次数；超过 MAX_ROUND_RESETS 就不再清）。 */
  private roundResets = 0;
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
        this.cancelPausable?.();
      }
    });
    // 「现在就换」（#1216）：只有正在跑的动手会话能当场停（和 hard 暂停同一条取消的路）；没在跑就不理——新指定已经在库里，下一次选路照它。
    // hard 暂停已经把这一段取消了、或已经在放弃：不抢。
    setHandler(taskRepinSignal, (command) => {
      if (!this.runningPausable || this.pauseCancelled || this.repinCancelled || this.abandon) return;
      this.repinReq = command;
      this.repinCancelled = true;
      this.cancelPausable?.();
    });
    setHandler(taskRouteWakeSignal, () => {
      this.routeWakes += 1;
    });
    setHandler(taskAbandonSignal, (command) => {
      this.abandon ??= command;
      this.cancelAll();
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

  private cancelAll(): void {
    for (const cancel of [...this.running]) cancel();
  }

  /**
   * 自动处理了一次、不停下等人（决定 0093）：在任务进度里写一行（库里的 doing），阶段不变。
   */
  async note(line: string): Promise<void> {
    await this.advance(this.status.phase, line);
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
   * 多张单同时等这里时，测试不要对未收场的工作流 await result()：TimeSkippingWorkflowClient.result
   * 会全局 unlockTimeSkipping，另一张若仍停在本条件上等 taskRouteWake、或活动尚在工人手里，时钟一跳即判 START_TO_CLOSE（#1764）。
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
    // 放弃的信号可能在上一个 await（比如换阶段落库）期间就到了：那时还没有可取消的范围，running 里没有它，
    // 信号只记了下来；这里不先看一眼，长活动就照常起、再没人去取消它，一直跑到它自己的限时（#706）。
    // 老历史里这一步没有这道检查：patched() 为假就照旧。
    if (patched('cancellable-guard')) this.guard();
    // hard 暂停的信号在这一段起之前就到了（前面落库那一步期间）：不起，当场按被暂停处理
    if (options.pausable && this.pauseReq?.mode === 'hard') throw new PausedInterrupt(this.pauseReq);
    const scope = new CancellationScope({ cancellable: true });
    const cancel = () => scope.cancel();
    const pausable = options.pausable === true;
    this.running.add(cancel);
    // 只有动手会话那一段动这几样：旁边自己跑完的验收收场时不能把它们清掉
    if (pausable) {
      this.cancelPausable = cancel;
      this.runningPausable = true;
    }
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
      this.running.delete(cancel);
      if (pausable) {
        this.cancelPausable = null;
        this.runningPausable = false;
        this.pauseCancelled = false;
        this.repinCancelled = false;
        this.repinReq = null;
      }
    }
  }

  /**
   * 轮数用尽。这张单头一回用尽（patched('auto-continue-rounds')，决定 0093）：不停下，自动换一条路由（避开最近动手的那个模型）
   * 带上意见续一次，进度里写一行，回 auto；调用方直接起动手，不先重走 CI 和验收。之后用尽才停下等人：点了「继续」，累计不超过
   * MAX_ROUND_RESETS 次（自动那一次也算）就把动手和验收轮数都清零并重读单子；超过就停住，写明交给指挥官，不再清零。
   * 同一次继续里原来的上限仍在。老历史没有 continue-resets-rounds：返回 legacy，调用方只把用尽的那一个计数清掉，不多读单子。
   */
  async exhaustRounds(
    title: string,
    legacyDetail: string,
    detail: string,
    level: 'stuck' | 'decision' = 'stuck',
  ): Promise<'legacy' | 'reset' | 'auto'> {
    const reset = patched('continue-resets-rounds');
    if (reset && this.roundResets === 0 && patched('auto-continue-rounds')) {
      this.roundResets += 1;
      const avoided = this.avoidLastModel();
      this.resetRounds();
      await this.reloadBrief();
      await this.note(
        `${title}：自动换一条路由${avoided ? `（避开 ${avoided}）` : ''}带上意见再做一次，不停下等人（再用完才停）`,
      );
      return 'auto';
    }
    await this.park(title, reset ? detail : legacyDetail, level);
    // 点「继续」清掉没提交攒下的避让，和轮数清零同一处（#1408）。老历史没有这个标记，不碰。
    if (patched('avoid-empty-commit-route')) this.clearCommitAvoid();
    if (!reset) return 'legacy';
    this.roundResets += 1;
    if (this.roundResets > MAX_ROUND_RESETS) {
      const handoff = `已继续 ${MAX_ROUND_RESETS} 次仍没过，交指挥官`;
      for (;;) {
        await this.park(handoff, handoff);
      }
    }
    this.resetRounds();
    await this.reloadBrief();
    return 'reset';
  }

  /** 两轮计数清零；单子可能改了：重读之后开新会话，不续带着旧交代的那个。 */
  private resetRounds(): void {
    this.round = 0;
    this.verifyRound = 0;
    this.lastSession = null;
    this.resumeStreak = 0;
  }

  /**
   * 自动续那一次换路由：把最近动手的那个模型记进这张单的避让。还没动过手回 null。
   */
  private avoidLastModel(): string | null {
    const last = this.lastImplementRoute;
    if (!last) return null;
    this.avoidModel(last);
    return last.modelId;
  }

  /**
   * 自动处理时换路由（决定 0093）：把这个模型记进这张单的避让（和没提交的避让同一处，pickRoute 读它）；认得出族的连这一族一起避开
   * （patched('avoid-model-family')：同族换个模型多半重蹈覆辙）。别的族派不出时选路退回只避开模型，还没有别的候选就照旧派原来那条
   * （commitMissRoute），不死等。人点「继续」时清掉。老历史没有这个标记，只避开模型。
   */
  avoidModel(route: RouteChoice): void {
    this.commitAvoid = widen(this.commitAvoid, route, 'model');
    const family = avoidableFamily(route);
    if (family !== null && patched('avoid-model-family'))
      this.commitAvoid = withFamily(this.commitAvoid, family);
    this.commitMissRoute = route;
  }

  /** 「继续」之后，没提交攒下的避让不再带到后面的轮。 */
  private clearCommitAvoid(): void {
    this.commitAvoid = NO_AVOID;
    this.commitMisses = 0;
    this.commitMissRoute = null;
    this.fellBackToMissRoute = false;
  }

  /**
   * 停下等人：报警、写库、等「继续」或「放弃」。继续了回来，调用方从头再试这一步。
   * level 默认 stuck（提醒）。等合并检查红了、返工轮数用完传 decision，进「要你拍的」。
   */
  async park(title: string, detail: string, level: 'stuck' | 'decision' = 'stuck'): Promise<void> {
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
          level,
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

  /**
   * 停下等人，但每 CI_POLICY_POLL_SECONDS 秒问一次 leave。leave 回 true：恢复运行并回 left（仓已切成不强制 CI）。
   * 人点「继续」回 stayed。放弃抛 Abandoned。还没离开就继续等，不每轮再报警。
   * 只给 patched('repo-ci-policy') 的新路径用；老的 park() 仍是无限等。
   */
  async parkUnless(title: string, detail: string, leave: () => Promise<boolean>): Promise<'left' | 'stayed'> {
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
    for (;;) {
      const woken = await this.waiting('human', `${title}（等「继续」或「放弃」，或仓改成不强制 CI）`, () =>
        condition(
          () => this.continued > before || this.abandon !== null,
          `${CI_POLICY_POLL_SECONDS} seconds`,
        ),
      );
      this.guard();
      if (woken && this.continued > before) {
        this.status.phase = previous;
        this.status.lastProblem = null;
        await this.mirror('running');
        return 'stayed';
      }
      if (await leave()) {
        this.status.phase = previous;
        this.status.lastProblem = null;
        await this.mirror('running');
        return 'left';
      }
    }
  }

  // ---- 失败分流

  /**
   * 一步：活动自己的重试用完还失败，按失败分流走——有界重试（退避，或等上游给的时间）；再不行停下等人，「继续」之后从头再试。
   * 不绑路由的步骤用它；动手会话在 task-session.ts 里自己带换路由、换模型。
   * autoCodes：判了停下等人、码（小写）在这里面的，不停下，抛 AutoEscape 交给调用方先自动处理一次。
   */
  async step<T>(source: string, fn: () => Promise<T>, autoCodes: readonly string[] = []): Promise<T> {
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
        // 工作树有没推的提交、本地又并不上：停下时把报错原文写进原因（里面有工作树路径和提交号）。
        // 看板「停下等人」读 lastProblem；失败分流的标题只有规则名，装不下这些。
        // 老历史没有这个标记，照旧交给失败分流（原因是规则标题那一句）。
        if (failure.code.toLowerCase() === 'worktree_diverged' && patched('worktree-diverged-note')) {
          await this.park(failure.message, failure.message);
          counters = ZERO;
          previousMessage = undefined;
          continue;
        }
        const next = await this.classify(failure, counters, false, { previousMessage });
        previousMessage = failure.message;
        this.status.lastProblem = next.reason;
        if (next.action === 'retry') {
          counters = bump(counters, next);
          await this.pause(next.wait === 'quota' ? 'quota' : 'retry', next.reason, next.delaySeconds);
        } else {
          // 调用方说这个码先自动处理一次（决定 0093）：不停下，交给调用方。老历史没有这个标记，照旧停下。
          if (autoCodes.includes(failure.code.toLowerCase()) && patched('auto-before-park')) {
            throw new AutoEscape(failure.code, failure.message);
          }
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
