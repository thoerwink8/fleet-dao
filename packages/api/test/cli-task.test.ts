// fleet-api task continue|abandon|redo（#1402）：卡死的单在命令行续、放弃、重做。
// 继续、放弃发的信号名和驾驶舱按钮一样；重做走 taskRedo.redo，只在已叫停或挂起时允许。
// 每条都写操作记录。找不到任务工作流时退出码不是 0，标准输出不打成功。
import { TASK_SIGNAL_NAMES } from '@fleet-dao/shared';
import { createMemoryStore, devFixtures, IDS } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import type { CliDeps } from '../src/cli.ts';
import { main } from '../src/cli.ts';
import type { TaskRedoPort } from '../src/deps.ts';
import type { TaskSignal } from '../src/ports.ts';
import { WorkflowGoneError } from '../src/ports.ts';

const T0 = new Date('2026-10-09T00:00:00.000Z');
const NOTE = '卡在检查点，接着做';

function task12(store: ReturnType<typeof createMemoryStore>) {
  const task = store.data.tasks.find((row) => row.id === IDS.task12);
  if (!task) throw new Error('样例数据里要有 #12');
  return task;
}

function setup(options?: { workflowId?: string; gone?: boolean; redo?: TaskRedoPort['redo'] }) {
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

  it('continue：发给 taskContinue，和驾驶舱「继续」同一个信号名，写一条操作记录', async () => {
    const h = setup({ workflowId: 'task:example/canary#12:r3' });
    const code = await h.run(['continue', 'example/canary', '12', '--note', NOTE]);
    expect(code).toBe(0);
    expect(h.out).toEqual(['已继续：example/canary#12（信号 taskContinue）']);
    expect(h.lookups()).toBe(1);
    expect(h.sent).toEqual([
      { workflowId: 'task:example/canary#12:r3', name: 'taskContinue', arg: { by: 'root' } },
    ]);
    expect(TASK_SIGNAL_NAMES.continue).toBe('taskContinue');
    expect(h.redos).toEqual([]);
    expect(taskAudits(h.store)).toEqual([
      expect.objectContaining({
        action: 'task.continue',
        target: 'issue:example/canary#12',
        ok: true,
        via: 'engine',
        actor: { kind: 'engine', id: 'ops:task' },
        after: expect.objectContaining({
          who: 'root',
          issue: 'example/canary#12',
          note: NOTE,
          result: '已继续：example/canary#12（信号 taskContinue）',
        }),
      }),
    ]);
    expect(h.store.data.audit[0]?.reason).toContain(NOTE);
    expect(h.store.data.audit[0]?.reason).toContain('root');
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
