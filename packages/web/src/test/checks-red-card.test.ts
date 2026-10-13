// 等合并期间必过检查红了（#1983）：卡片不写「等合并队列」/「在合并队列」，写「检查红了」加检查名。
import { describe, expect, test } from 'vitest';
import { statusTextOf, toneOf, waitLineOf } from '../components/home/running-card';
import type { HomeRunning } from '../components/home/types';

const item: HomeRunning = {
  issueNumber: 1967,
  title: '等合并时检查转红',
  repo: 'fleet-dao/fleet-dao',
  segment: 'merge',
  waitingReason: 'merge_queue',
  link: '/tasks/t-1967',
  taskId: 't-1967',
};

describe('等合并时检查红了', () => {
  test('必过检查是红的：在等、徽章都写「检查红了」加检查名，用失败色', () => {
    const red: HomeRunning = { ...item, redChecks: 'merge-gate' };
    expect(waitLineOf(red)).toBe('检查红了：merge-gate');
    expect(waitLineOf(red)).not.toContain('等合并队列');
    expect(statusTextOf(red)).toBe('检查红了：merge-gate');
    expect(statusTextOf(red)).not.toContain('在合并队列');
    expect(toneOf(red).tone).toBe('fail');
  });

  test('检查没红：仍写等合并队列、在合并队列', () => {
    expect(waitLineOf(item)).toBe('等合并队列');
    expect(statusTextOf(item)).toBe('在合并队列');
    expect(toneOf(item).tone).toBe('wait');
  });

  test('暂停压过红检查：写已暂停，不是失败红', () => {
    const paused: HomeRunning = {
      ...item,
      waitingReason: 'paused',
      paused: '已暂停：被人暂停（frank）',
      redChecks: 'merge-gate',
    };
    expect(statusTextOf(paused)).toBe('已暂停');
    expect(waitLineOf(paused)).toBe('已暂停');
    expect(toneOf(paused).tone).toBe('stall');
  });
});
