// 探针退避节奏（#1424）。#1843（#1798 片 8）删了按需探测和只为抠原文存在的函数：
// onDemandDetail、isOnDemandDetail、isDegradedDetail、probeCadenceMinutes、probeNextEveryMinutes、probeBackoffNextAt
// 和它们的断言一起删了（概念没了：按需探测不再有，节奏和疑似换模型改读 routes 上的结构化列）。
import { describe, expect, it } from 'vitest';
import * as pace from '../src/route-probe-pace.ts';
import {
  probeBackoffMinutes,
  probeBackoffNotice,
  probeBackoffPhrase,
  probeFailStreak,
} from '../src/route-probe-pace.ts';

describe('退避', () => {
  it('连着不通 1、2、3、4、5 次：隔 15、30、60、120、240 分钟；不到 1 次按第 1 档，超过封顶', () => {
    expect([1, 2, 3, 4, 5].map(probeBackoffMinutes)).toEqual([15, 30, 60, 120, 240]);
    expect(probeBackoffMinutes(0)).toBe(15);
    expect(probeBackoffMinutes(9)).toBe(240);
  });

  it('退避那句按北京时间写（UTC 01:05 = 北京 09:05），原文里也认得回来', () => {
    const phrase = probeBackoffPhrase(new Date('2026-10-10T01:05:00Z'));
    expect(phrase).toBe('退避中，下次约 09:05 再探');
    expect(probeBackoffNotice(`503 容量满。${phrase}（连着不通 1 次）`)).toBe(phrase);
    expect(probeBackoffNotice('答上了：pong')).toBeNull();
    expect(probeBackoffNotice(null)).toBeNull();
  });

  it('【故意造出的失败】时刻不是有效时间：抛，不写一个编的钟点', () => {
    expect(() => probeBackoffPhrase(new Date(Number.NaN))).toThrow();
  });

  it('原文里的「连着不通 N 次」（引擎老行兜底）；没写次数回 null，不当 0', () => {
    expect(probeFailStreak('没通（连着不通 3 次）')).toBe(3);
    expect(probeFailStreak('网络不通')).toBeNull();
    expect(probeFailStreak(null)).toBeNull();
  });
});

describe('按需探测和抠原文的函数已删（#1843）', () => {
  it('这些导出都不在了', () => {
    for (const name of [
      'ROUTE_PROBE_ON_DEMAND_MARK',
      'onDemandDetail',
      'isOnDemandDetail',
      'isDegradedDetail',
      'probeCadenceMinutes',
      'probeNextEveryMinutes',
      'probeBackoffNextAt',
    ]) {
      expect(pace, name).not.toHaveProperty(name);
    }
  });
});
