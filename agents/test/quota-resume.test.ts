import { describe, expect, it } from 'vitest';
import { verdict } from '../hooks/quota-resume.mjs';

const t = (s: string) => Date.parse(`${s}+08:00`);
const at = '2026-10-27T02:00:00+08:00';

describe('verdict', () => {
  it('限流停 5 分钟后续', () => {
    const row = { at, error: 'rate_limit' };
    expect(verdict(row, {}, t('2026-10-27T02:03:00'))).toBe('wait');
    expect(verdict(row, {}, t('2026-10-27T02:06:00'))).toBe('resume');
  });
  it('额度停下：拼车开了新窗口、挂独享、或过 5 小时才续', () => {
    const row = { at, error: 'rate_limit', error_details: 'usage limit reached' };
    expect(verdict(row, { lastProbeAt: t('2026-10-27T01:00:00') }, t('2026-10-27T03:00:00'))).toBe('wait');
    expect(verdict(row, { lastProbeAt: t('2026-10-27T05:30:00') }, t('2026-10-27T05:31:00'))).toBe('resume');
    expect(verdict(row, { org: 'solo' }, t('2026-10-27T02:30:00'))).toBe('resume');
    expect(verdict(row, {}, t('2026-10-27T07:01:00'))).toBe('resume');
  });
  it('超过 24 小时不续', () => {
    expect(verdict({ at, error: 'rate_limit' }, {}, t('2026-10-28T03:00:00'))).toBe('expire');
  });
});
