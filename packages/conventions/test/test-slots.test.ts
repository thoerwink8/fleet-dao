// 本机测试槽（src/test-slots.ts）：占、满了排队、还；死进程占的槽被回收；槽目录读不到写不进、槽文件认不出、等太久
// 都明确失败（不当成拿到了槽）；两个进程同时抢最后一个槽只有一个拿到（真起两个子进程抢）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireSlot,
  DEFAULT_MAX_HOLD_MIN,
  DEFAULT_MAX_WAIT_MIN,
  DEFAULT_SLOTS,
  ENV_DIR,
  ENV_HELD,
  ENV_HOLD_MIN,
  ENV_SLOTS,
  ENV_WAIT_MIN,
  type Holder,
  readSlotConfig,
  runInSlot,
  type SlotConfig,
  type SlotDeps,
  slotPolicy,
  TestSlotError,
  tryAcquire,
  withTestSlot,
} from '../src/test-slots.ts';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'test-slots-'));
  tmps.push(d);
  return d;
};

function cfgIn(dir: string, over: Partial<SlotConfig> = {}): SlotConfig {
  return {
    dir,
    slots: 2,
    maxWaitMs: 60_000,
    maxHoldMs: 30 * 60_000,
    pollMs: 1000,
    reportMs: 10_000,
    ...over,
  };
}

