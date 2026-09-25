// adoptWorktree：换会话用户接着干时，把一棵工作树的属主和过程记录转给另一个会话用户。真帮手的路径校验、
// chown、拷记录用真的 shell 脚本测（deploy/test/agent-scope-adopt.test.sh）；这里只验插头交给帮手的参数对不对、
// 各个退出码翻译成哪种结果——和 scope.test.ts 验 stopScope/scopePrefix 是同一个分工。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AdoptWorktreeInput, adoptWorktree } from '../src/procs.ts';
import { tempDir } from './helpers.ts';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'fake-scope-helper.ts');
const DIR = '/var/lib/fleet-work/repo1/task1';
const SESSION = '8e188c1c-4430-4735-9eb2-bbb3d9f012c6';

function input(over: Partial<AdoptWorktreeInput> = {}): AdoptWorktreeInput {
  return { dir: DIR, user: 'fleet-agent-dedicated', helper: HELPER, sudo: [process.execPath], ...over };
}

describe('adoptWorktree · 校验（挡明显不对的调用，起之前就拒；真正的边界在以 root 跑的帮手脚本里）', () => {
  it('工作树要绝对路径', () => {
    expect(() => adoptWorktree(input({ dir: 'repo1/task1' }))).toThrow('绝对路径');
  });

  it('工作树路径不许有控制字符', () => {
    expect(() => adoptWorktree(input({ dir: `${DIR}\r` }))).toThrow('控制字符');
  });

  it('--user 只能是两个会话用户之一', () => {
    expect(() => adoptWorktree(input({ user: 'root' as AdoptWorktreeInput['user'] }))).toThrow('会话用户');
  });

  it('--from 只能是两个会话用户之一', () => {
    expect(() =>
      adoptWorktree(input({ from: 'root' as AdoptWorktreeInput['user'], sessionId: SESSION })),
    ).toThrow('会话用户');
  });

  it('--from 和 --user 不能一样', () => {
    expect(() => adoptWorktree(input({ from: 'fleet-agent-dedicated', sessionId: SESSION }))).toThrow(
      '不能一样',
    );
  });

  it('--from 和会话编号要么都给要么都不给（拷会话记录要知道从哪个用户拷）', () => {
    expect(() => adoptWorktree(input({ from: 'fleet-agent-carpool' }))).toThrow('都给');
    expect(() => adoptWorktree(input({ sessionId: SESSION }))).toThrow('都给');
  });

  it('会话编号必须是 UUID', () => {
    expect(() => adoptWorktree(input({ from: 'fleet-agent-carpool', sessionId: 'latest' }))).toThrow('UUID');
  });
});

describe('adoptWorktree · 调帮手的参数与退出码（假帮手）', () => {
  let log: string;
  beforeEach(() => {
    log = join(tempDir(), 'adopt.log');
    process.env.FLEET_FAKE_SCOPE_LOG = log;
  });
  afterEach(() => {
    delete process.env.FLEET_FAKE_SCOPE_LOG;
    delete process.env.FLEET_FAKE_SCOPE_ADOPT_EXIT;
    delete process.env.FLEET_FAKE_SCOPE_ADOPT_STDERR;
  });
  const entries = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l)
      .map((l) => JSON.parse(l) as { action: string; args: string[] });

  it('只改属主：adopt <工作树> --user <用户>，不带 --from / --session', async () => {
    const result = await adoptWorktree(input());
    expect(result).toEqual({ ok: true });
    const [run] = entries();
    expect(run?.action).toBe('adopt');
    expect(run?.args).toEqual([DIR, '--user', 'fleet-agent-dedicated']);
  });

  it('带会话记录：--from、--session 跟在 --user 后面', async () => {
    await adoptWorktree(input({ from: 'fleet-agent-carpool', sessionId: SESSION }));
    const [run] = entries();
    expect(run?.action).toBe('adopt');
    expect(run?.args).toEqual([
      DIR,
      '--user',
      'fleet-agent-dedicated',
      '--from',
      'fleet-agent-carpool',
      '--session',
      SESSION,
    ]);
  });

  it('退出码 0：ok true', async () => {
    process.env.FLEET_FAKE_SCOPE_ADOPT_EXIT = '0';
    expect(await adoptWorktree(input())).toEqual({ ok: true });
  });

  it('退出码 64：usage，detail 里带着帮手的原话', async () => {
    process.env.FLEET_FAKE_SCOPE_ADOPT_EXIT = '64';
    process.env.FLEET_FAKE_SCOPE_ADOPT_STDERR = 'fleet-agent-scope：工作树要写绝对路径\n';
    const result = await adoptWorktree(input());
    expect(result).toMatchObject({ ok: false, code: 'usage', exitCode: 64 });
    expect(!result.ok && result.detail).toContain('工作树要写绝对路径');
  });

  it('退出码 65：transcript_missing', async () => {
    process.env.FLEET_FAKE_SCOPE_ADOPT_EXIT = '65';
    process.env.FLEET_FAKE_SCOPE_ADOPT_STDERR = 'fleet-agent-scope：找不到会话记录\n';
    const result = await adoptWorktree(input({ from: 'fleet-agent-carpool', sessionId: SESSION }));
    expect(result).toMatchObject({ ok: false, code: 'transcript_missing', exitCode: 65 });
  });

  it('别的退出码（例如 chown 失败时的 1）：failed', async () => {
    process.env.FLEET_FAKE_SCOPE_ADOPT_EXIT = '1';
    const result = await adoptWorktree(input());
    expect(result).toMatchObject({ ok: false, code: 'failed', exitCode: 1 });
  });

  it('帮手脚本本身起不来（拼错路径，spawn 就失败）：failed，exitCode 是 null（不是脚本的退出码，是 spawn 自己的错）', async () => {
    const result = await adoptWorktree(input({ sudo: [], helper: join(tempDir(), 'no-such-helper') }));
    expect(result).toMatchObject({ ok: false, code: 'failed', exitCode: null });
  });
});
