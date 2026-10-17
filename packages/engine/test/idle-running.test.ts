// 看门狗：running + executor=engine + 没有开着的会话 + 任务行过旧（#2392）。
// 换路由续之后睡在等选路里就是这个样子：工作流仍 Running，拉单把它算进在干活。判据钉在这里。

import { describe, expect, it } from 'vitest';
import {
  IDLE_RUNNING_LINK,
  IDLE_RUNNING_STALE_MS,
  type IdleRunningFact,
  idleRunningAlertKey,
  judgeIdleRunning,
  watchIdleRunning,
} from '../src/jobs/idle-running.ts';
import { SELF_CHECK_ACTIVITY_MS, SELF_CHECK_DOING } from '../src/self-check-budget.ts';

const NOW = new Date('2026-10-16T03:16:00.000Z');
const STALE = new Date(NOW.getTime() - IDLE_RUNNING_STALE_MS - 60_000);
const FRESH = new Date(NOW.getTime() - IDLE_RUNNING_STALE_MS + 60_000);
const EXACT = new Date(NOW.getTime() - IDLE_RUNNING_STALE_MS);

function row(over: Partial<IdleRunningFact> = {}): IdleRunningFact {
  return {
    taskId: 'task-2261',
    owner: 'thoerwink8',
    name: 'fleet-dao',
    issueNumber: 2261,
    state: 'running',
    executor: 'engine',
    openRuns: 0,
    updatedAt: STALE,
    doing: '第 2 轮：deepseek-flash 同一条路由第二次总时长到顶，换一条路由带上进度续一次，不停下等人',
    ...over,
  };
}

describe('judgeIdleRunning：引擎自测那一段', () => {
  const doing = `第 1 轮：${SELF_CHECK_DOING}`;

  it('进度停在自测上、自测活动限时以内：不报（正常排队、跑测试没有会话）', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(judgeIdleRunning(row({ doing, updatedAt: at(IDLE_RUNNING_STALE_MS + 60_000) }), NOW)).toEqual({
      alert: false,
    });
    expect(judgeIdleRunning(row({ doing, updatedAt: at(SELF_CHECK_ACTIVITY_MS - 1_000) }), NOW)).toEqual({
      alert: false,
    });
  });

  it('过了自测活动限时还停在自测上：报，正文写明去看心跳的阶段和最后输出时刻', () => {
    const v = judgeIdleRunning(
      row({ doing, updatedAt: new Date(NOW.getTime() - SELF_CHECK_ACTIVITY_MS - 60_000) }),
      NOW,
    );
    expect(v.alert).toBe(true);
    if (!v.alert) return;
    expect(v.body).toContain('停在引擎自测上');
    expect(v.body).toContain('最后输出时刻');
    expect(v.body).not.toContain('换路由续之后');
  });

  it('别的进度照旧 20 分钟就报', () => {
    expect(judgeIdleRunning(row({ updatedAt: STALE }), NOW).alert).toBe(true);
  });
});

describe('judgeIdleRunning', () => {
  it('running、引擎、没有开着的会话、updated_at 过了 20 分钟：报，正文不写会变的分钟数', () => {
    const verdict = judgeIdleRunning(row(), NOW);
    expect(verdict.alert).toBe(true);
    if (!verdict.alert) return;
    expect(verdict.key).toBe(idleRunningAlertKey('task-2261'));
    expect(verdict.title).toContain('thoerwink8/fleet-dao#2261');
    expect(verdict.body).toContain('running');
    expect(verdict.body).toContain('没有 ended_at 为空的会话');
    expect(verdict.body).toContain('带上进度续一次');
    // 阈值「20 分钟」可以写死；按这一轮算出的「已经 N 分钟」每轮会变，不能写进正文。
    expect(verdict.body).not.toMatch(/已经 \d+ 分钟/);
  });

  it('正好 20 分钟也报；差一秒不报', () => {
    expect(judgeIdleRunning(row({ updatedAt: EXACT }), NOW).alert).toBe(true);
    expect(judgeIdleRunning(row({ updatedAt: FRESH }), NOW).alert).toBe(false);
  });

  it('updated_at 空（从没写过快照）也报', () => {
    expect(judgeIdleRunning(row({ updatedAt: null }), NOW).alert).toBe(true);
  });

  it('有开着的会话、本机领的、不是 running：不报', () => {
    expect(judgeIdleRunning(row({ openRuns: 1 }), NOW).alert).toBe(false);
    expect(judgeIdleRunning(row({ executor: 'local' }), NOW).alert).toBe(false);
    expect(judgeIdleRunning(row({ state: 'stalled' }), NOW).alert).toBe(false);
  });
});

describe('watchIdleRunning', () => {
  it('该报的报一条，条件没了撤掉；读不到不撤开着的', async () => {
    const raised: { dedupeKey: string; title: string; body: string; link: string }[] = [];
    const resolved: string[] = [];
    const open = new Map<string, { title: string; body: string }>();
    const alerts = {
      openByPrefix: async () => [...open.entries()].map(([dedupeKey, card]) => ({ dedupeKey, ...card })),
      raise: async (input: { dedupeKey: string; title: string; body: string; link: string }) => {
        raised.push(input);
        open.set(input.dedupeKey, { title: input.title, body: input.body });
      },
      resolve: async (input: { dedupeKey: string; why: string }) => {
        resolved.push(input.dedupeKey);
        open.delete(input.dedupeKey);
        return 'ok' as const;
      },
    };
    const first = await watchIdleRunning({ tasks: async () => [row()], alerts, log: () => {} }, NOW);
    expect(first).toMatchObject({ scanned: 1, found: 1, problems: [] });
    expect(raised).toHaveLength(1);
    expect(raised[0]?.dedupeKey).toBe(idleRunningAlertKey('task-2261'));
    expect(raised[0]?.link).toBe(IDLE_RUNNING_LINK);
    const again = await watchIdleRunning({ tasks: async () => [row()], alerts, log: () => {} }, NOW);
    expect(again.found).toBe(1);
    expect(raised).toHaveLength(1);
    const gone = await watchIdleRunning(
      { tasks: async () => [row({ openRuns: 1 })], alerts, log: () => {} },
      NOW,
    );
    expect(gone.found).toBe(0);
    expect(resolved).toEqual([idleRunningAlertKey('task-2261')]);
    const unread = await watchIdleRunning(
      {
        tasks: async () => {
          throw new Error('库不通');
        },
        alerts,
        log: () => {},
      },
      NOW,
    );
    expect(unread.problems[0]).toContain('库不通');
    expect(resolved).toHaveLength(1);
  });
});
