import type { SessionUser } from '@fleet-dao/adapters';
import { describe, expect, it, vi } from 'vitest';
import type { PortContext } from '../../src/ports.ts';
import type { UserCommand, UserCommandResult } from '../../src/real/exec.ts';
import { createSelfCheck } from '../../src/real/self-check.ts';
import type { CiTestCoverage, SelfCheckInput } from '../../src/task-contract.ts';
import { selfCheckText } from '../../src/workflows/task-support.ts';
import { freshRepo } from '../helpers.ts';

const head = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const receipt: CiTestCoverage = {
  repo: 'thoerwink8/fleet-dao',
  pr: 12,
  head,
  tree,
  run: 50,
  attempt: 2,
  workflow: 9,
  contractCommit: 'c'.repeat(40),
  contractHash: 'd'.repeat(64),
  checks: ['check', 'changes', 'test (1/1)'],
  ciNodes: ['v22.23.3'],
  node: 'v22.23.2',
};
const commandResult = (code: number, out = ''): UserCommandResult => ({
  code,
  stdout: Buffer.from(out),
  stderr: '',
  aborted: false,
  timedOut: false,
});
const identity = `${head}\n${tree}\nv22.23.2\n11.28.2\n5.0.1\n`;
function rig(
  options: {
    dirtyAt?: number;
    mutateTsc?: boolean;
    failTsc?: boolean;
    cancelRead?: boolean;
    cancelTsc?: boolean;
    errorAt?: number;
    invalidateCiDuringTsc?: boolean;
    dirtyDuringFinalRead?: boolean;
    cancelFinalRead?: boolean;
    changedFinalAttempt?: boolean;
    noCoverage?: boolean;
  } = {},
) {
  const ac = new AbortController();
  const context: PortContext = { signal: ac.signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined };
  let probes = 0;
  let tests = 0;
  let typed = 0;
  let ciPolluted = false;
  const commands: UserCommand[] = [];
  const coverage = vi.fn(async () => {
    if (options.cancelRead) ac.abort();
    if (typed > 0) {
      if (options.cancelFinalRead) ac.abort();
      if (options.dirtyDuringFinalRead) ciPolluted = true;
      if (options.invalidateCiDuringTsc) return null;
      if (options.changedFinalAttempt) return { ...receipt, attempt: 3 };
    }
    return options.noCoverage ? null : receipt;
  });
  const check = createSelfCheck({
    trees: { ownerOf: async () => 'fleet-agent-1' as SessionUser },
    ciCoverage: coverage,
    slots: { acquire: async () => () => {} },
    fullLock: { acquire: async () => () => {} },
    exec: async (command) => {
      commands.push(command);
      const s = command.argv[2] ?? '';
      if (s.includes('git_safe()')) {
        probes++;
        if (options.errorAt === probes) throw new Error('git probe unavailable');
        return options.dirtyAt === probes || (options.mutateTsc && typed > 0) || ciPolluted
          ? commandResult(1)
          : commandResult(0, identity);
      }
      if (s.includes('test -d node_modules') || s.includes('test -f tsconfig.json'))
        return commandResult(0, 'yes\n');
      if (s.includes('tsc -b')) {
        typed++;
        if (options.cancelTsc) ac.abort();
        return commandResult(options.failTsc ? 1 : 0, options.failTsc ? 'error TS2322: wrong' : '');
      }
      tests++;
      return commandResult(0, 'Tests 3 passed (3)');
    },
  });
  const input: SelfCheckInput = {
    schemaVersion: 1,
    taskId: 'ci-cover',
    repo: { ...freshRepo(), owner: 'thoerwink8', name: 'fleet-dao', testCommand: 'pnpm test:changed' },
    worktreePath: '/work/ci-cover',
    expectedHead: head,
    prNumber: 12,
  };
  return { check, input, context, coverage, commands, counts: () => ({ probes, tests, typed }) };
}

