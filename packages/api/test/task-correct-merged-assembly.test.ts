// 真实装配：fleet-api 命令、PGlite、pg Store 的事务、真 runTask 重做和起代意图。GitHub 和 Temporal 用替身，不打生产，不发信号。
import { acceptanceDuties, auditLog, pullRequests, repos, runs, stateChanges, tasks } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { createPgStore, type Store } from '@fleet-dao/store';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import type { TaskRedoPort } from '../src/deps.ts';
import type { WorkflowControl } from '../src/ports.ts';
import { runTask } from '../src/task-cli.ts';
import type { ExecutionFacts } from '../src/task-correct-merged.ts';
import { type GitHubGet, portsFromParts } from '../src/task-correct-merged-cli.ts';
import { fencedTaskRedo } from '../src/task-generation-fence.ts';

const HEAD = '5b52006a9cdcef60c030c5dbeec645f81a2ad86a';
const MERGE = 'bfe1b1ae69c7ae6404b068eb3ed7bde3082b3e40';
const WF = 'task:thoerwink8/fleet-dao#3114';
const RUN = '01a14fd8-fb57-741a-8c14-42e3fdba87d6';
const TASK = 'd629758a-570d-405d-be00-417b7ee6c0c7';
const REPO_ID = 'a3114000-0000-4000-8000-000000003114';
const RUN_ROW = 'b3114000-0000-4000-8000-000000003137';
const WHEN = new Date('2026-10-19T01:52:06.446Z');

interface World {
  issue: unknown | null;
  pull: unknown | null;
  throwRead: string | null;
  status: string;
  runId: string;
  result: unknown;
  /** 替身 Temporal 上第二代在不在（重做真起成、或迟到的起代落地才出现）。 */
  extraGeneration: boolean;
  /** Temporal 这一读已经拍下了旧快照、还没交回之前跑：模拟「最后一次 describe 之后才起代」。 */
  afterExecutionRead: (() => Promise<void>) | null;
  wrapCas: boolean;
  conflictOnCas: boolean;
  reads: number;
  resultCalls: number;
  casCalls: number;
  opened: number;
  redoStarts: number;
}

function world(): World {
  return {
    issue: { number: 3114, state: 'closed', title: '合成' },
    pull: {
      number: 3137,
      merged: true,
      state: 'closed',
      head: { sha: HEAD },
      merge_commit_sha: MERGE,
      base: { repo: { full_name: 'thoerwink8/fleet-dao' } },
    },
    throwRead: null,
    status: 'COMPLETED',
    runId: RUN,
    result: { outcome: 'abandoned', prNumber: 3137, head: HEAD },
    extraGeneration: false,
    afterExecutionRead: null,
    wrapCas: false,
    conflictOnCas: false,
    reads: 0,
    resultCalls: 0,
    casCalls: 0,
    opened: 0,
    redoStarts: 0,
  };
}

