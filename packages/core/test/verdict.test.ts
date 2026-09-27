// 开 PR 前验证结论的边界表：只三种能挡，其余当建议；认不出的一律作废，不当成过了。
import { describe, expect, it } from 'vitest';
import {
  checkReport,
  decideVerdict,
  type VerdictInput,
  type VerifiedRound,
  verificationLines,
} from '../src/verdict.ts';

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

describe('作废了该谁改', () => {
  it.each([
    ['同族', input({ verifierFamily: 'claude' }), 'setup'],
    ['没写验证模型族', input({ verifierFamily: '' }), 'setup'],
    ['单子没有怎么算做完', input({ criteria: [] }), 'setup'],
    ['交回的认不出', input({ report: '全部做到' }), 'verifier'],
    ['审的不是送检的头', input({ report: { ...allDone, head: 'fffffff0000' } }), 'verifier'],
    ['漏答一条', input({ report: { ...allDone, results: [allDone.results[0]] } }), 'verifier'],
    ['驳回不存在的意见', input({ rebuttals: [{ target: '没有这条', evidence: 'x' }] }), 'lead'],
  ])('%s → %s', (_name, given, fault) => {
    const got = decideVerdict(given);
    expect(got.verdict).toBe('invalid');
    if (got.verdict === 'invalid') expect(got.fault).toBe(fault);
  });
});

describe('交回的这一份本身对不对（会话端口读结论文件时先挡一道，和 decideVerdict 同一个判法）', () => {
  it('对的：原样交回解析好的', () => {
    const got = checkReport(allDone, criteria, HEAD);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.report.results).toHaveLength(2);
  });

  it.each([
    ['认不出', { head: HEAD }, /认不出/],
    ['审的不是送检的头', { ...allDone, head: 'abc1234' }, /不是送检的头/],
    [
      '一条没带证据',
      { ...allDone, results: [{ ...allDone.results[0], evidence: ' ' }, allDone.results[1]] },
      /认不出/,
    ],
    [
      '答了清单外的',
      {
        ...allDone,
        results: [...allDone.results, { criterion: '别的', answer: 'done', evidence: 'x' }],
      },
      /清单外/,
    ],
  ])('【失败】%s', (_name, report, why) => {
    const got = checkReport(report, criteria, HEAD);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(why);
  });

  it('【失败】没有「怎么算做完」也不算对（不拿空清单放过去）', () => {
    const got = checkReport({ head: HEAD, results: [], findings: [] }, [], HEAD);
    expect(got.ok).toBe(false);
  });
});

describe('验证结论写成 PR 正文', () => {
  const round1: VerifiedRound = {
    round: 1,
    verifier: 'Kimi k3（kimi 族）',
    criteria: 2,
    rebuttals: [{ target: '密钥写进日志', evidence: 'log.ts 第 8 行打的是密钥编号不是值' }],
    final: {
      verdict: 'block',
      reasons: ['没做到：过期的验证码登录不了（证据：没有测试）'],
      notes: [],
      rebutted: ['密钥写进日志'],
    },
  };
  const round2: VerifiedRound = {
    round: 2,
    verifier: 'Kimi k3（kimi 族）',
    criteria: 2,
    rebuttals: [],
    final: { verdict: 'pass', notes: ['建议：变量名可以更清楚（证据：auth.ts 第 12 行）'], rebutted: [] },
  };

  it('每轮一行、驳回各一行带证据，最后一轮的建议进「还欠什么」', () => {
    expect(verificationLines([round1, round2])).toEqual({
      verified: [
        '开 PR 前别家验证第 1 轮（Kimi k3（kimi 族））：挡，逐条核了 2 条「怎么算做完」，Lead 拿证据驳回 1 条，挡在 1 条：没做到：过期的验证码登录不了（证据：没有测试）',
        '第 1 轮 Lead 驳回「密钥写进日志」：log.ts 第 8 行打的是密钥编号不是值',
        '开 PR 前别家验证第 2 轮（Kimi k3（kimi 族））：过，逐条核了 2 条「怎么算做完」',
      ],
      owed: ['验证建议：变量名可以更清楚（证据：auth.ts 第 12 行）'],
    });
  });

  it('【失败】一轮都没有：明说没有记录，不空着', () => {
    expect(verificationLines([])).toEqual({ verified: ['开 PR 前别家验证：没有记录'], owed: [] });
  });
});
