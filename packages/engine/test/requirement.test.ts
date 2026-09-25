import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentEventSignal,
  answerSignal,
  approveSignal,
  pauseSignal,
  type RequirementResult,
  type RequirementStatus,
  requirementWorkflowId,
  rerouteSignal,
  resumeSignal,
  type SubtaskStatus,
  stopSignal,
  subtaskWorkflowId,
  WORKFLOW_TYPES,
} from '../src/contract.ts';
import { createFakeWorld, type FakeCall } from '../src/fakes.ts';
import { PortError, type StartSessionInput, type WaitTiming } from '../src/ports.ts';
import {
  markerText,
  overlaps,
  queryUntil,
  requirementInput,
  useEnv,
  waitUntil,
  withWorker,
} from './helpers.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const startRequirement = (taskQueue: string, input = requirementInput()) =>
  env.client.workflow.start(WORKFLOW_TYPES.requirement, {
    taskQueue,
    workflowId: requirementWorkflowId(input.repo, input.issueNumber),
    args: [input],
  });

/** 某个子任务的会话（按 subtaskKey）。 */
const sessionsOf = (calls: FakeCall[], key: string) =>
  calls.filter((c) => c.port === 'startSession' && (c.input as StartSessionInput).subtaskKey === key);

/** 某个子任务从第一次起会话到合并完成的时间段。 */
function spanOf(calls: FakeCall[], key: string, prNumber: number) {
  const first = sessionsOf(calls, key)[0];
  const merge = calls.find(
    (c) => c.port === 'mergePr' && (c.input as { prNumber: number }).prNumber === prNumber,
  );
  return { at: first?.at ?? 0, end: merge?.end ?? null };
}

