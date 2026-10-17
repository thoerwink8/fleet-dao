// PR 头的完整检出、第 2 轮增量 diff：用临时镜像，不碰本机的引擎镜像。
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutBlockedAlert,
  checkoutPrHead,
  incrementalDiffAtHead,
  placeVerifyCheckout,
  VERIFY_CHECKOUT_FALLBACK,
} from '../src/cold-verify-run.ts';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  return result.stdout.trim();
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

  async function mirrorWith(
    files: { path: string; text: string }[],
  ): Promise<{ head: string; first: string }> {
    state = mkdtempSync(join(tmpdir(), 'fleet-verify-mirror-'));
    process.env.FLEET_GITHUB_STATE_DIR = state;
    const bare = join(state, 'mirrors', 'acme', 'demo.git');
    mkdirSync(join(state, 'mirrors', 'acme'), { recursive: true });
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare], { env: gitEnv });
    const work = join(state, 'work');
    await execFileAsync('git', ['init', '-b', 'main', work], { env: gitEnv });
    const commit = async (message: string) => {
      await git(work, ['add', '.']);
      await git(work, ['commit', '-m', message]);
      return git(work, ['rev-parse', 'HEAD']);
    };
    const firstFile = files[0];
    if (firstFile === undefined) throw new Error('至少要一个文件');
    writeFileSync(join(work, firstFile.path), firstFile.text);
    const first = await commit('first');
    for (const file of files.slice(1)) writeFileSync(join(work, file.path), file.text);
    const head = files.length > 1 ? await commit('second') : first;
    await git(work, ['remote', 'add', 'origin', bare]);
    await git(work, ['push', 'origin', 'HEAD']);
    return { head, first };
  }

  it('检出里能读到 PR 头上的文件', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, 'checkout');
    await checkoutPrHead(dest, head, 'task:acme/demo#12');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
  });

  it('增量 diff 只含上一轮头之后的改动', async () => {
    const { head, first } = await mirrorWith([
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

  it('目录本来可写：直接检出，不修、不报警', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, '_tmp', 'verify-ok');
    const repairs: string[] = [];
    const logs: string[] = [];
    const blocked: string[] = [];
    const placed = await placeVerifyCheckout({
      dir: dest,
      head,
      workflowId: 'task:acme/demo#12',
      repair: async (dir) => {
        repairs.push(dir);
      },
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('full');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(repairs).toEqual([]);
    expect(logs).not.toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(blocked).toEqual([]);
  });

  it('模拟 _tmp 为 root:root 755：先 EACCES，修好后再放进 PR 头的完整检出，不走退路', async () => {
    const { head } = await mirrorWith([{ path: 'hello.txt', text: 'hello\n' }]);
    const dest = join(state, '_tmp', 'verify-e75af80b');
    let denied = true;
    const repairs: string[] = [];
    const logs: string[] = [];
    const blocked: string[] = [];
    const placed = await placeVerifyCheckout({
      dir: dest,
      head,
      workflowId: 'task:acme/demo#12',
      checkout: async (dir, headSha, workflowId) => {
        // 夹具：引擎用户在 root:root 755 的 _tmp 下 mkdir。第一次拒绝，repair 之后放行。
        if (denied) {
          denied = false;
          throw Object.assign(new Error(`EACCES: permission denied, mkdir '${dir}'`), { code: 'EACCES' });
        }
        await checkoutPrHead(dir, headSha, workflowId);
      },
      repair: async (dir) => {
        repairs.push(dir);
      },
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('full');
    expect(readFileSync(join(dest, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(repairs).toEqual([dest]);
    expect(logs).not.toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(blocked).toEqual([]);
  });
});

describe('建不出检出目录时报警里有路径', () => {
  const dir = '/var/lib/fleet-work/_tmp/verify-e75af80b';

  it('修好了仍是 EACCES：走退路，报警正文含目录路径', async () => {
    const logs: string[] = [];
    const blocked: { body: string; dedupeKey: string }[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'a'.repeat(40),
      workflowId: 'task:acme/demo#12',
      checkout: async (target) => {
        throw Object.assign(new Error(`EACCES: permission denied, mkdir '${target}'`), { code: 'EACCES' });
      },
      repair: async () => undefined,
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async (alert) => {
        blocked.push({ body: alert.body, dedupeKey: alert.dedupeKey });
      },
    });
    expect(placed).toBe('blocked');
    expect(logs).toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(blocked).toEqual([
      {
        dedupeKey: 'cold-verify:checkout-dir',
        body: checkoutBlockedAlert(dir, `EACCES: permission denied, mkdir '${dir}'`).body,
      },
    ]);
    expect(blocked[0]?.body).toContain(dir);
  });

  it('修复本身失败：不第二次检出，报警正文仍含目录路径', async () => {
    const checkouts: string[] = [];
    const blocked: string[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'b'.repeat(40),
      workflowId: undefined,
      checkout: async (target) => {
        checkouts.push(target);
        throw Object.assign(new Error(`EACCES: permission denied, mkdir '${target}'`), { code: 'EACCES' });
      },
      repair: async () => {
        throw new Error('ensure-tmp 没换成');
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('blocked');
    expect(checkouts).toEqual([dir]);
    expect(blocked[0]).toContain(dir);
    expect(blocked[0]).toContain('ensure-tmp 没换成');
  });

  it('不是权限问题：不修，仍报警且正文含目录路径', async () => {
    const repairs: string[] = [];
    const blocked: string[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'c'.repeat(40),
      workflowId: undefined,
      checkout: async () => {
        throw new Error('引擎镜像里没有这个仓，放不了 PR 头的完整检出');
      },
      repair: async (target) => {
        repairs.push(target);
      },
      onBlocked: async (alert) => {
        blocked.push(alert.body);
      },
    });
    expect(placed).toBe('blocked');
    expect(repairs).toEqual([]);
    expect(blocked[0]).toContain(dir);
  });

  it('报警写不进库：仍是退路，不把验收停掉', async () => {
    const logs: string[] = [];
    const placed = await placeVerifyCheckout({
      dir,
      head: 'd'.repeat(40),
      workflowId: undefined,
      checkout: async () => {
        throw new Error('放不进去');
      },
      log: (message) => {
        logs.push(message);
      },
      onBlocked: async () => {
        throw new Error('库连不上');
      },
    });
    expect(placed).toBe('blocked');
    expect(logs).toContain(VERIFY_CHECKOUT_FALLBACK);
    expect(logs).toContain('冷验收检出目录的报警没写进库');
  });
});
