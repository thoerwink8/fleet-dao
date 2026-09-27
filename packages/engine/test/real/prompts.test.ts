// 会话的活怎么交代、交回来的东西怎么认：提示词里有该有的，交错了的明确认成交错了（不补默认值、不猜）。
import { describe, expect, it } from 'vitest';
import type { SessionBrief } from '../../src/ports.ts';
import {
  isLeadKind,
  OUT_DIR,
  outputKindFor,
  outputKindOf,
  parseDoc,
  parseLeadBrief,
  parseLeadPlan,
  parseLeadRebut,
  parseLeadReview,
  parseLeadText,
  parseLeadVerdict,
  parsePlan,
  parseRequirementDoc,
  parseReview,
  parseTriage,
  parseVerify,
  stagePrompt,
  VERIFY_FILES_SHOWN,
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
    // 问他不挡路（#259）：提问一定带选项和推荐，按推荐接着干、不等
    expect(text).toContain('-r <推荐的>');
    expect(text).toContain('不等回答');
    expect(text).toContain('--outside');
    expect(text).toContain('--hold release|spend|delete|standard');
  });

  it('Fusion 的副手（带任务简报）：简报外的非改不可才改，交活总结里写清改了哪个、为什么；旧的子任务不写这句', () => {
    const task: NonNullable<SessionBrief['task']> = {
      goal: '加验证码',
      scope: '只改登录',
      constraints: [],
      files: ['src/login/'],
      acceptance: ['验证码 5 分钟过期'],
      returnFormat: '改了什么',
    };
    const side = stagePrompt({
      stage: 'execute',
      brief: brief({ task }),
      repo,
      issueNumber: 12,
      mode: 'new',
    });
    expect(side).toContain('「会改的地方」以外的文件非改不可才改');
    expect(side).toContain('交活总结里写清改了哪个、为什么');
    expect(side).not.toContain('改派');
    const old = stagePrompt({ stage: 'execute', brief: brief(), repo, issueNumber: 12, mode: 'new' });
    expect(old).not.toContain('非改不可');
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

  it('写码：交活只认原样跑的测试命令（别接管道、别放后台）；审查：和 origin/<主线> 比（引擎在树里钉好了）', () => {
    const exec = stagePrompt({
      stage: 'execute',
      brief: brief({ branch: 'fleet/12-login' }),
      repo: { ...repo, testCommand: 'pnpm test:changed' },
      issueNumber: 12,
      mode: 'new',
    });
    expect(exec).toContain('交活只认会话里原样跑的 `pnpm test:changed`');
    expect(exec).toContain('别接管道、别放后台');
    expect(exec).toContain('origin/main');
    const review = stagePrompt({
      stage: 'review',
      brief: brief({ prNumber: 31, head: 'abc' }),
      repo,
      issueNumber: 12,
      mode: 'new',
    });
    expect(review).toContain('git diff origin/main...HEAD');
    expect(review).toContain('可以跑测试（pnpm check）');
  });

  it('项目没写测试命令（只有不写码的阶段起得来）：提示词里不出现 null、不叫它跑测试', () => {
    const none = { ...repo, testCommand: null };
    const review = stagePrompt({
      stage: 'review',
      brief: brief({ prNumber: 31, head: 'abc' }),
      repo: none,
      issueNumber: 12,
      mode: 'new',
    });
    expect(review).not.toContain('可以跑测试');
    const research = stagePrompt({
      stage: 'research',
      brief: brief(),
      repo: none,
      issueNumber: 12,
      mode: 'new',
    });
    expect(research).toContain(
      '这个项目没写测试命令（仓里 .fleet/flow.json 的 testCommand），交活不核对测试',
    );
    for (const text of [review, research]) expect(text).not.toContain('null');
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

  it('分诊说不清时带的选项和推荐（#259）：去空白认出来；类型不对明确算交错了（合不合格由 core 的 checkAsk 判）', () => {
    expect(
      parseTriage(
        '{"clear":false,"question":"验证码几位？","options":[" 6 位 ","4 位",""],"recommend":" 6 位 "}',
      ),
    ).toEqual({
      ok: { clear: false, question: '验证码几位？', options: ['6 位', '4 位'], recommend: '6 位' },
    });
    expect(parseTriage('{"clear":false,"question":"几位？","options":"6 位"}')).toMatchObject({
      error: expect.stringContaining('options'),
    });
    expect(parseTriage('{"clear":false,"question":"几位？","recommend":6}')).toMatchObject({
      error: expect.stringContaining('recommend'),
    });
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

describe('开 PR 前验证', () => {
  const HEAD = 'a'.repeat(40);
  const CRITERIA = ['验证码 5 分钟过期', '有一条故意造出失败的测试'];
  const verifyBrief = (changedFiles: string[] = ['src/login/code.ts']) =>
    brief({
      head: HEAD,
      verify: {
        criteria: CRITERIA,
        specPath: 'specs/12-登录页加验证码/需求.md',
        planSummary: '登录表单加验证码输入，后端校验五分钟过期',
        changedFiles,
      },
    });
  const good = {
    head: HEAD,
    results: CRITERIA.map((criterion) => ({
      criterion,
      answer: 'done',
      evidence: 'src/login/code.ts 第 8 行',
    })),
    findings: [],
  };

  it('交代：送检的头、和主线怎么比、只读；「怎么算做完」逐条带出处；方案摘要、改了哪些文件；只三种能挡、其余写建议', () => {
    expect(outputKindOf('verify')).toBe('verify');
    const text = stagePrompt({ stage: 'verify', brief: verifyBrief(), repo, issueNumber: 12, mode: 'new' });
    for (const part of [
      `送检的提交 ${HEAD}`,
      'git diff origin/main...HEAD',
      '只读',
      '出自 specs/12-登录页加验证码/需求.md',
      '1. 验证码 5 分钟过期',
      '2. 有一条故意造出失败的测试',
      '登录表单加验证码输入，后端校验五分钟过期',
      '改了 1 个文件',
      '- src/login/code.ts',
      'breaks-existing',
      'security',
      'data-loss',
      'suggestion',
      `${OUT_DIR}/verify.json`,
      '不用 fleet done',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('改的文件太多：只列前一段，写明另有几个、让它看 git diff', () => {
    const files = Array.from({ length: VERIFY_FILES_SHOWN + 3 }, (_, i) => `src/f${i}.ts`);
    const text = stagePrompt({
      stage: 'verify',
      brief: verifyBrief(files),
      repo,
      issueNumber: 12,
      mode: 'new',
    });
    expect(text).toContain(`改了 ${VERIFY_FILES_SHOWN + 3} 个文件`);
    expect(text).toContain('另有 3 个，看 git diff');
    expect(text).not.toContain(`src/f${VERIFY_FILES_SHOWN}.ts`);
  });

  it('结论文件：合法的认出来（和 core 的 checkReport 同一个判法）', () => {
    expect(parseVerify(JSON.stringify(good), CRITERIA, HEAD)).toEqual({ ok: good });
  });

  it('【故意造出的失败】结论文件解析不出、审的不是送检的头、漏答、答了清单外的：都明确算交错了', () => {
    expect(parseVerify('不是 JSON', CRITERIA, HEAD)).toMatchObject({
      error: expect.stringContaining('不是合法的 JSON'),
    });
    expect(parseVerify('{"verdict":"pass"}', CRITERIA, HEAD)).toMatchObject({
      error: expect.stringContaining('.fleet-out/verify.json 交回的认不出'),
    });
    expect(parseVerify(JSON.stringify({ ...good, head: 'b'.repeat(40) }), CRITERIA, HEAD)).toMatchObject({
      error: expect.stringContaining('审的不是送检的头'),
    });
    expect(
      parseVerify(JSON.stringify({ ...good, results: good.results.slice(1) }), CRITERIA, HEAD),
    ).toMatchObject({ error: expect.stringContaining('没答：「验证码 5 分钟过期」') });
    expect(
      parseVerify(
        JSON.stringify({
          ...good,
          results: [...good.results, { criterion: '顺手改了别的', answer: 'done', evidence: 'x' }],
        }),
        CRITERIA,
        HEAD,
      ),
    ).toMatchObject({ error: expect.stringContaining('答了清单外的一条') });
  });
});

describe('Fusion 的 Lead：每一步交代什么、交回什么', () => {
  const DOCS = {
    requirement: 'specs/12-login/需求.md',
    plan: 'specs/12-login/方案.md',
    result: 'specs/12-login/结果.md',
  };
  const BASE = 'a'.repeat(40);
  const leadBrief = (lead: Partial<NonNullable<SessionBrief['lead']>>, over: Partial<SessionBrief> = {}) =>
    brief({
      branch: 'fleet/12-fabc12345',
      specDir: 'specs/12-login',
      lead: { step: 'plan', mode: 'fusion', docs: DOCS, ...lead },
      ...over,
    });
  const prompt = (b: SessionBrief, mode: 'new' | 'resume' = 'resume', stage: 'plan' | 'execute' = 'plan') =>
    stagePrompt({ stage, brief: b, repo, issueNumber: 12, mode });

  it('交什么按这一步定，不按阶段：写码那一步交活（和副手一样）；没带 lead 的照阶段', () => {
    const steps = ['plan', 'accept', 'rebut', 'fix-brief', 'review', 'pr-text', 'takeover'] as const;
    expect(steps.map((step) => outputKindFor('plan', leadBrief({ step })))).toEqual([
      'lead-plan',
      'lead-verdict',
      'lead-rebut',
      'lead-brief',
      'lead-review',
      'lead-text',
      'delivery',
    ]);
    expect(isLeadKind('lead-plan')).toBe(true);
    expect(isLeadKind('delivery')).toBe(false);
    expect(outputKindFor('plan', brief())).toBe('plan');
  });

  it('第 2 步（新会话）：读哪份需求文档、方案写哪提交、简报和摘要写哪个结论文件、各字段怎么填', () => {
    const text = prompt(leadBrief({ step: 'plan' }), 'new');
    for (const part of [
      '你是这张单的主导模型 Lead',
      DOCS.requirement,
      DOCS.plan,
      'git commit',
      `${OUT_DIR}/lead-plan.json`,
      '"brief": {"goal"',
      '"returnFormat"',
      'fleet/12-fabc12345',
      '不用 fleet done',
      '不 push',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('单模型模式');
    expect(prompt(leadBrief({ step: 'plan', mode: 'single' }), 'new')).toContain('这次是单模型模式');
    // #246：简报外的改动由 Lead 验收时定，不再是「改到外面的一律不收」
    expect(text).toContain('副手改到外面的，验收时由你定收不收');
    expect(text).not.toContain('一律不收');
  });

  it('#246 验收：简报外的改动看过该改就可以收，why 里写清为什么；点出这一轮改到简报外的是哪几个', () => {
    const task: NonNullable<SessionBrief['task']> = {
      goal: '全熔断提醒自动撤',
      scope: '只改对账',
      constraints: [],
      files: ['packages/engine/src/jobs/alert-sweep.ts'],
      acceptance: ['熔断解了就撤'],
      returnFormat: '改了什么',
    };
    const text = prompt(
      leadBrief(
        {
          step: 'accept',
          delivery: {
            head: 'b'.repeat(40),
            base: BASE,
            summary: '加了撤提醒的规则',
            changedFiles: ['packages/engine/src/jobs/alert-sweep.ts', 'docs/ops.md'],
            testsPassed: true,
          },
        },
        { task },
      ),
    );
    expect(text).toContain('改到任务简报外的：docs/ops.md');
    expect(text).toContain('看过觉得该改就可以收，why 里写清为什么要改它们');
    expect(text).not.toContain('一律不收');
    // 都在简报里的不点名
    const inside = prompt(
      leadBrief(
        {
          step: 'accept',
          delivery: {
            head: 'b'.repeat(40),
            base: BASE,
            summary: '加了撤提醒的规则',
            changedFiles: ['packages/engine/src/jobs/alert-sweep.ts'],
            testsPassed: true,
          },
        },
        { task },
      ),
    );
    expect(inside).not.toContain('改到任务简报外的');
  });

  it('续会话的下一步：只交代这一步（不重复整份任务）；验收写明从哪个头看起、只看不改', () => {
    const text = prompt(
      leadBrief({
        step: 'accept',
        delivery: {
          head: 'b'.repeat(40),
          base: BASE,
          summary: '加了验证码输入',
          changedFiles: ['src/login/form.ts'],
          testsPassed: true,
        },
      }),
    );
    expect(text.startsWith('这张单的下一步：')).toBe(true);
    expect(text).not.toContain('原话 / 说明');
    for (const part of [
      `git diff ${BASE}..HEAD`,
      'src/login/form.ts',
      '加了验证码输入',
      '它报测试过了',
      '只看不改',
      `${OUT_DIR}/lead-verdict.json`,
      '"verdict": "accept"',
    ]) {
      expect(text).toContain(part);
    }
    // 上一轮出了问题的（同一步重试）：照旧写「接着干」和问题
    const retry = stagePrompt({
      stage: 'plan',
      brief: leadBrief({ step: 'accept' }),
      repo,
      issueNumber: 12,
      mode: 'resume',
      previousProblem: '没写结论',
    });
    expect(retry).toContain('接着干');
    expect(retry).toContain('没写结论');
  });

  it('驳回、写修复简报、最终审查、重写 PR 摘要、自己接手：各写明看什么、交哪个文件', () => {
    const rebut = prompt(
      leadBrief({
        step: 'rebut',
        blocking: [{ target: '有一条故意造出失败的测试', kind: 'not-done', evidence: 'test/ 下没有' }],
        notes: ['验证码长度可以配置'],
      }),
    );
    expect(rebut).toContain('[没做到] 有一条故意造出失败的测试（它的证据：test/ 下没有）');
    expect(rebut).toContain('验证码长度可以配置');
    expect(rebut).toContain(`${OUT_DIR}/lead-rebut.json`);
    expect(rebut).toContain('{"rebuttals": []}');

    const fix = prompt(
      leadBrief(
        { step: 'fix-brief' },
        { feedback: [{ kind: 'ci', summary: 'CI 没过', items: ['test (engine)'] }] },
      ),
    );
    expect(fix).toContain('test (engine)');
    expect(fix).toContain(`${OUT_DIR}/lead-brief.json`);
    expect(fix).toContain('只看不改');

    const review = prompt(leadBrief({ step: 'review' }));
    for (const part of [
      'git diff origin/main...HEAD',
      DOCS.result,
      '"verdict": "fix"',
      `${OUT_DIR}/lead-review.json`,
    ]) {
      expect(review).toContain(part);
    }
    expect(review).not.toContain('只看不改');

    const text = prompt(leadBrief({ step: 'pr-text' }));
    expect(text).toContain(`${OUT_DIR}/lead-text.json`);
    expect(text).toContain('PR 正文是公开的');

    const takeover = prompt(
      leadBrief({ step: 'takeover', why: '副手打回两次还没做好' }),
      'resume',
      'execute',
    );
    expect(takeover).toContain('副手打回两次还没做好');
    expect(takeover).toContain('fleet done');
    expect(takeover).toContain('pnpm check');
  });

  it('结论文件：合法的认出来（字段原样，前后空白去掉）', () => {
    const b = {
      goal: '加验证码',
      scope: '只改登录',
      constraints: [],
      files: ['src/login/'],
      acceptance: ['五分钟过期'],
      returnFormat: '改了什么',
    };
    expect(
      parseLeadPlan(JSON.stringify({ summary: ' 摘要 ', brief: b, small: true, highRisk: false, holds: [] })),
    ).toEqual({ ok: { summary: '摘要', brief: b, small: true, highRisk: false, holds: [] } });
    expect(parseLeadVerdict('{"verdict": "reject", "why": "没做过期"}')).toEqual({
      ok: { verdict: 'reject', why: '没做过期' },
    });
    expect(parseLeadRebut('{"rebuttals": [{"target": "日志里有验证码", "evidence": "打的是编号"}]}')).toEqual(
      {
        ok: { rebuttals: [{ target: '日志里有验证码', evidence: '打的是编号' }] },
      },
    );
    expect(parseLeadRebut('{"rebuttals": []}')).toEqual({ ok: { rebuttals: [] } });
    expect(parseLeadBrief(JSON.stringify({ brief: b }))).toEqual({ ok: { brief: b } });
    expect(
      parseLeadReview(JSON.stringify({ verdict: 'pass', why: '都做到了', did: ['加了验证码'], owed: [] })),
    ).toEqual({ ok: { verdict: 'pass', why: '都做到了', did: ['加了验证码'], owed: [] } });
    expect(
      parseLeadReview(JSON.stringify({ verdict: 'fix', why: '漏了过期', did: [], owed: [], brief: b })),
    ).toEqual({ ok: { verdict: 'fix', why: '漏了过期', did: [], owed: [], brief: b } });
    expect(parseLeadText('{"summary": "加验证码", "did": ["加了输入框"]}')).toEqual({
      ok: { summary: '加验证码', did: ['加了输入框'] },
    });
  });

  it('【故意造出的失败】结论文件认不出：不是 JSON、不是对象、缺字段、类型不对、空的一条、要改却没给简报，都明确算交错了', () => {
    const cases: [ReturnType<typeof parseLeadPlan | typeof parseLeadText>, string][] = [
      [parseLeadPlan('不是 JSON'), '不是合法的 JSON'],
      [parseLeadPlan('[]'), 'lead-plan.json 要是一个对象'],
      [
        parseLeadPlan('{"brief": {}, "small": true, "highRisk": false, "holds": []}'),
        'summary 要是不空的字符串',
      ],
      [
        parseLeadPlan(
          '{"summary": "x", "brief": "写在正文里", "small": true, "highRisk": false, "holds": []}',
        ),
        'brief 要是一个对象',
      ],
      [
        parseLeadPlan('{"summary": "x", "brief": {}, "small": "是", "highRisk": false, "holds": []}'),
        'small 要是 true 或 false',
      ],
      [
        parseLeadPlan('{"summary": "x", "brief": {}, "small": true, "highRisk": false}'),
        'holds 要是字符串数组',
      ],
      [parseLeadText('{"summary": "x", "did": ["", "y"]}'), 'did 里有空的一条'],
    ];
    for (const [got, why] of cases) expect(got).toMatchObject({ error: expect.stringContaining(why) });
    expect(parseLeadVerdict('{"verdict": "maybe", "why": "x"}')).toMatchObject({
      error: expect.stringContaining('verdict 要是 accept 或 reject'),
    });
    expect(parseLeadVerdict('{"verdict": "accept", "why": " "}')).toMatchObject({
      error: expect.stringContaining('why 要是不空的字符串'),
    });
    expect(parseLeadRebut('{"rebuttals": [{"evidence": "x"}]}')).toMatchObject({
      error: expect.stringContaining('第 1 条驳回 缺 target'),
    });
    expect(parseLeadRebut('{"rebuttals": {}}')).toMatchObject({
      error: expect.stringContaining('rebuttals 要是数组'),
    });
    expect(parseLeadBrief('{"brief": null}')).toMatchObject({
      error: expect.stringContaining('brief 要是一个对象'),
    });
    expect(parseLeadReview('{"verdict": "fix", "why": "x", "did": [], "owed": []}')).toMatchObject({
      error: expect.stringContaining('没写修复简报'),
    });
    expect(parseLeadReview('{"verdict": "ok", "why": "x", "did": [], "owed": []}')).toMatchObject({
      error: expect.stringContaining('verdict 要是 pass 或 fix'),
    });
  });
});
