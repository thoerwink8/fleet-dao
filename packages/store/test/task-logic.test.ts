import { TERMINAL_TASK_STATES as DB_TERMINAL_TASK_STATES } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  autoDispatchAudit,
  autoDispatchChanged,
  autoDispatchUnchanged,
  boardCutoffMs,
  canStopTask,
  isAutoDispatchUnchanged,
  isRequestUnchanged,
  isTerminalTaskState,
  keepOnBoard,
  NEW_TASK_STATE,
  nextTaskPriority,
  RECENT_TERMINAL_MS,
  segmentRunMatch,
  TERMINAL_TASK_STATES,
} from '../src/task-logic.ts';

const DAY = 24 * 60 * 60_000;

describe('任务共用判断', () => {
  it('结束状态的清单和库里的一致（库里加了状态这里漏了会红）', () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual([...DB_TERMINAL_TASK_STATES].sort());
  });

  it('isTerminalTaskState：done / stopped / failed 是结束，其余（含认不出的）不是', () => {
    for (const s of ['done', 'stopped', 'failed']) expect(isTerminalTaskState(s)).toBe(true);
    for (const s of ['queued', 'running', 'blocked', '', 'DONE']) expect(isTerminalTaskState(s)).toBe(false);
  });

  it('看板留 7 天：boardCutoffMs 往前推 RECENT_TERMINAL_MS', () => {
    expect(RECENT_TERMINAL_MS).toBe(7 * DAY);
    expect(boardCutoffMs(10 * DAY)).toBe(3 * DAY);
  });

  it('keepOnBoard：没结束的一律留；结束的不早于截止才留（正好等于截止也留）', () => {
    const cutoff = 3 * DAY;
    expect(keepOnBoard('queued', 0, cutoff)).toBe(true);
    expect(keepOnBoard('done', cutoff, cutoff)).toBe(true);
    expect(keepOnBoard('done', cutoff + 1, cutoff)).toBe(true);
    expect(keepOnBoard('done', cutoff - 1, cutoff)).toBe(false);
    expect(keepOnBoard('stopped', 0, cutoff)).toBe(false);
    expect(keepOnBoard('failed', 0, cutoff)).toBe(false);
  });

  it('keepOnBoard：结束时刻读不出（NaN）就不留，不当成「最新」', () => {
    expect(keepOnBoard('done', Number.NaN, 0)).toBe(false);
  });

  it('nextTaskPriority：这个仓最大的加一，没有任务从 1 起，不被负数拉低', () => {
    expect(nextTaskPriority([])).toBe(1);
    expect(nextTaskPriority([3, 1, 2])).toBe(4);
    expect(nextTaskPriority([-5])).toBe(1);
  });

  it('isRequestUnchanged：标题和原话都一样才算没变，任何一个不同都算改了', () => {
    const task = { title: 't', rawRequest: 'r' };
    expect(isRequestUnchanged(task, { title: 't', rawRequest: 'r' })).toBe(true);
    expect(isRequestUnchanged(task, { title: 't2', rawRequest: 'r' })).toBe(false);
    expect(isRequestUnchanged(task, { title: 't', rawRequest: 'r2' })).toBe(false);
  });

  it('canStopTask：只有排队中的能停', () => {
    expect(NEW_TASK_STATE).toBe('queued');
    expect(canStopTask('queued')).toBe(true);
    for (const s of ['running', 'done', 'stopped', 'failed', '']) expect(canStopTask(s)).toBe(false);
  });

  it('segmentRunMatch：记了任务号的只认任务号（别张任务的不收，哪怕 issue 号和工作流编号都碰巧对上）', () => {
    const task = { id: 't1', issueNumber: 12, workflowId: 'task:a/b#12' };
    expect(segmentRunMatch({ taskId: 't1' }, task)).toBe('task');
    expect(
      segmentRunMatch({ taskId: 't2', issueNumber: 12, workflowId: 'task:a/b#12' }, task),
    ).toBeUndefined();
    expect(segmentRunMatch({ taskId: null, issueNumber: 12, workflowId: 'task:a/b#12' }, task)).toBe(
      'issueNumber',
    );
  });

  it('segmentRunMatch：没记任务号的按 issue 号兜底，工作流编号不对、没记、任务那边算不出都不收', () => {
    const task = { id: 't1', issueNumber: 12, workflowId: 'task:a/b#12' };
    expect(segmentRunMatch({ issueNumber: 12, workflowId: 'task:a/b#12' }, task)).toBe('issueNumber');
    expect(segmentRunMatch({ issueNumber: 13, workflowId: 'task:a/b#12' }, task)).toBeUndefined();
    expect(segmentRunMatch({ issueNumber: 12, workflowId: 'task:other/b#12' }, task)).toBeUndefined();
    expect(segmentRunMatch({ issueNumber: 12 }, task)).toBeUndefined();
    expect(segmentRunMatch({}, task)).toBeUndefined();
    expect(
      segmentRunMatch({ issueNumber: 12, workflowId: 'x' }, { ...task, workflowId: undefined }),
    ).toBeUndefined();
    expect(segmentRunMatch({ issueNumber: 12 }, { ...task, workflowId: undefined })).toBeUndefined();
  });

  it('isAutoDispatchUnchanged：有打开时刻 = 开着；要的状态和现在一样就不改', () => {
    expect(isAutoDispatchUnchanged(null, false)).toBe(true);
    expect(isAutoDispatchUnchanged('2026-01-01T00:00:00.000Z', true)).toBe(true);
    expect(isAutoDispatchUnchanged(null, true)).toBe(false);
    expect(isAutoDispatchUnchanged('2026-01-01T00:00:00.000Z', false)).toBe(false);
  });

  it('开关的返回形状：没改不带 auditId，改了带；操作记录 before / after 是打开时刻', () => {
    expect(autoDispatchUnchanged(null)).toEqual({ changed: false, autoDispatchSince: null });
    expect(autoDispatchChanged('t1', 'a1')).toEqual({
      changed: true,
      autoDispatchSince: 't1',
      auditId: 'a1',
    });
    const entry = {
      actor: { kind: 'user' as const, id: 'u1' },
      action: 'repo.auto_dispatch.enable',
      target: 'repo:1',
      via: 'cockpit' as const,
      ok: true,
    };
    expect(autoDispatchAudit(entry, null, 't1')).toEqual({
      ...entry,
      before: { autoDispatchSince: null },
      after: { autoDispatchSince: 't1' },
    });
  });
});
