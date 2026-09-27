// 任务简报和副手验收的边界表，含故意造出失败的行。
import { describe, expect, it } from 'vitest';
import { decideAcceptance, type OtherBlock } from '../src/acceptance.ts';
import { type Brief, checkBrief, checkParallel, outsideBrief } from '../src/brief.ts';

const good: Brief = {
  goal: '给登录加验证码过期',
  scope: '只改后端，不碰页面',
  constraints: ['不加新依赖'],
  files: ['packages/api/src/auth.ts', 'packages/api/test/'],
  acceptance: ['过期的验证码登录不了', '有一条故意造出失败的测试'],
  returnFormat: '改了哪些文件、测试结果、没做完的',
};

describe('任务简报', () => {
  it('齐全的收', () => {
    expect(checkBrief(good)).toEqual({ ok: true, brief: good });
  });

  it.each([
    ['【失败】缺目标', { ...good, goal: '  ' }, /缺「目标」/],
    ['【失败】没写只许改的文件', { ...good, files: [] }, /缺「只许改的文件」/],
    ['【失败】没写怎么算合格', { ...good, acceptance: [] }, /缺「怎么算合格」/],
    ['【失败】缺交回格式', { ...good, returnFormat: undefined }, /缺「交回格式」/],
    ['【失败】绝对路径', { ...good, files: ['/etc/passwd'] }, /绝对路径/],
    ['【失败】盘符', { ...good, files: ['C:/x.ts'] }, /绝对路径/],
    ['【失败】跳出仓', { ...good, files: ['packages/../../x'] }, /带 \.\./],
    ['【失败】反斜杠', { ...good, files: ['packages\\api\\x.ts'] }, /反斜杠/],
    ['【失败】写了两遍', { ...good, files: ['a.ts', 'a.ts'] }, /写了两遍/],
    ['【失败】不是对象', 'goal: x', /认不出/],
  ])('%s', (_name, input, problem) => {
    const got = checkBrief(input);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join('\n')).toMatch(problem);
  });

  it('不撞文件的三份能同时派', () => {
    const a = { ...good, files: ['packages/api/'] };
    const b = { ...good, files: ['packages/web/src/login.tsx'] };
    const c = { ...good, files: ['docs/design.md'] };
    expect(checkParallel([a, b, c])).toEqual({ ok: true });
  });

  it.each([
    [
      '【失败】两份改同一个文件',
      [good, { ...good, files: ['packages/api/src/auth.ts'] }],
      /都要改「packages\/api\/src\/auth\.ts」/,
    ],
    ['【失败】目录包住文件', [good, { ...good, files: ['packages/api/'] }], /都要改/],
    ['【失败】超过 3 份', [1, 2, 3, 4].map((i) => ({ ...good, files: [`f${i}.ts`] })), /最多 3 个副手/],
  ])('%s', (_name, briefs, problem) => {
    const got = checkParallel(briefs);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join('\n')).toMatch(problem);
  });

  it('只许改的文件：目录下的算，别处不算', () => {
    expect(
      outsideBrief(good, [
        'packages/api/src/auth.ts',
        'packages/api/test/auth.test.ts',
        'packages/api/src/db.ts',
      ]),
    ).toEqual(['packages/api/src/db.ts']);
  });
});

