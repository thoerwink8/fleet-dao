// brief.ts：三份 brief 各自的形状 + 渲染出来的文字带齐该有的节。Verify 必带 diff。

import { describe, expect, it } from 'vitest';
import {
  AnyBriefSchema,
  ManualBriefSchema,
  renderBrief,
  type ScopeBrief,
  ScopeBriefSchema,
  VerifyBriefSchema,
} from '../../src/runner/brief.ts';

describe('Brief schemas', () => {
  it('scope：title / request / acceptance / touches 必填、kind=scope', () => {
    const b: ScopeBrief = {
      kind: 'scope',
      title: '试试',
      request: '要那个',
      acceptance: ['做 A', '做 B'],
      touches: ['packages/engine'],
    };
    expect(ScopeBriefSchema.parse(b)).toEqual(b);
  });

  it('scope：acceptance 至少一条，空数组拒', () => {
    expect(() =>
      ScopeBriefSchema.parse({
        kind: 'scope',
        title: 'x',
        request: 'y',
        acceptance: [],
        touches: [],
      }),
    ).toThrow();
  });

  it('manual：必带 branch / baseSha', () => {
    const b = ManualBriefSchema.parse({
      kind: 'manual',
      title: '动手',
      request: '写代码',
      acceptance: ['1. 写完'],
      touches: ['packages/engine/src/runner/'],
      branch: 'feat/test',
      baseSha: 'a'.repeat(40),
    });
    expect(b.branch).toBe('feat/test');
    expect(b.baseSha).toHaveLength(40);
  });

  it('verify：必带 prNumber / baseSha / headSha / changedFiles / diffText，缺一就拒', () => {
    const base = {
      kind: 'verify' as const,
      title: '验收',
      request: '对',
      acceptance: ['pass'],
      touches: [],
      prNumber: 100,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      changedFiles: ['x.ts'],
      diffText: '@@ -1 +1 @@\n-old\n+new',
    };
    expect(() => VerifyBriefSchema.parse(base)).not.toThrow();
    // prNumber 缺
    const { prNumber: _p, ...noPr } = base;
    expect(() => VerifyBriefSchema.parse(noPr)).toThrow();
    // diffText 缺
    const { diffText: _d, ...noDiff } = base;
    expect(() => VerifyBriefSchema.parse(noDiff)).toThrow();
    // changedFiles 空
    expect(() => VerifyBriefSchema.parse({ ...base, changedFiles: [] })).toThrow();
  });

  it('discriminatedUnion 按 kind 分', () => {
    const scope = AnyBriefSchema.parse({
      kind: 'scope',
      title: 't',
      request: 'r',
      acceptance: ['a'],
      touches: [],
    });
    expect(scope.kind).toBe('scope');
  });
});

describe('renderBrief', () => {
  it('scope：带需求 / 怎么算做完 / 已知的模块，不带分支节', () => {
    const out = renderBrief({
      kind: 'scope',
      title: 'T',
      request: 'R',
      acceptance: ['A1', 'A2'],
      touches: ['packages/x'],
    });
    expect(out).toContain('# 任务：T');
    expect(out).toContain('## 需求');
    expect(out).toContain('1. A1');
    expect(out).toContain('2. A2');
    expect(out).toContain('- packages/x');
    expect(out).not.toContain('## 分支与头');
    expect(out).not.toContain('diff');
  });

  it('manual：带分支 + baseSha', () => {
    const out = renderBrief({
      kind: 'manual',
      title: 'T',
      request: 'R',
      acceptance: ['A'],
      touches: [],
      branch: 'feat/x',
      baseSha: 'c'.repeat(40),
    });
    expect(out).toContain('`feat/x`');
    expect(out).toContain(`\`${'c'.repeat(40)}\``);
  });

  it('verify：必带 diff、改了哪些文件、三种能挡的判法', () => {
    const out = renderBrief({
      kind: 'verify',
      title: 'T',
      request: 'R',
      acceptance: ['A'],
      touches: [],
      prNumber: 42,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      changedFiles: ['x.ts', 'y.ts'],
      diffText: '@@ fake',
    });
    expect(out).toContain('PR：#42');
    expect(out).toContain('- x.ts');
    expect(out).toContain('```diff');
    expect(out).toContain('@@ fake');
    expect(out).toContain('没做到验收条');
    expect(out).toContain('弄坏原有功能');
    expect(out).toContain('安全或丢数据');
    expect(out).toContain('**不许判**');
  });
});
