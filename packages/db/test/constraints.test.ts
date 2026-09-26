// 库自己挡住的错：每条对应一个旧系统踩过的坑。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asks,
  auditLog,
  jevAnswers,
  jevQuestions,
  notificationDeliveries,
  notifications,
  pools,
  progressEvents,
  pullRequests,
  quotaWindows,
  routes,
  scheduledJobs,
  scheduleRuns,
  sessionRuns,
  settings,
  stateChanges,
  subtaskDeps,
  subtasks,
  tasks,
  users,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import {
  addRepo,
  addRoute,
  addRun,
  addSubtask,
  addTask,
  ago,
  catalog,
  expectViolation,
  HOUR,
  MIN,
  NOW,
} from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
});

describe('路由与账号池', () => {
  it('路由挂的账号池必须属于路由写的渠道', async () => {
    await expectViolation(
      t.db.insert(routes).values({
        id: 'wrong',
        channelId: 'claude-subscription',
        poolId: 'relay-a',
        modelId: 'opus-5.5',
        hostId: 'claude-code',
      }),
      'routes_pool_in_channel_fk',
    );
  });

  it('同一模型换一种执行方式是另一条路由；同池同模型同执行方式不许重复', async () => {
    await addRoute(t.db, { id: 'k3-pi', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' });
    await addRoute(t.db, { id: 'k3-api', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'api-shell' });
    await expectViolation(
      addRoute(t.db, { id: 'k3-pi-again', poolId: 'relay-a', modelId: 'kimi-k3', hostId: 'mirasim' }),
      'routes_pool_model_host_unique',
    );
  });

  it('并发上限没有「不限」：必须是正数', async () => {
    await expectViolation(
      t.db.insert(pools).values({ id: 'p0', channelId: 'relay', maxConcurrency: 0 }),
      'pools_max_concurrency_positive',
    );
  });

  it('新路由没探过就不在线', async () => {
    await t.db.insert(routes).values({
      id: 'fresh',
      channelId: 'relay',
      poolId: 'relay-a',
      modelId: 'opus-5.5',
      hostId: 'claude-code',
    });
    const [row] = await t.db.select().from(routes).where(eq(routes.id, 'fresh'));
    expect(row?.alive).toBe(false);
    expect(row?.probeState).toBeNull();
  });

  describe('路由探针的结论（#129）', () => {
    const fresh = {
      id: 'fresh',
      channelId: 'relay',
      poolId: 'relay-a',
      modelId: 'opus-5.5',
      hostId: 'claude-code' as const,
    };

    it('不许拿默认值、手改冒充在线：没有探针的 ok 结论，alive 写不成真', async () => {
      await expectViolation(
        t.db.insert(routes).values({ ...fresh, alive: true }),
        'routes_alive_needs_probe_ok',
      );
      await t.db.insert(routes).values(fresh);
      await expectViolation(
        t.db.update(routes).set({ alive: true }).where(eq(routes.id, 'fresh')),
        'routes_alive_needs_probe_ok',
      );
      // 探针说没探通，也不能在线
      await expectViolation(
        t.db
          .update(routes)
          .set({ alive: true, probeState: 'failed', probedAt: NOW, probeDetail: '登录失效' })
          .where(eq(routes.id, 'fresh')),
        'routes_alive_needs_probe_ok',
      );
    });

    it('结论和时刻同空同有', async () => {
      await expectViolation(
        t.db.insert(routes).values({ ...fresh, probeState: 'ok' }),
        'routes_probe_state_at_together',
      );
      await expectViolation(
        t.db.insert(routes).values({ ...fresh, probedAt: NOW }),
        'routes_probe_state_at_together',
      );
    });

    it('不在线、没探的都要写原因（没写、写空串都拒）', async () => {
      for (const state of ['failed', 'not_wired', 'skipped'] as const) {
        await expectViolation(
          t.db.insert(routes).values({ ...fresh, probeState: state, probedAt: NOW }),
          'routes_probe_not_ok_has_detail',
        );
        await expectViolation(
          t.db.insert(routes).values({ ...fresh, probeState: state, probedAt: NOW, probeDetail: '' }),
          'routes_probe_not_ok_has_detail',
        );
      }
      // ok 可以不带原因；在线要连 ok 一起写
      await t.db.insert(routes).values({ ...fresh, alive: true, probeState: 'ok', probedAt: NOW });
    });
  });
});

describe('额度窗', () => {
  const base = {
    poolId: 'relay-a',
    reading: 'measured',
    readAt: NOW,
    unit: 'percent',
    source: 'test',
  } as const;

  it('7d_model 必须写组名；别的窗口也可以只扣一组模型（Cursor 的 auto / api 桶）', async () => {
    await expectViolation(
      t.db.insert(quotaWindows).values({ ...base, label: '7d_x', window: '7d_model' }),
      'quota_windows_model_scope',
    );
    await t.db.insert(quotaWindows).values([
      { ...base, label: 'auto_percent', window: 'other', scope: 'auto' },
      { ...base, label: 'api_percent', window: 'other', scope: 'api' },
      { ...base, label: 'plan_usd', window: 'month_usd', unit: 'usd' },
    ]);
  });

  it('同一池里按上游原名一行：同类窗口可以有好几个，原名重复不行', async () => {
    for (const scope of ['claude', 'fable', 'brand-new-group']) {
      await t.db.insert(quotaWindows).values({ ...base, label: `7d_${scope}`, window: '7d_model', scope });
    }
    await t.db.insert(quotaWindows).values([
      { ...base, label: 'weekly_all', window: 'other' },
      { ...base, label: 'on_demand', window: 'other' },
    ]);
    const rows = await t.db.select().from(quotaWindows).where(eq(quotaWindows.poolId, 'relay-a'));
    expect(rows.map((r) => r.label).sort()).toEqual([
      '7d_brand-new-group',
      '7d_claude',
      '7d_fable',
      'on_demand',
      'weekly_all',
    ]);
    await expectViolation(
      t.db.insert(quotaWindows).values({ ...base, label: 'weekly_all', window: '7d' }),
      'quota_windows_pool_id_label_pk',
    );
  });

  it('原名、读法不许是空串', async () => {
    await expectViolation(
      t.db.insert(quotaWindows).values({ ...base, label: '', window: '5h' }),
      'quota_windows_label_nonempty',
    );
    await expectViolation(
      t.db.insert(quotaWindows).values({ ...base, label: '5h', window: '5h', source: '' }),
      'quota_windows_source_nonempty',
    );
  });

  it('池的成员表每一项是 {in: [模型 id…]} 或 {notIn: [模型 id…]}', async () => {
    const members = { auto: { in: ['composer-2.5'] }, api: { notIn: ['composer-2.5'] }, spare: { in: [] } };
    await t.db.update(pools).set({ scopeModels: members }).where(eq(pools.id, 'relay-a'));
    const [row] = await t.db.select().from(pools).where(eq(pools.id, 'relay-a'));
    expect(row?.scopeModels).toEqual(members);
  });

  it.each([
    '["auto"]',
    '{"auto": ["x"]}',
    '{"auto": {}}',
    '{"auto": {"only": ["x"]}}',
    '{"auto": {"in": "composer-2.5"}}',
    '{"auto": {"in": ["x"], "notIn": ["y"]}}',
    '{"auto": {"in": [1]}}',
    '{"auto": {"notIn": ["x", null]}}',
  ])('形状不对的成员表写不进去：%s', async (bad) => {
    await expectViolation(
      t.client.query(`update pools set scope_models = $1::jsonb where id = 'relay-a'`, [bad]),
      'pools_scope_models_shape',
    );
  });
});

describe('子任务依赖', () => {
  it('只能依赖同一个需求里的子任务', async () => {
    const repo = await addRepo(t.db);
    const a = await addTask(t.db, repo.id);
    const b = await addTask(t.db, repo.id);
    const sa = await addSubtask(t.db, a.id);
    const sb = await addSubtask(t.db, b.id);
    await expectViolation(
      t.db.insert(subtaskDeps).values({ taskId: a.id, subtaskId: sa.id, dependsOnId: sb.id }),
      'subtask_deps_depends_on_fk',
    );
  });

  it('不能依赖自己，也不能依赖不存在的子任务', async () => {
    const repo = await addRepo(t.db);
    const a = await addTask(t.db, repo.id);
    const sa = await addSubtask(t.db, a.id);
    await expectViolation(
      t.db.insert(subtaskDeps).values({ taskId: a.id, subtaskId: sa.id, dependsOnId: sa.id }),
      'subtask_deps_not_self',
    );
    await expectViolation(
      t.db
        .insert(subtaskDeps)
        .values({ taskId: a.id, subtaskId: sa.id, dependsOnId: '00000000-0000-4000-8000-000000000000' }),
      'subtask_deps_depends_on_fk',
    );
  });
});

describe('会话记录', () => {
  let taskId: string;
  beforeEach(async () => {
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db);
    taskId = (await addTask(t.db, repo.id)).id;
  });

  it('排队时间和干活时间分开算，由库算', async () => {
    const run = await addRun(t.db, {
      taskId,
      routeId: 'r1',
      queuedAt: ago(30 * MIN),
      startedAt: ago(25 * MIN),
      endedAt: ago(5 * MIN),
      outcome: 'ok',
    });
    expect(run.queueMs).toBe(5 * MIN);
    expect(run.runMs).toBe(20 * MIN);
  });

  it('排队时就被叫停：排队时长算到结束，干活时长为空', async () => {
    const run = await addRun(t.db, {
      taskId,
      routeId: 'r1',
      queuedAt: ago(30 * MIN),
      endedAt: ago(10 * MIN),
      outcome: 'stopped',
    });
    expect(run.queueMs).toBe(20 * MIN);
    expect(run.runMs).toBeNull();
  });

  it('时长列不许手写', async () => {
    await expectViolation(
      t.client.query(
        `insert into session_runs (task_id, stage, route_id, why_route, queue_ms) values ($1, 'execute', 'r1', 'x', 5)`,
        [taskId],
      ),
      'cannot insert a non-DEFAULT value into column "queue_ms"',
    );
  });

  it('结束了就必须有结局，有结局就必须已结束', async () => {
    await expectViolation(
      addRun(t.db, { taskId, routeId: 'r1', endedAt: NOW }),
      'session_runs_outcome_iff_ended',
    );
    await expectViolation(
      addRun(t.db, { taskId, routeId: 'r1', outcome: 'ok' }),
      'session_runs_outcome_iff_ended',
    );
  });

  it('开工不能早于排队', async () => {
    await expectViolation(
      addRun(t.db, { taskId, routeId: 'r1', queuedAt: ago(MIN), startedAt: ago(2 * MIN) }),
      'session_runs_started_after_queued',
    );
  });

  it('子任务必须属于会话写的那个需求', async () => {
    const repo = await addRepo(t.db);
    const other = await addTask(t.db, repo.id);
    const foreign = await addSubtask(t.db, other.id);
    await expectViolation(
      addRun(t.db, { taskId, subtaskId: foreign.id, routeId: 'r1' }),
      'session_runs_subtask_in_task_fk',
    );
  });

  it('帅位、考新模型的会话可以不属于任何需求；但写了子任务就必须写需求', async () => {
    const marshal = await addRun(t.db, {
      taskId: null,
      stage: 'research',
      routeId: 'r1',
      whyRoute: '帅位诊断',
    });
    expect(marshal.taskId).toBeNull();
    const sub = await addSubtask(t.db, taskId);
    await expectViolation(
      addRun(t.db, { taskId: null, subtaskId: sub.id, routeId: 'r1' }),
      'session_runs_subtask_needs_task',
    );
  });

  it('token 和花费不知道就是空，不记成 0', async () => {
    const run = await addRun(t.db, { taskId, routeId: 'r1' });
    expect([run.inputTokens, run.outputTokens, run.costUsd]).toEqual([null, null, null]);
  });

  it('请求的模型（看路由）和上游实际用的模型分开记', async () => {
    const run = await addRun(t.db, { taskId, routeId: 'r1', actualModel: 'claude-sonnet-fallback' });
    const [row] = await t.db
      .select({ requested: routes.modelId, actual: sessionRuns.actualModel })
      .from(sessionRuns)
      .innerJoin(routes, eq(routes.id, sessionRuns.routeId))
      .where(eq(sessionRuns.id, run.id));
    expect(row).toEqual({ requested: 'opus-5.5', actual: 'claude-sonnet-fallback' });
  });

  it('plan 进度的载荷必须是 { steps: [...] }（和 fleet plan 的请求体同形）', async () => {
    const run = await addRun(t.db, { taskId, routeId: 'r1' });
    for (const payload of [[{ title: '写测试', state: 'in_progress' }], { steps: 'x' }, {}, null]) {
      await expectViolation(
        t.db.insert(progressEvents).values({ runId: run.id, kind: 'plan', payload }),
        'progress_events_plan_has_steps',
      );
    }
    await t.db.insert(progressEvents).values({
      runId: run.id,
      kind: 'plan',
      payload: { steps: [{ title: '写测试', state: 'in_progress' }] },
    });
  });
});

describe('追问', () => {
  let taskId: string;
  let runId: string;
  beforeEach(async () => {
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db);
    taskId = (await addTask(t.db, repo.id)).id;
    runId = (await addRun(t.db, { taskId, routeId: 'r1' })).id;
  });

  it('同一会话问一模一样的一句只有一条', async () => {
    await t.db
      .insert(asks)
      .values({ taskId, runId, question: '要不要兼容旧接口？', options: ['要', '不要'] });
    await expectViolation(
      t.db.insert(asks).values({ taskId, runId, question: '要不要兼容旧接口？' }),
      'asks_run_question_unique',
    );
  });

  it('一问可以长到 2000 字（fleet ask 的上限），照样去重', async () => {
    // 2000 个汉字约 6000 字节：直接在原文上建唯一索引，900 多字就会报 index row size exceeds。
    const long = `${'要'.repeat(1999)}？`;
    await t.db.insert(asks).values({ taskId, runId, question: long });
    await expectViolation(
      t.db.insert(asks).values({ taskId, runId, question: long }),
      'asks_run_question_unique',
    );
    // 同一会话里差一个字就是另一问；别的会话问同一句也是另一问。
    await t.db.insert(asks).values({ taskId, runId, question: `${long.slice(0, -1)}!` });
    const otherRun = (await addRun(t.db, { taskId, routeId: 'r1' })).id;
    await t.db.insert(asks).values({ taskId, runId: otherRun, question: long });
    const rows = await t.db.select({ question: asks.question }).from(asks);
    expect(rows.map((r) => r.question.length)).toEqual([2000, 2000, 2000]);
  });

  it('按 (run_id, md5(question)) 重试可以直接拿回已有的那一问', async () => {
    const question = '要不要兼容旧接口？';
    const first = await t.db.insert(asks).values({ taskId, runId, question }).returning({ id: asks.id });
    const again = await t.client.query<{ id: string }>(
      `insert into asks (task_id, run_id, question) values ($1, $2, $3)
       on conflict (run_id, md5(question)) do nothing returning id`,
      [taskId, runId, question],
    );
    expect(again.rows).toEqual([]);
    const existing = await t.client.query<{ id: string }>(
      'select id from asks where run_id = $1 and md5(question) = md5($2)',
      [runId, question],
    );
    expect(existing.rows.map((r) => r.id)).toEqual([first[0]?.id]);
  });

  it('会话必须属于追问挂的那个需求', async () => {
    const repo = await addRepo(t.db);
    const other = await addTask(t.db, repo.id);
    await expectViolation(
      t.db.insert(asks).values({ taskId: other.id, runId, question: '?' }),
      'asks_run_in_task_fk',
    );
  });

  it('回答、谁答的、什么时候答的，要么都有要么都没有', async () => {
    await expectViolation(
      t.db.insert(asks).values({ taskId, runId, question: '?', answer: '要' }),
      'asks_answer_shape',
    );
    await t.db
      .insert(asks)
      .values({ taskId, runId, question: '?', answer: '要', answeredBy: 'user-1', answeredAt: NOW });
  });
});

