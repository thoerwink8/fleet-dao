// 执行方式的驱动（#212）：会话用户怎么定、cursor-agent 的起法（会话用户现找版本目录）、两家驱动拼的参数、报告整理成的
// 同一个形状（读不到的不记成 0）。找版本目录的那段 sh 真跑（本机的 sh、假的 cursor-agent 脚本），每条失败路径都故意造一次。
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURSOR_MISSING,
  CURSOR_PENDING_PREFIX,
  cursorLaunchCommand,
  DEFAULT_CURSOR_VERSIONS_DIR,
  type HostRunners,
  type HostRunSpec,
  hostDrivers,
  sessionUserOf,
  WIRED_HOSTS,
  wiredHostNames,
} from '../../src/real/hosts.ts';
import { agentCommands, realPortsConfigFromEnv } from '../../src/real/index.ts';
import {
  CURSOR_NO_LOGIN,
  CURSOR_SESSION,
  type FakeCursorScript,
  fakeCursorRun,
  fakeRun,
} from './fixtures.ts';

describe('会话用户怎么定', () => {
  const claude = { userFrom: 'pool' as const };
  const cursor = { userFrom: 'sole' as const };

  it('池上定了、是现在的会话用户：照池（两家都是）', () => {
    expect(sessionUserOf(claude, 'fleet-agent-carpool')).toEqual({ user: 'fleet-agent-carpool' });
    expect(sessionUserOf(cursor, 'fleet-agent-carpool')).toEqual({ user: 'fleet-agent-carpool' });
  });

  it('池上定的不是现在的会话用户（已停用的）：报缺什么，不瞎挑一个', () => {
    const who = sessionUserOf(claude, 'fleet-agent-dedicated');
    expect(who).toEqual({ missing: expect.stringContaining('不是现在的会话用户') });
  });

  it('Claude 的池没定会话用户：报没定（它绑着 reclaude 组织，猜不得）', () => {
    expect(sessionUserOf(claude, null)).toEqual({ missing: expect.stringContaining('没定会话用户') });
  });

  it('cursor 的池不绑：用唯一的会话用户', () => {
    expect(sessionUserOf(cursor, null)).toEqual({ user: 'fleet-agent-carpool' });
  });

  it('cursor 的池不绑、会话用户却不止一个或一个都没有：报缺什么，不瞎挑一个', () => {
    const two = ['fleet-agent-carpool', 'fleet-agent-other'] as unknown as SessionUser[];
    expect(sessionUserOf(cursor, null, two)).toEqual({ missing: expect.stringContaining('不止一个') });
    expect(sessionUserOf(cursor, null, [])).toEqual({ missing: expect.stringContaining('不知道以谁起') });
  });
});

describe('接上的执行方式', () => {
  it('Claude Code 和 cursor-agent；报错里的说法跟着这张表', () => {
    expect([...WIRED_HOSTS]).toEqual(['claude-code', 'cursor-agent']);
    expect(wiredHostNames()).toBe('Claude Code、Cursor Agent');
  });
});

// ---- cursor-agent 的起法：会话用户自己现找版本目录

const SH = process.platform === 'win32' ? 'sh' : '/bin/sh';
const posix = (p: string) => p.replaceAll('\\', '/');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-hosts-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 假的 cursor-agent：能跑的先报自己是哪一个，再一行一个报参数；不能跑的（没有执行权限）不该被挑中。 */
function agent(dir: string, label: string, runnable = true) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cursor-agent');
  writeFileSync(
    file,
    runnable ? `#!/bin/sh\necho "${label}"\nfor a in "$@"; do echo "[$a]"; done\n` : `echo "${label}"\n`,
  );
  chmodSync(file, runnable ? 0o755 : 0o644);
}