/** 假的时钟和睡觉：sleep 只把时钟往前拨，并给测试一个「睡的时候别人在干什么」的钩子。 */
function fakeDeps(over: Partial<SlotDeps> = {}, onSleep?: (t: number) => void) {
  let t = 1_000_000;
  const logs: string[] = [];
  const deps: SlotDeps = {
    now: () => t,
    sleep(ms) {
      t += ms;
      onSleep?.(t);
    },
    pidAlive: () => true,
    pid: 4242,
    host: 'host-a',
    cwd: '/work/a',
    log: (l) => logs.push(l),
    ...over,
  };
  return {
    deps,
    logs,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function putHolder(dir: string, index: number, h: Partial<Holder> = {}): Holder {
  mkdirSync(dir, { recursive: true });
  const holder: Holder = {
    v: 1,
    token: `tok${index}`,
    pid: 99999,
    host: 'host-a',
    startedAt: 1_000_000,
    cwd: '/work/x',
    ...h,
  };
  writeFileSync(join(dir, `slot-${index}.json`), JSON.stringify(holder));
  return holder;
}

const slotFiles = (dir: string) => readdirSync(dir).filter((n) => /^slot-\d+\.json$/.test(n));

describe('readSlotConfig / slotPolicy', () => {
  it('不设就是默认：2 个、等 15 分钟、持有上限 30 分钟、槽目录在用户目录下', () => {
    const c = readSlotConfig({}, () => '/home/u');
    expect(c.slots).toBe(DEFAULT_SLOTS);
    expect(c.maxWaitMs).toBe(DEFAULT_MAX_WAIT_MIN * 60_000);
    expect(c.maxHoldMs).toBe(DEFAULT_MAX_HOLD_MIN * 60_000);
    expect(c.dir.replaceAll('\\', '/')).toBe('/home/u/.fleet-dao/test-slots');
  });

  it('环境变量能调个数、等多久、持有上限、槽目录', () => {
    const c = readSlotConfig(
      { [ENV_SLOTS]: '3', [ENV_WAIT_MIN]: '0.5', [ENV_HOLD_MIN]: '5', [ENV_DIR]: '/x/y' },
      () => '',
    );
    expect([c.slots, c.maxWaitMs, c.maxHoldMs, c.dir]).toEqual([3, 30_000, 300_000, '/x/y']);
  });

  it('写错了（0、负数、小数个数、不是数）抛错，不悄悄用默认值', () => {
    for (const v of ['0', '-1', '1.5', 'two', '2x']) {
      expect(() => readSlotConfig({ [ENV_SLOTS]: v }, () => '/h')).toThrow(TestSlotError);
    }
    for (const name of [ENV_WAIT_MIN, ENV_HOLD_MIN]) {
      for (const v of ['0', '-3', 'abc'])
        expect(() => readSlotConfig({ [name]: v }, () => '/h')).toThrow(TestSlotError);
    }
  });

  it('读不到用户目录又没指定槽目录：抛错', () => {
    expect(() => readSlotConfig({}, () => '')).toThrow(/读不到用户目录/);
  });

  it('CI 里和外层已拿着槽时跳过，其余都拿', () => {
    expect(slotPolicy({})).toEqual({ kind: 'lock' });
    expect(slotPolicy({ CI: 'false' })).toEqual({ kind: 'lock' });
    expect(slotPolicy({ CI: '0' })).toEqual({ kind: 'lock' });
    expect(slotPolicy({ CI: 'true' }).kind).toBe('skip');
    expect(slotPolicy({ [ENV_HELD]: 'abc' }).kind).toBe('skip');
    expect(slotPolicy({ [ENV_HELD]: '  ' })).toEqual({ kind: 'lock' });
  });
});

describe('tryAcquire', () => {
  it('同时最多 N 个：占满后再试回 busy，还一个就又能占', () => {
    const dir = join(tmp(), 'slots');
    const { deps } = fakeDeps();
    const cfg = cfgIn(dir);
    const a = tryAcquire(cfg, deps);
    const b = tryAcquire(cfg, deps);
    expect([a.kind, b.kind]).toEqual(['got', 'got']);
    expect(slotFiles(dir)).toEqual(['slot-0.json', 'slot-1.json']);
    const c = tryAcquire(cfg, deps);
    expect(c.kind).toBe('busy');
    if (c.kind === 'busy') expect(c.holders).toHaveLength(2);
    if (a.kind === 'got') a.handle.release();
    expect(slotFiles(dir)).toEqual(['slot-1.json']);
    expect(tryAcquire(cfg, deps).kind).toBe('got');
  });

  it('死进程占的槽（同一台主机、进程号不存在）被回收，并留一行日志', () => {
    const dir = tmp();
    putHolder(dir, 0, { pid: 31337 });
    const { deps, logs } = fakeDeps({ pidAlive: (pid) => pid !== 31337 });
    const r = tryAcquire(cfgIn(dir, { slots: 1 }), deps);
    expect(r.kind).toBe('got');
    expect(logs.join('\n')).toMatch(/回收本机测试槽 slot-0\.json.*31337 已经不在/);
  });

  it('进程号还在也不能永远占着：超过持有上限的槽被回收', () => {
    const dir = tmp();
    const { deps, advance } = fakeDeps();
    putHolder(dir, 0, { pid: 31337, startedAt: 1_000_000 });
    const cfg = cfgIn(dir, { slots: 1, maxHoldMs: 60_000 });
    expect(tryAcquire(cfg, deps).kind).toBe('busy');
    advance(60_001);
    expect(tryAcquire(cfg, deps).kind).toBe('got');
  });

  it('别的主机占的槽没法判进程号：没过期就当还活着', () => {
    const dir = tmp();
    putHolder(dir, 0, { host: 'host-b', pid: 31337 });
    const { deps } = fakeDeps({ pidAlive: () => false });
    expect(tryAcquire(cfgIn(dir, { slots: 1 }), deps).kind).toBe('busy');
  });

  it('槽目录建不出来（那个路径是个文件）：抛 TestSlotError，不当成拿到', () => {
    const file = join(tmp(), 'not-a-dir');
    writeFileSync(file, 'x');
    const { deps } = fakeDeps();
    expect(() => tryAcquire(cfgIn(file), deps)).toThrow(TestSlotError);
    expect(() => tryAcquire(cfgIn(join(file, 'sub')), deps)).toThrow(/本机测试槽没法用/);
  });

  it('槽目录写不进（互斥锁的位置被一个文件占着）：抛错', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.mutex'), 'x');
    const { deps } = fakeDeps();
    // 文件的 mtime 是刚刚的、不算过期；mkdir 报 EEXIST 一路等到 5 秒用尽（假时钟，不真等）
    expect(() => tryAcquire(cfgIn(dir), deps)).toThrow(/互斥锁 \.mutex 等了 5 秒还被占着/);
  });

  it('互斥锁被死进程留下、超过 10 秒：被拆掉后正常拿到', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.mutex'));
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, '.mutex'), old, old);
    const { deps } = fakeDeps();
    expect(tryAcquire(cfgIn(dir), deps).kind).toBe('got');
    expect(existsSync(join(dir, '.mutex'))).toBe(false);
  });

  it('槽文件格式认不出（JSON 坏了、缺字段）：抛错、不当成空槽', () => {
    for (const body of [
      'not json',
      '{}',
      '{"v":2}',
      JSON.stringify({ v: 1, token: 't', pid: 'x', host: 'h', startedAt: 1, cwd: 'c' }),
    ]) {
      const dir = tmp();
      writeFileSync(join(dir, 'slot-0.json'), body);
      const { deps } = fakeDeps();
      expect(() => tryAcquire(cfgIn(dir, { slots: 1 }), deps)).toThrow(/槽文件格式认不出/);
    }
  });

  it('槽文件读不了（是个目录）：抛错', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'slot-0.json'));
    const { deps } = fakeDeps();
    expect(() => tryAcquire(cfgIn(dir), deps)).toThrow(TestSlotError);
  });

  it('把个数调小后，序号超出范围的老槽照样算在占着的里面', () => {
    const dir = tmp();
    putHolder(dir, 3, { pid: 31337 });
    const { deps } = fakeDeps();
    expect(tryAcquire(cfgIn(dir, { slots: 1 }), deps).kind).toBe('busy');
    expect(tryAcquire(cfgIn(dir, { slots: 2 }), deps).kind).toBe('got');
  });

  it('还槽只删自己的：槽已被回收、换了别人占，不动别人的', () => {
    const dir = tmp();
    const { deps } = fakeDeps();
    const r = tryAcquire(cfgIn(dir, { slots: 1 }), deps);
    if (r.kind !== 'got') throw new Error('应该拿到');
    putHolder(dir, 0, { token: 'someone-else', pid: 777 });
    r.handle.release();
    expect(slotFiles(dir)).toEqual(['slot-0.json']);
  });
});

