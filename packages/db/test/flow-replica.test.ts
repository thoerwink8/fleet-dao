// 流程配置副本（repos 表的 flow_* 列）和会话记下的测试命令（session_runs.test_command）：写入口照着写、库的约束兜住
// 写坏了的形状；会话那一行记的是真起来的那次被交代的命令。
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markSessionRunStarted, openSessionRun } from '../src/queries/engine.ts';
import { listFlowReplicas, writeFlowReplica } from '../src/queries/flow.ts';
import { repos, sessionRuns } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addTask, catalog, expectViolation, later, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const rowOf = async (id: string) => (await t.db.select().from(repos).where(eq(repos.id, id)))[0];

describe('writeFlowReplica', () => {
  it('读成、认得出：整份写进去，清掉出错和没查成；配置里有测试命令就顺带改给人看的 test_command', async () => {
    const repo = await addRepo(t.db, 'shop');
    await writeFlowReplica(t.db, repo.id, { write: 'unread', why: 'GitHub 回 502' }, NOW);
    expect(
      await writeFlowReplica(
        t.db,
        repo.id,
        {
          write: 'synced',
          config: { formatVersion: 1, testCommand: 'pnpm test:changed' },
          source: 'project',
          commit: C1,
          testCommand: 'pnpm test:changed',
        },
        later(MIN),
      ),
    ).toBe('ok');
    expect(await rowOf(repo.id)).toMatchObject({
      testCommand: 'pnpm test:changed',
      flowConfig: { formatVersion: 1, testCommand: 'pnpm test:changed' },
      flowSource: 'project',
      flowCommit: C1,
      flowSyncedAt: later(MIN),
      flowCheckedAt: later(MIN),
      flowError: null,
      flowUnread: null,
    });
    const [listed] = await listFlowReplicas(t.db);
    expect(listed).toMatchObject({ repoId: repo.id, testCommand: 'pnpm test:changed', source: 'project' });
  });

  it('用全组织默认（项目没写测试命令）：副本里没有测试命令，给人看的 test_command 不动', async () => {
    const repo = await addRepo(t.db, 'shop');
    await writeFlowReplica(
      t.db,
      repo.id,
      { write: 'synced', config: { formatVersion: 1 }, source: 'org_default', commit: C1, testCommand: null },
      NOW,
    );
    expect(await rowOf(repo.id)).toMatchObject({ testCommand: 'pnpm check', flowSource: 'org_default' });
    expect((await listFlowReplicas(t.db))[0]?.testCommand).toBeNull();
  });

  it('【失败】认不出：只记原因（停派），配置、测试命令、同步时刻都不动', async () => {
    const repo = await addRepo(t.db, 'shop');
    const synced = {
      write: 'synced' as const,
      config: { formatVersion: 1, testCommand: 'pnpm test:changed' },
      source: 'project' as const,
      commit: C1,
      testCommand: 'pnpm test:changed',
    };
    await writeFlowReplica(t.db, repo.id, synced, NOW);
    await writeFlowReplica(
      t.db,
      repo.id,
      { write: 'invalid', why: '项目配置：不是 JSON（提交 2222222）' },
      later(MIN),
    );
    expect(await rowOf(repo.id)).toMatchObject({
      testCommand: 'pnpm test:changed',
      flowConfig: synced.config,
      flowCommit: C1,
      flowSyncedAt: NOW,
      flowError: '项目配置：不是 JSON（提交 2222222）',
      flowCheckedAt: later(MIN),
    });
    // 改好了再读成：出错清掉、换成新提交
    await writeFlowReplica(t.db, repo.id, { ...synced, commit: C2 }, later(2 * MIN));
    expect(await rowOf(repo.id)).toMatchObject({ flowError: null, flowCommit: C2 });
  });

  it('【失败】没查成：什么都不动，只记这一次的原因和时刻', async () => {
    const repo = await addRepo(t.db, 'shop');
    await writeFlowReplica(
      t.db,
      repo.id,
      { write: 'synced', config: { formatVersion: 1 }, source: 'org_default', commit: C1, testCommand: null },
      NOW,
    );
    const before = await rowOf(repo.id);
    await writeFlowReplica(t.db, repo.id, { write: 'unread', why: 'GitHub 回 502' }, later(MIN));
    const after = await rowOf(repo.id);
    expect(after).toEqual({ ...before, flowUnread: 'GitHub 回 502', flowCheckedAt: later(MIN) });
  });

  it('【失败】仓不在（列出来之后删了）：回 not_found，不装作写上了', async () => {
    expect(await writeFlowReplica(t.db, randomUUID(), { write: 'unread', why: 'x' }, NOW)).toBe('not_found');
  });
});

