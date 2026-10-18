// 看门狗提醒键形状的回归。API 的真库贯通测试还会运行这些真实检测器，修改键和撤卡判据必须两头一起验证。
import { describe, expect, it } from 'vitest';
import { IDLE_RUNNING_ALERT_PREFIX, watchIdleRunning } from '../src/jobs/idle-running.ts';
import { judgeReleaseAttention } from '../src/jobs/release-watch.ts';

const NOW = new Date('2026-10-18T08:00:00.000Z');
const TASK = 'b0000000-0000-4000-8000-000000000012';
const SHA = `2005b290${'a'.repeat(32)}`;

describe('api 的受控修复依赖的键形状', () => {
  it('idle-running：键是 watchdog:idle-running:<任务编号>，标题带 owner/仓#单号；条件没了同一把键被撤', async () => {
    const raised: { dedupeKey: string; title: string; body: string }[] = [];
    const resolved: string[] = [];
    const open = new Map<string, { dedupeKey: string; title: string; body: string }>();
    const deps = (updatedAt: Date) => ({
      tasks: async () => [
        {
          taskId: TASK,
          owner: 'example',
          name: 'canary',
          issueNumber: 12,
          state: 'running',
          executor: 'engine',
          openRuns: 0,
          updatedAt,
          doing: '换路由续之后睡在等选路里',
        },
      ],
      alerts: {
        openByPrefix: async () => [...open.values()],
        raise: async (i: { dedupeKey: string; title: string; body: string; link: string }) => {
          raised.push(i);
          open.set(i.dedupeKey, i);
        },
        resolve: async (i: { dedupeKey: string; why: string }) => {
          resolved.push(i.dedupeKey);
          open.delete(i.dedupeKey);
          return 'ok' as const;
        },
      },
      log: () => undefined,
    });
    await watchIdleRunning(deps(new Date(NOW.getTime() - 60 * 60_000)), NOW);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.dedupeKey).toBe(`watchdog:idle-running:${TASK}`);
    expect(IDLE_RUNNING_ALERT_PREFIX).toBe('watchdog:idle-running:');
    expect(raised[0]?.title).toBe('在干活但没有开着的会话：example/canary#12');
    // 任务行更新了：同一把键被撤（api 的核验也是看任务行动没动）
    await watchIdleRunning(deps(new Date(NOW.getTime() - 60_000)), NOW);
    expect(resolved).toEqual([`watchdog:idle-running:${TASK}`]);
  });

  it('发版卡住：键是 watchdog:release:train:<提交前 12 位>:running', () => {
    const verdict = judgeReleaseAttention(
      {
        trainStatus: 'running',
        trainSince: new Date(NOW.getTime() - 120 * 60_000).toISOString(),
        trainSha: SHA,
      },
      NOW,
    );
    if (verdict.kind !== 'alert') throw new Error('检测器没报');
    expect(verdict.key).toBe(`watchdog:release:train:${SHA.slice(0, 12)}:running`);
    expect(verdict.key).toMatch(/^watchdog:release:train:([0-9a-f]{7,40}):(running|failed)$/);
    expect(verdict.title).toContain(SHA.slice(0, 12));
  });
});
