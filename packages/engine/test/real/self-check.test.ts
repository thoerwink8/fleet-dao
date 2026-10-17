// 引擎自测（selfCheck，决定 0093）：以树主人的身份跑仓的测试命令和 tsc；精炼输出；没跑成回 skipped 不抛。
// test:changed 退出 3（要全跑）时不把测试推给 CI：在整机锁下改跑受影响的包，超时记没过。

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from '@fleet-dao/adapters';
import type { RepoWithProfile } from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PortContext } from '../../src/ports.ts';
import { localExec, type UserCommand, type UserCommandResult } from '../../src/real/exec.ts';
import {
  createAffectedLock,
  createSelfCheck,
  createSelfCheckSlots,
  digestOutput,
  SELF_CHECK_HEARTBEAT_MS,
  SELF_CHECK_QUEUE_MS,
  SELF_CHECK_SLOTS,
  SELF_CHECK_TEST_MS,
  SELF_CHECK_TSC_MS,
  type SelfCheckFullLock,
} from '../../src/real/self-check.ts';
import { SELF_CHECK_DIGEST_MAX, type SelfCheckInput } from '../../src/task-contract.ts';
import { runChild } from '../child.ts';
import { freshRepo } from '../helpers.ts';

const USER = 'fleet-agent-1' as SessionUser;

function ctx(): PortContext {
  return { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, lastHeartbeat: undefined };
}

function result(code: number | null, out = '', over: Partial<UserCommandResult> = {}): UserCommandResult {
  return { code, stdout: Buffer.from(out), stderr: '', timedOut: false, aborted: false, ...over };
}

function input(
  testCommand = 'pnpm test:changed',
  profile?: NonNullable<RepoWithProfile['profile']>,
): SelfCheckInput {
  return {
    schemaVersion: 1,
    taskId: 't-1',
    repo: { ...freshRepo(), testCommand, ...(profile === undefined ? {} : { profile }) },
    worktreePath: '/work/t-1',
  };
}

const openLock: SelfCheckFullLock = { acquire: async () => () => {} };

/** 按脚本里的那一段（node_modules 探测 / tsc 探测 / 测试 / 受影响包 / tsc）回结果，记下每条命令。 */
function rig(over: {
  deps?: string;
  hasTsc?: string;
  test?: () => UserCommandResult;
  /** test:changed --affected。不给就跟 test 同一条。 */
  affected?: () => UserCommandResult;
  tsc?: () => UserCommandResult;
  owner?: SessionUser | null;
  lock?: SelfCheckFullLock;
  /** 不给就一直有名额。要测排队就换上会等的。 */
  slots?: SelfCheckFullLock;
  testMs?: number;
  queueMs?: number;
  /** 测试命令换成按脚本吐输出、会被叫停的假进程（用假时钟走）。给了就不看 test。 */
  testRun?: (command: UserCommand) => Promise<UserCommandResult>;
  tscRun?: (command: UserCommand) => Promise<UserCommandResult>;
}) {
  const commands: UserCommand[] = [];
  const check = createSelfCheck({
    trees: { ownerOf: async () => (over.owner === undefined ? USER : over.owner) },
    ...(over.testMs === undefined ? {} : { testMs: over.testMs }),
    ...(over.queueMs === undefined ? {} : { queueMs: over.queueMs }),
    fullLock: over.lock ?? openLock,
    slots: over.slots ?? openLock,
    exec: async (command) => {
      commands.push(command);
      const script = command.argv[2] ?? '';
      if (script.includes('test -d node_modules')) return result(0, over.deps ?? 'yes\n');
      if (script.includes('test -f tsconfig.json')) return result(0, over.hasTsc ?? 'yes\n');
      if (script.includes('tsc -b')) {
        if (over.tscRun) return over.tscRun(command);
        return (over.tsc ?? (() => result(0, '')))();
      }
      if (over.testRun) return over.testRun(command);
      if (script.includes('--affected')) return (over.affected ?? over.test ?? (() => result(0, '')))();
      return (over.test ?? (() => result(0, 'Tests  3 passed (3)')))();
    },
  });
  return { check, commands };
}

function scriptOf(command: UserCommand): string {
  return command.argv[2] ?? '';
}

