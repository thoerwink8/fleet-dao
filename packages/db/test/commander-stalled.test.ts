// 法国指挥官看门狗和 attention / 每日简报共用的停下任务清单（queries/commander.ts）：
// 指挥官自己留给人的提醒（commander:<工作流>:park:<第几次>）不是停点来源，已认领的停点照样算「指挥官处理」。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  commanderStalledSummary,
  commanderSummaryLine,
  listCommanderStalledTasks,
  readOpenParkAlert,
} from '../src/queries/commander.ts';
import { resolveAlertByKey, upsertAlert } from '../src/queries/engine-alerts.ts';
import { recordEngineAudit } from '../src/queries/session-org.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const park = (taskId: string, workflowId: string, seq: number) =>
  upsertAlert(t.db, {
    dedupeKey: `${workflowId}:park:${seq}`,
    level: 'alert',
    taskId,
    title: '任务停下',
    body: '停下了',
  });

const claim = (workflowId: string, parkSeq: number) =>
  recordEngineAudit(t.db, {
    action: 'commander.claim',
    target: 'commander',
    actorId: 'engine:park-triage',
    after: { workflowId, parkSeq },
    ok: true,
  });

describe('listCommanderStalledTasks', () => {
  it('指挥官认领后又写了留给人的提醒：这一停仍按工作流报的那条算，算指挥官看过', async () => {
    const repo = await addRepo(t.db);
    const claimed = await addTask(t.db, repo.id, { state: 'stalled', executor: 'engine' });
    const untouched = await addTask(t.db, repo.id, { state: 'stalled', executor: 'engine' });
    await park(claimed.id, 'wf-claimed', 2);
    await park(untouched.id, 'wf-untouched', 1);
    await claim('wf-claimed', 2);
    // park-triage 的 noticeKey：认领之后才写，raisedAt 比工作流那条新
    await park(claimed.id, 'commander:wf-claimed', 2);

    const rows = await listCommanderStalledTasks(t.db);
    expect(rows.map((r) => [r.taskId, r.workflowId, r.parkSeq, r.commanderSeen])).toEqual([
      [claimed.id, 'wf-claimed', 2, true],
      [untouched.id, 'wf-untouched', 1, false],
    ]);

    const summary = await commanderStalledSummary(t.db);
    expect(summary).toEqual({ stalled: 2, handled: 1, forHuman: 1 });
    expect(commanderSummaryLine(summary)).toBe('停下 2 张，指挥官处理 1 张，留给人 1 张');
  });

  it('认领之后会话没起成（commander.retry）：这一停不算指挥官看过；再认领一次才算', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { state: 'stalled', executor: 'engine' });
    await park(task.id, 'wf-retry', 1);
    await claim('wf-retry', 1);
    await recordEngineAudit(t.db, {
      action: 'commander.retry',
      target: 'commander',
      actorId: 'engine:commander',
      after: { workflowId: 'wf-retry', parkSeq: 1, attempt: 1 },
      ok: false,
      error: '选不到路由',
    });
    expect((await listCommanderStalledTasks(t.db)).map((r) => r.commanderSeen)).toEqual([false]);
    // 看门狗要写「为什么没人看」：最近一条没起成的第几次和原文
    expect((await listCommanderStalledTasks(t.db)).map((r) => r.retry)).toEqual([
      { attempt: 1, why: '选不到路由' },
    ]);
    await claim('wf-retry', 1);
    expect((await listCommanderStalledTasks(t.db)).map((r) => r.commanderSeen)).toEqual([true]);
  });
});

describe('readOpenParkAlert', () => {
  it('取这个工作流开着的、编号最大的停下提醒；别的工作流、指挥官那条、撤了的不算', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { state: 'stalled', executor: 'engine' });
    expect(await readOpenParkAlert(t.db, 'wf-a')).toBeNull();
    await park(task.id, 'wf-a', 1);
    await upsertAlert(t.db, {
      dedupeKey: 'wf-a:park:2',
      level: 'alert',
      taskId: task.id,
      title: '改动超出体量预算：新增 9550 行',
      body: '点「继续」照这一版推',
    });
    await park(task.id, 'wf-a-other', 9);
    await park(task.id, 'commander:wf-a', 5);
    const got = await readOpenParkAlert(t.db, 'wf-a');
    expect(got).toMatchObject({
      seq: 2,
      title: '改动超出体量预算：新增 9550 行',
      body: '点「继续」照这一版推',
    });
    expect(got?.at).toBeInstanceOf(Date);
    await resolveAlertByKey(t.db, { dedupeKey: 'wf-a:park:2', by: 'test' });
    expect((await readOpenParkAlert(t.db, 'wf-a'))?.seq).toBe(1);
  });
});
