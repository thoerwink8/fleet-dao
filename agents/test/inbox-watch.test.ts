// 单 #2488：主线程一轮收尾、后台子代理还在跑时，创始人的引导由收尾时起的盯账进程（agents/hooks/inbox-watch.mjs，
// 挂在 Stop 上、asyncRewake）十几秒内叫醒主线程送进来，不等子代理跑完。
// 钉住：「发了没收到」的一条在一个节拍内退出码 2、stderr 含原文和北京时间；已见过的（轮中对账塞过的）不再退 2，
// 反过来盯账送过的轮中对账也不再塞；锁被新进程接管时旧进程退 0；读账连续失败 3 次明说「对账没查成」退 2，同一句不重复叫醒；
// 子代理、无血缘、引擎无头的不盯。真起进程的用例节拍配成毫秒级。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

type WatchOpts = Record<string, unknown>;
const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const WATCH = `${HOOKS}inbox-watch.mjs`;
const { watch, WATCH_TICK_MS, WATCH_MAX_MS } = (await import(pathToFileURL(WATCH).href)) as {
  watch(input: unknown, opts?: WatchOpts): Promise<number>;
  WATCH_TICK_MS: number;
  WATCH_MAX_MS: number;
};
const { tick } = (await import(pathToFileURL(`${HOOKS}inbox-tick.mjs`).href)) as {
  tick(input: unknown, opts?: Record<string, unknown>): Promise<string | null>;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const STEER_TEXT = '子代理跑着的时候我发的：先把 CI 修了';
/** 北京时间 MM-DD HH:mm */
const stamp = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
const day = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

/**
 * 一个 Mirasim 会话 dir-w（原生号 w-1）：两轮开头都收到了；steerAt 发的一条引导没收到（prompt-log 里没有）。
 * 时刻都相对 base 摆，真起进程的用例拿真钟的「刚刚」当 base。
 */
function world(base: number) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-watch-'));
  dirs.push(home);
  const d = join(home, '.mirasim', 'sessions', 'claude', 'dir-w');
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'record.json'),
    JSON.stringify({ workdir: 'D:\\frank\\fleet-dao', nativeSessionId: 'w-1' }),
  );
  const first = base - 20 * 60_000;
  const second = base - 10 * 60_000;
  const steerAt = base - 60_000;
  const turns = [
    { sessionId: 'w-1', startedAt: first, prompt: '开始做 2488' },
    { sessionId: 'w-1', startedAt: second, prompt: '接着做', steers: [{ text: STEER_TEXT, at: steerAt }] },
  ];
  writeFileSync(join(d, 'turns.jsonl'), turns.map((t) => `${JSON.stringify(t)}\n`).join(''));
  const log = join(home, '.fleet-dao', 'prompt-log');
  mkdirSync(log, { recursive: true });
  const rows = [
    { at: new Date(first + 1000).toISOString(), sessionId: 'w-1', prompt: '开始做 2488' },
    { at: new Date(second + 1000).toISOString(), sessionId: 'w-1', prompt: '接着做' },
  ];
  for (const dd of new Set([day(first), day(base)]))
    writeFileSync(join(log, `${dd}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const seen = join(home, '.fleet-dao', 'inbox-seen');
  const input = (extra: Record<string, unknown> = {}) => ({
    session_id: 'w-1',
    hook_event_name: 'Stop',
    ...extra,
  });
  /** 子进程用的环境：账都指到这个临时家目录 */
  const childEnv = (extra: Record<string, string> = {}) => ({
    ...process.env,
    FLEET_MIRASIM_DIR: join(home, '.mirasim'),
    FLEET_PROMPT_LOG_DIR: log,
    FLEET_INBOX_SEEN_DIR: seen,
    FLEET_STEER_SHOWN_DIR: join(home, 'steer-shown'),
    FLEET_HEADLESS: '',
    FLEET_WORKER: '',
    ...extra,
  });
  return { home, input, steerAt, seen, log, childEnv };
}

/** 假钟：每次 sleep 把钟往前拨这么久，马上返回 */
function fakeTime(start: number) {
  let t = start;
  const slept: number[] = [];
  return {
    clock: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe('收尾后盯账：子代理跑着时发的引导叫醒主线程（#2488）', () => {
  it('节拍是 15 秒、最长等 3 小时', () => {
    expect(WATCH_TICK_MS).toBe(15_000);
    expect(WATCH_MAX_MS).toBe(3 * 3_600_000);
  });

  it('发了没收到的一条：第一个节拍就退 2，stderr 含原文和北京时间发出时间；之后轮中对账不再塞第二遍', async () => {
    const now = Date.parse('2026-10-16T02:30:00Z');
    const w = world(now);
    const time = fakeTime(now);
    const out: string[] = [];
    const code = await watch(w.input(), { home: w.home, env: {}, ...time, err: (t: string) => out.push(t) });
    expect(code).toBe(2);
    expect(time.slept).toEqual([15_000]);
    const text = out.join('\n');
    expect(text).toContain(STEER_TEXT);
    expect(text).toContain(`${stamp(w.steerAt)} 北京时间发出`);
    expect(text).not.toContain('开始做 2488'); // 收到了的不是丢的
    expect(text).not.toContain('对账没查成');
    // 共用已见名单：下一次工具调用不再塞
    expect(
      await tick({ session_id: 'w-1', tool_name: 'Bash' }, { home: w.home, env: {}, now: now + 20_000 }),
    ).toBeNull();
  });

  it('轮中对账已经塞过的：盯账不再退 2，等到上限退 0、什么都不说', async () => {
    const now = Date.parse('2026-10-16T02:30:00Z');
    const w = world(now);
    expect(await tick({ session_id: 'w-1', tool_name: 'Bash' }, { home: w.home, env: {}, now })).toContain(
      STEER_TEXT,
    );
    const time = fakeTime(now + 1_000);
    const out: string[] = [];
    const code = await watch(w.input(), {
      home: w.home,
      env: { FLEET_INBOX_WATCH_MAX_MS: String(60_000) },
      ...time,
      err: (t: string) => out.push(t),
    });
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(time.slept.length).toBe(4); // 15、30、45 秒各核一次，60 秒到点
  });

  it('等的过程中他又发了一条：下一个节拍就退 2、只送新的那条', async () => {
    const now = Date.parse('2026-10-16T02:30:00Z');
    const w = world(now);
    await tick({ session_id: 'w-1', tool_name: 'Bash' }, { home: w.home, env: {}, now }); // 旧的那条已塞过
    const turnsFile = join(w.home, '.mirasim', 'sessions', 'claude', 'dir-w', 'turns.jsonl');
    let t = now;
    let rounds = 0;
    const out: string[] = [];
    const code = await watch(w.input(), {
      home: w.home,
      env: {},
      clock: () => t,
      sleep: async (ms: number) => {
        t += ms;
        rounds++;
        if (rounds === 3) {
          const later = { text: '再看一下覆盖率', at: t - 2_000 };
          const turns = readFileSync(turnsFile, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
          turns[1].steers.push(later);
          writeFileSync(turnsFile, turns.map((x) => `${JSON.stringify(x)}\n`).join(''));
        }
      },
      err: (s: string) => out.push(s),
    });
    expect(code).toBe(2);
    expect(rounds).toBe(3);
    expect(out.join('\n')).toContain('再看一下覆盖率');
    expect(out.join('\n')).not.toContain(STEER_TEXT);
  });

  it('读账连续失败 3 次：打「对账没查成：原因」退 2；同一句 10 分钟内再遇到不再叫醒、退 0', async () => {
    const now = Date.parse('2026-10-16T02:30:00Z');
    const w = world(now);
    const load = () => Promise.reject(new Error('boom'));
    const out: string[] = [];
    const time = fakeTime(now);
    expect(
      await watch(w.input(), { home: w.home, env: {}, ...time, load, err: (t: string) => out.push(t) }),
    ).toBe(2);
    expect(time.slept.length).toBe(3);
    expect(out.join('\n')).toContain('对账没查成：boom');
    // 下一次收尾起的盯账进程又遇到同一个坏账：已经说过，不再叫醒（免得每次收尾都叫醒一次）
    const again: string[] = [];
    const later = fakeTime(now + 60_000);
    expect(
      await watch(w.input(), { home: w.home, env: {}, ...later, load, err: (t: string) => again.push(t) }),
    ).toBe(0);
    expect(again).toEqual([]);
  });

  it('偶尔失败一两次、接着读成了：不算连续，照常送', async () => {
    const now = Date.parse('2026-10-16T02:30:00Z');
    const w = world(now);
    let calls = 0;
    const real = () => import(pathToFileURL(`${HOOKS}founder-inbox.mjs`).href);
    const load = () => {
      calls++;
      return calls <= 2 ? Promise.reject(new Error('暂时读不了')) : real();
    };
    const out: string[] = [];
    expect(
      await watch(w.input(), {
        home: w.home,
        env: {},
        ...fakeTime(now),
        load,
        err: (t: string) => out.push(t),
      }),
    ).toBe(2);
    expect(out.join('\n')).toContain(STEER_TEXT);
    expect(out.join('\n')).not.toContain('暂时读不了');
  });

  it('锁被新的盯账进程接管：旧的退 0，不再叫醒', async () => {
    const now = Date.parse('2026-10-16T02:30:00Z');
    const w = world(now);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const out: string[] = [];
    const old = watch(w.input(), {
      home: w.home,
      env: {},
      clock: () => now,
      pid: 111,
      sleep: () => gate,
      err: (t: string) => out.push(t),
    });
    const lock = join(w.seen, 'watch-w-1.lock');
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual({ pid: 111, startedAt: now });
    // 下一次收尾起来的那个写了自己的锁
    writeFileSync(lock, JSON.stringify({ pid: 222, startedAt: now + 5_000 }));
    release();
    expect(await old).toBe(0);
    expect(out).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toContain('222'); // 不是自己的锁不删
  });

  it('子代理（带 agent_id）、不是 Mirasim 起的、引擎无头、机器派的会话：不盯，马上退 0', async () => {
    const now = Date.parse('2026-10-16T02:30:00Z');
    const w = world(now);
    const time = fakeTime(now);
    const run = (input: unknown, env: Record<string, string> = {}) =>
      watch(input, { home: w.home, env, ...time, err: () => {} });
    expect(await run(w.input({ agent_id: 'sub-1' }))).toBe(0);
    expect(await run(w.input(), { FLEET_HEADLESS: '1' })).toBe(0);
    expect(await run(w.input(), { FLEET_WORKER: '1' })).toBe(0);
    expect(await run({ hook_event_name: 'Stop' })).toBe(0);
    expect(time.slept).toEqual([]);
    expect(await run(w.input({ session_id: 'not-in-mirasim' }))).toBe(0); // 第一次对账判无血缘就退
    expect(time.slept.length).toBe(1);
    expect(existsSync(join(w.seen, 'watch-not-in-mirasim.lock'))).toBe(false); // 退出时收掉自己的锁
  });
});

describe('真起盯账进程（节拍配成毫秒级）', () => {
  it('发了没收到：退出码 2、stderr 含原文；再起一次（已见过）到上限退 0', { timeout: 0 }, () => {
    const w = world(Date.now());
    const input = JSON.stringify(w.input({ transcript_path: join(w.home, 'none.jsonl') }));
    const first = runChild(process.execPath, [WATCH], {
      input,
      env: w.childEnv({ FLEET_INBOX_WATCH_TICK_MS: '50', FLEET_INBOX_WATCH_MAX_MS: '2000' }),
    });
    expect(first.status, first.stderr).toBe(2);
    expect(first.stderr).toContain(STEER_TEXT);
    expect(first.stderr).toContain('北京时间发出');
    // stdout 只有探 Claude Code 还在不在写的换行，没有别的（叫醒用的是 stderr）
    expect(first.stdout.trim()).toBe('');
    expect(existsSync(join(w.seen, 'watch-w-1.lock'))).toBe(false);
    const second = runChild(process.execPath, [WATCH], {
      input,
      env: w.childEnv({ FLEET_INBOX_WATCH_TICK_MS: '50', FLEET_INBOX_WATCH_MAX_MS: '300' }),
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toBe('');
  });

  it('新的一次收尾起了另一个盯账进程：它接管锁，旧的那个退 0', { timeout: 0 }, async () => {
    const now = Date.now();
    const w = world(now);
    await tick(
      { session_id: 'w-1', tool_name: 'Bash' },
      { home: w.home, env: { FLEET_INBOX_SEEN_DIR: w.seen }, now },
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const out: string[] = [];
    const old = watch(w.input(), {
      home: w.home,
      env: { FLEET_INBOX_SEEN_DIR: w.seen },
      sleep: () => gate,
      err: (t: string) => out.push(t),
    });
    await new Promise((r) => setTimeout(r, 0));
    const lock = join(w.seen, 'watch-w-1.lock');
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    // 真起的新进程：写自己的锁、盯到上限退出（没有新话），退出时收掉自己的锁
    const next = runChild(process.execPath, [WATCH], {
      input: JSON.stringify(w.input()),
      env: w.childEnv({ FLEET_INBOX_WATCH_TICK_MS: '50', FLEET_INBOX_WATCH_MAX_MS: '200' }),
    });
    expect(next.status, next.stderr).toBe(0);
    release();
    expect(await old).toBe(0);
    expect(out).toEqual([]);
  });
});
