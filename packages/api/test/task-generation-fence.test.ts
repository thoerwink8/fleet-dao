// 受管起代先落起代意图：正常重做照常另起并落已结；已做完、不在库里的单不调 Temporal；
// 绑了目标之后结果未知时意图挂着，再跑一次重做明确看到那一代（列代或起成、编号已存在）才核清，不会永久卡住。
import type { TaskState } from '@fleet-dao/shared';
import { createMemoryStore } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import type { TaskRedoPort } from '../src/deps.ts';
import { fencedTaskRedo } from '../src/task-generation-fence.ts';

const TASK = 'd629758a-570d-405d-be00-417b7ee6c0c7';
const WHEN = '2026-10-19T01:52:06.446Z';
const WF = 'task:thoerwink8/fleet-dao#3114';
const REPO = {
  id: 'repo',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm test',
};
const ACTOR = { kind: 'ops', id: 'founder', via: 'ops' } as const;

function storeWith(state: TaskState) {
  return createMemoryStore(
    {
      repos: [REPO],
      tasks: [
        {
          id: TASK,
          repoId: 'repo',
          issueNumber: 3114,
          title: '合成',
          rawRequest: '合成',
          requestedBy: 'test',
          state,
          priority: 0,
          createdAt: WHEN,
          executor: 'engine',
        },
      ],
      taskClosures: [{ taskId: TASK, phase: 'abandoned', updatedAt: WHEN }],
    },
    { now: () => new Date('2026-10-19T02:00:00.000Z') },
  );
}

type RedoInput = Parameters<TaskRedoPort['redo']>[0];
type RedoResult = Awaited<ReturnType<TaskRedoPort['redo']>>;

/** 替身 Temporal 重做口子：behave 自己决定报不报 observed、调不调 beforeStart（和真 createTemporalTaskRedo 同一约定）。 */
function fakeRedo(behave: (input: RedoInput) => Promise<RedoResult>) {
  const calls: string[] = [];
  const port: TaskRedoPort = {
    async redo(input) {
      calls.push(input.taskId);
      return behave(input);
    },
  };
  return { port, calls };
}

/** 列到第 seen 代，再起第 next 代；start 决定起的那一步怎么回来。 */
function redoing(seen: number, next: number, start: () => Promise<'started' | 'already_exists'>) {
  return async (input: RedoInput): Promise<RedoResult> => {
    input.observed?.(seen);
    const workflowId = `${WF}:r${next}`;
    await input.beforeStart?.(workflowId);
    if ((await start()) === 'already_exists')
      return { ok: false, why: `编号 ${workflowId} 已经有记录，没有覆盖旧代，也没另起` };
    return { ok: true, workflowId, generation: next };
  };
}

const deadline = async (): Promise<never> => {
  throw new Error('4 DEADLINE_EXCEEDED');
};
const input = { taskId: TASK, issueNumber: 3114, title: '合成', repo: REPO } as const;

async function pending(store: ReturnType<typeof storeWith>) {
  const ledger = await store.readCorrectMergedLedger({
    owner: 'thoerwink8',
    name: 'fleet-dao',
    issueNumber: 3114,
    prNumber: 3137,
  });
  return ledger?.task.startPending;
}

const actions = (store: ReturnType<typeof storeWith>) => store.data.audit.map((row) => row.action);

