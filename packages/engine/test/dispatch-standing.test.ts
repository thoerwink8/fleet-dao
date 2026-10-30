// 一张单「派出过没有」的判法（jobs/dispatch-standing.ts）。#3461：本机领过又退回法国队列的行，各代都已结束，
// 退回晚于最后一代结束的时刻 → 「重新派」，不再误判成「派出过」永远没人接（#3033、#3258）。
import { MAX_TASK_GENERATION } from '@fleet-dao/shared/task-redo';
import { describe, expect, it } from 'vitest';
import {
  dispatchStanding,
  type IssueTaskRow,
  readDispatchStanding,
  type TaskGenerationFacts,
} from '../src/jobs/dispatch-standing.ts';

const T0 = new Date('2026-10-20T00:00:00.000Z');
const T1 = new Date('2026-10-20T05:00:00.000Z');
const T2 = new Date('2026-10-20T08:00:00.000Z');

const returnedRow = (over: Partial<IssueTaskRow> = {}): IssueTaskRow => ({
  id: 'task-1',
  state: 'stopped',
  executor: 'engine',
  returnedAt: T2,
  ...over,
});
const ended = (
  lives: ('running' | 'terminated')[] = ['terminated'],
  lastEndedAt: Date | null = T1,
): TaskGenerationFacts => ({ ok: true, lives, lastEndedAt });

describe('dispatchStanding · 重新派（#3461）', () => {
  it('stopped + engine + 各代都结束 + 退回晚于最后一代结束 → 重新派，下一代是已有代数 + 1', () => {
    expect(dispatchStanding(returnedRow(), ended())).toEqual({
      kind: 'redispatch',
      taskId: 'task-1',
      generation: 2,
      returnedAt: T2,
    });
    expect(dispatchStanding(returnedRow(), ended(['terminated', 'terminated']))).toMatchObject({
      kind: 'redispatch',
      generation: 3,
    });
  });

  it('退回早于最后一代结束（退回之后又起过一代、那一代也结束了）→ 仍是派出过', () => {
    expect(dispatchStanding(returnedRow({ returnedAt: T0 }), ended())).toEqual({ kind: 'dispatched' });
  });

  it('退回和最后一代结束同一刻：不算「晚于」，仍是派出过', () => {
    expect(dispatchStanding(returnedRow({ returnedAt: T1 }), ended())).toEqual({ kind: 'dispatched' });
  });

  it.each([
    ['任务行不是 stopped', returnedRow({ state: 'failed' })],
    ['任务行是本机在做', returnedRow({ state: 'running', executor: 'local' })],
    ['执行方是本机', returnedRow({ executor: 'local' })],
    ['老装配没给执行方', returnedRow({ executor: undefined })],
    ['从没退回过', returnedRow({ returnedAt: null })],
    ['老装配没给退回时刻', returnedRow({ returnedAt: undefined })],
  ])('【故意造出的失败】%s → 派出过，不重新派', (_name, row) => {
    expect(dispatchStanding(row, ended())).toEqual({ kind: 'dispatched' });
  });

  it('【故意造出的失败】有一代还在跑 → 派出过', () => {
    expect(dispatchStanding(returnedRow(), ended(['terminated', 'running'], null))).toEqual({
      kind: 'dispatched',
    });
  });

  it('【故意造出的失败】最后一代什么时候结束的读不到 → 不判重新派（不猜）', () => {
    expect(dispatchStanding(returnedRow(), ended(['terminated'], null))).toEqual({ kind: 'dispatched' });
    expect(dispatchStanding(returnedRow(), { ok: true, lives: ['terminated'] })).toEqual({
      kind: 'dispatched',
    });
  });

  it('已经到代数上限：再起不了下一代，不重新派', () => {
    const lives = Array.from({ length: MAX_TASK_GENERATION }, () => 'terminated' as const);
    expect(dispatchStanding(returnedRow(), ended(lives))).toEqual({ kind: 'dispatched' });
  });

  it('问不清各代：不确定，不当成重新派', () => {
    expect(dispatchStanding(returnedRow(), { ok: false, why: 'Temporal 连不上' })).toMatchObject({
      kind: 'uncertain',
    });
  });
});

describe('dispatchStanding · 原有的几种不变', () => {
  it('没有任务行 → open；没有任何一代的 queued / stopped → adopt；有一代结束且没退回过 → dispatched', () => {
    expect(dispatchStanding(null, null)).toEqual({ kind: 'open' });
    expect(
      dispatchStanding({ id: 't', state: 'queued', executor: 'engine', returnedAt: null }, ended([], null)),
    ).toEqual({ kind: 'adopt', taskId: 't', state: 'queued' });
    expect(
      dispatchStanding({ id: 't', state: 'stopped', executor: 'engine', returnedAt: null }, ended([], null)),
    ).toEqual({ kind: 'adopt', taskId: 't', state: 'stopped' });
    expect(
      dispatchStanding({ id: 't', state: 'done', executor: 'engine', returnedAt: null }, ended()),
    ).toEqual({ kind: 'dispatched' });
  });

  it('本机领单后退回、从没有过任何一代：接手，并带上退回时刻（法国接不了时拉单据此留给本机）', () => {
    expect(dispatchStanding(returnedRow(), ended([], null))).toEqual({
      kind: 'adopt',
      taskId: 'task-1',
      state: 'stopped',
      returnedAt: T2,
    });
  });
});

describe('readDispatchStanding', () => {
  it('把任务行的退回时刻和最后一代的结束时刻一起交给判法', async () => {
    const got = await readDispatchStanding(
      {
        async issueTask() {
          return returnedRow();
        },
        async taskGenerations() {
          return ended();
        },
      },
      'repo',
      12,
    );
    expect(got).toMatchObject({ kind: 'redispatch', generation: 2 });
  });

  it('新内核的单（owner = harness，决定 0124）：不问 Temporal，直接判归新内核；queued、stopped 也不接手', async () => {
    let asked = false;
    for (const state of ['queued', 'stopped', 'running'] as const) {
      const got = await readDispatchStanding(
        {
          async issueTask() {
            return { id: 'task-1', state, executor: 'engine', owner: 'harness' };
          },
          async taskGenerations() {
            asked = true;
            return ended();
          },
        },
        'repo',
        12,
      );
      expect(got).toEqual({ kind: 'harness' });
    }
    expect(asked).toBe(false);
  });
});
