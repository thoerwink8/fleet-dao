// 日报收口（jobs/daily-notes.ts）：简报收进去的、超过 48 小时还开着的，一轮里一起标已处理；alert、decision 不动。
import { alertByKey, notifications, resolveAlertWithReason } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DAILY_STALE_MS, settleDailyNotes } from '../src/jobs/daily-notes.ts';
import { RECONCILE_ACTOR } from '../src/jobs/reconcile-common.ts';

const DAY = 24 * 60 * 60_000;
const NOW = new Date('2026-10-15T00:30:00Z');

describe('settleDailyNotes', () => {
  it('刚好满 48 小时不收；简报自己那一行不按「已收进」收，超过 48 小时才按对账收；一条失败不挡别的', async () => {
    const calls: { dedupeKey: string; by: string; why: string }[] = [];
    const old = new Date(NOW.getTime() - 3 * DAY);
    const exact = new Date(NOW.getTime() - DAILY_STALE_MS);
    const r = await settleDailyNotes(
      async (input) => {
        if (input.dedupeKey === 'bad') throw new Error('库断了');
        calls.push(input);
        return input.dedupeKey === 'gone' ? 'already_resolved' : 'ok';
      },
      [
        { dedupeKey: 'release:start:exact:1', level: 'daily', updatedAt: exact },
        { dedupeKey: 'feishu:brief:2026-10-15', level: 'daily', updatedAt: NOW },
        { dedupeKey: 'feishu:brief:2026-10-12', level: 'daily', updatedAt: old },
        { dedupeKey: 'bad', level: 'daily', updatedAt: old },
        { dedupeKey: 'gone', level: 'daily', updatedAt: old },
        { dedupeKey: 'release:done:good:1', level: 'daily', updatedAt: old },
        { dedupeKey: 'task:stuck', level: 'alert', updatedAt: old },
      ],
      {
        now: NOW,
        includedDay: '2026-10-15',
        includedKeys: new Set(['feishu:brief:2026-10-15', 'feishu:brief:2026-10-12', 'task:stuck']),
      },
    );
    expect(calls.map((c) => c.dedupeKey)).toEqual(['feishu:brief:2026-10-12', 'gone', 'release:done:good:1']);
    expect(calls.find((c) => c.dedupeKey === 'feishu:brief:2026-10-12')).toMatchObject({
      by: RECONCILE_ACTOR,
      why: '超过 48 小时自动收',
    });
    expect(r.resolved).toEqual(['feishu:brief:2026-10-12', 'release:done:good:1']);
    expect(r.already).toEqual(['gone']);
    expect(r.failed).toEqual(['提醒 bad 没收成：库断了']);
  });
});

describe('一轮里同时收「已收进简报」和「超过 48 小时」', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(() => resetTestDb(t));

  it('已被简报收进的 release:done 和 3 天前的 release:start 都已处理；开着的 alert、decision 仍开着', async () => {
    const doneKey = 'release:done:abcdef123456:100';
    const startKey = 'release:start:abcdef123456:1';
    const alertKey = 'task:stuck:12';
    const decisionKey = 'someone:asks-human';
    const old = new Date(NOW.getTime() - 3 * DAY);
    await t.db.insert(notifications).values([
      {
        dedupeKey: doneKey,
        level: 'daily',
        title: '发版成功',
        body: '成功正文',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        dedupeKey: startKey,
        level: 'daily',
        title: '发版开始',
        body: '开始正文',
        createdAt: old,
        updatedAt: old,
      },
      {
        dedupeKey: alertKey,
        level: 'alert',
        title: '卡住了',
        body: '还在',
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        dedupeKey: decisionKey,
        level: 'decision',
        title: '等你拍',
        body: '还在',
        createdAt: old,
        updatedAt: old,
      },
    ]);
    const open = [doneKey, startKey, alertKey, decisionKey].map((dedupeKey) => {
      const daily = dedupeKey === doneKey || dedupeKey === startKey;
      return {
        dedupeKey,
        level: daily ? 'daily' : dedupeKey === alertKey ? 'alert' : 'decision',
        updatedAt: dedupeKey === startKey || dedupeKey === decisionKey ? old : NOW,
      };
    });
    const settled = await settleDailyNotes((input) => resolveAlertWithReason(t.db, input), open, {
      now: NOW,
      includedDay: '2026-10-15',
      includedKeys: new Set([doneKey, alertKey]),
    });
    expect(settled.failed).toEqual([]);
    expect(settled.resolved.sort()).toEqual([doneKey, startKey].sort());

    const done = await alertByKey(t.db, doneKey);
    expect(done?.resolvedAt).not.toBeNull();
    expect(done?.resolvedBy).toBe('engine:daily-brief');
    expect(done?.body.startsWith('已撤：已收进 2026-10-15 简报')).toBe(true);
    expect(done?.body).toContain('成功正文');

    const start = await alertByKey(t.db, startKey);
    expect(start?.resolvedAt).not.toBeNull();
    expect(start?.resolvedBy).toBe(RECONCILE_ACTOR);
    expect(start?.body.startsWith('已撤：超过 48 小时自动收')).toBe(true);
    expect(start?.body).toContain('开始正文');

    expect((await alertByKey(t.db, alertKey))?.resolvedAt).toBeNull();
    expect((await alertByKey(t.db, decisionKey))?.resolvedAt).toBeNull();
  });
});
