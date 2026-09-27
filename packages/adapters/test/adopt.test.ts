// adoptWorktree：把一棵工作树交给会话用户（不在就建、在就改属主）。真帮手的路径校验、chown 用真的 shell 脚本测
// （deploy/test/agent-scope-adopt.test.sh）；这里只验插头交给帮手的参数对不对、各个退出码翻译成哪种结果——和
// scope.test.ts 验 stopScope/scopePrefix 是同一个分工。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AdoptWorktreeInput,
  adoptWorktree,
  listAgentScopes,
  removeWorktreeDir,
  switchSessionOrg,
} from '../src/procs.ts';
import { tempDir } from './helpers.ts';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'fake-scope-helper.ts');
const DIR = '/var/lib/fleet-work/repo1/task1';
const SESSION = '8e188c1c-4430-4735-9eb2-bbb3d9f012c6';

function input(over: Partial<AdoptWorktreeInput> = {}): AdoptWorktreeInput {
  return { dir: DIR, user: 'fleet-agent-carpool', helper: HELPER, sudo: [process.execPath], ...over };
}

describe('adoptWorktree · 校验（挡明显不对的调用，起之前就拒；真正的边界在以 root 跑的帮手脚本里）', () => {
  it('工作树要绝对路径', () => {
    expect(() => adoptWorktree(input({ dir: 'repo1/task1' }))).toThrow('绝对路径');
  });

  it('工作树路径不许有控制字符', () => {
    expect(() => adoptWorktree(input({ dir: `${DIR}\r` }))).toThrow('控制字符');
  });

  it('--user 只能是会话用户：别的用户、已停用的 fleet-agent-dedicated 都拒', () => {
    expect(() => adoptWorktree(input({ user: 'root' as AdoptWorktreeInput['user'] }))).toThrow('会话用户');
    expect(() =>
      adoptWorktree(input({ user: 'fleet-agent-dedicated' as AdoptWorktreeInput['user'] })),
    ).toThrow('会话用户');
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

  it('adopt <工作树> --user <用户>，别的什么都不带（只有一个会话用户，过程记录不用拷）', async () => {
    const result = await adoptWorktree(input());
    expect(result).toEqual({ ok: true });
    const [run] = entries();
    expect(run?.action).toBe('adopt');
    expect(run?.args).toEqual([DIR, '--user', 'fleet-agent-carpool']);
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

  it('别的退出码（例如 chown 失败时的 1、旧帮手的 65）：failed', async () => {
    process.env.FLEET_FAKE_SCOPE_ADOPT_EXIT = '1';
    expect(await adoptWorktree(input())).toMatchObject({ ok: false, code: 'failed', exitCode: 1 });
    process.env.FLEET_FAKE_SCOPE_ADOPT_EXIT = '65';
    expect(await adoptWorktree(input())).toMatchObject({ ok: false, code: 'failed', exitCode: 65 });
  });

  it('帮手脚本本身起不来（拼错路径，spawn 就失败）：failed，exitCode 是 null（不是脚本的退出码，是 spawn 自己的错）', async () => {
    const result = await adoptWorktree(input({ sudo: [], helper: join(tempDir(), 'no-such-helper') }));
    expect(result).toMatchObject({ ok: false, code: 'failed', exitCode: null });
  });
});

describe('listAgentScopes · 在册的会话 scope（假帮手）', () => {
  afterEach(() => {
    delete process.env.FLEET_FAKE_SCOPE_LIST_STDOUT;
    delete process.env.FLEET_FAKE_SCOPE_LIST_EXIT;
  });
  const list = (over: { helper?: string; sudo?: readonly string[] } = {}) =>
    listAgentScopes({ helper: HELPER, sudo: [process.execPath], ...over });

  it('一行一个「编号 状态」；一个都没有是空数组', async () => {
    process.env.FLEET_FAKE_SCOPE_LIST_STDOUT = `${SESSION} active\npush-t1-g3 failed\n`;
    expect(await list()).toEqual({
      ok: true,
      scopes: [
        { id: SESSION, state: 'active' },
        { id: 'push-t1-g3', state: 'failed' },
      ],
    });
    process.env.FLEET_FAKE_SCOPE_LIST_STDOUT = '';
    expect(await list()).toEqual({ ok: true, scopes: [] });
  });

  it('认不出的行、帮手报错、帮手起不来：明确失败，不当成一个都没有', async () => {
    process.env.FLEET_FAKE_SCOPE_LIST_STDOUT = 'fleet-agent-x.scope loaded active running\n';
    expect(await list()).toMatchObject({ ok: false, exitCode: 0 });
    process.env.FLEET_FAKE_SCOPE_LIST_STDOUT = '';
    process.env.FLEET_FAKE_SCOPE_LIST_EXIT = '1';
    expect(await list()).toMatchObject({ ok: false, exitCode: 1 });
    expect(await list({ sudo: [], helper: join(tempDir(), 'no-such-helper') })).toMatchObject({
      ok: false,
      exitCode: null,
    });
  });
});

describe('removeWorktreeDir · 调帮手删工作树（假帮手）', () => {
  let log: string;
  beforeEach(() => {
    log = join(tempDir(), 'remove.log');
    process.env.FLEET_FAKE_SCOPE_LOG = log;
  });
  afterEach(() => {
    delete process.env.FLEET_FAKE_SCOPE_LOG;
    delete process.env.FLEET_FAKE_SCOPE_REMOVE_STDOUT;
    delete process.env.FLEET_FAKE_SCOPE_REMOVE_STDERR;
    delete process.env.FLEET_FAKE_SCOPE_REMOVE_EXIT;
  });
  const remove = (over: Partial<Parameters<typeof removeWorktreeDir>[0]> = {}) =>
    removeWorktreeDir({ dir: DIR, helper: HELPER, sudo: [process.execPath], ...over });

  it('参数：remove <工作树>；帮手报 removed 就是删了', async () => {
    expect(await remove()).toEqual({ ok: true, gone: false });
    const [run] = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l)
      .map((l) => JSON.parse(l) as { action: string; args: string[] });
    expect(run?.action).toBe('remove');
    expect(run?.args).toEqual([DIR]);
  });

  it('帮手报 gone：本来就不在，正常返回', async () => {
    process.env.FLEET_FAKE_SCOPE_REMOVE_STDOUT = `gone ${DIR}\n`;
    expect(await remove()).toEqual({ ok: true, gone: true });
  });

  it('退出码 0 却认不出最后一行（别的路径、空输出）：failed，不当成删好了', async () => {
    process.env.FLEET_FAKE_SCOPE_REMOVE_STDOUT = 'removed /var/lib/fleet-work/repo1/other\n';
    expect(await remove()).toMatchObject({ ok: false, code: 'failed', exitCode: 0 });
    process.env.FLEET_FAKE_SCOPE_REMOVE_STDOUT = '';
    expect(await remove()).toMatchObject({ ok: false, code: 'failed', exitCode: 0 });
  });

  it('退出码 64：usage，带帮手原话；别的退出码：failed', async () => {
    process.env.FLEET_FAKE_SCOPE_REMOVE_STDOUT = '';
    process.env.FLEET_FAKE_SCOPE_REMOVE_EXIT = '64';
    process.env.FLEET_FAKE_SCOPE_REMOVE_STDERR = 'fleet-agent-scope：工作树路径上有符号链接\n';
    const usage = await remove();
    expect(usage).toMatchObject({ ok: false, code: 'usage', exitCode: 64 });
    expect(!usage.ok && usage.detail).toContain('符号链接');
    process.env.FLEET_FAKE_SCOPE_REMOVE_EXIT = '1';
    expect(await remove()).toMatchObject({ ok: false, code: 'failed', exitCode: 1 });
  });

  it('帮手起不来：failed，exitCode 是 null', async () => {
    expect(await remove({ sudo: [], helper: join(tempDir(), 'no-such-helper') })).toMatchObject({
      ok: false,
      code: 'failed',
      exitCode: null,
    });
  });

  it('相对路径、控制字符：起之前就拒', () => {
    expect(() => remove({ dir: 'repo1/task1' })).toThrow('绝对路径');
    expect(() => remove({ dir: `${DIR}\n` })).toThrow('控制字符');
  });
});

describe('switchSessionOrg · 调帮手切会话用户挂的组织（假帮手，#157）', () => {
  let log: string;
  beforeEach(() => {
    log = join(tempDir(), 'org.log');
    process.env.FLEET_FAKE_SCOPE_LOG = log;
  });
  afterEach(() => {
    delete process.env.FLEET_FAKE_SCOPE_LOG;
    delete process.env.FLEET_FAKE_SCOPE_ORG_STDOUT;
    delete process.env.FLEET_FAKE_SCOPE_ORG_STDERR;
    delete process.env.FLEET_FAKE_SCOPE_ORG_EXIT;
    delete process.env.FLEET_FAKE_SCOPE_ORG_HANG_MS;
  });
  const sw = (over: Partial<Parameters<typeof switchSessionOrg>[0]> = {}) =>
    switchSessionOrg({
      to: 'solo',
      user: 'fleet-agent-carpool',
      helper: HELPER,
      sudo: [process.execPath],
      ...over,
    });

  it('参数：org-use <类型> --user <会话用户>，别的什么都不带（组织编号由帮手现认）；switched 是切了、already 是本来就挂着', async () => {
    expect(await sw()).toEqual({ ok: true, changed: true });
    const [run] = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l)
      .map((l) => JSON.parse(l) as { action: string; args: string[] });
    expect(run?.action).toBe('org-use');
    expect(run?.args).toEqual(['solo', '--user', 'fleet-agent-carpool']);
    process.env.FLEET_FAKE_SCOPE_ORG_STDOUT = '已经挂着独享组织，不用切\nalready solo\n';
    expect(await sw()).toEqual({ ok: true, changed: false });
  });

  it('【故意造出的失败】帮手说没切成：带上它说的现在挂的是哪一类和原话', async () => {
    process.env.FLEET_FAKE_SCOPE_ORG_STDOUT = 'failed carpool\n';
    process.env.FLEET_FAKE_SCOPE_ORG_STDERR =
      'fleet-agent-scope：没切成（org use 退出码 1：account_banned），现在挂的还是原来的拼车组织\n';
    process.env.FLEET_FAKE_SCOPE_ORG_EXIT = '1';
    const r = await sw();
    expect(r).toMatchObject({ ok: false, code: 'failed', exitCode: 1, now: 'carpool' });
    expect(!r.ok && r.detail).toContain('现在挂的还是原来的拼车组织');
    process.env.FLEET_FAKE_SCOPE_ORG_STDOUT = 'failed unknown\n';
    expect(await sw()).toMatchObject({ ok: false, now: 'unknown' });
    process.env.FLEET_FAKE_SCOPE_ORG_STDOUT = 'failed other\n';
    expect(await sw()).toMatchObject({ ok: false, now: 'other' });
  });

  it('【故意造出的失败】退出码 0 却没报 switched / already、最后一行认不出：不当成切好了，现在挂的是哪个不知道', async () => {
    for (const stdout of ['', 'ok\n', 'switched team\n', 'switched carpool extra\n']) {
      process.env.FLEET_FAKE_SCOPE_ORG_STDOUT = stdout;
      expect(await sw()).toMatchObject({ ok: false, code: 'failed', exitCode: 0, now: 'unknown' });
    }
  });

  it('【故意造出的失败】退出码 64：usage；超时：被停、不知道挂的是哪个；帮手起不来：failed', async () => {
    process.env.FLEET_FAKE_SCOPE_ORG_STDOUT = '';
    process.env.FLEET_FAKE_SCOPE_ORG_EXIT = '64';
    process.env.FLEET_FAKE_SCOPE_ORG_STDERR = 'fleet-agent-scope：--user 只能是会话用户\n';
    expect(await sw()).toMatchObject({ ok: false, code: 'usage', exitCode: 64, now: 'unknown' });
    delete process.env.FLEET_FAKE_SCOPE_ORG_EXIT;
    delete process.env.FLEET_FAKE_SCOPE_ORG_STDERR;
    process.env.FLEET_FAKE_SCOPE_ORG_HANG_MS = '5000';
    const slow = await sw({ timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, code: 'failed', now: 'unknown' });
    expect(!slow.ok && slow.detail).toContain('没切完，被停');
    delete process.env.FLEET_FAKE_SCOPE_ORG_HANG_MS;
    expect(await sw({ sudo: [], helper: join(tempDir(), 'no-such-helper') })).toMatchObject({
      ok: false,
      code: 'failed',
      exitCode: null,
      now: 'unknown',
    });
  });

  it('只认 carpool、solo 和会话用户：起之前就拒', () => {
    expect(() => sw({ to: 'team' as never })).toThrow('只认 carpool、solo');
    expect(() => sw({ user: 'root' as never })).toThrow('会话用户');
  });
});
