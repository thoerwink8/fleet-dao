// 影子比对（#3776）：diff 规范化和评分是纯函数；批次冻结、影子产物、评分落库用 PGlite 跑真迁移。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BatchFrozenError,
  compareDiffs,
  freezeBatch,
  listCompare,
  normalizeDiff,
  recordCompare,
  recordShadowRun,
  shadowSilence,
} from '../src/shadow.ts';
import { createTestDb, type TestDb } from '../src/testing.ts';

const SHA = 'a'.repeat(40);
const diff = (file: string, body: string) =>
  `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n${body}\n`;

describe('规范化', () => {
  it('按文件分，空白和缩进不算差别，空行不算', () => {
    const a = normalizeDiff(diff('src/x.ts', '-const a=1;\n+const a = 2;\n+\n context'));
    expect([...(a.get('src/x.ts') ?? [])]).toEqual(['-consta=1;', '+consta=2;']);
  });

  it('新建和删掉的文件按真路径记', () => {
    const created =
      'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n';
    const deleted =
      'diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-y\n';
    expect([...normalizeDiff(created + deleted).keys()]).toEqual(['n.ts', 'd.ts']);
  });
});

describe('评分', () => {
  it('只差格式：判一样', () => {
    const s = compareDiffs(diff('a.ts', '+if (x) {  return 1 }'), diff('a.ts', '+if(x){return 1}'));
    expect(s).toMatchObject({ fileJaccard: 1, lineJaccard: 1, identical: true });
  });

  it('多改一个、漏改一个：分别列出来，重合按交集比并集', () => {
    const s = compareDiffs(
      diff('a.ts', '+1') + diff('extra.ts', '+2'),
      diff('a.ts', '+1') + diff('missed.ts', '+3'),
    );
    expect(s).toMatchObject({
      shadowFiles: 2,
      refFiles: 2,
      sharedFiles: 1,
      fileJaccard: 0.333,
      lineJaccard: 0.333,
      shadowOnly: ['extra.ts'],
      refOnly: ['missed.ts'],
      identical: false,
    });
  });

  it('同一行改在不同文件不算重合；影子空补丁对非空参照是 0', () => {
    expect(compareDiffs(diff('a.ts', '+x'), diff('b.ts', '+x')).lineJaccard).toBe(0);
    expect(compareDiffs('', diff('b.ts', '+x'))).toMatchObject({ fileJaccard: 0, lineJaccard: 0 });
  });
});

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec(
    'truncate fleet2.shadow_batch_items, fleet2.shadow_runs, fleet2.shadow_compare restart identity',
  );
});

const item = (issue: number) => ({
  repo: 'o/r',
  issue,
  baseSha: SHA,
  snapshotAt: new Date('2026-10-31T00:00:00Z'),
});
const run = (runId: string, issue: number, patch: string) => ({
  runId,
  batchId: 'b1',
  repo: 'o/r',
  issue,
  baseSha: SHA,
  verdict: 'passed' as const,
  patch,
  wallMs: 1000,
});

describe('落库', () => {
  it('批次冻结后不改：同一批号再冻结拒', async () => {
    await freezeBatch(t.db, 'b1', [item(1), item(2)]);
    await expect(freezeBatch(t.db, 'b1', [item(3)])).rejects.toBeInstanceOf(BatchFrozenError);
  });

  it('不在清单里、基线对不上的影子产物拒；同一个 runId 重放回原来那行', async () => {
    await freezeBatch(t.db, 'b1', [item(1)]);
    await expect(recordShadowRun(t.db, run('r0', 9, ''))).rejects.toThrow('不在批次');
    await expect(recordShadowRun(t.db, { ...run('r0', 1, ''), baseSha: 'b'.repeat(40) })).rejects.toThrow(
      '基线',
    );
    const id = await recordShadowRun(t.db, run('r1', 1, diff('a.ts', '+1')));
    expect(await recordShadowRun(t.db, run('r1', 1, diff('a.ts', '+changed')))).toBe(id);
  });

  it('评分写一次；再评回原分不覆盖；比对表按页往后翻', async () => {
    await freezeBatch(t.db, 'b1', [item(1), item(2), item(3)]);
    const ids = [];
    for (const i of [1, 2, 3]) ids.push(await recordShadowRun(t.db, run(`r${i}`, i, diff('a.ts', `+${i}`))));
    const first = await recordCompare(t.db, {
      shadowRunId: ids[0] ?? 0,
      mergedPr: 10,
      mergedSha: SHA,
      mergedDiff: diff('a.ts', '+1'),
    });
    expect(first.identical).toBe(true);
    const again = await recordCompare(t.db, {
      shadowRunId: ids[0] ?? 0,
      mergedPr: 10,
      mergedSha: SHA,
      mergedDiff: diff('z.ts', '+9'),
    });
    expect(again).toEqual(first);
    for (const id of ids.slice(1))
      await recordCompare(t.db, {
        shadowRunId: id,
        mergedPr: 11,
        mergedSha: SHA,
        mergedDiff: diff('b.ts', '+x'),
      });
    const page1 = await listCompare(t.db, 'b1', 0, 2);
    expect(page1.map((r) => r.issue)).toEqual([1, 2]);
    const page2 = await listCompare(t.db, 'b1', page1[1]?.shadowRunId, 2);
    expect(page2.map((r) => [r.issue, r.score.fileJaccard])).toEqual([[3, 0]]);
  });
});

describe('影子静默报警', () => {
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  it('没有批次、或批次全跑完：不报', async () => {
    expect(await shadowSilence(t.db, 'none')).toEqual({ kind: 'idle' });
    await freezeBatch(t.db, 'b1', [{ ...item(1), snapshotAt: old }]);
    await recordShadowRun(t.db, run('r1', 1, ''));
    expect(await shadowSilence(t.db, 'b1')).toEqual({ kind: 'idle' });
  });

  it('冻结了一整天还一条产物都没有：报 silent', async () => {
    await freezeBatch(t.db, 'b1', [
      { ...item(1), snapshotAt: old },
      { ...item(2), snapshotAt: old },
    ]);
    expect(await shadowSilence(t.db, 'b1')).toMatchObject({ kind: 'silent', pending: 2 });
  });

  it('最近刚出过一条、还有没跑的：不报，按最近那条算', async () => {
    await freezeBatch(t.db, 'b1', [
      { ...item(1), snapshotAt: old },
      { ...item(2), snapshotAt: old },
    ]);
    await recordShadowRun(t.db, run('r1', 1, ''));
    const s = await shadowSilence(t.db, 'b1');
    expect(s).toMatchObject({ kind: 'ok', pending: 1 });
    expect(s.kind === 'ok' && s.lastAt.getTime()).toBeGreaterThan(old.getTime());
  });
});
