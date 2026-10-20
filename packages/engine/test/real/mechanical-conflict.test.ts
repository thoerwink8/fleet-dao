// 并主线冲突里机械可解的（迁移生成文件、pnpm-lock.yaml）引擎自己解（#3428）：真 git、临时目录里的小仓，
// 重新生成迁移、装锁文件、自测的命令换成夹具脚本（真的 drizzle-kit 在 schema-drift 里核）。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localExec } from '../../src/real/exec.ts';
import {
  GENERATED_CHECK_SCRIPT,
  MECHANICAL_CONFLICT_RULES,
  mechanicalKindOf,
  resolveMechanically,
} from '../../src/real/mechanical-conflict.ts';
import { headOf, type UserTree } from '../../src/real/user-git.ts';
import { runChildOk } from '../child.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mech-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  runChildOk('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

const M = 'packages/db/migrations';
const JOURNAL = `${M}/meta/_journal.json`;

const journalOf = (tags: string[]) =>
  `${JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({ idx, version: '7', when: 1000 + idx, tag, breakpoints: true })),
    },
    null,
    2,
  )}\n`;
const snapshot = (id: string, prevId: string, tables: string[]) =>
  `${JSON.stringify({ id, prevId, version: '7', tables: Object.fromEntries(tables.map((n) => [n, { name: n }])) }, null, 2)}\n`;

