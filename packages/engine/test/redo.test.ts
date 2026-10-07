// 被撤的任务可以重做（jobs/redo.ts）：同一张单另起一代，编号 task:<仓>#<号>:r2。
// 旧代必须已经终止；还在跑就拒绝。重做不许改旧代的记录（故意造出覆盖，这条就红）。
import { parseTaskWorkflowId, taskWorkflowId } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  generationLife,
  MAX_TASK_GENERATION,
  readTaskGenerations,
  redoTask,
  runningTaskWorkflowId,
  signalTaskWorkflowId,
} from '../src/jobs/redo.ts';

const repo = { owner: 'acme', name: 'demo' };
const issue = 12;
const id1 = taskWorkflowId(repo, issue);

interface Row {
  workflowId: string;
  generation: number;
  life: 'running' | 'terminated';
  record: { note: string };
}

function world(rows: Row[]) {
  const store = new Map(rows.map((row) => [row.workflowId, row]));
  const started: string[] = [];
  return {
    store,
    started,
    async list() {
      return [...store.values()];
    },
    async start(workflowId: string): Promise<'started' | 'already_exists'> {
      started.push(workflowId);
      const existing = store.get(workflowId);
      if (existing) {
        store.set(workflowId, { ...existing, record: { note: '被覆盖' } });
        return 'already_exists';
      }
      const parsed = parseTaskWorkflowId(workflowId);
      store.set(workflowId, {
        workflowId,
        generation: parsed?.generation ?? 0,
        life: 'running',
        record: { note: '新一代' },
      });
      return 'started';
    },
  };
}

describe('撤掉以后可以重做', () => {
  it('旧代已经终止：另起 :r2，旧记录原样留着', async () => {
    const old = { note: '第一代留下来的' };
    const w = world([{ workflowId: id1, generation: 1, life: 'terminated', record: old }]);
    const outcome = await redoTask(w);
    expect(outcome).toEqual({ ok: true, workflowId: 'task:acme/demo#12:r2', generation: 2 });
    expect(w.started).toEqual(['task:acme/demo#12:r2']);
    expect(w.store.get(id1)?.life).toBe('terminated');
    expect(w.store.get(id1)?.record).toBe(old);
    expect(w.store.get(id1)?.record).toEqual({ note: '第一代留下来的' });
    expect(w.store.get('task:acme/demo#12:r2')?.record).not.toBe(old);
    expect(w.store.get('task:acme/demo#12:r2')?.life).toBe('running');
  });

  it('旧任务还在跑：拒绝，说明先叫停，不另起、不碰记录', async () => {
    const old = { note: '还在跑' };
    const w = world([{ workflowId: id1, generation: 1, life: 'running', record: old }]);
    const outcome = await redoTask(w);
    expect(outcome).toEqual({ ok: false, why: `上一代还在跑（${id1}），先叫停再重做` });
    expect(w.started).toEqual([]);
    expect(w.store.size).toBe(1);
    expect(w.store.get(id1)?.record).toBe(old);
  });

  it('【故意造出的失败】重做后旧代的记录不能被覆盖', async () => {
    const old = { note: '第一代留下来的' };
    const w = world([{ workflowId: id1, generation: 1, life: 'terminated', record: old }]);
    const outcome = await redoTask(w);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.workflowId).toBe('task:acme/demo#12:r2');
    expect(w.store.get(id1)?.record).toBe(old);
    expect(old).toEqual({ note: '第一代留下来的' });
    expect(w.store.get(id1)).toEqual({
      workflowId: id1,
      generation: 1,
      life: 'terminated',
      record: old,
    });
  });

  it('没有上一代：拒绝，不起第一条', async () => {
    const w = world([]);
    expect(await redoTask(w)).toEqual({ ok: false, why: '没有上一代任务可重做' });
    expect(w.started).toEqual([]);
  });

  it('下一代编号已经有记录：不覆盖，也不再往下跳', async () => {
    const old = { note: '第一代留下来的' };
    const w = world([{ workflowId: id1, generation: 1, life: 'terminated', record: old }]);
    w.start = async (workflowId) => {
      w.started.push(workflowId);
      return 'already_exists';
    };
    const outcome = await redoTask(w);
    expect(outcome).toEqual({
      ok: false,
      why: '编号 task:acme/demo#12:r2 已经有记录，没有覆盖旧代，也没另起',
    });
    expect(w.started).toEqual(['task:acme/demo#12:r2']);
    expect(w.store.get(id1)?.record).toBe(old);
    expect(w.store.has('task:acme/demo#12:r3')).toBe(false);
  });

  it('第二代也终止了：下一次是 :r3，第一代、第二代都留着', async () => {
    const first = { note: '第一代' };
    const second = { note: '第二代' };
    const w = world([
      { workflowId: id1, generation: 1, life: 'terminated', record: first },
      { workflowId: 'task:acme/demo#12:r2', generation: 2, life: 'terminated', record: second },
    ]);
    const outcome = await redoTask(w);
    expect(outcome).toEqual({ ok: true, workflowId: 'task:acme/demo#12:r3', generation: 3 });
    expect(w.store.get(id1)?.record).toBe(first);
    expect(w.store.get('task:acme/demo#12:r2')?.record).toBe(second);
  });

  it(`已经到第 ${MAX_TASK_GENERATION} 代：不再另起`, async () => {
    const rows: Row[] = [];
    for (let g = 1; g <= MAX_TASK_GENERATION; g++) {
      rows.push({
        workflowId: taskWorkflowId(repo, issue, g),
        generation: g,
        life: 'terminated',
        record: { note: `第 ${g} 代` },
      });
    }
    const first = rows[0]?.record;
    const w = world(rows);
    const outcome = await redoTask(w);
    expect(outcome).toEqual({ ok: false, why: `已经重做到第 ${MAX_TASK_GENERATION} 代，不再另起` });
    expect(w.started).toEqual([]);
    expect(w.store.get(id1)?.record).toBe(first);
  });
});