describe('状态变化由库记', () => {
  it('新建记一行、改状态记一行、改别的不记', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const sub = await addSubtask(t.db, task.id);
    await t.db.update(tasks).set({ state: 'planning' }).where(eq(tasks.id, task.id));
    await t.db.update(tasks).set({ title: '改个标题' }).where(eq(tasks.id, task.id));
    await t.db.update(tasks).set({ state: 'planning' }).where(eq(tasks.id, task.id));
    await t.db.update(subtasks).set({ state: 'running' }).where(eq(subtasks.id, sub.id));
    const rows = await t.db
      .select({
        entity: stateChanges.entity,
        id: stateChanges.entityId,
        taskId: stateChanges.taskId,
        from: stateChanges.fromState,
        to: stateChanges.toState,
      })
      .from(stateChanges)
      .orderBy(stateChanges.id);
    expect(rows).toEqual([
      { entity: 'task', id: task.id, taskId: task.id, from: null, to: 'queued' },
      { entity: 'subtask', id: sub.id, taskId: task.id, from: null, to: 'pending' },
      { entity: 'task', id: task.id, taskId: task.id, from: 'queued', to: 'planning' },
      { entity: 'subtask', id: sub.id, taskId: task.id, from: 'pending', to: 'running' },
    ]);
  });

  it('删掉需求时它的状态历史一起删，不会卡住删除', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await t.db.delete(tasks).where(eq(tasks.id, task.id));
    expect(await t.db.select().from(stateChanges)).toEqual([]);
  });
});

