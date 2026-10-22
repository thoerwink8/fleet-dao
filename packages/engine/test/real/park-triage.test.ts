// 法国指挥官会话的真装配（real/park-triage.ts，#3294 第 2 片）在库上的几样：设置开关怎么读、用途没配模型怎么认、
// 认领和执行的操作记录记在 engine:commander 名下、提醒带诊断文字、回合怎么读给空转判断。会话和 Temporal 不真连（另有 jobs 的假依赖测试）。
import {
  acceptanceDuties,
  auditLog,
  families,
  models,
  notifications,
  pullRequests,
  registerScheduledJobs,
  repos,
  routingPurposeModels,
  settings,
  taskRounds,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { noteOnlyOptions } from '@fleet-dao/shared';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDER_ACTOR } from '../../src/commander-contract.ts';
import { judgeSpin } from '../../src/decisions/spin.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  COMMANDER_AUDIT_RETRY,
  PARK_TRIAGE_JOB,
  PARK_TRIAGE_REDO_START_TRIES,
  PARK_TRIAGE_REDO_STOP_TRIES,
  type ParkTriageItem,
  runParkTriageJob,
  triageParkedTasks,
} from '../../src/jobs/park-triage.ts';
import { COMMANDER_SETTING, parkTriageJob } from '../../src/real/park-triage.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
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
  beforeEach(async () => {
    await resetTestDb(t);
    await registerScheduledJobs(t.db, [PARK_TRIAGE_JOB]);
  });

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

  it('重做前的诊断判据（#3602）：按库里这张任务的单子正文判；命中就留言并贴「本机做」，普通单不命中', async () => {
    const calls: string[] = [];
    const gh = {
      commentIssue: async (i: { issueNumber: number; key: string; body: string }) => {
        calls.push(`comment ${i.issueNumber} ${i.body.includes('核实原场景卡在哪个COMMIT')}`);
        return { commentId: 1, url: 'u', created: true };
      },
      addIssueLabel: async (i: { issueNumber: number; label: string }) => {
        calls.push(`label ${i.issueNumber} ${i.label}`);
        return [i.label];
      },
    };
    const wired = parkTriageJob({
      db: t.db,
      gh: gh as never,
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
    const hold = wired.offDiffHold;
    if (!hold) throw new Error('真装配要接上 offDiffHold');
    const task = await seedTask();
    const row = itemOf(task.id).row;
    // 单子正文还没有「怎么算做完」一节：判不了，不拦
    expect(await hold.check(row)).toBeNull();
    await t.db.update(tasks).set({
      rawRequest:
        '## 怎么算做完\n\n- diff与测试输出能核实原场景卡在哪个COMMIT/等待/收尾边界；新增失败诊断只记录合成数据、阶段与必要资源读数。\n',
    });
    const found = await hold.check(row);
    expect(found?.why).toContain('不续');
    if (!found) throw new Error('应当命中');
    await hold.handBack({ id: 'r', owner: 'acme', name: 'app' } as never, 7, found);
    expect(calls).toEqual(['comment 7 true', 'label 7 本机做']);
    await t.db
      .update(tasks)
      .set({ rawRequest: '## 怎么算做完\n\n- 新增 packages/engine/test/foo.test.ts，断言 bar 返回 3。\n' });
    expect(await hold.check(row)).toBeNull();
    await expect(hold.check({ ...row, taskId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(
      '库里没有任务',
    );
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

  it('commander:daily-cap：回到上限以下撤掉，没有这张卡时撤也不报错；执行记录带原文指纹', async () => {
    const d = deps();
    await d.resolveCapAlert();
    await d.notify({
      level: 'alert',
      key: 'commander:daily-cap',
      title: '到了上限',
      body: '等着的单……',
      taskId: null,
    });
    await d.resolveCapAlert();
    const card = (await t.db.select().from(notifications)).find((n) => n.dedupeKey === 'commander:daily-cap');
    expect(card).toMatchObject({ resolvedAt: NOW, resolvedBy: COMMANDER_ACTOR });
    const task = await seedTask();
    await d.audit({
      item: { ...itemOf(task.id), detailHash: 'abc123' },
      action: 'continue',
      reason: '测试',
      ok: true,
    });
    const act = (await t.db.select().from(auditLog)).find((a) => a.action === COMMANDER_AUDIT_ACT);
    expect(act?.after).toMatchObject({ ref: 'acme/app#7', detailHash: 'abc123' });
  });

  it('用途 commander 下一个模型都没有：认成没配模型', async () => {
    expect(await deps().purposeConfigured()).toBe(false);
  });

  async function configureModelWithoutRoute() {
    await t.db.insert(families).values({ id: 'test-family', displayName: '测试', vendor: 'test' });
    await t.db.insert(models).values({ id: 'test-model', family: 'test-family', displayName: '测试模型' });
    await t.db
      .insert(routingPurposeModels)
      .values({ purpose: 'commander', modelId: 'test-model', position: 0 });
  }

  it('任务入口空→非空→重复：只撤缺模型卡、保留原文，审计幂等；没有活路由也只证明配置恢复', async () => {
    const d = deps();
    expect((await runParkTriageJob(d)).outcome).toBe('partial');
    await d.notify({
      level: 'alert',
      key: 'commander:other',
      title: '其它故障',
      body: '原故障证据',
      taskId: null,
    });
    const before = await t.db.select().from(notifications);
    const oldCard = before.find((n) => n.dedupeKey === 'commander:no-model');
    expect(oldCard?.resolvedAt).toBeNull();
    await configureModelWithoutRoute();
    expect(await d.purposeConfigured()).toBe(true);
    expect((await runParkTriageJob(d)).outcome).toBe('ok');
    const once = await t.db.select().from(notifications);
    const resolved = once.find((n) => n.dedupeKey === 'commander:no-model');
    expect(resolved).toMatchObject({ id: oldCard?.id, resolvedAt: NOW, resolvedBy: COMMANDER_ACTOR });
    expect(resolved?.body).toContain(oldCard?.body ?? '旧正文丢失');
    expect(resolved?.body).toContain('调用是否恢复仍待验证');
    expect(once.find((n) => n.dedupeKey === 'commander:other')).toEqual(
      before.find((n) => n.dedupeKey === 'commander:other'),
    );
    expect((await runParkTriageJob(d)).outcome).toBe('ok');
    expect(await t.db.select().from(notifications)).toEqual(once);
    const audits = (await t.db.select().from(auditLog)).filter((a) => a.action === 'notification.resolve');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      target: `notification:${oldCard?.id}`,
      actorKind: 'engine',
      actorId: COMMANDER_ACTOR,
      at: NOW,
      reason: expect.stringContaining('调用是否恢复仍待验证'),
    });
  });

  it('用途已配但没有旧卡：不创建故障卡、不补造解除审计', async () => {
    await configureModelWithoutRoute();
    expect((await runParkTriageJob(deps())).outcome).toBe('ok');
    expect(await t.db.select().from(notifications)).toHaveLength(0);
    expect(
      (await t.db.select().from(auditLog)).filter((a) => a.action === 'notification.resolve'),
    ).toHaveLength(0);
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

  it('留给人·掏新钱写成「要你拍」：选项和原因一起落库；会话没起成记 commander.retry（ok=false）', async () => {
    const task = await seedTask();
    const d = deps();
    await d.notify({
      level: 'decision',
      key: 'commander:task-acme-app-7:park:3',
      title: '要你拍：acme/app#7',
      body: '要掏新钱',
      taskId: task.id,
      options: noteOnlyOptions(),
      reason: 'new-money',
    });
    const [card] = await t.db.select().from(notifications);
    expect(card).toMatchObject({ level: 'decision', decisionReason: 'new-money' });
    expect(card?.decisionOptions).toHaveLength(2);
    const item = itemOf(task.id);
    await d.retry({ row: item.row, workflowId: item.workflowId, park: PARK, attempt: 1, why: '选不到路由' });
    const rows = (await t.db.select().from(auditLog)).filter((r) => r.action === COMMANDER_AUDIT_RETRY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: COMMANDER_ACTOR, ok: false });
    expect(rows[0]?.after).toMatchObject({ workflowId: 'task-acme-app-7', parkSeq: 3, attempt: 1 });
  });

  it('老历史认停在哪一次：读开着的、编号最大的停下提醒', async () => {
    const task = await seedTask();
    await deps().notify({
      level: 'alert',
      key: 'task-acme-app-7:park:2',
      title: '动手 3 轮都没过',
      body: '原文',
      taskId: task.id,
    });
    expect(await deps().openPark('task-acme-app-7')).toMatchObject({ seq: 2, title: '动手 3 轮都没过' });
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

  it('验收结清和 supersede 复用受管 store 的精确身份与代次核验', async () => {
    const task = await seedTask();
    const sourceHead = 'a'.repeat(40);
    const finalHead = 'b'.repeat(40);
    const [source] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: task.id,
        repo: 'acme/app',
        issueNumber: 7,
        prNumber: 8,
        head: sourceHead,
        items: ['现场审计'],
        source: 'cold_verify',
        mergeCommit: null,
      })
      .returning();
    const [target] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: task.id,
        repo: 'acme/app',
        issueNumber: 7,
        prNumber: 8,
        head: finalHead,
        items: ['现场审计'],
        source: 'cold_verify',
        mergeCommit: 'c'.repeat(40),
        settledAt: new Date(NOW.getTime() - 1_000),
        settledBy: 'cold-verify',
        settleEvidence: '最终头已验收',
      })
      .returning();
    if (!source || !target) throw new Error('验收责任没写进去');
    const d = deps();
    await expect(
      d.settleAcceptance?.({ task: {} as never, duty: source, evidence: '未合并' }),
    ).rejects.toThrow();
    await d.supersedeAcceptance?.({
      task: {} as never,
      source,
      target,
      evidence: '最终头覆盖旧头',
      coverage: [{ source: '现场审计', target: '现场审计', basis: '同一条责任' }],
    });
    const rows = await t.db.select().from(acceptanceDuties);
    expect(rows.find((row) => row.id === source.id)).toMatchObject({
      supersededBy: COMMANDER_ACTOR,
      successorId: target.id,
    });
  });

  // —— #3497：验收机读/执行失败走真装配（候选查询、认领/重试记账、提醒、结清口子），不变成人工批准 ——
  describe('验收责任：机读或执行失败不变成人工批准（#3497）', () => {
    const OLD_HEAD = 'c'.repeat(40);
    const HEAD = 'a'.repeat(40);
    const MERGE = 'b'.repeat(40);
    const fence = (verdicts: unknown[]) =>
      `\`\`\`json\n${JSON.stringify({ summary: '核过', acceptanceVerdicts: verdicts })}\n\`\`\``;
    const verdictOf = (duty: { id: number; head: string }, extra: Record<string, unknown>) => ({
      issue: 7,
      dutyId: duty.id,
      generation: 1,
      prNumber: 8,
      head: duty.head,
      reason: '逐条核对后的结论',
      ...extra,
    });

    /** 复现 #3438：当前头责任已结清，旧头责任没有合并回执仍 open。 */
    async function seedOldHeadOpen(opts: { alsoOpenCurrent?: boolean } = {}) {
      const task = await seedTask();
      await t.db.insert(pullRequests).values({
        repoId: task.repoId,
        number: 8,
        state: 'merged',
        headRef: 'feat',
        headSha: HEAD,
        updatedAt: NOW,
        mergedAt: new Date(NOW.getTime() - 60 * 60_000),
        mergeSha: MERGE,
      });
      const base = { taskId: task.id, repo: 'acme/app', issueNumber: 7, prNumber: 8, source: 'cold_verify' };
      const [oldDuty] = await t.db
        .insert(acceptanceDuties)
        .values({ ...base, head: OLD_HEAD, items: ['现场审计'], mergeCommit: null })
        .returning();
      const [currentDuty] = await t.db
        .insert(acceptanceDuties)
        .values({
          ...base,
          head: HEAD,
          items: ['现场审计'],
          mergeCommit: MERGE,
          ...(opts.alsoOpenCurrent
            ? {}
            : {
                settledAt: new Date(NOW.getTime() - 5 * 60_000),
                settledBy: 'commander',
                settleEvidence: '已验',
              }),
        })
        .returning();
      if (!oldDuty || !currentDuty) throw new Error('验收责任没写进去');
      return { task, oldDuty, currentDuty };
    }

    const liveAcceptance = (
      answer: string,
      sessions: { n: number },
      pull?: { number: number; merged: boolean; headSha: string },
    ) => {
      const base = parkTriageJob({
        db: t.db,
        gh: {
          readIssueState: async () => ({ state: 'open' }),
          claims: { readPull: async () => pull ?? Promise.reject(new Error('测试里没读到 PR')) },
        } as never,
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
      return {
        ...base,
        purposeConfigured: async () => true,
        mainHead: async () => 'f'.repeat(40),
        tasks: async () => [],
        runSession: async () => {
          sessions.n += 1;
          return { ok: true as const, answer, model: 'test-model' };
        },
      };
    };
    const noticeOf = async (taskId: string) =>
      (await t.db.select().from(notifications)).find(
        (n) => n.dedupeKey === `commander:${taskId}:acceptance:8`,
      );
    const retryRows = async () =>
      (await t.db.select().from(auditLog)).filter((a) => a.action === COMMANDER_AUDIT_RETRY);
    const dutyOf = async (id: number) =>
      (await t.db.select().from(acceptanceDuties)).find((d) => d.id === id);

    it('旧头没有合并回执、模型要 settle：不是「要你拍」，责任保持 open，记核验没成的重试，下一轮同一 head 再处理', async () => {
      const { task, oldDuty } = await seedOldHeadOpen();
      const sessions = { n: 0 };
      const d = liveAcceptance(
        fence([verdictOf(oldDuty, { action: 'settle', evidence: '最终头已验收' })]),
        sessions,
      );
      const first = await triageParkedTasks(d);
      expect(first).toMatchObject({ claimed: 1, left: [] });
      expect(first.retrying).toEqual([
        { ref: 'acme/app#7', why: expect.stringContaining('PR 没有合并回执') },
      ]);
      const notice = await noticeOf(task.id);
      expect(notice).toMatchObject({ level: 'alert', decisionReason: null, decisionOptions: null });
      expect(notice?.title).not.toContain('要你拍');
      expect(notice?.body).not.toContain('仍留给创始人的证据');
      expect(notice?.body).toContain('PR 没有合并回执');
      expect((await dutyOf(oldDuty.id))?.settledAt).toBeNull();
      const retries = await retryRows();
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ ok: false, actorId: COMMANDER_ACTOR });
      expect(retries[0]?.error).toContain('PR 没有合并回执');
      expect(retries[0]?.after).toMatchObject({ kind: 'acceptance', cause: 'unverified', attempt: 1 });
      // 下一轮：同一 head 又进候选、又起一次会话（重试抵销了认领）
      const second = await triageParkedTasks(d);
      expect(second.candidates).toBe(1);
      expect(sessions.n).toBe(2);
      // 第 3 次（预算用满）：仍记账，提醒如实写已试满
      await triageParkedTasks(d);
      expect(sessions.n).toBe(3);
      expect(await retryRows()).toHaveLength(3);
      expect((await noticeOf(task.id))?.body).toContain('已试满');
      // 之后每一轮：不再起会话，但未核实责任带着真实原因（来自持久审计账）仍每轮报出来
      for (let i = 0; i < 2; i++) {
        const after = await triageParkedTasks(d);
        expect(after.candidates).toBe(0);
        expect(sessions.n).toBe(3);
        expect(after.problems).toEqual([expect.stringContaining('PR 没有合并回执')]);
        expect(after.problems[0]).toContain('验收责任仍未核实');
      }
      expect(await retryRows()).toHaveLength(3);
      expect((await dutyOf(oldDuty.id))?.settledAt).toBeNull();
      expect((await noticeOf(task.id))?.level).toBe('alert');
    });

    it('停写之后（#3591）：合并收尾、在途重试照样交来转人验收条，库里不落新行，指挥官没有候选、不起会话、不出「要你拍」；旧行照旧进候选', async () => {
      const task = await seedTask();
      await t.db.insert(pullRequests).values({
        repoId: task.repoId,
        number: 8,
        state: 'merged',
        headRef: 'feat',
        headSha: HEAD,
        updatedAt: NOW,
        mergedAt: new Date(NOW.getTime() - 60 * 60_000),
        mergeSha: MERGE,
      });
      // 真端口：工作流收尾（和老历史在途重试带着 record）调的就是它
      const store = createStorePorts({
        db: t.db,
        now: () => NOW,
        draw: () => 0.5,
        log: () => {},
        sessionOrg: async () => ({ ok: true, org: 'carpool' }),
      });
      const read = await store.acceptanceDuties(
        {
          taskId: task.id,
          repo: {
            id: task.repoId,
            owner: 'acme',
            name: 'app',
            defaultBranch: 'main',
            testCommand: 'pnpm check',
          },
          issueNumber: 7,
          record: [{ prNumber: 8, head: HEAD, items: ['现场审计'], mergeCommit: MERGE }],
        },
        { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, lastHeartbeat: undefined },
      );
      expect(read.open).toEqual([]);
      expect(await t.db.select().from(acceptanceDuties)).toEqual([]);
      const sessions = { n: 0 };
      const d = liveAcceptance(fence([]), sessions);
      const none = await triageParkedTasks(d);
      expect(none.candidates).toBe(0);
      expect(none.claimed).toBe(0);
      expect(sessions.n).toBe(0);
      expect((await t.db.select().from(notifications)).filter((n) => n.level === 'decision')).toEqual([]);
      expect(await noticeOf(task.id)).toBeUndefined();
      // 对照：#3037 时期留下的旧行（不动它们）照旧进候选——上面的 0 不是读法坏了
      await t.db.insert(acceptanceDuties).values({
        taskId: task.id,
        repo: 'acme/app',
        issueNumber: 7,
        prNumber: 8,
        source: 'cold_verify',
        head: HEAD,
        items: ['现场审计'],
        mergeCommit: MERGE,
      });
      const old = await triageParkedTasks(d);
      expect(old.candidates).toBe(1);
    });

    it('只有引擎可信来源证明的创始人证据才发「要你拍」，不记重试、不重复起会话', async () => {
      const { task, oldDuty } = await seedOldHeadOpen();
      const sessions = { n: 0 };
      const d = {
        ...liveAcceptance(
          fence([verdictOf(oldDuty, { action: 'leave', humanOnly: '模型自述的缺口' })]),
          sessions,
        ),
        acceptanceFounderFacts: async () => [
          {
            dutyId: oldDuty.id,
            generation: oldDuty.generation,
            prNumber: oldDuty.prNumber,
            head: oldDuty.head,
            kind: 'founder-decision' as const,
            what: '线下合同签章确认',
          },
        ],
      };
      const out = await triageParkedTasks(d);
      expect(out.left).toHaveLength(1);
      expect(await noticeOf(task.id)).toMatchObject({ level: 'decision', decisionReason: 'human-only' });
      expect((await noticeOf(task.id))?.body).toContain('线下合同签章确认');
      expect((await noticeOf(task.id))?.body).not.toContain('模型自述的缺口');
      expect(await retryRows()).toHaveLength(0);
      // 真实操作记录里有这条转人的 commander.act（workflowId 是认领键）：之后每轮是「有结论」，不重复起会话也不重复报
      const leaveActs = (await t.db.select().from(auditLog)).filter(
        (a) => a.action === COMMANDER_AUDIT_ACT && (a.after as { action?: string }).action === 'leave',
      );
      expect(leaveActs).toHaveLength(1);
      expect(leaveActs[0]?.after).toMatchObject({
        workflowId: `acceptance:${task.id}:8:${HEAD}`,
        parkSeq: 0,
        dutyId: oldDuty.id,
      });
      const again = await triageParkedTasks(d);
      expect(again.candidates).toBe(0);
      expect(again.problems).toEqual([]);
      expect(sessions.n).toBe(1);
      expect((await dutyOf(oldDuty.id))?.settledAt).toBeNull();
    });

    it('真装配没有创始人证据来源：模型自称受限读不到证据、甚至自加 founder-only，都只留机读缺口并重试，不转人', async () => {
      const { task, oldDuty } = await seedOldHeadOpen();
      expect(deps().acceptanceFounderFacts).toBeUndefined();
      const d = liveAcceptance(
        fence([
          verdictOf(oldDuty, {
            action: 'leave',
            leaveKind: 'founder-only',
            humanOnly: '受限会话不能访问 Temporal/journal，请人帮忙',
          }),
        ]),
        { n: 0 },
      );
      const out = await triageParkedTasks(d);
      expect(out.left).toEqual([]);
      expect(out.retrying).toHaveLength(1);
      const notice = await noticeOf(task.id);
      expect(notice).toMatchObject({ level: 'alert', decisionReason: null, decisionOptions: null });
      expect(notice?.body).toContain('没有可信事实证明只有创始人能提供');
      expect(notice?.body).toContain('模型自述（引擎未证实）');
      expect(await retryRows()).toHaveLength(1);
    });

    it('部分结清、部分核验没成：只结清已核的那条（真实 CAS），失败那条保持 open 重试，不关单也不要你拍', async () => {
      const { task, oldDuty, currentDuty } = await seedOldHeadOpen({ alsoOpenCurrent: true });
      const d = liveAcceptance(
        fence([
          verdictOf(currentDuty, { action: 'settle', evidence: '现场日志与合并回执相符' }),
          verdictOf(oldDuty, { action: 'settle', evidence: '同上' }),
        ]),
        { n: 0 },
      );
      // 真装配的读方暂时分不出义务来源（见下一条）；这里换成确定的可信读证，只测真实 CAS 结清
      d.acceptanceTrustedRead = async (_task, duty) => ({
        dutyId: duty.id,
        generation: duty.generation,
        prNumber: duty.prNumber,
        head: duty.head,
        mergedHead: duty.head,
        items: duty.items.map((item) => ({ item, need: 'platform' as const, got: 'platform' as const })),
      });
      const out = await triageParkedTasks(d);
      expect(out.acted).toEqual([
        { ref: `acme/app#7/duty-${currentDuty.id}`, action: 'continue', source: 'verdict' },
      ]);
      expect(out.left).toEqual([]);
      expect(out.retrying).toEqual([
        { ref: 'acme/app#7', why: expect.stringContaining(`duty ${oldDuty.id}`) },
      ]);
      expect(await dutyOf(currentDuty.id)).toMatchObject({ settledBy: COMMANDER_ACTOR });
      expect((await dutyOf(oldDuty.id))?.settledAt).toBeNull();
      const notice = await noticeOf(task.id);
      expect(notice).toMatchObject({ level: 'alert', decisionReason: null });
      expect(notice?.body).toMatch(new RegExp(`duty ${currentDuty.id}[^\\n]*已按裁决收口`));
      expect(notice?.body).toMatch(new RegExp(`duty ${oldDuty.id}[^\\n]*仍未收口`));
      expect(out.problems).toEqual([]);
    });

    it('真装配的读证：现读 GitHub 得到实际已合的头，但义务来源分不出，所以不结清（#3579）', async () => {
      const { task, currentDuty } = await seedOldHeadOpen({ alsoOpenCurrent: true });
      const answer = fence([
        verdictOf(currentDuty, { action: 'settle', evidence: '责任行 mergeCommit 与 CI 全绿' }),
      ]);
      const d = liveAcceptance(answer, { n: 0 }, { number: 8, merged: true, headSha: HEAD });
      const read = await d.acceptanceTrustedRead?.(
        { owner: 'acme', name: 'app' } as never,
        currentDuty as never,
      );
      expect(read).toMatchObject({ dutyId: currentDuty.id, head: HEAD, mergedHead: HEAD });
      expect(read?.items).toEqual([{ item: '现场审计', need: 'unknown', got: 'unknown' }]);
      // PR 没合：mergedHead 为 null
      const open = liveAcceptance(answer, { n: 0 }, { number: 8, merged: false, headSha: HEAD });
      expect(
        (await open.acceptanceTrustedRead?.({ owner: 'acme', name: 'app' } as never, currentDuty as never))
          ?.mergedHead,
      ).toBeNull();
      const out = await triageParkedTasks(d);
      expect(out.acted).toEqual([]);
      expect((await dutyOf(currentDuty.id))?.settledAt).toBeNull();
      expect(out.retrying).toEqual([{ ref: 'acme/app#7', why: expect.stringContaining('读方分不出') }]);
      expect((await noticeOf(task.id))?.level).toBe('alert');
      // GitHub 读不到：同样不结清
      const broken = liveAcceptance(answer, { n: 0 });
      expect((await triageParkedTasks(broken)).retrying).toEqual([
        { ref: 'acme/app#7', why: expect.stringContaining('可信读证读取失败') },
      ]);
    });

    it('主线头读不到：认领被抵销、下一轮再看，不静默吞掉', async () => {
      const { oldDuty } = await seedOldHeadOpen();
      const d = liveAcceptance(fence([verdictOf(oldDuty, { action: 'settle', evidence: 'x' })]), { n: 0 });
      d.mainHead = async () => {
        throw new Error('GitHub 暂时不可用');
      };
      const first = await triageParkedTasks(d);
      expect(first.retrying).toHaveLength(1);
      expect((await retryRows())[0]?.after).toMatchObject({ cause: 'session' });
      d.mainHead = async () => 'f'.repeat(40);
      expect((await triageParkedTasks(d)).candidates).toBe(1);
    });
  });

  // —— #3496：重做在叫停等待超时后保留迟到终态的受管接续 ——
  // 假 Temporal + 假时钟（sleep 只推进虚拟时间），库、审计、提醒走真实现有存储；入口是真的 parkTriageJob + triageParkedTasks。
  const WF1 = 'task:acme/app#7';
  const WF2 = 'task:acme/app#7:r2';
  const T0 = Date.parse('2026-10-21T11:28:00Z');
  const REDO_ANSWER = [
    '```json',
    JSON.stringify({
      summary: '看完了',
      verdicts: [{ issue: 7, parkSeq: 3, action: 'redo', reason: '换路由重来' }],
    }),
    '```',
  ].join('\n');

  function world() {
    const w = {
      nowMs: T0,
      runs: new Map<string, { runId: string; status: string; phase: string }>(),
      signals: [] as string[],
      starts: [] as string[],
      describeFault: undefined as ((id: string) => Error | undefined) | undefined,
      startFault: undefined as ((id: string, n: number) => 'lost' | 'fail' | undefined) | undefined,
      onSignal: undefined as ((id: string) => void) | undefined,
      timers: [] as { at: number; fn: () => void }[],
      at(delayMs: number, fn: () => void) {
        w.timers.push({ at: w.nowMs + delayMs, fn });
      },
      advance(ms: number) {
        w.nowMs += ms;
        const due = w.timers.filter((x) => x.at <= w.nowMs).sort((a, b) => a.at - b.at);
        w.timers = w.timers.filter((x) => x.at > w.nowMs);
        for (const x of due) x.fn();
      },
      finish(id: string, status = 'COMPLETED') {
        const run = w.runs.get(id);
        if (run) run.status = status;
      },
    };
    const handle = (id: string) => ({
      describe: async () => {
        const fault = w.describeFault?.(id);
        if (fault) throw fault;
        const run = w.runs.get(id);
        if (!run) throw new WorkflowNotFoundError('没有这条执行', id, undefined);
        return { status: { name: run.status }, runId: run.runId };
      },
      query: async () => {
        const run = w.runs.get(id);
        if (!run) throw new WorkflowNotFoundError('没有这条执行', id, undefined);
        return {
          phase: run.phase,
          prNumber: 3300,
          park: {
            kind: 'rounds',
            seq: 3,
            at: new Date(T0 - 30 * 60_000).toISOString(),
            title: '轮数用尽',
            head: null,
            retriedBefore: false,
          },
        };
      },
      signal: async () => {
        w.signals.push(id);
        w.onSignal?.(id);
      },
    });
    const client = {
      connection: { withDeadline: async (_ms: number, fn: () => Promise<unknown>) => fn() },
      workflow: {
        getHandle: handle,
        start: async (_type: string, opts: { workflowId: string }) => {
          w.starts.push(opts.workflowId);
          if (w.runs.has(opts.workflowId))
            throw new WorkflowExecutionAlreadyStartedError('已经有了', opts.workflowId, 'taskWorkflow');
          const fault = w.startFault?.(opts.workflowId, w.starts.length);
          if (fault === 'fail') throw new Error('start 被拒绝');
          w.runs.set(opts.workflowId, {
            runId: `run-${w.runs.size + 1}`,
            status: 'RUNNING',
            phase: 'running',
          });
          if (fault === 'lost') throw new Error('DEADLINE_EXCEEDED：start 的响应丢了');
          return {};
        },
      },
    };
    return { w, client };
  }

  /** 真装配 + 假 Temporal/假时钟；会话、选路这类和本单无关的口子换成固定值。 */
  function live(world_: ReturnType<typeof world>, taskId: string, state: { stalled: boolean }) {
    const base = parkTriageJob({
      db: t.db,
      gh: {} as never,
      trees: {} as never,
      exec: {} as never,
      tmpDir: '/tmp/none',
      spawner: {} as never,
      pickRoute: (async () => ({ ok: false, detail: '测试里不选路' })) as never,
      sessions: {} as never,
      temporal: { use: (fn) => fn(world_.client as never) },
      taskQueue: 'fleet',
      clock: { nowMs: () => world_.w.nowMs, sleep: async (ms) => world_.w.advance(ms) },
      now: () => new Date(world_.w.nowMs),
      log: () => {},
    })();
    return {
      ...base,
      purposeConfigured: async () => true,
      mainHead: async () => 'f'.repeat(40),
      runSession: async () => ({ ok: true as const, answer: REDO_ANSWER, model: 'test-model' }),
      tasks: async () =>
        state.stalled ? [{ taskId, owner: 'acme', name: 'app', issueNumber: 7, workflowId: WF1 }] : [],
    };
  }

  async function seedRedoRig() {
    const task = await seedTask();
    const fake = world();
    fake.w.runs.set(WF1, { runId: 'run-1', status: 'RUNNING', phase: 'parked' });
    const state = { stalled: true };
    return { task, fake, state, d: live(fake, task.id, state) };
  }
  const ledgerPhases = async () =>
    (await t.db.select().from(auditLog))
      .filter((a) => a.action === 'commander.redo')
      .map((a) => (a.after as { phase: string }).phase);
  const parkNotice = async () =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === `commander:${WF1}:park:3`);

  it('叫停等待窗内旧代没停、稍后才结束：下一轮标准调度沿原裁决接续，只起一个新代（重复调度不再起）', async () => {
    const { fake, state, d } = await seedRedoRig();
    fake.w.onSignal = (id) => fake.w.at(90_000, () => fake.w.finish(id));
    const first = await triageParkedTasks(d);
    expect(first.left).toHaveLength(1);
    expect(fake.w.signals).toEqual([WF1]);
    expect(fake.w.starts).toEqual([]);
    // 迟到的终态：任务行也已被放弃，不再出现在停着的候选里（线上 #3258 的样子）
    fake.w.advance(60_000);
    expect(fake.w.runs.get(WF1)?.status).toBe('COMPLETED');
    state.stalled = false;
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([WF2]);
    await triageParkedTasks(d);
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([WF2]);
    expect(fake.w.signals).toEqual([WF1]);
  });

  it('叫停后读旧代状态失败不能当成已终止：旧代仍在跑就不起新代', async () => {
    const { fake, d } = await seedRedoRig();
    fake.w.describeFault = () => (fake.w.signals.length > 0 ? new Error('Temporal 暂时不可用') : undefined);
    const out = await triageParkedTasks(d);
    expect(fake.w.runs.get(WF1)?.status).toBe('RUNNING');
    expect(fake.w.starts).toEqual([]);
    expect(out.acted).toEqual([]);
  });

  it('叫停已发出但终态没确认时，回执不写「任务没动」，并写明三种阶段里的哪一种', async () => {
    const { fake, d } = await seedRedoRig();
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1]);
    const notice = await parkNotice();
    expect(notice?.body).not.toContain('任务没动');
    expect(notice?.body).toContain('叫停请求已发送');
    expect(notice?.body).toContain('终态');
    expect(notice?.body).toContain('叫停 task:acme/app#7 后还没停');
  });

  it('旧代仍在跑时接续每一轮都不起新代、补发叫停有界；等它结束后才起一个', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    for (let i = 0; i < 4; i++) await triageParkedTasks(d);
    expect(fake.w.signals).toHaveLength(PARK_TRIAGE_REDO_STOP_TRIES);
    expect(fake.w.starts).toEqual([]);
    fake.w.finish(WF1);
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([WF2]);
    const body = (await parkNotice())?.body ?? '';
    expect(body).toContain('已确认启动');
    expect(body).toContain('叫停 task:acme/app#7 后还没停');
  });

  it('接续时读旧代状态失败：拒绝，不凭任务行 stopped 放行', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.finish(WF1);
    fake.w.describeFault = () => new Error('Temporal 暂时不可用');
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    fake.w.describeFault = undefined;
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([WF2]);
  });

  it('旧代身份变化（run 对不上）：不起新代，记 given-up 交人看，之后不再重试', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    const run = fake.w.runs.get(WF1);
    if (run) {
      run.status = 'COMPLETED';
      run.runId = 'run-other';
    }
    await triageParkedTasks(d);
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    const rows = (await t.db.select().from(auditLog)).filter((a) => a.action === 'commander.redo');
    expect(rows.map((r) => (r.after as { phase: string }).phase)).toEqual([
      'stop-requested',
      'stop-unconfirmed',
      'given-up',
    ]);
    expect((await parkNotice())?.body).toContain('run 身份变了');
  });

  it('起新代的响应丢了但服务端已创建：回执写启动未确认，下一轮发现新代已存在，不再起第二个', async () => {
    const { fake, state, d } = await seedRedoRig();
    fake.w.onSignal = (id) => fake.w.finish(id);
    fake.w.startFault = () => 'lost';
    const first = await triageParkedTasks(d);
    expect(first.left).toHaveLength(1);
    expect(fake.w.starts).toEqual([WF2]);
    expect((await parkNotice())?.body).toContain('新代待启动或启动没得到确认');
    state.stalled = false;
    await triageParkedTasks(d);
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([WF2]);
    expect(fake.w.runs.size).toBe(2);
    expect((await parkNotice())?.body).toContain('已经存在');
  });

  it('起新代被拒：接续最多再试到总次数，试满后不再起、交人', async () => {
    const { fake, state, d } = await seedRedoRig();
    fake.w.onSignal = (id) => fake.w.finish(id);
    fake.w.startFault = () => 'fail';
    await triageParkedTasks(d);
    state.stalled = false;
    for (let i = 0; i < 6; i++) await triageParkedTasks(d);
    expect(fake.w.starts).toHaveLength(PARK_TRIAGE_REDO_START_TRIES);
    expect(fake.w.runs.has(WF2)).toBe(false);
    expect((await parkNotice())?.title).toContain('不再接续');
  });

  it('接续账写不进：不发叫停，回执如实写没动手', async () => {
    const { fake, d } = await seedRedoRig();
    const broken = {
      ...d,
      redoJournal: async () => {
        throw new Error('库连不上');
      },
    };
    await triageParkedTasks(broken);
    expect(fake.w.signals).toEqual([]);
    expect((await parkNotice())?.body).toContain('任务没动');
  });

  it('叫停已发出后进程中断（只有 stop-requested）：重启后的调度凭账接续一次', async () => {
    const { task, fake, state, d } = await seedRedoRig();
    state.stalled = false;
    fake.w.finish(WF1);
    await d.redoJournal({
      row: { taskId: task.id, owner: 'acme', name: 'app', issueNumber: 7, workflowId: WF1 },
      workflowId: WF1,
      parkSeq: 3,
      rec: {
        phase: 'stop-requested',
        trail: { fromGeneration: 1, runs: [{ workflowId: WF1, runId: 'run-1' }] },
      },
    });
    await Promise.all([triageParkedTasks(d), triageParkedTasks(d)]);
    await triageParkedTasks(d);
    expect(fake.w.runs.has(WF2)).toBe(true);
    expect(fake.w.runs.size).toBe(2);
  });

  // —— 根独验退回（#3521 review）的五条边界 ——
  it('读不到旧代 run 身份：任何副作用之前就拒绝，不发叫停', async () => {
    const { fake, d } = await seedRedoRig();
    const run = fake.w.runs.get(WF1);
    if (run) run.runId = undefined as never;
    fake.w.onSignal = (id) => fake.w.finish(id);
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([]);
    expect(fake.w.starts).toEqual([]);
    expect(await ledgerPhases()).toEqual([]);
    expect((await parkNotice())?.body).toContain('任务没动');
  });

  it('新代已存在但旧代仍在跑：不报接续完成，也不重起/覆盖新代', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.runs.set(WF2, { runId: 'new-run', status: 'RUNNING', phase: 'running' });
    const result = await triageParkedTasks(d);
    expect(fake.w.runs.get(WF1)?.status).toBe('RUNNING');
    expect(result.acted).toEqual([]);
    expect(fake.w.starts).toEqual([]);
    expect((await parkNotice())?.title).not.toContain('接续完成');
    // 旧代读不到同样不能报完成
    fake.w.describeFault = (id) => (id === WF1 ? new Error('读不到') : undefined);
    expect((await triageParkedTasks(d)).acted).toEqual([]);
  });

  it('起新代的响应丢了、25 小时后仍读不到：未知责任持久保留并报没查成，不写 given-up、不宣称新代不存在', async () => {
    const { fake, state, d } = await seedRedoRig();
    fake.w.onSignal = (id) => fake.w.finish(id);
    fake.w.startFault = () => 'lost';
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.advance(25 * 3_600_000);
    fake.w.describeFault = () => new Error('unreachable');
    const first = await triageParkedTasks(d);
    const second = await triageParkedTasks(d);
    expect(await ledgerPhases()).not.toContain('given-up');
    expect(await ledgerPhases()).toContain('unverified');
    expect((await parkNotice())?.body).not.toContain('没有在跑的新代');
    expect((await parkNotice())?.body).toContain('没查成');
    // 每一轮都继续报未核实，不因过了时间就算结清
    expect(first.problems.join('\n')).toContain('未核实');
    expect(second.problems.join('\n')).toContain('未核实');
    expect(fake.w.starts).toEqual([WF2]);
    // 读得到之后：新代存在 → 收口为 exists
    fake.w.describeFault = undefined;
    await triageParkedTasks(d);
    expect(await ledgerPhases()).toContain('exists');
    expect(fake.w.starts).toEqual([WF2]);
  });

  it('旧代停止后任务转给本机：接续拒绝，不再 Start', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.finish(WF1);
    await t.db.update(tasks).set({ executor: 'local' });
    const out = await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    expect(out.left.map((x) => x.why).join('\n')).toContain('不属于引擎');
    expect((await parkNotice())?.body).toContain('不属于引擎');
    expect(await ledgerPhases()).toContain('given-up');
  });

  it('任务行读不到或和账对不上：不 Start，保持待接续', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.finish(WF1);
    await t.db.update(tasks).set({ issueNumber: 99 });
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
  });

  it('同键后来一条坏的 start-requested（trail 空）：阻断该意图并报 problems，不沿旧 trail 继续 Start', async () => {
    const { task, fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.finish(WF1);
    await d.redoJournal({
      row: { taskId: task.id, owner: 'acme', name: 'app', issueNumber: 7, workflowId: WF1 },
      workflowId: WF1,
      parkSeq: 3,
      rec: {
        phase: 'start-requested',
        trail: { fromGeneration: 1, runs: [] },
        newWorkflowId: WF2,
        generation: 2,
      },
    });
    const out = await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    expect(out.problems.join('\n')).toContain('阻断');
    const again = await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    expect(again.problems.join('\n')).toContain('阻断');
  });

  // —— 第 2 轮根独验退回：两处接续缺口 ——
  it('起新代响应丢了、新代已把任务行改成 running：接续只读确认同一新代已存在，不 Start', async () => {
    const { fake, state, d } = await seedRedoRig();
    fake.w.onSignal = (id) => fake.w.finish(id);
    fake.w.startFault = () => 'lost';
    await triageParkedTasks(d);
    state.stalled = false;
    await t.db.update(tasks).set({ state: 'running' });
    const result = await triageParkedTasks(d);
    expect(result.acted).toHaveLength(1);
    expect(fake.w.starts).toEqual([WF2]);
    expect((await parkNotice())?.title).toContain('接续完成');
    expect(await ledgerPhases()).toContain('exists');
  });

  it('任务行不是停着/已放弃（running）而新代并不存在：只读核对不能变成 Start 或叫停，记 given-up', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.finish(WF1);
    await t.db.update(tasks).set({ state: 'running' });
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    expect(await ledgerPhases()).toContain('given-up');
  });

  it('叫停请求记账后、发信号前进程崩溃：接续在同一授权意图内补发已核 run 的叫停，旧代结束后只起一个新代', async () => {
    const { task, fake, state, d } = await seedRedoRig();
    state.stalled = false;
    fake.w.onSignal = (id) => fake.w.finish(id);
    await d.redoJournal({
      row: { taskId: task.id, owner: 'acme', name: 'app', issueNumber: 7, workflowId: WF1 },
      workflowId: WF1,
      parkSeq: 3,
      rec: {
        phase: 'stop-requested',
        trail: { fromGeneration: 1, runs: [{ workflowId: WF1, runId: 'run-1' }] },
      },
    });
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1]);
    expect(fake.w.starts).toEqual([WF2]);
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1]);
    expect(fake.w.starts).toEqual([WF2]);
    expect(await ledgerPhases()).toEqual(['stop-requested', 'stop-requested', 'start-requested', 'started']);
  });

  it('补发叫停有界：叫停一直不生效时，总共只发 PARK_TRIAGE_REDO_STOP_TRIES 次，不起新代', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    for (let i = 0; i < 6; i++) await triageParkedTasks(d);
    expect(fake.w.signals).toHaveLength(PARK_TRIAGE_REDO_STOP_TRIES);
    expect(fake.w.starts).toEqual([]);
  });

  it.each(['running', 'abandoned'])(
    '补发叫停只对真正停着的旧代：旧代姿态是 %s 时不再发信号也不 Start',
    async (phase) => {
      const { fake, state, d } = await seedRedoRig();
      await triageParkedTasks(d);
      state.stalled = false;
      const run = fake.w.runs.get(WF1);
      if (run) run.phase = phase;
      await triageParkedTasks(d);
      expect(fake.w.signals).toEqual([WF1]);
      expect(fake.w.starts).toEqual([]);
    },
  );

  it('旧代还停着时任务转给本机：接续不补发叫停、不 Start', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    await t.db.update(tasks).set({ executor: 'local' });
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1]);
    expect(fake.w.starts).toEqual([]);
  });

  it('旧代还停着时 run 身份变了：接续不补发叫停、不 Start', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    const run = fake.w.runs.get(WF1);
    if (run) run.runId = 'run-other';
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1]);
    expect(fake.w.starts).toEqual([]);
  });

  it('多个旧代都停着时，首次叫停先对全部旧代发出请求，接续只读不再补叫停', async () => {
    const { fake, state, d } = await seedRedoRig();
    const WF1B = 'task:acme/app#7:r2';
    fake.w.runs.set(WF1B, { runId: 'run-2', status: 'RUNNING', phase: 'parked' });
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1, WF1B]);
    state.stalled = false;
    for (const id of [WF1, WF1B]) fake.w.finish(id);
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1, WF1B]);
    expect(fake.w.starts).toEqual(['task:acme/app#7:r3']);
  });

  it.each(['running', 'unreadable'])(
    '补发前任何旧代姿态为 %s：整批拒绝，不对其它旧代补发叫停',
    async (posture) => {
      const { fake, state, d } = await seedRedoRig();
      fake.w.runs.set(WF2, { runId: 'run-2', status: 'RUNNING', phase: 'parked' });
      await triageParkedTasks(d);
      state.stalled = false;
      const handle = fake.client.workflow.getHandle;
      fake.client.workflow.getHandle = (id) => {
        const old = handle(id);
        return {
          ...old,
          query: async () => {
            if (id === WF1) {
              if (posture === 'unreadable') throw new Error('posture unavailable');
              return { ...(await old.query()), phase: 'running' };
            }
            return old.query();
          },
        };
      };
      await triageParkedTasks(d);
      expect(fake.w.signals).toEqual([WF1, WF2]);
      expect(fake.w.starts).toEqual([]);
    },
  );

  it('接续查询旧代姿态期间任务转本机：补发信号前重读归属并拒绝', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    const handle = fake.client.workflow.getHandle;
    fake.client.workflow.getHandle = (id) => {
      const old = handle(id);
      return {
        ...old,
        query: async () => {
          await t.db.update(tasks).set({ executor: 'local' });
          return old.query();
        },
      };
    };
    await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([WF1]);
    expect(fake.w.starts).toEqual([]);
  });

  // 第 3 轮：所有耗时的远端读、写账之后，真正 signal/Start 前必须重读归属，不复用查询前读到的结果
  it('首次重做：查姿态期间任务转本机，发叫停前重读归属并拒绝，回执写任务没动', async () => {
    const { fake, d } = await seedRedoRig();
    const handle = fake.client.workflow.getHandle;
    fake.client.workflow.getHandle = (id) => {
      const old = handle(id);
      return {
        ...old,
        query: async () => {
          const answer = await old.query();
          await t.db.update(tasks).set({ executor: 'local' });
          return answer;
        },
      };
    };
    fake.w.onSignal = (id) => fake.w.finish(id);
    const out = await triageParkedTasks(d);
    expect(fake.w.signals).toEqual([]);
    expect(fake.w.starts).toEqual([]);
    expect(out.acted).toEqual([]);
    expect(await ledgerPhases()).not.toContain('started');
  });

  it('接续：读旧代代次期间任务转本机，起新代前重读归属并拒绝，账收口成 given-up', async () => {
    const { fake, state, d } = await seedRedoRig();
    await triageParkedTasks(d);
    state.stalled = false;
    fake.w.finish(WF1);
    const handle = fake.client.workflow.getHandle;
    fake.client.workflow.getHandle = (id) => {
      const old = handle(id);
      return {
        ...old,
        describe: async () => {
          const answer = await old.describe();
          if (id === WF1) await t.db.update(tasks).set({ executor: 'local' });
          return answer;
        },
      };
    };
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    expect(await ledgerPhases()).not.toContain('started');
  });

  it('首次重做：旧代已终止、第二次读代次期间任务转本机，起新代前重读归属并拒绝', async () => {
    const { fake, d } = await seedRedoRig();
    let reads = 0;
    const handle = fake.client.workflow.getHandle;
    fake.client.workflow.getHandle = (id) => {
      const old = handle(id);
      return {
        ...old,
        describe: async () => {
          const answer = await old.describe();
          if (id === WF1 && ++reads === 2) await t.db.update(tasks).set({ executor: 'local' });
          return answer;
        },
      };
    };
    const wf1 = fake.w.runs.get(WF1);
    if (!wf1) throw new Error('测试装配缺旧代');
    wf1.status = 'COMPLETED';
    await triageParkedTasks(d);
    expect(fake.w.starts).toEqual([]);
    expect(await ledgerPhases()).not.toContain('started');
  });
});
