import { describe, expect, it } from 'vitest';
import { HIDDEN_RELEASE_MS, releaseWhenHidden } from './visibility';

function setup(initial: 'visible' | 'hidden' = 'visible') {
  const calls: string[] = [];
  const feed = { start: () => calls.push('start'), stop: () => calls.push('stop') };
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as string,
    addEventListener: (_: 'visibilitychange', fn: () => void) => listeners.add(fn),
    removeEventListener: (_: 'visibilitychange', fn: () => void) => listeners.delete(fn),
  };
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => {
      pending.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...pending]) {
      if (t.at <= now) {
        pending.delete(id);
        t.fn();
      }
    }
  };
  const set = (v: 'visible' | 'hidden') => {
    doc.visibilityState = v;
    for (const fn of [...listeners]) fn();
  };
  return { calls, feed, doc, timers, advance, set, listeners };
}

describe('后台标签页释放实时流', () => {
  it('隐藏不满 10 秒不放；满 10 秒放掉；回到前台再连', () => {
    const s = setup();
    releaseWhenHidden(s.feed, s.doc, HIDDEN_RELEASE_MS, s.timers);
    s.set('hidden');
    s.advance(HIDDEN_RELEASE_MS - 1);
    expect(s.calls).toEqual([]);
    s.advance(1);
    expect(s.calls).toEqual(['stop']);
    s.set('visible');
    expect(s.calls).toEqual(['stop', 'start']);
  });

  it('不满 10 秒就回来：不放，也不重复 start 之外的动作', () => {
    const s = setup();
    releaseWhenHidden(s.feed, s.doc, HIDDEN_RELEASE_MS, s.timers);
    s.set('hidden');
    s.advance(5000);
    s.set('visible');
    s.advance(20_000);
    expect(s.calls).toEqual(['start']); // start 对在跑的流是空操作
  });

  it('来回切：每次隐藏都重新计 10 秒', () => {
    const s = setup();
    releaseWhenHidden(s.feed, s.doc, HIDDEN_RELEASE_MS, s.timers);
    s.set('hidden');
    s.advance(8000);
    s.set('visible');
    s.set('hidden');
    s.advance(8000);
    expect(s.calls).not.toContain('stop');
    s.advance(2000);
    expect(s.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });

  it('打开时就在后台：10 秒后放掉', () => {
    const s = setup('hidden');
    releaseWhenHidden(s.feed, s.doc, HIDDEN_RELEASE_MS, s.timers);
    s.advance(HIDDEN_RELEASE_MS);
    expect(s.calls).toEqual(['stop']);
  });

  it('解除绑定后不再响应，挂着的计时也取消', () => {
    const s = setup();
    const off = releaseWhenHidden(s.feed, s.doc, HIDDEN_RELEASE_MS, s.timers);
    s.set('hidden');
    off();
    s.advance(60_000);
    expect(s.calls).toEqual([]);
    expect(s.listeners.size).toBe(0);
  });
});
