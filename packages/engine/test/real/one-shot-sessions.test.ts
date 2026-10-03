// 三段一次性会话的登记（real/one-shot-sessions.ts，#59）：切号照它停下跑在带组织类型的池上的那一段、等它们都收场。
import { describe, expect, it } from 'vitest';
import { oneShotSessions } from '../../src/real/one-shot-sessions.ts';

const pools = (...ids: string[]) => new Set(ids);

describe('oneShotSessions：一段从定了路由起登记，收场走', () => {
  it('还没起会话的用登记号认，起了会话换成 runs 的编号；只看问到的池', () => {
    const reg = oneShotSessions();
    const a = reg.enter({ poolId: 'claude-carpool' });
    const b = reg.enter({ poolId: 'relay' });
    expect(reg.live(pools('claude-carpool'))).toEqual(['one-shot-1']);
    a.attempt('run-a');
    expect(reg.live(pools('claude-carpool', 'claude-solo'))).toEqual(['run-a']);
    expect(reg.live(pools('relay'))).toEqual(['one-shot-2']);
    b.leave();
    expect(reg.live(pools('relay'))).toEqual([]);
  });

  it('stop：只停问到的池上的，信号带着为什么；已经叫停的不重复叫停；收场之后不在 live 里', () => {
    const reg = oneShotSessions();
    const car = reg.enter({ poolId: 'claude-carpool' });
    car.attempt('run-car');
    const other = reg.enter({ poolId: 'relay' });
    expect(reg.stop(pools('claude-carpool', 'claude-solo'), '切号：拼车切到独享')).toEqual(['run-car']);
    expect(car.signal.aborted).toBe(true);
    expect((car.signal.reason as Error).message).toBe('切号：拼车切到独享');
    expect(other.signal.aborted).toBe(false);
    // 再叫一遍：已经在停的不算这一次叫停的，但没收场就还在 live 里（切号要等它收场）
    expect(reg.stop(pools('claude-carpool'), '又一次')).toEqual([]);
    expect(reg.live(pools('claude-carpool'))).toEqual(['run-car']);
    car.leave();
    car.leave();
    expect(reg.live(pools('claude-carpool'))).toEqual([]);
  });
});
