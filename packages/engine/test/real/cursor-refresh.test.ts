// Cursor 额度读取在登录令牌被拒时，以会话用户的身份跑一次 `cursor-agent status` 刷新再读（#1340）。
// exec、fetch 全是假的：不起进程、不连上游。假令牌一律用明显的假值。
import { SESSION_USERS } from '@fleet-dao/adapters';
import { type CommandResult, type QuotaIo, readAllQuotas } from '@fleet-dao/adapters/quota';
import { describe, expect, it } from 'vitest';
import type { UserCommand, UserCommandResult } from '../../src/real/exec.ts';
import { cursorBareCommand, DEFAULT_CURSOR_VERSIONS_DIR } from '../../src/real/hosts.ts';
import {
  CURSOR_REFRESH_TIMEOUT_MS,
  DEFAULT_MIRASIM_HOME,
  quotaAsUser,
  refreshCursorLogin,
} from '../../src/real/index.ts';

const [USER] = SESSION_USERS;
const HOME = `/home/${USER}`;
const AUTH = `${HOME}/.config/cursor/auth.json`;
const STALE = 'stale-token-for-test';
const FRESH = 'fresh-token-for-test';
const VERSIONS = DEFAULT_CURSOR_VERSIONS_DIR.replaceAll('{user}', USER as string);

const PERIOD = {
  billingCycleEnd: '1792177716000',
  planUsage: { totalSpend: 1000, limit: 2000, autoPercentUsed: 5, apiPercentUsed: 0 },
};

type Status =
  | 'rewrites-token'
  | 'does-nothing'
  | { code: number | null; stderr?: string; spawnError?: string };

/** 假 exec：/bin/cat 按路径给内容；/bin/sh 起的 cursor-agent status 按 status 的样子办，记下每条命令。 */
function fakeWorld(status: Status) {
  const files: Record<string, string> = { [AUTH]: JSON.stringify({ accessToken: STALE }) };
  const commands: UserCommand[] = [];
  const exec = async (c: UserCommand): Promise<UserCommandResult> => {
    commands.push(c);
    const base = { stdout: Buffer.alloc(0), timedOut: false, aborted: false };
    if (c.argv[0] === '/bin/cat') {
      const hit = files[c.argv[2] ?? ''];
      if (hit === undefined) return { ...base, code: 1, stderr: 'No such file or directory' };
      return { ...base, stdout: Buffer.from(hit), code: 0, stderr: '' };
    }
    if (c.argv[0] === '/bin/sh' && c.argv.includes('status')) {
      if (status === 'rewrites-token') files[AUTH] = JSON.stringify({ accessToken: FRESH });
      if (typeof status === 'object') {
        return {
          ...base,
          code: status.code,
          stderr: status.stderr ?? '',
          ...(status.spawnError ? { spawnError: status.spawnError } : {}),
        };
      }
      return { ...base, code: 0, stderr: '' };
    }
    return { ...base, code: 127, stderr: 'not expected' };
  };
  const bearers: string[] = [];
  const fetchFake = async (_input: string | URL | Request, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.Authorization);
    bearers.push(auth);
    return auth === `Bearer ${FRESH}`
      ? new Response(JSON.stringify(PERIOD), { status: 200 })
      : new Response('{}', { status: 401 });
  };
  return { exec, files, commands, bearers, fetch: fetchFake as typeof fetch };
}

const refuse = (what: string) => () => {
  throw new Error(`引擎自己的身份不该碰 ${what}`);
};

async function readRound(world: ReturnType<typeof fakeWorld>, withRefresh = true) {
  const io = {
    fetch: world.fetch,
    runCommand: refuse('runCommand'),
    readFile: refuse('readFile'),
    listDir: refuse('listDir'),
    openWebSocket: refuse('openWebSocket'),
    workDir: async () => '/nowhere',
    homeDir: '/home/engine-user',
    env: {},
  } as unknown as QuotaIo;
  const report = await readAllQuotas(
    {
      pools: [
        { poolId: 'cursor', channelId: 'cursor', name: 'Cursor', reader: 'cursor-dashboard', authFile: AUTH },
      ],
    } as never,
    {
      ...io,
      asUser: quotaAsUser(
        world.exec,
        USER as never,
        DEFAULT_MIRASIM_HOME,
        undefined,
        undefined,
        withRefresh ? DEFAULT_CURSOR_VERSIONS_DIR : undefined,
      ),
    },
  );
  return report.results[0];
}

const statusCommands = (w: ReturnType<typeof fakeWorld>) => w.commands.filter((c) => c.argv[0] === '/bin/sh');

