// 被人暂停的单（#820 片 3）在前端怎么读：「在跑的」卡片写「已暂停」、用等待色（黄系 stall）不用失败红；假后端的暂停、继续和真后端同一个说法。
import { describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { statusTextOf, toneOf, WAIT_LABEL } from '../components/home/running-card';
import type { HomeRunning } from '../components/home/types';

const item: HomeRunning = {
  issueNumber: 12,
  title: '登录页加手机验证码',
  repo: 'orbit/web',
  segment: 'doing',
  waitingReason: 'nothing',
  link: '/tasks/t-12',
  taskId: 't-12',
};

describe('卡片上的已暂停', () => {
  test('暂停的单：写「已暂停」，等待色（stall），不是失败红也不是等你拍', () => {
    const paused: HomeRunning = { ...item, waitingReason: 'paused', paused: '已暂停：被人暂停（frank）' };
    expect(statusTextOf(paused)).toBe('已暂停');
    expect(toneOf(paused).tone).toBe('stall');
    expect(WAIT_LABEL.paused).toBe('已暂停');
  });

  test('【故意造出的失败】对照：没暂停的同一张单不写已暂停、不是 stall 色', () => {
    expect(statusTextOf(item)).not.toBe('已暂停');
    expect(toneOf(item).tone).not.toBe('stall');
  });

  test('暂停压过「最近一次是失败」：那是以前的事，现在是人让它停的，不画红', () => {
    const paused: HomeRunning = {
      ...item,
      waitingReason: 'paused',
      lastEvent: { text: '动手超时', at: '2026-10-07T00:00:00.000Z', tone: 'trouble' },
    };
    expect(toneOf(paused).tone).toBe('stall');
  });
});

describe('假后端：暂停、继续', () => {
  test('暂停后任务详情和首页「在跑的」都带着 paused；重复暂停 409 already_paused；继续后清掉', async () => {
    const api = createMockApi({ live: false });
    await api.taskAction('t-12', { action: 'pause', reason: '先看一下' });
    const detail = await api.task('t-12');
    expect(detail.task.paused).toContain('已暂停：被人暂停');
    expect(detail.task.paused).toContain('先看一下');
    const home = await api.home();
    expect(home.running.find((r) => r.taskId === 't-12')).toMatchObject({ waitingReason: 'paused' });
    await expect(api.taskAction('t-12', { action: 'pause' })).rejects.toMatchObject({
      status: 409,
      code: 'already_paused',
    });
    await api.taskAction('t-12', { action: 'resume' });
    expect((await api.task('t-12')).task.paused).toBeUndefined();
    expect((await api.home()).running.find((r) => r.taskId === 't-12')?.waitingReason).not.toBe('paused');
  });

  test('叫停暂停着的单：暂停标记一并清掉（叫停是终局）', async () => {
    const api = createMockApi({ live: false });
    await api.taskAction('t-12', { action: 'pause' });
    await api.taskAction('t-12', { action: 'stop' });
    const task = (await api.task('t-12')).task;
    expect(task.state).toBe('stopped');
    expect(task.paused).toBeUndefined();
  });
});
