// fleet-api task continue|abandon|redo（#1402）：卡死的单在命令行续、放弃、重做。
// 继续、放弃发的信号名和驾驶舱按钮一样；重做走 taskRedo.redo，只在已叫停或挂起时允许。
// 每条都写操作记录。找不到任务工作流时退出码不是 0，标准输出不打成功。
import { CONTINUE_ROUTE_WAKE_REASON, TASK_SIGNAL_NAMES } from '@fleet-dao/shared';
import { createMemoryStore, devFixtures, IDS } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import type { CliDeps } from '../src/cli.ts';
import { main } from '../src/cli.ts';
import type { TaskRedoPort } from '../src/deps.ts';
import type {
  LineBudgetRemeasureRequest,
  LineBudgetRemeasureResponse,
  TaskSignal,
  WorkflowControl,
} from '../src/ports.ts';
import { WorkflowGoneError } from '../src/ports.ts';
import { createTemporalLineBudgetRemeasure, REMEASURE_UPDATE_NAME } from '../src/temporal.ts';

const T0 = new Date('2026-10-09T00:00:00.000Z');
const NOTE = '卡在检查点，接着做';

function task12(store: ReturnType<typeof createMemoryStore>) {
  const task = store.data.tasks.find((row) => row.id === IDS.task12);
  if (!task) throw new Error('样例数据里要有 #12');
  return task;
}

function setup(options?: {
  workflowId?: string;
  gone?: boolean;
  redo?: TaskRedoPort['redo'];
  /** 体量重评（#3249）：不给＝控制端没接这项能力。 */
  remeasure?: NonNullable<WorkflowControl['remeasureLineBudget']>;
  execution?: { runId: string; running: boolean };
}) {
  const store = createMemoryStore(devFixtures(T0));
  const out: string[] = [];
  const err: string[] = [];
  const sent: { workflowId: string; name: string; arg: unknown }[] = [];
  const redos: unknown[] = [];
  let opened = 0;
  let lookups = 0;
  const deps = (): CliDeps => ({
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => T0,
    openStore: async () => {
      opened += 1;
      return { store, close: async () => {} };
    },
    openTaskControl: async () => ({
      workflows: {
        async signal(workflowId, signal: TaskSignal) {
          if (options?.gone) throw new WorkflowGoneError(workflowId);
          const { name, ...arg } = signal;
          sent.push({ workflowId, name, arg });
        },
        async runningTaskWorkflow() {
          lookups += 1;
          return options?.workflowId ?? 'task:example/canary#12';
        },
        ...(options?.remeasure
          ? {
              remeasureLineBudget: options.remeasure,
              async taskWorkflowExecution(workflowId: string) {
                return { workflowId, ...(options.execution ?? { runId: RUN, running: true }) };
              },
            }
          : {}),
      },
      taskRedo: {
        redo: async (input) => {
          redos.push(input);
          if (options?.redo) return options.redo(input);
          return { ok: true as const, workflowId: 'task:example/canary#12:r2', generation: 2 };
        },
      },
      close: async () => {},
    }),
  });
  return {
    store,
    out,
    err,
    sent,
    redos,
    opened: () => opened,
    lookups: () => lookups,
    run: (args: string[]) => main(['task', ...args], deps()),
  };
}

function taskAudits(store: ReturnType<typeof createMemoryStore>) {
  return store.data.audit.filter((row) => row.action.startsWith('task.'));
}