describe('通知', () => {
  it('同一件事（去重键相同）只有一条', async () => {
    await t.db
      .insert(notifications)
      .values({ level: 'alert', dedupeKey: 'stuck:12:execute', title: '卡住了' });
    await expectViolation(
      t.db.insert(notifications).values({ level: 'alert', dedupeKey: 'stuck:12:execute', title: '又卡住了' }),
      'notifications_dedupe_key_unique',
    );
  });

  it('没拿到飞书 message_id 不许记成已送到', async () => {
    const [n] = await t.db
      .insert(notifications)
      .values({ level: 'decision', dedupeKey: 'gate:1', title: '要你拍' })
      .returning();
    if (!n) throw new Error('通知没写进去');
    await expectViolation(
      t.db
        .insert(notificationDeliveries)
        .values({ notificationId: n.id, channel: 'feishu', target: 'team', deliveredAt: NOW }),
      'notification_deliveries_delivered_needs_message_id',
    );
  });
});

describe('Jev 记录', () => {
  const question = {
    id: 'triage.clear',
    site: 'triage',
    prompt: '这条需求说清楚了吗？',
    type: 'noul' as const,
    confidenceLine: 0.7,
    model: 'jev-2026-09-01',
  };

  it('模型版本要钉死，不许用 latest', async () => {
    await expectViolation(
      t.db.insert(jevQuestions).values({ ...question, model: 'jev-latest' }),
      'jev_questions_model_pinned',
    );
  });

  it('单选题至少两个选项，是非题不带选项', async () => {
    await expectViolation(
      t.db.insert(jevQuestions).values({ ...question, type: 'choice' }),
      'jev_questions_choice_has_options',
    );
    await expectViolation(
      t.db.insert(jevQuestions).values({ ...question, options: ['是', '否'] }),
      'jev_questions_choice_has_options',
    );
  });

  it('新题默认只记不拦', async () => {
    const [q] = await t.db.insert(jevQuestions).values(question).returning();
    expect(q?.mode).toBe('shadow');
  });

  it('没判出来（超时、连不上）要写原因且没有答案，不能当成「否」', async () => {
    await t.db.insert(jevQuestions).values(question);
    const base = { questionId: question.id, subject: 'task:1', sample: { issue: 1 }, shadow: true };
    await t.db.insert(jevAnswers).values({ ...base, ok: false, failReason: 'timeout' });
    await expectViolation(t.db.insert(jevAnswers).values({ ...base, ok: false }), 'jev_answers_ok_shape');
    await expectViolation(
      t.db.insert(jevAnswers).values({ ...base, ok: false, failReason: 'timeout', answer: 'no' }),
      'jev_answers_ok_shape',
    );
    await expectViolation(
      t.db.insert(jevAnswers).values({ ...base, ok: true, answer: 'yes' }),
      'jev_answers_ok_shape',
    );
    await expectViolation(
      t.db.insert(jevAnswers).values({ ...base, ok: true, answer: 'yes', confidence: 0.9, truth: 'no' }),
      'jev_answers_truth_shape',
    );
  });
});

