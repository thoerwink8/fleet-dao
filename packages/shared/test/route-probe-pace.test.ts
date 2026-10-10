// 按需探测的结论原文和认法（#1635）：固定那一句 + 上一次真探的结果和北京时间时刻；没真探过的写「还没真探过」，不编。
import { describe, expect, it } from 'vitest';
import {
  isOnDemandDetail,
  onDemandDetail,
  probeCadenceMinutes,
  ROUTE_PROBE_PRIMARY_NOTE,
} from '../src/route-probe-pace.ts';

describe('按需探测的原文', () => {
  it('上一次真探通：写通和北京时间时刻（UTC 01:05 = 北京 09:05）', () => {
    const text = onDemandDetail({ state: 'ok', at: new Date('2026-10-10T01:05:00Z'), detail: '答上了：OK' });
    expect(text).toBe('不主动探，要派给它时先探一次。上一次真探：通，10-10 09:05（答上了：OK）');
    expect(isOnDemandDetail(text)).toBe(true);
  });
  it('上一次不通：写不通和原因', () => {
    const text = onDemandDetail({
      state: 'failed',
      at: new Date('2026-10-10T01:05:00Z'),
      detail: '网络不通',
    });
    expect(text).toContain('上一次真探：不通，10-10 09:05');
    expect(text).toContain('网络不通');
  });
  it('没有上一次、或上一次没真探（skipped）：写还没真探过，不编时刻', () => {
    expect(onDemandDetail(null)).toBe('不主动探，要派给它时先探一次。还没真探过');
    expect(onDemandDetail({ state: 'skipped', at: new Date(), detail: '渠道已下架' })).toContain(
      '还没真探过',
    );
  });
  it('【故意造出的失败】时刻不是有效时间：抛，不写一个编的钟点', () => {
    expect(() => onDemandDetail({ state: 'ok', at: new Date(Number.NaN), detail: null })).toThrow();
  });
  it('不是按需的原文认不出来', () => {
    expect(isOnDemandDetail('答上了：OK')).toBe(false);
    expect(isOnDemandDetail(null)).toBe(false);
  });
});

describe('前 2 位隔 30 分钟的间隔', () => {
  it('结论写了前 2 位隔 30 分钟：按 30；本来更久的执行方式取更长的', () => {
    const detail = `答上了：OK。${ROUTE_PROBE_PRIMARY_NOTE}`;
    expect(probeCadenceMinutes('claude-code', detail)).toBe(30);
    expect(probeCadenceMinutes('cursor-agent', detail)).toBe(120);
    expect(probeCadenceMinutes('claude-code', '答上了：OK')).toBe(15);
  });
});