describe('fleet-api task', () => {
  it('没带 --note：退出码 2，不连库，用法里写明三条子命令', async () => {
    const h = setup();
    const code = await h.run(['continue', 'example/canary', '12']);
    expect(code).toBe(2);
    expect(h.opened()).toBe(0);
    expect(h.err.join('\n')).toContain('fleet-api task continue|abandon|redo');
    expect(h.out.join('\n')).not.toMatch(/已继续|已放弃|已重做/);
  });

  it('continue：发给 taskContinue，并带一发 taskRouteWake（等选路不看继续），写一条操作记录', async () => {
    const h = setup({ workflowId: 'task:example/canary#12:r3' });
    const code = await h.run(['continue', 'example/canary', '12', '--note', NOTE]);
    expect(code).toBe(0);
    expect(h.out).toEqual(['已继续：example/canary#12（信号 taskContinue、taskRouteWake）']);
    expect(h.lookups()).toBe(1);
    expect(h.sent).toEqual([
      { workflowId: 'task:example/canary#12:r3', name: 'taskContinue', arg: { by: 'root' } },
      {
        workflowId: 'task:example/canary#12:r3',
        name: 'taskRouteWake',
        arg: { by: 'root', reason: CONTINUE_ROUTE_WAKE_REASON },
      },
    ]);
    expect(TASK_SIGNAL_NAMES.continue).toBe('taskContinue');
    expect(h.redos).toEqual([]);
    expect(taskAudits(h.store)).toEqual([
      expect.objectContaining({
        action: 'task.continue',
        target: 'issue:example/canary#12',
        ok: true,
        via: 'ops',
        actor: { kind: 'ops', id: 'ops:task' },
        after: expect.objectContaining({
          who: 'root',
          issue: 'example/canary#12',
          note: NOTE,
          result: '已继续：example/canary#12（信号 taskContinue、taskRouteWake）',
        }),
      }),
    ]);
    expect(h.store.data.audit[0]?.reason).toContain(NOTE);
    expect(h.store.data.audit[0]?.reason).toContain('root');
  });

  it('continue：继续次数用满时不发信号，退出码不是 0，说明要重开用 redo', async () => {
    const h = setup();
    const task = task12(h.store);
    task.state = 'stalled';
    task.stalled = { why: '已继续 3 次仍没过，交指挥官', since: T0.toISOString() };
    const code = await h.run(['continue', 'example/canary', '12', '--note', '再继续一次']);
    expect(code).not.toBe(0);
    expect(h.err.join('\n')).toContain('继续次数已用满（3 次），继续无效；要重开用 redo');
    expect(h.err.join('\n')).toContain('已用满');
    expect(h.out.join('\n')).not.toMatch(/已继续|已放弃|已重做/);
    expect(h.sent).toEqual([]);
    expect(taskAudits(h.store)[0]).toMatchObject({ action: 'task.continue', ok: false });
  });

  it('abandon：发给 taskAbandon，原因是 --note，写一条操作记录', async () => {
    const h = setup();
    const code = await h.run(['abandon', 'example/canary', '12', '--note', '这张不做了']);
    expect(code).toBe(0);
    expect(h.out).toEqual(['已放弃：example/canary#12（信号 taskAbandon）']);
    expect(h.sent).toEqual([
      {
        workflowId: 'task:example/canary#12',
        name: 'taskAbandon',
        arg: { by: 'root', reason: '这张不做了' },
      },
    ]);
    expect(TASK_SIGNAL_NAMES.abandon).toBe('taskAbandon');
    expect(taskAudits(h.store)[0]).toMatchObject({
      action: 'task.abandon',
      ok: true,
      after: { who: 'root', issue: 'example/canary#12', note: '这张不做了' },
    });
  });

  it('redo：已叫停时走 taskRedo.redo，不发信号，写一条操作记录', async () => {
    const h = setup();
    task12(h.store).state = 'stopped';
    const code = await h.run(['redo', 'example/canary', '12', '--note', '叫停之后重来']);
    expect(code).toBe(0);
    expect(h.out).toEqual(['已重做：example/canary#12（task:example/canary#12:r2，第 2 代）']);
    expect(h.sent).toEqual([]);
    expect(h.redos).toEqual([
      expect.objectContaining({
        taskId: IDS.task12,
        issueNumber: 12,
        title: '登录页加验证码',
        repo: expect.objectContaining({ owner: 'example', name: 'canary' }),
      }),
    ]);
    expect(task12(h.store).state).toBe('stopped');
    expect(taskAudits(h.store)[0]).toMatchObject({
      action: 'task.redo',
      ok: true,
      after: {
        who: 'root',
        issue: 'example/canary#12',
        note: '叫停之后重来',
        result: '已重做：example/canary#12（task:example/canary#12:r2，第 2 代）',
      },
    });
  });

  it('redo：挂起时同样走 taskRedo.redo，不发信号', async () => {
    const h = setup();
    task12(h.store).state = 'stalled';
    const code = await h.run(['redo', 'example/canary', '12', '--note', '挂起之后重来']);
    expect(code).toBe(0);
    expect(h.out).toEqual(['已重做：example/canary#12（task:example/canary#12:r2，第 2 代）']);
    expect(h.sent).toEqual([]);
    expect(h.redos).toHaveLength(1);
    expect(task12(h.store).state).toBe('stalled');
    expect(taskAudits(h.store)[0]).toMatchObject({
      action: 'task.redo',
      ok: true,
      after: { who: 'root', issue: 'example/canary#12', note: '挂起之后重来' },
    });
  });

  it('redo：做完、失败的拒绝，说原因，不调用重做，不打印成功', async () => {
    const done = setup();
    const doneCode = await done.run(['redo', 'example/canary', '13', '--note', '做完了还想重来']);
    expect(doneCode).toBe(1);
    expect(done.out.join('\n')).not.toMatch(/已继续|已放弃|已重做/);
    expect(done.err.join('\n')).toContain('这张单现在是done，只有已叫停或挂起的才能重做');
    expect(done.redos).toEqual([]);
    expect(taskAudits(done.store)[0]).toMatchObject({
      action: 'task.redo',
      ok: false,
      after: { who: 'root', issue: 'example/canary#13', note: '做完了还想重来' },
    });

    const failed = setup();
    task12(failed.store).state = 'failed';
    const failedCode = await failed.run(['redo', 'example/canary', '12', '--note', '失败了还想重来']);
    expect(failedCode).toBe(1);
    expect(failed.out.join('\n')).not.toMatch(/已继续|已放弃|已重做/);
    expect(failed.err.join('\n')).toContain('这张单现在是failed，只有已叫停或挂起的才能重做');
    expect(failed.redos).toEqual([]);
    expect(taskAudits(failed.store)[0]).toMatchObject({ action: 'task.redo', ok: false });
  });

  it('【故意造出的失败】找不到对应的任务工作流：退出码不是 0，不打印成功', async () => {
    const missing = setup();
    const missingCode = await missing.run(['continue', 'example/canary', '99', '--note', '库里没有']);
    expect(missingCode).not.toBe(0);
    expect(missing.out.join('\n')).not.toMatch(/已继续|已放弃|已重做/);
    expect(missing.err.join('\n')).toContain('找不到对应的任务工作流');
    expect(missing.sent).toEqual([]);
    expect(taskAudits(missing.store)[0]).toMatchObject({
      ok: false,
      after: { who: 'root', issue: 'example/canary#99', note: '库里没有' },
    });

    const gone = setup({ gone: true });
    const goneCode = await gone.run(['abandon', 'example/canary', '12', '--note', '工作流没了']);
    expect(goneCode).not.toBe(0);
    expect(gone.out.join('\n')).not.toMatch(/已继续|已放弃|已重做/);
    expect(gone.err.join('\n')).toContain('没有谁能收到这个操作');
    expect(taskAudits(gone.store)[0]).toMatchObject({
      action: 'task.abandon',
      ok: false,
      after: { who: 'root', issue: 'example/canary#12', note: '工作流没了' },
    });
  });
});

