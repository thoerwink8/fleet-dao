import { beforeAll, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { AuditEntry, Routing } from '../api/types';
import { describeChange } from './policy';

let routing: Routing;
beforeAll(async () => {
  routing = await createMockApi({ live: false }).routing();
});

function entry(before: unknown, after: unknown): AuditEntry {
  return {
    id: 'a',
    at: '2026-09-25T10:00:00Z',
    actor: { kind: 'ai', id: 'marshal', name: 'AI 帅位' },
    action: 'stage_policy.update',
    target: 'stage:execute',
    before,
    after,
    via: 'engine',
    ok: true,
  };
}

describe('调度台「最近改动」的白话', () => {
  test('挪顺序：说清把哪条（模型 + 账号池）从第几挪到第几', () => {
    const c = describeChange(
      routing,
      entry(
        { routeIds: ['r-ca-opus', 'r-rl-kimi', 'r-cursor', 'r-ds'], pinned: false },
        { routeIds: ['r-ca-opus', 'r-cursor', 'r-ds', 'r-rl-kimi'], pinned: false },
      ),
    );
    expect(c.summary).toBe('「写码」：把 Kimi k3（relay）从第 2 挪到第 4');
    expect(c.after?.routeIds).toEqual(['r-ca-opus', 'r-cursor', 'r-ds', 'r-rl-kimi']);
  });

  test('两条对调就说对调', () => {
    const c = describeChange(
      routing,
      entry(
        { routeIds: ['r-ca-opus', 'r-rl-kimi', 'r-cursor'], pinned: false },
        { routeIds: ['r-ca-opus', 'r-cursor', 'r-rl-kimi'], pinned: false },
      ),
    );
    expect(c.summary).toBe('「写码」：Cursor Auto（cursor-pro）和 Kimi k3（relay）对调了位置');
  });

  test('加、去、钉住都写出来', () => {
    const c = describeChange(
      routing,
      entry(
        { routeIds: ['r-ca-opus', 'r-rl-kimi'], pinned: false },
        { routeIds: ['r-ca-opus', 'r-cursor'], pinned: true },
      ),
    );
    expect(c.summary).toBe('「写码」：钉住了，加上 Cursor Auto（cursor-pro），去掉 Kimi k3（relay）');
  });

  test('记录里没有前后对比：照实说，不给撤回的依据', () => {
    const c = describeChange(routing, entry(undefined, { routeIds: [], pinned: false }));
    expect(c.summary).toBe('改了「写码」（记录里没有前后对比）');
    expect(c.before).toBeUndefined();
  });
});
