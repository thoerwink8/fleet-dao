// 写锁：同一个家目录同一时刻只许一个 --apply 在写（几个会话同时开，开会话钩子会同时跑同步）。
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Deps, runCli } from '../src/cli.ts';
import { STALE_MS, takeLock } from '../src/lock.ts';
import { cleanup, fakeBin, makeRepo, PLATFORM, put, tempDir } from './helpers.ts';

afterEach(cleanup);

const NOW = new Date('2026-09-26T06:00:00Z');
const LOCK = '.fleet-dao/agents-sync.lock';

describe('写锁', () => {
  it('拿到了别人就拿不到，放了再拿得到', () => {
    const home = tempDir('home');
    const first = takeLock(home, PLATFORM, NOW);
    expect(first.ok).toBe(true);
    expect(existsSync(join(home, ...LOCK.split('/')))).toBe(true);
    const second = takeLock(home, PLATFORM, NOW);
    expect(second.ok).toBe(false);
    expect(second.ok ? '' : second.why).toContain('另一个 agents-sync 在写');
    if (first.ok) first.release();
    expect(existsSync(join(home, ...LOCK.split('/')))).toBe(false);
    expect(takeLock(home, PLATFORM, NOW).ok).toBe(true);
  });

  it('拿锁的进程已经不在了：当成上次崩了留下的，拿过来', () => {
    const home = tempDir('home');
    put(home, LOCK, '999999999 2026-09-26T05:59:00.000Z\n');
    expect(takeLock(home, PLATFORM, NOW).ok).toBe(true);
  });

  it('锁放了太久（进程还在也算）：拿过来', () => {
    const home = tempDir('home');
    const file = put(home, LOCK, `${process.pid} 2026-09-26T05:00:00.000Z\n`);
    const old = new Date(Date.now() - STALE_MS - 60_000);
    utimesSync(file, old, old);
    expect(takeLock(home, PLATFORM, NOW).ok).toBe(true);
  });

  it('--apply 时锁被占着：没查成（退出码 2），说清谁占着，一个字不写', () => {
    const home = tempDir('home');
    put(home, LOCK, `${process.pid} ${NOW.toISOString()}\n`);
    const bin = tempDir('bin');
    fakeBin(bin, 'claude');
    let out = '';
    const deps: Deps = {
      platform: PLATFORM,
      env: { PATH: bin, PATHEXT: '.CMD' },
      stdout: (t) => {
        out += t;
      },
      stderr: (t) => {
        out += t;
      },
      now: () => NOW,
      homedir: () => home,
      defaultRepo: makeRepo({}),
      getuid: () => 1000,
      lookupUser: () => undefined,
      becomeUser: () => {},
    };
    expect(runCli(['--apply'], deps)).toBe(2);
    expect(out).toContain('另一个 agents-sync 在写');
    expect(existsSync(join(home, '.claude'))).toBe(false);
    // 锁还是那个会话的，不许被这次删掉
    expect(existsSync(join(home, ...LOCK.split('/')))).toBe(true);
  });
});