const RUN = 'run-0001';
const HEAD = '0684b1d2a3c71a7f02d5716376f1046c2243b42c';
const BASE = '0524abecd5c4145d909f261e19c400f1cdccb526';
const FLAGS = ['--head', HEAD, '--base', BASE, '--note', '只重新核这次成果'];
const RECEIPT = {
  head: HEAD,
  base: BASE,
  rawAddedLines: 9550,
  verifiedGeneratedLines: 8037,
  chargeableAddedLines: 1513,
  budget: 3000,
  reason: '已核单份快照',
};

function remeasurer(respond?: (request: LineBudgetRemeasureRequest) => LineBudgetRemeasureResponse) {
  const requests: LineBudgetRemeasureRequest[] = [];
  const remeasure: NonNullable<WorkflowControl['remeasureLineBudget']> = async (request) => {
    requests.push(request);
    return (
      respond?.(request) ?? {
        ok: true,
        outcome: request.mode === 'resume' ? 'resumed' : 'eligible',
        park: '2.5.0',
        receipt: RECEIPT,
      }
    );
  };
  return { requests, remeasure };
}

describe('fleet-api task budget-remeasure（#3249）', () => {
  it('参数：head/base 要完整 sha；--execute 必须带预检看到的 run 和停点；别的动作不收这些参数；全部退出码 2 不连库', async () => {
    const cases: string[][] = [
      ['budget-remeasure', 'example/canary', '12', '--base', BASE, '--note', 'n'],
      ['budget-remeasure', 'example/canary', '12', '--head', 'abc', '--base', BASE, '--note', 'n'],
      [
        'budget-remeasure',
        'example/canary',
        '12',
        '--head',
        HEAD,
        '--base',
        BASE.toUpperCase(),
        '--note',
        'n',
      ],
      ['budget-remeasure', 'example/canary', '12', ...FLAGS, '--execute'],
      ['budget-remeasure', 'example/canary', '12', ...FLAGS, '--execute', '--run', RUN],
      ['budget-remeasure', 'example/canary', '12', ...FLAGS, '--park', 'x'],
      ['continue', 'example/canary', '12', '--head', HEAD, '--note', 'n'],
      ['abandon', 'example/canary', '12', '--execute', '--note', 'n'],
    ];
    for (const args of cases) {
      const h = setup();
      expect(await h.run(args), args.join(' ')).toBe(2);
      expect(h.opened()).toBe(0);
    }
  });

  it('默认只读预检：只发 check，不放行、不发任何信号、不写操作记录，并打印可复制的执行命令', async () => {
    const r = remeasurer();
    const h = setup({ remeasure: r.remeasure });
    expect(await h.run(['budget-remeasure', 'example/canary', '12', ...FLAGS])).toBe(0);
    expect(r.requests).toEqual([
      expect.objectContaining({
        mode: 'check',
        runId: RUN,
        head: HEAD,
        base: BASE,
        by: 'root',
        taskId: expect.any(String),
      }),
    ]);
    expect(h.sent).toEqual([]);
    expect(taskAudits(h.store)).toEqual([]);
    const out = h.out.join('\n');
    expect(out).toContain('预检通过（只读，没放行）');
    expect(out).toContain('实际计量 1513 行');
    expect(out).toContain('已核生成 8037 行');
    expect(out).toContain(`--execute --run ${RUN} --park 2.5.0`);
  });

  it('--execute：发 resume，记一条操作记录；不发 taskContinue / taskRouteWake', async () => {
    const r = remeasurer();
    const h = setup({ remeasure: r.remeasure });
    const code = await h.run([
      'budget-remeasure',
      'example/canary',
      '12',
      ...FLAGS,
      '--execute',
      '--run',
      RUN,
      '--park',
      '2.5.0',
    ]);
    expect(code).toBe(0);
    expect(r.requests[0]).toMatchObject({ mode: 'resume', park: '2.5.0', runId: RUN });
    expect(h.sent).toEqual([]);
    expect(h.out.join('\n')).toContain('已放行这一份成果（不算「继续」，不授权后续交付）');
    expect(taskAudits(h.store)).toEqual([
      expect.objectContaining({ action: 'task.budget-remeasure', ok: true, via: 'ops' }),
    ]);
  });

  it('幂等回执照实说「已放行过」；换代（run 对不上）本地就拒，不调用重评', async () => {
    const again = remeasurer((request) => ({
      ok: true,
      outcome: 'already_resumed',
      park: request.park ?? '2.5.0',
      receipt: RECEIPT,
    }));
    const h = setup({ remeasure: again.remeasure });
    expect(
      await h.run([
        'budget-remeasure',
        'example/canary',
        '12',
        ...FLAGS,
        '--execute',
        '--run',
        RUN,
        '--park',
        '2.5.0',
      ]),
    ).toBe(0);
    expect(h.out.join('\n')).toContain('已放行过（幂等回执，不再放行别的头）');

    const closedFlags = [
      'budget-remeasure',
      'example/canary',
      '12',
      ...FLAGS,
      '--execute',
      '--run',
      RUN,
      '--park',
      '2.5.0',
    ] as const;
    const closed = setup({
      remeasure: again.remeasure,
      execution: { runId: RUN, running: false },
    });
    expect(await closed.run([...closedFlags])).toBe(0);
    expect(closed.out.join('\n')).toContain('已放行过（幂等回执，不再放行别的头）');
    const finished = setup({
      remeasure: again.remeasure,
      execution: { runId: RUN, running: false },
    });
    task12(finished.store).state = 'done';
    expect(await finished.run([...closedFlags])).toBe(0);
    expect(finished.out.join('\n')).toContain('已放行过（幂等回执，不再放行别的头）');

    const r = remeasurer();
    const moved = setup({ remeasure: r.remeasure, execution: { runId: 'run-0002', running: true } });
    expect(
      await moved.run([
        'budget-remeasure',
        'example/canary',
        '12',
        ...FLAGS,
        '--execute',
        '--run',
        RUN,
        '--park',
        '2.5.0',
      ]),
    ).toBe(1);
    expect(moved.err.join('\n')).toContain('工作流已换代');
    expect(r.requests).toEqual([]);
    expect(taskAudits(moved.store)[0]).toMatchObject({ action: 'task.budget-remeasure', ok: false });
  });

  it('拒绝都退出码 1、标准输出不打成功；执行的拒绝写失败记录，预检的不写', async () => {
    const reasons = [
      'stale',
      'busy',
      'unknown',
      'changed',
      'unverified',
      'over_budget',
      'unsupported',
      'identity',
    ];
    for (const reason of reasons) {
      const r = remeasurer(() => ({
        ok: false,
        reason,
        detail: `原因 ${reason}`,
        park: '2.5.0',
        current: { head: HEAD, rawAddedLines: 9550, chargeableAddedLines: 9550, budget: 3000 },
      }));
      const pre = setup({ remeasure: r.remeasure });
      expect(await pre.run(['budget-remeasure', 'example/canary', '12', ...FLAGS])).toBe(1);
      expect(pre.err.join('\n')).toContain(`体量重评被拒（${reason}）`);
      expect(pre.err.join('\n')).toContain('原停点保留，没放行任何成果');
      expect(pre.out).toEqual([]);
      expect(taskAudits(pre.store)).toEqual([]);

      const exec = setup({ remeasure: r.remeasure });
      expect(
        await exec.run([
          'budget-remeasure',
          'example/canary',
          '12',
          ...FLAGS,
          '--execute',
          '--run',
          RUN,
          '--park',
          '2.5.0',
        ]),
      ).toBe(1);
      expect(exec.out).toEqual([]);
      expect(taskAudits(exec.store)).toEqual([expect.objectContaining({ ok: false })]);
    }
  });

  it('控制端没接重评、工作流已结束、重评调用抛错（结果未知）：都不放行', async () => {
    const none = setup();
    expect(await none.run(['budget-remeasure', 'example/canary', '12', ...FLAGS])).toBe(1);
    expect(none.err.join('\n')).toContain('没接上可信重评能力');

    const ended = setup({ remeasure: remeasurer().remeasure, execution: { runId: RUN, running: false } });
    expect(await ended.run(['budget-remeasure', 'example/canary', '12', ...FLAGS])).toBe(1);
    expect(ended.err.join('\n')).toContain('已经结束');

    const closedRelease = remeasurer((request) => ({
      ok: true,
      outcome: 'resumed',
      park: request.park ?? '2.5.0',
      receipt: RECEIPT,
    }));
    const closed = setup({
      remeasure: closedRelease.remeasure,
      execution: { runId: RUN, running: false },
    });
    expect(
      await closed.run([
        'budget-remeasure',
        'example/canary',
        '12',
        ...FLAGS,
        '--execute',
        '--run',
        RUN,
        '--park',
        '2.5.0',
      ]),
    ).toBe(1);
    expect(closed.err.join('\n')).toContain('不是一条已完成请求的幂等回执');
    expect(closed.out).toEqual([]);

    const boom = setup({
      remeasure: async () => {
        throw new Error('rpc 超时');
      },
    });
    expect(
      await boom.run([
        'budget-remeasure',
        'example/canary',
        '12',
        ...FLAGS,
        '--execute',
        '--run',
        RUN,
        '--park',
        '2.5.0',
      ]),
    ).toBe(1);
    expect(boom.err.join('\n')).toContain('结果未知，原停点保留');
    expect(taskAudits(boom.store)[0]).toMatchObject({ ok: false });
  });
});

