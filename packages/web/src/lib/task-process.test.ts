// 任务页概览和过程的说法（#3140）。
import type { ProcessStep } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import { barWeights, callVerb, commandTally, fileParts, PR_STATE, stepDurationMs } from './task-process';

const step = (over: Partial<ProcessStep>): ProcessStep => ({
  index: 0,
  title: 't',
  firstSeq: 0,
  lastSeq: 1,
  startedAt: '2026-10-18T08:00:00.000Z',
  running: false,
  failed: false,
  calls: 0,
  commands: 0,
  commandsFailed: 0,
  commandsUnknown: 0,
  reads: 0,
  callsFailed: 0,
  files: [],
  added: 0,
  removed: 0,
  uncounted: 0,
  ...over,
});

describe('命令计数', () => {
  test('已完成 = 总数 − 失败 − 在跑 − 没读到结果，不出负数', () => {
    expect(commandTally({ commands: 6, commandsFailed: 1, commandsRunning: 1, commandsUnknown: 0 })).toEqual({
      done: 4,
      failed: 1,
      running: 1,
      unknown: 0,
    });
    expect(
      commandTally({ commands: 0, commandsFailed: 1, commandsRunning: 0, commandsUnknown: 0 }).done,
    ).toBe(0);
  });
});

describe('动词', () => {
  test('完成：已运行 / 已读取 / 已编辑 / 创建 / 已搜索；Agent 不加动词前缀靠调用文本自己说', () => {
    expect(callVerb('Bash', 'ok')).toBe('已运行');
    expect(callVerb('Read', 'ok')).toBe('已读取');
    expect(callVerb('Edit', 'ok')).toBe('已编辑');
    expect(callVerb('MultiEdit', 'ok')).toBe('已编辑');
    expect(callVerb('Write', 'ok')).toBe('创建');
    expect(callVerb('Grep', 'ok')).toBe('已搜索');
    expect(callVerb('mcp__x__y', 'ok')).toBe('已调用 mcp__x__y');
  });
  test('没成写失败、还没结果写进行时', () => {
    expect(callVerb('Bash', 'failed')).toBe('运行失败');
    expect(callVerb('Edit', 'failed')).toBe('编辑失败');
    expect(callVerb('Bash', 'pending')).toBe('正在运行');
    expect(callVerb('Read', 'pending')).toBe('正在读取');
  });
});

describe('文件路径', () => {
  test('拆目录和文件名', () => {
    expect(fileParts('packages/web/src/a.tsx')).toEqual({ dir: 'packages/web/src/', base: 'a.tsx' });
    expect(fileParts('README.md')).toEqual({ dir: '', base: 'README.md' });
  });
});

describe('PR 状态', () => {
  test('五种都有字和状态色；没读到的不冒充开着', () => {
    expect(PR_STATE.merged).toMatchObject({ label: '已合并', tone: 'done' });
    expect(PR_STATE.failed.tone).toBe('fail');
    expect(PR_STATE.unknown.label).toBe('没读到状态');
  });
});

describe('时间条', () => {
  test('宽度按用时比例；太短的给下限；在跑的按现在算', () => {
    const now = Date.parse('2026-10-18T08:10:00.000Z');
    const w = barWeights(
      [
        step({ durationMs: 540_000 }),
        step({ durationMs: 1_000 }),
        step({ startedAt: '2026-10-18T08:09:00.000Z', running: true }),
      ],
      now,
    );
    expect(w[0]).toBe(540_000);
    expect(w[1]).toBeGreaterThan(1_000); // 下限抬上去
    expect(w[2]).toBe(60_000);
  });
  test('全是 0：每段等宽，不除以 0', () => {
    expect(barWeights([step({ durationMs: 0 }), step({ durationMs: 0 })], 0)).toEqual([1, 1]);
  });
  test('stepDurationMs：结束了用算好的，在跑的用现在减开始', () => {
    expect(stepDurationMs(step({ durationMs: 5 }), 99)).toBe(5);
    expect(stepDurationMs(step({ running: true }), Date.parse('2026-10-18T08:00:30.000Z'))).toBe(30_000);
  });
});