describe('需求工作流', { timeout: 60_000 }, () => {
  it('顺利走完：分诊 → 需求文档 → 方案 → 子任务（子工作流）→ 结果文档 → 关单', async () => {
    const world = createFakeWorld({
      plan: [
        { key: 'login', title: '登录页加验证码', touches: ['src/login'] },
        { key: 'docs', title: '更新说明', touches: ['docs'], risk: 'low' },
      ],
    });
    const input = requirementInput();
    const { result, history } = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q, input);
      const done = (await handle.result()) as RequirementResult;
      return { result: done, history: await handle.fetchHistory() };
    });
    expect(result.state).toBe('done');
    expect(result.subtasks.map((s) => [s.key, s.state])).toEqual([
      ['login', 'merged'],
      ['docs', 'merged'],
    ]);
    // 子任务工作流编号就是 sub:<子任务编号>（后端手里有 subtask_id 就拼得出来）。
    expect(world.states.at(-1)?.subtasks.map((s) => s.workflowId === subtaskWorkflowId(s.id))).toEqual([
      true,
      true,
    ]);
    // 子任务编号、需求自己的会话编号都是 decide 生成、记在历史里的（重放时取历史里的，不随代码里调了几次错位）。
    const recorded = markerText(history);
    for (const s of result.subtasks) expect(recorded).toContain(s.subtaskId);
    const ownRuns = world
      .callsOf('startSession')
      .filter((c) => !c.input.subtaskId)
      .map((c) => c.input.runId);
    expect(ownRuns).toHaveLength(3);
    for (const runId of ownRuns) expect(recorded).toContain(runId);
    expect(world.callsOf('writeSpecDoc').map((c) => c.input.doc)).toEqual(['requirement', 'plan', 'result']);
    expect(result.docs).toEqual({
      requirement: 'specs/12-登录页加验证码/需求.md',
      plan: 'specs/12-登录页加验证码/方案.md',
      result: 'specs/12-登录页加验证码/结果.md',
    });
    expect(world.callsOf('closeIssue').map((c) => c.input.reason)).toEqual(['completed']);
    // 分诊、需求文档、方案各一个会话；login 写码 + 第二意见；docs 是低风险，只写码不要第二意见。
    expect(
      world
        .callsOf('startSession')
        .map((c) => `${c.input.subtaskKey ?? '-'}:${c.input.stage}`)
        .sort(),
    ).toEqual(['-:plan', '-:spec', '-:triage', 'docs:execute', 'login:execute', 'login:review'].sort());
    // 驾驶舱读库：最后一次写进库的是做完了、两个子任务都合并，子任务编号是 UUID。
    const last = world.states.at(-1);
    expect(last?.state).toBe('done');
    expect(last?.subtasks.map((s) => [s.key, s.state])).toEqual([
      ['login', 'merged'],
      ['docs', 'merged'],
    ]);
    for (const s of last?.subtasks ?? []) expect(s.id).toMatch(UUID);
    expect(result.subtasks.map((s) => s.subtaskId)).toEqual(last?.subtasks.map((s) => s.id));
    const lastProgress = world.callsOf('updateIssueProgress').at(-1)?.input.progress;
    expect(lastProgress).toMatchObject({ state: 'done', done: 2, total: 2 });
  });

  it('需求文档写进主线前被卫生检查拦下：退回写需求文档的会话（续同一个）拿掉再交，第二次写成', async () => {
    const world = createFakeWorld({
      specDoc: (input, n) =>
        input.doc === 'requirement' && n === 1
          ? new PortError('HYGIENE_BLOCKED', '卫生检查拦下了要公开的内容：specs/12-x/需求.md:3 known-value', {
              retryable: false,
            })
          : undefined,
    });
    const result = await withWorker(
      env,
      world,
      async (q) => (await (await startRequirement(q)).result()) as RequirementResult,
    );
    expect(result.state).toBe('done');
    const specs = world.callsOf('startSession').filter((c) => c.input.stage === 'spec');
    expect(specs).toHaveLength(2);
    expect(specs[1]?.input.resumeSessionId).toBeTruthy();
    const feedback = specs[1]?.input.brief.feedback ?? [];
    expect(feedback.map((f) => f.kind)).toEqual(['hygiene']);
    expect(feedback[0]?.items).toEqual(['卫生检查拦下了要公开的内容：specs/12-x/需求.md:3 known-value']);
    expect(world.callsOf('writeSpecDoc').map((c) => c.input.doc)).toEqual([
      'requirement',
      'requirement',
      'plan',
      'result',
    ]);
  });

  it('方案写进主线前被拦下：退回写方案的会话重写；名单没读到就挂起报警，放好点继续', async () => {
    const world = createFakeWorld({
      specDoc: (input, n) => {
        if (input.doc !== 'plan') return undefined;
        if (n === 2)
          return new PortError('HYGIENE_BLOCKED', '卫生检查拦下了要公开的内容：specs/12-x/方案.md:9 ip', {
            retryable: false,
          });
        if (n === 3)
          return new PortError('HYGIENE_LIST_MISSING', '写之前的卫生检查没法做：已知敏感值名单没读到', {
            retryable: false,
          });
        return undefined;
      },
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      const parked = await queryUntil<RequirementStatus>(handle, (s) => s.parked, '挂起');
      expect(parked.lastProblem).toContain('名单没读到');
      await handle.signal(resumeSignal, { by: 'founder' });
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('done');
    const plans = world.callsOf('startSession').filter((c) => c.input.stage === 'plan');
    expect(plans).toHaveLength(2);
    expect((plans[1]?.input.brief.feedback ?? []).map((f) => f.kind)).toEqual(['hygiene']);
  });

  it('子任务标题写进 issue 进度段前被卫生检查拦下：退回写方案的会话改标题（意见说的是进度段），再写成才开工', async () => {
    let titled = 0;
    const world = createFakeWorld({
      plan: [{ key: 'login', title: '登录页加验证码', touches: ['src/login'] }],
      progress: (input) => {
        if (input.progress.subtasks.length === 0) return undefined;
        titled += 1;
        return titled === 1
          ? new PortError(
              'HYGIENE_BLOCKED',
              '卫生检查拦下了要公开的内容：#12 的进度段：第 1 个子任务:1 known-value',
              { retryable: false },
            )
          : undefined;
      },
    });
    const result = await withWorker(
      env,
      world,
      async (q) => (await (await startRequirement(q)).result()) as RequirementResult,
    );
    expect(result.state).toBe('done');
    const plans = world.callsOf('startSession').filter((c) => c.input.stage === 'plan');
    expect(plans).toHaveLength(2);
    const feedback = plans[1]?.input.brief.feedback ?? [];
    expect(feedback.map((f) => f.kind)).toEqual(['hygiene']);
    expect(feedback[0]?.summary).toContain('进度段');
    expect(feedback[0]?.items).toEqual([
      '卫生检查拦下了要公开的内容：#12 的进度段：第 1 个子任务:1 known-value',
    ]);
    // 标题过了检查才开工：子任务的会话都在第二次写方案之后
    const firstExec = world.calls.findIndex(
      (c) => c.port === 'startSession' && (c.input as StartSessionInput).stage === 'execute',
    );
    expect(firstExec).toBeGreaterThan(world.calls.indexOf(plans[1] as FakeCall));
  });

  it('写进度段前卫生检查的名单没读到：挂起报警、不退回写方案的会话；放好点继续就开工', async () => {
    let titled = 0;
    const world = createFakeWorld({
      progress: (input) => {
        if (input.progress.subtasks.length === 0) return undefined;
        titled += 1;
        return titled === 1
          ? new PortError('HYGIENE_LIST_MISSING', '写进度段之前的卫生检查没法做：已知敏感值名单没读到', {
              retryable: false,
            })
          : undefined;
      },
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      const parked = await queryUntil<RequirementStatus>(handle, (s) => s.parked, '挂起');
      expect(parked.lastProblem).toContain('名单没读到');
      await handle.signal(resumeSignal, { by: 'founder' });
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('done');
    expect(world.callsOf('startSession').filter((c) => c.input.stage === 'plan')).toHaveLength(1);
  });

  it('看不懂就在任务里追问：回答（后端的 answer 信号）之后重新分诊，再往下走', async () => {
    const world = createFakeWorld({
      triage: (n) => (n === 1 ? { clear: false, question: '验证码发短信还是邮件？' } : { clear: true }),
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      const asking = await queryUntil<RequirementStatus>(
        handle,
        (s) => s.waiting?.askId !== undefined,
        '在等回答',
      );
      expect(asking.phase).toBe('asking');
      expect(asking.waiting?.kind).toBe('human');
      await handle.signal(answerSignal, {
        by: 'founder',
        askId: asking.waiting?.askId ?? '',
        answer: '短信',
      });
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('done');
    expect(world.callsOf('askHuman').map((c) => c.input.question)).toEqual(['验证码发短信还是邮件？']);
    const triages = world.callsOf('startSession').filter((c) => c.input.stage === 'triage');
    expect(triages[1]?.input.brief.answers).toEqual([{ question: '验证码发短信还是邮件？', answer: '短信' }]);
  });

  it('子任务按依赖先后跑：后面的等前面的合并了才开工', async () => {
    const world = createFakeWorld({
      plan: [
        { key: 'api', title: '后端接口', touches: ['src/api'] },
        { key: 'page', title: '页面', touches: ['src/page'], dependsOn: ['api'] },
      ],
    });
    const result = (await withWorker(env, world, async (q) =>
      (await startRequirement(q)).result(),
    )) as RequirementResult;
    expect(result.state).toBe('done');
    const apiMerged = world.callsOf('mergePr').find((c) => c.input.subtaskKey === 'api');
    const pageTree = world.callsOf('createWorktree').find((c) => c.input.subtaskKey === 'page');
    expect(apiMerged?.end).not.toBeNull();
    expect(pageTree?.at ?? 0).toBeGreaterThanOrEqual(apiMerged?.end ?? Number.POSITIVE_INFINITY);
    // 等依赖的时长单独记了一笔。
    const waits = world.timings.filter((t): t is WaitTiming => t.kind === 'wait' && t.subtaskKey === 'page');
    expect(waits.map((w) => w.waitFor)).toContain('deps');
  });

  it('会改同一块地方的不同时跑，互不相干的并行', async () => {
    const world = createFakeWorld({
      plan: [
        { key: 'form', title: '登录表单', touches: ['src/login'] },
        { key: 'form-style', title: '表单样式', touches: ['src/login/form.css'] },
        { key: 'readme', title: '说明', touches: ['README.md'] },
      ],
      // 登录表单的写码会话挂住，好在它跑着的时候看别的子任务。
      session: (input, n) =>
        input.subtaskKey === 'form' && input.stage === 'execute' && n === 1 ? { hold: true } : {},
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      await waitUntil(() => world.held().length === 1, 'form 的写码会话挂着');
      // readme 不相干，照样做完；form-style 改的地方被 form 占着，排队等。
      await queryUntil<RequirementStatus>(
        handle,
        (s) => s.subtasks.find((x) => x.key === 'readme')?.state === 'merged',
        'readme 合并',
      );
      const status = (await handle.query('status')) as RequirementStatus;
      const style = status.subtasks.find((x) => x.key === 'form-style');
      expect(style?.state).toBe('waiting_slot');
      expect(style?.waiting).toMatchObject({ kind: 'overlap', on: ['form'] });
      expect(sessionsOf(world.calls, 'form-style')).toHaveLength(0);
      const held = world.held()[0];
      if (held) world.release(held.id);
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('done');
    const pr = (key: string) => result.subtasks.find((s) => s.key === key)?.prNumber ?? -1;
    const form = spanOf(world.calls, 'form', pr('form'));
    const style = spanOf(world.calls, 'form-style', pr('form-style'));
    const readme = spanOf(world.calls, 'readme', pr('readme'));
    expect(overlaps(form, style)).toBe(false);
    expect(overlaps(form, readme)).toBe(true);
  });

  it('叫停：在跑的子任务停会话、收树，需求以 stopped 结束，不关单', async () => {
    const world = createFakeWorld({
      session: (input) => (input.stage === 'execute' ? { hold: true } : {}),
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      await handle.signal(stopSignal, { by: 'founder', reason: '不做了' });
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('stopped');
    expect(result.subtasks.map((s) => s.state)).toEqual(['stopped']);
    expect(world.callsOf('stopSession').map((c) => c.input.mode)).toEqual(['kill']);
    expect(world.callsOf('removeWorktree').map((c) => c.input.archive)).toEqual([true]);
    expect(world.count('closeIssue')).toBe(0);
    expect(world.states.at(-1)?.state).toBe('stopped');
  });

  it('暂停、继续发给需求，转给在跑的子任务', async () => {
    const world = createFakeWorld({
      session: (input, n) => (input.stage === 'execute' && n === 1 ? { hold: true } : {}),
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      await handle.signal(pauseSignal, { by: 'founder' });
      await waitUntil(() => world.count('stopSession') === 1, '子任务的会话被请停');
      const paused = await queryUntil<RequirementStatus>(
        handle,
        (s) => s.subtasks[0]?.paused === true,
        '子任务暂停',
      );
      expect(paused.commands.at(-1)).toMatchObject({ command: 'pause', accepted: true });
      await handle.signal(resumeSignal, { by: 'founder' });
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('done');
    const execs = world.callsOf('startSession').filter((c) => c.input.stage === 'execute');
    expect(execs).toHaveLength(2);
    // 继续后续上原来那个写码会话。
    expect(execs[0]?.input.resumeSessionId).toBeUndefined();
    expect(world.sessions.get(execs[1]?.input.resumeSessionId ?? '')?.stage).toBe('execute');
  });

  it('换路由点名一个子任务：只有它停在干净的点、换上新路由接着干', async () => {
    const world = createFakeWorld({
      plan: [
        { key: 'a', title: 'A', touches: ['src/a'] },
        { key: 'b', title: 'B', touches: ['src/b'] },
      ],
      session: (input, n) => (input.stage === 'execute' && n <= 2 ? { hold: true } : {}),
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      await waitUntil(() => world.held().length === 2, '两个写码会话都挂着');
      const status = (await handle.query('status')) as RequirementStatus;
      const a = status.subtasks.find((s) => s.key === 'a');
      await handle.signal(rerouteSignal, { by: 'founder', routeId: 'r3', subtaskId: a?.id ?? '' });
      await waitUntil(
        () => world.callsOf('startSession').filter((c) => c.input.stage === 'execute').length === 3,
        'a 按新路由重起',
      );
      for (const s of world.held()) world.release(s.id);
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('done');
    const aStarts = sessionsOf(world.calls, 'a').filter(
      (c) => (c.input as StartSessionInput).stage === 'execute',
    );
    expect(aStarts.map((c) => (c.input as StartSessionInput).route.routeId)).toEqual(['r1', 'r3']);
    const bStarts = sessionsOf(world.calls, 'b').filter(
      (c) => (c.input as StartSessionInput).stage === 'execute',
    );
    expect(bStarts).toHaveLength(1);
    expect(world.callsOf('stopSession')).toHaveLength(1);
  });

  it('fleet 叫醒直接发给会话所属的子任务工作流，需求一条都不转；say、plan 这类不叫醒', async () => {
    const world = createFakeWorld({
      session: (input, n) => (input.stage === 'execute' && n === 1 ? { hold: true } : {}),
    });
    const history = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      await waitUntil(() => world.held().length === 1, '写码会话挂着');
      const held = world.held()[0];
      const runId = held?.runId ?? '';
      // 后端拿 session_runs.subtask_id 拼出子任务工作流编号。
      const child = env.client.workflow.getHandle(subtaskWorkflowId(held?.input.subtaskId ?? ''));
      await child.signal(agentEventSignal, { runId, kind: 'ask', askId: 'ask-1' });
      await queryUntil<SubtaskStatus>(child, (s) => s.lastAgentEvent?.kind === 'ask', '子任务收到叫醒');
      // 不叫醒的几类、别人的会话：不理。发个不认识的命令垫后，等它的回执，确保前面几条都处理过了。
      await child.signal(agentEventSignal, { runId, kind: 'say' });
      await child.signal(agentEventSignal, { runId: 'someone-else', kind: 'done' });
      await child.signal('ping');
      const seen = await queryUntil<SubtaskStatus>(child, (s) => s.commands.length === 1, '垫后的回执');
      expect(seen.lastAgentEvent).toMatchObject({ runId, kind: 'ask', askId: 'ask-1' });
      // 发到需求上的（老后端就是这么发的）：需求不转，也不当成自己的。
      await handle.signal(agentEventSignal, { runId, kind: 'done' });
      await handle.signal('ping');
      const req = await queryUntil<RequirementStatus>(handle, (s) => s.commands.length === 1, '垫后的回执');
      expect(req.lastAgentEvent).toBeNull();
      if (held) world.release(held.id);
      await handle.result();
      return handle.fetchHistory();
    });
    const relayed = (history.events ?? []).filter(
      (e) => e.signalExternalWorkflowExecutionInitiatedEventAttributes?.signalName === 'agentEvent',
    );
    expect(relayed).toEqual([]);
  });

  it('人闸：方案标的、分诊判出的都带上；批准发给需求，按子任务编号或批准编号转给对应的子任务', async () => {
    const world = createFakeWorld({
      triage: () => ({ clear: true, holds: ['spend'] }),
      plan: [
        { key: 'api', title: '后端接口', touches: ['src/api'], holds: ['delete'] },
        { key: 'page', title: '页面', touches: ['src/page'] },
      ],
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      const waiting = await queryUntil<RequirementStatus>(
        handle,
        (s) => s.subtasks.filter((x) => x.waiting?.approvalId).length === 2,
        '两个子任务都在等批准',
      );
      expect(waiting.subtasks.map((s) => [s.key, s.holds])).toEqual([
        ['api', ['delete', 'spend']],
        ['page', ['spend']],
      ]);
      expect(world.count('mergePr')).toBe(0);
      const [api, page] = waiting.subtasks;
      await handle.signal(approveSignal, { by: 'founder', subtaskId: api?.id });
      await handle.signal(approveSignal, { by: 'founder', approvalId: page?.waiting?.approvalId });
      // 不点名的不受理：一次批一张。
      await handle.signal(approveSignal, { by: 'founder' });
      const done = (await handle.result()) as RequirementResult;
      return { done, status: (await handle.query('status')) as RequirementStatus };
    });
    expect(result.done.state).toBe('done');
    expect(result.status.commands.map((c) => [c.command, c.accepted])).toEqual([
      ['approve', true],
      ['approve', true],
      ['approve', false],
    ]);
    expect(world.approvals.map((a) => [a.subtaskKey, a.holds])).toEqual(
      expect.arrayContaining([
        ['api', ['delete', 'spend']],
        ['page', ['spend']],
      ]),
    );
    expect(world.states.at(-1)?.subtasks.map((s) => s.holds)).toEqual([['delete', 'spend'], ['spend']]);
  });

  it('依赖的子任务被叫停：后面的起不来，需求以没做完结束并报警，不关单', async () => {
    const world = createFakeWorld({
      plan: [
        { key: 'api', title: '后端接口', touches: ['src/api'] },
        { key: 'page', title: '页面', touches: ['src/page'], dependsOn: ['api'] },
      ],
      session: (input) => (input.subtaskKey === 'api' && input.stage === 'execute' ? { hold: true } : {}),
    });
    const result = await withWorker(env, world, async (q) => {
      const handle = await startRequirement(q);
      await waitUntil(() => world.held().length === 1, 'api 的写码会话挂着');
      const status = (await handle.query('status')) as RequirementStatus;
      const api = status.subtasks.find((s) => s.key === 'api');
      await env.client.workflow.getHandle(api?.workflowId ?? '').signal(stopSignal, { by: 'founder' });
      return (await handle.result()) as RequirementResult;
    });
    expect(result.state).toBe('failed');
    expect(result.subtasks.map((s) => [s.key, s.state])).toEqual([
      ['api', 'stopped'],
      ['page', 'failed'],
    ]);
    expect(result.subtasks[1]?.problem).toContain('依赖没做成');
    expect(world.count('closeIssue')).toBe(0);
    expect(world.callsOf('raiseAlert').map((c) => c.input.title)).toContain('需求 #12 没有全部做完');
  });
});
