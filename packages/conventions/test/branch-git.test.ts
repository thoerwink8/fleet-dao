// 分支体检的「内容」那几样（branch-git.ts）：在临时仓里真跑 git，造出没产出的几种（分支就是主线的祖先、改动已经 squash 进主线、
// 合进去以后主线又改过）和有产出的几种（主线上没有的新文件、分支删了主线还在的文件、和主线没有共同祖先）；
// 读不到、认不出的每一条故意造出来，断言是抛出（调用方记「没查成」），不是「没产出」。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BranchGitError,
  contentFacts,
  type GitExec,
  type MainIndex,
  mainIndex,
  parseRaw,
} from '../src/branch-git.ts';
import { runChild } from './child.ts';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];

// 同步起几十个 git：用例和建仓的钩子都不设 vitest 的超时，卡死由子进程自己的上限管（为什么见 child.ts 开头）。
describe('分支体检：内容那几样（真 git，临时仓）', { timeout: 0 }, () => {
  let root = '';
  const heads: Record<string, string> = {};
  let main = '';
  const sh = (...args: string[]) => {
    const r = runChild('git', [...ID, ...args], { cwd: root });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const git: GitExec = (args, input) => {
    const r = runChild('git', args, { cwd: root, ...(input === undefined ? {} : { input }) });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fleet-branch-git-'));
    sh('init', '-q', '-b', 'main');
    put('a.txt', 'a\n');
    put('keep.txt', 'k\n');
    put('specs/中文/方案.md', 'x\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'base');
    // 就是主线的祖先：一个提交都没多
    heads.empty = sh('rev-parse', 'HEAD');

    sh('checkout', '-q', '-b', 'squashed');
    put('a.txt', 'a2\n');
    sh('commit', '-q', '-am', 'a2');
    heads.squashed = sh('rev-parse', 'HEAD');

    sh('checkout', '-q', 'main');
    sh('checkout', '-q', '-b', 'evolved');
    put('b.txt', 'b\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'b');
    heads.evolved = sh('rev-parse', 'HEAD');

    sh('checkout', '-q', 'main');
    sh('checkout', '-q', '-b', 'unique');
    put('specs/中文/新.md', 'new\n');
    put('keep.txt', 'k-unique\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'wip: 半成品', '-m', 'Co-Authored-By: Claude Test <noreply@anthropic.com>');
    heads.unique = sh('rev-parse', 'HEAD');

    sh('checkout', '-q', 'main');
    sh('checkout', '-q', '-b', 'deleter');
    sh('rm', '-q', 'keep.txt');
    sh('commit', '-q', '-m', 'rm keep');
    heads.deleter = sh('rev-parse', 'HEAD');

    sh('checkout', '-q', '--orphan', 'orphan');
    sh('rm', '-rq', '--cached', '.');
    put('o.txt', 'o\n');
    sh('add', 'o.txt');
    sh('commit', '-q', '-m', 'orphan');
    heads.orphan = sh('rev-parse', 'HEAD');

    // 主线：squash 合了 squashed 的改动、合了 evolved 的 b.txt 之后又改了它
    sh('checkout', '-q', '-f', 'main');
    put('a.txt', 'a2\n');
    sh('commit', '-q', '-am', 'squash a2');
    put('b.txt', 'b\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'squash b');
    put('b.txt', 'b-later\n');
    sh('commit', '-q', '-am', 'b later');
    main = sh('rev-parse', 'HEAD');
    // 钩子的超时和用例分开算：一样不设（几十个 git 在满载的机器上十几秒），卡死由 runChild 的上限管
  }, 0);
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  let index: MainIndex;
  const facts = (name: string) => {
    index ??= mainIndex(git, main);
    const sha = heads[name];
    if (!sha) throw new Error(`没有 ${name}`);
    return contentFacts(git, index, sha);
  };

  it('主线的索引：现在的文件（中文路径原样，不转义）和历史上出现过的版本', () => {
    index ??= mainIndex(git, main);
    expect([...index.current.keys()].sort()).toEqual(['a.txt', 'b.txt', 'keep.txt', 'specs/中文/方案.md']);
    expect(index.history.size).toBeGreaterThanOrEqual(6);
  });

  it('分支就是主线的祖先：没产出，改动是空的', () => {
    const f = facts('empty');
    expect(f.output).toEqual({ kind: 'none', changed: 0 });
    expect(f.ahead).toBe(0);
    expect(f.behind).toBe(3);
  });

  it('改动已经 squash 进主线（同样的内容）：没产出', () => {
    expect(facts('squashed').output).toEqual({ kind: 'none', changed: 1 });
  });

  it('合进去以后主线又改过这个文件：这个版本主线历史上有过，没产出', () => {
    expect(facts('evolved').output).toEqual({ kind: 'none', changed: 1 });
  });

  it('主线上没有的新文件和改动：有产出，列出文件（中文路径原样）；作者、Co-Authored-By、提交说明读得出', () => {
    const f = facts('unique');
    expect(f.output).toEqual({ kind: 'some', changed: 2, files: ['keep.txt', 'specs/中文/新.md'] });
    expect(f.ahead).toBe(1);
    expect(f.authors).toEqual(['t']);
    expect(f.coAuthors).toEqual(['Claude Test']);
    expect(f.headSubject).toBe('wip: 半成品');
    expect(Number.isNaN(Date.parse(f.headDate))).toBe(false);
  });

  it('分支删了主线上还在的文件：删这件事主线上没有，算产出', () => {
    expect(facts('deleter').output).toEqual({ kind: 'some', changed: 1, files: ['keep.txt'] });
  });

  it('和主线没有共同祖先：判不了（unrelated），不当成没产出', () => {
    expect(facts('orphan').output).toEqual({ kind: 'unrelated' });
  });

  it('本地没有这个提交：抛，说先 git fetch origin', () => {
    index ??= mainIndex(git, main);
    expect(() => contentFacts(git, index, 'f'.repeat(40))).toThrow(
      /本地没有提交 fffffffff：先 git fetch origin/,
    );
    expect(() => mainIndex(git, 'e'.repeat(40))).toThrow(BranchGitError);
  });

  it('提交号不是 40 位十六进制：抛，不拿去跑 git', () => {
    index ??= mainIndex(git, main);
    expect(() => contentFacts(git, index, 'main')).toThrow(/提交号认不出：main/);
  });
});

describe('分支体检：git 跑不成、读回来认不出都抛', () => {
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const SHA = 'a'.repeat(40);
  const index: MainIndex = {
    sha: 'b'.repeat(40),
    current: new Map([['x', 'c'.repeat(40)]]),
    history: new Set(),
  };

  it('git 起不来：抛「git 跑不起来」', () => {
    const git: GitExec = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn git ENOENT'),
    });
    expect(() => contentFacts(git, index, SHA)).toThrow(/git 跑不起来（spawn git ENOENT）/);
  });

  it('找分叉点时 git 报错（不是「没有共同祖先」的退出码 1）：抛，不当成判不了', () => {
    const git: GitExec = (args) => {
      if (args[0] === 'cat-file') return ok();
      if (args[0] === 'log' && args.includes('-1')) return ok('2026-10-01T00:00:00+00:00\0提交\n');
      if (args[0] === 'rev-list') return ok('1\t2\n');
      if (args[0] === 'log') return ok('');
      if (args[0] === 'merge-base') return { status: 128, stdout: '', stderr: 'fatal: bad object' };
      throw new Error(`没料到 ${args.join(' ')}`);
    };
    expect(() => contentFacts(git, index, SHA)).toThrow(/找分叉点：git merge-base 没成（fatal: bad object）/);
  });

  it('分支头的提交时间认不出：抛', () => {
    const git: GitExec = (args) => (args[0] === 'log' ? ok('不是时间\0提交\n') : ok());
    expect(() => contentFacts(git, index, SHA)).toThrow(/读分支头的提交，认不出/);
  });

  it('改动清单里有认不出的一段：抛，不跳过（跳过的可能正是产出）', () => {
    expect(() => parseRaw(':100644 100644 zz M\0a.txt\0')).toThrow(/改动清单认不出/);
    expect(() => parseRaw(`:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0`)).toThrow(
      /改动清单认不出/,
    );
  });

  it('改动清单解析：状态、改完的对象号、路径（几个提交之间夹着换行也认得）', () => {
    const one = `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\0a b.txt\0`;
    const del = `\n:100644 000000 ${'3'.repeat(40)} ${'0'.repeat(40)} D\0specs/中文.md\0`;
    expect(parseRaw(one + del)).toEqual([
      { status: 'M', blob: '2'.repeat(40), path: 'a b.txt' },
      { status: 'D', blob: '0'.repeat(40), path: 'specs/中文.md' },
    ]);
    expect(parseRaw('')).toEqual([]);
  });

  it('主线一个文件都没列出来：抛，不当成空仓（空仓会让什么都算产出、或什么都算没产出）', () => {
    const git: GitExec = (args) => (args[0] === 'ls-tree' ? ok('') : ok());
    expect(() => mainIndex(git, 'b'.repeat(40))).toThrow(/主线上一个文件都没列出来/);
  });
});
