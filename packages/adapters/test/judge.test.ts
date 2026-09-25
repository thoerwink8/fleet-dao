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

  it('优先级：进程没起来 > 起没起来没查成 > 我们杀的 > 额度用满 > 没终帧 > 终帧报错 > 退出码 > 中转没查成 > 交付', () => {
    const cases: [RunFacts, string][] = [
      [{ ...clean, spawnError: 'ENOENT', launchUnknown: '没等到应答', killed: 'aborted' }, 'spawn_failed'],
      [{ ...clean, launchUnknown: '没等到应答', killed: 'aborted' }, 'launch_unknown'],
      [{ ...clean, killed: 'wall_clock_timeout', quotaExhausted: true }, 'wall_clock_timeout'],
      [{ exitCode: 1, signal: null, quotaExhausted: true }, 'quota_exhausted'],
      [{ exitCode: 0, signal: null, quotaExhausted: false, relayUnknown: '账本没读成' }, 'no_result'],
      [{ ...clean, exitCode: 1, terminal: { isError: true, detail: 'api_error · HTTP 404' } }, 'agent_error'],
      [{ ...clean, exitCode: 2, relayUnknown: '账本没读成' }, 'exit_nonzero'],
      [{ ...clean, relayUnknown: '账本没读成' }, 'relay_unknown'],
    ];
    for (const [facts, reason] of cases) {
      expect(judgeRun(facts, delivery('delivered')).reason).toBe(reason);
    }
  });

  it('中转没查成、起没起来没查成：判失败但原因单列（该重查 / 先对账），不混进执行体失败', () => {
    expect(judgeRun({ ...clean, relayUnknown: '没给账本目录' })).toEqual({
      outcome: 'failed',
      reason: 'relay_unknown',
      detail: '中转没查成：没给账本目录',
    });
    expect(judgeRun({ quotaExhausted: false, launchUnknown: '起会话没查成：别重发' })).toEqual({
      outcome: 'failed',
      reason: 'launch_unknown',
      detail: '起会话没查成：别重发',
    });
  });

  it('额度用满但终帧说成功：以终帧为准（读数只是顺带的）', () => {
    expect(judgeRun({ ...clean, quotaExhausted: true }).outcome).toBe('ok');
  });

  it('叫停算 stopped，停滞算 stalled，其余被杀算 failed', () => {
    expect(judgeRun({ ...clean, killed: 'aborted' }).outcome).toBe('stopped');
    expect(judgeRun({ ...clean, killed: 'idle_timeout' }).outcome).toBe('stalled');
    expect(judgeRun({ ...clean, killed: 'model_mismatch' }).outcome).toBe('failed');
  });

  it('跑完才看出的模型 / 会话不一致：判失败，写明点名的和实际的；排在被杀之后、额度之前', () => {
    const facts: RunFacts = {
      ...clean,
      mismatch: { kind: 'model', expected: 'grok-4.6', observed: 'grok-4.7-build' },
    };
    expect(judgeRun(facts, delivery('delivered'))).toEqual({
      outcome: 'failed',
      reason: 'model_mismatch',
      detail: '实际回话的模型不是点名的那个：点名 grok-4.6，实际 grok-4.7-build',
    });
    expect(judgeRun({ ...facts, killed: 'aborted' }).reason).toBe('aborted');
    expect(
      judgeRun({
        ...facts,
        mismatch: { kind: 'session', expected: 'a', observed: 'b' },
        quotaExhausted: true,
      }).reason,
    ).toBe('session_mismatch');
  });

  it('不是进程的插头（Mirasim、接口外壳）：没有退出码也能判，没终帧时说「会话结束」并带上最后的原话', () => {
    expect(judgeRun({ terminal: { isError: false, detail: 'done' }, quotaExhausted: false }).outcome).toBe(
      'ok',
    );
    const verdict = judgeRun({ quotaExhausted: false, lastWords: '读状态的连接建不起来' });
    expect(verdict).toEqual({
      outcome: 'failed',
      reason: 'no_result',
      detail: '会话结束，没有终帧：读状态的连接建不起来',
    });
    expect(
      judgeRun({ exitCode: 1, signal: null, quotaExhausted: false, lastWords: 'Failed to reach the API' })
        .detail,
    ).toBe('进程退出（退出码 1），没有终帧：Failed to reach the API');
  });

  it('被信号杀掉时写明信号', () => {
    expect(judgeRun({ exitCode: null, signal: 'SIGKILL', quotaExhausted: false }).detail).toContain(
      'SIGKILL',
    );
  });
});