// Postgres 上的意图、更新时间和纠正交错见 task-correct-merged-assembly.test.ts。
describe('受管起代的起代意图', () => {
  it('已做完或不在库里：意图里重读就拒绝，不调 Temporal，不落意图', async () => {
    for (const [state, taskId] of [
      ['done', TASK],
      ['stopped', 'd629758a-570d-405d-be00-000000000000'],
    ] as const) {
      const store = storeWith(state);
      const { port, calls } = fakeRedo(redoing(1, 2, async () => 'started'));
      const outcome = await fencedTaskRedo(port, store, ACTOR).redo({ ...input, taskId });
      expect(outcome.ok).toBe(false);
      if (state === 'done')
        expect(outcome).toEqual({ ok: false, why: '这张单现在是done，只有已叫停或挂起的才能重做' });
      expect(calls).toEqual([]);
      expect(store.data.audit).toEqual([]);
    }
  });

  it('正常重做：绑目标、起成、落已结，意图不挂着', async () => {
    const store = storeWith('stopped');
    const { port } = fakeRedo(redoing(1, 2, async () => 'started'));
    expect(await fencedTaskRedo(port, store, ACTOR).redo(input)).toEqual({
      ok: true,
      workflowId: `${WF}:r2`,
      generation: 2,
    });
    expect(actions(store)).toEqual(['task.start-intent', 'task.start-target', 'task.start-settled']);
    expect(await pending(store)).toBe(false);
  });

  it('还没绑目标就抛错（列代、叫停上一代没成）：明确没起，落已结', async () => {
    const store = storeWith('stopped');
    const { port } = fakeRedo(async (redoInput) => {
      redoInput.observed?.(1);
      throw new Error('14 UNAVAILABLE');
    });
    await expect(fencedTaskRedo(port, store, ACTOR).redo(input)).rejects.toThrow('UNAVAILABLE');
    expect(actions(store)).toEqual(['task.start-intent', 'task.start-settled']);
    expect(await pending(store)).toBe(false);
  });

  it('绑了目标之后超时（结果未知）：意图挂着；列代读不清的再次重做核不清，仍挂着', async () => {
    const store = storeWith('stopped');
    const timeout = fakeRedo(redoing(1, 2, deadline));
    await expect(fencedTaskRedo(timeout.port, store, ACTOR).redo(input)).rejects.toThrow('DEADLINE_EXCEEDED');
    expect(await pending(store)).toBe(true);

    const unread = fakeRedo(async () => ({ ok: false as const, why: '查不到上一代是不是还在跑' }));
    const outcome = await fencedTaskRedo(unread.port, store, ACTOR).redo(input);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.why).toContain('起代没有结算');
    expect(await pending(store)).toBe(true);
  });

  it('结果未知后再跑重做：列代明确看到迟到的那一代在跑，就核清（不调 start）', async () => {
    const store = storeWith('stopped');
    await expect(
      fencedTaskRedo(fakeRedo(redoing(1, 2, deadline)).port, store, ACTOR).redo(input),
    ).rejects.toThrow('DEADLINE_EXCEEDED');
    const landed = fakeRedo(async (redoInput) => {
      redoInput.observed?.(2);
      return { ok: false, why: `上一代还在跑（${WF}:r2），先叫停再重做` };
    });
    const outcome = await fencedTaskRedo(landed.port, store, ACTOR).redo(input);
    expect(outcome).toEqual({ ok: false, why: `上一代还在跑（${WF}:r2），先叫停再重做` });
    expect(landed.calls).toEqual([TASK]);
    expect(await pending(store)).toBe(false);
  });

  it('结果未知后再跑重做：还没落地就由这一次起同一代，起成或编号已存在都核清', async () => {
    for (const start of ['started', 'already_exists'] as const) {
      const store = storeWith('stopped');
      await expect(
        fencedTaskRedo(fakeRedo(redoing(1, 2, deadline)).port, store, ACTOR).redo(input),
      ).rejects.toThrow('DEADLINE_EXCEEDED');
      await fencedTaskRedo(fakeRedo(redoing(1, 2, async () => start)).port, store, ACTOR).redo(input);
      expect(await pending(store), start).toBe(false);
    }
  });

  it('被后来的重做接手的旧持有者：绑不了目标，不会越代再起', async () => {
    const store = storeWith('stopped');
    let resumeOld: () => void = () => undefined;
    const oldStarts: string[] = [];
    const old = fencedTaskRedo(
      fakeRedo(async (redoInput) => {
        redoInput.observed?.(1);
        await new Promise<void>((resolve) => {
          resumeOld = resolve;
        });
        await redoInput.beforeStart?.(`${WF}:r2`);
        oldStarts.push('r2');
        return { ok: true, workflowId: `${WF}:r2`, generation: 2 };
      }).port,
      store,
      ACTOR,
    ).redo(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 新的一次重做接手（落新意图），起成第二代并结算
    expect(
      (await fencedTaskRedo(fakeRedo(redoing(1, 2, async () => 'started')).port, store, ACTOR).redo(input))
        .ok,
    ).toBe(true);
    resumeOld();
    expect(await old).toEqual({ ok: false, why: '这次起代意图已被后来的起代接手或已经结算，没有再起' });
    expect(oldStarts).toEqual([]);
    expect(await pending(store)).toBe(false);
  });

  it('绑过更高代数的未知起代：这次起的更低一代核不清它，意图挂着', async () => {
    const store = storeWith('stopped');
    await expect(
      fencedTaskRedo(fakeRedo(redoing(2, 3, deadline)).port, store, ACTOR).redo(input),
    ).rejects.toThrow('DEADLINE_EXCEEDED');
    // 假设列代只看到第一代（读到的比绑的还旧），起的第二代核不清第三代的未知起代
    const outcome = await fencedTaskRedo(
      fakeRedo(redoing(1, 2, async () => 'started')).port,
      store,
      ACTOR,
    ).redo(input);
    expect(outcome.ok).toBe(true);
    expect(await pending(store)).toBe(true);
  });
});
