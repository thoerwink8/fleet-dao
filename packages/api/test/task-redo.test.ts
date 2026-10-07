// 驾驶舱「重做」（cockpit.ts）：已叫停或挂起才交给引擎另起一代。叫停本身的语义不动。
import { describe, expect, it } from 'vitest';
import type { TaskRedoPort } from '../src/deps.ts';
import { errorCode, harness, IDS, write } from './harness.ts';

function taskOf(h: ReturnType<typeof harness>, id: string) {
  const task = h.store.data.tasks.find((row) => row.id === id);
  if (!task) throw new Error(`样例数据里要有 ${id}`);
  return task;
}

function port(redo: TaskRedoPort['redo']): TaskRedoPort {
  return { redo };
}

/** 登录也会记一条。重做有没有记，只看 task. 开头的。 */
function taskAudits(h: ReturnType<typeof harness>) {
  return h.store.data.audit.filter((row) => row.action.startsWith('task.'));
}

describe('重做', () => {
  it('已叫停：交给重做入口另起一代，不发信号，也不把状态改回排队', async () => {
    const seen: { issueNumber: number; repo: string; title: string }[] = [];
    const h = harness({
      taskRedo: port(async (input) => {
        seen.push({
          issueNumber: input.issueNumber,
          repo: `${input.repo.owner}/${input.repo.name}`,
          title: input.title,
        });
        return { ok: true, workflowId: 'task:example/canary#12:r2', generation: 2 };
      }),
    });
    const s = await h.login();
    const task = taskOf(h, IDS.task12);
    task.state = 'stopped';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ issueNumber: 12, repo: 'example/canary', title: '登录页加验证码' }]);
    expect(task.state).toBe('stopped');
    expect(h.signals).toEqual([]);
    expect(taskAudits(h).map((row) => [row.action, row.ok])).toEqual([['task.redo', true]]);
  });

  it('上一代还在跑：409，原因原样给驾驶舱，并追加一条没做成', async () => {
    const why = '上一代还在跑（task:example/canary#12），先叫停再重做';
    const h = harness({
      taskRedo: port(async () => ({ ok: false, why })),
    });
    const s = await h.login();
    taskOf(h, IDS.task12).state = 'stalled';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('redo_refused');
    expect(body.error.message).toBe(why);
    expect(taskAudits(h).map((row) => [row.action, row.ok, row.error])).toEqual([
      ['task.redo', true, undefined],
      ['task.redo', false, why],
    ]);
  });

  it('还在跑、做完的不能重做：不调用入口、不写记录', async () => {
    let called = 0;
    const h = harness({
      taskRedo: port(async () => {
        called += 1;
        return { ok: true, workflowId: 'task:example/canary#12:r2', generation: 2 };
      }),
    });
    const s = await h.login();
    const running = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(running.status).toBe(409);
    expect(await errorCode(running)).toBe('redo_not_allowed');
    const done = await h.cockpit.request(
      `/api/tasks/${IDS.task13}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(done.status).toBe(409);
    expect(await errorCode(done)).toBe('redo_not_allowed');
    expect(called).toBe(0);
    expect(taskAudits(h)).toEqual([]);
  });

  it('没接 Temporal：503，不假装已经另起', async () => {
    const h = harness();
    const s = await h.login();
    taskOf(h, IDS.task12).state = 'stopped';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('redo_not_wired');
    expect(taskAudits(h)).toEqual([]);
    expect(taskOf(h, IDS.task12).state).toBe('stopped');
  });

  it('已叫停再点暂停仍是 409 task_finished：叫停的语义没变', async () => {
    const h = harness({
      taskRedo: port(async () => ({ ok: true, workflowId: 'task:example/canary#12:r2', generation: 2 })),
    });
    const s = await h.login();
    taskOf(h, IDS.task12).state = 'stopped';
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'pause' }),
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('task_finished');
    expect(h.signals).toEqual([]);
    expect(taskAudits(h)).toEqual([]);
  });
});
