import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PR_LINE_BUDGET } from '../../src/limits.ts';
import { localExec } from '../../src/real/exec.ts';
import { measureMigrationBudget } from '../../src/real/migration-budget.ts';
import { remeasureLineBudget } from '../../src/real/task-activities.ts';
import { addedLinesAgainst, type UserTree } from '../../src/real/user-git.ts';
import { gitIn, isolatedGitEnv } from './isolated-git.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-migration-budget-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function fixture(renameSnapshot = false, seedPath?: string) {
  const env = isolatedGitEnv(root, root),
    git = (...args: string[]) => gitIn(env, root, ...args).trim();
  git('init', '-q', '-b', 'main');
  const read = (p: string) => readFileSync(new URL(`../../../db/migrations/${p}`, import.meta.url));
  const journal = JSON.parse(read('meta/_journal.json').toString('utf8'));
  const put = (p: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  };
  const prefix = 'packages/db/migrations/';
  put(`${prefix}meta/_journal.json`, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 94) }));
  put(`${prefix}meta/0093_snapshot.json`, read('meta/0093_snapshot.json'));
  if (seedPath) put(seedPath, '// trust input before\n');
  if (renameSnapshot) put('template_snapshot.json', read('meta/0094_snapshot.json'));
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  put(`${prefix}meta/_journal.json`, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 95) }));
  put(`${prefix}meta/0094_snapshot.json`, read('meta/0094_snapshot.json'));
  if (renameSnapshot) git('rm', 'template_snapshot.json');
  put(`${prefix}0094_acceptance_duty_supersession.sql`, read('0094_acceptance_duty_supersession.sql'));
  put('source.ts', 'export const changed = true;\n');
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'change');
    return git('rev-parse', 'HEAD');
  };
  const head = commit();
  const exec = localExec();
  const tree: UserTree = {
    exec: (command) => exec({ ...command, env: { ...env, ...command.env } }),
    user: 'fleet-agent-carpool',
    dir: root,
    scopePrefix: 'budget-test',
    git: 'git',
  };
  const raw = await addedLinesAgainst(tree, base, head);
  return { tree, base, head, raw, put, commit, prefix, git };
}
describe('固定 Git blob 的生成快照计量', { timeout: 30000 }, () => {
  it.each([
    ['A', 'packages/db/src/migration-budget-data.ts'],
    ['M', 'packages/db/src/migration-budget-data.ts'],
    ['D', 'packages/db/src/migration-budget-data.ts'],
    ['M', 'packages/db/package.json'],
    ['M', 'pnpm-lock.yaml'],
    ['A', 'packages/engine/src/real/migration-budget.ts'],
    ['M', 'packages/engine/src/real/user-git.ts'],
    ['A', 'packages/engine/src/workflows/task-budget-remeasure.ts'],
    ['M', 'packages/engine/src/workflows/task-budget-remeasure.ts'],
    ['D', 'packages/engine/src/workflows/task-budget-remeasure.ts'],
    ['A', 'packages/engine/src/workflows/task-runtime.ts'],
    ['M', 'packages/engine/src/workflows/task-runtime.ts'],
    ['D', 'packages/engine/src/workflows/task-runtime.ts'],
    ['A', '.gitattributes'],
    ['A', 'packages/db/migrations/.gitattributes'],
  ])('候选信任根%s %s即无折扣，保留完整raw', async (status, p) => {
    const f = await fixture(false, status === 'A' ? undefined : p);
    if (status === 'D') f.git('rm', p);
    else f.put(p, '// trust input after\n');
    const head = f.commit(),
      raw = await addedLinesAgainst(f.tree, f.base, head);
    const measured = await measureMigrationBudget(f.tree, f.base, head, raw);
    expect(measured).toMatchObject({
      verified: false,
      rawAddedLines: raw,
      verifiedGeneratedLines: 0,
      chargeableAddedLines: raw,
      reason: expect.stringContaining(`信任根 ${p}`),
    });
  });
  it('重评资格链两处连同裁决依赖的合同一起改：整批无折扣，不是只拦单个文件', async () => {
    const f = await fixture();
    f.put('packages/engine/src/workflows/task-budget-remeasure.ts', '// 候选改资格裁决\n');
    f.put('packages/engine/src/workflows/task-runtime.ts', '// 候选改放行消费\n');
    f.put('packages/engine/src/task-contract.ts', '// 候选改回执形状\n');
    const head = f.commit(),
      raw = await addedLinesAgainst(f.tree, f.base, head);
    expect(await measureMigrationBudget(f.tree, f.base, head, raw)).toMatchObject({
      verified: false,
      verifiedGeneratedLines: 0,
      chargeableAddedLines: raw,
      reason: expect.stringContaining('信任根'),
    });
  });
  it('重评资格链源码引到的体量裁决专用相对模块，都在信任根里（防以后又漏一个）', async () => {
    const chain = ['task-budget-remeasure.ts', 'task-runtime.ts'];
    const asked = new Set<string>();
    for (const file of chain) {
      const source = readFileSync(new URL(`../../src/workflows/${file}`, import.meta.url), 'utf8');
      for (const m of source.matchAll(/from '(\.\.?\/[^']*(?:budget|remeasure)[^']*\.ts)'/g))
        asked.add(new URL(m[1] as string, new URL(`../../src/workflows/${file}`, import.meta.url)).pathname);
    }
    expect(asked.size).toBeGreaterThan(0);
    for (const abs of asked) {
      const rel = abs.slice(abs.lastIndexOf('packages/engine/'));
      const f = await fixture();
      f.put(rel, '// 候选改了体量裁决依赖\n');
      const head = f.commit(),
        raw = await addedLinesAgainst(f.tree, f.base, head);
      expect(await measureMigrationBudget(f.tree, f.base, head, raw), rel).toMatchObject({
        verified: false,
        chargeableAddedLines: raw,
      });
    }
  });
  it('全局raw识别改名时，不用局部no-renames全量快照错误抵扣代码', async () => {
    const f = await fixture(true);
    f.put('many-lines.ts', '// normal source change\n'.repeat(9000));
    const head = f.commit(),
      raw = await addedLinesAgainst(f.tree, f.base, head);
    expect(raw).toBeGreaterThan(9000);
    expect(await measureMigrationBudget(f.tree, f.base, head, raw)).toMatchObject({
      verified: false,
      rawAddedLines: raw,
      chargeableAddedLines: raw,
      reason: expect.stringContaining('改名'),
    });
  });
  it('真实迁移只减新snapshot，SQL/journal/source全计，raw不变；候选loader/config不执行', async () => {
    const f = await fixture();
    f.put('packages/db/drizzle.config.ts', 'throw new Error("candidate executed");');
    f.put('packages/db/src/schema/index.ts', 'throw new Error("candidate executed");');
    const head = f.commit(),
      raw = await addedLinesAgainst(f.tree, f.base, head);
    const result = await measureMigrationBudget(f.tree, f.base, head, raw);
    expect(result).toMatchObject({ verified: true, rawAddedLines: raw, base: f.base, head });
    expect(result.verifiedGeneratedLines).toBeGreaterThan(6000);
    expect(result.chargeableAddedLines).toBe(raw - result.verifiedGeneratedLines);
    expect(result.chargeableAddedLines).toBeGreaterThan(10);
    expect(await addedLinesAgainst(f.tree, f.base, head)).toBe(raw);
  });
  it.each([
    'second-sql',
    'second-snapshot',
    'old-snapshot',
    'deleted-snapshot',
    'journal-change',
    'invalid-utf8',
    'symbolic-blob',
  ])('%s 保持raw并交明确原因', async (kind) => {
    const f = await fixture();
    if (kind === 'second-sql') f.put(`${f.prefix}0095_second.sql`, 'SELECT 1;');
    if (kind === 'second-snapshot') f.put(`${f.prefix}meta/0095_snapshot.json`, '{}');
    if (kind === 'old-snapshot') f.put(`${f.prefix}meta/0093_snapshot.json`, '{}');
    if (kind === 'deleted-snapshot') f.git('rm', `${f.prefix}meta/0093_snapshot.json`);
    if (kind === 'journal-change') {
      const p = `${f.prefix}meta/_journal.json`,
        j = JSON.parse(readFileSync(join(root, p), 'utf8'));
      j.entries[0].when += 1;
      f.put(p, JSON.stringify(j));
    }
    if (kind === 'invalid-utf8')
      f.put(`${f.prefix}0094_acceptance_duty_supersession.sql`, Buffer.from([0x80]));
    let head = kind === 'symbolic-blob' ? f.head : f.commit();
    if (kind === 'symbolic-blob') {
      f.git(
        'update-index',
        '--cacheinfo',
        '120000',
        f.git('rev-parse', `${head}:${f.prefix}0094_acceptance_duty_supersession.sql`),
        `${f.prefix}0094_acceptance_duty_supersession.sql`,
      );
      f.git('commit', '-qm', 'unsupported blob');
      head = f.git('rev-parse', 'HEAD');
    }
    const raw = await addedLinesAgainst(f.tree, f.base, head),
      got = await measureMigrationBudget(f.tree, f.base, head, raw);
    expect(got).toMatchObject({
      verified: false,
      rawAddedLines: raw,
      verifiedGeneratedLines: 0,
      chargeableAddedLines: raw,
    });
    expect(got.reason.length).toBeGreaterThan(0);
    if (kind === 'invalid-utf8') expect(got.reason).toContain('UTF-8');
  });
  it('raw硬界只是自动折扣资格；patch有界溢出回raw，Git真实读取失败抛错', async () => {
    const f = await fixture();
    expect(await measureMigrationBudget(f.tree, f.base, f.head, 20001)).toMatchObject({
      verified: false,
      chargeableAddedLines: 20001,
      reason: expect.stringContaining('20000'),
    });
    f.put('huge.txt', 'x'.repeat(2 * 1024 * 1024));
    const head = f.commit(),
      raw = await addedLinesAgainst(f.tree, f.base, head);
    expect(await measureMigrationBudget(f.tree, f.base, head, raw)).toMatchObject({
      verified: false,
      chargeableAddedLines: raw,
      reason: expect.stringContaining('2MiB'),
    });
    await expect(measureMigrationBudget(f.tree, 'f'.repeat(40), head, raw)).rejects.toMatchObject({
      code: 'GIT_FAILED',
    });
  });
});