describe('selfCheck 必经口的 CI 覆盖', () => {
  it('已有PR同成果免重复源码测试，仍本机tsc；回执与摘要都不冒充本机PASS', async () => {
    const f = rig();
    const result = await f.check(f.input, f.context);
    expect(f.counts()).toEqual({ probes: 3, tests: 0, typed: 1 });
    expect(result.state).toBe('green');
    expect(result.steps.map((s) => s.outcome)).toEqual(['skipped', 'pass']);
    expect(result.steps[0]?.coveredByCi).toEqual(receipt);
    const text = selfCheckText(result);
    expect(text).toContain('CI 已覆盖，未重复本机执行（不计本机 PASS）');
    expect(text).toContain(`head=${head} tree=${tree}`);
    expect(text).not.toContain('测试没有结果');
    expect(
      f.commands
        .filter((c) => (c.argv[2] ?? '').includes('git_safe()'))
        .every((c) => String(c.user) === 'fleet-agent-1'),
    ).toBe(true);
  });
  it.each([1, 2])('第%d次身份检查失败：不复用，原测试与tsc实跑', async (dirtyAt) => {
    const f = rig({ dirtyAt });
    const result = await f.check(f.input, f.context);
    expect(f.counts().tests).toBe(1);
    expect(f.counts().typed).toBe(1);
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it('tsc期间污染树：最终返回前撤覆盖，重回本机检查，不让已有失败被重试覆盖', async () => {
    const f = rig({ mutateTsc: true, failTsc: true });
    const result = await f.check(f.input, f.context);
    expect(f.counts().tests).toBe(1);
    expect(f.counts().typed).toBe(2);
    expect(result.state).toBe('red');
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it('CI查不到回原测试', async () => {
    const f = rig({ noCoverage: true });
    const result = await f.check(f.input, f.context);
    expect(f.counts().tests).toBe(1);
    expect(result.steps[0]?.outcome).toBe('pass');
  });
  it('最终身份读取报错也回本机检查，不保留未经最终复核的覆盖', async () => {
    const f = rig({ errorAt: 3 });
    const result = await f.check(f.input, f.context);
    expect(f.counts().tests).toBe(1);
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it.each([false, true])('tsc期间最新CI失效：撤回覆盖回原检查，保留已知失败=%s', async (failTsc) => {
    const f = rig({ invalidateCiDuringTsc: true, failTsc });
    const result = await f.check(f.input, f.context);
    expect(f.coverage).toHaveBeenCalledTimes(2);
    expect(f.counts().tests).toBe(1);
    expect(result.state).toBe(failTsc ? 'red' : 'green');
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it('最后CI读取期间污染：其后仍核本地身份并回原检查', async () => {
    const f = rig({ dirtyDuringFinalRead: true });
    const result = await f.check(f.input, f.context);
    expect(f.counts().tests).toBe(1);
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it('最终CI换attempt，即使新attempt也绿，仍保守回原检查', async () => {
    const f = rig({ changedFinalAttempt: true });
    const result = await f.check(f.input, f.context);
    expect(f.counts().tests).toBe(1);
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it('最终CI读取时取消撤证据，不开始原测试', async () => {
    const f = rig({ cancelFinalRead: true });
    const result = await f.check(f.input, f.context);
    expect(result.state).toBe('skipped');
    expect(f.counts().tests).toBe(0);
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it('本机tsc期间取消：撤掉覆盖字段及覆盖摘要，不留下假的采纳回执', async () => {
    const f = rig({ cancelTsc: true });
    const result = await f.check(f.input, f.context);
    expect(result.state).toBe('skipped');
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
    expect(result.steps[0]?.digest).toBe('被叫停了，未采纳 CI 覆盖证据');
  });
  it('查证期间取消不能留下CI覆盖或开始测试', async () => {
    const f = rig({ cancelRead: true });
    const result = await f.check(f.input, f.context);
    expect(result.state).toBe('skipped');
    expect(f.counts().tests).toBe(0);
    expect(result.steps.every((s) => s.coveredByCi === undefined)).toBe(true);
  });
  it('旧历史缺输入不取证，仍跑原检查', async () => {
    const f = rig();
    delete f.input.expectedHead;
    delete f.input.prNumber;
    await f.check(f.input, f.context);
    expect(f.coverage).not.toHaveBeenCalled();
    expect(f.counts()).toEqual({ probes: 0, tests: 1, typed: 1 });
  });
  it.each(['pnpm test:changed --affected', 'pnpm test:changed && pnpm smoke', 'pnpm check'])(
    '自定义命令%s不做自然语言猜测，原样实跑',
    async (command) => {
      const f = rig();
      f.input.repo.testCommand = command;
      await f.check(f.input, f.context);
      expect(f.coverage).not.toHaveBeenCalled();
      expect(f.counts().tests).toBe(1);
    },
  );
});
