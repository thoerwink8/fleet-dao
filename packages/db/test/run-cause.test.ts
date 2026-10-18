// 每一笔会话为什么起、属于第几个回合、冷验收结论，一轮的开始和返工摘要，PR 头的文件清单（#3140）。
import { randomUUID } from 'node:crypto';
import { RUN_CAUSE_SUMMARY_MAX, RUN_CAUSES } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordTaskRound } from '../src/queries/pipeline-health.ts';
import { PR_HEAD_FILES_MAX, readLatestPrHeadFiles, recordPrHeadFiles } from '../src/queries/pr-head-files.ts';
import { getRun, noteRunVerdict, startRun } from '../src/queries/runs.ts';
import { prHeadFiles, runs, taskRounds } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, catalog, expectViolation, MIN } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
});

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

describe('runs 的起因、摘要、回合', () => {
  it('shared 的起因名单和库里的约束一字不差：名单里的都写得进，名单外的被挡', async () => {
    for (const cause of RUN_CAUSES) {
      await startRun(t.db, { segment: 'manual', model: 'opus-5.5', cause });
    }
    await expectViolation(
      t.db
        .insert(runs)
        .values({ segment: 'manual', model: 'opus-5.5', startedAt: ago(MIN), cause: 'nope' as never }),
      'runs_cause_known',
    );
  });

  it('开跑写的起因、摘要、回合，收场那一笔没带就留着；摘要写之前截到 500 字；回合号要是正数', async () => {
    const id = randomUUID();
    const long = '为'.repeat(900);
    await startRun(t.db, {
      id,
      segment: 'manual',
      model: 'opus-5.5',
      startedAt: ago(MIN),
      cause: 'rework_ci',
      causeSummary: long,
      roundSeq: 2,
    });
    const opened = await getRun(t.db, id);
    expect(opened).toMatchObject({ cause: 'rework_ci', roundSeq: 2 });
    expect(opened?.causeSummary?.length).toBe(RUN_CAUSE_SUMMARY_MAX);
    expect(opened?.causeSummary?.endsWith('…')).toBe(true);
    // 收场整行覆盖：这一笔没带起因，不把开跑写的冲成空
    await startRun(t.db, {
      id,
      segment: 'manual',
      model: 'opus-5.5',
      startedAt: ago(MIN),
      endedAt: ago(0),
      outcome: 'done',
    });
    expect(await getRun(t.db, id)).toMatchObject({ cause: 'rework_ci', roundSeq: 2, outcome: 'done' });
    await expectViolation(
      t.db.insert(runs).values({ segment: 'manual', model: 'opus-5.5', startedAt: ago(MIN), roundSeq: 0 }),
      'runs_round_seq_positive',
    );
    await expectViolation(
      t.db
        .insert(runs)
        .values({ segment: 'manual', model: 'opus-5.5', startedAt: ago(MIN), causeSummary: 'x'.repeat(501) }),
      'runs_cause_summary_short',
    );
  });

  it('老行和不经任务工作流的会话：起因、摘要、回合、结论都是空，不拿默认值顶', async () => {
    const id = randomUUID();
    await startRun(t.db, { id, segment: 'scope', model: 'opus-5.5' });
    expect(await getRun(t.db, id)).toMatchObject({
      cause: null,
      causeSummary: null,
      roundSeq: null,
      verdict: null,
    });
  });
});

describe('冷验收的结论（runs.verdict）', () => {
  it('写在验收那一笔上，读回来一样；再写以最后一次为准；收场时的整行覆盖不冲掉它', async () => {
    const id = randomUUID();
    await startRun(t.db, {
      id,
      segment: 'verify',
      model: 'gpt-5.6',
      startedAt: ago(MIN),
      endedAt: ago(0),
      outcome: 'done',
    });
    await noteRunVerdict(t.db, id, {
      pass: false,
      problems: ['第 2 条没做到'],
      failedCriteria: [2],
      handedOver: ['截图要人看'],
    });
    expect((await getRun(t.db, id))?.verdict).toEqual({
      pass: false,
      problems: ['第 2 条没做到'],
      failedCriteria: [2],
      handedOver: ['截图要人看'],
    });
    // 重放的收场不带结论，库里已有的留着
    await startRun(t.db, {
      id,
      segment: 'verify',
      model: 'gpt-5.6',
      startedAt: ago(MIN),
      endedAt: ago(0),
      outcome: 'done',
    });
    expect((await getRun(t.db, id))?.verdict?.pass).toBe(false);
    await noteRunVerdict(t.db, id, { pass: true, problems: [], failedCriteria: [], handedOver: [] });
    expect((await getRun(t.db, id))?.verdict).toMatchObject({ pass: true });
  });

  it('【故意造出的失败】形状不对、这一笔不在库里：抛出来，不悄悄丢', async () => {
    await expect(
      noteRunVerdict(t.db, randomUUID(), { pass: true, problems: [], failedCriteria: [], handedOver: [] }),
    ).rejects.toThrow('库里没有这一笔');
    const id = randomUUID();
    await startRun(t.db, { id, segment: 'verify', model: 'gpt-5.6' });
    await expect(noteRunVerdict(t.db, id, { pass: 'yes' } as never)).rejects.toThrow('形状不对');
  });
});

