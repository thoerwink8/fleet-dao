// 卫生检查只管一个仓（hygiene-scope.ts）：别的仓按它们自己的标准，不套 fleet-dao 这套——认对、认错、认不出
// 三种都造一遍（创始人 2026-10-01 10:50 前后拍：「1-1，但是除了这个仓库，其他仓库不要拦（按照其他仓库自己标准）」）。
import { describe, expect, it } from 'vitest';
import { repoSlug } from '../src/client.ts';
import { guardedByHygiene, HYGIENE_REPO } from '../src/hygiene-scope.ts';
import { assertPublishable } from '../src/publish-check.ts';

// 真的令牌形状：拼起来写，源码里不出现整段（全仓卫生检查会扫这个文件）。
const LEAK = ['ghp', 'yU1zL5aC3Kp9mQ2xR7bN4wT8Zt4wQ9mB'].join('_');
const OTHER = { owner: 'acme', name: 'widgets' };

describe('哪一个仓要过这套卫生检查', () => {
  it('认得出 fleet-dao 这个仓：大小写不算差别', () => {
    expect(guardedByHygiene(HYGIENE_REPO)).toBe(true);
    expect(guardedByHygiene({ owner: 'Thoerwink8', name: 'Fleet-DAO' })).toBe(true);
  });

  it('别的仓不管：owner 一样、仓名不一样也不管', () => {
    expect(guardedByHygiene(OTHER)).toBe(false);
    expect(guardedByHygiene({ owner: HYGIENE_REPO.owner, name: 'fleet-dao-vault' })).toBe(false);
    expect(guardedByHygiene({ owner: 'someone-else', name: HYGIENE_REPO.name })).toBe(false);
  });

  it('【故意造出的失败】认不出是哪个仓：明确报错，不当成别的仓放过去、也不当成 fleet-dao 拦下来', () => {
    for (const bad of [undefined, null, { owner: '', name: 'x' }, { owner: 'x', name: '' }] as const) {
      let caught: unknown;
      try {
        guardedByHygiene(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'HYGIENE_SCOPE_UNKNOWN' });
      expect(String((caught as Error).message)).toContain(repoSlug(HYGIENE_REPO));
    }
  });
});

describe('写东西之前：fleet-dao 拦，别的仓不扫', () => {
  const texts = [{ path: 'PR 正文', text: `顺手把 ${LEAK} 贴进来了` }];

  it('fleet-dao 自己：查出真密钥就拦（HYGIENE_BLOCKED），报错里只有位置、行、规则名，不带那个值', () => {
    let caught: unknown;
    try {
      assertPublishable(HYGIENE_REPO, '开 fleet-dao 上的 PR', texts);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'HYGIENE_BLOCKED', retryable: false });
    const message = String((caught as Error).message);
    expect(message).toContain('令牌');
    expect(message).not.toContain(LEAK);
  });

  it('别的仓：同一段内容不拦、也不扫（没有 findings，一次都不做）', () => {
    expect(() => assertPublishable(OTHER, '开 acme/widgets 上的 PR', texts)).not.toThrow();
    // 干净内容当然也不拦（这条防的是「把不扫实现成乱拦」）
    expect(() =>
      assertPublishable(OTHER, '开 acme/widgets 上的 PR', [{ path: 'PR 正文', text: '干净' }]),
    ).not.toThrow();
  });

  it('【故意造出的失败】认不出是哪个仓：明确报错，不默认放过去', () => {
    expect(() => assertPublishable(undefined as never, '开 PR', texts)).toThrow(
      /HYGIENE_SCOPE_UNKNOWN|认不出/,
    );
  });
});