/** 照 cursorLaunchCommand 给的脚本真跑一次（版本目录换成这次造的；Windows 上用 Git 的 sh）。 */
function launch(versionsDir: string, args: string[] = []) {
  const [sh, flag, script, name, dir] = cursorLaunchCommand('/home/u/.local/share/cursor-agent/versions');
  expect([sh, flag, name, dir]).toEqual([
    '/bin/sh',
    '-c',
    'cursor-agent',
    '/home/u/.local/share/cursor-agent/versions',
  ]);
  const r = spawnSync(SH, [flag as string, script as string, name as string, posix(versionsDir), ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, lines: r.stdout.trim().split('\n'), stderr: r.stderr.trim() };
}

describe('cursorLaunchCommand：会话用户按 current → 最新版本目录现找（CU-03：升级会删掉旧版本目录）', () => {
  it('有 current 就用 current', () => {
    const v = join(root, 'versions');
    agent(join(v, 'current'), 'current');
    agent(join(v, '2026.10.1-ccc3333'), 'ccc');
    expect(launch(v)).toMatchObject({ status: 0, lines: ['current'] });
  });

  it('没有 current：按版本号挑最新的（月、日不补零也排得对）', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.9.5-aaa1111'), 'aaa');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    agent(join(v, '2026.10.1-ccc3333'), 'ccc');
    expect(launch(v)).toMatchObject({ status: 0, lines: ['ccc'] });
  });

  it('最新的那个目录里的 cursor-agent 不能跑：跳过，用下一个', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    agent(join(v, '2026.10.1-ccc3333'), 'ccc', false);
    expect(launch(v)).toMatchObject({ status: 0, lines: ['bbb'] });
  });

  it('不是版本号的名字（安装时下载的 UUID 临时包、latest 这类）不认，哪怕按版本号排它更「新」', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    agent(join(v, '80975bde-8b97-4c7b-bdcb-00741e363c13'), 'uuid');
    agent(join(v, 'latest'), 'latest');
    expect(launch(v)).toMatchObject({ status: 0, lines: ['bbb'] });
  });

  it('插头的参数原样交给 cursor-agent（带空格、引号的也不拆）', () => {
    const v = join(root, 'versions');
    agent(join(v, '2026.09.23-bbb2222'), 'bbb');
    // Windows 上 Node 把参数拼成一行交给 Git 的 sh，单引号会被它当成引号吃掉（生产在 Linux 上直接传 argv，没有这一层）
    const quoted = process.platform === 'win32' ? [] : ["it's"];
    const r = launch(v, ['-p', '--output-format', 'stream-json', 'a b', ...quoted, '--model', 'auto']);
    expect(r).toMatchObject({ status: 0 });
    expect(r.lines).toEqual([
      'bbb',
      '[-p]',
      '[--output-format]',
      '[stream-json]',
      '[a b]',
      ...quoted.map((q) => `[${q}]`),
      '[--model]',
      '[auto]',
    ]);
  });

  it('版本目录是空的、不存在、里面都不能跑：退出 127，stderr 写清没装（失败分流认成执行方式配置不对）', () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const broken = join(root, 'broken');
    agent(join(broken, '2026.09.23-bbb2222'), 'bbb', false);
    for (const dir of [empty, join(root, 'nowhere'), broken]) {
      const r = launch(dir);
      expect(r.status).toBe(127);
      expect(r.stderr).toContain(CURSOR_MISSING);
      expect(r.stderr).toContain('没装 cursor-agent');
      expect(r.stderr).toContain(posix(dir));
    }
  });

  it('版本目录要写绝对路径；命令行里没有换行这类控制字符（要经 sudo 记日志）', () => {
    expect(() => cursorLaunchCommand('home/u/versions')).toThrow('绝对路径');
    for (const arg of cursorLaunchCommand('/home/u/.local/share/cursor-agent/versions')) {
      expect([...arg].every((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c !== '\u007f')).toBe(true);
    }
  });

  it('本机配置：默认在会话用户家里找，{user} 换成会话用户；写了相对路径就起不来（一次列全）', () => {
    const env = { FLEET_MACHINE_NAME: '法国', DATABASE_URL: 'postgres:///fleet' };
    const config = realPortsConfigFromEnv(env);
    expect(config.cursorVersionsDir).toBe(DEFAULT_CURSOR_VERSIONS_DIR);
    expect(agentCommands(config).cursorCommand('fleet-agent-carpool')).toEqual(
      cursorLaunchCommand('/home/fleet-agent-carpool/.local/share/cursor-agent/versions'),
    );
    const custom = realPortsConfigFromEnv({
      ...env,
      FLEET_CURSOR_VERSIONS_DIR: '/opt/{user}/cursor/versions',
    });
    expect(agentCommands(custom).cursorCommand('fleet-agent-carpool').at(-1)).toBe(
      '/opt/fleet-agent-carpool/cursor/versions',
    );
    expect(() => realPortsConfigFromEnv({ ...env, FLEET_CURSOR_VERSIONS_DIR: 'versions' })).toThrow(
      'FLEET_CURSOR_VERSIONS_DIR 要写绝对路径',
    );
  });
});

// ---- 两家驱动：拼的参数、整理成的同一个形状

function spec(over: Partial<HostRunSpec> = {}): HostRunSpec {
  const runId = randomUUID();
  return {
    runId,
    user: 'fleet-agent-carpool',
    cwd: '/var/lib/fleet-work/o/r/12-login',
    prompt: '只回 OK',
    env: { base: {}, fleetApi: '', fleetToken: '' },
    limits: {},
    testCommands: [],
    cgroup: {
      id: runId,
      user: 'fleet-agent-carpool',
      limits: { memoryHigh: '1024M', memoryMax: '1536M', memorySwapMax: '0' },
    },
    model: 'auto',
    session: { mode: 'new', id: 'ignored' },
    purpose: 'work',
    ...over,
  };
}

function drivers(run: HostRunners) {
  return hostDrivers({
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    cursorCommand: (user) => [`/opt/fake/${user}/cursor-agent`],
    run,
  });
}

