// pnpm test:changed：改了哪些文件（git 每一步没成都报错，不当成没改动）、跑哪些测试（和 CI 按改动跑同一套判法）、
// 要全跑时本机跑不跑、不跑时给出的清单（CI 每次都跑的那几份一份不少）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ALWAYS_JOBS,
  ALWAYS_TESTS,
  dependentsClosure,
  type PackageGraph,
  readGraph,
} from '../src/ci-plan.ts';
import { docNeedles, docReaders } from '../src/doc-readers.ts';
import { fsRepo, type RepoView } from '../src/repo.ts';
import {
  BASE,
  changedFiles,
  DOC_POINTERS_TEST,
  ENGINE_SESSION_MARKER,
  type GitRun,
  REFUSED_FULL_RUN,
  selectTests,
  TestChangedError,
  testChanged,
  vitestArgs,
} from '../src/test-changed.ts';
import { listTestFiles } from '../src/test-split.ts';
import { runChild } from './child.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GRAPH = readGraph(fsRepo(ROOT));
const graph = (): PackageGraph => {
  if (typeof GRAPH === 'string') throw new Error(GRAPH);
  return GRAPH;
};

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

type VitestResult = ReturnType<Parameters<typeof testChanged>[0]['vitest']>;

/** 整段流程（testChanged）换上假的 git、假的 vitest 跑：看跑不跑、打了什么、退出码。 */
function run(
  changed: string[],
  opts: {
    argv?: string[];
    env?: Record<string, string>;
    graph?: PackageGraph | string;
    docReaders?: Parameters<typeof testChanged>[0]['docReaders'];
    vitest?: () => VitestResult;
  } = {},
) {
  const { git } = fakeGit({ committed: { stdout: changed.map((f) => `${f}\0`).join('') } });
  const out: string[] = [];
  const err: string[] = [];
  const vitestCalls: string[][] = [];
  const code = testChanged({
    argv: opts.argv ?? [],
    env: opts.env ?? {},
    git,
    graph: () => opts.graph ?? GRAPH,
    docReaders: opts.docReaders,
    vitest: (args) => {
      vitestCalls.push(args);
      return opts.vitest?.() ?? { status: 0 };
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, vitestCalls };
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

  it('只改文档（没有受影响的包），没给「谁读文档」的判法：照 CI 每个 PR 都跑的整份，不全跑、不算失败', () => {
    const s = selectTests(
      ['docs/decisions/0002-fusion.md', 'specs/164-会话内存与交活测试/方案.md', 'README.md'],
      GRAPH,
    );
    expect(s).toMatchObject({ kind: 'some', paths: [...ALWAYS_TESTS] });
    expect(vitestArgs(s)).toEqual(['run', ...ALWAYS_TESTS]);
  });

  it('文档指针检查是 CI 每次都跑的一份（只改文档时本机仍带它）', () => {
    expect(ALWAYS_TESTS).toContain(DOC_POINTERS_TEST);
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

  it('CI 另外还跑的（格式和类型、前端打包、装机测试）写出来，免得以为这里绿了 CI 一定绿', () => {
    expect(selectTests(['packages/web/src/app.css'], GRAPH).ciOnly).toEqual([
      '格式和类型（biome、tsc）',
      '驾驶舱前端打包',
      '驾驶舱 e2e（pnpm --filter @fleet-dao/web e2e，要真 Postgres，见 packages/web/e2e/README.md）',
      '装机测试（deploy/test/run.sh）',
    ]);
    expect(selectTests(['docs/ops.md'], GRAPH).ciOnly).toEqual(['装机测试（deploy/test/run.sh --ops）']);
  });

  it('基准就是 origin/main（引擎钉在会话树里的也是它）', () => {
    expect(BASE).toBe('origin/main');
  });
});

describe('只改文档：只跑读这些文档的测试，不拖上 agents/test/ 整个目录', () => {
  // 路径拆开写：这个文件自己若写着完整的文档路径，改那份文档时会被它自己选上
  const D = 'docs';
  const PROGRESS = `${D}/PROGRESS.md`;
  const DESIGN = `${D}/design.md`;
  const ARCHIVE_PAGE = `${D}/archive/progress-2026-09-30.md`;
  const realReaders = (docs: readonly string[]) => docReaders(fsRepo(ROOT), docs);
  const ALL = listTestFiles(fsRepo(ROOT));
  if (typeof ALL === 'string') throw new Error(ALL);
  /** 交给 vitest 的过滤会跑的测试文件（vitest 的子串过滤）。 */
  const filesOf = (filters: readonly string[]) => ALL.filter((f) => filters.some((p) => f.includes(p)));
  const sel = (changed: string[], readers: Parameters<typeof selectTests>[2]) => {
    const s = selectTests(changed, GRAPH, readers);
    if (s.kind !== 'some') throw new Error(`只改文档不该全跑：${changed.join(' ')}`);
    return s;
  };

  it('改进度文档：跑文档指针检查加读它的几个测试，不是 agents/test/ 的三十个文件', () => {
    const s = sel([PROGRESS], realReaders);
    expect(s.paths).toContain(DOC_POINTERS_TEST);
    expect(s.paths).toContain('agents/test/progress-structure.test.ts');
    expect(s.paths).toContain('agents/test/session-start.test.ts');
    expect(s.paths).not.toContain('agents/test/');
    const files = filesOf(s.paths);
    expect(files.length).toBeLessThan(10);
    expect(files.length).toBeLessThan(filesOf(ALWAYS_TESTS).length);
    expect(s.reasons.join('\n')).toContain('只改文档');
    expect(s.ciOnly.join('\n')).toContain('agents/test/');
    expect(vitestArgs(s)).toEqual(['run', ...s.paths]);
  });

  it('改设计文档、归档页：各自读它们的测试照跑', () => {
    expect(sel([DESIGN], realReaders).paths).toContain('agents/test/skills.test.ts');
    expect(sel([ARCHIVE_PAGE], realReaders).paths).toContain('agents/test/progress-structure.test.ts');
  });

  it('没有测试读的文档（比如目标）：只剩文档指针检查，不拿空清单冒充没事', () => {
    expect(sel([`${D}/goals.md`], realReaders).paths).toEqual([DOC_POINTERS_TEST]);
  });

  // 金丝雀：这几份文档确实被这几个测试读着。选择器漏了其中一条，改那份文档的 PR 就绕过了钉着它的测试。
  const CANARIES: [string, string][] = [
    [PROGRESS, 'agents/test/progress-structure.test.ts'],
    [ARCHIVE_PAGE, 'agents/test/progress-structure.test.ts'],
    [DESIGN, 'agents/test/skills.test.ts'],
  ];
  const missedCanaries = (readers: Parameters<typeof selectTests>[2]) =>
    CANARIES.filter(([doc, test]) => !sel([doc], readers).paths.includes(test)).map(
      ([doc, test]) => `${doc} → ${test}`,
    );

  it('金丝雀：读着这几份文档的测试，改文档时都选得到', () => {
    expect(missedCanaries(realReaders)).toEqual([]);
  });

  it('【故意造出的失败】选择器什么都没选到：金丝雀正好逐条报出来（改了被读的文档却没选中读它的测试就红）', () => {
    expect(missedCanaries(() => [])).toEqual(CANARIES.map(([doc, test]) => `${doc} → ${test}`));
  });

  it('【故意造出的失败】测试源码读不出（没给判法、判法报一句为什么）：退回 CI 每次都跑的整份，不当成没有读它的测试', () => {
    for (const readers of [undefined, () => '读不到测试文件 x']) {
      const s = sel([PROGRESS], readers);
      expect(s.paths).toEqual([...ALWAYS_TESTS]);
    }
    expect(sel([PROGRESS], () => '读不到测试文件 x').reasons.join('\n')).toContain('退回 CI 每次都跑的整份');
  });

  it('文档和代码一起改：不缩，照原来的判法（改到的包 + CI 每次都跑的整份）', () => {
    const s = sel([PROGRESS, 'packages/cli/src/help.ts'], () => {
      throw new Error('带代码改动时不该问谁读文档');
    });
    expect(s.paths).toContain('packages/cli/');
    for (const p of ALWAYS_TESTS) expect(s.paths).toContain(p);
  });

  it('改了读 docs/ops.md 的包（有 deploy 测试）、AGENTS.md：不算只改文档，照原来的判法', () => {
    for (const f of [`${D}/ops.md`, 'AGENTS.md']) {
      const s = sel([f], () => {
        throw new Error('不该问谁读文档');
      });
      for (const p of ALWAYS_TESTS) expect(s.paths, f).toContain(p);
      expect(s.paths.length, f).toBeGreaterThan(ALWAYS_TESTS.length);
    }
  });

  it('整段流程：只改进度文档跑的是缩小后的清单、退出码 0；列不出测试文件时照整份跑（不是 0 个、也不是 3）', () => {
    const r = run([PROGRESS], { docReaders: realReaders });
    expect(r.code).toBe(0);
    expect(r.vitestCalls).toHaveLength(1);
    expect(r.vitestCalls[0]).toContain(DOC_POINTERS_TEST);
    expect(r.vitestCalls[0]).not.toContain('agents/test/');
    const broken = run([PROGRESS], { docReaders: () => '列不出测试文件：x' });
    expect(broken.code).toBe(0);
    expect(broken.vitestCalls[0]).toEqual(['run', ...ALWAYS_TESTS]);
  });

  describe('谁读这份文档（doc-readers.ts）', () => {
    /** 内存里的仓：只有文件内容，目录从路径推。 */
    const memRepo = (files: Record<string, string>): RepoView => {
      const names = (dir: string) => {
        const prefix = dir === '' ? '' : `${dir}/`;
        const out = new Set<string>();
        for (const f of Object.keys(files))
          if (f.startsWith(prefix)) out.add(f.slice(prefix.length).split('/')[0] as string);
        return out.size === 0 ? undefined : [...out];
      };
      return {
        read: (rel) => files[rel],
        exists: (rel) => rel in files || names(rel) !== undefined,
        isDir: (rel) => !(rel in files) && names(rel) !== undefined,
        list: (rel) => (rel in files ? undefined : names(rel)),
      };
    };
    const base = {
      'agents/test/a.test.ts': "readFileSync(join(ROOT, 'docs', 'x.md'))",
      'agents/test/b.test.ts': "read('docs/x.md')",
      'agents/test/c.test.ts': "read('docs/y.md')",
      'packages/p/test/d.test.ts': "new URL('../../../docs/archive/z.md', import.meta.url)",
      'packages/p/test/e.test.ts': "read('README.md')",
    };

    it('整条路径、一段一段写的 join、上面带斜杠的目录都认；没提到的不选', () => {
      const repo = memRepo(base);
      expect(docReaders(repo, ['docs/x.md'])).toEqual(['agents/test/a.test.ts', 'agents/test/b.test.ts']);
      expect(docReaders(repo, ['docs/archive/other.md'])).toEqual(['packages/p/test/d.test.ts']);
      expect(docReaders(repo, ['docs/nobody.md'])).toEqual([]);
    });

    it('仓根下的单个文件（README.md）只认指向仓根的写法，不被「README.md」这个词到处当夹具拖上全部', () => {
      const repo = memRepo({ ...base, 'packages/p/test/f.test.ts': "read(join(REPO_ROOT, 'README.md'))" });
      expect(docReaders(repo, ['README.md'])).toEqual(['packages/p/test/f.test.ts']);
      expect(docNeedles('README.md')).toHaveLength(2);
    });

    it('【故意造出的失败】列不出测试文件、读不到某个测试文件：返回一句为什么，不返回空清单', () => {
      expect(docReaders(memRepo({ 'x.md': '' }), ['docs/x.md'])).toMatch(/^列不出测试文件/);
      const repo = memRepo(base);
      const unreadable: RepoView = {
        ...repo,
        read: (rel) => (rel === 'agents/test/b.test.ts' ? undefined : repo.read(rel)),
      };
      expect(docReaders(unreadable, ['docs/x.md'])).toMatch(/^读不到测试文件 agents\/test\/b\.test\.ts/);
    });
  });
});

describe('要全跑时本机不跑：写明原因、全量交给 CI，不再教人单跑对应包，退出码 3（#1066）', () => {
  /** 拒跑的提示里不许再出现教人单跑的命令。 */
  const teachesSingleRun = (err: readonly string[]) => err.some((l) => /vitest run/.test(l));

  it('【故意造出的情形】要全跑、本机、没带 --all：一个测试都不跑，退出码 3，写明原因、交给 CI、怎么真全跑；不教单跑对应包', () => {
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
    expect(r.err[1]).toContain('其余交给 CI，红了再回来修');
    expect(teachesSingleRun(r.err)).toBe(false);
    expect(r.err.join('\n')).not.toContain('单跑');
    expect(r.err).toContain('真要在本机全跑：pnpm test:changed --all');
    expect(r.err.at(-1)).toContain('退出码 3（不是测试没过）');
  });

  it('改了 shared：依赖 shared 的写出来、留给 CI 全跑去测；不再给本机先跑的清单', () => {
    const r = run(['packages/shared/src/domain.ts']);
    expect(r.code).toBe(REFUSED_FULL_RUN);
    // 依赖 shared 的（依赖图里直接间接依赖它的，加上测试读它们的）一个不少写出来；
    // agents 不在依赖图里，它的测试读 db 的路由骨架（ci-plan.ts 的 TEST_READS），db 依赖 shared，所以也在里面
    const users = [
      ...[...dependentsClosure(graph(), ['shared'])].filter((u) => u !== 'shared'),
      'agents',
    ].sort();
    expect(users.length).toBeGreaterThan(5);
    expect(r.err).toContain(`依赖 shared 的也要跑——本机不逐个跑，CI 全跑会测到：${users.join('、')}`);
    expect(r.err.join('\n')).not.toContain('packages/<包>/');
  });

  it('db 和锁文件一起改：db 和依赖它的本来就在「本机不跑」里，不另列留给 CI 的依赖行', () => {
    const r = run(['pnpm-lock.yaml', 'packages/db/src/schema/index.ts']);
    expect(r.code).toBe(REFUSED_FULL_RUN);
    expect(r.vitestCalls).toEqual([]);
    expect(r.err.some((l) => l.startsWith('依赖 '))).toBe(false);
    expect(teachesSingleRun(r.err)).toBe(false);
  });

  it('只改了根配置：照样不跑、退出码 3、交给 CI', () => {
    const r = run(['vitest.config.ts']);
    expect(r.code).toBe(REFUSED_FULL_RUN);
    expect(r.vitestCalls).toEqual([]);
    expect(r.err[1]).toContain('其余交给 CI');
    expect(r.err.some((l) => l.startsWith('依赖 '))).toBe(false);
  });

  it('【故意造出的失败】依赖图读不出：照 CI 全跑（本机拒跑），写明依赖它的算不出来、不当成没人依赖', () => {
    const r = run(['packages/api/src/cli.ts'], { graph: '读不到 packages/api/package.json' });
    expect(r.code).toBe(REFUSED_FULL_RUN);
    expect(r.err).toContain(
      '包依赖图读不出（读不到 packages/api/package.json），依赖改到的包的算不出来：CI 全跑会测到。',
    );
    expect(teachesSingleRun(r.err)).toBe(false);
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
});

describe('CI 每次都跑的测试：test:changed 给出的清单一定包含（#740）', () => {
  const YML = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  /**
   * ci.yml 里不管改了什么都跑的测试：每次都跑的 job（ci-plan.ts 的 ALWAYS_JOBS）里，`vitest run` 后面全是写死路径的那几处。
   * 参数带 `$` 的是按开关、按台算出来的（比如 test job 的 "${box[@]}"），不算。认解析出来的 run 脚本，不认行号、缩进。
   */
  const ciAlwaysTests = (yml: string): string[] => {
    const doc = parse(yml) as { jobs?: Record<string, { steps?: { run?: unknown }[] } | undefined> };
    const out: string[] = [];
    for (const id of ALWAYS_JOBS) {
      for (const step of doc.jobs?.[id]?.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        for (const m of step.run.matchAll(/\bvitest run\b([^\n;&|)]*)/g)) {
          const args = (m[1] ?? '')
            .trim()
            .split(/\s+/)
            .filter((a) => a !== '');
          if (args.some((a) => a.includes('$'))) continue;
          out.push(...args.filter((a) => !a.startsWith('-')));
        }
      }
    }
    return out;
  };
  const CI_ALWAYS = ciAlwaysTests(YML);
  const ALL = listTestFiles(fsRepo(ROOT));
  if (typeof ALL === 'string') throw new Error(ALL);
  /** 一串过滤交给 vitest 会跑哪些测试文件（照 vitest 的 filterFiles：仓内路径里含过滤串就收，不分大小写）。 */
  const filesOf = (filters: readonly string[]) =>
    ALL.filter((f) => filters.some((p) => f.toLowerCase().includes(p.toLowerCase())));
  /** CI 每次都跑、这份清单却跑不到的测试文件。 */
  const uncovered = (list: readonly string[]) => {
    const got = new Set(filesOf(list));
    return filesOf(CI_ALWAYS).filter((f) => !got.has(f));
  };
  /** test:changed 给出的清单：跑了的是交给 vitest 的过滤；拒跑的什么都不跑、也不再打清单（全量交给 CI，#1066），所以是空的。 */
  const listOf = (r: ReturnType<typeof run>) => r.vitestCalls.flatMap((args) => args.slice(1));

  it('从 ci.yml 读得出来，正好就是 ALWAYS_TESTS（多一份、少一份都红），每一份都跑得到真测试文件', () => {
    expect(CI_ALWAYS.length, 'ci.yml 里一处每次都跑的测试都没读到：这里查的东西不在了').toBeGreaterThan(0);
    expect([...CI_ALWAYS].sort()).toEqual([...ALWAYS_TESTS].sort());
    for (const p of CI_ALWAYS) expect(filesOf([p]).length, p).toBeGreaterThan(0);
  });

  it('【故意造出的失败】ci.yml 的 docs 那步多跑一份：读出来的跟着多那一份，和 ALWAYS_TESTS 对不上', () => {
    const more = YML.replace(ALWAYS_TESTS.join(' '), `${ALWAYS_TESTS.join(' ')} packages/hygiene/test/`);
    expect(more, 'ci.yml 里找不到 docs 那步的写法了：这条的改法跟着换').not.toBe(YML);
    expect(ciAlwaysTests(more).sort()).toEqual([...ALWAYS_TESTS, 'packages/hygiene/test/'].sort());
  });

  // 每种走法各一个：没改动、只改文档、改一个包、改 skill（只跑选中的）；shared、锁文件、CI 工作流、deploy/、夹具、
  // 认不出的路径、shared 和别的包一起改、依赖图读不出（拒跑：一个测试都不跑，CI 每次都跑的那几份由 CI 自己跑）
  const CASES: { changed: string[]; graph?: string; code: number }[] = [
    { changed: [], code: 0 },
    { changed: ['docs/design.md'], code: 0 },
    { changed: ['packages/cli/src/help.ts'], code: 0 },
    { changed: ['agents/skills/discuss/SKILL.md'], code: 0 },
    { changed: ['packages/shared/src/domain.ts'], code: REFUSED_FULL_RUN },
    { changed: ['pnpm-lock.yaml'], code: REFUSED_FULL_RUN },
    { changed: ['.github/workflows/ci.yml'], code: REFUSED_FULL_RUN },
    { changed: ['deploy/france.sh'], code: REFUSED_FULL_RUN },
    { changed: ['packages/adapters/test/fixtures/claude-code/x.ndjson'], code: REFUSED_FULL_RUN },
    { changed: ['LICENSE'], code: REFUSED_FULL_RUN },
    { changed: ['packages/shared/src/domain.ts', 'packages/db/src/schema/index.ts'], code: REFUSED_FULL_RUN },
    {
      changed: ['packages/api/src/cli.ts'],
      graph: '读不到 packages/api/package.json',
      code: REFUSED_FULL_RUN,
    },
  ];

  it('跑的时候，给出的清单都跑得到 CI 每次都跑的那几份；拒跑的一个测试都不跑（CI 自己跑那几份）', () => {
    for (const c of CASES) {
      const r = run(c.changed, c.graph === undefined ? {} : { graph: c.graph });
      const label = `${c.changed.join(' ') || '（没改动）'}${c.graph === undefined ? '' : `（${c.graph}）`}`;
      expect(r.code, label).toBe(c.code);
      if (c.code === REFUSED_FULL_RUN) {
        expect(r.vitestCalls, label).toEqual([]);
        continue;
      }
      expect(listOf(r).length, label).toBeGreaterThan(0);
      expect(uncovered(listOf(r)), label).toEqual([]);
    }
  });

  it('【故意造出的失败】从清单里摘掉 CI 每次都跑的任一份：报出来的正好是那一份的测试文件，不是空、也不是别的', () => {
    const list = listOf(run(['packages/cli/src/help.ts']));
    expect(uncovered(list)).toEqual([]);
    for (const drop of CI_ALWAYS) {
      const cut = list.filter((p) => p !== drop);
      expect(cut, `${drop} 不在清单里：这条摘不掉东西，等于没查`).toHaveLength(list.length - 1);
      const missed = uncovered(cut);
      expect(missed.length, drop).toBeGreaterThan(0);
      expect(missed, drop).toEqual(filesOf([drop]));
    }
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