describe('操作记录与定时任务', () => {
  it('失败的操作必须写错误', async () => {
    const entry = {
      actorKind: 'engine',
      actorId: 'worker-1',
      action: 'pr.merge',
      target: 'task:1',
      via: 'engine',
    } as const;
    await expectViolation(
      t.db.insert(auditLog).values({ ...entry, ok: false }),
      'audit_log_failure_has_error',
    );
    await t.db.insert(auditLog).values({ ...entry, ok: false, error: '合并冲突' });
  });

  it('没登记的定时任务记不了运行记录', async () => {
    await expectViolation(
      t.db.insert(scheduleRuns).values({ job: 'nobody-declared-me' }),
      'schedule_runs_job_scheduled_jobs_id_fk',
    );
  });

  it('定时任务：结束了要有结局；ok 要真扫到东西；一个都没扫到只能记 unscanned；不是 ok 的都要写原因', async () => {
    await t.db
      .insert(scheduledJobs)
      .values({ id: 'j', name: '对账', schedule: '每小时', expectEveryMinutes: 75 });
    const done = { job: 'j', startedAt: ago(HOUR), endedAt: NOW } as const;
    await expectViolation(
      t.db.insert(scheduleRuns).values({ job: 'j', endedAt: NOW }),
      'schedule_runs_outcome_iff_ended',
    );
    // 「查了、0 个问题」和「一个都没扫到」不许混写。
    await expectViolation(
      t.db.insert(scheduleRuns).values({ ...done, outcome: 'ok', scanned: 0, found: 0 }),
      'schedule_runs_ok_scanned_something',
    );
    await expectViolation(
      t.db.insert(scheduleRuns).values({ ...done, outcome: 'ok', scanned: 3 }),
      'schedule_runs_ok_scanned_something',
    );
    await expectViolation(
      t.db.insert(scheduleRuns).values({ ...done, outcome: 'unscanned', scanned: 3, why: '?' }),
      'schedule_runs_unscanned_is_zero',
    );
    for (const outcome of ['failed', 'partial', 'unscanned'] as const) {
      await expectViolation(
        t.db.insert(scheduleRuns).values({ ...done, outcome }),
        'schedule_runs_not_ok_has_why',
      );
    }
    await t.db.insert(scheduleRuns).values([
      { ...done, outcome: 'ok', scanned: 3, found: 0 },
      { ...done, outcome: 'unscanned', scanned: 0, why: '名册是空的' },
      { ...done, outcome: 'partial', scanned: 5, found: 1, why: '一个源超时' },
      { ...done, outcome: 'failed', why: '连不上' },
    ]);
  });
});

