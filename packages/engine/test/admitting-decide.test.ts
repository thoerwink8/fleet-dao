import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it, vi } from 'vitest';
import { createAdmittingDecide, startAdmissionAlertTransfer } from '../src/decisions/admitting-decide.ts';
import { createDecide } from '../src/decisions/index.ts';
import {
  deniedFailureOf,
  EXECUTION_ADMISSION_DENIED,
  EXECUTION_ADMISSION_UNKNOWN,
} from '../src/execution-admission-failure.ts';
import type { AlertOutcome } from '../src/real/admission-alert-protocol.ts';
import type { LegacySourceAdmission } from '../src/real/execution-legacy-admission.ts';

const RUN = '11111111-2222-4333-8444-555555555555';
const allowed: LegacySourceAdmission = {
  kind: 'allowed',
  status: 'admitted',
  admissionId: RUN,
  postCommitWarnings: [],
};

function setup(
  result: LegacySourceAdmission | Error,
  record?: () => Promise<AlertOutcome>,
  workflowType = 'taskWorkflow',
) {
  const inner = vi.fn(createDecide());
  const admit = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const alert = {
    record: vi.fn(
      record ??
        (async () => ({ kind: 'spooled', key: 'a'.repeat(64), recordHash: 'b'.repeat(64) }) as AlertOutcome),
    ),
  };
  const decide = createAdmittingDecide({ decide: inner as never, admit, alert });
  const env = new MockActivityEnvironment({
    namespace: 'test',
    workflowNamespace: 'test',
    taskQueue: 'q',
    isLocal: true,
    activityType: 'decide',
    workflowType,
    workflowExecution: { workflowId: 'task:example/canary#12', runId: RUN },
  });
  const run = <K extends 'limits' | 'failure'>(kind: K, input: never) =>
    env.run(async () => decide(kind, input as never));
  return { inner, admit, alert, run, env };
}

