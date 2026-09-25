// 会话的活怎么交代、交回来的东西怎么认：提示词里有该有的，交错了的明确认成交错了（不补默认值、不猜）。
import { describe, expect, it } from 'vitest';
import type { SessionBrief } from '../../src/ports.ts';
import {
  OUT_DIR,
  outputKindOf,
  parseDoc,
  parsePlan,
  parseRequirementDoc,
  parseReview,
  parseTriage,
  stagePrompt,
} from '../../src/real/prompts.ts';
import { planLineOf } from '../../src/real/spec-doc.ts';

const repo = { owner: 'acme', name: 'widgets', defaultBranch: 'main', testCommand: 'pnpm check' };
/** 检出副本里的 docs/plan.md（和 conventions 的测试同一个样子）。 */
const PLAN = '# 计划\n\n### P1 核心闭环\n\n- 工作流：需求、子任务。\n';
const brief = (over: Partial<SessionBrief> = {}): SessionBrief => ({
  title: '登录页加验证码',
  request: '给登录页加手机验证码',
  acceptance: ['验证码 5 分钟过期'],
  touches: ['src/login/'],
  feedback: [],
  answers: [],
  ...over,
});

describe('阶段 → 交回什么', () => {
  it('分诊交分诊结论、需求文档交文档、方案交方案、审查交审查意见、写码交活；判断题不起会话', () => {
    expect(
      ['triage', 'spec', 'plan', 'review', 'execute', 'ui'].map((s) => outputKindOf(s as never)),
    ).toEqual(['triage', 'doc', 'plan', 'review', 'delivery', 'delivery']);
    expect(() => outputKindOf('judge')).toThrow('不起会话');
  });
});

