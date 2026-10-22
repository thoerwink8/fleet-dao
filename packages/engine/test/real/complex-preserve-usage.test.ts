// 生产占用核验走 root 帮手（readTreeUsageDetail）：答不出 idle 时，原因类别和核验阶段要进原保留错误；
// busy、unknown、取消、身份不符都留树，不删、不写可删除回执（#3557）。帮手读数由可控依赖摆布，夹具 ProcLook 不给。
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTreeUsageDetail, type TreeUsageReading } from '@fleet-dao/adapters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { preserveThenRemove } from '../../src/real/preserve-worktree.ts';
import type { UserTree } from '../../src/real/user-git.ts';
import { git } from './fixtures.ts';

vi.mock('@fleet-dao/adapters', async (original) => ({
  ...(await original<typeof import('@fleet-dao/adapters')>()),
  readTreeUsageDetail: vi.fn(),
}));

const usage = vi.mocked(readTreeUsageDetail);
let root: string;
let workRoot: string;
let archive: string;
let removed: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-usage-'));
  workRoot = join(root, 'work');
  archive = join(root, 'archive');
  mkdirSync(workRoot);
  removed = [];
  usage.mockReset();
  usage.mockResolvedValue({ state: 'idle' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dirtyTree(signal?: AbortSignal): UserTree {
  const dir = join(workRoot, 'acme_web/12-keep');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'dirty.txt'), 'dirty\n');
  return {
    exec: localExec(),
    user: 'fleet-agent-carpool',
    dir,
    scopePrefix: 'usage-test',
    git: 'git',
    sh: 'sh',
    ...(signal ? { signal } : {}),
  };
}

function run(t: UserTree) {
  return preserveThenRemove(
    t,
    archive,
    { workRoot, confirmIdle: async () => 'idle' },
    undefined,
    async () => {
      removed.push(t.dir);
      return { gone: true };
    },
  );
}

async function kept(t: UserTree): Promise<PortError> {
  const error = await run(t).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PortError);
  expect((error as PortError).code).toBe('WORKTREE_PRESERVED');
  expect(removed).toEqual([]);
  return error as PortError;
}

/** 已落盘的受管可删除回执。 */
function receipts(): string[] {
  let names: string[];
  try {
    names = readdirSync(archive).filter((name) => name.startsWith('worktree-'));
  } catch {
    return [];
  }
  return names.filter((name) => readdirSync(join(archive, name)).includes('receipt.json'));
}

