// 任务简报和副手验收的边界表，含故意造出失败的行。
import { describe, expect, it } from 'vitest';
import { decideAcceptance } from '../src/acceptance.ts';
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
  const accept = { verdict: 'accept' as const, why: '' };

  it('交付齐、测试绿、Lead 收 → 收下', () => {
    expect(decideAcceptance({ brief: good, delivery: delivered, lead: accept, reworks: 0 })).toEqual({
      decision: 'accept',
    });
  });

  it.each([
    ['【失败】空交付', { ...delivered, changedFiles: [] }, accept, /空交付/],
    [
      '【失败】改了简报外的文件',
      { ...delivered, changedFiles: ['packages/web/x.tsx'] },
      accept,
      /简报外的文件/,
    ],
    ['【失败】测试红', { ...delivered, tests: 'red' as const }, accept, /测试没过/],
    ['【失败】没跑成测试不算过', { ...delivered, tests: 'not-run' as const }, accept, /没跑成测试/],
    ['Lead 打回', delivered, { verdict: 'reject' as const, why: '漏了过期时间的边界' }, /Lead 打回：漏了/],
  ])('%s → 打回', (_name, delivery, lead, why) => {
    const got = decideAcceptance({ brief: good, delivery, lead, reworks: 1 });
    expect(got.decision).toBe('rework');
    if (got.decision !== 'accept') expect(got.why.join('\n')).toMatch(why);
  });

  it('打回满 2 次再不行 → Lead 接手', () => {
    const got = decideAcceptance({
      brief: good,
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
        delivery: delivered,
        lead: { verdict: 'reject', why: ' ' },
        reworks: 0,
      }),
    ).toThrow(/写理由/);
  });

  it('【失败】打回次数认不出', () => {
    expect(() => decideAcceptance({ brief: good, delivery: delivered, lead: accept, reworks: -1 })).toThrow(
      /认不出/,
    );
  });
});
