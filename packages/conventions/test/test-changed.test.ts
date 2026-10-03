// pnpm test:changed：改了哪些文件（git 每一步没成都报错，不当成没改动）、跑哪些测试（和 CI 按改动跑同一套判法）、
// 要全跑时本机跑不跑。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readGraph } from '../src/ci-plan.ts';
import { fsRepo, type RepoView } from '../src/repo.ts';
import {
  ALWAYS_TESTS,
  BASE,
  changedFiles,
  changedUnits,
  ENGINE_SESSION_MARKER,
  type GitRun,
  REFUSED_FULL_RUN,
  selectTests,
  TestChangedError,
  testChanged,
  unitHasTests,
  vitestArgs,
} from '../src/test-changed.ts';
import { runChild } from './child.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GRAPH = readGraph(fsRepo(ROOT));

/** 假的 git：按命令的第一、二个词回话；没写到的命令当成成功、没输出。 */
function fakeGit(replies: Record<string, Partial<ReturnType<GitRun>>>) {
  const calls: string[][] = [];
  const git: GitRun = (args) => {
    calls.push([...args]);
    const key = args.includes('--cached')
      ? 'staged'
      : args[0] === 'diff' && args.some((a) => a.endsWith('...HEAD'))
        ? 'committed'
        : args[0] === 'diff'
          ? 'unstaged'
          : (args[0] as string);
    return { status: 0, stdout: '', stderr: '', ...replies[key] };
  };
  return { git, calls };
}

describe('改了哪些文件', () => {
  it('提交了的（和 origin/main 分叉以来，三个点）+ 暂存 + 没暂存 + 没跟踪，去重排序；-z 原样读中文名和空格', () => {
    const { git, calls } = fakeGit({
      committed: { stdout: 'packages/api/src/a.ts\0specs/164-会话内存与交活测试/方案.md\0' },
      staged: { stdout: 'packages/api/src/a.ts\0' },
      unstaged: { stdout: 'docs/ops.md\0' },
      'ls-files': { stdout: 'notes with space.md\0' },
    });
    expect(changedFiles(git)).toEqual([
      'docs/ops.md',
      'notes with space.md',
      'packages/api/src/a.ts',
      'specs/164-会话内存与交活测试/方案.md',
    ]);
    expect(calls[0]).toEqual(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
    expect(calls).toContainEqual(['diff', '--name-only', '-z', '--no-renames', 'origin/main...HEAD']);
    expect(calls).toContainEqual(['ls-files', '-z', '--others', '--exclude-standard']);
  });

  it('什么都没改：空列表（git 每一步都成了才算「没改动」）', () => {
    expect(changedFiles(fakeGit({}).git)).toEqual([]);
  });

  describe('没查成：报错，不当成没改动', () => {
    it('origin/main 读不到（本机没 fetch、引擎的树没钉好）：写明怎么办，后面的 git 一条都不跑', () => {
      const { git, calls } = fakeGit({ 'rev-parse': { status: 1 } });
      expect(() => changedFiles(git)).toThrow(TestChangedError);
      expect(() => changedFiles(git)).toThrow(/认不出 origin\/main.*git fetch origin.*fleet blocked/);
      expect(calls.every((c) => c[0] === 'rev-parse')).toBe(true);
    });

    it('git 起不来', () => {
      const { git } = fakeGit({ 'rev-parse': { status: null, error: new Error('spawn git ENOENT') } });
      expect(() => changedFiles(git)).toThrow(/git 跑不起来（spawn git ENOENT）/);
    });

    it('和 origin/main 没有共同祖先（git diff 三个点失败）', () => {
      const { git } = fakeGit({
        committed: { status: 128, stderr: 'fatal: origin/main...HEAD: no merge base\n' },
      });
      expect(() => changedFiles(git)).toThrow(/算和 origin\/main 分叉以来提交了什么.*no merge base/);
    });

    it('暂存、没暂存、没跟踪哪一步没成都报错（被信号杀掉也算）', () => {
      for (const key of ['staged', 'unstaged', 'ls-files']) {
        const { git } = fakeGit({ [key]: { status: 129, stderr: 'boom' } });
        expect(() => changedFiles(git), key).toThrow(/没成（boom）/);
      }
      const { git } = fakeGit({ 'ls-files': { status: null } });
      expect(() => changedFiles(git)).toThrow(/被信号杀掉/);
    });

    it('基准不像分支名（- 开头会被 git 当成参数）', () => {
      expect(() => changedFiles(fakeGit({}).git, '--output=x')).toThrow(/不像分支名/);
    });
  });

  // 同步起三十几个 git：不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 child.ts 开头）。
  describe('真 git（临时仓）', { timeout: 0 }, () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
    const realGit =
      (cwd: string): GitRun =>
      (args) => {
        const r = runChild('git', args, { cwd });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      };
    const sh = (cwd: string, ...args: string[]) => {
      const r = runChild('git', [...ID, ...args], { cwd });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
      return r.stdout.trim();
    };
    const put = (root: string, rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };

    it('分叉以来提交的、暂存的、没暂存的、没跟踪的都算上；主线后来的提交、忽略的文件不算', () => {
      const root = mkdtempSync(join(tmpdir(), 'fleet-test-changed-'));
      dir = root;
      sh(root, 'init', '-q', '-b', 'main');
      put(root, '.gitignore', 'node_modules/\n');
      put(root, 'packages/api/src/a.ts', 'a\n');
      put(root, 'packages/db/src/b.ts', 'b\n');
      put(root, 'docs/ops.md', 'ops\n');
      sh(root, 'add', '-A');
      sh(root, 'commit', '-q', '-m', 'base');
      sh(root, 'checkout', '-q', '-b', 'work');
      put(root, 'packages/api/src/a.ts', 'a2\n');
      sh(root, 'commit', '-q', '-am', 'work');
      // 主线在分叉之后又动了：三个点只比分叉点，主线自己改的不算这次的改动
      sh(root, 'checkout', '-q', 'main');
      put(root, 'packages/db/src/b.ts', 'b-main\n');
      sh(root, 'commit', '-q', '-am', 'main moved');
      sh(root, 'update-ref', 'refs/remotes/origin/main', 'main');
      sh(root, 'checkout', '-q', 'work');
      put(root, 'specs/164-会话内存与交活测试/方案.md', '方案\n');
      sh(root, 'add', 'specs');
      put(root, 'docs/ops.md', 'ops2\n');
      put(root, 'packages/web/新文件.ts', 'x\n');
      put(root, 'node_modules/x/index.js', 'x\n');
      expect(changedFiles(realGit(root))).toEqual([
        'docs/ops.md',
        'packages/api/src/a.ts',
        'packages/web/新文件.ts',
        'specs/164-会话内存与交活测试/方案.md',
      ]);

      // 钉的引用没了：报错
      sh(root, 'update-ref', '-d', 'refs/remotes/origin/main');
      expect(() => changedFiles(realGit(root))).toThrow(/认不出 origin\/main/);

      // 和主线没有共同祖先：报错
      sh(root, 'checkout', '-q', '--orphan', 'lonely');
      sh(root, 'commit', '-q', '-m', 'lonely');
      sh(root, 'update-ref', 'refs/remotes/origin/main', 'main');
      expect(() => changedFiles(realGit(root))).toThrow(/no merge base/);
    });
  });
});

