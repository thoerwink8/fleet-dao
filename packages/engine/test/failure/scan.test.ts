// 从原文里提取结构化信号：只提取、不判断。状态码只在有上下文时认，等待时间读不出就是没有，不编。
import { describe, expect, it } from 'vitest';
import { embeddedCodes, scanEvidence, statusFromText, waitFromText } from '../../src/failure/scan.ts';

describe('状态码', () => {
  it('有「状态码」上下文的才认', () => {
    const cases: [string, number | undefined][] = [
      ['API Error: 422 平台服务当前繁忙', 422],
      ['HTTP 422: Validation Failed', 422],
      ['gh: Resource not accessible by integration (HTTP 403)', 403],
      ['unexpected status 403: {"error":{}}', 403],
      ['{"code":"account_banned","status":403}', 403],
      ['503 status code (no body)', 503],
      ['429 rate_limit_error', 429],
      ['403: Internal error during token generation', 403],
      // 数字不是状态码的不认。
      ['no progress for 361s', undefined],
      ['gpt-5.6-terra 当前可用容量已满', undefined],
      ['ETIMEDOUT (2636ms, timeout 2000ms)', undefined],
      ['Exit code 143', undefined],
      ['listening on port 4316', undefined],
    ];
    expect(cases.map(([text]) => statusFromText(text))).toEqual(cases.map(([, status]) => status));
  });

  it('证据里给了状态码就用给的', () => {
    expect(scanEvidence({ httpStatus: 529, message: 'HTTP 500' }).status).toBe(529);
  });
});

describe('原文里嵌着的码', () => {
  it('JSON 的 code / error、errorCode=、[命令行:码]、蛇形标识都认，统一小写', () => {
    expect(embeddedCodes('{"error":{"code":"account_banned","status":403}}')).toContain('account_banned');
    expect(embeddedCodes('status=400 errorCode=non_cc_client')).toContain('non_cc_client');
    expect(embeddedCodes('[claude-code:unrecognized_model] x')).toContain('unrecognized_model');
    expect(embeddedCodes('429 Insufficient_Quota')).toContain('insufficient_quota');
    expect(embeddedCodes('socket hang up')).toEqual([]);
  });
});

describe('上游写明的等待', () => {
  const now = Date.parse('2026-09-25T00:00:00.000Z');
  it('Retry-After、中文「约 N 分钟后」、英文 in / after N、ISO 时刻', () => {
    expect(waitFromText('Retry-After: 30')).toBe(30);
    expect(waitFromText('拼车 5 小时额度已用完，约 20 分钟后重置')).toBe(1200);
    expect(waitFromText('quota exceeded, try again in 3 hours')).toBe(10_800);
    expect(waitFromText('retry after 45 seconds')).toBe(45);
    expect(waitFromText('usage limit reached, resets at 2026-09-25T02:00:00Z', now)).toBe(7200);
    expect(waitFromText('resets at 2026-09-24T02:00:00Z', now)).toBe(0);
  });

  it('读不出就是没有：「5 小时额度」「每分钟」不是等待时间；ISO 时刻没给现在也算不出', () => {
    expect(waitFromText('拼车 5 小时额度已用完')).toBeUndefined();
    expect(waitFromText('触发限流：每分钟额度已满，请稍后再试')).toBeUndefined();
    expect(waitFromText('resets at 2026-09-25T02:00:00Z')).toBeUndefined();
    expect(waitFromText('socket hang up')).toBeUndefined();
  });
});
