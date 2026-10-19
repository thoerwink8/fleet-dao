// 真实装配：fleet-api 命令、PGlite、pg Store 的事务。GitHub 和 Temporal 用替身，不打生产，不发信号。
import { acceptanceDuties, auditLog, pullRequests, repos, runs, stateChanges, tasks } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { createPgStore } from '@fleet-dao/store';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import type { ExecutionFacts } from '../src/task-correct-merged.ts';
import { type GitHubGet, portsFromParts } from '../src/task-correct-merged-cli.ts';

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
  resultThrows: boolean;
  extraGeneration: boolean;
  onSecondRead: (() => Promise<void>) | null;
  wrapCas: boolean;
  conflictOnCas: boolean;
  reads: number;
  resultCalls: number;
  casCalls: number;
  opened: number;
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
    resultThrows: false,
    extraGeneration: false,
    onSecondRead: null,
    wrapCas: false,
    conflictOnCas: false,
    reads: 0,
    resultCalls: 0,
    casCalls: 0,
    opened: 0,
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
  beforeEach(async () => {
    await resetTestDb(t);
    current = world();
    await t.db.insert(repos).values({
      id: REPO_ID,
      owner: 'thoerwink8',
      name: 'fleet-dao',
      testCommand: 'pnpm test',
    });
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
    await t.db.insert(runs).values({
      id: RUN_ROW,
      segment: 'manual',
      taskId: TASK,
      issueNumber: 3114,
      model: 'test',
      startedAt: WHEN,
      endedAt: WHEN,
      outcome: 'done',
      prNumber: 3137,
      workflowId: WF,
    });
    await t.db.insert(acceptanceDuties).values({
      taskId: TASK,
      repo: 'thoerwink8/fleet-dao',
      issueNumber: 3114,
      prNumber: 3137,
      head: HEAD,
      items: ['要现场看一眼'],
    });
  });

  function execution(): ExecutionFacts {
    const first = { workflowId: WF, generation: 1, runId: current.runId, status: current.status };
    const generations = current.extraGeneration
      ? [first, { workflowId: `${WF}:r2`, generation: 2, runId: 'later-run', status: 'COMPLETED' }]
      : [first];
    const matched =
      current.status === 'COMPLETED' && current.runId === RUN && !current.resultThrows
        ? { ...first, result: resultOf(current.result) }
        : { ...first, result: null };
    if (current.status === 'COMPLETED' && current.runId === RUN) current.resultCalls += 1;
    return { generations, matched: generations.some((row) => row.workflowId === WF) ? matched : null };
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

  async function invoke(argv: string[], env: Record<string, string | undefined> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const store = createPgStore(t.db, { now: () => new Date('2026-10-19T02:00:00.000Z') });
    const real = portsFromParts({
      ledger: store,
      github: github(),
      execution: async () => execution(),
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
              if (current.reads === 2 && current.onSecondRead) await current.onSecondRead();
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
                await t.db.insert(runs).values({
                  id: 'c3114000-0000-4000-8000-000000000097',
                  segment: 'manual',
                  taskId: TASK,
                  issueNumber: 3114,
                  model: 'test',
                  startedAt: WHEN,
                  endedAt: WHEN,
                  outcome: 'done',
                  prNumber: 99999,
                  workflowId: WF,
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
    const values: Record<string, string> = {
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
      values.repo ?? '',
      values.issue ?? '',
      '--pr',
      values.pr ?? '',
      '--head',
      values.head ?? '',
      '--merge',
      values.merge ?? '',
      '--workflow',
      values.workflow ?? '',
      '--run',
      values.run ?? '',
      '--note',
      values.note ?? '',
      ...extra,
    ];
  }

  async function taskRow() {
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, TASK));
    return row;
  }

  async function audits() {
    return t.db.select().from(auditLog).where(eq(auditLog.action, 'task.correct-merged'));
  }

  it('预检不写；--apply 纠正并留下原 run、原 abandoned 结果和待验责任', async () => {
    const preview = await invoke(args());
    expect(preview.code).toBe(0);
    expect(preview.json?.status).toBe('precheck');
    expect(preview.json?.preview.proposed).toEqual({ state: 'done', phase: 'merged' });
    expect(preview.json?.text).not.toContain('closed');
    expect(current.casCalls).toBe(0);
    expect(current.reads).toBe(1);
    expect((await taskRow())?.state).toBe('stopped');

    current = world();
    const applied = await invoke(args(['--apply']));
    expect(applied.code).toBe(0);
    expect(applied.json?.status).toBe('corrected');
    expect(applied.json?.preview.execution?.outcome).toBe('abandoned');
    expect(current.resultCalls).toBe(2);
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

  it('事实不对、读不到、未授权、活着、换代都不写', async () => {
    const cases: {
      name: string;
      patch?: Record<string, string>;
      env?: Record<string, string | undefined>;
      prepare?: () => Promise<void> | void;
      fragment: string;
      open?: boolean;
    }[] = [
      { name: '未授权', env: { FLEET_OPS_OPERATOR: '' }, fragment: '未授权', open: false },
      { name: '错仓', patch: { repo: 'other/fleet-dao' }, fragment: '不属于这张单', open: false },
      { name: '错 PR', patch: { pr: '9999' }, fragment: '原执行的 PR', open: true },
      { name: '错 run', patch: { run: 'other-run-id' }, fragment: '错 run', open: true },
      {
        name: '还没合并',
        prepare: () => {
          current.pull = { ...(current.pull as object), merged: false };
        },
        fragment: '还没合并',
        open: true,
      },
      {
        name: '错 head',
        prepare: () => {
          current.pull = { ...(current.pull as object), head: { sha: 'a'.repeat(40) } };
        },
        fragment: '错 head',
        open: true,
      },
      {
        name: '错 merge',
        prepare: () => {
          current.pull = { ...(current.pull as object), merge_commit_sha: 'b'.repeat(40) };
        },
        fragment: '错 merge',
        open: true,
      },
      {
        name: '读不到',
        prepare: () => {
          current.throwRead = 'github down';
        },
        fragment: '读取事实没成',
        open: true,
      },
      {
        name: 'issue 不存在',
        prepare: () => {
          current.issue = null;
        },
        fragment: '读不到这张 issue',
        open: true,
      },
      {
        name: '编号其实是 PR',
        prepare: () => {
          current.issue = { number: 3114, pull_request: { url: 'https://example.test' } };
        },
        fragment: '这是 PR 不是 issue',
        open: true,
      },
      {
        name: '本机执行',
        prepare: async () => {
          await t.db.update(tasks).set({ executor: 'local' }).where(eq(tasks.id, TASK));
        },
        fragment: '本机执行',
        open: true,
      },
      {
        name: '活会话',
        prepare: async () => {
          await t.db.insert(runs).values({
            id: 'c3114000-0000-4000-8000-000000000001',
            segment: 'manual',
            taskId: TASK,
            issueNumber: 3114,
            model: 'test',
            startedAt: WHEN,
            workflowId: WF,
          });
        },
        fragment: '活跃会话',
        open: true,
      },
      {
        name: '仍在运行',
        prepare: () => {
          current.status = 'RUNNING';
        },
        fragment: '仍在运行',
        open: true,
      },
      {
        name: '结果读不到',
        prepare: () => {
          current.result = { outcome: 'abandoned' };
        },
        fragment: '原执行结果读不到',
        open: true,
      },
      {
        name: '镜像冲突',
        prepare: async () => {
          await t.db.insert(pullRequests).values({
            repoId: REPO_ID,
            number: 3137,
            state: 'merged',
            headRef: 'fleet/3114',
            headSha: 'c'.repeat(40),
            mergeSha: MERGE,
            updatedAt: WHEN,
            issueRefs: [3114],
          });
        },
        fragment: '镜像',
        open: true,
      },
      {
        name: '会话记了别的 run',
        prepare: async () => {
          await t.db.update(runs).set({ temporalRunId: 'other-run' }).where(eq(runs.id, RUN_ROW));
        },
        fragment: '无证据',
        open: true,
      },
      {
        name: '同一工作流另有不同 PR',
        prepare: async () => {
          await t.db.insert(runs).values({
            id: 'c3114000-0000-4000-8000-000000000099',
            segment: 'manual',
            taskId: TASK,
            issueNumber: 3114,
            model: 'test',
            startedAt: WHEN,
            endedAt: WHEN,
            outcome: 'done',
            prNumber: 99999,
            workflowId: WF,
          });
        },
        fragment: '歧义',
        open: true,
      },
      {
        name: '不是 abandoned',
        prepare: async () => {
          await t.db.update(tasks).set({ state: 'running', phase: null }).where(eq(tasks.id, TASK));
        },
        fragment: '不是误记',
        open: true,
      },
      {
        name: '没有更新时间',
        prepare: async () => {
          await t.db.update(tasks).set({ updatedAt: null }).where(eq(tasks.id, TASK));
        },
        fragment: '更新时间',
        open: true,
      },
      {
        name: 'done 但没有这次回执',
        prepare: async () => {
          await t.db.update(tasks).set({ state: 'done', phase: 'merged' }).where(eq(tasks.id, TASK));
        },
        fragment: '审计回执',
        open: true,
      },
    ];
    for (const item of cases) {
      await resetTestDb(t);
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
      await t.db.insert(runs).values({
        id: RUN_ROW,
        segment: 'manual',
        taskId: TASK,
        issueNumber: 3114,
        model: 'test',
        startedAt: WHEN,
        endedAt: WHEN,
        outcome: 'done',
        prNumber: 3137,
        workflowId: WF,
      });
      current = world();
      await item.prepare?.();
      const result = await invoke(args(['--apply'], item.patch), item.env);
      expect(result.code, item.name).toBe(1);
      expect(result.json?.status, item.name).toBe('refused');
      expect(result.json?.reason ?? result.json?.text, item.name).toContain(item.fragment);
      expect(current.casCalls, item.name).toBe(0);
      expect(current.opened, item.name).toBe(item.open ? 1 : 0);
      const row = await taskRow();
      expect(await audits(), item.name).toEqual([]);
      if (item.name === 'done 但没有这次回执') expect(row?.state, item.name).toBe('done');
      else if (item.name === '不是 abandoned') expect(row?.state, item.name).toBe('running');
      else {
        expect(row?.state, item.name).toBe('stopped');
        expect(row?.phase, item.name).toBe('abandoned');
      }
    }
  });

  it('已经纠正后再出现同一工作流的不同 PR，不能当成同一次成功', async () => {
    const applied = await invoke(args(['--apply']));
    expect(applied.code).toBe(0);
    expect(applied.json?.status).toBe('corrected');

    await t.db.insert(runs).values({
      id: 'c3114000-0000-4000-8000-000000000098',
      segment: 'manual',
      taskId: TASK,
      issueNumber: 3114,
      model: 'test',
      startedAt: WHEN,
      endedAt: WHEN,
      outcome: 'done',
      prNumber: 99999,
      workflowId: WF,
    });
    current = world();
    const preview = await invoke(args());
    expect(preview.code).toBe(1);
    expect(preview.json?.status).toBe('refused');
    expect(preview.json?.reason).toContain('歧义');
    expect(preview.json?.reason).toContain('不能当作同一次执行的证据');
    expect(current.casCalls).toBe(0);

    current = world();
    const again = await invoke(args(['--apply'], { note: '换一句原因' }));
    expect(again.code).toBe(1);
    expect(again.json?.status).toBe('refused');
    expect(again.json?.reason).toContain('歧义');
    expect(current.casCalls).toBe(0);
    const row = await taskRow();
    expect(row?.state).toBe('done');
    expect(row?.phase).toBe('merged');
    const recorded = await audits();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.reason).toContain('合成的 #3114 反例');
    const kept = await t.db.select().from(runs).where(eq(runs.taskId, TASK));
    expect(kept).toHaveLength(2);
    expect(kept.every((run) => run.outcome === 'done')).toBe(true);
  });

  it('二次读取之后才出现冲突会话，事务拒绝且不写任务和审计', async () => {
    current.conflictOnCas = true;
    const result = await invoke(args(['--apply']));
    expect(result.code).toBe(1);
    expect(result.json?.reason).toContain('变了');
    expect(current.reads).toBe(2);
    expect(current.casCalls).toBe(1);
    const row = await taskRow();
    expect(row?.state).toBe('stopped');
    expect(row?.phase).toBe('abandoned');
    expect(row?.updatedAt?.toISOString()).toBe(WHEN.toISOString());
    expect(await audits()).toEqual([]);
    const changes = await t.db.select().from(stateChanges).where(eq(stateChanges.taskId, TASK));
    expect(changes.some((change) => change.toState === 'done')).toBe(false);
    const kept = await t.db.select().from(runs).where(eq(runs.taskId, TASK));
    expect(kept.map((run) => run.prNumber).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([3137, 99999]);
  });

  it('第二次读到活会话或新一代就拒绝，不覆盖', async () => {
    current.onSecondRead = async () => {
      await t.db.insert(runs).values({
        id: 'c3114000-0000-4000-8000-000000000002',
        segment: 'manual',
        taskId: TASK,
        issueNumber: 3114,
        model: 'test',
        startedAt: WHEN,
        workflowId: WF,
      });
    };
    const live = await invoke(args(['--apply']));
    expect(live.code).toBe(1);
    expect(live.json?.reason).toContain('活跃会话');
    expect(current.casCalls).toBe(0);
    expect((await taskRow())?.state).toBe('stopped');

    await t.db.delete(runs).where(eq(runs.id, 'c3114000-0000-4000-8000-000000000002'));
    current = world();
    current.onSecondRead = async () => {
      current.extraGeneration = true;
    };
    const next = await invoke(args(['--apply']));
    expect(next.code).toBe(1);
    expect(next.json?.reason).toContain('新的一代');
    expect(current.casCalls).toBe(0);
    expect((await taskRow())?.phase).toBe('abandoned');
  });

  it('核对之后更新时间被别人改了，事务回 stale，不写成 done', async () => {
    current.wrapCas = true;
    const result = await invoke(args(['--apply']));
    expect(result.code).toBe(1);
    expect(result.json?.reason).toContain('变了');
    const row = await taskRow();
    expect(row?.state).toBe('stopped');
    expect(row?.phase).toBe('abandoned');
    expect(await audits()).toEqual([]);
  });

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
      const row = await taskRow();
      expect(row?.state).toBe('stopped');
      expect(row?.phase).toBe('abandoned');
      expect(await audits()).toEqual([]);
      const changes = await t.db.select().from(stateChanges).where(eq(stateChanges.taskId, TASK));
      expect(changes.some((change) => change.toState === 'done')).toBe(false);
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
  if (
    typeof row.outcome !== 'string' ||
    typeof prNumber !== 'number' ||
    !Number.isInteger(prNumber) ||
    typeof row.head !== 'string'
  ) {
    return null;
  }
  return { outcome: row.outcome, prNumber, head: row.head };
}
