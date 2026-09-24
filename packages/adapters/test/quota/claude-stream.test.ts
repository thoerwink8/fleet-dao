// 被动读：插头解析出的 rate_limit_event → 窗口读数。用插头自己的 ClaudeStreamReader 喂真帧形状，两边的约定一起钉住。
import { describe, expect, it } from 'vitest';
import { ClaudeStreamReader } from '../../src/claude-code/stream.ts';
import { readingsFromRateLimit } from '../../src/quota/index.ts';
import type { RateLimitReading } from '../../src/types.ts';

const NOW = new Date('2026-09-24T19:00:00.000Z');

function parse(info: Record<string, unknown>): RateLimitReading {
  const reader = new ClaudeStreamReader({ runId: 'run-1', cwd: '/tmp/work', now: () => NOW });
  const effect = reader.read(
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' }),
  );
  if (!effect.rateLimit) throw new Error('插头没认出 rate_limit_event');
  return effect.rateLimit;
}

describe('被动读：真会话里的 rate_limit_event → 每窗一行', () => {
  it('几个窗口在同一条事件里：各记一行，状态字只挂到正卡着的那个窗口，没见过的窗口归 other', () => {
    const out = readingsFromRateLimit(
      parse({
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        unifiedWindows: {
          five_hour: { utilization: 0.1, resetsAt: 1790294400 },
          seven_day: { utilization: 0.83, resetsAt: 1790452800 },
          seven_day_overage_included: { utilization: 0.2, resetsAt: 1790452800 },
        },
      }),
      { poolId: 'claude-solo' },
    );
    expect(out).toMatchObject([
      { label: 'five_hour', window: '5h', used: 10, limit: 100, resetsAt: '2026-09-25T00:00:00.000Z' },
      { label: 'seven_day', window: '7d', used: 83, upstreamStatus: 'warning', statusRaw: 'allowed_warning' },
      { label: 'seven_day_overage_included', window: 'other' },
    ]);
    expect(out[0]?.upstreamStatus).toBeUndefined();
    expect(out.every((r) => r.readAt === NOW.toISOString() && r.source === 'claude-stream')).toBe(true);
  });

  it('用满那一刻只有 {status:"rejected"}、没有利用率：记 5h 已用满，刷新点按「约 N 分钟后重置」推，不记成没查成', () => {
    const out = readingsFromRateLimit(parse({ status: 'rejected', isUsingOverage: false }), {
      poolId: 'claude-carpool',
      errorText: 'API Error: 拼车 5 小时额度已用完，约 20 分钟后重置',
    });
    expect(out).toEqual([
      expect.objectContaining({
        label: 'five_hour',
        window: '5h',
        upstreamStatus: 'limit_reached',
        resetsAt: '2026-09-24T19:20:00.000Z',
      }),
    ]);
  });

  it('上游说了卡在哪个窗口、何时恢复：照它记，不看报错正文', () => {
    const out = readingsFromRateLimit(
      parse({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1790452800 }),
      { poolId: 'claude-solo', errorText: '5 小时额度已用完，约 20 分钟后重置' },
    );
    expect(out).toEqual([
      expect.objectContaining({
        label: 'seven_day_opus',
        window: '7d_model',
        scope: 'opus',
        upstreamStatus: 'limit_reached',
        resetsAt: '2026-09-26T20:00:00.000Z',
      }),
    ]);
  });
});
