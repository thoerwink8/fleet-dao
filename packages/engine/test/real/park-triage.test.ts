// 法国指挥官会话的真装配（real/park-triage.ts，#3294 第 2 片）在库上的几样：设置开关怎么读、用途没配模型怎么认、
// 认领和执行的操作记录记在 engine:commander 名下、提醒带诊断文字、回合怎么读给空转判断。会话和 Temporal 不真连（另有 jobs 的假依赖测试）。
import { auditLog, notifications, repos, settings, taskRounds, tasks } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDER_ACTOR } from '../../src/commander-contract.ts';
import { judgeSpin } from '../../src/decisions/spin.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  type ParkTriageItem,
} from '../../src/jobs/park-triage.ts';
import { COMMANDER_SETTING, parkTriageJob } from '../../src/real/park-triage.ts';
import type { TaskParkInfo } from '../../src/task-contract.ts';

const NOW = new Date('2026-10-19T12:00:00Z');
const PARK: TaskParkInfo = {
  kind: 'quota',
  seq: 3,
  at: NOW.toISOString(),
  title: 'token 额度超预算',
  head: null,
  retriedBefore: false,
};

describe('real/park-triage', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(() => resetTestDb(t));

  const deps = () =>
    parkTriageJob({
      db: t.db,
      gh: {} as never,
      trees: {} as never,
      exec: {} as never,
      tmpDir: '/tmp/none',
      spawner: {} as never,
      pickRoute: (async () => ({ ok: false, detail: '测试里不选路' })) as never,
      sessions: {} as never,
      temporal: { use: async () => Promise.reject(new Error('测试里不连 Temporal')) },
      taskQueue: 'fleet',
      now: () => NOW,
      log: () => {},
    })();

  async function seedTask() {
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name: 'app', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('仓没写进去');
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 7,
        title: '给登录页加验证码',
        rawRequest: '加验证码',
        requestedBy: 'founder-a',
        priority: 10,
        state: 'stalled',
      })
      .returning();
    if (!task) throw new Error('任务没写进去');
    return task;
  }

  const itemOf = (taskId: string): ParkTriageItem => ({
    row: { taskId, owner: 'acme', name: 'app', issueNumber: 7, workflowId: 'task-acme-app-7' },
    workflowId: 'task-acme-app-7',
    park: PARK,
    handoff: false,
    detail: null,
    rounds: [],
    spin: null,
  });

  it('开关：没设过算开；false 关；认不出的值按关并说明', async () => {
    expect(await deps().enabled()).toEqual({ on: true });
    await t.db.insert(settings).values({ key: COMMANDER_SETTING, value: false });
    expect(await deps().enabled()).toMatchObject({ on: false });
    await t.db.delete(settings);
    await t.db.insert(settings).values({ key: COMMANDER_SETTING, value: true });
    expect(await deps().enabled()).toEqual({ on: true });
    await t.db.delete(settings);
    await t.db.insert(settings).values({ key: COMMANDER_SETTING, value: 'maybe' });
    const unknown = await deps().enabled();
    expect(unknown.on).toBe(false);
    expect(!unknown.on && unknown.why).toContain('认不出');
  });

  it('用途 commander 下一个模型都没有：认成没配模型', async () => {
    expect(await deps().purposeConfigured()).toBe(false);
  });

  it('认领和执行的操作记录都记在 engine:commander 名下；认领带工作流编号和停下编号', async () => {
    const task = await seedTask();
    const item = itemOf(task.id);
    const d = deps();
    await d.claim({
      row: item.row,
      workflowId: item.workflowId,
      park: PARK,
      requestId: 'park-triage:acme/app:1',
    });
    await d.audit({ item, action: 'continue', reason: '指挥官判继续（引擎核对放行）', ok: true });
    await d.audit({ item, action: 'redo', reason: '重做', ok: false, error: '上一代还在跑' });
    const rows = (await t.db.select().from(auditLog)).filter((r) => r.target === 'commander');
    expect(rows.map((r) => [r.action, r.actorId, r.actorKind, r.ok])).toEqual([
      [COMMANDER_AUDIT_CLAIM, COMMANDER_ACTOR, 'engine', true],
      [COMMANDER_AUDIT_ACT, COMMANDER_ACTOR, 'engine', true],
      [COMMANDER_AUDIT_ACT, COMMANDER_ACTOR, 'engine', false],
    ]);
    expect(rows[0]?.after).toMatchObject({ workflowId: 'task-acme-app-7', parkSeq: 3, kind: 'quota' });
    expect(rows[1]?.after).toMatchObject({ action: 'continue', parkSeq: 3 });
    // 认领读得回来（jobs 靠它判同一次停下处理过没有）
    const back = await d.audits(new Date(NOW.getTime() - 3_600_000));
    expect(back.filter((a) => a.action === COMMANDER_AUDIT_CLAIM)).toHaveLength(1);
  });

  it('提醒经 upsertAlert 落库：诊断文字在正文里，挂在这张任务上', async () => {
    const task = await seedTask();
    await deps().notify({
      level: 'alert',
      key: 'commander:task-acme-app-7:park:3',
      title: '指挥官看了 acme/app#7，留给人处理',
      body: '指挥官（grok-4.7）看了 acme/app#7。\n理由：同一个命令反复失败',
      taskId: task.id,
    });
    const [row] = await t.db.select().from(notifications);
    expect(row?.body).toContain('同一个命令反复失败');
    expect(row?.taskId).toBe(task.id);
  });

  it('回合读给空转判断：旧的在前，没有收场的回合回空数组', async () => {
    const task = await seedTask();
    expect(await deps().rounds(task.id)).toEqual([]);
    for (const [seq, outcome] of [
      [1, 'ci_red'],
      [2, 'ci_red'],
      [3, 'ci_red'],
    ] as const) {
      await t.db.insert(taskRounds).values({
        taskId: task.id,
        workflowId: 'task-acme-app-7',
        seq,
        round: seq,
        outcome,
        addedLines: 50,
        endedAt: new Date(NOW.getTime() + seq * 60_000),
      });
    }
    const rounds = await deps().rounds(task.id);
    expect(rounds).toHaveLength(3);
    expect(judgeSpin(rounds ?? []).spinning).toBe(true);
  });
});