describe('成员', () => {
  it('飞书身份和 GitHub 数字编号各自唯一；机器人可以没有飞书身份', async () => {
    await t.db
      .insert(users)
      .values({ displayName: '创始人甲', role: 'founder', feishuOpenId: 'ou_a', feishuUnionId: 'on_a' });
    await t.db
      .insert(users)
      .values({ displayName: '干活的机器人', role: 'bot', githubLogin: 'worker-bot', githubId: 1001 });
    await expectViolation(
      t.db.insert(users).values({ displayName: '冒名', role: 'founder', feishuOpenId: 'ou_a' }),
      'users_feishu_open_id_unique',
    );
    await expectViolation(
      t.db.insert(users).values({ displayName: '改名的机器人', role: 'bot', githubId: 1001 }),
      'users_github_id_unique',
    );
  });
});

describe('设置', () => {
  it('第一次写入版本是 1，版本不能是 0 或负数', async () => {
    const [row] = await t.db.insert(settings).values({ key: 'theme', value: 'dusk' }).returning();
    expect(row?.version).toBe(1);
    await expectViolation(
      t.db.insert(settings).values({ key: 'quiet', value: { from: '23:00', to: '08:00' }, version: 0 }),
      'settings_version_positive',
    );
  });
});

describe('PR 镜像', () => {
  it('每个仓每个编号一行，CI 汇总默认「没有」', async () => {
    const repo = await addRepo(t.db);
    const base = {
      repoId: repo.id,
      number: 31,
      state: 'open',
      headRef: 'p1-db',
      headSha: 'abc123',
      updatedAt: NOW,
    } as const;
    const [pr] = await t.db.insert(pullRequests).values(base).returning();
    expect(pr?.checks).toBe('none');
    await expectViolation(t.db.insert(pullRequests).values(base), 'pull_requests_repo_id_number_pk');
  });
});

describe('子任务', () => {
  it('同一个需求里序号不重复', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await addSubtask(t.db, task.id, { index: 0 });
    await expectViolation(addSubtask(t.db, task.id, { index: 0 }), 'subtasks_task_index_unique');
    const rows = await t.db.select().from(subtasks).where(eq(subtasks.taskId, task.id));
    expect(rows).toHaveLength(1);
  });
});
