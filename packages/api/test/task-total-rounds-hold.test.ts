// 驾驶舱「重做」另起新一代之前按历代累计动手轮数封顶（#3625）：累计到 MAX_TOTAL_ROUNDS 就 409、不另起新一代、留言并交回本机；
// 没到照常重做。累计数自库里 runs（segment=manual、outcome=done，跨代）。
import { MAX_TOTAL_ROUNDS } from '@fleet-dao/shared/continue-exhausted';
import { describe, expect, it } from 'vitest';
import type { LocalHoldInput } from '../src/local-hold.ts';
import { errorCode, harness, IDS, write } from './harness.ts';

function seedRuns(h: ReturnType<typeof harness>, count: number, outcome: 'done' | 'killed' = 'done') {
  for (let i = 0; i < count; i += 1) {
    h.store.data.segmentRuns.push({
      id: `00000000-0000-4000-8000-${String(900000 + h.store.data.segmentRuns.length).padStart(12, '0')}`,
      segment: 'manual',
      taskId: IDS.task12,
      model: 'claude-sonnet-5-5',
      startedAt: new Date(Date.UTC(2026, 9, 20, 0, h.store.data.segmentRuns.length)).toISOString(),
      endedAt: new Date(Date.UTC(2026, 9, 20, 1, h.store.data.segmentRuns.length)).toISOString(),
      outcome,
    });
  }
}

function stopped(h: ReturnType<typeof harness>) {
  const task = h.store.data.tasks.find((row) => row.id === IDS.task12);
  if (!task) throw new Error('样例数据里要有 #12');
  task.state = 'stopped';
}

function redoable(holds: LocalHoldInput[], calls: { n: number }) {
  return {
    localHold: async (input: LocalHoldInput) => void holds.push(input),
    taskRedo: {
      redo: async () => {
        calls.n += 1;
        return { ok: true as const, workflowId: 'task:example/canary#12:r2', generation: 2 };
      },
    },
  };
}

describe('驾驶舱：重做按历代累计动手轮数封顶（#3625）', () => {
  it('历代累计做完 6 轮：409 total_rounds_hold，不另起新一代，留言并交回本机，追加一条没做成', async () => {
    const holds: LocalHoldInput[] = [];
    const calls = { n: 0 };
    const h = harness(redoable(holds, calls));
    seedRuns(h, MAX_TOTAL_ROUNDS);
    stopped(h);
    const s = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('total_rounds_hold');
    expect(calls.n).toBe(0);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ issueNumber: 12, repo: { owner: 'example', name: 'canary' } });
    expect(holds[0]?.comment).toContain('历代累计已经动手 6 轮');
    expect(h.store.data.audit.filter((a) => a.action === 'task.redo').map((a) => a.ok)).toEqual([
      true,
      false,
    ]);
  });

  it('累计没到上限（5 轮）：照常重做，不留言', async () => {
    const holds: LocalHoldInput[] = [];
    const calls = { n: 0 };
    const h = harness(redoable(holds, calls));
    seedRuns(h, MAX_TOTAL_ROUNDS - 1);
    stopped(h);
    const s = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(200);
    expect(calls.n).toBe(1);
    expect(holds).toEqual([]);
  });

  it('被杀、没做成的笔不算一轮：5 轮做完 + 3 笔被杀 = 还是 5 轮，照常重做', async () => {
    const holds: LocalHoldInput[] = [];
    const calls = { n: 0 };
    const h = harness(redoable(holds, calls));
    seedRuns(h, MAX_TOTAL_ROUNDS - 1);
    seedRuns(h, 3, 'killed');
    stopped(h);
    const s = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(200);
    expect(calls.n).toBe(1);
  });

  it('没接 GitHub（开发环境）：照样拦，原因里写明没贴标签', async () => {
    const calls = { n: 0 };
    const h = harness({
      taskRedo: {
        redo: async () => {
          calls.n += 1;
          return { ok: true as const, workflowId: 'task:example/canary#12:r2', generation: 2 };
        },
      },
    });
    seedRuns(h, MAX_TOTAL_ROUNDS);
    stopped(h);
    const s = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('没贴「本机做」');
    expect(calls.n).toBe(0);
  });

  it('【故意造出的失败】读不到历代轮数：503，不另起新一代，不当成 0 轮', async () => {
    const holds: LocalHoldInput[] = [];
    const calls = { n: 0 };
    const h = harness(redoable(holds, calls));
    h.store.listSegmentRuns = async () => {
      throw new Error('库连不上');
    };
    stopped(h);
    const s = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', s, { action: 'redo' }),
    );
    expect(res.status).toBe(503);
    expect(calls.n).toBe(0);
  });
});
