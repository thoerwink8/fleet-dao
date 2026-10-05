import { describe, expect, it } from 'vitest';
import {
  claimedCommandResult,
  commandKey,
  commandTarget,
  judgeExistingCommand,
  tookOverResult,
} from '../src/command-logic.ts';

const OLD = '2026-01-01T00:00:00.000Z';
const CUTOFF = '2026-01-01T00:10:00.000Z';
const FRESH = '2026-01-01T00:20:00.000Z';

describe('fleet 命令幂等键共用判断', () => {
  it('键和目标的写法', () => {
    expect(commandKey('r1', 'k1')).toBe('fleet:r1:k1');
    expect(commandTarget('r1')).toBe('run:r1');
  });

  it('别的命令占着：other-action（先于「做完」和「过期」判）', () => {
    expect(
      judgeExistingCommand({ action: 'a', claimedAt: OLD, completed: true, result: 1 }, 'b', CUTOFF),
    ).toEqual({
      status: 'other-action',
      action: 'a',
    });
  });

  it('做完了：done 带当时的结果；结果是 undefined 也照回', () => {
    expect(
      judgeExistingCommand({ action: 'a', claimedAt: OLD, completed: true, result: { ok: 1 } }, 'a', CUTOFF),
    ).toEqual({ status: 'done', result: { ok: 1 } });
    expect(judgeExistingCommand({ action: 'a', claimedAt: OLD, completed: true }, 'a', CUTOFF)).toEqual({
      status: 'done',
      result: undefined,
    });
  });

  it('没做完：占用早于 takeOverBefore 才接管；等于或晚于都是 in-flight', () => {
    expect(judgeExistingCommand({ action: 'a', claimedAt: OLD, completed: false }, 'a', CUTOFF)).toEqual({
      status: 'take-over',
    });
    expect(judgeExistingCommand({ action: 'a', claimedAt: CUTOFF, completed: false }, 'a', CUTOFF)).toEqual({
      status: 'in-flight',
      claimedAt: CUTOFF,
    });
    expect(judgeExistingCommand({ action: 'a', claimedAt: FRESH, completed: false }, 'a', CUTOFF)).toEqual({
      status: 'in-flight',
      claimedAt: FRESH,
    });
  });

  it('时刻写法不同（带不带毫秒）按时刻比，不按字面比', () => {
    expect(
      judgeExistingCommand({ action: 'a', claimedAt: '2026-01-01T00:09:59Z', completed: false }, 'a', CUTOFF)
        .status,
    ).toBe('take-over');
  });

  it('接管、新占的返回形状：新占没有 tookOver 字段', () => {
    expect(claimedCommandResult('t')).toEqual({ status: 'claimed', token: 't' });
    expect('tookOver' in claimedCommandResult('t')).toBe(false);
    expect(tookOverResult('t')).toEqual({ status: 'claimed', token: 't', tookOver: true });
  });
});
