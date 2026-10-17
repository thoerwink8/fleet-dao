import { describe, expect, it } from 'vitest';
import {
  checkColdVerify,
  checkSecurityBase,
  coldVerifyFrom,
  coldVerifyNeed,
  DESCRIPTION_MAX,
  SECURITY_BASE_CONTEXT,
  securityBaseFrom,
  statusDescription,
} from '../src/merge-gates.ts';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

describe('合前验收（cold-verify）状态', () => {
  const status = (state: string, description = '') => ({ context: 'cold-verify', state, description });

  it('从当前头的状态里挑出 cold-verify；没有就是 null', () => {
    expect(coldVerifyFrom([{ context: 'ci', state: 'success' }, status('success', '通过')])).toEqual({
      state: 'success',
      description: '通过',
    });
    expect(coldVerifyFrom([{ context: 'ci', state: 'success' }])).toBeNull();
    // 已经去掉的 second-opinion 不再被认
    expect(coldVerifyFrom([{ context: 'second-opinion', state: 'success' }])).toBeNull();
  });

  it('故意认不出的：没有 context、state 不认得，说为什么', () => {
    expect(coldVerifyFrom([{ state: 'success' }])).toBe('提交状态里有一条认不出（没有 context）');
    expect(coldVerifyFrom([status('ok')])).toBe('cold-verify 的 state「ok」认不出');
  });

  it('只有引擎任务 PR 要验；要验的：通过不报，没有、还在跑、没过各报一句', () => {
    expect(coldVerifyNeed(false)).toEqual({ needed: false, why: '' });
    expect(coldVerifyNeed(true, 'off')).toEqual({ needed: false, why: '' });
    expect(coldVerifyNeed(false, 'off')).toEqual({ needed: false, why: '' });
    const need = coldVerifyNeed(true);
    expect(need.needed).toBe(true);
    expect(checkColdVerify(HEAD, null, coldVerifyNeed(false))).toEqual([]);
    expect(checkColdVerify(HEAD, { state: 'success', description: '' }, need)).toEqual([]);
    expect(checkColdVerify(HEAD, null, need)[0]).toMatch(/^还没验：当前头 aaaaaaa 上没有 cold-verify 状态/);
    expect(checkColdVerify(HEAD, { state: 'pending', description: '' }, need)[0]).toMatch(/^等验收：/);
    expect(checkColdVerify(HEAD, { state: 'failure', description: '有一条没做' }, need)[0]).toMatch(
      /^验收没过：.* 是 failure：有一条没做/,
    );
    expect(checkColdVerify(HEAD, { state: 'error', description: '' }, need)[0]).toMatch(/^验收没过/);
  });
});

describe('安全基前置要你拍（security-base-approved，决定 0106）', () => {
  const approve = (state: string, description = '') => ({
    context: SECURITY_BASE_CONTEXT,
    state,
    description,
  });

  it('从当前头的状态里挑出这一条；没有就是 null', () => {
    expect(
      securityBaseFrom([{ context: 'cold-verify', state: 'success' }, approve('success', '拍了')]),
    ).toEqual({ state: 'success', description: '拍了' });
    expect(securityBaseFrom([{ context: 'cold-verify', state: 'success' }])).toBeNull();
    expect(securityBaseFrom([{ context: 'second-opinion', state: 'success' }])).toBeNull();
  });

  it('故意认不出的：没有 context、state 不认得，说为什么', () => {
    expect(securityBaseFrom([{ state: 'success' }])).toBe('提交状态里有一条认不出（没有 context）');
    expect(securityBaseFrom([approve('ok')])).toBe('security-base-approved 的 state「ok」认不出');
  });

  it('判法只有三条：没拍（null）、拍成 success、拍成别的（pending / failure / error）', () => {
    expect(checkSecurityBase(HEAD, null)[0]).toMatch(/^前置要你拍：/);
    expect(checkSecurityBase(HEAD, null)[0]).toContain(SECURITY_BASE_CONTEXT);
    expect(checkSecurityBase(HEAD, { state: 'success', description: '' })).toEqual([]);
    expect(checkSecurityBase(HEAD, { state: 'pending', description: '' })[0]).toMatch(
      /^前置要你拍：.*是 pending/,
    );
    expect(checkSecurityBase(HEAD, { state: 'failure', description: '' })[0]).toMatch(
      /^前置要你拍：.*是 failure/,
    );
    expect(checkSecurityBase(HEAD, { state: 'error', description: '' })[0]).toMatch(
      /^前置要你拍：.*是 error/,
    );
  });

  it('SHA 换了旧 SHA 上拍过的不算：闸读的是当前头，看不到旧头上的状态，重新要拍', () => {
    // 旧 HEAD 上有 success（解决了）；对当前 NEXT 上还是 null，闸看不到旧那条就判没拍
    expect(checkSecurityBase(NEXT, null)[0]).toMatch(/推了新提交的/);
    expect(checkSecurityBase(HEAD, { state: 'success', description: '' })).toEqual([]);
  });
});

describe('状态说明', () => {
  it('放第一条，多的写另有几条；再长也不超过 GitHub 的 140 个字符', () => {
    expect(statusDescription(['还没验。'])).toBe('还没验。');
    expect(statusDescription(['还没验。', '等验收。'])).toBe('还没验。（另有 1 条，点详情看）');
    const long = statusDescription(['很'.repeat(300), '第二条']);
    expect([...long].length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(long).toMatch(/…（另有 1 条，点详情看）$/);
  });
});
