import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localExec } from '../../src/real/exec.ts';
import { measureMigrationBudget } from '../../src/real/migration-budget.ts';
import { addedLinesAgainst, type UserTree } from '../../src/real/user-git.ts';
import { gitIn, isolatedGitEnv } from './isolated-git.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-migration-budget-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function fixture(renameSnapshot = false) {
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
