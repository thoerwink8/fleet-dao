import { beforeAll, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { Activity, Board, BoardTask, Me } from '../api/types';
import {
  activityPhrase,
  describeSubtask,
  describeTask,
  isMine,
  needsAttention,
  taskLive,
  taskTone,
} from './status';

const NOW = Date.parse('2026-09-25T10:00:00Z');
let board: Board;

beforeAll(async () => {
  // 看板数据走一遍假后端：出来的形状已经按 shared/web-api.ts 校验过。
  board = await createMockApi({ live: false, now: () => NOW }).board('r-fleet');
});

function task(issue: number): BoardTask {
  const t = board.tasks.find((x) => x.issueNumber === issue);
  if (!t) throw new Error(`看板上没有 #${issue}`);
  return t;
}

function sub(issue: number, index: number) {
  const s = task(issue).subtasks.find((x) => x.index === index);
  if (!s) throw new Error(`#${issue} 没有第 ${index} 个子任务`);
  return s;
}

describe('每张卡一句白话状态', () => {
  test('在写码的子任务：后端给「谁在干哪一步」，前端补上干了多久', () => {
    expect(describeSubtask(sub(12, 1), NOW)).toBe('Opus 5.5 正在写验证码过期的测试，已 12 分钟');
  });

  test('还在排队的会话写「已排」，不写成在干活', () => {
    const a: Activity = {
      runId: 'r',
      stage: 'execute',
      routeId: 'x',
      modelName: 'Opus 5.5',
      queued: true,
      since: new Date(NOW - 3 * 60_000).toISOString(),
      text: 'Opus 5.5 排队中',
    };
    expect(activityPhrase(a, NOW)).toBe('Opus 5.5 排队中，已排 3 分钟');
  });

  test('停滞的子任务写明卡在哪一步、交给了帅位', () => {
    expect(describeSubtask(sub(17, 0), NOW)).toBe('卡在「加密与传输」没有进展，已交帅位诊断');
  });

  test('等前置的子任务写明等哪一个', () => {
    const t = task(12);
    expect(describeSubtask(sub(12, 2), NOW, t.subtasks)).toBe('等子任务 B 先合并');
  });

  test('有子任务的需求概括各子任务的状态', () => {
    expect(describeTask(task(12), NOW)).toBe('3 个子任务：1 个已合并 · 1 个在写码 · 1 个在等');
  });

  test('写方案的需求用后端的白话，加上时长', () => {
    expect(describeTask(task(16), NOW)).toBe('Opus 5.5 正在写方案，已 5 分钟');
  });
});

describe('颜色只表达状态', () => {
  test('等人回答的需求是「等你」色', () => {
    expect(taskTone(task(15))).toBe('human');
  });

  test('只有真在干活的需求才有动效；排队、等人的没有', () => {
    expect(taskLive(task(12))).toBe(true);
    expect(taskLive(task(18))).toBe(false);
    expect(taskLive(task(15))).toBe(false);
  });

  test('「只看卡住的」挑出等人、停滞、失败，不含正常在跑的', () => {
    const picked = board.tasks.filter(needsAttention).map((t) => t.issueNumber);
    expect(picked.sort((a, b) => a - b)).toEqual([15, 17, 19]);
  });
});

describe('只看我提的', () => {
  const me: Me = { user: { id: 'u-lan', displayName: '阿岚', role: 'founder' }, csrfToken: 't' };

  test('提出人填的是用户编号或名字都认', () => {
    expect(isMine('u-lan', me)).toBe(true);
    expect(isMine('阿岚', me)).toBe(true);
  });

  test('别人的、没登录时都不算', () => {
    expect(isMine('u-zhou', me)).toBe(false);
    expect(isMine('u-lan', undefined)).toBe(false);
  });
});