describe('acquireSlot / withTestSlot', () => {
  it('满了就排队：第一行写前面几个在跑，之后每 10 秒一行；前面一释放就接上', () => {
    const dir = tmp();
    putHolder(dir, 0, { pid: 31337, startedAt: 1_000_000 });
    putHolder(dir, 1, { pid: 31338, startedAt: 1_000_000 });
    // 假时钟走到 25 秒时，前面一个持有者进程「死了」
    let dead = false;
    const f = fakeDeps({ pidAlive: (pid) => !(dead && pid === 31337) }, (t) => {
      if (t >= 1_025_000) dead = true;
    });
    const h = acquireSlot(cfgIn(dir), f.deps);
    expect(h.token).toMatch(/^[0-9a-f]{16}$/);
    const waits = f.logs.filter((l) => l.includes('前面还有'));
    expect(waits[0]).toMatch(/前面还有 2 个在跑，已等 0 秒/);
    expect(waits[1]).toMatch(/已等 10 秒/);
    expect(waits[2]).toMatch(/已等 20 秒/);
    expect(waits).toHaveLength(3);
    expect(f.logs.some((l) => l.includes('拿到本机测试槽，共等了'))).toBe(true);
  });

  it('等过上限还满：抛 TestSlotError，说明占着的是谁、没跑测试', () => {
    const dir = tmp();
    putHolder(dir, 0, { pid: 31337, cwd: '/work/slowpoke' });
    const f = fakeDeps();
    const cfg = cfgIn(dir, { slots: 1, maxWaitMs: 30_000 });
    expect(() => acquireSlot(cfg, f.deps)).toThrow(/等了 30 秒还是满的.*\/work\/slowpoke.*没跑测试/);
    expect(slotFiles(dir)).toEqual(['slot-0.json']);
  });

  it('withTestSlot：fn 抛了也还槽；拿不到时 fn 不会被调用', () => {
    const dir = tmp();
    const f = fakeDeps();
    const cfg = cfgIn(dir, { slots: 1, maxWaitMs: 2000 });
    expect(() =>
      withTestSlot(cfg, f.deps, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(slotFiles(dir)).toEqual([]);
    putHolder(dir, 0, { pid: 31337 });
    let called = false;
    expect(() =>
      withTestSlot(cfg, f.deps, () => {
        called = true;
      }),
    ).toThrow(TestSlotError);
    expect(called).toBe(false);
  });
});

describe('runInSlot（test:changed 真起 vitest 的那一步）', () => {
  it('拿到槽才跑，把 token 交给 run（写进 vitest 的环境），跑完槽已还', () => {
    const dir = tmp();
    const f = fakeDeps();
    const seen: Array<string | undefined> = [];
    const r = runInSlot({ [ENV_DIR]: dir }, f.deps, (held) => {
      seen.push(held);
      expect(slotFiles(dir)).toHaveLength(1);
      return { status: 0 };
    });
    expect(r).toEqual({ status: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(slotFiles(dir)).toEqual([]);
  });

  it('CI 里和外层已拿着槽：不碰槽目录，直接跑', () => {
    const file = join(tmp(), 'would-fail');
    writeFileSync(file, 'x'); // 槽目录若被碰就会报错
    const f = fakeDeps();
    for (const env of [
      { CI: 'true', [ENV_DIR]: file },
      { [ENV_HELD]: 'abc', [ENV_DIR]: file },
    ]) {
      expect(runInSlot(env, f.deps, (held) => ({ status: held === undefined ? 0 : 9 }))).toEqual({
        status: 0,
      });
    }
  });

  it('拿不到槽（槽目录用不了、等太久、个数写错）：回 error、run 一次都不调用，不当成拿到了', () => {
    const f = fakeDeps();
    let calls = 0;
    const run = () => {
      calls += 1;
      return { status: 0 };
    };
    const file = join(tmp(), 'a-file');
    writeFileSync(file, 'x');
    const full = tmp();
    putHolder(full, 0, { pid: 31337 });
    putHolder(full, 1, { pid: 31338 });
    for (const env of [
      { [ENV_DIR]: file },
      { [ENV_DIR]: full, [ENV_WAIT_MIN]: '0.01' },
      { [ENV_DIR]: tmp(), [ENV_SLOTS]: 'zero' },
    ]) {
      const r = runInSlot(env, f.deps, run);
      expect(r.status).toBeNull();
      expect(r.error).toBeInstanceOf(TestSlotError);
    }
    expect(calls).toBe(0);
  });

  it('run 自己抛的不是槽的错：照样往上抛、槽照样还', () => {
    const dir = tmp();
    const f = fakeDeps();
    expect(() =>
      runInSlot({ [ENV_DIR]: dir }, f.deps, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(slotFiles(dir)).toEqual([]);
  });
});

describe('跨进程', () => {
  it('两个进程同时抢最后一个槽：只有一个拿到', async () => {
    const dir = join(tmp(), 'slots');
    const script = fileURLToPath(new URL('./test-slots-race.ts', import.meta.url));
    // 三轮各用各的槽目录、互不相干：一起跑（原来一轮一轮串着，每轮光等开抢时刻就 3 秒）
    await Promise.all(
      [0, 1, 2].map(async (round) => {
        const roundDir = join(dir, `r${round}`);
        const startAt = Date.now() + 3000;
        const runOne = () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [script, roundDir, String(startAt), '1500'], {
              env: { ...process.env, RACE_SLOTS: '1' },
              stdio: ['ignore', 'pipe', 'inherit'],
            });
            let out = '';
            child.stdout.on('data', (d: Buffer) => {
              out += d.toString();
            });
            child.on('error', reject);
            child.on('close', () => resolve(out.trim()));
          });
        const results = await Promise.all([runOne(), runOne()]);
        expect(results.sort()).toEqual(['BUSY', 'GOT']);
      }),
    );
  }, 60_000);
});