function write(dir: string, rel: string, text: string): void {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

/** 夹具脚本放在仓外：重新生成（在 0001 后面接 0002）、自测（journal 接得上、分支原来的 0001 已经没了）。 */
function scripts() {
  const tools = join(root, 'tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(
    join(tools, 'generated.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      'for (const arg of process.argv.slice(2)) {',
      "  const tag = arg.split(':')[1];",
      "  if (/UPDATE|INSERT/.test(readFileSync(`migrations/${tag}.sql`, 'utf8'))) console.log(`MISMATCH ${tag}`);",
      '}',
      "console.log('CHECKED');",
    ].join('\n'),
  );
  const regen = join(tools, 'regen.mjs').replaceAll('\\', '/');
  const check = join(tools, 'check.mjs').replaceAll('\\', '/');
  writeFileSync(
    join(tools, 'regen.mjs'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const m = '${M}';`,
      "const j = JSON.parse(readFileSync(`${m}/meta/_journal.json`, 'utf8'));",
      "const prev = JSON.parse(readFileSync(`${m}/meta/${String(j.entries.length - 1).padStart(4, '0')}_snapshot.json`, 'utf8'));",
      "const idx = j.entries.length; const tag = String(idx).padStart(4, '0') + '_regen';",
      "j.entries.push({ idx, version: '7', when: 9000, tag, breakpoints: true });",
      "writeFileSync(`${m}/meta/_journal.json`, JSON.stringify(j, null, 2) + '\\n');",
      "writeFileSync(`${m}/${tag}.sql`, 'CREATE TABLE b (id int);\\n');",
      "writeFileSync(`${m}/meta/${String(idx).padStart(4, '0')}_snapshot.json`, JSON.stringify({ ...prev, id: 'regen', prevId: prev.id }, null, 2) + '\\n');",
    ].join('\n'),
  );
  writeFileSync(
    join(tools, 'check.mjs'),
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      `const m = '${M}';`,
      "const j = JSON.parse(readFileSync(`${m}/meta/_journal.json`, 'utf8'));",
      "for (const e of j.entries) if (!existsSync(`${m}/${e.tag}.sql`)) { console.log('FAIL 缺 ' + e.tag); process.exit(1); }",
      "if (existsSync(`${m}/0001_branch.sql`)) { console.log('FAIL 分支原来的迁移还在'); process.exit(1); }",
    ].join('\n'),
  );
  return {
    deps: 'true',
    regenerate: `node ${regen}`,
    lockfile: "echo 'lock: regenerated' > pnpm-lock.yaml",
    drift: `node ${check}`,
    tsc: 'true',
    // 夹具里没有 drizzle-kit：认「生成后手加了 UPDATE/INSERT」的当不一致（真的字节比对在下面单独核）
    generatedCheck: `node ${join(tools, 'generated.mjs').replaceAll('\\', '/')}`,
  };
}

interface Fixture {
  t: UserTree;
  head: string;
  mainline: string;
}

/**
 * 基础提交上长出两条线：主线加 0001_main，分支加 0001_branch（同号）。
 * 想要的变化：branchLock 分支也改锁文件；branchOther 分支改了名单外的 other.ts（主线也改）；custom 分支的迁移是手写的。
 */
function fixture(
  opts: {
    branchLock?: boolean;
    branchOther?: boolean;
    custom?: boolean;
    edited?: boolean;
    noMigrations?: boolean;
  } = {},
): Fixture {
  const dir = join(root, 'tree');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 'fleet-test@localhost');
  write(dir, `${M}/0000_init.sql`, 'CREATE TABLE a (id int);\n');
  write(dir, `${M}/meta/0000_snapshot.json`, snapshot('s0', '0', ['a']));
  write(dir, JOURNAL, journalOf(['0000_init']));
  write(dir, 'pnpm-lock.yaml', ['lock: base', 'line2: x', 'line3: y', 'line4: z', 'line5: w', ''].join('\n'));
  write(dir, 'other.ts', 'export const v = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'task');
  if (!opts.noMigrations) {
    write(
      dir,
      `${M}/0001_branch.sql`,
      opts.custom
        ? 'CREATE TRIGGER x;\n'
        : `CREATE TABLE b (id int);\n${opts.edited ? '--> statement-breakpoint\nUPDATE b SET id = 1;\n' : ''}`,
    );
    write(dir, `${M}/meta/0001_snapshot.json`, snapshot('s1b', 's0', opts.custom ? ['a'] : ['a', 'b']));
    write(dir, JOURNAL, journalOf(['0000_init', '0001_branch']));
  }
  if (opts.branchLock)
    write(
      dir,
      'pnpm-lock.yaml',
      ['lock: branch', 'line2: x', 'line3: y', 'line4: z', 'line5: w', ''].join('\n'),
    );
  if (opts.branchOther) write(dir, 'other.ts', 'export const v = 2;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'branch');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  if (!opts.noMigrations) {
    write(dir, `${M}/0001_main.sql`, 'CREATE TABLE m (id int);\n');
    write(dir, `${M}/meta/0001_snapshot.json`, snapshot('s1m', 's0', ['a', 'm']));
    write(dir, JOURNAL, journalOf(['0000_init', '0001_main']));
  }
  write(
    dir,
    'pnpm-lock.yaml',
    [
      opts.branchLock ? 'lock: main' : 'lock: base',
      'line2: x',
      'line3: y',
      'line4: z',
      'line5: main-only',
      '',
    ].join('\n'),
  );
  if (opts.branchOther) write(dir, 'other.ts', 'export const v = 3;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'mainline');
  const mainline = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'task');
  git(dir, 'update-ref', 'refs/remotes/origin/main', mainline);
  const t: UserTree = {
    exec: localExec(),
    user: 'fleet-agent-carpool',
    dir,
    scopePrefix: 'mech',
    git: 'git',
    sh: 'sh',
  };
  return { t, head, mainline };
}

const tagsOf = (dir: string): string[] =>
  (JSON.parse(readFileSync(join(dir, JOURNAL), 'utf8')) as { entries: { tag: string }[] }).entries.map(
    (e) => e.tag,
  );

describe('名单', () => {
  it('迁移的生成文件、锁文件在名单里；手写的 sql 编号之外、别的文件不在', () => {
    expect(MECHANICAL_CONFLICT_RULES.length).toBeGreaterThan(0);
    expect(mechanicalKindOf(JOURNAL)).toBe('migration');
    expect(mechanicalKindOf(`${M}/meta/0092_snapshot.json`)).toBe('migration');
    expect(mechanicalKindOf(`${M}/0092_faithful_riptide.sql`)).toBe('migration');
    expect(mechanicalKindOf('pnpm-lock.yaml')).toBe('lockfile');
    expect(mechanicalKindOf('packages/db/src/schema/tasks.ts')).toBeNull();
    expect(mechanicalKindOf('packages/web/pnpm-lock.yaml')).toBeNull();
    expect(mechanicalKindOf('other.ts')).toBeNull();
  });
});

describe('机械解并主线冲突', { timeout: 60_000 }, () => {
  it('两个分支各生成同号迁移：后合的取主线的、重新生成接在主线后面，自测过了才推', async () => {
    const f = fixture();
    const push = vi.fn(async (_t: UserTree, merged: string) => merged);
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL, `${M}/meta/0001_snapshot.json`],
      push,
      commands: scripts(),
      shellPath: null,
    });
    expect(got.state).toBe('resolved');
    expect(tagsOf(f.t.dir)).toEqual(['0000_init', '0001_main', '0002_regen']);
    expect(existsSync(join(f.t.dir, M, '0001_branch.sql'))).toBe(false);
    expect(existsSync(join(f.t.dir, M, '0001_main.sql'))).toBe(true);
    expect(existsSync(join(f.t.dir, M, '0002_regen.sql'))).toBe(true);
    // 合并提交：第一父是分支原来的头，第二父是主线；树是干净的
    const merged = await headOf(f.t);
    expect(git(f.t.dir, 'rev-parse', `${merged}^1`)).toBe(f.head);
    expect(git(f.t.dir, 'rev-parse', `${merged}^2`)).toBe(f.mainline);
    expect(git(f.t.dir, 'status', '--porcelain')).toBe('');
    expect(push).toHaveBeenCalledWith(f.t, merged, f.head);
    if (got.state === 'resolved') {
      expect(got.head).toBe(merged);
      expect(got.files).toEqual(expect.arrayContaining([JOURNAL]));
      expect(got.note).toContain('0002_regen.sql');
    }
  });

  it('自测没过：撤回这次机械解，树回到并之前，原因写明，没推', async () => {
    const f = fixture();
    const push = vi.fn(async (_t: UserTree, merged: string) => merged);
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL],
      push,
      commands: { ...scripts(), drift: "echo 'FAIL schema-drift 红了'; exit 1" },
      shellPath: null,
    });
    expect(got).toMatchObject({ state: 'declined' });
    if (got.state === 'declined') {
      expect(got.reason).toContain('schema-drift');
      expect(got.reason).toContain('已撤回');
      expect(got.reason).toContain('FAIL schema-drift 红了');
    }
    expect(push).not.toHaveBeenCalled();
    expect(await headOf(f.t)).toBe(f.head);
    expect(git(f.t.dir, 'status', '--porcelain')).toBe('');
    expect(tagsOf(f.t.dir)).toEqual(['0000_init', '0001_branch']);
    expect(existsSync(join(f.t.dir, M, '0002_regen.sql'))).toBe(false);
  });

  it('冲突里夹着名单外的文件：不推，名单内的取主线版暂存，树停在没并完的合并上，原因写明', async () => {
    const f = fixture({ branchOther: true });
    const push = vi.fn(async (_t: UserTree, merged: string) => merged);
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL, 'other.ts'],
      push,
      commands: scripts(),
      shellPath: null,
    });
    expect(got).toMatchObject({ state: 'declined', inTree: true });
    if (got.state === 'declined') {
      expect(got.reason).toContain('other.ts');
      expect(got.resolvedFiles).toEqual(expect.arrayContaining([JOURNAL]));
      expect(got.reason).toContain('db:generate');
    }
    expect(push).not.toHaveBeenCalled();
    // 还在合并中：名单外的冲突标记留着，迁移已是主线的
    expect(git(f.t.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(f.mainline);
    expect(readFileSync(join(f.t.dir, 'other.ts'), 'utf8')).toContain('<<<<<<<');
    expect(tagsOf(f.t.dir)).toEqual(['0000_init', '0001_main']);
    expect(git(f.t.dir, 'diff', '--name-only', '--diff-filter=U')).toBe('other.ts');
    expect(existsSync(join(f.t.dir, M, '0002_regen.sql'))).toBe(false);
  });

  it('pnpm-lock.yaml 冲突：取主线的再重跑 lockfile-only，不动迁移', async () => {
    const f = fixture({ branchLock: true, noMigrations: true });
    const cmds = { ...scripts(), regenerate: 'echo 不该重新生成迁移; exit 1' };
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: ['pnpm-lock.yaml'],
      push: async (_t, merged) => merged,
      commands: cmds,
      shellPath: null,
    });
    expect(got.state).toBe('resolved');
    expect(readFileSync(join(f.t.dir, 'pnpm-lock.yaml'), 'utf8')).toContain('lock: regenerated');
    expect(git(f.t.dir, 'status', '--porcelain')).toBe('');
    expect(git(f.t.dir, 'rev-parse', `${await headOf(f.t)}^2`)).toBe(f.mainline);
  });

  it('分支新增的迁移像手写的（快照和上一版一样）：不自己解，树不动', async () => {
    const f = fixture({ custom: true });
    const push = vi.fn(async (_t: UserTree, merged: string) => merged);
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL],
      push,
      commands: scripts(),
      shellPath: null,
    });
    expect(got).toMatchObject({ state: 'declined' });
    if (got.state === 'declined') expect(got.reason).toContain('手写');
    expect(await headOf(f.t)).toBe(f.head);
    expect(git(f.t.dir, 'status', '--porcelain')).toBe('');
    expect(push).not.toHaveBeenCalled();
  });

  it('生成后手加了 UPDATE/INSERT 的迁移：不机械解，树一点不动，意见写明是哪个文件、为什么', async () => {
    const f = fixture({ edited: true });
    const push = vi.fn(async (_t: UserTree, merged: string) => merged);
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL, `${M}/meta/0001_snapshot.json`],
      push,
      commands: scripts(),
      shellPath: null,
    });
    expect(got).toMatchObject({ state: 'declined' });
    if (got.state === 'declined') {
      expect(got.reason).toContain('0001_branch.sql');
      expect(got.reason).toContain('逐字节');
      expect(got.reason).toContain('手改');
      expect(got.inTree).toBeUndefined();
    }
    expect(await headOf(f.t)).toBe(f.head);
    expect(git(f.t.dir, 'status', '--porcelain')).toBe('');
    expect(() => git(f.t.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(push).not.toHaveBeenCalled();
  });

  it('核对本身没跑成：不当成纯生成，不自己解', async () => {
    const f = fixture();
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL],
      push: async (_t, merged) => merged,
      commands: { ...scripts(), generatedCheck: "echo '核对脚本坏了'; exit 3 #" },
      shellPath: null,
    });
    expect(got).toMatchObject({ state: 'declined', reason: expect.stringContaining('没能核对') });
    expect(await headOf(f.t)).toBe(f.head);
  });

  it('冲突文件一个都不在名单里：什么都不动，不留原因', async () => {
    const f = fixture();
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: ['other.ts'],
      push: async (_t, merged) => merged,
      commands: scripts(),
      shellPath: null,
    });
    expect(got).toEqual({ state: 'declined', reason: '' });
    expect(await headOf(f.t)).toBe(f.head);
    expect(git(f.t.dir, 'status', '--porcelain')).toBe('');
  });

  it('树里没装依赖：没法自测，不动树', async () => {
    const f = fixture();
    const got = await resolveMechanically(f.t, {
      head: f.head,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL],
      push: async (_t, merged) => merged,
      commands: { ...scripts(), deps: 'false' },
      shellPath: null,
    });
    expect(got).toMatchObject({ state: 'declined', reason: expect.stringContaining('没装依赖') });
    expect(await headOf(f.t)).toBe(f.head);
  });

  it('工作树的头不是 PR 的头：不动', async () => {
    const f = fixture();
    const got = await resolveMechanically(f.t, {
      head: f.mainline,
      defaultBranch: 'main',
      conflictFiles: [JOURNAL],
      push: async (_t, merged) => merged,
      commands: scripts(),
      shellPath: null,
    });
    expect(got).toMatchObject({ state: 'declined', reason: expect.stringContaining('不是 PR 的头') });
  });
});

// 真的 drizzle-kit：对仓里已提交的迁移重新生成，逐字节一致；手加一行 UPDATE 就不一致
describe('生成核对脚本（真 drizzle-kit）', { timeout: 120_000 }, () => {
  const dbDir = fileURLToPath(new URL('../../../db', import.meta.url));
  const journal = JSON.parse(readFileSync(join(dbDir, 'migrations/meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const last = journal.entries.at(-1);
  const before = journal.entries.at(-2);
  if (!last || !before) throw new Error('仓里的迁移记录不够');
  const arg = `${last.idx}:${last.tag}:${before.idx}`;
  const run = (migDir: string) =>
    spawnSync(process.execPath, ['--input-type=module', '-', arg], {
      cwd: dbDir,
      input: GENERATED_CHECK_SCRIPT,
      env: { ...process.env, MIG_DIR: migDir },
      encoding: 'utf8',
    });

  it('已提交的最新迁移是 drizzle-kit 生成的：逐字节一致', () => {
    const r = run(join(dbDir, 'migrations'));
    expect(r.stdout).toContain('CHECKED');
    expect(r.stdout).not.toContain('MISMATCH');
  });

  it('手加一行 UPDATE：判不一致', () => {
    const copy = join(root, 'migrations-copy');
    cpSync(join(dbDir, 'migrations'), copy, { recursive: true });
    const file = join(copy, `${last.tag}.sql`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}--> statement-breakpoint\nUPDATE tasks SET id = id;\n`);
    const r = run(copy);
    expect(r.stdout).toContain(`MISMATCH ${last.tag}`);
  });
});