describe('占用核验未知带原因和阶段进原保留错误', () => {
  it.each<[string, TreeUsageReading, string]>([
    ['调用失败', { state: 'unknown', reason: 'call-failed', exitCode: 3 }, '帮手调用失败'],
    ['取消', { state: 'unknown', reason: 'aborted' }, '核验被取消'],
    ['超时', { state: 'unknown', reason: 'timeout' }, '帮手调用超时'],
    ['协议无效', { state: 'unknown', reason: 'protocol' }, '帮手回执协议无效'],
    ['身份不符', { state: 'unknown', reason: 'identity' }, '回执身份和这棵树不符'],
    ['扫描不完整', { state: 'unknown', reason: 'incomplete', scanned: 0, failed: 2 }, '进程扫描不完整'],
    ['帮手明确未知', { state: 'unknown', reason: 'helper-unknown' }, '帮手答确认不了'],
  ])(
    '打快照前%s：留树、不打快照，阶段和类别写进原错误',
    async (_name, reading, said) => {
      const t = dirtyTree();
      usage.mockResolvedValueOnce(reading);
      const error = await kept(t);
      expect(error.message).toBe(
        `打快照前确认不了有没有进程用着这棵树（${reading.reason}：${said}），保留原树`,
      );
      const { state: _state, ...facts } = reading;
      expect(error.details).toEqual({ dir: t.dir, stage: '打快照前', usage: 'unknown', ...facts });
      expect(
        Buffer.byteLength(JSON.stringify({ message: error.message, details: error.details })),
      ).toBeLessThanOrEqual(512);
      expect(receipts()).toEqual([]);
    },
    30_000,
  );

  it('缺证的未知不冒充超时；读数没带原因也按原因未知', async () => {
    const t = dirtyTree();
    usage.mockResolvedValueOnce({ state: 'unknown' });
    const error = await kept(t);
    expect(error.message).toContain('（unknown：原因未知）');
    expect(error.message).not.toContain('超时');
    expect(error.details).toEqual({ dir: t.dir, stage: '打快照前', usage: 'unknown', reason: 'unknown' });
  }, 30_000);

  it('读取方真抛错：原文不进保留错误，按原因未知留树', async () => {
    const t = dirtyTree();
    const secret = `sudo -n /usr/local/sbin/fleet-agent-scope TOKEN=ghp_secret ${'x'.repeat(4096)}`;
    usage.mockRejectedValueOnce(new Error(secret));
    const error = await kept(t);
    expect(error.message).toBe('打快照前确认不了有没有进程用着这棵树（unknown：原因未知），保留原树');
    expect(error.details).toEqual({ dir: t.dir, stage: '打快照前', usage: 'unknown', reason: 'unknown' });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toMatch(
      /ghp_secret|sudo|fleet-agent-scope/,
    );
    expect(receipts()).toEqual([]);
  }, 30_000);

  it('读数里越界或非整数的计数不带进保留错误', async () => {
    const t = dirtyTree();
    usage.mockResolvedValueOnce({
      state: 'unknown',
      reason: 'incomplete',
      exitCode: -1,
      scanned: 1.5,
      failed: Number.MAX_SAFE_INTEGER + 2,
    });
    const error = await kept(t);
    expect(error.details).toEqual({ dir: t.dir, stage: '打快照前', usage: 'unknown', reason: 'incomplete' });
  }, 30_000);

  it('busy 不冒充 idle：打快照前就留树', async () => {
    const t = dirtyTree();
    usage.mockResolvedValueOnce({ state: 'busy' });
    const error = await kept(t);
    expect(error.message).toBe('打快照前有进程正用着这棵树，保留原树');
    expect(error.details).toEqual({ dir: t.dir, stage: '打快照前', usage: 'busy' });
    expect(receipts()).toEqual([]);
  }, 30_000);

  it('存档后二次核验未知：回执不落盘，留树', async () => {
    const t = dirtyTree();
    usage
      .mockResolvedValueOnce({ state: 'idle' })
      .mockResolvedValueOnce({ state: 'unknown', reason: 'timeout' });
    const error = await kept(t);
    expect(error.message).toBe('存档后确认不了有没有进程用着这棵树（timeout：帮手调用超时），保留原树');
    expect(error.details).toMatchObject({ stage: '存档后', reason: 'timeout' });
    expect(receipts()).toEqual([]);
    expect(usage).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('存档后 busy 也留树，不再说成确认不了', async () => {
    const t = dirtyTree();
    usage.mockResolvedValueOnce({ state: 'idle' }).mockResolvedValueOnce({ state: 'busy' });
    const error = await kept(t);
    expect(error.message).toBe('存档后有进程正用着这棵树，保留原树');
    expect(receipts()).toEqual([]);
  }, 60_000);

  it.each<[string, number, TreeUsageReading]>([
    ['回执复核时取消', 2, { state: 'unknown', reason: 'aborted' }],
    ['删除必经点身份变了', 3, { state: 'unknown', reason: 'identity' }],
    ['删除必经点 busy', 3, { state: 'busy' }],
  ])(
    '删除前%s：不调删除',
    async (_name, idleCalls, reading) => {
      const t = dirtyTree();
      for (let i = 0; i < idleCalls; i += 1) usage.mockResolvedValueOnce({ state: 'idle' });
      usage.mockResolvedValueOnce(reading);
      const error = await kept(t);
      expect(error.details).toMatchObject({ stage: '删除前', usage: reading.state });
      if (reading.reason) expect(error.message).toContain(`（${reading.reason}：`);
      expect(usage).toHaveBeenCalledTimes(idleCalls + 1);
    },
    60_000,
  );

  it('四次核验都 idle 才删；每次都按这棵树的身份和取消信号去问帮手', async () => {
    const signal = new AbortController().signal;
    const t = dirtyTree(signal);
    const done = await run(t);
    expect(done.gone).toBe(true);
    expect(removed).toEqual([t.dir]);
    expect(receipts()).toHaveLength(1);
    expect(usage).toHaveBeenCalledTimes(4);
    for (const [place, options] of usage.mock.calls) {
      expect(place).toMatchObject({ real: t.dir });
      expect(options).toEqual({ signal });
    }
  }, 60_000);
});