describe('跑哪些测试：和 CI 按改动跑同一套判法', () => {
  const paths = (changed: string[]) => {
    const s = selectTests(changed, GRAPH);
    return s.kind === 'all' ? 'all' : s.paths;
  };

  it('只改文档（没有受影响的包）：只跑 CI 每个 PR 都跑的文档检查，不全跑、不算失败', () => {
    const s = selectTests(
      ['docs/decisions/0002-fusion.md', 'specs/164-会话内存与交活测试/方案.md', 'README.md'],
      GRAPH,
    );
    expect(s).toMatchObject({ kind: 'some', paths: [...ALWAYS_TESTS] });
    expect(vitestArgs(s)).toEqual(['run', ...ALWAYS_TESTS]);
  });

  it('什么都没改：只跑文档检查（不像 CI 那样把空改动升成全跑：本机没改动是正常的）', () => {
    expect(selectTests([], GRAPH)).toMatchObject({ kind: 'some', paths: [...ALWAYS_TESTS] });
  });

  it('改了引擎的工作流代码：跑引擎的全部测试（vitest --changed 顺着 import 找不到 Temporal 按路径打包的工作流）', () => {
    expect(paths(['packages/engine/src/workflows/subtask.ts'])).toContain('packages/engine/');
  });

  it('改了 db（含迁移）：db 和依赖它的包都测', () => {
    const p = paths(['packages/db/migrations/0011_x.sql']);
    expect(p).toContain('packages/db/');
    expect(p).toContain('packages/api/');
    expect(p).toContain('packages/engine/');
  });

  it('改了根配置、锁文件、shared：全跑', () => {
    for (const f of ['vitest.config.ts', 'pnpm-lock.yaml', 'package.json', 'packages/shared/src/domain.ts']) {
      const s = selectTests([f], GRAPH);
      expect(s.kind, f).toBe('all');
      expect(vitestArgs(s)).toEqual(['run']);
    }
  });

  it('包的依赖图读不出：照 CI 全跑，不少跑', () => {
    expect(selectTests(['packages/api/src/a.ts'], '读不到 packages/api/package.json')).toMatchObject({
      kind: 'all',
    });
  });

  it('CI 另外还跑的（格式和类型、演示版、装机测试）写出来，免得以为这里绿了 CI 一定绿', () => {
    expect(selectTests(['packages/web/src/app.css'], GRAPH).ciOnly).toEqual([
      '格式和类型（biome、tsc）',
      '演示版打包',
      '装机测试（deploy/test/run.sh）',
    ]);
    expect(selectTests(['docs/ops.md'], GRAPH).ciOnly).toEqual(['装机测试（deploy/test/run.sh --ops）']);
  });

  it('每次都跑的两份就是 CI 里 docs 那一步跑的那两份', () => {
    const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const line = yml.split('\n').find((l) => l.includes('vitest run') && l.includes('doc-pointers'));
    // docs 那步在 lint job 里、和 biome/tsc 并行跑（后台进程、日志进 $LOGS），不是单行 `- run:`。
    expect(line).toContain(`pnpm exec vitest run ${ALWAYS_TESTS.join(' ')}`);
  });

  it('基准就是 origin/main（引擎钉在会话树里的也是它）', () => {
    expect(BASE).toBe('origin/main');
  });
});

