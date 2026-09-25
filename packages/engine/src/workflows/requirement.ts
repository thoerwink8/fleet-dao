// 需求工作流：分诊（看不懂就追问）→ 写需求文档 → 写方案、拆子任务 → 按依赖和「改同一块的不同时跑」起子任务 → 写结果文档 → 关单。
// 人发的命令（暂停、继续、叫停、换路由、回答、批准、加人闸）按任务发到这里，这里再转给对应的子任务；
// fleet 命令的叫醒不经这里转（后端直接发给会话所属的工作流），这里只认自己的会话（分诊、需求文档、方案）。

import type { SubtaskState, TaskState } from '@fleet-dao/shared';
import {
  CancellationScope,
  type ChildWorkflowHandle,
  condition,
  isCancellation,
  log,
  patched,
  setHandler,
  startChild,
  TemporalFailure,
  workflowInfo,
} from '@temporalio/workflow';
import {
  type ApprovalCommand,
  answerSignal,
  approveSignal,
  defaultSpecDir,
  pauseSignal,
  type RequirementInput,
  type RequirementPhase,
  type RequirementResult,
  type RequirementStatus,
  rejectSignal,
  requireApprovalSignal,
  requirementStatusQuery,
  rerouteSignal,
  resumeSignal,
  type SubtaskInput,
  type SubtaskResult,
  type SubtaskView,
  subtaskProgressSignal,
  subtaskWorkflowId,
  type Waiting,
  WORKFLOW_TYPES,
} from '../contract.ts';
import type { SchedItem, SchedState, SubtaskSpec, WaitReason } from '../decisions/plan.ts';
import type { Feedback } from '../decisions/verify.ts';
import { describeHolds, normalizeHolds } from '../holds.ts';
import type { IssueProgress, SessionBrief, TaskStateSnapshot, WaitKind } from '../ports.ts';
import {
  activitiesFor,
  askAndWait,
  attempt,
  attemptOrRework,
  type Control,
  gate,
  installControl,
  iso,
  judge,
  type Kit,
  limitsFor,
  NO_REWORK,
  newKit,
  park,
  type ReworkCarry,
  recordWait,
  reworkFeedback,
  runStage,
  stopActiveSessions,
  type Verdict,
} from './kit.ts';
import type { subtaskWorkflow } from './subtask.ts';

interface Item {
  /** 库里的 subtasks.id（经 decide 生成、记在历史里）。 */
  id: string;
  spec: SubtaskSpec;
  state: SubtaskState;
  started: boolean;
  workflowId: string | null;
  prNumber: number | null;
  paused: boolean;
  waiting: Waiting | null;
  /** 人闸标记：方案、分诊判出的，加上人工加的。 */
  holds: string[];
  /** 开始排队等的那一刻（起子任务时记一笔等待时长）。 */
  waitingSince: { kind: WaitKind; since: number; detail: string } | null;
  result: SubtaskResult | null;
  problem: string | null;
}

type ChildHandle = ChildWorkflowHandle<typeof subtaskWorkflow>;

const TERMINAL: readonly SubtaskState[] = ['merged', 'failed', 'stopped'];
const isTerminal = (state: SubtaskState) => TERMINAL.includes(state);

const STATE_OF_PHASE: Record<RequirementPhase, TaskState> = {
  triage: 'triaging',
  asking: 'asking',
  spec: 'planning',
  plan: 'planning',
  running: 'running',
  result: 'running',
  finished: 'done',
};

function describeWait(reason: WaitReason): string {
  const on = reason.on.map((k) => `「${k}」`).join('');
  if (reason.kind === 'deps') return `等依赖 ${on} 合并`;
  if (reason.kind === 'overlap') return `${on} 在改同一块地方，等它做完`;
  return `需求内并发已满（${on} 在跑）`;
}

function toSched(item: Item): SchedItem {
  let state: SchedState;
  if (item.state === 'merged' || item.state === 'failed' || item.state === 'stopped') state = item.state;
  else state = item.started ? 'running' : 'pending';
  return { key: item.spec.key, touches: item.spec.touches, dependsOn: item.spec.dependsOn, state };
}

