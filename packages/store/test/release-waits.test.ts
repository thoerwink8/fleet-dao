// 合并后等发版那一段等待（step_timings 的 wait 行，release-waits.ts，决定 0093）：认「随哪一版上线」的判法（firstLiveAt）、
// 记一笔的形状、去重、认不出不记、读不到状态文件不记。假日志、假库（PGlite 或真 PG 都行）。
import {
  type Db,
  mergesAwaitingReleaseWait,
  pullRequests,
  RELEASE_WAIT,
  repos,
  runs,
  stepTimings,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeployLagState } from '../src/deploy-lag.ts';
import { firstLiveAt, type ReleaseWaitDeps, recordReleaseWaitsOnce } from '../src/release-waits.ts';

const H0 = 'a'.repeat(40);
const H1 = 'b'.repeat(40);
const H2 = 'c'.repeat(40);
const HX = 'd'.repeat(40);
const NOW = new Date('2026-10-14T12:00:00Z');
const MIN = 60_000;
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

/** 主线：H2 现在、H1 一小时前、H0 两小时前（新的在前）。 */
const commits: [string, string][] = [
  [H2, at(0)],
  [H1, at(60 * MIN)],
  [H0, at(120 * MIN)],
];

const state = (): DeployLagState =>
  ({
    schema: 1,
    ranAt: at(2 * MIN),
    main: { checkedAt: at(2 * MIN), head: H2, headAt: at(0), commits },
    mainError: null,
    ci: { sha: H2, verdict: 'green', detail: 'CI 全绿', checkedAt: at(2 * MIN) },
    rules: { commit: H2, at: at(2 * MIN), result: 'ok', detail: '' },
    tier: null,
    system: { appliedSha: H2, behind: 0, oldestAt: null },
    last: { action: 'up-to-date', detail: '', at: at(2 * MIN) },
  }) as DeployLagState;

describe('认「随哪一版上线」', () => {
  it('合并提交比切上去的那版新 → 那一版带上了它，回那一版切上去的时刻', () => {
    const history = [`${at(70 * MIN)} ${H0} release`, `${at(30 * MIN)} ${H1} release`].join('\n');
    expect(firstLiveAt(history, commits, H1)).toBe(at(30 * MIN));
    // 合得更晚的：只有更晚那一版带得上
    expect(firstLiveAt(history, commits, H2)).toBeNull();
  });

  it('按发布历史从早到晚取第一行：中间发过几版取最早带上的那一次', () => {
    const history = [
      `${at(70 * MIN)} ${H0} release`,
      `${at(40 * MIN)} ${H1} release`,
      `${at(30 * MIN)} ${H1} release`,
    ].join('\n');
    expect(firstLiveAt(history, commits, H1)).toBe(at(40 * MIN));
  });

  it('老版本回滚不算「上线」之后又上线：回滚行照收（它也是切上去的一版）', () => {
    // 回到老版本那一版（H0）也带上了它，但那一版更早
    const history = [`${at(70 * MIN)} ${H1} release`, `${at(30 * MIN)} ${H0} rollback`].join('\n');
    expect(firstLiveAt(history, commits, H1)).toBe(at(70 * MIN));
  });

  it('合并提交或那一版不在最近的提交里、还没上线、时间认不出：都不记，不拿先后猜', () => {
    expect(firstLiveAt(`${at(30 * MIN)} ${H1} release`, commits, HX)).toBeNull();
    expect(firstLiveAt(`${at(30 * MIN)} ${HX} release`, commits, H1)).toBeNull();
    expect(firstLiveAt('', commits, H1)).toBeNull();
    expect(firstLiveAt(`${at(30 * MIN)} ${H1} release`, commits, H1)).toBe(at(30 * MIN));
    expect(firstLiveAt(`不是时间 ${H1} release`, commits, H1)).toBeNull();
    // 别的事件行（清目录之类）不是切上去
    expect(firstLiveAt(`${at(30 * MIN)} ${H1} prune`, commits, H1)).toBeNull();
  });
});

