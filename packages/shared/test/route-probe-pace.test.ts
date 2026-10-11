// 按需探测的结论原文和认法（#1635）：固定那一句 + 上一次真探的结果和北京时间时刻；没真探过的写「还没真探过」，不编。
import { describe, expect, it } from 'vitest';
import {
  isDegradedDetail,
  isOnDemandDetail,
  onDemandDetail,
  probeCadenceMinutes,
  ROUTE_PROBE_PRIMARY_NOTE,
} from '../src/route-probe-pace.ts';

describe('疑似换成旧模型 / 疑似降智的原文（#1748、#1798）', () => {
  it('不通的结论直接以「疑似降智」或「疑似换成旧模型」起头：认', () => {
    expect(isDegradedDetail('疑似降智：题 17 乘 23，应为 391，实答 381')).toBe(true);
    expect(isDegradedDetail('疑似换成旧模型：题 日本首相，新答案应为 高市早苗，实答 石破茂')).toBe(true);
  });
  it('按需探测接手后，上一次真探是疑似降智：也认（路由页、渠道状态页不能只写按需）', () => {
    const text = onDemandDetail({
      state: 'failed',
      at: new Date('2026-10-10T01:05:00Z'),
      detail: '疑似降智：题 17 乘 23，应为 391，实答 381',
    });
    expect(isOnDemandDetail(text)).toBe(true);
    expect(isDegradedDetail(text)).toBe(true);
  });
  it('上一次真探是通的、普通不通、没真探过、空：不认', () => {
    expect(isDegradedDetail(onDemandDetail({ state: 'ok', at: new Date(), detail: '答上了：OK' }))).toBe(
      false,
    );
    expect(isDegradedDetail(onDemandDetail({ state: 'failed', at: new Date(), detail: '网络不通' }))).toBe(
      false,
    );
    expect(isDegradedDetail(onDemandDetail(null))).toBe(false);
    expect(isDegradedDetail('答上了：OK · 降智检测通过（17*23=391）')).toBe(false);
    expect(isDegradedDetail(null)).toBe(false);
    expect(isDegradedDetail(undefined)).toBe(false);
  });
});

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
