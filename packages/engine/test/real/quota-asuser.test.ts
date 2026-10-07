// 额度读取里 Cursor、Grok 池以会话用户身份读登录文件（#1195）：不连库、不连上游、不起进程，exec 和 fetch 全是假的。
// 假凭据一律用明显的假值（fake-token-for-test）。
import { type MirasimFrame, type MirasimWire, SESSION_USERS } from '@fleet-dao/adapters';
import type { QuotaConfig } from '@fleet-dao/adapters/quota';
import type { Db, PoolQuotaSnapshot } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { runQuotaReadJob } from '../../src/jobs/quota-read.ts';
import type { UserCommand, UserCommandResult } from '../../src/real/exec.ts';
import { catAsUser, DEFAULT_MIRASIM_HOME, quotaAsUser } from '../../src/real/index.ts';
import { quotaReadJob } from '../../src/real/quota-read.ts';

const [USER] = SESSION_USERS;
const HOME = `/home/${USER}`;
const SECRET = 'fake-token-for-test';
const NOW = new Date('2026-10-07T08:00:00Z');

const cursorAuth = `${HOME}/.config/cursor/auth.json`;
const grokAuth = `${HOME}/.grok/auth.json`;
const farFuture = '2099-01-01T00:00:00Z';

type Files = Record<string, string | 'denied'>;

/** 假 exec：只认 /bin/cat；按路径给内容，没登记的路径像 cat 一样退出 1、说没有这个文件。 */
function fakeExec(files: Files) {
  const commands: UserCommand[] = [];
  const exec = async (c: UserCommand): Promise<UserCommandResult> => {
    commands.push(c);
    const [bin, , path] = c.argv;
    const hit = files[path ?? ''];
    const base = { stdout: Buffer.alloc(0), timedOut: false, aborted: false };
    if (bin !== '/bin/cat') return { ...base, code: 127, stderr: 'not cat' };
    if (hit === undefined)
      return { ...base, code: 1, stderr: `/bin/cat: ${path}: No such file or directory` };
    if (hit === 'denied') return { ...base, code: 1, stderr: `/bin/cat: ${path}: Permission denied` };
    return { ...base, stdout: Buffer.from(hit), code: 0, stderr: '' };
  };
  return { exec, commands };
}

const happyFiles = (): Files => ({
  [cursorAuth]: JSON.stringify({ accessToken: SECRET }),
  [grokAuth]: JSON.stringify({ default: { key: SECRET, expires_at: farFuture } }),
});

const CURSOR_PERIOD = {
  billingCycleEnd: '1792177716000',
  planUsage: { totalSpend: 1000, limit: 2000, autoPercentUsed: 5, apiPercentUsed: 0 },
};
const GROK_BILLING = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-10-04T00:00:00+00:00',
      end: '2026-10-11T00:00:00+00:00',
    },
    creditUsagePercent: 47,
  },
};

/** 假 fetch：只回这两家的账单；请求头里的令牌记下来，核对读到的凭据真的带上了。 */
function fakeFetch() {
  const auth: string[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    auth.push(String((init?.headers as Record<string, string>)?.Authorization));
    const body = url.includes('GetCurrentPeriodUsage')
      ? CURSOR_PERIOD
      : url.includes('/billing')
        ? GROK_BILLING
        : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch: f as typeof fetch, auth };
}

const config = (): QuotaConfig =>
  ({
    pools: [
      {
        poolId: 'cursor',
        channelId: 'cursor',
        name: 'Cursor',
        reader: 'cursor-dashboard',
        authFile: cursorAuth,
      },
      // 不写 authFile：默认走 ~ 下的 grok 登录文件，要展开到会话用户的家，不是引擎用户的
      { poolId: 'grok', channelId: 'xai', name: 'Grok', reader: 'grok-billing' },
    ],
  }) as unknown as QuotaConfig;

