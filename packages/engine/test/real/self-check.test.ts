// 引擎自测（selfCheck，决定 0093）：以树主人的身份跑仓的测试命令和 tsc；精炼输出；没跑成回 skipped 不抛。
// test:changed 退出 3（要全跑）时不把测试推给 CI：在整机锁下改跑受影响的包，超时记没过。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import type { RepoWithProfile } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { PortContext } from '../../src/ports.ts';
import type { UserCommand, UserCommandResult } from '../../src/real/exec.ts';
import {
  createAffectedLock,
  createSelfCheck,
  digestOutput,
  SELF_CHECK_TEST_MS,
  type SelfCheckFullLock,
} from '../../src/real/self-check.ts';
import { SELF_CHECK_DIGEST_MAX, type SelfCheckInput } from '../../src/task-contract.ts';
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
  testMs?: number;
}) {
  const commands: UserCommand[] = [];
  const check = createSelfCheck({
    trees: { ownerOf: async () => (over.owner === undefined ? USER : over.owner) },
    ...(over.testMs === undefined ? {} : { testMs: over.testMs }),
    fullLock: over.lock ?? openLock,
    exec: async (command) => {
      commands.push(command);
      const script = command.argv[2] ?? '';
      if (script.includes('test -d node_modules')) return result(0, over.deps ?? 'yes\n');
      if (script.includes('test -f tsconfig.json')) return result(0, over.hasTsc ?? 'yes\n');
      if (script.includes('tsc -b')) return (over.tsc ?? (() => result(0, '')))();
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
    expect(affected?.timeoutMs).toBeLessThanOrEqual(SELF_CHECK_TEST_MS);
    expect(affected?.timeoutMs).toBeGreaterThan(SELF_CHECK_TEST_MS - 5_000);
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
    expect(affected?.timeoutMs).toBeLessThan(5_000);
    expect(got.steps[1]).toMatchObject({ outcome: 'pass' });
    expect(got.state).toBe('green');
  });

  it('要全跑之后受影响的包超时：记自测超时，没过', async () => {
    const ran = rig({
      test: () => result(3, '要全跑'),
      affected: () => result(null, '还在跑', { timedOut: true }),
    });
    const ranOut = await ran.check(input(), ctx());
    expect(ranOut.steps[1]).toMatchObject({ outcome: 'fail', exitCode: null, digest: '自测超时' });
    expect(ranOut.state).toBe('red');

    // 锁一直被占，排队到时限：同样记没过，不跳过、也不当成过了
    const queued = rig({
      test: () => result(3, '要全跑'),
      testMs: 80,
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
    expect(waited.steps[1]).toMatchObject({ outcome: 'fail', digest: '自测超时' });
    expect(waited.state).toBe('red');
    expect(queued.commands.some((c) => scriptOf(c).includes('--affected'))).toBe(false);
  });

  it('超时：记没跑（慢不等于错），不算红', async () => {
    const { check } = rig({ test: () => result(null, '', { timedOut: true }) });
    const got = await check(input(), ctx());
    expect(got.steps[0]?.outcome).toBe('skipped');
    expect(got.steps[0]?.digest).toContain('没跑完');
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
