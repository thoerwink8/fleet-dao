import { describe, expect, it } from 'vitest';
import { POLL_CAP_MS, pollInterval, RECONNECT_CAP_MS, RECONNECT_FLOOR_MS, reconnectDelay } from './backoff';
import { mergeEvents } from './merge';
import { SseParser } from './sse-parse';
import type { FeedEvent } from './types';

const ev = (id: number): FeedEvent => ({
  id,
  seq: id,
  type: 'worker.progress.reported',
  payload: { n: id },
  createdAt: '2026-10-31T00:00:00.000Z',
});

describe('mergeEvents：不重、有序', () => {
  it('新来的比现有的新：直接接在后面', () => {
    expect(mergeEvents([ev(1), ev(2)], [ev(3), ev(4)]).map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });
  it('补发里夹着已有的：按事件号去重，顺序不乱', () => {
    expect(mergeEvents([ev(1), ev(2), ev(3)], [ev(2), ev(3), ev(4)]).map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });
  it('往上翻的旧页并进来排在前面', () => {
    expect(mergeEvents([ev(5), ev(6)], [ev(3), ev(4)]).map((e) => e.id)).toEqual([3, 4, 5, 6]);
  });
  it('同一批里自己重复也只留一条；空批原样返回', () => {
    expect(mergeEvents([ev(1)], [ev(2), ev(2), ev(3)]).map((e) => e.id)).toEqual([1, 2, 3]);
    const cur = [ev(1)];
    expect(mergeEvents(cur, [])).toBe(cur);
  });
});

describe('reconnectDelay：抖动退避，打散多标签页同时断线（G4）', () => {
  it('永远在 [下限, 上限] 里，上限按失败次数翻倍，封顶 30 秒', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const d = reconnectDelay(attempt, () => r);
        expect(d).toBeGreaterThanOrEqual(RECONNECT_FLOOR_MS);
        expect(d).toBeLessThanOrEqual(RECONNECT_CAP_MS);
      }
    }
    expect(reconnectDelay(1, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(reconnectDelay(3, () => 0.999)).toBeLessThanOrEqual(4000);
    expect(reconnectDelay(20, () => 0.999)).toBeGreaterThan(29_000);
  });
  it('20 个标签页同时第 3 次失败：等待时间摊开，不会挤在同一刻', () => {
    let seed = 7;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    const delays = Array.from({ length: 20 }, () => reconnectDelay(3, rng));
    const buckets = new Set(delays.map((d) => Math.floor(d / 250)));
    // 窗口 [250, 4000] 共 15 个 250ms 的格子：20 个随机点至少落进 5 个格子，且没有哪一格装了一半以上
    expect(buckets.size).toBeGreaterThanOrEqual(5);
    const worst = Math.max(
      ...[...buckets].map((b) => delays.filter((d) => Math.floor(d / 250) === b).length),
    );
    expect(worst).toBeLessThanOrEqual(10);
  });
});

describe('pollInterval：后端挂了轮询退避到 60 秒，成功恢复原间隔（E5）', () => {
  it('10 秒起，失败一次翻一倍，封顶 60 秒', () => {
    expect([0, 1, 2, 3, 4, 10].map((f) => pollInterval(10_000, f))).toEqual([
      10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
    ]);
    expect(pollInterval(10_000, 99)).toBe(POLL_CAP_MS);
  });
});

describe('SseParser', () => {
  it('跨块拼帧、忽略注释但算活着、多行 data 合并', () => {
    const p = new SseParser();
    const a = p.push('id: 7\nevent: worker.progress.reported\nda');
    expect(a.frames).toEqual([]);
    const b = p.push('ta: {"seq":1}\n\n: ping\n\nid: 8\nevent: resync\ndata: {}\n\n');
    expect(b.frames).toEqual([
      { id: '7', event: 'worker.progress.reported', data: '{"seq":1}' },
      { id: '8', event: 'resync', data: '{}' },
    ]);
    expect(p.push(': ping\n\n')).toEqual({ frames: [], alive: true });
    expect(new SseParser().push('data: a\ndata: b\n\n').frames[0]?.data).toBe('a\nb');
  });
});