/** 真接线（quotaReadJob + quotaAsUser）跑一整轮，写库、提醒、日志都截下来。 */
async function runRound(files: Files) {
  const { exec, commands } = fakeExec(files);
  const net = fakeFetch();
  const refuse = (what: string) => () => {
    throw new Error(`引擎自己的身份不该碰 ${what}`);
  };
  const io = {
    fetch: net.fetch,
    runCommand: refuse('runCommand'),
    readFile: refuse('readFile（凭据要经会话用户读）'),
    listDir: refuse('listDir'),
    openWebSocket: refuse('openWebSocket'),
    workDir: async () => '/nowhere',
    homeDir: '/home/engine-user',
    env: {},
  } as unknown as NonNullable<Parameters<typeof quotaReadJob>[0]['io']>;
  const wired = quotaReadJob({
    db: {} as Db,
    io,
    now: () => NOW,
    asUser: quotaAsUser(exec, USER, DEFAULT_MIRASIM_HOME),
  })();
  const saved: PoolQuotaSnapshot[] = [];
  const raised: { key: string; title: string; body: string }[] = [];
  const logs: unknown[] = [];
  const run = await runQuotaReadJob({
    ...wired,
    loadConfig: async () => config(),
    save: async (s) => {
      saved.push(s);
    },
    lastReadOk: async (ids) => new Map(ids.map((id) => [id, null])),
    raise: async (a) => {
      raised.push(a);
    },
    resolve: async () => undefined,
    runs: { start: async () => 1, finish: async () => undefined },
    log: (level, message, fields) => logs.push([level, message, fields]),
  });
  const report = await wired.read(config());
  return { run, saved, raised, logs, report, commands, net };
}

describe('额度读取：Cursor、Grok 池以会话用户读登录文件（#1195）', () => {
  it('读到凭据后两个池的额度都进库；凭据真带到了上游请求里；命令是以会话用户 cat 那个文件', async () => {
    const r = await runRound(happyFiles());
    expect(r.run).toMatchObject({ outcome: 'ok', scanned: 2, found: 0 });
    expect(r.saved.map((s) => s.poolId).sort()).toEqual(['cursor', 'grok']);
    expect(r.net.auth.length).toBeGreaterThan(0);
    expect(r.net.auth.every((a) => a === `Bearer ${SECRET}`)).toBe(true);
    // 命令上只有路径，凭据的值不在 argv 里
    const seen = [...new Set(r.commands.map((c) => `${c.user} ${c.argv.join(' ')}`))].sort();
    expect(seen).toEqual([`${USER} /bin/cat -- ${cursorAuth}`, `${USER} /bin/cat -- ${grokAuth}`].sort());
    expect(JSON.stringify(r.commands.map((c) => c.argv))).not.toContain(SECRET);
  });

  it('凭据值在写库内容、提醒、日志、读取结果、这一轮结局里都搜不到', async () => {
    const r = await runRound(happyFiles());
    const all = JSON.stringify({
      saved: r.saved,
      raised: r.raised,
      logs: r.logs,
      report: r.report,
      run: r.run,
    });
    expect(all).not.toContain(SECRET);
  });

  it('故意造失败：Cursor 登录文件不在，Cursor 报「读不到」当场提醒、不写库、不当成 0 或 ok；Grok 照常读成', async () => {
    const files = happyFiles();
    delete files[cursorAuth];
    const r = await runRound(files);
    expect(r.saved.map((s) => s.poolId)).toEqual(['grok']);
    const cursor = r.report.results.find((x) => x.poolId === 'cursor');
    expect(cursor).toMatchObject({ ok: false, error: { code: 'no_credentials' } });
    expect(cursor && !cursor.ok && cursor.error.message).toContain(
      `读不到 Cursor 登录文件 ${cursorAuth}（ENOENT）`,
    );
    expect(r.raised.map((a) => a.key)).toEqual(['quota-read:cursor']);
    expect(r.run.outcome).toBe('partial');
    expect(JSON.stringify([r.raised, r.logs, r.report])).not.toContain(SECRET);
  });

  it('故意造失败：Grok 登录文件没权限读，报 EACCES 的读不到，Cursor 不受影响', async () => {
    const files = happyFiles();
    files[grokAuth] = 'denied';
    const r = await runRound(files);
    expect(r.saved.map((s) => s.poolId)).toEqual(['cursor']);
    const grok = r.report.results.find((x) => x.poolId === 'grok');
    expect(grok && !grok.ok && grok.error.message).toContain('（EACCES）');
  });
});

