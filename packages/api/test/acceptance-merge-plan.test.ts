// #3207 第 1 片：历史验收责任归并的只读预检。真实迁移的测试库，断言不写表、拒绝原因、两类原项逐项留来源。
import {
  acceptanceDuties,
  acceptanceDutySupersessions,
  pullRequests,
  repos,
  runs,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAcceptanceArgs, planAcceptanceMerge } from '../src/acceptance-cli.ts';
import { type CliDeps, main } from '../src/cli.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const FINAL = 'f0f325aac789501574583653d4588c9faf2a6f53';
const MERGE = '52fc610a270b7288073159a679aaa2d7df8e0132';
const STALE_MERGE = '1'.repeat(40);
const CHECK = '最终检查项：pnpm check 全绿';
const HISTORY = '历史要求：旧头现场截图';

async function seed() {
  const [repo] = await t.db
    .insert(repos)
    .values({ owner: 'o', name: 'r', testCommand: 'pnpm check' })
    .returning();
  if (!repo) throw new Error('repo seed failed');
  const [task] = await t.db
    .insert(tasks)
    .values({
      repoId: repo.id,
      issueNumber: 3090,
      title: '换头的单',
      rawRequest: '验收',
      requestedBy: 'frank',
      priority: 1,
    })
    .returning();
  if (!task) throw new Error('task seed failed');
  await t.db.insert(runs).values({
    segment: 'manual',
    model: 'm',
    startedAt: new Date('2026-10-01T00:00:00Z'),
    taskId: task.id,
    issueNumber: 3090,
    workflowId: 'wf-3090',
    temporalRunId: 'run-3090',
  });
  await t.db.insert(pullRequests).values({
    repoId: repo.id,
    number: 3104,
    state: 'merged',
    headRef: 'fleet/3090',
    headSha: FINAL,
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    mergedAt: new Date('2026-10-02T00:00:00Z'),
    mergeSha: MERGE,
  });
  // 旧行带着一个「历史 merge 字段」：预检不能拿它证明旧头合并过
  const duty = async (head: string, items: string[]) => {
    const [r] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: task.id,
        repo: 'o/r',
        issueNumber: 3090,
        prNumber: 3104,
        head,
        items,
        mergeCommit: STALE_MERGE,
      })
      .returning();
    if (!r) throw new Error('duty seed failed');
    return r;
  };
  const d23 = await duty('a'.repeat(40), [CHECK, HISTORY]);
  const d24 = await duty('b'.repeat(40), [CHECK]);
  const d32 = await duty('c'.repeat(40), [CHECK]);
  const input = {
    action: 'merge-plan',
    repo: 'o/r',
    issueNumber: 3090,
    taskId: task.id,
    workflowId: 'wf-3090',
    temporalRunId: 'run-3090',
    prNumber: 3104,
    head: FINAL,
    mergeCommit: MERGE,
    duties: [d23, d24, d32].map((d) => ({ id: d.id, generation: d.generation })),
  } as const;
  return { repo, task, d23, d24, d32, input };
}

const snapshot = async () =>
  JSON.stringify([
    await t.db.select().from(acceptanceDuties),
    await t.db.select().from(acceptanceDutySupersessions),
    await t.db.select().from(pullRequests),
    await t.db.select().from(runs),
    await t.db.select().from(tasks),
  ]);