describe('task correct-merged 真实装配', () => {
  let t: TestDb;
  let current: World;

  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  /** 合成的 #3114：引擎的 stopped/abandoned，一条已结束的会话记着 PR #3137，验收责任还开着。 */
  async function seed() {
    await resetTestDb(t);
    current = world();
    await t.db
      .insert(repos)
      .values({ id: REPO_ID, owner: 'thoerwink8', name: 'fleet-dao', testCommand: 'pnpm test' });
    await t.db.insert(tasks).values({
      id: TASK,
      repoId: REPO_ID,
      issueNumber: 3114,
      title: '合成',
      rawRequest: '合成',
      requestedBy: 'test',
      state: 'stopped',
      phase: 'abandoned',
      priority: 0,
      executor: 'engine',
      updatedAt: WHEN,
    });
    await addRun({ id: RUN_ROW, endedAt: WHEN, outcome: 'done', prNumber: 3137 });
    await t.db.insert(acceptanceDuties).values({
      taskId: TASK,
      repo: 'thoerwink8/fleet-dao',
      issueNumber: 3114,
      prNumber: 3137,
      head: HEAD,
      items: ['要现场看一眼'],
    });
  }
  beforeEach(seed);

  function addRun(over: Partial<typeof runs.$inferInsert> & { id: string }) {
    return t.db.insert(runs).values({
      segment: 'manual',
      taskId: TASK,
      issueNumber: 3114,
      model: 'test',
      startedAt: WHEN,
      workflowId: WF,
      ...over,
    });
  }

  function execution(): ExecutionFacts {
    const first = { workflowId: WF, generation: 1, runId: current.runId, status: current.status };
    const generations = current.extraGeneration
      ? [first, { workflowId: `${WF}:r2`, generation: 2, runId: 'later-run', status: 'RUNNING' }]
      : [first];
    const readable = current.status === 'COMPLETED' && current.runId === RUN;
    if (readable) current.resultCalls += 1;
    return { generations, matched: { ...first, result: readable ? resultOf(current.result) : null } };
  }

  function github(): GitHubGet {
    return {
      async request({ path }) {
        if (current.throwRead) throw new Error(current.throwRead);
        if (path.endsWith('/issues/3114')) {
          return current.issue === null ? { status: 404, data: {} } : { status: 200, data: current.issue };
        }
        if (path.includes('/pulls/')) {
          return current.pull === null ? { status: 404, data: {} } : { status: 200, data: current.pull };
        }
        return { status: 404, data: {} };
      },
    };
  }

  function pgStore(): Store {
    return createPgStore(t.db, { now: () => new Date('2026-10-19T02:00:00.000Z') });
  }

  async function invoke(argv: string[], env: Record<string, string | undefined> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const real = portsFromParts({
      ledger: pgStore(),
      github: github(),
      execution: async () => {
        const facts = execution();
        if (current.afterExecutionRead) await current.afterExecutionRead();
        return facts;
      },
    });
    const code = await main(['task', ...argv], {
      env: { DATABASE_URL: 'postgres://assembly', FLEET_OPS_OPERATOR: 'founder', ...env },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      openStore: async () => {
        throw new Error('correct-merged 不应走普通 task 入口');
      },
      now: () => new Date('2026-10-19T02:00:00.000Z'),
      openCorrectMerged: async () => {
        current.opened += 1;
        return {
          ports: {
            read: async (request) => {
              current.reads += 1;
              return real.read(request);
            },
            cas: async (input) => {
              current.casCalls += 1;
              if (current.wrapCas) {
                await t.db
                  .update(tasks)
                  .set({ updatedAt: new Date('2026-10-19T04:00:00.000Z') })
                  .where(eq(tasks.id, input.taskId));
              }
              if (current.conflictOnCas) {
                await addRun({
                  id: 'c3114000-0000-4000-8000-000000000097',
                  endedAt: WHEN,
                  outcome: 'done',
                  prNumber: 99999,
                });
              }
              return real.cas(input);
            },
          },
          close: async () => {},
        };
      },
    });
    const json =
      out.length === 1
        ? (JSON.parse(out[0] ?? '') as {
            status: string;
            reason?: string;
            text: string;
            preview: { execution: { outcome: string | null } | null; proposed: unknown };
          })
        : null;
    return { code, out, err: err.join('\n'), json };
  }

  function args(extra: string[] = [], patch: Record<string, string> = {}) {
    const v: Record<string, string> = {
      repo: 'thoerwink8/fleet-dao',
      issue: '3114',
      pr: '3137',
      head: HEAD,
      merge: MERGE,
      workflow: WF,
      run: RUN,
      note: '合成的 #3114 反例',
      ...patch,
    };
    return [
      'correct-merged',
      v.repo ?? '',
      v.issue ?? '',
      ...['--pr', v.pr ?? '', '--head', v.head ?? '', '--merge', v.merge ?? ''],
      ...['--workflow', v.workflow ?? '', '--run', v.run ?? '', '--note', v.note ?? ''],
      ...extra,
    ];
  }

  async function taskRow() {
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, TASK));
    return row;
  }

  async function audits(action = 'task.correct-merged') {
    return t.db.select().from(auditLog).where(eq(auditLog.action, action));
  }

  async function expectUntouched(label = '') {
    const row = await taskRow();
    expect(row?.state, label).toBe('stopped');
    expect(row?.phase, label).toBe('abandoned');
    expect(await audits(), label).toEqual([]);
    const changes = await t.db.select().from(stateChanges).where(eq(stateChanges.taskId, TASK));
    expect(
      changes.some((change) => change.toState === 'done'),
      label,
    ).toBe(false);
  }

  /**
   * 经真实 runTask（task 命令的重做）+ fencedTaskRedo + pg Store 起代。替身 Temporal：
   * 和真 createTemporalTaskRedo 同一份口子约定：列代后报 observed，起之前调 beforeStart。
   * ok 起成第二代；deadline 绑了第二代后抛 DEADLINE_EXCEEDED（结果未知，起代可能迟到落地）；
   * landed 列代看到迟到的第二代已在跑，拒绝另起（不调 start）。
   * beforeRedo 在 runTask 读到 stopped 之后、进起代意图之前跑。
   */
  function redoViaRunTask(
    mode: 'ok' | 'deadline' | 'landed',
    beforeRedo?: () => Promise<void>,
  ): Promise<string> {
    const store = pgStore();
    const port: TaskRedoPort = {
      async redo(input) {
        if (mode === 'landed') {
          input.observed?.(2);
          return { ok: false, why: `上一代还在跑（${WF}:r2），先叫停再重做` };
        }
        input.observed?.(1);
        await input.beforeStart?.(`${WF}:r2`);
        current.redoStarts += 1;
        if (mode === 'deadline') throw Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: 4 });
        current.extraGeneration = true;
        return { ok: true, workflowId: `${WF}:r2`, generation: 2 };
      },
    };
    const read: Pick<Store, 'findTaskByIssue'> = {
      async findTaskByIssue(repoId, issueNumber) {
        const task = await store.findTaskByIssue(repoId, issueNumber);
        await beforeRedo?.();
        return task;
      },
    };
    const workflows = { async signal() {} } as unknown as WorkflowControl;
    const actor = { kind: 'ops', id: 'founder', via: 'ops' } as const;
    return runTask(
      { action: 'redo', owner: 'thoerwink8', name: 'fleet-dao', issueNumber: 3114, note: '交错回归' },
      {
        store: { ...store, findTaskByIssue: read.findTaskByIssue },
        workflows,
        taskRedo: fencedTaskRedo(port, store, actor),
        operator: 'founder',
      },
    ).then(
      (text) => text,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
  }

  it('预检不写；--apply 纠正并留下原 run、原 abandoned 结果和待验责任；重复调用幂等', async () => {
    const preview = await invoke(args());
    expect(preview.code).toBe(0);
    expect(preview.json?.status).toBe('precheck');
    expect(preview.json?.preview.proposed).toEqual({ state: 'done', phase: 'merged' });
    expect(preview.json?.text).not.toContain('closed');
    expect(current.casCalls).toBe(0);
    expect((await taskRow())?.state).toBe('stopped');

    current = world();
    const applied = await invoke(args(['--apply']));
    expect(applied.code).toBe(0);
    expect(applied.json?.status).toBe('corrected');
    expect(applied.json?.preview.execution?.outcome).toBe('abandoned');
    expect(current.reads).toBe(1);
    const row = await taskRow();
    expect(row?.state).toBe('done');
    expect(row?.phase).toBe('merged');
    expect(row?.doing).toContain('原 abandoned');
    const recorded = await audits();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.actorId).toBe('ops:correct-merged:founder');
    expect(recorded[0]?.reason).toContain('合成的 #3114 反例');
    expect(recorded[0]?.before).toEqual({ state: 'stopped', phase: 'abandoned' });
    expect(recorded[0]?.after).toMatchObject({
      state: 'done',
      phase: 'merged',
      head: HEAD,
      mergeCommit: MERGE,
      workflowId: WF,
      runId: RUN,
      pr: 3137,
    });
    const [run] = await t.db.select().from(runs).where(eq(runs.id, RUN_ROW));
    expect(run?.outcome).toBe('done');
    expect(run?.temporalRunId).toBeNull();
    expect(run?.workflowId).toBe(WF);
    const [duty] = await t.db.select().from(acceptanceDuties).where(eq(acceptanceDuties.taskId, TASK));
    expect(duty?.settledAt).toBeNull();
    const changes = await t.db.select().from(stateChanges).where(eq(stateChanges.taskId, TASK));
    expect(changes.some((change) => change.fromState === 'stopped' && change.toState === 'done')).toBe(true);

    current = world();
    const again = await invoke(args(['--apply'], { note: '换一句原因' }), {
      FLEET_OPS_OPERATOR: 'other-ops',
    });
    expect(again.code).toBe(0);
    expect(again.json?.status).toBe('already');
    expect(again.json?.preview.execution?.outcome).toBe('abandoned');
    expect(current.casCalls).toBe(0);
    expect(await audits()).toHaveLength(1);
    expect((await audits())[0]?.reason).toContain('合成的 #3114 反例');
  });

  it('事实不对、读不到、未授权、活着、换代、起代结果未知都不写', async () => {
    const pull = (patch: object) => () => {
      current.pull = { ...(current.pull as object), ...patch };
    };
    const cases: {
      name: string;
      patch?: Record<string, string>;
      env?: Record<string, string | undefined>;
      prepare?: () => unknown;
      fragment: string;
      open?: boolean;
      state?: string;
    }[] = [
      { name: '未授权', env: { FLEET_OPS_OPERATOR: '' }, fragment: '未授权', open: false },
      { name: '错仓', patch: { repo: 'other/fleet-dao' }, fragment: '不属于这张单', open: false },
      { name: '错 PR', patch: { pr: '9999' }, fragment: '原执行的 PR' },
      { name: '错 run', patch: { run: 'other-run-id' }, fragment: '错 run' },
      { name: '还没合并', prepare: pull({ merged: false }), fragment: '还没合并' },
      { name: '错 head', prepare: pull({ head: { sha: 'a'.repeat(40) } }), fragment: '错 head' },
      { name: '错 merge', prepare: pull({ merge_commit_sha: 'b'.repeat(40) }), fragment: '错 merge' },
      {
        name: '读不到',
        prepare: () => {
          current.throwRead = 'github down';
        },
        fragment: '读取事实没成',
      },
      {
        name: 'issue 不存在',
        prepare: () => {
          current.issue = null;
        },
        fragment: '读不到这张 issue',
      },
      {
        name: '编号其实是 PR',
        prepare: () => {
          current.issue = { number: 3114, pull_request: { url: 'https://example.test' } };
        },
        fragment: '这是 PR 不是 issue',
      },
      {
        name: '本机执行',
        prepare: () => t.db.update(tasks).set({ executor: 'local' }).where(eq(tasks.id, TASK)),
        fragment: '本机执行',
      },
      {
        name: '活会话',
        prepare: () => addRun({ id: 'c3114000-0000-4000-8000-000000000001' }),
        fragment: '活跃会话',
      },
      {
        name: '仍在运行',
        prepare: () => {
          current.status = 'RUNNING';
        },
        fragment: '仍在运行',
      },
      {
        name: '已有新的一代',
        prepare: () => {
          current.extraGeneration = true;
        },
        fragment: '仍在运行',
      },
      {
        name: '结果读不到',
        prepare: () => {
          current.result = { outcome: 'abandoned' };
        },
        fragment: '原执行结果读不到',
      },
      {
        name: '镜像冲突',
        prepare: () =>
          t.db.insert(pullRequests).values({
            repoId: REPO_ID,
            number: 3137,
            state: 'merged',
            headRef: 'fleet/3114',
            headSha: 'c'.repeat(40),
            mergeSha: MERGE,
            updatedAt: WHEN,
            issueRefs: [3114],
          }),
        fragment: '镜像',
      },
      {
        name: '会话记了别的 run',
        prepare: () => t.db.update(runs).set({ temporalRunId: 'other-run' }).where(eq(runs.id, RUN_ROW)),
        fragment: '无证据',
      },
      {
        name: '同一工作流另有不同 PR',
        prepare: () =>
          addRun({
            id: 'c3114000-0000-4000-8000-000000000099',
            endedAt: WHEN,
            outcome: 'done',
            prNumber: 99999,
          }),
        fragment: '歧义',
      },
      {
        name: '旧行（task_id 为空、单号和工作流对上）活会话',
        prepare: () => addRun({ id: 'c3114000-0000-4000-8000-0000000000a1', taskId: null }),
        fragment: '活跃会话',
      },
      {
        name: '旧行（task_id 为空、单号和工作流对上）另有不同 PR',
        prepare: () =>
          addRun({
            id: 'c3114000-0000-4000-8000-0000000000a2',
            taskId: null,
            endedAt: WHEN,
            outcome: 'done',
            prNumber: 99999,
          }),
        fragment: '歧义',
      },
      {
        name: '起代意图没结',
        prepare: () =>
          pgStore().beginTaskStart({
            taskId: TASK,
            allowed: ['stopped'],
            actor: { kind: 'ops', id: 'founder', via: 'ops' },
          }),
        fragment: '结果未知',
      },
      {
        name: '不是 abandoned',
        prepare: () => t.db.update(tasks).set({ state: 'running', phase: null }).where(eq(tasks.id, TASK)),
        fragment: '不是误记',
        state: 'running',
      },
      {
        name: '没有更新时间',
        prepare: () => t.db.update(tasks).set({ updatedAt: null }).where(eq(tasks.id, TASK)),
        fragment: '更新时间',
      },
      {
        name: 'done 但没有这次回执',
        prepare: () => t.db.update(tasks).set({ state: 'done', phase: 'merged' }).where(eq(tasks.id, TASK)),
        fragment: '审计回执',
        state: 'done',
      },
    ];
    for (const item of cases) {
      await seed();
      await item.prepare?.();
      const result = await invoke(args(['--apply'], item.patch), item.env);
      expect(result.code, item.name).toBe(1);
      expect(result.json?.status, item.name).toBe('refused');
      expect(result.json?.reason ?? result.json?.text, item.name).toContain(item.fragment);
      expect(current.casCalls, item.name).toBe(0);
      expect(current.opened, item.name).toBe(item.open === false ? 0 : 1);
      expect(await audits(), item.name).toEqual([]);
      const row = await taskRow();
      expect(row?.state, item.name).toBe(item.state ?? 'stopped');
      if (!item.state) expect(row?.phase, item.name).toBe('abandoned');
    }
  }, 60_000);

  it('读取之后才出现冲突会话，或更新时间被别人改了：事务回 stale，不写', async () => {
    current.conflictOnCas = true;
    const conflict = await invoke(args(['--apply']));
    expect(conflict.code).toBe(1);
    expect(conflict.json?.reason).toContain('变了');
    expect(current.casCalls).toBe(1);
    await expectUntouched('冲突会话');
    expect((await taskRow())?.updatedAt?.toISOString()).toBe(WHEN.toISOString());

    await seed();
    current.wrapCas = true;
    const moved = await invoke(args(['--apply']));
    expect(moved.json?.reason).toContain('变了');
    await expectUntouched('更新时间');
  });

  it('固定交错（评审 5567178504/5567399389）：Temporal 最后一读拍下旧快照之后，真 runTask 重做起成新代——CAS 因起代意图回 stale，不写 done', async () => {
    let redoText = '';
    current.afterExecutionRead = async () => {
      current.afterExecutionRead = null;
      redoText = await redoViaRunTask('ok');
    };
    const result = await invoke(args(['--apply']));
    expect(redoText).toContain('已重做');
    expect(current.redoStarts).toBe(1);
    expect(current.extraGeneration).toBe(true);
    expect(result.code).toBe(1);
    expect(result.json?.status).toBe('refused');
    expect(result.json?.reason).toContain('受管起代');
    expect(current.casCalls).toBe(1);
    await expectUntouched();
    expect(await audits('task.redo')).toHaveLength(1);
    expect((await audits('task.start-intent')).length).toBe(1);
    expect((await audits('task.start-settled')).length).toBe(1);
    // 起成已结：意图不再挂着；再预检拒绝的理由是新一代在跑，不是结果未知
    current.afterExecutionRead = null;
    const again = await invoke(args());
    expect(again.json?.reason).toContain('仍在运行');
  }, 30_000);

  it('固定交错（评审 5567809690 第 1 条）：起代超时结果未知、迟到的起代在纠正最后一读之后才落地——意图一直挂着，纠正拒绝，不靠超时放行', async () => {
    // 窗口里：纠正已读完旧快照，重做起代超时
    current.afterExecutionRead = async () => {
      current.afterExecutionRead = null;
      expect(await redoViaRunTask('deadline')).toContain('DEADLINE_EXCEEDED');
    };
    const first = await invoke(args(['--apply']));
    expect(first.json?.status).toBe('refused');
    expect(current.casCalls).toBe(1);
    await expectUntouched('窗口里超时');

    // 之后再纠正：Temporal 还看不到新代，但意图没结，照样拒绝，连 CAS 都不进
    for (const mode of [[], ['--apply']]) {
      current = world();
      const later = await invoke(args(mode));
      expect(later.json?.status).toBe('refused');
      expect(later.json?.reason).toContain('结果未知');
      expect(current.casCalls).toBe(0);
    }
    // 迟到的起代真落地了：任务行仍是原样，没有被旧请求写成 done
    current.extraGeneration = true;
    await expectUntouched('迟到落地');
    expect(await audits('task.start-intent')).toHaveLength(1);
    expect(await audits('task.start-target')).toHaveLength(1);
    expect(await audits('task.start-settled')).toEqual([]);

    // 不会永久卡住：再跑一次重做，列代明确看到第二代已在，才核清那次未知起代；拒绝另起，不调 start
    const starts = current.redoStarts;
    expect(await redoViaRunTask('landed')).toContain('上一代还在跑');
    expect(current.redoStarts).toBe(starts);
    expect(await audits('task.start-intent')).toHaveLength(2);
    expect(await audits('task.start-settled')).toHaveLength(1);
    await expectUntouched('核清之后');
    // 核清之后纠正的拒绝理由是新一代在跑，不是结果未知
    current.casCalls = 0;
    const settled = await invoke(args(['--apply']));
    expect(settled.json?.status).toBe('refused');
    expect(settled.json?.reason).toContain('仍在运行');
    expect(current.casCalls).toBe(0);
  }, 30_000);

  it('固定交错：重做已读到 stopped、还没落意图时纠正先提交——起代意图重读到 done 而拒绝，新代从未起', async () => {
    let corrected = '';
    const text = await redoViaRunTask('ok', async () => {
      corrected = (await invoke(args(['--apply']))).json?.status ?? '';
    });
    expect(corrected).toBe('corrected');
    expect(text).toContain('现在是done');
    expect(current.redoStarts).toBe(0);
    expect(current.extraGeneration).toBe(false);
    expect((await taskRow())?.state).toBe('done');
    expect(await audits()).toHaveLength(1);
    expect(await audits('task.start-intent')).toEqual([]);
  }, 30_000);

  it('操作记录写不进时任务行和状态变化一起回滚', async () => {
    await t.db.execute(sql`
      create or replace function correct_merged_audit_boom() returns trigger
      language plpgsql as $fn$
      begin
        if new.action = 'task.correct-merged' then
          raise exception 'audit boom';
        end if;
        return new;
      end
      $fn$
    `);
    await t.db.execute(sql`
      create trigger correct_merged_audit_boom
      before insert on audit_log
      for each row execute function correct_merged_audit_boom()
    `);
    try {
      const result = await invoke(args(['--apply']));
      expect(result.code).toBe(1);
      expect(result.json?.reason).toContain('写不进');
      await expectUntouched();
    } finally {
      await t.db.execute(sql`drop trigger if exists correct_merged_audit_boom on audit_log`);
      await t.db.execute(sql`drop function if exists correct_merged_audit_boom()`);
    }
  });

  it('参数不对不连库', async () => {
    const result = await invoke(['correct-merged', 'thoerwink8/fleet-dao', '3114']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('缺');
    expect(current.opened).toBe(0);
    expect(result.json).toBeNull();
  });
});

function resultOf(value: unknown): { outcome: string; prNumber: number; head: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const prNumber = row.prNumber;
  if (typeof row.outcome !== 'string' || typeof prNumber !== 'number' || typeof row.head !== 'string') {
    return null;
  }
  return { outcome: row.outcome, prNumber, head: row.head };
}
