import { describe, expect, it } from 'vitest';
import type { DeliveryCheck } from '../src/delivery.ts';
import { judgeRun, type RunFacts } from '../src/judge.ts';

const clean: RunFacts = {
  exitCode: 0,
  signal: null,
  terminal: { isError: false, detail: 'completed' },
  quotaExhausted: false,
};
const delivery = (state: DeliveryCheck['state']): DeliveryCheck => ({
  state,
  target: 'refs/remotes/origin/main',
  detail: state,
});

describe('judgeRun', () => {
  it('不要求交付的活：终帧没错、退出 0 就算完成', () => {
    expect(judgeRun(clean)).toMatchObject({ outcome: 'ok', reason: 'answered' });
  });

  it('要交付的活只认交付：说完成了但没交付算失败，没查成单独一类', () => {
    expect(judgeRun(clean, delivery('delivered'))).toMatchObject({ outcome: 'ok', reason: 'delivered' });
    expect(judgeRun(clean, delivery('not_delivered'))).toMatchObject({
      outcome: 'failed',
      reason: 'not_delivered',
    });
    expect(judgeRun(clean, delivery('unknown'))).toMatchObject({
      outcome: 'failed',
      reason: 'delivery_unknown',
    });
  });

  it('优先级：进程没起来 > 我们杀的 > 额度用满 > 没终帧 > 终帧报错 > 退出码 > 交付', () => {
    const cases: [RunFacts, string][] = [
      [{ ...clean, spawnError: 'ENOENT', killed: 'aborted' }, 'spawn_failed'],
      [{ ...clean, killed: 'wall_clock_timeout', quotaExhausted: true }, 'wall_clock_timeout'],
      [{ exitCode: 1, signal: null, quotaExhausted: true }, 'quota_exhausted'],
      [{ exitCode: 0, signal: null, quotaExhausted: false }, 'no_result'],
      [{ ...clean, exitCode: 1, terminal: { isError: true, detail: 'api_error · HTTP 404' } }, 'agent_error'],
      [{ ...clean, exitCode: 2 }, 'exit_nonzero'],
    ];
    for (const [facts, reason] of cases) {
      expect(judgeRun(facts, delivery('delivered')).reason).toBe(reason);
    }
  });

  it('额度用满但终帧说成功：以终帧为准（读数只是顺带的）', () => {
    expect(judgeRun({ ...clean, quotaExhausted: true }).outcome).toBe('ok');
  });

  it('叫停算 stopped，停滞算 stalled，其余被杀算 failed', () => {
    expect(judgeRun({ ...clean, killed: 'aborted' }).outcome).toBe('stopped');
    expect(judgeRun({ ...clean, killed: 'idle_timeout' }).outcome).toBe('stalled');
    expect(judgeRun({ ...clean, killed: 'model_mismatch' }).outcome).toBe('failed');
  });

  it('被信号杀掉时写明信号', () => {
    expect(judgeRun({ exitCode: null, signal: 'SIGKILL', quotaExhausted: false }).detail).toContain(
      'SIGKILL',
    );
  });
});
