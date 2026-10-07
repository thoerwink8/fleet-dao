// 单子页「现在就换」模型（#1216）：PUT /api/tasks/:taskId/route-pin 带 now: true，除了写指定还给任务工作流发 taskRepin。
// 先核后写：单子不在跑、被暂停、在跑的不是动手这一段、验收段，都回 409 写明原因，库里不动、不发信号、不记操作；
// 不带 now 照旧只写指定、不发信号；信号没发成（工作流已结束）指定已记下，409 里写明。
import type { TaskRoutePin } from '@fleet-dao/db';
import { taskWorkflowId } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { WorkflowGoneError } from '../src/ports.ts';
import type { TaskRoutePinsPort } from '../src/task-route-pins.ts';
import { DEV_USER_ID, errorCode, type Harness, harness, IDS, T0, write } from './harness.ts';

const WORKFLOW_ID = taskWorkflowId({ owner: 'example', name: 'canary' }, 12);

/** 假的指定端口：记下每次写，写什么回什么（真端口的核对在 task-route-pins.test.ts）。 */
function fakePins() {
  const sets: unknown[] = [];
  const port: TaskRoutePinsPort = {
    list: async () => [],
    set: async (input) => {
      sets.push(input);
      const after: TaskRoutePin = {
        taskId: input.taskId,
        segment: input.segment,
        modelId: input.modelId,
        routeId: input.routeId,
        setBy: input.setBy,
        setAt: input.setAt,
        reason: input.reason ?? null,
      };
      return { ok: true, before: null, after };
    },
  };
  return { port, sets };
}

type Opts = { state?: string; paused?: string; open?: 'manual' | 'verify' | 'none' };

/** 内存版的 task12：按要求改成「在跑 / 没在跑」、挂一笔开着的动手（或验收）流水。 */
function setup(opts: Opts = {}, over: Parameters<typeof harness>[0] = {}) {
  const pins = fakePins();
  const h = harness({ taskRoutePins: pins.port, ...over });
  const task = h.store.data.tasks.find((x) => x.id === IDS.task12);
  if (!task) throw new Error('样例数据里要有 task12');
  task.state = (opts.state ?? 'running') as typeof task.state;
  if (opts.paused !== undefined) task.paused = opts.paused;
  h.store.data.segmentRuns = h.store.data.segmentRuns.filter((r) => r.taskId !== IDS.task12);
  const open = opts.open ?? 'manual';
  if (open !== 'none') {
    h.store.data.segmentRuns.push({
      id: '00000000-0000-4000-8000-0000000012aa',
      segment: open,
      taskId: IDS.task12,
      model: 'opus-5.5',
      startedAt: T0.toISOString(),
    });
  }
  return { h, pins };
}

/** 登录自己会记一条操作记录：想比对操作记录条数的用例先登录、取 before、再把会话传进来。 */
const put = async (h: Harness, body: unknown, session?: { cookie: string; csrf: string }) =>
  h.cockpit.request(`/api/tasks/${IDS.task12}/route-pin`, write('PUT', session ?? (await h.login()), body));

const NOW = { segment: 'manual', modelId: 'gpt-5.6', now: true };

describe('单子页「现在就换」', () => {
  it('动手在跑：写下指定，再给这张单的任务工作流发 taskRepin（谁点的、为什么），并记一条 task.repin 操作记录', async () => {
    const { h, pins } = setup();
    const res = await put(h, { ...NOW, reason: '想试试 GPT' });
    expect(res.status).toBe(200);
    expect(pins.sets).toHaveLength(1);
    expect(h.signals).toEqual([
      {
        workflowId: WORKFLOW_ID,
        signal: { name: 'taskRepin', by: DEV_USER_ID, segment: 'manual', reason: '想试试 GPT' },
      },
    ]);
    expect(h.store.data.audit.filter((a) => a.action === 'task.repin').map((a) => a.ok)).toEqual([true]);
  });

  it('不带 now：和以前一样只写指定，不发信号', async () => {
    const { h, pins } = setup();
    const res = await put(h, { segment: 'manual', modelId: 'gpt-5.6' });
    expect(res.status).toBe(200);
    expect(pins.sets).toHaveLength(1);
    expect(h.signals).toEqual([]);
  });

  it.each([
    ['单子不在跑（排队中）', { state: 'queued' }, NOW, 'task_not_running'],
    ['单子停着等人（stalled）', { state: 'stalled' }, NOW, 'task_not_running'],
    ['单子被暂停了', { paused: '已暂停：被 frank 暂停' }, NOW, 'task_paused'],
    ['在跑的是验收，不是动手', { open: 'verify' as const }, NOW, 'segment_not_running'],
    ['动手这一段没有开着的一笔', { open: 'none' as const }, NOW, 'segment_not_running'],
    ['验收段不支持现在就换', {}, { ...NOW, segment: 'verify' }, 'repin_segment_unsupported'],
  ] as [string, Opts, Record<string, unknown>, string][])(
    '【故意造出的失败】%s：409，库里不动、不发信号、不记操作',
    async (_name, opts, body, code) => {
      const { h, pins } = setup(opts);
      const session = await h.login();
      const before = h.store.data.audit.length;
      const res = await put(h, body, session);
      expect([res.status, await errorCode(res)]).toEqual([409, code]);
      expect(pins.sets).toEqual([]);
      expect(h.signals).toEqual([]);
      expect(h.store.data.audit.length).toBe(before);
    },
  );

  it('【故意造出的失败】工作流已经结束、信号发不出去：409，写明指定已记下、只是当场没换成', async () => {
    const { h, pins } = setup(
      {},
      {
        workflows: {
          async signal(workflowId) {
            throw new WorkflowGoneError(workflowId);
          },
        },
      },
    );
    const res = await put(h, NOW);
    const text = await res.clone().text();
    expect([res.status, await errorCode(res)]).toEqual([409, 'workflow_gone']);
    expect(pins.sets).toHaveLength(1);
    expect(text).toContain('新指定已记下');
    // 信号没发成记一条 ok=false 的操作记录
    expect(h.store.data.audit.filter((a) => a.action === 'task.repin').map((a) => a.ok)).toEqual([
      true,
      false,
    ]);
  });
});