describe('task_rounds：一轮的开始时刻和返工摘要', () => {
  it('带上就写，截到 500 字；不带是空（老写法）', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const base = { taskId: task.id, workflowId: 'wf', round: 1, outcome: 'ci_red' as const };
    await recordTaskRound(t.db, {
      ...base,
      seq: 1,
      startedAt: ago(10 * MIN),
      reworkSummary: '检查红了：test'.repeat(80),
    });
    await recordTaskRound(t.db, { ...base, seq: 2, outcome: 'merged' });
    const rows = await t.db.select().from(taskRounds).orderBy(taskRounds.seq);
    expect(rows[0]?.startedAt?.getTime()).toBe(ago(10 * MIN).getTime());
    expect(rows[0]?.reworkSummary?.length).toBe(RUN_CAUSE_SUMMARY_MAX);
    expect(rows[1]).toMatchObject({ startedAt: null, reworkSummary: null });
    await expectViolation(
      t.db
        .update(taskRounds)
        .set({ reworkSummary: 'x'.repeat(501) })
        .where(eq(taskRounds.seq, 2)),
      'task_rounds_rework_summary_short',
    );
  });
});

describe('pr_head_files：按头记 numstat', () => {
  async function pr() {
    const repo = await addRepo(t.db);
    return { repoId: repo.id, prNumber: 7 };
  }

  it('一个头一次写全；同键再写跳过、不改；二进制没有行数；读最新那个头的清单', async () => {
    const key = await pr();
    expect(await readLatestPrHeadFiles(t.db, key.repoId, key.prNumber)).toBeNull();
    const first = await recordPrHeadFiles(t.db, {
      ...key,
      headSha: HEAD_A,
      files: [
        { path: 'b.ts', added: 3, removed: 1, binary: false },
        { path: 'a.png', added: null, removed: null, binary: true },
      ],
    });
    expect(first).toEqual({ written: 2, truncated: false });
    // 活动重试：同一个头再写，不重复、不改
    await recordPrHeadFiles(t.db, {
      ...key,
      headSha: HEAD_A,
      files: [{ path: 'b.ts', added: 99, removed: 99, binary: false }],
    });
    const a = await readLatestPrHeadFiles(t.db, key.repoId, key.prNumber);
    expect(a?.headSha).toBe(HEAD_A);
    expect(a?.files).toEqual([
      { path: 'a.png', added: null, removed: null, binary: true },
      { path: 'b.ts', added: 3, removed: 1, binary: false },
    ]);
    // 推了新头：读最新那个头，旧头的行不混着加
    await t.db
      .update(prHeadFiles)
      .set({ recordedAt: ago(5 * MIN) })
      .where(eq(prHeadFiles.headSha, HEAD_A));
    await recordPrHeadFiles(t.db, {
      ...key,
      headSha: HEAD_B,
      files: [{ path: 'c.ts', added: 1, removed: 0, binary: false }],
    });
    const b = await readLatestPrHeadFiles(t.db, key.repoId, key.prNumber);
    expect(b).toEqual({ headSha: HEAD_B, files: [{ path: 'c.ts', added: 1, removed: 0, binary: false }] });
  });

  it('超过上限只记前面的并说明截断；空清单不写；库里的形状约束', async () => {
    const key = await pr();
    const many = Array.from({ length: PR_HEAD_FILES_MAX + 2 }, (_, i) => ({
      path: `f${String(i).padStart(4, '0')}.ts`,
      added: 1,
      removed: 0,
      binary: false,
    }));
    expect(await recordPrHeadFiles(t.db, { ...key, headSha: HEAD_A, files: many })).toEqual({
      written: PR_HEAD_FILES_MAX,
      truncated: true,
    });
    expect(await recordPrHeadFiles(t.db, { ...key, headSha: HEAD_B, files: [] })).toEqual({
      written: 0,
      truncated: false,
    });
    expect(await readLatestPrHeadFiles(t.db, key.repoId, key.prNumber)).toMatchObject({ headSha: HEAD_A });
    // 二进制不能带行数、文本一定要有行数、头必须是完整提交号
    await expectViolation(
      t.db
        .insert(prHeadFiles)
        .values({ ...key, headSha: HEAD_B, path: 'x', binary: true, added: 1, removed: 0 }),
      'pr_head_files_binary_shape',
    );
    await expectViolation(
      t.db.insert(prHeadFiles).values({ ...key, headSha: HEAD_B, path: 'y', binary: false }),
      'pr_head_files_binary_shape',
    );
    await expectViolation(
      t.db
        .insert(prHeadFiles)
        .values({ ...key, headSha: 'abc', path: 'z', binary: false, added: 0, removed: 0 }),
      'pr_head_files_head_sha_shape',
    );
  });
});
