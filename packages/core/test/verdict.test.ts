// 开 PR 前验证结论的边界表：只三种能挡，其余当建议；认不出的一律作废，不当成过了。
import { describe, expect, it } from 'vitest';
import { decideVerdict, type VerdictInput } from '../src/verdict.ts';

const HEAD = 'abc1234def';
const criteria = ['过期的验证码登录不了', '有一条故意造出失败的测试'];
const allDone = {
  head: HEAD,
  results: criteria.map((criterion) => ({ criterion, answer: 'done', evidence: 'auth.test.ts 第 40 行' })),
  findings: [] as unknown[],
};
const input = (patch: Partial<VerdictInput> = {}): VerdictInput => ({
  criteria,
  sentHead: HEAD,
  report: allDone,
  verifierFamily: 'gpt',
  authorFamilies: ['claude'],
  rebuttals: [],
  ...patch,
});

describe('开 PR 前验证结论', () => {
  it('逐条做到 → 过', () => {
    expect(decideVerdict(input())).toEqual({ verdict: 'pass', notes: [], rebutted: [] });
  });

  it('没做到一条 → 挡', () => {
    const report = {
      ...allDone,
      results: [{ ...allDone.results[0], answer: 'not-done' }, allDone.results[1]],
    };
    const got = decideVerdict(input({ report }));
    expect(got.verdict).toBe('block');
    if (got.verdict === 'block') expect(got.reasons[0]).toMatch(/没做到：过期的验证码登录不了/);
  });

  it.each([
    ['弄坏原有功能', 'breaks-existing', /弄坏了原有功能/],
    ['安全', 'security', /安全/],
    ['丢数据', 'data-loss', /丢数据/],
  ])('有证据的「%s」→ 挡', (_name, kind, reason) => {
    const report = { ...allDone, findings: [{ kind, text: '注册接口 500', evidence: '跑了 e2e' }] };
    const got = decideVerdict(input({ report }));
    expect(got.verdict).toBe('block');
    if (got.verdict === 'block') expect(got.reasons[0]).toMatch(reason);
  });

  it('看不出、建议 → 不挡，写进 PR 当备注', () => {
    const report = {
      ...allDone,
      results: [{ ...allDone.results[0], answer: 'unclear', evidence: '没找到相关测试' }, allDone.results[1]],
      findings: [{ kind: 'suggestion', text: '变量名可以更清楚', evidence: 'auth.ts 第 12 行' }],
    };
    const got = decideVerdict(input({ report }));
    expect(got.verdict).toBe('pass');
    if (got.verdict === 'pass') expect(got.notes).toHaveLength(2);
  });

  it('Lead 拿证据驳回 → 不挡，记下驳回了哪条', () => {
    const report = { ...allDone, findings: [{ kind: 'security', text: '密钥写进日志', evidence: 'log.ts' }] };
    const got = decideVerdict(
      input({
        report,
        rebuttals: [{ target: '密钥写进日志', evidence: 'log.ts 第 8 行打的是密钥编号不是值' }],
      }),
    );
    expect(got).toEqual({ verdict: 'pass', notes: [], rebutted: ['密钥写进日志'] });
  });

  it.each([
    ['同族验证', input({ verifierFamily: 'Claude' }), /同一族/],
    ['没写验证模型族', input({ verifierFamily: ' ' }), /哪一族/],
    ['单子没有怎么算做完', input({ criteria: [] }), /没有「怎么算做完」/],
    ['交回的不是对象', input({ report: '全部做到' }), /认不出/],
    [
      '没带证据',
      input({ report: { ...allDone, results: allDone.results.map((r) => ({ ...r, evidence: '' })) } }),
      /认不出/,
    ],
    ['审的不是送检的头', input({ report: { ...allDone, head: 'fffffff0000' } }), /不是送检的头/],
    ['漏答一条', input({ report: { ...allDone, results: [allDone.results[0]] } }), /没答/],
    [
      '答了清单外的',
      input({
        report: {
          ...allDone,
          results: [...allDone.results, { criterion: '顺手改了 UI', answer: 'done', evidence: 'x' }],
        },
      }),
      /清单外/,
    ],
    [
      '一条答两遍',
      input({ report: { ...allDone, results: [...allDone.results, allDone.results[0]] } }),
      /答了两遍/,
    ],
    ['驳回不存在的意见', input({ rebuttals: [{ target: '没有这条', evidence: 'x' }] }), /不是一条能挡的意见/],
  ])('【失败】%s → 作废', (_name, given, why) => {
    const got = decideVerdict(given);
    expect(got.verdict).toBe('invalid');
    if (got.verdict === 'invalid') expect(got.why).toMatch(why);
  });

  it('【失败】驳回不带证据 → 作废', () => {
    const report = { ...allDone, findings: [{ kind: 'security', text: '密钥写进日志', evidence: 'log.ts' }] };
    const got = decideVerdict(input({ report, rebuttals: [{ target: '密钥写进日志', evidence: ' ' }] }));
    expect(got.verdict).toBe('invalid');
  });
});
