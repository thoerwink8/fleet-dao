// 账密错误怎么说：登录页（loginErrorText）和设置页（credentialFailure）。
// 要钉住：密码错、锁了、请求太频繁、读不到后端、后端出错是五句不同的话；锁到几点读不懂就不编时刻；
// 设置页的错按 details.field 落到栏，认不出的 field 不乱落（落成整体错误）。
import { describe, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { credentialFailure, loginErrorText } from './credentials';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const IN_14_MIN = '2026-10-04T12:14:00.000Z';

describe('loginErrorText', () => {
  test('五种情形五句不同的话', () => {
    const texts = [
      loginErrorText(new ApiError(401, 'bad_credentials', '用户名或密码不对'), NOW),
      loginErrorText(new ApiError(429, 'locked', '锁了', { until: IN_14_MIN }), NOW),
      loginErrorText(new ApiError(429, 'whatever', '慢点'), NOW),
      loginErrorText(new ApiError(0, 'network', '连不上后端：Failed to fetch'), NOW),
      loginErrorText(new ApiError(502, 'bad_gateway', '网关错'), NOW),
    ];
    expect(new Set(texts).size).toBe(5);
    expect(texts[0]).toContain('用户名或密码不对');
    expect(texts[1]).toContain('14 分钟后');
    expect(texts[2]).toContain('请求太频繁');
    expect(texts[3]).toContain('不是密码的问题');
    expect(texts[4]).toContain('后端出错了（502）');
  });

  test('【故意造出的失败】账号不存在和密码错是同一句：不透露账号在不在', () => {
    // 后端对「没这个人」「没设过密码」「密码错」都回 bad_credentials；前端只认 code，说同一句
    const a = loginErrorText(new ApiError(401, 'bad_credentials', '用户名或密码不对'), NOW);
    const b = loginErrorText(new ApiError(401, 'bad_credentials', '后端换了句话也不影响我们'), NOW);
    expect(a).toBe(b);
    expect(a).not.toMatch(/不存在|没有这个|未注册|没设过/);
  });

  test.each([
    ['缺 until', undefined],
    ['until 不是时间', { until: '过一会' }],
    ['until 已经过了', { until: '2026-10-04T11:00:00.000Z' }],
    ['details 不是对象', 'x'],
  ])('【故意造出的失败】锁了但%s：不编时刻，只说过一会儿', (_name, details) => {
    expect(loginErrorText(new ApiError(429, 'locked', '锁了', details), NOW)).toBe(
      '输错次数太多，已临时锁住，请过一会儿再试。',
    );
  });

  test('不是 ApiError 的异常：原样给出信息，不冒充成密码错', () => {
    expect(loginErrorText(new Error('boom'), NOW)).toBe('boom');
    expect(loginErrorText('str', NOW)).toBe('str');
  });
});

describe('credentialFailure', () => {
  test.each([
    ['username', 'invalid_username'],
    ['newPassword', 'weak_password'],
    ['currentPassword', 'bad_current_password'],
  ] as const)('details.field=%s 落到对应的栏，话是后端的原话', (field, code) => {
    expect(credentialFailure(new ApiError(400, code, '后端的话', { field }), NOW)).toEqual({
      field,
      message: '后端的话',
    });
  });

  test('【故意造出的失败】field 认不出或没给：落成整体错误，不乱落到某一栏', () => {
    expect(credentialFailure(new ApiError(400, 'x', '话', { field: 'email' }), NOW).field).toBeUndefined();
    expect(credentialFailure(new ApiError(400, 'x', '话'), NOW).field).toBeUndefined();
    expect(credentialFailure(new ApiError(403, 'recent_feishu_login_required', '要先飞书登录'), NOW)).toEqual(
      {
        field: undefined,
        message: '要先飞书登录',
      },
    );
  });

  test('锁了：整体错误，带几分钟后；读不到后端：说没有保存', () => {
    const locked = credentialFailure(new ApiError(429, 'locked', '锁了', { until: IN_14_MIN }), NOW);
    expect(locked.field).toBeUndefined();
    expect(locked.message).toContain('14 分钟后');
    const net = credentialFailure(new ApiError(0, 'network', '连不上'), NOW);
    expect(net.message).toContain('没有保存');
  });
});
