// fleet-api release pause|continue（#2038）：发版切版本前给手上有会话的任务发 hard 暂停（暂停人「发版」），新引擎起来后
// 只对这一批发「继续」；人手暂停的、停下等人的不碰；发不出去的照实记 failed、退出码 1。
import { TASK_SIGNAL_NAMES } from '@fleet-dao/shared';
import { createMemoryStore, devFixtures, IDS } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import type { TaskSignal } from '../src/ports.ts';
import { WorkflowGoneError } from '../src/ports.ts';
import {
  continueTasks,
  type PauseList,
  parsePauseList,
  parseReleaseArgs,
  pauseTasks,
  RELEASE_PAUSE_BY,
  type ReleaseCommandDeps,
  runReleaseCommand,
} from '../src/release-pause.ts';

const T0 = new Date('2026-10-14T09:00:00.000Z');
const REASON = '发版 0123456789ab';

function setup(options: { goneFor?: string[] } = {}) {
  const store = createMemoryStore(devFixtures(T0));
  const base = store.data.tasks.find((t) => t.id === IDS.task12);
  if (!base) throw new Error('样例数据里要有 #12');
  const add = (id: string, issueNumber: number, extra: Record<string, unknown>) => {
    store.data.tasks.push({ ...base, id, issueNumber, ...extra });
    return id;
  };
  const ids = {
    running: IDS.task12,
    human: add('b0000000-0000-4000-8000-000000000101', 101, {
      paused: '已暂停：被人暂停（创始人甲）：先别动',
    }),
    stalled: add('b0000000-0000-4000-8000-000000000102', 102, { state: 'stalled' }),
    done: IDS.task13,
    other: add('b0000000-0000-4000-8000-000000000103', 103, {}),
  };
  const sent: { workflowId: string; name: string; arg: Record<string, unknown> }[] = [];
  const workflows = {
    async signal(workflowId: string, signal: TaskSignal) {
      if (options.goneFor?.includes(workflowId)) throw new WorkflowGoneError(workflowId);
      const { name, ...arg } = signal;
      sent.push({ workflowId, name, arg });
    },
  };
  const deps = { store, workflows, operator: 'root', now: () => T0 };
  return { store, ids, sent, deps };
}

describe('pauseTasks', () => {
  it('在跑的发 hard 暂停（暂停人「发版」）；人手暂停的、停下等人的、已结束的跳过，记原因', async () => {
    const h = setup();
    const list = await pauseTasks([h.ids.running, h.ids.human, h.ids.stalled, h.ids.done], REASON, h.deps);
    expect(h.sent).toEqual([
      {
        workflowId: expect.stringContaining('#12'),
        name: TASK_SIGNAL_NAMES.pause,
        arg: { by: RELEASE_PAUSE_BY, mode: 'hard', reason: REASON },
      },
    ]);
    expect(list.entries.map((e) => [e.issueNumber, e.result, e.pausedOk])).toEqual([
      [12, 'paused', true],
      [101, 'skipped', false],
      [102, 'skipped', false],
      [13, 'skipped', false],
    ]);
    expect(list.entries[1]?.why).toContain('不是发版暂停的');
    // 操作记录记成运维脚本，不是引擎
    const audits = h.store.data.audit.filter((a) => a.action === 'task.pause');
    expect(audits).toHaveLength(4);
    expect(audits.every((a) => a.actor.kind === 'ops' && a.via === 'ops')).toBe(true);
  });

  it('信号发不出去：记 failed、pausedOk=false，不当成暂停了', async () => {
    const h = setup({ goneFor: ['task:example/canary#12'] });
    const list = await pauseTasks([h.ids.running, 'b0000000-0000-4000-8000-00000000ffff'], REASON, h.deps);
    expect(list.entries[0]).toMatchObject({ result: 'failed', pausedOk: false });
    expect(list.entries[0]?.why).toContain('已经结束或不存在');
    expect(list.entries[1]).toMatchObject({ result: 'failed', why: '库里没有这个任务' });
  });
});