/** 任何写入口都抛：预检只许读。 */
const readOnly = (db: TestDb['db']) =>
  new Proxy(db, {
    get(target, prop) {
      if (['insert', 'update', 'delete', 'transaction', 'execute'].includes(String(prop)))
        throw new Error(`预检不许写：${String(prop)}`);
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

const reasons = (plan: Awaited<ReturnType<typeof planAcceptanceMerge>>) =>
  plan.rejections.map((r) => r.reason).join('\n');

describe('acceptance merge-plan 只读预检', () => {
  it('#23 两项、#24/#32 只有最终检查项：两类原项都在、逐项写来源、历史要求不被揉掉，且不写任何表', async () => {
    const { d23, d24, d32, input } = await seed();
    const before = await snapshot();
    const plan = await planAcceptanceMerge(readOnly(t.db), input);
    expect(await snapshot()).toBe(before);
    expect(plan.ok).toBe(true);
    expect(plan.rejections).toEqual([]);
    expect(plan.duties.map((d) => [d.id, d.generation, d.head])).toEqual(
      [d23, d24, d32].map((d) => [d.id, d.generation, d.head]),
    );
    expect(plan.target).toMatchObject({ prNumber: 3104, head: FINAL, mergeCommit: MERGE, existing: null });
    const source = (item: string) => plan.target.items.find((i) => i.item === item)?.sources.map((s) => s.id);
    expect(plan.target.items).toHaveLength(2);
    expect(source(HISTORY)).toEqual([d23.id]);
    expect(source(CHECK)).toEqual([d23.id, d24.id, d32.id]);
  });

  it('最终头上已有责任行时一并报出，它的项也记来源', async () => {
    const { task, input } = await seed();
    const [existing] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: task.id,
        repo: 'o/r',
        issueNumber: 3090,
        prNumber: 3104,
        head: FINAL,
        items: ['最终头新增项'],
      })
      .returning();
    if (!existing) throw new Error('seed failed');
    const plan = await planAcceptanceMerge(readOnly(t.db), input);
    expect(plan.ok).toBe(true);
    expect(plan.target.existing).toMatchObject({ id: existing.id, generation: 1, head: FINAL });
    expect(plan.target.items.find((i) => i.item === '最终头新增项')?.sources).toMatchObject([
      { id: existing.id, existingTarget: true },
    ]);
  });

  const cases: [string, (s: Awaited<ReturnType<typeof seed>>) => Promise<object>, string][] = [
    ['错仓', async () => ({ repo: 'o/other' }), '错仓'],
    ['错单', async () => ({ issueNumber: 3091 }), '错单'],
    ['错任务', async () => ({ taskId: '00000000-0000-4000-8000-000000000001' }), '错任务'],
    ['错 run', async () => ({ temporalRunId: 'run-other' }), '错 run'],
    ['错 workflow', async () => ({ workflowId: 'wf-other' }), '错 run'],
    ['头对不上', async () => ({ head: 'd'.repeat(40) }), '头对不上'],
    [
      'PR 未合（旧行的历史 merge 字段不算数）',
      async (s) => {
        await t.db
          .update(pullRequests)
          .set({ state: 'open', mergeSha: null, mergedAt: null })
          .where(eq(pullRequests.repoId, s.repo.id));
        return {};
      },
      'PR 未合',
    ],
    [
      '回执未知：PR 镜像读不到（旧行的历史 merge 字段不算数）',
      async (s) => {
        await t.db.delete(pullRequests).where(eq(pullRequests.repoId, s.repo.id));
        return {};
      },
      '回执未知',
    ],
    [
      '回执未知：已合没有合并提交',
      async (s) => {
        await t.db.update(pullRequests).set({ mergeSha: null }).where(eq(pullRequests.repoId, s.repo.id));
        return {};
      },
      '回执未知',
    ],
    ['回执矛盾：合并提交对不上', async () => ({ mergeCommit: '2'.repeat(40) }), '回执矛盾'],
    [
      '回执矛盾：未合却有合并提交',
      async (s) => {
        await t.db.update(pullRequests).set({ state: 'closed' }).where(eq(pullRequests.repoId, s.repo.id));
        return {};
      },
      '回执矛盾',
    ],
    ['代次已变', async (s) => ({ duties: [{ id: s.d23.id, generation: s.d23.generation + 1 }] }), '代次已变'],
    [
      '已最终验收',
      async (s) => {
        await t.db
          .update(acceptanceDuties)
          .set({ settledAt: new Date(), settledBy: 'x', settleEvidence: 'y' })
          .where(eq(acceptanceDuties.id, s.d24.id));
        return {};
      },
      '已最终验收',
    ],
  ];
  it.each(cases)('拒绝：%s', async (_name, change, expected) => {
    const s = await seed();
    const over = await change(s);
    const before = await snapshot();
    const plan = await planAcceptanceMerge(readOnly(t.db), { ...s.input, ...over });
    expect(plan.ok).toBe(false);
    expect(reasons(plan)).toContain(expected);
    expect(plan.target.items).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it('责任行读不全抛错，经 CLI 退出 1、不输出空计划', async () => {
    const { input } = await seed();
    await expect(
      planAcceptanceMerge(readOnly(t.db), {
        ...input,
        duties: [...input.duties, { id: 999_999, generation: 1 }],
      }),
    ).rejects.toThrow('读取不全');
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      env: { DATABASE_URL: 'test' },
      out: (x: string) => out.push(x),
      err: (x: string) => err.push(x),
      openDb: async () => ({ db: t.db, close: async () => {} }),
      now: () => new Date('2026-10-19T00:00:00Z'),
    } as unknown as CliDeps;
    const argv = (duties: string) => [
      'acceptance',
      'merge-plan',
      'o/r',
      '3090',
      '--task',
      input.taskId,
      '--workflow',
      'wf-3090',
      '--run',
      'run-3090',
      '--pr',
      '3104',
      '--head',
      FINAL,
      '--merge-commit',
      MERGE,
      '--duties',
      duties,
    ];
    const first = input.duties[0]?.id;
    expect(await main(argv(`${first}:1,999999:1`), deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('读取不全');
    // 拒绝同样非 0，原因在 stderr；全通过才退出 0 并输出计划
    expect(await main(argv(`${first}:2`), deps)).toBe(1);
    expect(err.join('\n')).toContain('代次已变');
    expect(out).toEqual([]);
    expect(await main(argv(input.duties.map((d) => `${d.id}:${d.generation}`).join(',')), deps)).toBe(0);
    expect(JSON.parse(out.pop() ?? 'null')).toMatchObject({ ok: true, rejections: [] });
  });

  it('参数：身份、SHA、责任号:代次都要写全，责任号不许重复', () => {
    const ok = [
      'merge-plan',
      'o/r',
      '3090',
      '--task',
      '00000000-0000-4000-8000-000000000001',
      '--workflow',
      'wf',
      '--run',
      'run',
      '--pr',
      '3104',
      '--head',
      FINAL,
      '--merge-commit',
      MERGE,
      '--duties',
      '23:1,24:2',
    ];
    expect(parseAcceptanceArgs(ok)).toMatchObject({
      prNumber: 3104,
      duties: [
        { id: 23, generation: 1 },
        { id: 24, generation: 2 },
      ],
    });
    const swap = (flag: string, value: string) => ok.map((x, i) => (ok[i - 1] === flag ? value : x));
    for (const bad of [
      swap('--duties', '23:1,23:2'),
      swap('--duties', '23'),
      swap('--duties', ''),
      swap('--head', 'abc'),
      swap('--merge-commit', 'abc'),
      swap('--task', 'not-a-uuid'),
      swap('--pr', '0'),
      ok.slice(0, -2),
    ])
      expect(() => parseAcceptanceArgs(bad)).toThrow();
  });
});
