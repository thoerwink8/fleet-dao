// 账号池要人动手的毛病怎么从提醒里读出来（#1748）。
import { describe, expect, test } from 'vitest';
import type { Notification } from '../api/types';
import { actionOf, poolProblemsOf, problemLine } from './pool-problems';

const note = (over: Partial<Notification> & Pick<Notification, 'dedupeKey' | 'body'>): Notification => ({
  id: over.dedupeKey ?? 'n',
  level: 'alert',
  title: 't',
  createdAt: '2026-10-10T08:00:00Z',
  deliveries: [],
  ...over,
});

const grokBody =
  'supergrok（grok-billing）这一轮没读成：auth——Grok 的登录令牌已过期：读取器不自己续期。这种要人动手（补凭据、重新登录、改配置），不会自己好。旧读数留着、没改。';

describe('poolProblemsOf', () => {
  test('额度读不到：取引擎写的错误码和原话，要人做什么写明 grok login', () => {
    const p = poolProblemsOf([note({ dedupeKey: 'quota-read:supergrok', body: grokBody })]).get('supergrok');
    expect(p).toMatchObject({ kind: 'unreadable', code: 'auth' });
    expect(p?.reason).toContain('登录令牌已过期');
    expect(p?.action).toBe('在引擎所在的机器（法国）以会话用户重新 grok login');
    expect(problemLine(p as NonNullable<typeof p>)).toContain('要人做：');
  });

  test('读数过期的提醒也认；两种都有时记「读不到」（更根本）', () => {
    const stale = note({ dedupeKey: 'reconcile:quota:p1', body: 'x' });
    expect(poolProblemsOf([stale]).get('p1')?.kind).toBe('stale');
    const both = poolProblemsOf([
      stale,
      note({ dedupeKey: 'quota-read:p1', body: 'p1（r）这一轮没读成：config——写错了。这种要人动手' }),
    ]);
    expect(both.get('p1')?.kind).toBe('unreadable');
  });

  test('撤了的、整份配置的、别的提醒不算；读不出原因就用整段正文，不编', () => {
    const out = poolProblemsOf([
      note({ dedupeKey: 'quota-read:a', body: 'b', resolvedAt: '2026-10-10T09:00:00Z' }),
      note({ dedupeKey: 'quota-read:config', body: 'b' }),
      note({ dedupeKey: 'stalled:task1', body: 'b' }),
      note({ dedupeKey: 'quota-read:odd', body: '一段认不出格式的话' }),
    ]);
    expect([...out.keys()]).toEqual(['odd']);
    expect(out.get('odd')?.reason).toBe('一段认不出格式的话');
    expect(out.get('odd')?.action).toBe('看提醒里的原话再定');
  });

  test('没读成（undefined）给空表，调用方另写「没读成」', () => {
    expect(poolProblemsOf(undefined).size).toBe(0);
  });
});

describe('actionOf', () => {
  test('按错误码说要人做什么', () => {
    expect(actionOf('config', '')).toContain('额度配置');
    expect(actionOf('auth', '要在这台机器上重新 cursor-agent login')).toContain('cursor-agent login');
    expect(actionOf('unreachable', '')).toContain('网络');
  });
});