describe('提示词', () => {
  it('新会话：任务、做完标准、会改的地方、怎么汇报、怎么交都写上；写码的交法是 fleet done', () => {
    const text = stagePrompt({
      stage: 'execute',
      brief: brief({ branch: 'fleet/12-login' }),
      repo,
      issueNumber: 12,
      mode: 'new',
    });
    for (const part of [
      'acme/widgets',
      '#12',
      '验证码 5 分钟过期',
      'src/login/',
      'fleet/12-login',
      'pnpm check',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).toContain('fleet done');
    expect(text).toContain('fleet blocked');
    expect(text).toContain('不 push');
  });

  it('非写码阶段：结论写进 .fleet-out 下的文件，不用 fleet done', () => {
    for (const [stage, file] of [
      ['triage', 'triage.json'],
      ['spec', 'doc.md'],
      ['plan', 'plan.json'],
      ['review', 'review.json'],
    ] as const) {
      const text = stagePrompt({
        stage,
        brief: brief({ prNumber: 31, head: 'abc' }),
        repo,
        issueNumber: 12,
        mode: 'new',
      });
      expect(text).toContain(`${OUT_DIR}/${file}`);
      expect(text).toContain('不用 fleet done');
    }
  });

  it('续会话：只补新东西（返工意见、回答、上一轮的问题），不重复整份任务', () => {
    const text = stagePrompt({
      stage: 'execute',
      brief: brief({
        feedback: [{ kind: 'hygiene', summary: '卫生检查拦下', items: ['config/app.env:3 github-token'] }],
        answers: [{ question: '要不要短信？', answer: '要' }],
      }),
      repo,
      issueNumber: 12,
      mode: 'resume',
      previousProblem: '说做完了，但没交付',
    });
    expect(text.startsWith('接着干')).toBe(true);
    expect(text).toContain('config/app.env:3 github-token');
    expect(text).toContain('要不要短信？');
    expect(text).toContain('说做完了，但没交付');
    expect(text).not.toContain('给登录页加手机验证码');
  });

  it('接力：新会话 + 前一个会话做到哪（步骤、进度、已提交的），写明已提交的不重做', () => {
    const text = stagePrompt({
      stage: 'execute',
      brief: brief(),
      repo,
      issueNumber: 12,
      mode: 'relay',
      relay: {
        steps: [{ title: '写测试', state: 'done' }],
        says: ['正在写过期逻辑'],
        commits: ['abc1234 加验证码表'],
        diffstat: [' 2 files changed'],
        why: '拼车号额度用满',
      },
    });
    for (const part of [
      '已提交的不重做',
      '[done] 写测试',
      '正在写过期逻辑',
      'abc1234 加验证码表',
      '拼车号额度用满',
    ]) {
      expect(text).toContain(part);
    }
  });
});

describe('认交回来的东西', () => {
  it('分诊：合法的认出来；形状不对、说不清却没写要问的，都明确算交错了', () => {
    expect(
      parseTriage('{"clear":true,"summary":"理解为：加验证码","size":"S","ui":false,"holds":[]}'),
    ).toEqual({
      ok: { clear: true, summary: '理解为：加验证码', size: 'S', ui: false, holds: [] },
    });
    expect(parseTriage('{"clear":null}')).toEqual({ ok: { clear: null } });
    expect(parseTriage('不是 JSON')).toMatchObject({ error: expect.stringContaining('不是合法的 JSON') });
    expect(parseTriage('{"clear":"yes"}')).toMatchObject({ error: expect.stringContaining('clear') });
    expect(parseTriage('{"clear":false}')).toMatchObject({ error: expect.stringContaining('question') });
    expect(parseTriage('{"clear":true,"size":"XL"}')).toMatchObject({
      error: expect.stringContaining('size'),
    });
    expect(parseTriage('[]')).toMatchObject({ error: expect.stringContaining('对象') });
  });

  it('文档：空的、太长的都算交错了', () => {
    expect(parseDoc('# 需求\n要验证码')).toEqual({ ok: '# 需求\n要验证码' });
    expect(parseDoc('  \n')).toMatchObject({ error: expect.stringContaining('空的') });
    expect(parseDoc('x'.repeat(200_001))).toMatchObject({ error: expect.stringContaining('太长') });
  });

  it('需求文档：还要有「对应计划：」那一行（开 PR 照它填），缺了、空着、骨架没填都算交错了', () => {
    const ok = '# 需求\n\n对应计划：plan.md P1「工作流」\n\n要验证码';
    expect(parseRequirementDoc(ok, PLAN)).toEqual({ ok });
    expect(parseRequirementDoc('# 需求\n要验证码', PLAN)).toMatchObject({
      error: expect.stringContaining('没有「对应计划：」那一行'),
    });
    expect(parseRequirementDoc('# 需求\n对应计划：  \n', PLAN)).toMatchObject({
      error: expect.stringContaining('后面是空的'),
    });
    expect(parseRequirementDoc('# 需求\n对应计划：plan.md P1「」\n', PLAN)).toMatchObject({
      error: expect.stringContaining('引号是空的'),
    });
    // 空的、太长的照旧先拦
    expect(parseRequirementDoc('  \n', PLAN)).toMatchObject({ error: expect.stringContaining('空的') });
  });

  it('需求文档的「对应计划」要对得上仓里的 plan.md（和 PR 上的 pr-fields 同一套判法）；仓里没有 plan.md 只认「无」', () => {
    // 条目在 plan.md 里找不到、只写了阶段没写哪一条：都退回去（开出来的 PR 这一栏会红，会话改不了正文）
    expect(parseRequirementDoc('# 需求\n对应计划：plan.md P1「没有这一条」\n', PLAN)).toMatchObject({
      error: expect.stringContaining('找不到'),
    });
    expect(parseRequirementDoc('# 需求\n对应计划：plan.md P1 的工作流\n', PLAN)).toMatchObject({
      error: expect.stringContaining('没写是哪一条'),
    });
    expect(parseRequirementDoc('# 需求\n对应计划：无\n', PLAN)).toMatchObject({
      error: expect.stringContaining('认不出'),
    });
    // 仓里没有 plan.md：写「无」就收；瞎凑一条不收
    expect(parseRequirementDoc('# 需求\n对应计划：无\n', undefined)).toEqual({
      ok: '# 需求\n对应计划：无\n',
    });
    expect(parseRequirementDoc('# 需求\n对应计划：P1「工作流」\n', undefined)).toMatchObject({
      error: expect.stringContaining('仓里没有'),
    });
  });

  it('「对应计划」那一行：取第一行，半角冒号、行首空白都认；仓里没有 plan.md 写「无」也算写了', () => {
    expect(planLineOf('对应计划：plan.md P0 的验收（「你好」工作流）\n对应计划：P6「规则」')).toEqual({
      ok: 'plan.md P0 的验收（「你好」工作流）',
    });
    expect(planLineOf('  对应计划: P2「驾驶舱」')).toEqual({ ok: 'P2「驾驶舱」' });
    expect(planLineOf('对应计划：无')).toEqual({ ok: '无' });
    // 第一行空着就是空着，不往下找别的
    expect(planLineOf('对应计划：\n对应计划：P1「工作流」')).toMatchObject({ error: expect.any(String) });
    // 正文里提到「对应计划」这个词不算那一行
    expect(planLineOf('PR 正文的对应计划一栏照它写')).toMatchObject({ error: expect.any(String) });
  });

  it('写需求文档的提示词里交代了「对应计划」那一行', () => {
    const prompt = stagePrompt({ stage: 'spec', brief: brief(), repo, issueNumber: 12, mode: 'new' });
    expect(prompt).toContain('对应计划：plan.md P<阶段>');
  });

  it('方案：子任务清单逐条核对形状（深的校验在 decide 的 validatePlan）', () => {
    const ok = parsePlan(
      '# 方案',
      '[{"key":"a","title":"做 A","touches":["src/a"],"stage":"execute","risk":"low","holds":["spend"]}]',
    );
    expect(ok).toEqual({
      ok: {
        markdown: '# 方案',
        subtasks: [
          { key: 'a', title: '做 A', touches: ['src/a'], stage: 'execute', risk: 'low', holds: ['spend'] },
        ],
      },
    });
    expect(parsePlan('# 方案', '[]')).toMatchObject({ error: expect.stringContaining('一个子任务都没有') });
    expect(parsePlan('# 方案', '{}')).toMatchObject({ error: expect.stringContaining('数组') });
    expect(parsePlan('# 方案', '[{"title":"没 key"}]')).toMatchObject({
      error: expect.stringContaining('缺 key'),
    });
    expect(parsePlan('# 方案', '[{"key":"a","title":"x","touches":"src"}]')).toMatchObject({
      error: expect.stringContaining('touches'),
    });
    expect(parsePlan('# 方案', '[{"key":"a","title":"x","stage":"deploy"}]')).toMatchObject({
      error: expect.stringContaining('stage'),
    });
    expect(parsePlan('', '[{"key":"a","title":"x"}]')).toMatchObject({
      error: expect.stringContaining('plan.md'),
    });
  });

  it('审查：审的头由引擎填（检出的就是它）；要改却没有必须改的意见算交错了', () => {
    expect(parseReview('{"verdict":"pass","findings":[{"severity":"minor","text":"命名"}]}', 'h1')).toEqual({
      ok: { verdict: 'pass', head: 'h1', findings: [{ severity: 'minor', text: '命名' }] },
    });
    expect(
      parseReview('{"verdict":"changes","findings":[{"severity":"minor","text":"x"}]}', 'h1'),
    ).toMatchObject({
      error: expect.stringContaining('blocking'),
    });
    expect(parseReview('{"verdict":"ok"}', 'h1')).toMatchObject({
      error: expect.stringContaining('verdict'),
    });
    expect(
      parseReview('{"verdict":"pass","findings":[{"severity":"major","text":"x"}]}', 'h1'),
    ).toMatchObject({
      error: expect.stringContaining('severity'),
    });
  });
});