describe('Temporal 重评适配（#3249）', () => {
  const identity = {
    version: 1 as const,
    runId: RUN,
    parks: 2,
    generation: 5,
    continued: 0,
    prNumber: null,
    head: HEAD,
    rawAddedLines: 9550,
    chargeableAddedLines: 9550,
    budget: 3000,
    base: BASE,
  };
  function client(status: unknown, update?: unknown) {
    const calls: { kind: string; name: string; args?: unknown[] }[] = [];
    return {
      calls,
      client: {
        connection: { withDeadline: async <R>(_d: number | Date, fn: () => Promise<R>) => fn() },
        workflow: {
          getHandle: () => ({
            async query(name: string) {
              calls.push({ kind: 'query', name });
              return status;
            },
            async executeUpdate(name: string, options: { args: unknown[] }) {
              calls.push({ kind: 'update', name, args: options.args });
              return update;
            },
          }),
        },
      },
    };
  }
  const request: LineBudgetRemeasureRequest = {
    workflowId: 'task:example/canary#12',
    runId: RUN,
    repo: { owner: 'example', name: 'canary' },
    taskId: 't1',
    head: HEAD,
    base: BASE,
    mode: 'resume',
    park: '2.5.0',
    by: 'root',
  };

  it('Update 名与引擎同一份', async () => {
    const { taskRemeasureLineBudgetUpdate } = await import('../../engine/src/task-contract.ts');
    expect(taskRemeasureLineBudgetUpdate.name).toBe(REMEASURE_UPDATE_NAME);
  });

  it('身份来自工作流的 taskStatus；通过时发带完整停点身份的 Update', async () => {
    const c = client(
      { lineBudgetPark: { version: 1, identity } },
      { outcome: 'resumed', receipt: { ...RECEIPT, identity } },
    );
    const got = await createTemporalLineBudgetRemeasure(c.client)(request);
    expect(got).toMatchObject({ ok: true, outcome: 'resumed', park: '2.5.0' });
    expect(c.calls.map((x) => x.kind)).toEqual(['query', 'update']);
    expect(c.calls[1]?.args?.[0]).toMatchObject({
      mode: 'resume',
      identity,
      head: HEAD,
      base: BASE,
      workflowId: request.workflowId,
    });
  });

  it('旧 worker 没有字段、不在体量停点、停点编号变了、头不同：本地就拒，不发 Update', async () => {
    const run = (status: unknown, over: Partial<LineBudgetRemeasureRequest> = {}) => {
      const c = client(status);
      return createTemporalLineBudgetRemeasure(c.client)({ ...request, ...over }).then((r) => ({ r, c }));
    };
    const old = await run({ phase: 'parked', lastProblem: '改动超出体量预算：新增 9550 行' });
    expect(old.r).toMatchObject({ ok: false, reason: 'unsupported' });
    const none = await run({ lineBudgetPark: { version: 1, identity: null } });
    expect(none.r).toMatchObject({ ok: false, reason: 'stale' });
    const inflight = await run({ lineBudgetPark: { version: 1, identity: null, busy: true } });
    expect(inflight.r).toMatchObject({ ok: false, reason: 'busy' });
    expect(inflight.c.calls.map((y) => y.kind)).toEqual(['query']);
    const park = await run({ lineBudgetPark: { version: 1, identity } }, { park: '1.4.0' });
    expect(park.r).toMatchObject({ ok: false, reason: 'stale', park: '2.5.0' });
    const head = await run({ lineBudgetPark: { version: 1, identity } }, { head: 'f'.repeat(40) });
    expect(head.r).toMatchObject({ ok: false, reason: 'changed' });
    // 停下时测量的固定 base 钉在身份里：换另一个（更早的）base 改测量范围，本地就拒
    const base = await run({ lineBudgetPark: { version: 1, identity } }, { base: 'e'.repeat(40) });
    expect(base.r).toMatchObject({ ok: false, reason: 'changed', detail: expect.stringContaining(BASE) });
    // 重评能力之前停下的没记测量 base：证明不了原测量范围，不拿请求者给的 base 顶替
    const unbound = await run({ lineBudgetPark: { version: 1, identity: { ...identity, base: null } } });
    expect(unbound.r).toMatchObject({ ok: false, reason: 'unsupported' });
    for (const x of [old, none, park, head, base, unbound])
      expect(x.c.calls.map((y) => y.kind)).toEqual(['query']);
  });

  it('同一已放行请求重发：停点身份已清空或换成新停点，按放行绑定带回原身份，拿工作流的幂等回执', async () => {
    const resumed = { identity, head: HEAD, base: BASE };
    const receipt = { outcome: 'already_resumed', receipt: { ...RECEIPT, identity } };
    const next = { ...identity, parks: 3, head: 'a'.repeat(40) };
    for (const now of [null, next]) {
      const c = client({ lineBudgetPark: { version: 1, identity: now, resumed } }, receipt);
      const got = await createTemporalLineBudgetRemeasure(c.client)(request);
      expect(got).toMatchObject({ ok: true, outcome: 'already_resumed', park: '2.5.0' });
      expect(c.calls.map((x) => x.kind)).toEqual(['query', 'update']);
      expect(c.calls[1]?.args?.[0]).toMatchObject({ mode: 'resume', identity, head: HEAD, base: BASE });
    }
    // 预检、别的头、别的停点编号、别的 base 都不借这份绑定：按现停点核对，对不上就拒，不发 Update
    for (const over of [
      { mode: 'check' as const },
      { head: 'f'.repeat(40) },
      { park: '1.4.0' },
      { base: 'e'.repeat(40) },
    ]) {
      const c = client({ lineBudgetPark: { version: 1, identity: null, resumed } }, receipt);
      const got = await createTemporalLineBudgetRemeasure(c.client)({ ...request, ...over });
      expect(got).toMatchObject({ ok: false, reason: 'stale' });
      expect(c.calls.map((x) => x.kind)).toEqual(['query']);
    }
  });

  it('工作流已结束：Update 发不出去时，查询里对得上的回执仍是幂等回执；读不全不当成功', async () => {
    const gone = new Error('workflow execution already completed');
    gone.name = 'WorkflowNotFoundError';
    const resumed = { identity, head: HEAD, base: BASE, receipt: { ...RECEIPT } };
    const calls: string[] = [];
    const got = await createTemporalLineBudgetRemeasure({
      connection: { withDeadline: async <R>(_d: number | Date, fn: () => Promise<R>) => fn() },
      workflow: {
        getHandle: () => ({
          async query() {
            calls.push('query');
            return { lineBudgetPark: { version: 1, identity: null, resumed } };
          },
          async executeUpdate() {
            calls.push('update');
            throw gone;
          },
        }),
      },
    })(request);
    expect(got).toMatchObject({ ok: true, outcome: 'already_resumed', park: '2.5.0', receipt: RECEIPT });
    expect(calls).toEqual(['query', 'update']);

    const incomplete = await createTemporalLineBudgetRemeasure({
      connection: { withDeadline: async <R>(_d: number | Date, fn: () => Promise<R>) => fn() },
      workflow: {
        getHandle: () => ({
          async query() {
            return {
              lineBudgetPark: {
                version: 1,
                identity: null,
                resumed: { identity, head: HEAD, base: BASE },
              },
            };
          },
          async executeUpdate() {
            throw gone;
          },
        }),
      },
    })(request);
    expect(incomplete).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('工作流回拒绝或认不出的回执：都不当成功', async () => {
    const status = { lineBudgetPark: { version: 1, identity } };
    const refused = await createTemporalLineBudgetRemeasure(
      client(status, { outcome: 'refused', reason: 'over_budget', detail: '仍超' }).client,
    )(request);
    expect(refused).toMatchObject({ ok: false, reason: 'over_budget', detail: '仍超' });
    const odd = await createTemporalLineBudgetRemeasure(client(status, { outcome: 'resumed' }).client)(
      request,
    );
    expect(odd).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('回执不是空对象、绑错头/base、数字对不上、结果和模式不符：一律按未知，不当成功', async () => {
    const status = { lineBudgetPark: { version: 1, identity } };
    const bad: [string, unknown][] = [
      ['空回执', { outcome: 'resumed', receipt: {} }],
      ['错 head', { outcome: 'resumed', receipt: { ...RECEIPT, head: 'f'.repeat(40) } }],
      ['错 base', { outcome: 'resumed', receipt: { ...RECEIPT, base: 'e'.repeat(40) } }],
      ['原预算被改', { outcome: 'resumed', receipt: { ...RECEIPT, budget: 99999 } }],
      [
        '原始行数不是停下时的',
        { outcome: 'resumed', receipt: { ...RECEIPT, rawAddedLines: 100, verifiedGeneratedLines: 0 } },
      ],
      [
        '计量仍超预算',
        {
          outcome: 'resumed',
          receipt: { ...RECEIPT, verifiedGeneratedLines: 0, chargeableAddedLines: 9550 },
        },
      ],
      ['计量加生成对不上原始', { outcome: 'resumed', receipt: { ...RECEIPT, chargeableAddedLines: 1 } }],
      [
        '负数',
        {
          outcome: 'resumed',
          receipt: { ...RECEIPT, chargeableAddedLines: -1, verifiedGeneratedLines: 9551 },
        },
      ],
      [
        '非整数',
        {
          outcome: 'resumed',
          receipt: { ...RECEIPT, chargeableAddedLines: 1512.5, verifiedGeneratedLines: 8037.5 },
        },
      ],
      ['缺 reason', { outcome: 'resumed', receipt: { ...RECEIPT, reason: undefined } }],
      ['执行拿到 eligible', { outcome: 'eligible', receipt: RECEIPT }],
    ];
    for (const [name, update] of bad) {
      const got = await createTemporalLineBudgetRemeasure(client(status, update).client)(request);
      expect(got, name).toMatchObject({ ok: false, reason: 'unknown' });
    }
    const check = await createTemporalLineBudgetRemeasure(
      client(status, { outcome: 'resumed', receipt: RECEIPT }).client,
    )({ ...request, mode: 'check' });
    expect(check, '预检拿到 resumed').toMatchObject({ ok: false, reason: 'unknown' });
    const eligible = await createTemporalLineBudgetRemeasure(
      client(status, { outcome: 'eligible', receipt: RECEIPT }).client,
    )({ ...request, mode: 'check', park: undefined });
    expect(eligible).toMatchObject({ ok: true, outcome: 'eligible' });
  });

  it('工作流已结束时查询里的回执同样逐项核对：错头、数字对不上都读不全', async () => {
    const gone = new Error('workflow execution already completed');
    gone.name = 'WorkflowNotFoundError';
    for (const receipt of [
      { ...RECEIPT, head: 'f'.repeat(40) },
      { ...RECEIPT, chargeableAddedLines: 9999 },
      { ...RECEIPT, budget: 1 },
      {},
    ]) {
      const got = await createTemporalLineBudgetRemeasure({
        connection: { withDeadline: async <R>(_d: number | Date, fn: () => Promise<R>) => fn() },
        workflow: {
          getHandle: () => ({
            async query() {
              return {
                lineBudgetPark: {
                  version: 1,
                  identity: null,
                  resumed: { identity, head: HEAD, base: BASE, receipt },
                },
              };
            },
            async executeUpdate() {
              throw gone;
            },
          }),
        },
      })(request);
      expect(got).toMatchObject({ ok: false, reason: 'unknown' });
    }
  });
});