describe('cursor-agent 的驱动', () => {
  const cursorWith = (script: FakeCursorScript) => {
    const fake = fakeCursorRun(() => script);
    return { fake, driver: drivers({ 'cursor-agent': fake.run })['cursor-agent'] };
  };

  it('开新会话先回临时号（一眼看得出不是 UUID），真号由 init 帧报上来', async () => {
    const { fake, driver } = cursorWith({ replay: 'cursor-edit-commit' });
    const fresh = driver.newSessionId('run-1');
    expect(fresh).toEqual({ id: `${CURSOR_PENDING_PREFIX}run-1`, known: false });
    const ids: string[] = [];
    const report = await driver.run(spec(), { onSessionId: (id) => ids.push(id) });
    expect(ids).toEqual([CURSOR_SESSION]);
    expect(report.sessionId).toBe(CURSOR_SESSION);
    // cursor 自己起号：插头拿到的新会话不带我们的号
    expect(fake.specs[0]?.session).toEqual({ mode: 'new' });
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/cursor-agent']);
  });

  it('干活的会话放开命令（--force），探针不放；续会话照原号 --resume', async () => {
    const { fake, driver } = cursorWith({ replay: 'cursor-resume' });
    await driver.run(spec({ purpose: 'work', session: { mode: 'resume', id: CURSOR_SESSION } }), {});
    await driver.run(spec({ purpose: 'probe' }), {});
    expect(fake.specs[0]).toMatchObject({ force: true, session: { mode: 'resume', id: CURSOR_SESSION } });
    expect(fake.specs[1]).toMatchObject({ force: false, session: { mode: 'new' } });
  });

  it('要 fork：拒（cursor 没有 fork，换了账号池走接力），插头不起', async () => {
    const { fake, driver } = cursorWith({ replay: 'cursor-edit-commit' });
    expect(driver.canFork).toBe(false);
    await expect(
      driver.run(spec({ session: { mode: 'fork', from: CURSOR_SESSION, id: 'x' } }), {}),
    ).rejects.toThrow('没有 fork');
    expect(fake.count()).toBe(0);
  });

  it('报告：token 照终帧（含缓存读写），没有花费、没有实际模型、没有上下文大小；回答照终帧', async () => {
    const { driver } = cursorWith({ replay: 'cursor-edit-commit' });
    const report = await driver.run(spec(), {});
    expect(report.usage).toEqual({
      inputTokens: 12715,
      outputTokens: 178,
      cacheReadTokens: 19968,
      cacheWriteTokens: 0,
    });
    expect(report).not.toHaveProperty('sessionCostUsd');
    expect(report).not.toHaveProperty('actualModel');
    expect(report).not.toHaveProperty('contextTokens');
    expect(report).not.toHaveProperty('rawError');
    expect(report.answer).toContain('好了');
    expect(report.facts).toMatchObject({ exitCode: 0, terminal: { isError: false } });
  });

  it('终帧里的用量读不到、不是数：那几项不给（不记成 0）', async () => {
    const { driver } = cursorWith({
      replay: 'cursor-edit-commit',
      replayLines: 1,
      frames: [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'OK',
          usage: { inputTokens: 5, outputTokens: 'x', cacheReadTokens: null },
        },
      ],
    });
    expect((await driver.run(spec(), {})).usage).toEqual({ inputTokens: 5 });
    const bare = cursorWith({ replay: 'cursor-edit-commit', replayLines: 1 });
    expect((await bare.driver.run(spec(), {})).usage).toEqual({});
  });

  it('只在 stderr 里的报错（没登录：退出 1、没有 JSON）：原话进 rawError，没有会话号', async () => {
    const { driver } = cursorWith({ stderr: CURSOR_NO_LOGIN, exitCode: 1 });
    const report = await driver.run(spec(), {});
    expect(report.rawError).toBe(CURSOR_NO_LOGIN);
    expect(report).not.toHaveProperty('sessionId');
    expect(report.usage).toEqual({});
    expect(report.facts).toMatchObject({ exitCode: 1, lastWords: CURSOR_NO_LOGIN, quotaExhausted: false });
  });

  it('登录失效的修法写清以谁跑 cursor-agent login', () => {
    const { driver } = cursorWith({});
    expect(driver.loginFix('「法国」', 'fleet-agent-carpool')).toBe(
      '在「法国」上以 fleet-agent-carpool 跑 cursor-agent login，在浏览器里批准',
    );
  });
});

describe('Claude Code 的驱动', () => {
  it('会话号由我们定（UUID）；干活放开权限，探针什么工具都不给、不存会话记录', async () => {
    const fake = fakeRun(() => ({ result: { text: 'OK' } }));
    const driver = drivers({ 'claude-code': fake.run })['claude-code'];
    const fresh = driver.newSessionId('run-1');
    expect(fresh.known).toBe(true);
    expect(fresh.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await driver.run(spec({ purpose: 'work', session: { mode: 'new', id: fresh.id } }), {});
    await driver.run(spec({ purpose: 'probe', session: { mode: 'new', id: fresh.id } }), {});
    expect(fake.specs[0]).toMatchObject({
      permissionMode: 'bypassPermissions',
      session: { mode: 'new', id: fresh.id },
    });
    expect(fake.specs[0]).not.toHaveProperty('persistSession');
    expect(fake.specs[1]).toMatchObject({ permissionMode: 'dontAsk', persistSession: false });
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/reclaude']);
  });
});