describe('顺着代数看', () => {
  it('第一代没有就停，不去猜后面还有没有', async () => {
    const seen: string[] = [];
    const read = await readTaskGenerations(repo, issue, async (id) => {
      seen.push(id);
      return { life: 'missing' };
    });
    expect(read).toEqual({ ok: true, generations: [] });
    expect(seen).toEqual([id1]);
  });

  it('看不清上一代还在不在跑：拒绝，不另起', async () => {
    const read = await readTaskGenerations(repo, issue, async () => ({ life: 'unknown' }));
    expect(read).toEqual({ ok: false, why: `查不到上一代是不是还在跑（${id1}），没有另起` });
  });

  it('在跑的那一代才算占着工作树；第一代没有就停', async () => {
    const asked: string[] = [];
    const running = await runningTaskWorkflowId(repo, issue, async (id) => {
      asked.push(id);
      return id === id1 ? 'running' : 'missing';
    });
    expect(running).toBe(id1);
    expect(asked).toEqual([id1]);

    const askedClosed: string[] = [];
    const later = await runningTaskWorkflowId(repo, issue, async (id) => {
      askedClosed.push(id);
      if (id === id1) return 'closed';
      if (id === 'task:acme/demo#12:r2') return 'running';
      return 'missing';
    });
    expect(later).toBe('task:acme/demo#12:r2');
    expect(askedClosed).toEqual([id1, 'task:acme/demo#12:r2']);

    const askedMissing: string[] = [];
    const none = await runningTaskWorkflowId(repo, issue, async (id) => {
      askedMissing.push(id);
      return 'missing';
    });
    expect(none).toBeNull();
    expect(askedMissing).toEqual([id1]);
  });

  it('发信号找在跑的那一代；都结束了就找最高的一代，一条都没有才退回第一代', async () => {
    expect(await signalTaskWorkflowId(repo, issue, async (id) => (id === id1 ? 'running' : 'missing'))).toBe(
      id1,
    );
    expect(
      await signalTaskWorkflowId(repo, issue, async (id) => {
        if (id === id1) return 'closed';
        if (id === 'task:acme/demo#12:r2') return 'running';
        return 'missing';
      }),
    ).toBe('task:acme/demo#12:r2');
    expect(await signalTaskWorkflowId(repo, issue, async (id) => (id === id1 ? 'closed' : 'missing'))).toBe(
      id1,
    );
    const asked: string[] = [];
    expect(
      await signalTaskWorkflowId(repo, issue, async (id) => {
        asked.push(id);
        return 'missing';
      }),
    ).toBe(id1);
    expect(asked).toEqual([id1]);
  });
});

describe('generationLife', () => {
  it('结束了的状态名算终止；还在跑和认不出的都算还在跑', () => {
    expect(generationLife('RUNNING')).toBe('running');
    expect(generationLife('COMPLETED')).toBe('terminated');
    expect(generationLife('FAILED')).toBe('terminated');
    expect(generationLife('CANCELED')).toBe('terminated');
    expect(generationLife('CANCELLED')).toBe('terminated');
    expect(generationLife('TERMINATED')).toBe('terminated');
    expect(generationLife('TIMED_OUT')).toBe('terminated');
    expect(generationLife('CONTINUED_AS_NEW')).toBe('running');
    expect(generationLife('UNSPECIFIED')).toBe('running');
  });
});