describe('兼容准入包装的 decide', () => {
  it('放行时 limits 输入输出与不带准入完全相同', async () => {
    const s = setup(allowed);
    const plain = await createDecide()('limits', {});
    expect(await s.run('limits', {} as never)).toEqual(plain);
    expect(s.inner).toHaveBeenCalledWith('limits', {});
    expect(s.alert.record).not.toHaveBeenCalled();
  });

  it('确证拒绝：固定类型、不可重试，不进内层 decide，不报警；判型不看 message', async () => {
    const s = setup({ kind: 'denied', code: 'managed_start_unsupported' });
    const error = await s.run('limits', {} as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationFailure);
    const failure = error as ApplicationFailure;
    expect(failure.type).toBe(EXECUTION_ADMISSION_DENIED);
    expect(failure.nonRetryable).toBe(true);
    expect(failure.details).toEqual(['managed_start_unsupported']);
    expect(deniedFailureOf(failure)).toBe(failure);
    expect(s.inner).not.toHaveBeenCalled();
    expect(s.alert.record).not.toHaveBeenCalled();
    // 同 message 的普通失败、同 type 但可重试的失败都不算确证拒绝。
    expect(deniedFailureOf(new Error(failure.message))).toBeUndefined();
    expect(
      deniedFailureOf(ApplicationFailure.retryable(failure.message, EXECUTION_ADMISSION_DENIED)),
    ).toBeUndefined();
  });

  it('未知：可重试、与拒绝分列，并把身份写进报警承接', async () => {
    const s = setup({ kind: 'unknown', code: 'start_unavailable' });
    const failure = (await s.run('limits', {} as never).catch((e: unknown) => e)) as ApplicationFailure;
    expect(failure.type).toBe(EXECUTION_ADMISSION_UNKNOWN);
    expect(failure.nonRetryable).toBe(false);
    expect(failure.details).toEqual(['start_unavailable', 'recorded']);
    expect(deniedFailureOf(failure)).toBeUndefined();
    expect(s.alert.record).toHaveBeenCalledWith(
      {
        identity: {
          version: 1,
          category: 'legacy_admission_unknown',
          namespace: 'test',
          workflowId: 'task:example/canary#12',
          runId: RUN,
        },
        firstCode: 'start_unavailable',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(s.inner).not.toHaveBeenCalled();
  });

  it.each([
    ['报警写失败', async () => ({ kind: 'unknown', code: 'io' }) as AlertOutcome],
    [
      '报警宿主抛错',
      async (): Promise<AlertOutcome> => {
        throw new Error('boom');
      },
    ],
  ])('%s：如实标 unrecorded，仍是未知而非拒绝或放行', async (_name, record) => {
    const s = setup({ kind: 'unknown', code: 'store_unavailable' }, record);
    const failure = (await s.run('limits', {} as never).catch((e: unknown) => e)) as ApplicationFailure;
    expect(failure.type).toBe(EXECUTION_ADMISSION_UNKNOWN);
    expect(failure.details).toEqual(['store_unavailable', 'unrecorded']);
    expect(s.inner).not.toHaveBeenCalled();
  });

  it('活动真被取消：以 CancelledFailure 结束，不报警不放行；信号没取消时 admit 抛错才按 store_unavailable 未知处理', async () => {
    // 取消发生在 admit 返回 allowed 之后也不放行（信号已取消）。
    const late = setup(allowed);
    const slow = createAdmittingDecide({
      decide: late.inner as never,
      admit: async () => {
        late.env.cancel();
        return allowed;
      },
      alert: late.alert,
    });
    expect(
      await late.env.run(async () => slow('limits', {} as never)).catch((e: unknown) => e),
    ).toBeInstanceOf(CancelledFailure);
    expect(late.inner).not.toHaveBeenCalled();
    const aborted = setup(new Error('x'));
    const throwing = createAdmittingDecide({
      decide: aborted.inner as never,
      admit: async () => {
        aborted.env.cancel();
        throw new Error('connection reset');
      },
      alert: aborted.alert,
    });
    expect(
      await aborted.env.run(async () => throwing('limits', {} as never)).catch((e: unknown) => e),
    ).toBeInstanceOf(CancelledFailure);
    expect(aborted.alert.record).not.toHaveBeenCalled();
    // 码说取消但信号未取消：仍是可重试未知，只是不报警。
    const cancelled = setup({ kind: 'unknown', code: 'cancelled' });
    const a = (await cancelled.run('limits', {} as never).catch((e: unknown) => e)) as ApplicationFailure;
    expect(a.details).toEqual(['cancelled', 'not_needed']);
    expect(a.nonRetryable).toBe(false);
    expect(cancelled.alert.record).not.toHaveBeenCalled();
    const thrown = setup(new Error('x'));
    const b = (await thrown.run('limits', {} as never).catch((e: unknown) => e)) as ApplicationFailure;
    expect(b.type).toBe(EXECUTION_ADMISSION_UNKNOWN);
    expect(b.details).toEqual(['store_unavailable', 'recorded']);
  });

  it('只门 taskWorkflow 的 limits；failure 判断和别的工作流类型不经准入', async () => {
    const other = setup({ kind: 'unknown', code: 'deadline' }, undefined, 'otherWorkflow');
    await other.run('limits', {} as never);
    expect(other.admit).not.toHaveBeenCalled();
    const s = setup({ kind: 'unknown', code: 'deadline' });
    const stub = vi.fn(async () => 'next');
    const gate = createAdmittingDecide({ decide: stub as never, admit: s.admit, alert: s.alert });
    expect(await s.env.run(async () => gate('failure', {} as never))).toBe('next');
    expect(stub).toHaveBeenCalledTimes(1);
    expect(s.admit).not.toHaveBeenCalled();
  });

  it('无 Activity Context 时仍交给 admit（由它 failclosed），不绕过', async () => {
    const admit = vi.fn(
      async (): Promise<LegacySourceAdmission> => ({ kind: 'unknown', code: 'missing_context' }),
    );
    const decide = createAdmittingDecide({
      decide: createDecide(),
      admit,
      alert: { record: async () => ({ kind: 'empty' }) },
    });
    const failure = (await decide('limits', {}).catch((e: unknown) => e)) as ApplicationFailure;
    expect(admit).toHaveBeenCalledTimes(1);
    expect(failure.type).toBe(EXECUTION_ADMISSION_UNKNOWN);
    expect(failure.details).toEqual(['missing_context', 'unrecorded']);
  });
});

describe('未知报警移交循环', () => {
  it('按间隔逐条移交，遇空停止；未知保留原件并记日志；stop 后不再起', async () => {
    vi.useFakeTimers();
    try {
      const outcomes: AlertOutcome[] = [
        { kind: 'transferred', key: 'a'.repeat(64), recordHash: 'b'.repeat(64), notificationId: RUN },
        { kind: 'empty' },
        { kind: 'unknown', code: 'store_unavailable' },
      ];
      const transferOne = vi.fn(async () => outcomes.shift() ?? ({ kind: 'empty' } as AlertOutcome));
      const log = vi.fn();
      const stop = startAdmissionAlertTransfer({ transferOne }, { intervalMs: 1000, log });
      await vi.advanceTimersByTimeAsync(1000);
      expect(transferOne).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(transferOne).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('store_unavailable'));
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(transferOne).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
