// 临时指挥官整理待办的操作记录（母单 #1335 第 3 片，#1338）：入口记点了、引擎记接手、整理完，读回只读 target=groom 的、since 之后的；
// 一次整理走到哪由 shared 的 foldGroomRequests 现算。用途 groom 能进路由两层（库里的 stage_kind 枚举有它）。
// 故意造出的失败：没成的回执不带原因，recordEngineAudit 先拒。
import { foldGroomRequests } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groomAuditRows,
  recordGroomDone,
  recordGroomRequest,
  recordGroomStart,
} from '../src/queries/groom.ts';
import { auditLog, routingPurposeModels } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { catalog } from './helpers.ts';

const NOW = new Date('2026-10-08T07:00:00.000Z');
const RESULT = {
  opened: [{ number: 901, title: '新单' }],
  amended: [3],
  groomed: [3],
  suggestedClose: [],
  flagged: [],
  rejected: [],
  summary: '开了一张',
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

describe('整理待办的操作记录', () => {
  it('点了、接手、整理完都读得回，现算出「做完了」，带结果；别的 target、since 之前的不读', async () => {
    await recordGroomRequest(t.db, {
      requestId: 'a',
      repo: 'acme/demo',
      source: 'cli',
      reason: '服务器上 root 跑的',
      at: new Date(NOW.getTime() - 120_000),
    });
    await recordGroomStart(t.db, {
      requestId: 'a',
      repo: 'acme/demo',
      at: new Date(NOW.getTime() - 100_000),
    });
    await recordGroomDone(t.db, {
      requestId: 'a',
      repo: 'acme/demo',
      at: new Date(NOW.getTime() - 10_000),
      ok: true,
      result: RESULT,
    });
    await t.db.insert(auditLog).values([
      {
        at: NOW,
        actorKind: 'user',
        actorId: 'founder',
        action: 'something.else',
        target: 'routing:probe',
        via: 'cockpit',
        ok: true,
      },
    ]);
    const rows = await groomAuditRows(t.db, new Date(NOW.getTime() - 3_600_000));
    expect(rows.map((r) => r.action).sort()).toEqual(['groom.done', 'groom.request', 'groom.start']);
    const { requests, unreadable } = foldGroomRequests(rows, NOW);
    expect(unreadable).toBe(0);
    expect(requests[0]).toMatchObject({ requestId: 'a', state: 'done', source: 'cli', result: RESULT });
    // since 之后才读
    expect(await groomAuditRows(t.db, new Date(NOW.getTime() - 5_000))).toEqual([]);
  });

  it('没整理成：记 ok=false 和原因，已经做了一部分的结果也带上；读回是「没做成」', async () => {
    await recordGroomRequest(t.db, {
      requestId: 'b',
      repo: 'acme/demo',
      source: 'auto',
      reason: '拉单一轮自己叫的',
      at: new Date(NOW.getTime() - 120_000),
    });
    await recordGroomStart(t.db, {
      requestId: 'b',
      repo: 'acme/demo',
      at: new Date(NOW.getTime() - 100_000),
    });
    await recordGroomDone(t.db, {
      requestId: 'b',
      repo: 'acme/demo',
      at: NOW,
      ok: false,
      error: '会话没跑成：选不到路由',
      result: RESULT,
    });
    const { requests } = foldGroomRequests(
      await groomAuditRows(t.db, new Date(NOW.getTime() - 3_600_000)),
      NOW,
    );
    expect(requests[0]).toMatchObject({ state: 'failed', why: '会话没跑成：选不到路由', result: RESULT });
  });

  it('【故意造出的失败】没成的回执不写原因：先拒，一行都不写', async () => {
    await expect(
      recordGroomDone(t.db, { requestId: 'c', repo: 'acme/demo', at: NOW, ok: false, error: '  ' }),
    ).rejects.toThrow(/没写为什么/);
    expect(await groomAuditRows(t.db, new Date(0))).toEqual([]);
  });
});

describe('用途 groom（迁移 0044 给库里的 stage_kind 枚举加了它）', () => {
  it('路由两层里 groom 用途的模型顺序写得进去、读得回', async () => {
    await catalog(t.db);
    await t.db.insert(routingPurposeModels).values([
      { purpose: 'groom', modelId: 'opus-4.9', position: 0 },
      { purpose: 'groom', modelId: 'claude-fable-5.2', position: 1 },
    ]);
    const rows = await t.db.select().from(routingPurposeModels).orderBy(routingPurposeModels.position);
    expect(rows.filter((r) => r.purpose === 'groom').map((r) => r.modelId)).toEqual([
      'opus-4.9',
      'claude-fable-5.2',
    ]);
  });
});