function renderResult(input: RequirementInput, items: Item[], allMerged: boolean): string {
  const lines = [
    `# 结果：${input.title}`,
    '',
    `需求 #${input.issueNumber}（提出人：${input.requestedBy}）${allMerged ? '已全部合并。' : '没有全部做完。'}`,
    '',
    '## 子任务',
    '',
  ];
  for (const item of items) {
    const r = item.result;
    const pr = item.prNumber ? ` #${item.prNumber}` : '';
    const state = item.state === 'merged' ? '已合并' : item.state === 'stopped' ? '已叫停' : '没做成';
    const commit = r?.mergeCommit ? `（${r.mergeCommit.slice(0, 12)}）` : '';
    lines.push(`- ${item.spec.key}「${item.spec.title}」：${state}${pr}${commit}`);
    if (r?.summary) lines.push(`  - 做了什么：${r.summary}`);
    if (item.holds.length > 0) lines.push(`  - 人闸：${describeHolds(item.holds)}`);
    const problem = item.problem ?? r?.problem;
    if (problem) lines.push(`  - 问题：${problem}`);
    if (r && (r.rounds.review || r.rounds.ciFix || r.rounds.conflict || r.rounds.mergeReturn)) {
      lines.push(
        `  - 返工：第二意见 ${r.rounds.review} 轮、CI ${r.rounds.ciFix} 轮、冲突 ${r.rounds.conflict} 轮、合并队列退回 ${r.rounds.mergeReturn} 次`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function requirementWorkflow(input: RequirementInput): Promise<RequirementResult> {
  const info = workflowInfo();
  const specDir = input.specDir ?? defaultSpecDir(input.issueNumber, input.title);
  const items: Item[] = [];
  const handles = new Map<string, ChildHandle>();
  const askOwner: Record<string, string> = {};
  const approvalOwner: Record<string, string> = {};
  const settled: Promise<void>[] = [];
  /** 整个需求的人闸（分诊判出的、人工加的）：拆方案时每个子任务都带上。 */
  let requirementHolds: string[] = [];
  const status: RequirementStatus = {
    kind: 'requirement',
    taskId: input.taskId,
    issueNumber: input.issueNumber,
    state: 'triaging',
    phase: 'triage',
    doing: '分诊',
    paused: false,
    parked: false,
    waiting: null,
    route: null,
    runId: null,
    sessionId: null,
    subtasks: [],
    progress: { done: 0, total: 0 },
    docs: {},
    lastProblem: null,
    lastAgentEvent: null,
    commands: [],
  };

  const byKey = (key: string) => items.find((i) => i.spec.key === key);
  const live = () =>
    [...handles.entries()].filter(([key]) => {
      const item = byKey(key);
      return item !== undefined && !isTerminal(item.state);
    });
  const send = (key: string, handle: ChildHandle, deliver: (h: ChildHandle) => Promise<void>) => {
    deliver(handle).catch((error) => log.warn('命令没转到子任务', { key, error: String(error) }));
  };
  const forwardAll = (deliver: (h: ChildHandle) => Promise<void>): number => {
    const targets = live();
    for (const [key, handle] of targets) send(key, handle, deliver);
    return targets.length;
  };
  /** 批准、拒绝转给点名的子任务：按子任务编号，或按批准编号找当初报「在等批准」的那个。 */
  const forwardApproval = (command: ApprovalCommand, verb: 'approve' | 'reject'): Verdict => {
    let key: string | undefined;
    if (command.subtaskId) key = items.find((i) => i.id === command.subtaskId)?.spec.key;
    else if (command.approvalId) key = approvalOwner[command.approvalId];
    else return { accepted: false, note: '要点名批准编号或子任务（一次批一张）' };
    const item = key ? byKey(key) : undefined;
    const handle = key ? handles.get(key) : undefined;
    if (!key || !item || !handle || isTerminal(item.state)) {
      return { accepted: false, note: '点名的子任务不在跑' };
    }
    const signal = verb === 'approve' ? approveSignal : rejectSignal;
    send(key, handle, (h) => h.signal(signal, command));
    return { accepted: true, note: `转给子任务「${key}」` };
  };

  // 信号处理器挂上时会当场处理缓存着的信号：它们要用的东西都得先声明好。
  let controlRef: Control | null = null;
  let kitRef: Kit | null = null;
  let version = 0;
  // 具体的信号处理先挂，再挂兜底处理（兜底处理一挂上就会吃掉还没有处理器的缓存信号）。
  setHandler(subtaskProgressSignal, (progress) => {
    const item = byKey(progress.key);
    if (!item || isTerminal(item.state)) return;
    item.state = progress.state;
    item.prNumber = progress.prNumber ?? item.prNumber;
    item.paused = progress.paused;
    item.waiting = progress.waiting;
    item.holds = progress.holds ?? item.holds;
    const askId = progress.waiting?.askId;
    if (askId) {
      askOwner[askId] = progress.key;
      // 回答比子任务报「在等」还先到（先收在了这一层）：现在知道是谁问的，转过去。
      const early = controlRef?.answers[askId];
      const handle = handles.get(progress.key);
      if (controlRef && early && handle) {
        const { [askId]: _forwarded, ...rest } = controlRef.answers;
        controlRef.answers = rest;
        send(progress.key, handle, (h) => h.signal(answerSignal, early));
      }
    }
    if (progress.waiting?.approvalId) approvalOwner[progress.waiting.approvalId] = progress.key;
    version += 1;
  });
  const main = new CancellationScope();
  const control = installControl(input.routeOverrides, {
    onStop: () => main.cancel(),
    // 整个需求换路由：自己的分诊/需求文档/方案，加上子任务写码用的（在跑的转过去，没起的起的时候带上）。
    mainStages: ['triage', 'spec', 'plan', 'execute', 'ui'],
    ownsRun: (runId) => Boolean(kitRef?.active[runId]),
    forwardPause: (meta) => forwardAll((h) => h.signal(pauseSignal, meta)),
    forwardResume: (meta) => forwardAll((h) => h.signal(resumeSignal, meta)),
    forwardReroute: (command) => {
      if (!command.subtaskId) return forwardAll((h) => h.signal(rerouteSignal, command));
      const target = live().find(([key]) => byKey(key)?.id === command.subtaskId);
      if (!target) return 0;
      send(target[0], target[1], (h) => h.signal(rerouteSignal, command));
      return 1;
    },
    forwardAnswer: (command) => {
      const key = askOwner[command.askId];
      const handle = key ? handles.get(key) : undefined;
      if (!key || !handle) return false;
      send(key, handle, (h) => h.signal(answerSignal, command));
      return true;
    },
    approve: (command) => forwardApproval(command, 'approve'),
    reject: (command) => forwardApproval(command, 'reject'),
    requireApproval: (command) => {
      const holds = normalizeHolds(command.holds);
      if (holds.length === 0) return { accepted: false, note: '没给要拦的事' };
      const targets = command.subtaskId
        ? items.filter((i) => i.id === command.subtaskId && !isTerminal(i.state))
        : items.filter((i) => !isTerminal(i.state));
      if (command.subtaskId && targets.length === 0) {
        return { accepted: false, note: `没有在做的子任务 ${command.subtaskId}` };
      }
      // 没点名子任务：整个需求都带上，包括还没拆出来的。
      if (!command.subtaskId) requirementHolds = normalizeHolds([...requirementHolds, ...holds]);
      let forwarded = 0;
      for (const item of targets) {
        item.holds = normalizeHolds([...item.holds, ...holds]);
        const handle = handles.get(item.spec.key);
        if (handle) {
          send(item.spec.key, handle, (h) =>
            h.signal(requireApprovalSignal, { ...command, subtaskId: item.id }),
          );
          forwarded += 1;
        }
      }
      version += 1;
      const scope = command.subtaskId ? `子任务 ${command.subtaskId}` : '整个需求';
      return {
        accepted: true,
        note: `${scope}加人闸：${describeHolds(holds)}${forwarded > 0 ? `，转给 ${forwarded} 个在跑的子任务` : ''}`,
      };
    },
  });
  controlRef = control;
  const wakeVersion = () => version + control.version;

  const subtaskViews = (): SubtaskView[] =>
    items.map((i) => ({
      id: i.id,
      key: i.spec.key,
      title: i.spec.title,
      state: i.state,
      workflowId: i.workflowId,
      prNumber: i.prNumber,
      paused: i.paused,
      waiting: i.waiting,
      touches: i.spec.touches,
      dependsOn: i.spec.dependsOn,
      holds: i.holds,
    }));
  setHandler(requirementStatusQuery, () => ({
    ...status,
    paused: control.paused,
    parked: control.parked,
    subtasks: subtaskViews(),
    progress: { done: items.filter((i) => i.state === 'merged').length, total: items.length },
    lastAgentEvent: control.lastAgentEvent,
    commands: [...control.commands],
  }));

  const limits = await limitsFor(input.limits);
  const acts = activitiesFor(limits);
  const kit = newKit({
    acts,
    limits,
    control,
    scope: { taskId: input.taskId },
    view: status,
    onChange: () => undefined,
  });
  kitRef = kit;

  const idOfKey = (key: string) => byKey(key)?.id ?? key;
  let lastSaved = '';
  let lastPublished = '';
  /** 状态变了：写库给驾驶舱、原地更新 issue 的进度段。都是尽力而为，失败不挡流程。 */
  const publishProgress = async () => {
    const snapshot: TaskStateSnapshot = {
      ...kit.scope,
      repoId: input.repo.id,
      issueNumber: input.issueNumber,
      state: status.state,
      phase: status.phase,
      doing: status.doing,
      specDir,
      docs: status.docs,
      lastProblem: status.lastProblem,
      subtasks: items.map((i) => ({
        id: i.id,
        key: i.spec.key,
        index: i.spec.index,
        title: i.spec.title,
        touches: i.spec.touches,
        dependsOn: i.spec.dependsOn.map(idOfKey),
        state: i.state,
        prNumber: i.prNumber,
        waitingOn: i.waiting?.detail ?? null,
        workflowId: i.workflowId,
        holds: i.holds,
      })),
    };
    const snapshotText = JSON.stringify(snapshot);
    if (snapshotText !== lastSaved) {
      lastSaved = snapshotText;
      try {
        await CancellationScope.nonCancellable(() => acts.saveTaskState(snapshot));
      } catch (error) {
        log.warn('任务状态没写进库', { error: String(error) });
      }
    }
    const progress = progressFor(
      items.map((i) => ({ key: i.spec.key, title: i.spec.title, state: i.state, prNumber: i.prNumber })),
    );
    const progressText = JSON.stringify(progress);
    if (progressText === lastPublished) return;
    lastPublished = progressText;
    try {
      await CancellationScope.nonCancellable(() =>
        acts.updateIssueProgress({
          ...kit.scope,
          repo: input.repo,
          issueNumber: input.issueNumber,
          progress,
        }),
      );
    } catch (error) {
      log.warn('issue 进度段没更新上', { error: String(error) });
    }
  };
  /** issue 进度段的内容：需求到哪了、各子任务的标题和状态、文档在哪。 */
  function progressFor(subtasks: IssueProgress['subtasks']): IssueProgress {
    return {
      state: status.state,
      current: status.doing,
      done: subtasks.filter((s) => s.state === 'merged').length,
      total: subtasks.length,
      subtasks,
      docs: status.docs,
    };
  }
  const setPhase = async (phase: RequirementPhase, doing: string) => {
    status.phase = phase;
    status.state = STATE_OF_PHASE[phase];
    status.doing = doing;
    await publishProgress();
  };

  const brief = (answers: SessionBrief['answers'], feedback: Feedback[] = []): SessionBrief => ({
    title: input.title,
    request: input.rawRequest,
    specDir,
    acceptance: [],
    touches: [],
    feedback,
    answers,
  });

  const startSubtask = async (item: Item) => {
    const waited = item.waitingSince;
    const scope = { taskId: input.taskId, subtaskId: item.id, subtaskKey: item.spec.key };
    if (waited) {
      await recordWait({ ...kit, scope }, waited.kind, waited.detail, waited.since, Date.now());
      item.waitingSince = null;
    }
    const workflowId = subtaskWorkflowId(item.id);
    const args: SubtaskInput = {
      schemaVersion: 1,
      taskId: input.taskId,
      subtaskId: item.id,
      repo: input.repo,
      issueNumber: input.issueNumber,
      specDir,
      subtask: { ...item.spec, holds: item.holds },
      ...(input.limits ? { limits: input.limits } : {}),
      routeOverrides: control.routeOverrides,
    };
    const handle = await startChild<typeof subtaskWorkflow>(WORKFLOW_TYPES.subtask, {
      workflowId,
      args: [args],
      parentClosePolicy: 'REQUEST_CANCEL',
      cancellationType: 'WAIT_CANCELLATION_COMPLETED',
    });
    item.started = true;
    item.state = 'running';
    item.workflowId = workflowId;
    item.waiting = null;
    handles.set(item.spec.key, handle);
    // 起的时候需求正暂停着（判完可以起、还没起的那一刻来的暂停）：起来就先暂停住。
    if (control.paused) {
      send(item.spec.key, handle, (h) => h.signal(pauseSignal, { by: 'engine', reason: '需求暂停中' }));
    }
    settled.push(
      handle.result().then(
        (result) => {
          item.result = result;
          item.state = result.state;
          item.prNumber = result.prNumber ?? item.prNumber;
          item.problem = result.problem;
          item.waiting = null;
          version += 1;
        },
        (error) => {
          item.state = isCancellation(error) ? 'stopped' : 'failed';
          item.problem = String(error);
          item.waiting = null;
          version += 1;
        },
      ),
    );
  };

  const runSubtasks = async () => {
    for (;;) {
      await gate(kit);
      const decision = await judge(kit, 'runnable', {
        items: items.map(toSched),
        maxParallel: limits.maxParallelSubtasks,
      });
      for (const u of decision.unreachable) {
        const item = byKey(u.key);
        if (!item) continue;
        item.state = 'failed';
        item.problem = `依赖没做成：${u.because.join('、')}`;
        item.waiting = null;
      }
      for (const w of decision.waiting) {
        const item = byKey(w.key);
        if (!item) continue;
        const detail = describeWait(w);
        if (!item.waitingSince || item.waitingSince.kind !== w.kind) {
          const prev = item.waitingSince;
          if (prev) {
            const scope = { taskId: input.taskId, subtaskId: item.id, subtaskKey: w.key };
            await recordWait({ ...kit, scope }, prev.kind, prev.detail, prev.since, Date.now());
          }
          item.waitingSince = { kind: w.kind, since: Date.now(), detail };
        }
        item.state = w.kind === 'deps' ? 'waiting_deps' : 'waiting_slot';
        item.waiting = { kind: w.kind, detail, since: iso(item.waitingSince.since), on: w.on };
      }
      for (const key of decision.start) {
        const item = byKey(key);
        if (item) await startSubtask(item);
      }
      status.doing = `子任务：${items.filter((i) => i.state === 'merged').length}/${items.length} 已合并`;
      await publishProgress();
      if (items.every((i) => isTerminal(i.state))) return;
      const running = items.some((i) => i.started && !isTerminal(i.state));
      if (!running && decision.start.length === 0) {
        // 按方案本不该出现：没有在跑的、也起不来新的。挂起让人看，别空转。
        await park(
          kit,
          '子任务排不开',
          decision.waiting.map((w) => `${w.key}：${describeWait(w)}`).join('\n'),
        );
        continue;
      }
      const seen = wakeVersion();
      await condition(() => wakeVersion() !== seen);
    }
  };

  const run = async (): Promise<'done' | 'failed'> => {
    // 分诊：看不懂就在任务里追问
    await setPhase('triage', '分诊：判断需求清不清楚');
    const answers: SessionBrief['answers'] = [];
    let asked = 0;
    for (;;) {
      const triage = await runStage(kit, { stage: 'triage', expect: 'triage', brief: brief(answers) });
      const decision = await judge(kit, 'triage', {
        verdict: triage.output.verdict,
        asked,
        maxQuestions: limits.maxQuestions,
      });
      if (decision.action === 'proceed') {
        if (decision.assumed) status.lastProblem = decision.note;
        requirementHolds = normalizeHolds([...requirementHolds, ...(decision.holds ?? [])]);
        break;
      }
      asked += 1;
      await setPhase('asking', `追问：${decision.question}`);
      const answer = await askAndWait(kit, decision.question);
      answers.push({ question: decision.question, answer });
      await setPhase('triage', '按回答重新分诊');
    }

    await setPhase('spec', '写需求文档');
    // 需求文档、方案直写进主线（公开）：写之前 github 包过卫生检查，拦下了退回写它的会话拿掉再交（HY1，同一处
    // 连续两次挂起报警）；名单没读到、没扫成挂起报警（HY2）。
    let specFeedback: Feedback[] = [];
    let specRework: ReworkCarry = NO_REWORK;
    let specSession: string | undefined;
    for (;;) {
      const spec = await runStage(kit, {
        stage: 'spec',
        expect: 'doc',
        brief: brief(answers, specFeedback),
        resumeSessionId: specSession,
      });
      specSession = spec.sessionId;
      const specDoc = await attemptOrRework(
        kit,
        'writeSpecDoc',
        () =>
          acts.writeSpecDoc({
            ...kit.scope,
            repo: input.repo,
            issueNumber: input.issueNumber,
            specDir,
            doc: 'requirement',
            markdown: spec.output.markdown,
          }),
        specRework,
      );
      if ('rework' in specDoc) {
        specRework = specDoc.rework.carry;
        specFeedback = [reworkFeedback('doc', specDoc.rework)];
        status.lastProblem = specDoc.rework.reason;
        continue;
      }
      status.docs = { ...status.docs, requirement: specDoc.ok.path };
      break;
    }

    await setPhase('plan', '写方案、拆子任务');
    let planFeedback: Feedback[] = [];
    let planTries = 0;
    let planRework: ReworkCarry = NO_REWORK;
    let subtasks: SubtaskSpec[] = [];
    for (;;) {
      const plan = await runStage(kit, {
        stage: 'plan',
        expect: 'plan',
        brief: brief(answers, planFeedback),
      });
      const checked = await judge(kit, 'plan', {
        subtasks: plan.output.subtasks,
        maxSubtasks: limits.maxSubtasks,
        holds: requirementHolds,
      });
      if (checked.ok) {
        const planDoc = await attemptOrRework(
          kit,
          'writeSpecDoc',
          () =>
            acts.writeSpecDoc({
              ...kit.scope,
              repo: input.repo,
              issueNumber: input.issueNumber,
              specDir,
              doc: 'plan',
              markdown: plan.output.markdown,
            }),
          planRework,
        );
        if ('rework' in planDoc) {
          planRework = planDoc.rework.carry;
          planFeedback = [reworkFeedback('doc', planDoc.rework)];
          status.lastProblem = planDoc.rework.reason;
          continue;
        }
        status.docs = { ...status.docs, plan: planDoc.ok.path };
        // 子任务的标题（会话写的）从这里起写进公开的 issue 进度段：先照这份方案写一次，github 包写之前过卫生检查，
        // 拦下了退回写方案的会话改标题（HY1，同一处连续两次挂起报警），名单没读到挂起报警（HY2）。这一次写成了，
        // 后面各阶段的进度段里是同样的标题（进度段平时尽力写、写不上只记日志）。
        if (patched('plan-titles-hygiene')) {
          const titles = await attemptOrRework(
            kit,
            'updateIssueProgress',
            () =>
              acts.updateIssueProgress({
                ...kit.scope,
                repo: input.repo,
                issueNumber: input.issueNumber,
                progress: progressFor(
                  checked.subtasks.map((s) => ({
                    key: s.key,
                    title: s.title,
                    state: 'pending',
                    prNumber: null,
                  })),
                ),
              }),
            planRework,
          );
          if ('rework' in titles) {
            planRework = titles.rework.carry;
            planFeedback = [reworkFeedback('progress', titles.rework)];
            status.lastProblem = titles.rework.reason;
            continue;
          }
        }
        subtasks = checked.subtasks;
        break;
      }
      planFeedback = [{ kind: 'plan', summary: '方案不合格，按下面几条改', items: checked.problems }];
      if (planTries >= limits.planRetries) {
        await park(kit, '方案几次都不合格', checked.problems.join('\n'));
        planTries = 0;
      } else {
        planTries += 1;
      }
    }
    // 库里 subtasks.id：经 decide 生成、记进历史（重放时取历史里的，不随代码里调了几次而错位）。
    const ids = await judge(kit, 'newIds', { count: subtasks.length });
    for (const [n, spec] of subtasks.entries()) {
      const id = ids[n];
      if (!id) throw new Error('newIds 给的编号不够');
      items.push({
        id,
        spec,
        state: 'pending',
        started: false,
        workflowId: null,
        prNumber: null,
        paused: false,
        waiting: null,
        // 方案拆完之后才人工加的整个需求的人闸，也带上。
        holds: normalizeHolds([...(spec.holds ?? []), ...requirementHolds]),
        waitingSince: null,
        result: null,
        problem: null,
      });
    }

    await setPhase('running', `${items.length} 个子任务开工`);
    await runSubtasks();

    await setPhase('result', '写结果文档');
    const allMerged = items.every((i) => i.state === 'merged');
    const resultDoc = await attempt(kit, 'writeSpecDoc', () =>
      acts.writeSpecDoc({
        ...kit.scope,
        repo: input.repo,
        issueNumber: input.issueNumber,
        specDir,
        doc: 'result',
        markdown: renderResult(input, items, allMerged),
      }),
    );
    status.docs = { ...status.docs, result: resultDoc.path };
    if (!allMerged) return 'failed';
    await attempt(kit, 'closeIssue', () =>
      acts.closeIssue({
        ...kit.scope,
        repo: input.repo,
        issueNumber: input.issueNumber,
        reason: 'completed',
        comment: `做完了：${resultDoc.path}`,
      }),
    );
    return 'done';
  };

  let final: RequirementResult['state'];
  let problem: string | null = null;
  try {
    final = await main.run(run);
  } catch (error) {
    if (isCancellation(error)) {
      final = 'stopped';
      problem = '叫停';
    } else if (error instanceof TemporalFailure) {
      final = 'failed';
      problem = error.message;
    } else {
      throw error;
    }
  }

  // 自己的会话（分诊、需求文档、方案）停掉；等子任务各自收完尾（叫停时它们在撤出合并队列、收工作树）。
  await CancellationScope.nonCancellable(async () => {
    await stopActiveSessions(kit, problem ?? '收尾');
    await Promise.all(settled);
  });
  status.runId = null;
  status.sessionId = null;
  status.phase = 'finished';
  status.state = final;
  status.doing = final === 'done' ? '做完了' : final === 'stopped' ? '已叫停' : '没有全部做完';
  status.waiting = null;
  if (problem) status.lastProblem = problem;
  if (final === 'failed') {
    const failedKeys = items.filter((i) => i.state !== 'merged').map((i) => i.spec.key);
    await CancellationScope.nonCancellable(() =>
      acts.raiseAlert({
        ...kit.scope,
        level: 'stuck',
        title: `需求 #${input.issueNumber} 没有全部做完`,
        detail: problem ?? `没做成的子任务：${failedKeys.join('、')}`,
        dedupeKey: `${info.workflowId}:failed`,
      }),
    ).catch((error) => log.warn('报警没发出去', { error: String(error) }));
  }
  await publishProgress();
  return {
    taskId: input.taskId,
    state: final,
    subtasks: items.map(
      (i) =>
        i.result ?? {
          key: i.spec.key,
          subtaskId: i.id,
          state: i.state === 'merged' ? 'merged' : i.state === 'stopped' ? 'stopped' : 'failed',
          prNumber: i.prNumber,
          mergeCommit: null,
          summary: '',
          problem: i.problem,
          rounds: { review: 0, ciFix: 0, conflict: 0, mergeReturn: 0 },
        },
    ),
    docs: status.docs,
    problem,
  };
}
