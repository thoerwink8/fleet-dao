// pnpm test:changed：改了哪些文件（git 每一步没成都报错，不当成没改动）、跑哪些测试（和 CI 按改动跑同一套判法）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readGraph } from '../src/ci-plan.ts';
import { fsRepo } from '../src/repo.ts';
import {
  ALWAYS_TESTS,
  BASE,
  changedFiles,
  type GitRun,
  selectTests,
  TestChangedError,
  vitestArgs,
} from '../src/test-changed.ts';

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

  describe('真 git（临时仓）', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
    const realGit =
      (cwd: string): GitRun =>
      (args) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
      };
    const sh = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8' });
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

  it('每次都跑的两份就是 CI docs job 跑的那两份', () => {
    const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const line = yml.split('\n').find((l) => l.includes('vitest run') && l.includes('doc-pointers'));
    expect(line?.trim()).toBe(`- run: pnpm exec vitest run ${ALWAYS_TESTS.join(' ')}`);
  });

  it('基准就是 origin/main（引擎钉在会话树里的也是它）', () => {
    expect(BASE).toBe('origin/main');
  });
});

describe('入口', () => {
  it('不收参数：给了就退出 2，一个测试都不跑', () => {
    const bin = fileURLToPath(new URL('../src/bin/test-changed.ts', import.meta.url));
    const r = spawnSync(process.execPath, [bin, 'packages/api'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('不收参数');
  });

  it('根目录的 pnpm test:changed 就是这个入口', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:changed']).toBe('node packages/conventions/src/bin/test-changed.ts');
  });
});