describe('记一笔等发版', () => {
  let t: TestDb;
  let repoId: string;
  let taskId: string;
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'o', name: 'r', testCommand: 'true' })
      .returning({ id: repos.id });
    repoId = repo?.id ?? '';
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId,
        issueNumber: 12,
        title: '一张单',
        rawRequest: '就这样',
        requestedBy: '人',
        priority: 1,
      })
      .returning({ id: tasks.id });
    taskId = task?.id ?? '';
  });

  async function mergedPr(input: { number: number; mergeSha: string; mergedAt: Date }) {
    await t.db.insert(pullRequests).values({
      repoId,
      number: input.number,
      state: 'merged',
      headRef: `b${input.number}`,
      headSha: 'e'.repeat(40),
      updatedAt: input.mergedAt,
      mergedAt: input.mergedAt,
      mergeSha: input.mergeSha,
      issueRefs: [12],
    });
  }

  const deps = (history: string, over: Partial<ReleaseWaitDeps> = {}): ReleaseWaitDeps => ({
    db: t.db as Db,
    read: () => ({ state: state() }),
    history: () => history,
    now: () => NOW,
    log,
    ...over,
  });

  it('合进主线、跟随下一版上线：记一笔 started_at = 合并时刻、ended_at = 上线时刻', async () => {
    await mergedPr({ number: 12, mergeSha: H1, mergedAt: new Date(at(60 * MIN)) });
    await t.db.insert(runs).values({
      id: crypto.randomUUID(),
      segment: 'manual',
      taskId,
      model: 'opus-5.5',
      prNumber: 12,
      startedAt: new Date(at(90 * MIN)),
    });
    const history = `${at(70 * MIN)} ${H0} release\n${at(30 * MIN)} ${H1} release`;
    expect(await recordReleaseWaitsOnce(deps(history))).toBe(1);
    const rows = await t.db.select().from(stepTimings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'wait',
      waitFor: RELEASE_WAIT.waitFor,
      temporalRunId: H1,
      endedAt: new Date(at(30 * MIN)),
      startedAt: new Date(at(60 * MIN)),
      waitMs: 30 * MIN,
      // 动手段记了这个 PR 号 → 认得出是哪张单
      taskId,
    });
    expect(rows[0]?.detail).toContain('PR #12');
    // 再跑一轮：不再记第二笔
    expect(await recordReleaseWaitsOnce(deps(history))).toBe(0);
    expect(await t.db.select().from(stepTimings)).toHaveLength(1);
  });

  it('还没上线、状态文件读不到、合并提交认不出：一笔都不记', async () => {
    await mergedPr({ number: 12, mergeSha: H1, mergedAt: new Date(at(60 * MIN)) });
    expect(await recordReleaseWaitsOnce(deps(''))).toBe(0);
    expect(await t.db.select().from(stepTimings)).toHaveLength(0);
    expect(await recordReleaseWaitsOnce(deps(`${at(30 * MIN)} ${H0} release`))).toBe(0);
    expect(await t.db.select().from(stepTimings)).toHaveLength(0);
    const broken = { ...deps(''), read: () => ({ state: { error: '没装' } }) };
    expect(await recordReleaseWaitsOnce(broken)).toBe(0);
    expect(await t.db.select().from(stepTimings)).toHaveLength(0);
  });

  it('合并时刻比切上去还晚（钟差）：记 0，不记负的', async () => {
    await mergedPr({ number: 13, mergeSha: H1, mergedAt: new Date(at(20 * MIN)) });
    const history = `${at(30 * MIN)} ${H1} release`;
    expect(await recordReleaseWaitsOnce(deps(history))).toBe(1);
    const [row] = await t.db.select().from(stepTimings);
    expect(row?.waitMs).toBe(0);
    expect(row?.startedAt).toEqual(row?.endedAt);
  });
});

describe('找还没记过的合并', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  it('记过的、没合的、比窗口老的、不在名单里的都不回', async () => {
    await resetTestDb(t);
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'o', name: 'r', testCommand: 'true' })
      .returning({ id: repos.id });
    const repoId = repo?.id ?? '';
    for (const p of [
      { number: 1, mergeSha: H0, mergedAt: new Date(at(10 * MIN)) },
      { number: 2, mergeSha: H1, mergedAt: new Date(at(10 * MIN)) },
      { number: 3, mergeSha: H2, mergedAt: new Date(at(20 * 24 * 60 * MIN)) },
    ]) {
      await t.db.insert(pullRequests).values({
        repoId,
        number: p.number,
        state: 'merged',
        headRef: `b${p.number}`,
        headSha: 'e'.repeat(40),
        updatedAt: p.mergedAt,
        mergedAt: p.mergedAt,
        mergeSha: p.mergeSha,
        issueRefs: [],
      });
    }
    await t.db.insert(stepTimings).values({
      kind: 'wait',
      workflowId: RELEASE_WAIT.workflowId,
      temporalRunId: H0,
      workflowType: RELEASE_WAIT.workflowType,
      waitFor: RELEASE_WAIT.waitFor,
      detail: '记过了',
      startedAt: new Date(at(60 * MIN)),
      endedAt: new Date(at(30 * MIN)),
      waitMs: 30 * MIN,
    });
    const found = await mergesAwaitingReleaseWait(t.db, {
      mergeShas: [H0, H1, H2],
      mergedAfter: new Date(NOW.getTime() - 7 * 24 * 60 * MIN),
    });
    expect(found.map((m) => m.number)).toEqual([2]);
    expect(found[0]).toMatchObject({ mergeSha: H1, repoId });
  });
});