// 整段流程（testChanged）换上假的 git、假的仓、假的 vitest 跑：看跑不跑、打了什么、退出码。
describe('要全跑时本机不跑：写明原因和单跑的命令，退出码 3（全量交给 CI）', () => {
  const REPO = memRepo({
    'packages/api/test/cli.test.ts': '',
    'packages/api/src/cli.ts': '',
    'packages/shared/src/domain.ts': '',
    'packages/web/src/app.test.tsx': '',
    'agents/test/discuss.test.ts': '',
  });
  type VitestResult = ReturnType<Parameters<typeof testChanged>[0]['vitest']>;
  const run = (
    changed: string[],
    opts: {
      argv?: string[];
      env?: Record<string, string>;
      repo?: RepoView;
      vitest?: () => VitestResult;
    } = {},
  ) => {
    const { git } = fakeGit({ committed: { stdout: changed.map((f) => `${f}\0`).join('') } });
    const out: string[] = [];
    const err: string[] = [];
    const vitestCalls: string[][] = [];
    const code = testChanged({
      argv: opts.argv ?? [],
      env: opts.env ?? {},
      git,
      repo: opts.repo ?? REPO,
      graph: () => GRAPH,
      vitest: (args) => {
        vitestCalls.push(args);
        return opts.vitest?.() ?? { status: 0 };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err, vitestCalls };
  };

  it('【故意造出的情形】要全跑、本机、没带 --all：一个测试都不跑，退出码 3，写明原因、改到的包各自单跑的命令、怎么真全跑', () => {
    const r = run([
      'pnpm-lock.yaml',
      'packages/api/src/cli.ts',
      'packages/shared/src/domain.ts',
      'agents/skills/discuss/scripts/ask.mjs',
    ]);
    expect(r.code).toBe(REFUSED_FULL_RUN);
    expect(REFUSED_FULL_RUN).toBe(3);
    expect(r.vitestCalls).toEqual([]);
    // 为什么要全跑照 CI 那套判法打出来（哪个文件、落到哪一条）
    expect(r.out.some((l) => l.startsWith('- pnpm-lock.yaml：'))).toBe(true);
    expect(r.err[0]).toContain('要全跑');
    expect(r.err[0]).toContain('全量交给 CI');
    expect(r.err).toEqual(
      expect.arrayContaining([
        '改到的包各自单跑：',
        '  pnpm exec vitest run agents/test/',
        '  pnpm exec vitest run packages/api/',
        '  pnpm exec vitest run packages/shared/（这个包自己没有测试，不用跑）',
        '真要在本机全跑：pnpm test:changed --all',
      ]),
    );
    expect(r.err.at(-1)).toContain('退出码 3（不是测试没过）');
  });

  it('只改了根配置：没有要单跑的包，照样不跑、退出码 3', () => {
    const r = run(['vitest.config.ts']);
    expect(r.code).toBe(REFUSED_FULL_RUN);
    expect(r.vitestCalls).toEqual([]);
    expect(r.err).toContain('这次没改到哪个包的代码，没有要单跑的。');
  });

  it('带 --all：本机全跑（vitest run 不带过滤），退出码照 vitest 的', () => {
    const r = run(['pnpm-lock.yaml'], { argv: ['--all'], vitest: () => ({ status: 1 }) });
    expect(r.vitestCalls).toEqual([['run']]);
    expect(r.out).toContain('带了 --all：本机全跑');
    expect(r.code).toBe(1);
  });

  it('在 CI 里（CI=true）照旧全跑；CI 写成 false、0、空的不算在 CI 里', () => {
    expect(run(['pnpm-lock.yaml'], { env: { CI: 'true' } }).vitestCalls).toEqual([['run']]);
    for (const CI of ['false', '0', '']) {
      expect(run(['pnpm-lock.yaml'], { env: { CI } }).code, CI).toBe(REFUSED_FULL_RUN);
    }
  });

  it('引擎起的会话（环境里有会话标记）照旧全跑：拒跑的话交活永远过不了；会话在有内存上限的 scope 里', () => {
    expect(ENGINE_SESSION_MARKER).toBe('FLEET_RUN_ID');
    const r = run(['packages/shared/src/domain.ts'], { env: { [ENGINE_SESSION_MARKER]: 'run-1' } });
    expect(r.vitestCalls).toEqual([['run']]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('引擎起的会话：照旧全跑');
    // 标记是空的不算
    expect(run(['packages/shared/src/domain.ts'], { env: { [ENGINE_SESSION_MARKER]: ' ' } }).code).toBe(
      REFUSED_FULL_RUN,
    );
  });

  it('不用全跑的照常只跑选中的；--all 能把它升成全跑', () => {
    const some = run(['packages/api/src/cli.ts']);
    expect(some.code).toBe(0);
    expect(some.vitestCalls[0]?.[0]).toBe('run');
    expect(some.vitestCalls[0]).toContain('packages/api/');
    expect(run(['packages/api/src/cli.ts'], { argv: ['--all'] }).vitestCalls).toEqual([['run']]);
  });

  it('给了 --all 以外的参数：退出码 2，一个测试都不跑，写明只收 --all', () => {
    const r = run(['packages/api/src/cli.ts'], { argv: ['packages/api'] });
    expect(r.code).toBe(2);
    expect(r.vitestCalls).toEqual([]);
    expect(r.err.join('\n')).toContain('只收 --all');
  });

  it('vitest 起不来：退出码 2；被信号杀掉：退出码 1，都不当成通过', () => {
    const missing = run(['packages/api/src/cli.ts'], {
      vitest: () => ({ status: null, error: new Error('找不到 vitest.mjs：先 pnpm install') }),
    });
    expect(missing.code).toBe(2);
    expect(missing.err.join('\n')).toContain('vitest 起不来（找不到 vitest.mjs');
    const killed = run(['packages/api/src/cli.ts'], { vitest: () => ({ status: null, signal: 'SIGKILL' }) });
    expect(killed.code).toBe(1);
    expect(killed.err.join('\n')).toContain('被信号 SIGKILL 杀掉了');
  });

  it('改到的文件落到哪几个单元：包、agents；根配置、文档、deploy 不算', () => {
    expect(
      changedUnits([
        'packages/api/src/a.ts',
        'packages/api/test/b.test.ts',
        'agents/skills/x/SKILL.md',
        'deploy/france.sh',
        'docs/ops.md',
        'pnpm-lock.yaml',
      ]),
    ).toEqual(['agents/test/', 'packages/api/']);
  });

  it('包有没有测试：src、test 下认 .test.ts(x)；目录列不出来的不说「没有」', () => {
    expect(unitHasTests(REPO, 'packages/api/')).toBe(true);
    expect(unitHasTests(REPO, 'packages/web/')).toBe(true);
    expect(unitHasTests(REPO, 'packages/shared/')).toBe(false);
    expect(unitHasTests(REPO, 'agents/test/')).toBe(true);
    const unreadable: RepoView = {
      ...REPO,
      list: (rel) => (rel === 'packages/shared/src' ? undefined : REPO.list(rel)),
    };
    expect(unitHasTests(unreadable, 'packages/shared/')).toBeUndefined();
    const r = run(['packages/shared/src/domain.ts'], { repo: unreadable });
    expect(r.err).toContain('  pnpm exec vitest run packages/shared/');
  });
});

describe('入口', () => {
  // 同步起 node：不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 child.ts 开头）。
  it('只收 --all：给了别的参数就退出 2，一个测试都不跑', { timeout: 0 }, () => {
    const bin = fileURLToPath(new URL('../src/bin/test-changed.ts', import.meta.url));
    const r = runChild(process.execPath, [bin, 'packages/api']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('只收 --all');
  });

  it('根目录的 pnpm test:changed 就是这个入口', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:changed']).toBe('node packages/conventions/src/bin/test-changed.ts');
  });
});
