// 入口脚本（src/bin/）里要 Git 执行器的，一律用 git-runner.ts 的 gitRunner(root)，不许自己拼一个（#2783）。
// 为什么：bin/work.ts 以前自己写了一个，退出码非 0 时把 Node 的 err.message（"Command failed: git grep …"）塞进 stderr；
// git grep 一条没匹配时退出码是 1、stderr 是空的，directives.ts 判「没匹配」要的正是「退出码 1 且 stderr 空」，结果永远不成立，
// `pnpm work queue` 报「没查成：挂着的引导没读成」。gitRunner 的注释写了这个坑。
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitRunner } from '../src/git-runner.ts';
import { buildQueue } from '../src/work-queue.ts';
import { runChild } from './child.ts';

const BIN = new URL('../src/bin/', import.meta.url);
const bins = readdirSync(BIN).filter((n) => n.endsWith('.ts'));

describe('入口脚本不许自己拼 git 执行器', () => {
  it('找得到入口脚本（别让下面的检查空转）', () => {
    expect(bins).toContain('work.ts');
    expect(bins).toContain('progress.ts');
  });

  it.each(bins)('%s：声明了 Git 类型的执行器就必须来自 gitRunner(…)', (name) => {
    const text = readFileSync(new URL(name, BIN), 'utf8');
    const own = [...text.matchAll(/:\s*Git\s*=\s*([^\n]*)/g)].filter((m) => !/^gitRunner\(/.test(m[1] ?? ''));
    expect(
      own.map((m) => m[0]),
      `${name} 自己写了 git 执行器，改用 ../git-runner.ts 的 gitRunner(root)`,
    ).toEqual([]);
  });
});

describe('pnpm work queue 走到「git grep 没匹配」那条路径', () => {
  const dirs: string[] = [];
  beforeEach(() => {
    vi.stubEnv('GH_REPO', '');
    vi.stubEnv('GITHUB_REPOSITORY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** 临时仓：提交一个和引导无关的文件，origin/main 指到这个提交（docs/directives 不存在，git grep 没有匹配） */
  function repoWithoutDirectives(): string {
    const dir = mkdtempSync(join(tmpdir(), 'work-queue-grep-'));
    dirs.push(dir);
    const g = (...a: string[]) =>
      runChild('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    g('init', '-q');
    writeFileSync(join(dir, 'x.txt'), 'x');
    g('add', '-A');
    g('commit', '-q', '-m', 'c');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return dir;
  }

  it('没有挂着的引导：队列照列，problems 里没有「引导没读成」', async () => {
    const dir = repoWithoutDirectives();
    const r = await buildQueue({
      gh: async (args) => {
        if (args[0] === 'issue' && args[1] === 'list')
          return {
            code: 0,
            stdout: JSON.stringify([{ number: 5, title: 't', body: '', labels: [{ name: '本机做' }] }]),
            stderr: '',
          };
        if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'repo') return { code: 0, stdout: '{"nameWithOwner":"a/b"}', stderr: '' };
        return { code: 1, stdout: '', stderr: `没想到的 gh：${args.join(' ')}` };
      },
      git: gitRunner(dir),
      readBeats: () => [],
      readLeases: () => [],
      readFranceClaims: async () => [],
      now: () => new Date('2026-10-16T09:00:00Z'),
    });
    expect(r.problems.filter((p) => p.includes('引导'))).toEqual([]);
    expect(r.items.map((i) => i.issue)).toEqual([5]);
  });
});