describe('体量关口重评活动（#3249）', { timeout: 30000 }, () => {
  const repo = { owner: 'thoerwink8', name: 'fleet-dao', defaultBranch: 'main' };
  async function ready() {
    const f = await fixture();
    // 会话树里钉的主线：base 就是主线头
    f.git('update-ref', 'refs/remotes/origin/main', f.base);
    return f;
  }
  const ask = (
    f: Awaited<ReturnType<typeof ready>>,
    over: Partial<{ head: string; base: string; rawAddedLines: number }> = {},
  ) => ({
    head: f.head,
    base: f.base,
    rawAddedLines: f.raw,
    ...over,
  });

  it('精确头、固定 base、干净树：可信完整测量，测量前后头和干净程度都核过，不动树', async () => {
    const f = await ready();
    f.put('.claude/settings.json', '{"hooks":"noise"}\n'); // 环境文件噪声不算脏，也不被还原
    const got = await remeasureLineBudget(f.tree, repo, ask(f));
    expect(got.budgetRemeasure).toMatchObject({
      version: 1,
      status: 'measured',
      head: f.head,
      base: f.base,
      headAfter: f.head,
      cleanAfter: true,
      mergeBaseAfter: f.base,
      measurement: { verified: true, rawAddedLines: f.raw, base: f.base, head: f.head },
    });
    const m = (
      got.budgetRemeasure as { measurement: { verifiedGeneratedLines: number; chargeableAddedLines: number } }
    ).measurement;
    expect(m.verifiedGeneratedLines + m.chargeableAddedLines).toBe(f.raw);
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toContain('noise');
  });

  it('头不是请求的头、有改动或未跟踪文件、base 不是祖先或不在主线：拒绝并写明原因', async () => {
    const f = await ready();
    expect((await remeasureLineBudget(f.tree, repo, ask(f, { head: f.base }))).budgetRemeasure).toMatchObject(
      {
        status: 'refused',
        reason: 'head',
      },
    );
    f.put('source.ts', 'export const changed = false;\n');
    expect((await remeasureLineBudget(f.tree, repo, ask(f))).budgetRemeasure).toMatchObject({
      status: 'refused',
      reason: 'dirty',
    });
    f.git('checkout', '--', 'source.ts');
    f.put('untracked.ts', 'x\n');
    expect((await remeasureLineBudget(f.tree, repo, ask(f))).budgetRemeasure).toMatchObject({
      status: 'refused',
      reason: 'dirty',
    });
    rmSync(join(root, 'untracked.ts'));
    expect((await remeasureLineBudget(f.tree, repo, ask(f, { base: f.head }))).budgetRemeasure).toMatchObject(
      {
        status: 'refused',
        reason: 'base',
      },
    );
    expect(
      (await remeasureLineBudget(f.tree, repo, ask(f, { base: 'e'.repeat(40) }))).budgetRemeasure,
    ).toMatchObject({
      status: 'refused',
      reason: 'base',
    });
    // base 是头的祖先，但不在树里钉的主线历史上
    const orphan = f.git('commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'orphan');
    f.git('update-ref', 'refs/remotes/origin/main', orphan);
    expect((await remeasureLineBudget(f.tree, repo, ask(f))).budgetRemeasure).toMatchObject({
      status: 'refused',
      reason: 'base',
    });
  });

  it('base 是头的祖先、也在主线上，但不是固定的 merge-base（更早的旧 base）：拒绝，不换测量范围', async () => {
    const f = await ready();
    f.git('update-ref', 'refs/remotes/origin/main', f.head); // 主线前进到原来的头
    f.put('later.ts', 'export const later = 1;\n');
    const head = f.commit();
    // 原始新增行按旧 base 数，行数核对也对得上：拦下它的只能是固定 base 核对
    const older = await addedLinesAgainst(f.tree, f.base, head);
    expect(
      (await remeasureLineBudget(f.tree, repo, { head, base: f.base, rawAddedLines: older })).budgetRemeasure,
    ).toMatchObject({ status: 'refused', reason: 'base' });
    const fixed = await addedLinesAgainst(f.tree, f.head, head);
    expect(
      (await remeasureLineBudget(f.tree, repo, { head, base: f.head, rawAddedLines: fixed })).budgetRemeasure,
    ).toMatchObject({ status: 'measured', base: f.head, head });
  });

  it('同头同 raw、不同 base 的变更构成不同（评审反例）：旧祖先 A 会把主线已有的 0094 当新增折掉，必须拒绝', async () => {
    const f = await fixture();
    // 0094 那份迁移（journal、快照、SQL）的新增行；业务文件凑成同样行数，让 A→H 与 S→H 的 raw 恰好相等
    const migrationLines = f.raw - 1; // fixture 的头另加了一行 source.ts
    const business = Array.from({ length: migrationLines }, (_, k) => `export const line${k} = ${k};\n`).join(
      '',
    );
    f.git('checkout', '-q', '--detach', f.base);
    f.put('business.ts', business);
    const a = f.commit(); // 旧主线 A：合法 0093 + 业务文件
    f.git('checkout', f.head, '--', 'packages/db/migrations');
    f.git('rm', '-q', 'business.ts');
    const s = f.commit(); // 主线 S：完整追加合法 0094，删掉业务文件
    f.put('business.ts', business);
    const h = f.commit(); // 候选 H：只恢复业务文件；真正的分叉点是 S
    f.git('update-ref', 'refs/remotes/origin/main', s);
    const fromS = await addedLinesAgainst(f.tree, s, h);
    const fromA = await addedLinesAgainst(f.tree, a, h);
    expect(fromA).toBe(fromS); // 同 head、同 raw
    // 主线真实测量：全是业务行，没有可折扣的快照，超预算
    expect(await measureMigrationBudget(f.tree, s, h, fromS)).toMatchObject({
      verified: false,
      verifiedGeneratedLines: 0,
      chargeableAddedLines: fromS,
    });
    // 换成旧祖先 A：业务文件没变，已在主线的 0094 反被当新增，可信验证器会核成快照并大幅折扣——这正是要挡住的
    const wrong = await measureMigrationBudget(f.tree, a, h, fromA);
    expect(wrong).toMatchObject({ verified: true, base: a });
    expect(wrong.chargeableAddedLines).toBeLessThan(DEFAULT_PR_LINE_BUDGET);
    expect(fromS).toBeGreaterThan(DEFAULT_PR_LINE_BUDGET);
    // 重评活动：A 是头的祖先、也在主线历史上、raw 也对得上，照样拒绝；只认固定的 S
    expect(
      (await remeasureLineBudget(f.tree, repo, { head: h, base: a, rawAddedLines: fromA })).budgetRemeasure,
    ).toMatchObject({ status: 'refused', reason: 'base' });
    expect(
      (await remeasureLineBudget(f.tree, repo, { head: h, base: s, rawAddedLines: fromS })).budgetRemeasure,
    ).toMatchObject({
      status: 'measured',
      measurement: { verified: false, base: s, chargeableAddedLines: fromS },
    });
  });

  it('测量期间主线引用变了、merge-base 不再是请求的 base：拒绝，不接受测量前的旧结果', async () => {
    const f = await ready();
    const got = await remeasureLineBudget(f.tree, repo, ask(f), async (tree, base, head, raw) => {
      const measured = await measureMigrationBudget(tree, base, head, raw);
      // 测量窗口里把钉住的主线挪到候选头上：merge-base 变成头自己，不再是停下时的 base
      f.git('update-ref', 'refs/remotes/origin/main', head);
      return measured;
    });
    expect(got.budgetRemeasure).toMatchObject({ status: 'refused', reason: 'base' });
    const detail = (got.budgetRemeasure as { detail?: string }).detail ?? '';
    expect(detail).toContain('测量之后');
  });

  it('原始新增行与停下时不同、不适用的仓、读失败：回 refused 或抛错，不当 0', async () => {
    const f = await ready();
    expect(
      (await remeasureLineBudget(f.tree, repo, ask(f, { rawAddedLines: f.raw + 1 }))).budgetRemeasure,
    ).toMatchObject({ status: 'refused', reason: 'raw' });
    await expect(remeasureLineBudget(f.tree, { ...repo, name: 'other' }, ask(f))).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    await expect(remeasureLineBudget(f.tree, repo, ask(f, { head: 'abc' }))).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    // 主线引用不存在：读不到，抛错（未知），不当作「不在主线」之外的任何结论
    f.git('update-ref', '-d', 'refs/remotes/origin/main');
    await expect(remeasureLineBudget(f.tree, repo, ask(f))).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });
});
