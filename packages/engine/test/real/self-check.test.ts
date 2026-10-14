// 引擎自测（selfCheck，决定 0093）：以树主人的身份跑仓的测试命令和 tsc；精炼输出；没跑成回 skipped 不抛。

import type { SessionUser } from '@fleet-dao/adapters';
import { describe, expect, it } from 'vitest';
import type { PortContext } from '../../src/ports.ts';
import type { UserCommand, UserCommandResult } from '../../src/real/exec.ts';
import { createSelfCheck, digestOutput } from '../../src/real/self-check.ts';
import { SELF_CHECK_DIGEST_MAX, type SelfCheckInput } from '../../src/task-contract.ts';
import { freshRepo } from '../helpers.ts';

const USER = 'fleet-agent-1' as SessionUser;

function ctx(): PortContext {
  return { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, lastHeartbeat: undefined };
}

function result(code: number | null, out = '', over: Partial<UserCommandResult> = {}): UserCommandResult {
  return { code, stdout: Buffer.from(out), stderr: '', timedOut: false, aborted: false, ...over };
}

function input(testCommand = 'pnpm test:changed'): SelfCheckInput {
  return {
    schemaVersion: 1,
    taskId: 't-1',
    repo: { ...freshRepo(), testCommand },
    worktreePath: '/work/t-1',
  };
}

/** 按脚本里的那一段（node_modules 探测 / tsc 探测 / 测试 / tsc）回结果，记下每条命令。 */
function rig(over: {
  deps?: string;
  hasTsc?: string;
  test?: () => UserCommandResult;
  tsc?: () => UserCommandResult;
  owner?: SessionUser | null;
}) {
  const commands: UserCommand[] = [];
  const check = createSelfCheck({
    trees: { ownerOf: async () => (over.owner === undefined ? USER : over.owner) },
    exec: async (command) => {
      commands.push(command);
      const script = command.argv[2] ?? '';
      if (script.includes('test -d node_modules')) return result(0, over.deps ?? 'yes\n');
      if (script.includes('test -f tsconfig.json')) return result(0, over.hasTsc ?? 'yes\n');
      if (script.includes('tsc -b')) return (over.tsc ?? (() => result(0, '')))();
      return (over.test ?? (() => result(0, 'Tests  3 passed (3)')))();
    },
  });
  return { check, commands };
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
    expect(test?.argv[2]).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
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

  it('test:changed 退出 3（要全跑交给 CI）、退出 2（没算成）：记没跑，不算红', async () => {
    for (const code of [2, 3]) {
      const { check } = rig({ test: () => result(code, '要全跑') });
      const got = await check(input(), ctx());
      expect(got.steps[0]).toMatchObject({ outcome: 'skipped', exitCode: code });
      expect(got.state).toBe('green'); // tsc 过了
    }
  });

  it('超时：记没跑（慢不等于错），不算红', async () => {
    const { check } = rig({ test: () => result(null, '', { timedOut: true }) });
    const got = await check(input(), ctx());
    expect(got.steps[0]?.outcome).toBe('skipped');
    expect(got.steps[0]?.digest).toContain('没跑完');
    expect(got.state).toBe('green');
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
