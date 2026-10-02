import { describe, expect, it } from 'vitest';
import { classifyPullRequestClosed, RELEASE_BRANCH_RE } from '../src/publish.ts';

describe('classifyPullRequestClosed：release.yml 的入口过滤', () => {
  it('合到 main、head 分支是 release/v<N> → proceed，版本号从分支名里提出来', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'release/v7', baseRef: 'main' });
    expect(r).toEqual({ kind: 'proceed', headBranch: 'release/v7', version: 'v7' });
  });

  it('没合（merged=false）→ noop：发布 PR 关上了不算发一版，不算错', () => {
    const r = classifyPullRequestClosed({ merged: false, headRef: 'release/v7', baseRef: 'main' });
    expect(r.kind).toBe('noop');
    if (r.kind === 'noop') expect(r.why).toMatch(/没合/);
  });

  it('分支不是 release/v<N> → error：明确失败，不悄悄跑', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'feat/fix-something', baseRef: 'main' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/release\/v<N>/);
  });

  it('head 是 release/ 但版本号模样不对 → error', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'release/vNext', baseRef: 'main' });
    expect(r.kind).toBe('error');
  });

  it('base 不是 main（合到了别处）→ error：发布一律合到 main', () => {
    const r = classifyPullRequestClosed({ merged: true, headRef: 'release/v7', baseRef: 'develop' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/base 不是 main/);
  });

  it('RELEASE_BRANCH_RE 只认刚好 v<数字>：release/v1、release/v123 通；release-v1、release/v1-beta、release/v 不通', () => {
    expect(RELEASE_BRANCH_RE.test('release/v1')).toBe(true);
    expect(RELEASE_BRANCH_RE.test('release/v123')).toBe(true);
    expect(RELEASE_BRANCH_RE.test('release-v1')).toBe(false);
    expect(RELEASE_BRANCH_RE.test('release/v1-beta')).toBe(false);
    expect(RELEASE_BRANCH_RE.test('release/v')).toBe(false);
    expect(RELEASE_BRANCH_RE.test('release/v1/extra')).toBe(false);
  });
});
