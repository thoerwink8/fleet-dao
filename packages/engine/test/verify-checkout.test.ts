// PR 头的完整检出、第 2 轮增量 diff：用临时镜像，不碰本机的引擎镜像。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutPrHead, incrementalDiffAtHead } from '../src/cold-verify-run.ts';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

describe('PR 头的完整检出和增量 diff', () => {
  let state = '';
  const prev = process.env.FLEET_GITHUB_STATE_DIR;

  afterEach(() => {
    if (prev === undefined) delete process.env.FLEET_GITHUB_STATE_DIR;
    else process.env.FLEET_GITHUB_STATE_DIR = prev;
    if (state !== '') rmSync(state, { recursive: true, force: true });
    state = '';
  });

  function mirrorWith(files: { path: string; text: string }[]): { head: string; first: string } {
    state = mkdtempSync(join(tmpdir(), 'fleet-verify-mirror-'));
    process.env.FLEET_GITHUB_STATE_DIR = state;
    const bare = join(state, 'mirrors', 'acme', 'demo.git');
    mkdirSync(join(state, 'mirrors', 'acme'), { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { env: gitEnv });
    const work = join(state, 'work');
    execFileSync('git', ['init', '-b', 'main', work], { env: gitEnv });
    const commit = (message: string) => {
      git(work, ['add', '.']);
      git(work, ['commit', '-m', message]);
      return git(work, ['rev-parse', 'HEAD']);
    };
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error('至少要一个文件');
    writeFileSync(join(work, firstFile.path), firstFile.text);
    const first = commit('first');
    for (const file of files.slice(1)) writeFileSync(join(work, file.path), file.text);
    const head = files.length > 1 ? commit('second') : first;
    git(work, ['remote', 'add', 'origin', bare]);
    git(work, ['push', 'origin', 'HEAD']);
    return { head, first };
  }

  it('检出里能读到 PR 头上的文件', async () => {
    const { head } = mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, 'checkout');
    await checkoutPrHead(dest, head, 'task:acme/demo#12');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
  });

  it('增量 diff 只含上一轮头之后的改动', async () => {
    const { head, first } = mirrorWith([
      { path: 'hello.txt', text: 'hello\n' },
      { path: 'hello.txt', text: 'hello\nworld\n' },
    ]);
    const diff = await incrementalDiffAtHead({
      workflowId: 'task:acme/demo#12',
      sinceSha: first,
      headSha: head,
    });
    expect(diff.changedFiles).toEqual(['hello.txt']);
    expect(diff.diffText).toContain('+world');
    expect(diff.diffText).not.toContain('diff --git a/hello.txt b/hello.txt\nnew file');
  });
});