describe('continueTasks：只继续本次发版暂停的', () => {
  async function pausedList(h: ReturnType<typeof setup>): Promise<PauseList> {
    const list = await pauseTasks([h.ids.running, h.ids.human, h.ids.other], REASON, h.deps);
    // 引擎停在检查点后写的样子
    for (const id of [h.ids.running, h.ids.other]) {
      const row = h.store.data.tasks.find((t) => t.id === id);
      if (row) row.paused = `已暂停：被人暂停（${RELEASE_PAUSE_BY}）：${REASON}`;
    }
    h.sent.length = 0;
    return list;
  }

  it('名单里发版暂停的发「继续」；名单外、人手暂停的不发', async () => {
    const h = setup();
    const list = await pausedList(h);
    const out = await continueTasks(list, h.deps);
    expect(h.sent.map((s) => [s.workflowId, s.name, s.arg.by])).toEqual([
      [expect.stringContaining('#12'), TASK_SIGNAL_NAMES.continue, RELEASE_PAUSE_BY],
      [expect.stringContaining('#103'), TASK_SIGNAL_NAMES.continue, RELEASE_PAUSE_BY],
    ]);
    expect(out.entries.map((e) => e.result)).toEqual(['continued', 'skipped', 'continued']);
    expect(out.continuedAt).toBe(T0.toISOString());
  });

  it('发版期间被人改成手动暂停的不继续', async () => {
    const h = setup();
    const list = await pausedList(h);
    const row = h.store.data.tasks.find((t) => t.id === h.ids.other);
    if (row) row.paused = '已暂停：被人暂停（创始人甲）：我来看看';
    const out = await continueTasks(list, h.deps);
    expect(h.sent).toHaveLength(1);
    expect(out.entries[2]).toMatchObject({ result: 'skipped' });
    expect(out.entries[2]?.why).toContain('人手暂停的不动');
  });

  it('继续发不出去：逐条记 failed（发版报告照列），不当成继续了', async () => {
    const h = setup();
    const list = await pausedList(h);
    const gone = setup({ goneFor: [list.entries[0]?.workflowId ?? ''] });
    gone.store.data.tasks = h.store.data.tasks;
    const out = await continueTasks(list, gone.deps);
    expect(out.entries[0]).toMatchObject({ result: 'failed' });
    expect(out.entries[0]?.why).toContain('没发出「继续」');
    expect(out.entries[2]).toMatchObject({ result: 'continued' });
  });
});

describe('命令行：参数、名单、退出码', () => {
  function cmd(h: ReturnType<typeof setup>, stdin = '') {
    const out: string[] = [];
    const err: string[] = [];
    let opened = 0;
    const deps: ReleaseCommandDeps = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      now: () => T0,
      operator: 'root',
      readStdin: async () => stdin,
      openStore: async () => {
        opened += 1;
        return { store: h.store, close: async () => {} };
      },
      openWorkflows: async () => ({ workflows: h.deps.workflows, close: async () => {} }),
    };
    return { out, err, deps, opened: () => opened };
  }

  it('pause 没带 --reason：退出码 2，不连库', async () => {
    const h = setup();
    const c = cmd(h);
    expect(await runReleaseCommand(['pause', h.ids.running], c.deps)).toBe(2);
    expect(c.opened()).toBe(0);
    expect(() => parseReleaseArgs(['pause', '--reason', 'x', 'a;b'])).toThrow(/认不出/);
  });

  it('pause → continue 走一遍：名单 JSON 打到标准输出，continue 从标准输入读回', async () => {
    const h = setup();
    const p = cmd(h);
    expect(await runReleaseCommand(['pause', '--reason', REASON, h.ids.running], p.deps)).toBe(0);
    const list = parsePauseList(p.out.at(-1) ?? '');
    expect(list.entries[0]).toMatchObject({ result: 'paused', pausedOk: true });
    const c = cmd(h, p.out.at(-1));
    expect(await runReleaseCommand(['continue'], c.deps)).toBe(0);
    expect(JSON.parse(c.out.at(-1) ?? '{}').entries[0].result).toBe('continued');
  });

  it('continue 的名单认不出：退出码 2，不连库', async () => {
    const h = setup();
    const c = cmd(h, '{"schema":1,"by":"别人","entries":[]}');
    expect(await runReleaseCommand(['continue'], c.deps)).toBe(2);
    expect(c.opened()).toBe(0);
  });

  it('有一条继续发不出去：退出码 1，结果照打', async () => {
    const h = setup({ goneFor: ['task:example/canary#12'] });
    const list: PauseList = {
      schema: 1,
      by: RELEASE_PAUSE_BY,
      reason: REASON,
      pausedAt: T0.toISOString(),
      entries: [
        {
          taskId: h.ids.running,
          repo: 'example/canary',
          issueNumber: 12,
          workflowId: 'task:example/canary#12',
          result: 'paused',
          pausedOk: true,
        },
      ],
    };
    const c = cmd(h, JSON.stringify(list));
    expect(await runReleaseCommand(['continue'], c.deps)).toBe(1);
    expect(JSON.parse(c.out.at(-1) ?? '{}').entries[0].result).toBe('failed');
    expect(c.err.join('\n')).toContain('failed');
  });
});