describe('cursorBareCommand：找 cursor-agent，不读 API 密钥', () => {
  it('命令里没有密钥文件那一段，参数原样接在版本目录后面', () => {
    const argv = cursorBareCommand(VERSIONS, ['status']);
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(argv.slice(3)).toEqual(['cursor-agent', VERSIONS, 'status']);
    expect(argv.join(' ')).not.toContain('CURSOR_API_KEY');
    expect(argv.join(' ')).not.toContain('fleet-api-key');
  });

  it('版本目录不是绝对路径、带控制字符都拒绝', () => {
    expect(() => cursorBareCommand('relative/dir', ['status'])).toThrow('绝对路径');
    expect(() => cursorBareCommand('/a\nb', ['status'])).toThrow('控制字符');
  });
});

describe('额度读取：Cursor 令牌被拒，以会话用户跑 cursor-agent status 刷新（#1340）', () => {
  it('被拒 → 以会话用户跑一次 status（命令里没有密钥）→ 重读登录文件 → 读成', async () => {
    const w = fakeWorld('rewrites-token');
    const r = await readRound(w);
    expect(r?.ok).toBe(true);
    const ran = statusCommands(w);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.user).toBe(USER);
    expect(ran[0]?.argv.at(-1)).toBe('status');
    expect(ran[0]?.argv.join(' ')).not.toContain('CURSOR_API_KEY');
    expect(ran[0]?.env ?? {}).toEqual({});
    expect(w.bearers[0]).toBe(`Bearer ${STALE}`);
    expect(w.bearers.slice(1).every((b) => b === `Bearer ${FRESH}`)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(STALE);
    expect(JSON.stringify(r)).not.toContain(FRESH);
  });

  it('刷新跑完了令牌还是旧的：报 auth，写明刷新过一次仍被拒、要人 cursor-agent login', async () => {
    const w = fakeWorld('does-nothing');
    const r = await readRound(w);
    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.error.code).toBe('auth');
    expect(r.error.message).toContain('刷新过一次仍被拒');
    expect(r.error.message).toContain('cursor-agent login');
    expect(statusCommands(w)).toHaveLength(1);
  });

  it('status 非 0 退出：报 auth，原因里带退出码和 cursor-agent 说的话', async () => {
    const w = fakeWorld({ code: 1, stderr: 'Not logged in' });
    const r = await readRound(w);
    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.error.code).toBe('auth');
    expect(r.error.message).toContain('也没跑成');
    expect(r.error.message).toContain('退出码 1');
    expect(r.error.message).toContain('Not logged in');
  });

  it('status 起不来（没装 cursor-agent）：报 auth，原因里带起不来的原因', async () => {
    const w = fakeWorld({ code: null, spawnError: 'sudo 不在' });
    const r = await readRound(w);
    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.error.message).toContain('起不来：sudo 不在');
  });

  it('引擎没给版本目录：不起任何进程，原因写明没有刷新手段', async () => {
    const w = fakeWorld('rewrites-token');
    const r = await readRound(w, false);
    expect(r?.ok).toBe(false);
    if (!r || r.ok) return;
    expect(r.error.message).toContain('没有刷新手段');
    expect(statusCommands(w)).toHaveLength(0);
  });
});

describe('refreshCursorLogin：命令怎么算成功、怎么算失败', () => {
  const ok: CommandResult = { code: 0, stdout: '', stderr: '', killed: false };

  it('退出 0 算跑完；命令是 cursor-agent status，工作目录 /，带上叫停信号', async () => {
    const seen: { argv: string[]; cwd: string; signal: AbortSignal }[] = [];
    await refreshCursorLogin(
      async (argv, o) => {
        seen.push({ argv, cwd: o.cwd, signal: o.signal });
        return ok;
      },
      VERSIONS,
      new AbortController().signal,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.argv.at(-1)).toBe('status');
    expect(seen[0]?.cwd).toBe('/');
  });

  it('被超时叫停：报超过多少秒没跑完', async () => {
    await expect(
      refreshCursorLogin(
        async () => ({ ...ok, code: null, killed: true }),
        VERSIONS,
        new AbortController().signal,
        5,
      ),
    ).rejects.toThrow('被叫停');
  });

  it('自己的超时到了：命令收到的信号被取消，错误里写明秒数', async () => {
    const run = (_argv: string[], o: { signal: AbortSignal }) =>
      new Promise<typeof ok>((resolve) => {
        o.signal.addEventListener('abort', () => resolve({ ...ok, code: null, killed: true }));
      });
    await expect(
      refreshCursorLogin(run as never, VERSIONS, new AbortController().signal, 20),
    ).rejects.toThrow('没跑完，被叫停');
    expect(CURSOR_REFRESH_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('故意造出失败：stderr 为空时用 stdout 的话当原因，退出码 3 照实抛', async () => {
    await expect(
      refreshCursorLogin(
        async () => ({ ...ok, code: 3, stdout: 'Not logged in\nsecond', stderr: '' }),
        VERSIONS,
        new AbortController().signal,
      ),
    ).rejects.toThrow('退出码 3：Not logged in / second');
  });
});