describe('额度读取：Mirasim 池经桥接以会话用户连，不读令牌文件、不直连（#1284）', () => {
  const mirasimConfig = {
    pools: [{ poolId: 'mirasim-relay', channelId: 'mirasim', name: 'Mirasim', reader: 'mirasim-relay' }],
  } as unknown as QuotaConfig;
  const relayFrame = {
    type: 'relay',
    relay: {
      usage: {
        ok: true,
        capturedAt: '2026-10-07T07:59:00Z',
        windows: [{ label: '5h', used: 10, budget: 100, resetAfterSeconds: 3600 }],
      },
    },
  };

  function fakeWire(frames: (MirasimFrame | 'closed')[]) {
    const sent: MirasimFrame[] = [];
    const queue = [...frames];
    let closed = 0;
    const wire: MirasimWire = {
      send: (f) => {
        sent.push(f);
      },
      next: async () => queue.shift() ?? 'timeout',
      close: () => {
        closed += 1;
      },
    };
    return { wire, sent, closes: () => closed };
  }

  function read(connectMirasim: () => Promise<MirasimWire>) {
    const refuse = (what: string) => () => {
      throw new Error(`引擎自己的身份不该碰 ${what}`);
    };
    const io = {
      fetch: refuse('fetch'),
      runCommand: refuse('runCommand'),
      readFile: refuse('readFile（令牌要由桥接以会话用户读）'),
      listDir: refuse('listDir'),
      openWebSocket: refuse('openWebSocket（回环口只许会话用户连）'),
      workDir: async () => '/nowhere',
      homeDir: '/home/engine-user',
      env: {},
    } as unknown as NonNullable<Parameters<typeof quotaReadJob>[0]['io']>;
    const { exec } = fakeExec({});
    const asUser = quotaAsUser(exec, USER, DEFAULT_MIRASIM_HOME, { connect: () => connectMirasim });
    return quotaReadJob({ db: {} as Db, io, now: () => NOW, asUser })().read(mirasimConfig);
  }

  it('quotaAsUser 给了桥接，读取器经桥接拿 relay 帧读成；发了三帧、连接关了', async () => {
    const w = fakeWire([{ type: 'state' }, relayFrame]);
    const report = await read(async () => w.wire);
    expect(report.results[0]).toMatchObject({ ok: true, poolId: 'mirasim-relay' });
    expect(w.sent.map((f) => f.type)).toEqual(['clientHello', 'getState', 'getRelay']);
    expect(w.closes()).toBe(1);
  });

  it('故意造失败：桥接连不上，如实报「读不到」（unreachable），不当成 0 或 ok', async () => {
    const report = await read(async () => {
      throw new Error('桥接没起来：退出码 1');
    });
    const r = report.results[0];
    expect(r).toMatchObject({ ok: false, error: { code: 'unreachable' } });
    expect(r && !r.ok && r.error.message).toContain('桥接没起来');
  });

  it('故意造失败：桥接中途断了，报错且连接关了', async () => {
    const w = fakeWire(['closed']);
    const report = await read(async () => w.wire);
    expect(report.results[0]).toMatchObject({ ok: false, error: { code: 'unreachable' } });
    expect(w.closes()).toBe(1);
  });

  it('上游回 error 帧：照旧报 upstream，连接关了', async () => {
    const w = fakeWire([{ type: 'error', message: 'nope' }]);
    const report = await read(async () => w.wire);
    expect(report.results[0]).toMatchObject({ ok: false, error: { code: 'upstream' } });
    expect(w.closes()).toBe(1);
  });
});

describe('catAsUser：读不了就抛错，不回空串', () => {
  it('没有这个文件 ENOENT、没权限 EACCES、别的失败没有 code；错误里没有文件内容', async () => {
    const { exec } = fakeExec({ '/a': 'denied' });
    await expect(catAsUser(exec, USER, '/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(catAsUser(exec, USER, '/a')).rejects.toMatchObject({ code: 'EACCES' });
    const broken = async (): Promise<UserCommandResult> => ({
      code: null,
      stdout: Buffer.from(SECRET),
      stderr: '',
      timedOut: true,
      aborted: false,
    });
    const err = await catAsUser(broken, USER, '/x').catch((e: NodeJS.ErrnoException) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBeUndefined();
    expect((err as Error).message).toContain('超时被停');
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('读成的文件原样返回', async () => {
    const { exec } = fakeExec({ '/ok': 'hello' });
    expect(await catAsUser(exec, USER, '/ok')).toBe('hello');
  });
});