describe('selfCheck', () => {
  it('测试和 tsc 都过：green；以树主人在树里跑，PATH 带上 /usr/local/bin，不带 FLEET_RUN_ID', async () => {
    const { check, commands } = rig({});
    const got = await check(input(), ctx());
    expect(got.state).toBe('green');
    expect(got.steps.map((s) => s.outcome)).toEqual(['pass', 'pass']);
    const test = commands.find((c) => (c.argv[2] ?? '').includes('pnpm test:changed'));
    expect(test).toMatchObject({ user: USER, cwd: '/work/t-1' });
    expect(test?.argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(test?.argv[2]).toContain(
      'PATH=$HOME/.local/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin',
    );
    expect(test?.argv[2]).toContain('unset FLEET_RUN_ID');
    expect(test?.argv[2]).toContain('2>&1');
    expect(JSON.stringify(commands.map((c) => c.env ?? {}))).not.toContain('FLEET_RUN_ID');
  });

  it('测试没过：red，摘要里有失败的那一行', async () => {
    const { check } = rig({
      test: () =>
        result(
          1,
          ['RUN v5', ' ✓ ok.test.ts', ' FAIL a.test.ts > 少了一行', 'Tests  1 failed (3)'].join('\n'),
        ),
    });
    const got = await check(input(), ctx());
    expect(got.state).toBe('red');
    expect(got.steps[0]).toMatchObject({ outcome: 'fail', exitCode: 1 });
    expect(got.steps[0]?.digest).toContain('FAIL a.test.ts > 少了一行');
    expect(got.steps[0]?.digest).toContain('Tests  1 failed (3)');
  });

  it('tsc 报错：red', async () => {
    const { check } = rig({
      tsc: () => result(2, "src/a.ts(3,1): error TS2322: Type 'x' is not assignable"),
    });
    const got = await check(input(), ctx());
    expect(got.state).toBe('red');
    expect(got.steps[1]?.digest).toContain('TS2322');
  });

  it('test:changed 退出 2（没算成）：记没跑，不算红，也不改跑受影响的包', async () => {
    const { check, commands } = rig({ test: () => result(2, '没算成') });
    const got = await check(input(), ctx());
    expect(got.steps[0]).toMatchObject({ outcome: 'skipped', exitCode: 2 });
    expect(got.state).toBe('green'); // tsc 过了
    expect(commands.some((c) => scriptOf(c).includes('--affected'))).toBe(false);
  });

  it('test:changed 退出 3（要全跑）：在锁下跑受影响的包，不再只跑 tsc', async () => {
    let acquired = 0;
    const { check, commands } = rig({
      test: () => result(3, '要全跑'),
      affected: () => result(0, 'Tests  4 passed (4)'),
      lock: {
        async acquire() {
          acquired += 1;
          return () => {};
        },
      },
    });
    const got = await check(input(), ctx());
    expect(acquired).toBe(1);
    const affected = commands.find((c) => scriptOf(c).includes('--affected'));
    expect(affected).toBeDefined();
    if (affected === undefined) return;
    expect(scriptOf(affected)).toContain('pnpm test:changed --affected');
    expect(affected).toMatchObject({ user: USER, cwd: '/work/t-1' });
    // exec 的兜底时限 = 剩下的排队预算 + 测试执行预算；按段停由自测自己的计时器管
    expect(affected?.timeoutMs).toBeLessThanOrEqual(SELF_CHECK_QUEUE_MS + SELF_CHECK_TEST_MS);
    expect(affected?.timeoutMs).toBeGreaterThan(SELF_CHECK_QUEUE_MS + SELF_CHECK_TEST_MS - 5_000);
    expect(got.steps.map((s) => s.outcome)).toEqual(['skipped', 'pass', 'pass']);
    expect(got.steps[0]).toMatchObject({ exitCode: 3 });
    expect(got.steps[1]?.command).toContain('--affected');
    expect(got.state).toBe('green');
  });

  it('要全跑之后受影响的包没过：red', async () => {
    const { check } = rig({
      test: () => result(3, '要全跑'),
      affected: () => result(1, 'FAIL pkg.test.ts > 坏了\nTests  1 failed (2)'),
    });
    const got = await check(input(), ctx());
    expect(got.state).toBe('red');
    expect(got.steps[1]).toMatchObject({ outcome: 'fail', exitCode: 1 });
    expect(got.steps[1]?.digest).toContain('FAIL pkg.test.ts > 坏了');
  });

  it('锁被占时排队而不是跳过，拿到锁才跑受影响的包', async () => {
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let waiting = false;
    const { check, commands } = rig({
      test: () => result(3, '要全跑'),
      affected: () => result(0, 'Tests  1 passed (1)'),
      testMs: 5_000,
      queueMs: 10_000,
      lock: {
        async acquire(signal) {
          waiting = true;
          await hold;
          if (signal.aborted) throw new Error('aborted');
          return () => {};
        },
      },
    });
    let settled = false;
    const pending = check(input(), ctx()).then((got) => {
      settled = true;
      return got;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(waiting).toBe(true);
    expect(settled).toBe(false);
    expect(commands.some((c) => scriptOf(c).includes('--affected'))).toBe(false);
    releaseHold();
    const got = await pending;
    expect(settled).toBe(true);
    const affected = commands.find((c) => scriptOf(c).includes('--affected'));
    expect(affected).toBeTruthy();
    // 等锁的 30 毫秒从排队预算里扣，执行预算 5 秒原样留着
    expect(affected?.timeoutMs).toBeLessThan(10_000 + 5_000 - 20);
    expect(affected?.timeoutMs).toBeGreaterThan(5_000);
    expect(got.steps[1]).toMatchObject({ outcome: 'pass' });
    expect(got.state).toBe('green');
  });

  it('要全跑之后受影响的包超时：记自测超时，没过', async () => {
    const ran = rig({
      test: () => result(3, '要全跑'),
      affected: () => result(null, '还在跑', { timedOut: true }),
    });
    const ranOut = await ran.check(input(), ctx());
    expect(ranOut.steps[1]).toMatchObject({ outcome: 'fail', exitCode: null });
    expect(ranOut.steps[1]?.digest).toMatch(/^自测超时：执行超过/);
    expect(ranOut.steps[1]?.digest).toContain('还在跑');
    expect(ranOut.state).toBe('red');

    // 锁一直被占，排队到时限：同样记没过，不跳过、也不当成过了
    const queued = rig({
      test: () => result(3, '要全跑'),
      queueMs: 80,
      lock: {
        acquire: (signal) =>
          new Promise((_resolve, reject) => {
            const fail = () => reject(new Error('aborted'));
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
          }),
      },
    });
    const waited = await queued.check(input(), ctx());
    expect(waited.steps[1]).toMatchObject({ outcome: 'fail' });
    expect(waited.steps[1]?.digest).toMatch(/^自测超时：等整机锁超过/);
    expect(waited.state).toBe('red');
    expect(queued.commands.some((c) => scriptOf(c).includes('--affected'))).toBe(false);
  });

  it('超时：记没跑（慢不等于错），不算红', async () => {
    const { check } = rig({ test: () => result(null, '', { timedOut: true }) });
    const got = await check(input(), ctx());
    expect(got.steps[0]?.outcome).toBe('skipped');
    expect(got.steps[0]?.digest).toContain('没跑完');
    expect(got.steps[0]?.digest).toContain('没有任何输出');
    expect(got.state).toBe('green');
  });

  it('非 Node 仓按档案命令跑：没有 node_modules 也不整个跳过', async () => {
    const { check, commands } = rig({ deps: 'no\n', hasTsc: 'no\n' });
    const got = await check(
      input('pnpm check', {
        language: 'go',
        toolchain: ['go'],
        testCommand: 'go test ./...',
        moduleRoots: [],
        mergeSignals: [],
        standardPathsFile: 'packages/conventions/standard-paths.json',
        weight: 1,
        flowEligible: false,
      }),
      ctx(),
    );
    expect(got.state).toBe('green');
    expect(got.steps.map((s) => [s.command, s.outcome])).toEqual([
      ['go test ./...', 'pass'],
      ['node_modules/.bin/tsc -b --pretty false', 'skipped'],
    ]);
    expect(commands.some((c) => scriptOf(c).includes('test -d node_modules'))).toBe(false);
  });

  it('工具链只写 pnpm、不写 node：仍算 Node 仓，没有 node_modules 整个跳过', async () => {
    const { check, commands } = rig({ deps: 'no\n' });
    const got = await check(
      input('pnpm check', {
        language: 'typescript',
        toolchain: ['pnpm'],
        testCommand: 'pnpm check',
        moduleRoots: ['packages/*'],
        mergeSignals: ['merge-gate'],
        standardPathsFile: 'packages/conventions/standard-paths.json',
        weight: 1,
        flowEligible: false,
      }),
      ctx(),
    );
    expect(got).toMatchObject({ state: 'skipped', reason: expect.stringContaining('没装依赖') });
    expect(commands.some((c) => scriptOf(c).includes('pnpm check'))).toBe(false);
  });

  it('没装依赖、树不在、没有命令也没有 tsc：skipped 加原因，不抛', async () => {
    expect(await rig({ deps: 'no\n' }).check(input(), ctx())).toMatchObject({
      state: 'skipped',
      reason: expect.stringContaining('没装依赖'),
    });
    expect(await rig({ owner: null }).check(input(), ctx())).toMatchObject({
      state: 'skipped',
      reason: expect.stringContaining('不在'),
    });
    const none = await rig({ hasTsc: 'no\n' }).check(input(''), ctx());
    expect(none.state).toBe('skipped');
    expect(none.steps.every((s) => s.outcome === 'skipped')).toBe(true);
  });

  it('【故意造出的失败】执行抛错：回 skipped 写明，不抛；入参认不出才抛', async () => {
    const check = createSelfCheck({
      trees: { ownerOf: async () => USER },
      exec: async () => {
        throw new Error('sudo 起不来');
      },
    });
    expect(await check(input(), ctx())).toMatchObject({
      state: 'skipped',
      reason: expect.stringContaining('sudo 起不来'),
    });
    await expect(check({ schemaVersion: 1 } as SelfCheckInput, ctx())).rejects.toThrow('自测');
  });
});

describe('受影响包的整机锁', () => {
  it('被占时后来者排队，放开才拿到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-check-lock-'));
    try {
      const lock = createAffectedLock(dir, { pollMs: 20, staleMs: 60_000 });
      const release = await lock.acquire(new AbortController().signal);
      let second = false;
      const pending = lock.acquire(new AbortController().signal).then((rel) => {
        second = true;
        return rel;
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(second).toBe(false);
      await release();
      const release2 = await pending;
      expect(second).toBe(true);
      await release2();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('死进程占的锁拆掉再占，不一直排着', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-check-lock-'));
    try {
      const lockDir = join(dir, 'affected.lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'deadbeefdeadbeef'), `2147483646\n${Date.now()}\n`);
      const lock = createAffectedLock(dir, { pollMs: 20, staleMs: 60_000 });
      const release = await lock.acquire(new AbortController().signal);
      await release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('两个等待者都判定锁过期后，后拆的那个删不掉新锁', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-check-lock-'));
    try {
      const lockDir = join(dir, 'affected.lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'deadbeefdeadbeef'), `2147483646\n${Date.now()}\n`);
      let entered = 0;
      let releaseBoth = (): void => {};
      const bothEntered = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      let releaseSecond = (): void => {};
      const firstHeld = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      let removed = 0;
      let markSecond = (): void => {};
      const secondRemoved = new Promise<void>((resolve) => {
        markSecond = resolve;
      });
      const lock = createAffectedLock(dir, {
        pollMs: 10,
        staleMs: 60_000,
        beforeRemove: async () => {
          entered += 1;
          const mine = entered;
          if (mine === 2) releaseBoth();
          if (mine === 1) await bothEntered;
          else await firstHeld;
        },
        afterRemove: () => {
          removed += 1;
          if (removed === 2) markSecond();
        },
      });
      const signal = new AbortController().signal;
      const done: Array<() => void | Promise<void>> = [];
      const tasks = [0, 1].map(() =>
        lock.acquire(signal).then((rel) => {
          done.push(rel);
          return rel;
        }),
      );
      // 先进入拆锁的那个拿锁；后进入的等这把锁公布之后才删。和两个 promise 谁先被调度无关。
      const leaderRel = await Promise.race(tasks);
      releaseSecond();
      await secondRemoved;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(done).toHaveLength(1);
      const name = readdirSync(lockDir)[0];
      if (name === undefined) throw new Error('新锁被拆掉了');
      expect(name).not.toBe('deadbeefdeadbeef');
      expect(readFileSync(join(lockDir, name), 'utf8').startsWith(`${process.pid}\n`)).toBe(true);
      await leaderRel();
      await Promise.all(tasks);
      expect(done).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 4_000);
});

describe('自测名额', () => {
  it('同时 4 个自测只有 2 个同时在跑', async () => {
    expect(SELF_CHECK_SLOTS).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'self-check-slots-'));
    try {
      const slots = createSelfCheckSlots(dir, { pollMs: 10, slots: SELF_CHECK_SLOTS });
      let running = 0;
      let maxRunning = 0;
      let sawTwo!: () => void;
      const twoRunning = new Promise<void>((resolve) => {
        sawTwo = resolve;
      });
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const check = createSelfCheck({
        trees: { ownerOf: async () => USER },
        slots,
        fullLock: openLock,
        exec: async (command) => {
          const script = command.argv[2] ?? '';
          if (script.includes('test -d node_modules')) return result(0, 'yes\n');
          if (script.includes('test -f tsconfig')) return result(0, 'no\n');
          running += 1;
          if (running > maxRunning) maxRunning = running;
          if (running === SELF_CHECK_SLOTS) sawTwo();
          await hold;
          running -= 1;
          return result(0, 'ok');
        },
      });
      // 不走 test:changed 的测试命令占自测名额（test:changed 的容量归它自己的本机测试槽，见下面那组）
      const pending = [0, 1, 2, 3].map((i) => check({ ...input('pnpm test'), taskId: `t-${i}` }, ctx()));
      const timedOut = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`名额没拦住：同时在跑 ${running}`)), 2_000);
      });
      try {
        await Promise.race([twoRunning, timedOut]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(running).toBe(SELF_CHECK_SLOTS);
        expect(maxRunning).toBe(SELF_CHECK_SLOTS);
      } finally {
        release();
      }
      const got = await Promise.all(pending);
      expect(maxRunning).toBe(SELF_CHECK_SLOTS);
      expect(got.map((g) => g.state)).toEqual(['green', 'green', 'green', 'green']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('死进程占满名额后，后来的拆掉再占', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-check-slots-'));
    try {
      for (const name of ['slot-0', 'slot-1']) {
        const lockDir = join(dir, name);
        mkdirSync(lockDir);
        writeFileSync(join(lockDir, 'deadbeefdeadbeef'), `2147483646\n${Date.now()}\n`);
      }
      const slots = createSelfCheckSlots(dir, { pollMs: 10, staleMs: 60_000 });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1_000);
      try {
        const release = await slots.acquire(ac.signal);
        await release();
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('排队等名额的时间不吃测试预算：拿到名额后测试、tsc 拿到的都是完整的执行时限', async () => {
    const waited = 150;
    const testMs = 5_000;
    const { check, commands } = rig({
      testMs,
      slots: {
        async acquire() {
          await new Promise((resolve) => setTimeout(resolve, waited));
          return () => {};
        },
      },
    });
    const got = await check(input('pnpm test'), ctx());
    expect(got.state).toBe('green');
    const test = commands.find((c) => scriptOf(c).includes('pnpm test'));
    const tsc = commands.find((c) => scriptOf(c).includes('tsc -b'));
    expect(test?.timeoutMs).toBe(testMs);
    expect(tsc?.timeoutMs).toBe(SELF_CHECK_TSC_MS);
  });

  it('测试命令是 test:changed：测试那一步不占自测名额（容量归本机测试槽），只有 tsc 占', async () => {
    const order: string[] = [];
    const { check } = rig({
      test: () => {
        order.push('test');
        return result(0, '拿到本机测试槽，共等了 0 秒\nTests  1 passed (1)');
      },
      tsc: () => {
        order.push('tsc');
        return result(0, '');
      },
      slots: {
        async acquire() {
          order.push('slot');
          return () => {
            order.push('release');
          };
        },
      },
    });
    const got = await check(input(), ctx());
    expect(got.state).toBe('green');
    expect(order).toEqual(['test', 'slot', 'tsc', 'release']);
  });

  it('排队等名额时每 30 秒心跳，心跳写明在等什么、从哪一刻起等', async () => {
    expect(SELF_CHECK_HEARTBEAT_MS).toBe(30_000);
    vi.useFakeTimers();
    try {
      const beats: Record<string, unknown>[] = [];
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { check } = rig({
        hasTsc: 'no\n',
        slots: {
          acquire: () => hold.then(() => () => {}),
        },
      });
      const pending = check(input('pnpm test'), {
        signal: new AbortController().signal,
        heartbeat: (detail) => {
          beats.push(detail as Record<string, unknown>);
        },
        attempt: 1,
        lastHeartbeat: undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      const queuedAt = new Date().toISOString();
      const before = beats.length;
      await vi.advanceTimersByTimeAsync(SELF_CHECK_HEARTBEAT_MS);
      expect(beats.length).toBe(before + 1);
      expect(beats.at(-1)).toEqual({
        selfCheck: 't-1',
        phase: 'queue',
        waitingFor: '自测名额',
        phaseStartedAt: queuedAt,
        lastOutputAt: null,
      });
      await vi.advanceTimersByTimeAsync(SELF_CHECK_HEARTBEAT_MS);
      expect(beats.length).toBe(before + 2);
      release();
      await pending;
      expect(beats.at(-1)).toMatchObject({ phase: 'done' });
      // 没有完成数就不编：心跳里只有阶段和时刻
      for (const b of beats) expect(Object.keys(b).sort()).not.toContain('passed');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 按脚本吐输出的假测试进程：at 是从起来算的毫秒，out 是这一刻吐的输出，exit 给了就在这一刻退出。
 * 被叫停（signal）当下交回已有输出、aborted；到了 exec 的兜底时限交回 timedOut。全走假时钟。
 */
function scripted(plan: Array<{ at: number; out?: string; exit?: number }>) {
  const seen: { abortedAt?: number; startedAt?: number } = {};
  const run = (command: UserCommand): Promise<UserCommandResult> =>
    new Promise((resolve) => {
      const startedAt = Date.now();
      seen.startedAt = startedAt;
      let out = '';
      const timers: ReturnType<typeof setTimeout>[] = [];
      const done = (r: UserCommandResult) => {
        for (const t of timers) clearTimeout(t);
        command.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => {
        seen.abortedAt = Date.now() - startedAt;
        done(result(null, out, { aborted: true }));
      };
      command.signal?.addEventListener('abort', onAbort, { once: true });
      for (const step of plan) {
        timers.push(
          setTimeout(() => {
            if (step.out !== undefined) {
              out += step.out;
              command.onOutput?.(Buffer.from(step.out));
            }
            if (step.exit !== undefined) done(result(step.exit, out));
          }, step.at),
        );
      }
      timers.push(setTimeout(() => done(result(null, out, { timedOut: true })), command.timeoutMs));
    });
  return { run, seen };
}

const MIN = 60_000;
/** #2969 那次：等 conventions 的本机测试槽 11 分 35 秒。 */
const QUEUED = 11 * MIN + 35_000;

describe('排队和执行分开计时（假时钟）', () => {
  function beatsCtx(signal = new AbortController().signal) {
    const beats: Record<string, unknown>[] = [];
    const c: PortContext = {
      signal,
      heartbeat: (d) => {
        beats.push(d as Record<string, unknown>);
      },
      attempt: 1,
      lastHeartbeat: undefined,
    };
    return { beats, c };
  }

  it('等本机测试槽 11 分 35 秒，之后 29 分钟跑完：过了——排队不吃 30 分钟的执行预算', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const fake = scripted([
        { at: 0, out: '本机测试槽满了（同时最多 2 个）：前面还有 2 个在跑，已等 0 秒\n' },
        { at: QUEUED, out: '拿到本机测试槽，共等了 695 秒\n RUN  v3.2.4 /work\n' },
        { at: QUEUED + 29 * MIN, out: ' Tests  3 passed (3)\n', exit: 0 },
      ]);
      const { check } = rig({ testRun: fake.run });
      const { beats, c } = beatsCtx();
      const pending = check(input(), c);
      await vi.advanceTimersByTimeAsync(QUEUED + 29 * MIN + 1);
      const got = await pending;
      expect(fake.seen.abortedAt).toBeUndefined();
      expect(got.state).toBe('green');
      expect(got.steps.map((s) => s.outcome)).toEqual(['pass', 'pass']);
      // 心跳分得出等槽、测试执行、tsc、结束，带阶段起点和最后一次有输出的时刻
      const phases = beats.map((b) => b.phase).filter((p, i, all) => p !== all[i - 1]);
      // 测试等的是本机测试槽，tsc 前等的是自测名额（这里一下就拿到）
      expect(phases).toEqual(['queue', 'test', 'queue', 'tsc', 'done']);
      const waits = beats.filter((b) => b.phase === 'queue').map((b) => b.waitingFor);
      expect(waits.filter((w, i) => w !== waits[i - 1])).toEqual(['本机测试槽（test:changed）', '自测名额']);
      const testBeat = beats.find((b) => b.phase === 'test');
      expect(testBeat).toMatchObject({ phaseStartedAt: new Date(t0 + QUEUED).toISOString() });
      expect(beats.find((b) => b.phase === 'queue')).toMatchObject({
        waitingFor: '本机测试槽（test:changed）',
        phaseStartedAt: new Date(t0).toISOString(),
      });
      const midTest = beats.filter((b) => b.phase === 'test').at(-1);
      expect(midTest?.lastOutputAt).toBe(new Date(t0 + QUEUED).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('拿到槽后先有 FAIL 再超时：执行满 30 分钟才停，记没过、留着那条失败和时刻，不当成跳过或过了', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const fake = scripted([
        { at: 0, out: '本机测试槽满了：前面还有 2 个在跑\n' },
        { at: QUEUED, out: '拿到本机测试槽，共等了 695 秒\n' },
        {
          at: QUEUED + 5 * MIN,
          out: ' FAIL  packages/a/test/a.test.ts > 少了一行\nAssertionError: expected 1 to be 2\n',
        },
      ]);
      const { check } = rig({ testRun: fake.run });
      const pending = check(input(), beatsCtx().c);
      await vi.advanceTimersByTimeAsync(QUEUED + SELF_CHECK_TEST_MS + 10);
      const got = await pending;
      expect(fake.seen.abortedAt).toBe(QUEUED + SELF_CHECK_TEST_MS);
      expect(got.state).toBe('red');
      const step = got.steps[0];
      expect(step).toMatchObject({ outcome: 'fail', exitCode: null });
      expect(step?.digest).toContain('超时前已经有没过的');
      expect(step?.digest).toContain('FAIL packages/a/test/a.test.ts > 少了一行');
      expect(step?.digest).toContain(`执行 30 分 0 秒（${new Date(t0 + QUEUED).toISOString()} 起）`);
      expect(step?.digest).toContain(
        `等本机测试槽（test:changed） 11 分 35 秒（${new Date(t0).toISOString()} 起）`,
      );
      expect(step?.digest).toContain(`最后一次输出 ${new Date(t0 + QUEUED + 5 * MIN).toISOString()}`);
      expect(step?.digest.length).toBeLessThanOrEqual(SELF_CHECK_DIGEST_MAX);
    } finally {
      vi.useRealTimers();
    }
  });

  it('不走 test:changed 的命令一直没输出：执行到时限停掉，记没跑完、没有任何输出，tsc 照跑', async () => {
    vi.useFakeTimers();
    try {
      const fake = scripted([]);
      const { check } = rig({ testRun: fake.run });
      const pending = check(input('pnpm test'), beatsCtx().c);
      await vi.advanceTimersByTimeAsync(SELF_CHECK_TEST_MS + 10);
      const got = await pending;
      expect(got.steps[0]?.outcome).toBe('skipped');
      expect(got.steps[0]?.digest).toContain('执行超过 30 分 0 秒，没跑完，交给 CI');
      expect(got.steps[0]?.digest).toContain('没有任何输出');
      expect(got.steps[0]?.digest).toContain('最后一次输出 没有');
      expect(got.steps[1]?.outcome).toBe('pass');
    } finally {
      vi.useRealTimers();
    }
  });

  it('一直等不到本机测试槽：排队到上限就停，记没跑（不是测试没过），没开跑也不吃执行预算', async () => {
    vi.useFakeTimers();
    try {
      const fake = scripted([{ at: 0, out: '本机测试槽满了：前面还有 2 个在跑\n' }]);
      const { check } = rig({ testRun: fake.run });
      const pending = check(input(), beatsCtx().c);
      await vi.advanceTimersByTimeAsync(SELF_CHECK_QUEUE_MS + 10);
      const got = await pending;
      expect(fake.seen.abortedAt).toBe(SELF_CHECK_QUEUE_MS);
      expect(got.steps[0]?.outcome).toBe('skipped');
      expect(got.steps[0]?.digest).toContain('排队超过');
      expect(got.steps[0]?.digest).toContain('没开跑');
      expect(got.steps[0]?.digest).toContain('本机测试槽满了');
    } finally {
      vi.useRealTimers();
    }
  });

  it('各段排队合起来有上限：测试前等了 11 分 35 秒，tsc 等名额只剩下的那点', async () => {
    vi.useFakeTimers();
    try {
      const fake = scripted([
        { at: QUEUED, out: '拿到本机测试槽，共等了 695 秒\n' },
        { at: QUEUED + MIN, out: 'Tests  1 passed (1)\n', exit: 0 },
      ]);
      let slotAbortedAt: number | undefined;
      const { check } = rig({
        testRun: fake.run,
        slots: {
          acquire: (signal) =>
            new Promise((_resolve, reject) => {
              const started = Date.now();
              signal.addEventListener(
                'abort',
                () => {
                  slotAbortedAt = Date.now() - started;
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            }),
        },
      });
      const pending = check(input(), beatsCtx().c);
      await vi.advanceTimersByTimeAsync(SELF_CHECK_QUEUE_MS + 2 * MIN);
      const got = await pending;
      expect(slotAbortedAt).toBe(SELF_CHECK_QUEUE_MS - QUEUED);
      expect(got.steps[0]?.outcome).toBe('pass');
      expect(got.steps[1]).toMatchObject({ outcome: 'skipped' });
      expect(got.steps[1]?.digest).toContain('等自测名额超过剩下的排队预算');
    } finally {
      vi.useRealTimers();
    }
  });

  it('被叫停：当下停掉命令，记没跑完、带上已有输出，不写成过了', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      const fake = scripted([
        { at: 0, out: '拿到本机测试槽，共等了 0 秒\n' },
        { at: MIN, out: ' ✓ a.test.ts (3 tests)\n' },
      ]);
      const { check, commands } = rig({ testRun: fake.run });
      const pending = check(input(), beatsCtx(ac.signal).c);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      ac.abort();
      await vi.advanceTimersByTimeAsync(1);
      const got = await pending;
      expect(fake.seen.abortedAt).toBe(2 * MIN);
      expect(got.state).toBe('skipped');
      expect(got.steps[0]?.outcome).toBe('skipped');
      expect(got.steps[0]?.digest).toContain('被叫停了，没跑完');
      expect(got.steps[0]?.digest).toContain('a.test.ts (3 tests)');
      expect(commands.some((c) => scriptOf(c).includes('tsc -b'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('起不来：记没跑，写明原因，tsc 照跑', async () => {
    const { check } = rig({ test: () => result(null, '', { spawnError: 'spawn sudo ENOENT' }) });
    const got = await check(input(), ctx());
    expect(got.steps[0]).toMatchObject({ outcome: 'skipped', digest: '起不来：spawn sudo ENOENT' });
    expect(got.steps[1]?.outcome).toBe('pass');
  });

  it('超时留下的输出脱敏、限长', async () => {
    vi.useFakeTimers();
    try {
      const noisy = Array.from({ length: 2000 }, (_, i) => `line ${i} Bearer abcdefghijklmnop`).join('\n');
      const fake = scripted([{ at: 0, out: `拿到本机测试槽，共等了 0 秒\n${noisy}\n` }]);
      const { check } = rig({ testRun: fake.run });
      const pending = check(input(), beatsCtx().c);
      await vi.advanceTimersByTimeAsync(SELF_CHECK_TEST_MS + 10);
      const got = await pending;
      const digest = got.steps[0]?.digest ?? '';
      expect(digest).not.toContain('abcdefghijklmnop');
      expect(digest).toContain('Bearer <令牌>');
      expect(digest.length).toBeLessThanOrEqual(SELF_CHECK_DIGEST_MAX);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 真起进程、真用 test:changed 的本机测试槽（packages/conventions/src/test-slots.ts）：占槽的「普通 test:changed」和引擎自测
 * 在同一组槽上排队。槽目录指到临时目录；不设「已持槽」的环境变量。子进程 exec 成 node，杀掉它就是持槽进程死了。
 */
describe('和普通 test:changed 共用本机测试槽（真进程）', () => {
  // 经包的入口拿（槽的那几样在 @fleet-dao/conventions 的面上），子进程和引擎认的是同一份
  const conventionsEntry = pathToFileURL(
    createRequire(import.meta.url).resolve('@fleet-dao/conventions'),
  ).href;

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'self-check-shared-slots-'));
    const slotDir = join(dir, 'slots');
    const tree = join(dir, 'tree');
    mkdirSync(join(tree, 'node_modules'), { recursive: true });
    const script = join(dir, 'fake-test-changed.mjs');
    // 和 bin/test-changed.ts 起 vitest 前一样：先拿槽（满了排队、每秒再试），拿到后「跑」HOLD_MS 毫秒再还
    writeFileSync(
      script,
      [
        `import { acquireSlot, readSlotConfig, realSlotDeps } from ${JSON.stringify(conventionsEntry)};`,
        'const h = acquireSlot(readSlotConfig(process.env), realSlotDeps((l) => console.log(l)));',
        "console.log(' RUN  v3 fake');",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HOLD_MS ?? '0'));",
        "console.log(' Tests  1 passed (1)');",
        'h.release();',
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FLEET_LOCAL_TEST_SLOTS_DIR: slotDir,
      FLEET_LOCAL_TEST_SLOTS: '2',
    };
    delete env.FLEET_LOCAL_TEST_SLOT_HELD;
    const command = (holdMs: number) =>
      `FLEET_LOCAL_TEST_SLOTS_DIR=${slotDir} FLEET_LOCAL_TEST_SLOTS=2 HOLD_MS=${holdMs} exec ${process.execPath} ${script} test:changed`;
    /** 「普通 test:changed」：另起一个进程占着槽。 */
    const holder = async () => {
      const child = spawn(process.execPath, [script], { env: { ...env, HOLD_MS: '60000' }, stdio: 'pipe' });
      let out = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      await until(() => out.includes('拿到本机测试槽'));
      return child;
    };
    const slotFiles = () => readdirSync(slotDir).filter((n) => /^slot-\d+\.json$/.test(n));
    /** 自测起的命令到现在吐了什么（经 exec 的 onOutput 看，和自测认标记同一条路）。 */
    const seen = { out: '' };
    const base = localExec();
    const check = (testMs?: number) =>
      createSelfCheck({
        trees: { ownerOf: async () => USER },
        exec: (command) =>
          base({
            ...command,
            onOutput: (chunk) => {
              seen.out += chunk.toString('utf8');
              command.onOutput?.(chunk);
            },
          }),
        slots: openLock,
        fullLock: openLock,
        ...(testMs === undefined ? {} : { testMs }),
      });
    return { dir, tree, command, holder, slotFiles, check, env, script, seen };
  }

  async function until(ok: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error('等太久');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function treeInput(tree: string, command: string): SelfCheckInput {
    return { ...input(command), worktreePath: tree };
  }

  it('两个槽被普通 test:changed 占满：自测排队（心跳写等本机测试槽），一个持有者死了就回收它的槽接着跑完', async () => {
    const s = setup();
    const holders = [await s.holder(), await s.holder()];
    try {
      expect(s.slotFiles()).toHaveLength(2);
      const beats: Record<string, unknown>[] = [];
      const pending = s.check()(treeInput(s.tree, s.command(0)), {
        signal: new AbortController().signal,
        heartbeat: (d) => {
          beats.push(d as Record<string, unknown>);
        },
        attempt: 1,
        lastHeartbeat: undefined,
      });
      await until(() => s.seen.out.includes('本机测试槽满了'));
      expect(beats.at(-1)).toMatchObject({ phase: 'queue', waitingFor: '本机测试槽（test:changed）' });
      expect(beats.some((b) => b.phase === 'test')).toBe(false);
      holders[0]?.kill('SIGKILL');
      const got = await pending;
      expect(got.steps[0]).toMatchObject({ outcome: 'pass', exitCode: 0 });
      expect(got.steps[0]?.digest).toMatch(/回收本机测试槽 slot-\d\.json：持有者进程 \d+ 已经不在/);
      expect(beats.some((b) => b.phase === 'test')).toBe(true);
      // 自测的那个跑完已经还槽；剩下的是活着的那个持有者，和死掉的那个（被回收后不再在）
      expect(s.slotFiles()).toHaveLength(1);
    } finally {
      for (const h of holders) h.kill('SIGKILL');
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('排队时被叫停：当下停掉，不占槽、不写成过了', async () => {
    const s = setup();
    const holders = [await s.holder(), await s.holder()];
    try {
      const ac = new AbortController();
      const beats: Record<string, unknown>[] = [];
      const pending = s.check()(treeInput(s.tree, s.command(0)), {
        signal: ac.signal,
        heartbeat: (d) => {
          beats.push(d as Record<string, unknown>);
        },
        attempt: 1,
        lastHeartbeat: undefined,
      });
      await until(() => s.seen.out.includes('本机测试槽满了'));
      expect(beats.at(-1)).toMatchObject({ phase: 'queue' });
      ac.abort();
      const got = await pending;
      expect(got.state).toBe('skipped');
      expect(got.steps[0]?.outcome).toBe('skipped');
      expect(got.steps[0]?.digest).toContain('被叫停了，没跑完');
      expect(got.steps[0]?.digest).toContain('本机测试槽满了');
      expect(s.slotFiles()).toHaveLength(2);
    } finally {
      for (const h of holders) h.kill('SIGKILL');
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('拿着槽执行超时被杀：槽留在盘上但持有者已死，下一个 test:changed 当下回收', async () => {
    const s = setup();
    try {
      const got = await s.check(800)(treeInput(s.tree, s.command(60_000)), ctx());
      expect(got.steps[0]?.outcome).toBe('skipped');
      expect(got.steps[0]?.digest).toContain('执行超过');
      expect(got.steps[0]?.digest).toContain('拿到本机测试槽');
      expect(s.slotFiles()).toHaveLength(1);
      const next = runChild(process.execPath, [s.script], { env: { ...s.env, HOLD_MS: '0' } });
      expect(next.stdout).toMatch(/回收本机测试槽 slot-0\.json：持有者进程 \d+ 已经不在/);
      expect(next.stdout).toContain('拿到本机测试槽，共等了 0 秒');
      expect(s.slotFiles()).toHaveLength(0);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('digestOutput', () => {
  it('先列像失败的行，再加末尾；去掉颜色码；限长', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `ok line ${i}`);
    lines[10] = '\u001b[31m FAIL x.test.ts > 一\u001b[0m';
    const got = digestOutput(lines.join('\n'));
    expect(got).toContain('FAIL x.test.ts > 一');
    expect(got).not.toContain('\u001b');
    expect(got).toContain('ok line 499');
    expect(got.length).toBeLessThanOrEqual(SELF_CHECK_DIGEST_MAX);
    const huge = digestOutput(
      Array.from({ length: 5000 }, (_, i) => `error ${i} ${'x'.repeat(50)}`).join('\n'),
    );
    expect(huge.length).toBeLessThanOrEqual(SELF_CHECK_DIGEST_MAX);
  });
});