describe('Lead 验收副手', () => {
  const delivered = { changedFiles: ['packages/api/src/auth.ts'], tests: 'green' as const };
  const accept = { verdict: 'accept' as const, why: '看过改动，和简报一致' };
  /** 一张单一块：没有别的块。 */
  const alone: OtherBlock[] = [];
  /** 同一张单里别的块（#252 母单多块时才有）：页面那一块。 */
  const webBlock: OtherBlock[] = [{ block: 'login-form', files: ['packages/web/src/login/'] }];
  /** 简报外、别的块也没认领的两个文件（#246 第 1 轮副手顺手改的那两个）。 */
  const unclaimed = ['docs/ops.md', 'packages/engine/test/hourly-reconcile.test.ts'];
  const withUnclaimed = { ...delivered, changedFiles: [...delivered.changedFiles, ...unclaimed] };

  it('交付齐、测试绿、Lead 收 → 收下，简报外的一个都没有', () => {
    expect(
      decideAcceptance({ brief: good, otherBlocks: alone, delivery: delivered, lead: accept, reworks: 0 }),
    ).toEqual({ decision: 'accept', outside: [] });
  });

  it('#246：简报外的文件没别的块认领、Lead 看过收下 → 收下，结果里列出这些文件好记下来', () => {
    // #246 第 1 轮：副手顺手改了 docs/ops.md 和一个测试，Lead 判收下，却被「简报外一律不收」打回；第 2 轮副手撤了，
    // Lead 又打回要改回来；改动是累计着看的，撤了也照样算简报外，这一块怎么做都过不了，白转两轮等 Lead 接手
    const brief: Brief = {
      ...good,
      goal: '全熔断提醒熔断解了由每小时对账自动撤',
      files: ['packages/engine/src/jobs/alert-sweep.ts', 'packages/engine/test/jobs/'],
    };
    const got = decideAcceptance({
      brief,
      otherBlocks: alone,
      delivery: {
        changedFiles: [
          'packages/engine/src/jobs/alert-sweep.ts',
          'packages/engine/test/jobs/alert.test.ts',
          ...unclaimed,
        ],
        tests: 'green',
      },
      lead: {
        verdict: 'accept',
        why: 'ops.md 跟着改的对账说明、hourly-reconcile 的测试补的是同一条规则，该改',
      },
      reworks: 0,
    });
    expect(got).toEqual({ decision: 'accept', outside: unclaimed });
  });

  it('Lead 打回 → 返工，理由里带上简报外改了哪些（没别的块认领的）', () => {
    const got = decideAcceptance({
      brief: good,
      otherBlocks: alone,
      delivery: withUnclaimed,
      lead: { verdict: 'reject', why: '漏了过期时间的边界' },
      reworks: 1,
    });
    expect(got).toEqual({
      decision: 'rework',
      why: [
        'Lead 打回：漏了过期时间的边界',
        '简报外改了：docs/ops.md、packages/engine/test/hourly-reconcile.test.ts（留不留照 Lead 的理由办）',
      ],
    });
  });

  it('【失败】简报外的文件碰到别的块的简报 → Lead 说收也返工，写明碰了哪块的哪个文件', () => {
    const got = decideAcceptance({
      brief: good,
      otherBlocks: webBlock,
      delivery: {
        ...withUnclaimed,
        changedFiles: [...withUnclaimed.changedFiles, 'packages/web/src/login/form.tsx'],
      },
      lead: accept,
      reworks: 1,
    });
    // 没别的块认领的那两个 Lead 收了，不进理由；碰到别的块的只有 form.tsx
    expect(got).toEqual({
      decision: 'rework',
      why: ['碰了别的块「login-form」的文件：packages/web/src/login/form.tsx（归那一块改，撤回来）'],
    });
  });

  it.each([
    ['【失败】测试红', 'red' as const, '测试没过'],
    ['【失败】没跑成测试不算过', 'not-run' as const, '没跑成测试（没跑不等于过了）'],
  ])('%s：简报外的 Lead 收了也返工，理由只有测试这一条', (_name, tests, reason) => {
    const got = decideAcceptance({
      brief: good,
      otherBlocks: alone,
      delivery: { ...withUnclaimed, tests },
      lead: accept,
      reworks: 1,
    });
    expect(got).toEqual({ decision: 'rework', why: [reason] });
  });

  it.each([
    ['【失败】空交付', { ...delivered, changedFiles: [] }, accept, /空交付/],
    ['【失败】测试红', { ...delivered, tests: 'red' as const }, accept, /测试没过/],
    ['【失败】没跑成测试不算过', { ...delivered, tests: 'not-run' as const }, accept, /没跑成测试/],
    ['Lead 打回', delivered, { verdict: 'reject' as const, why: '漏了过期时间的边界' }, /Lead 打回：漏了/],
  ])('%s → 打回', (_name, delivery, lead, why) => {
    const got = decideAcceptance({ brief: good, otherBlocks: alone, delivery, lead, reworks: 1 });
    expect(got.decision).toBe('rework');
    if (got.decision !== 'accept') expect(got.why.join('\n')).toMatch(why);
  });

  it('打回满 2 次再不行 → Lead 接手', () => {
    const got = decideAcceptance({
      brief: good,
      otherBlocks: alone,
      delivery: { ...delivered, tests: 'red' },
      lead: accept,
      reworks: 2,
    });
    expect(got.decision).toBe('takeover');
  });

  it('【失败】Lead 打回不写理由', () => {
    expect(() =>
      decideAcceptance({
        brief: good,
        otherBlocks: alone,
        delivery: delivered,
        lead: { verdict: 'reject', why: ' ' },
        reworks: 0,
      }),
    ).toThrow(/写理由/);
  });

  it('【失败】打回次数认不出', () => {
    expect(() =>
      decideAcceptance({ brief: good, otherBlocks: alone, delivery: delivered, lead: accept, reworks: -1 }),
    ).toThrow(/认不出/);
  });

  it.each([
    ['没给', undefined],
    ['块名空着', [{ block: ' ', files: ['packages/web/'] }]],
    ['文件不是数组', [{ block: 'login-form', files: 'packages/web/' }]],
  ])('【失败】别的块认不出（%s）：直接报错，不当成没有别的块', (_name, otherBlocks) => {
    expect(() =>
      decideAcceptance({
        brief: good,
        otherBlocks: otherBlocks as unknown as OtherBlock[],
        delivery: delivered,
        lead: accept,
        reworks: 0,
      }),
    ).toThrow(/别的块认不出/);
  });
});