describe('副本的约束：写坏了的形状进不了库', () => {
  it('【失败】有配置却没有同步时刻、提交、来源（四样要么都有要么都没有）', async () => {
    const repo = await addRepo(t.db, 'shop');
    await expectViolation(
      t.db
        .update(repos)
        .set({ flowConfig: { formatVersion: 1 } })
        .where(eq(repos.id, repo.id)),
      'repos_flow_synced_together',
    );
  });

  it('【失败】来源认不出、原因是空串', async () => {
    const repo = await addRepo(t.db, 'shop');
    await expectViolation(
      t.client.query(`update repos set flow_source = 'guess' where id = $1`, [repo.id]),
      'repos_flow_source_known',
    );
    await expectViolation(
      t.db.update(repos).set({ flowError: '' }).where(eq(repos.id, repo.id)),
      'repos_flow_reasons_not_blank',
    );
    await expectViolation(
      t.db.update(repos).set({ flowUnread: '' }).where(eq(repos.id, repo.id)),
      'repos_flow_reasons_not_blank',
    );
  });

  it('【失败】副本里的测试命令是空串或不是字符串（起会话、交活就没法照它交代、核对）', async () => {
    const repo = await addRepo(t.db, 'shop');
    const synced = (config: Record<string, unknown>) =>
      t.db
        .update(repos)
        .set({ flowConfig: config, flowSource: 'project', flowCommit: C1, flowSyncedAt: NOW })
        .where(eq(repos.id, repo.id));
    await expectViolation(synced({ formatVersion: 1, testCommand: '' }), 'repos_flow_config_shape');
    await expectViolation(synced({ formatVersion: 1, testCommand: 42 }), 'repos_flow_config_shape');
    await expectViolation(
      t.client.query(
        `update repos set flow_config = '[]'::jsonb, flow_source = 'project', flow_commit = $2, flow_synced_at = now() where id = $1`,
        [repo.id, C1],
      ),
      'repos_flow_config_shape',
    );
    await synced({ formatVersion: 1 });
    await synced({ formatVersion: 1, testCommand: 'pnpm test:changed' });
  });
});

describe('会话那一行记下交代的测试命令', () => {
  beforeEach(async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
  });

  async function open(id: string, taskId: string, testCommand: string | null) {
    return openSessionRun(t.db, {
      id,
      taskId,
      subtaskId: null,
      stage: 'execute',
      routeId: 'r1',
      whyRoute: '首选',
      branch: 'fleet/1-x',
      queuedAt: NOW,
      workflowId: null,
      runAsUser: 'fleet-agent-carpool',
      worktreePath: '/work/x',
      testCommand,
    });
  }

  it('起会话时记下；同一个 runId 上一次没起来（没开工）就改成这一次交代的；已经开工的不改', async () => {
    const repo = await addRepo(t.db, 'shop');
    const task = await addTask(t.db, repo.id);
    const id = randomUUID();
    expect(await open(id, task.id, 'pnpm check')).toMatchObject({
      created: true,
      run: { testCommand: 'pnpm check' },
    });
    // 上一次尝试没把会话起来，这一次按改过的副本交代：记的必须是真起来的这次被告知的
    expect(await open(id, task.id, 'pnpm test:changed')).toMatchObject({
      created: false,
      run: { testCommand: 'pnpm test:changed' },
    });
    await markSessionRunStarted(t.db, { id, startedAt: later(MIN), sessionId: 's1', handle: null });
    expect(await open(id, task.id, 'pnpm other')).toMatchObject({
      created: false,
      run: { testCommand: 'pnpm test:changed', sessionId: 's1' },
    });
  });

  it('不写码的阶段项目没写测试命令：记成空；空串进不了库', async () => {
    const repo = await addRepo(t.db, 'shop');
    const task = await addTask(t.db, repo.id);
    expect((await open(randomUUID(), task.id, null)).run.testCommand).toBeNull();
    await expectViolation(open(randomUUID(), task.id, ''), 'session_runs_test_command_not_blank');
    const rows = await t.db.select().from(sessionRuns);
    expect(rows.map((r) => r.testCommand)).toEqual([null]);
  });
});
