// Fusion 工作流的纯判断：开工前流程配置能不能用、用哪套；Lead 交回的方案和最终审查收不收；验证挡住后给 Lead 驳回的原文；
// PR 正文、关单评论写什么。每张表都有故意造出失败的行：读不到、认不出一律明说，不拿默认值、空的、0 顶。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveFlowConfig, type Source } from '../src/config.ts';
import {
  type CloseFacts,
  checkLeadPlan,
  checkLeadReview,
  closeComment,
  type FlowConfigRead,
  type FusionPrFacts,
  fusionPrParts,
  rebuttable,
  setupFusion,
  specDocs,
  summaryItems,
} from '../src/fusion.ts';
import type { FlowReplica } from '../src/replica.ts';

const ORG_TEXT = readFileSync(new URL('../flow.default.json', import.meta.url), 'utf8');
const org: Source = { kind: 'text', text: ORG_TEXT };
const NOW = '2026-09-27T08:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const merged = (project: Source = { kind: 'missing' }) => {
  const got = resolveFlowConfig(org, project);
  if (!got.ok) throw new Error(got.why);
  return got.config;
};
const fresh: FlowReplica = { syncedAt: ago(10), error: null, unread: null, testCommand: 'pnpm test:changed' };
const readOf = (over: Partial<FlowConfigRead> = {}): FlowConfigRead => ({
  replica: fresh,
  source: 'org_default',
  config: merged(),
  ...over,
});

describe('开工前看流程配置（setupFusion）', () => {
  it('仓里没有自己的配置：照全组织默认派，标出 org_default；每一步的模型顺序、验证几轮照配置', () => {
    const got = setupFusion({ read: readOf(), now: NOW, category: '需求' });
    expect(got).toEqual({
      ok: true,
      source: 'org_default',
      profile: 'default',
      mode: 'fusion',
      // 创始人 2026-09-27 夜、09-28 凌晨拍的顺序（specs/169-Fusion形态/需求.md 那一节，含第 9 条）：Lead 拼车 Opus 在前、
      // Grok 兜底；副手排 DeepSeek Flash 第一、Grok 第二（09-28 凌晨改：拼车 Opus 用满、Grok 又留给界面单验证时副手一度
      // 派不出，改成 DeepSeek Flash 经 Mirasim 真当副手，#345）；不用 Kimi；验证 DeepSeek Flash、Opus 垫在后面（碰界面的单
      // GPT 不验）
      models: {
        lead: ['opus-5.5', 'grok-4.7'],
        sidekick: ['deepseek-flash', 'grok-4.7'],
        verify: ['gpt-5.6-luna', 'grok-4.7', 'deepseek-flash', 'opus-5.5'],
      },
      verifyRounds: 2,
      uiPaths: [],
      highRiskPaths: [],
    });
  });

  it('项目自己的配置：按类别挑那一套；单上指定的配置、模式压过类别', () => {
    const config = merged({
      kind: 'text',
      text: JSON.stringify({
        formatVersion: 1,
        categoryProfiles: { 缺陷: 'single' },
        uiPaths: ['packages/web/'],
      }),
    });
    const read = readOf({ source: 'project', config });
    expect(setupFusion({ read, now: NOW, category: '缺陷' })).toMatchObject({
      ok: true,
      source: 'project',
      profile: 'single',
      mode: 'single',
      // 单模型模式和 default 同一套（创始人 2026-09-27 夜：拼车号和 Grok 混用当 Lead；Mirasim 只开 DeepSeek Flash，不用 Kimi）：
      // Lead Opus 在前、Grok 兜底；验证 DeepSeek Flash、Opus 垫在后面（Lead 兜底成 Grok 时界面单还有人验）；没有副手
      models: {
        lead: ['opus-5.5', 'grok-4.7'],
        sidekick: [],
        verify: ['gpt-5.6-luna', 'grok-4.7', 'deepseek-flash', 'opus-5.5'],
      },
      verifyRounds: 1,
      uiPaths: ['packages/web/'],
    });
    expect(
      setupFusion({ read, now: NOW, category: '缺陷', profile: 'default', mode: 'single' }),
    ).toMatchObject({ ok: true, profile: 'default', mode: 'single', verifyRounds: 2 });
  });

  it.each<[string, Partial<FlowConfigRead>, RegExp]>([
    ['仓里的配置认不出', { replica: { ...fresh, error: '格式版本 7 认不出' } }, /流程配置认不出：格式版本 7/],
    ['从没同步过', { replica: { ...fresh, syncedAt: null }, config: null, source: null }, /还没从仓里同步过/],
    [
      '太久没同步成',
      { replica: { ...fresh, syncedAt: ago(90), unread: 'GitHub 502' } },
      /90 分钟没同步成.*GitHub 502/,
    ],
    ['同步过却没记来源', { source: null }, /没记读自仓里还是全组织默认/],
    ['整份认不出', { config: { profiles: 'x' } }, /整份认不出/],
    ['副本里没有整份', { config: null }, /整份认不出/],
  ])('【失败】%s：不派，写明原因（外壳挂起报红）', (_name, over, why) => {
    const got = setupFusion({ read: readOf(over), now: NOW, category: '需求' });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(why);
  });

  it('【失败】单上指定的配置不存在、判的时刻认不出：不派，不拿默认那套顶', () => {
    expect(setupFusion({ read: readOf(), now: NOW, category: '需求', profile: 'nope' })).toMatchObject({
      ok: false,
      why: expect.stringMatching(/没有叫「nope」的配置/),
    });
    expect(setupFusion({ read: readOf(), now: 'yesterday', category: '需求' })).toMatchObject({
      ok: false,
      why: expect.stringMatching(/时刻认不出/),
    });
  });
});

const SPEC_DIR = 'specs/12-登录验证码';
const BRIEF = {
  goal: '登录页加验证码',
  scope: '只改登录表单和校验',
  constraints: [],
  files: ['src/login/'],
  acceptance: ['验证码五分钟过期'],
  returnFormat: '改了哪些文件、测试结果',
};
const plan = (over: Record<string, unknown> = {}) => ({
  kind: 'lead-plan',
  head: 'c'.repeat(40),
  changedFiles: [`${SPEC_DIR}/方案.md`],
  summary: '登录表单加验证码输入，后端校验五分钟过期',
  brief: BRIEF,
  small: true,
  highRisk: false,
  holds: [],
  ...over,
});

describe('Lead 交回的方案和任务简报（checkLeadPlan）', () => {
  it('齐全：收下，简报按 core 的简报格式认', () => {
    const got = checkLeadPlan({ output: plan(), specDir: `${SPEC_DIR}/` });
    expect(got).toMatchObject({ ok: true, plan: { summary: plan().summary, small: true, brief: BRIEF } });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['方案没提交', { changedFiles: ['src/x.ts'] }, /方案没提交：写进 specs\/12-登录验证码\/方案\.md/],
    ['简报缺只许改的文件', { brief: { ...BRIEF, files: [] } }, /任务简报：缺「只许改的文件」/],
    [
      '简报写了绝对路径',
      { brief: { ...BRIEF, files: ['/etc/passwd'] } },
      /任务简报：「\/etc\/passwd」是绝对路径/,
    ],
    ['没写方案摘要', { summary: '  ' }, /方案交回的认不出：summary/],
    ['没说大小', { small: undefined }, /方案交回的认不出：small/],
    ['头不是提交号', { head: 'x' }, /方案交回的认不出：head/],
  ])('【失败】%s：退回 Lead 照原因重写', (_name, over, why) => {
    const got = checkLeadPlan({ output: plan(over), specDir: SPEC_DIR });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join('\n')).toMatch(why);
  });
});

const review = (over: Record<string, unknown> = {}) => ({
  kind: 'lead-review',
  verdict: 'pass',
  why: '改动和方案一致，测试齐',
  did: ['登录页加了验证码'],
  owed: [],
  head: 'd'.repeat(40),
  changedFiles: [`${SPEC_DIR}/结果.md`],
  ...over,
});

describe('Lead 的最终审查（checkLeadReview）', () => {
  it('过了：结果.md 这一轮提交了，或者以前提交过', () => {
    expect(checkLeadReview({ output: review(), specDir: SPEC_DIR, committed: [] })).toMatchObject({
      ok: true,
      review: { verdict: 'pass', did: ['登录页加了验证码'] },
    });
    expect(
      checkLeadReview({
        output: review({ changedFiles: [] }),
        specDir: SPEC_DIR,
        committed: [`${SPEC_DIR}/结果.md`],
      }),
    ).toMatchObject({ ok: true });
  });

  it('要改：带一份能派的修复简报', () => {
    const got = checkLeadReview({
      output: review({ verdict: 'fix', did: [], brief: BRIEF, changedFiles: [] }),
      specDir: SPEC_DIR,
      committed: [],
    });
    expect(got).toMatchObject({ ok: true, review: { verdict: 'fix', brief: BRIEF } });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['过了却没提交结果.md', { changedFiles: [] }, /结果没提交/],
    ['过了却没写做了什么', { did: [] }, /没写做了什么/],
    ['要改却没给简报', { verdict: 'fix', brief: undefined }, /修复简报：/],
    ['结论认不出', { verdict: 'maybe' }, /最终审查交回的认不出：verdict/],
  ])('【失败】%s：退回 Lead 重写', (_name, over, why) => {
    const got = checkLeadReview({ output: review(over), specDir: SPEC_DIR, committed: [] });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problems.join('\n')).toMatch(why);
  });
});

describe('验证挡住后给 Lead 看的（rebuttable）', () => {
  it('没做到的「怎么算做完」和三种发现原文照抄；做到的、看不出的、建议不算', () => {
    expect(
      rebuttable({
        head: 'a'.repeat(40),
        results: [
          { criterion: '照原话做完', answer: 'done', evidence: 'e1' },
          { criterion: ' 有一条失败测试 ', answer: 'not-done', evidence: '没找到' },
          { criterion: '文档', answer: 'unclear', evidence: '看不出' },
        ],
        findings: [
          { kind: 'security', text: '验证码进了日志', evidence: 'code.ts:12' },
          { kind: 'suggestion', text: '长度可配', evidence: '写死 6 位' },
        ],
      }),
    ).toEqual([
      { target: '有一条失败测试', kind: 'not-done', evidence: '没找到' },
      { target: '验证码进了日志', kind: 'security', evidence: 'code.ts:12' },
    ]);
  });
});

const prFacts = (over: Partial<FusionPrFacts> = {}): FusionPrFacts => ({
  mode: 'fusion',
  planSummary: '登录表单加验证码\n后端校验',
  summary: '- 加了验证码输入；- 加了过期校验',
  testsPassed: true,
  verify: { verified: ['开 PR 前别家验证第 1 轮（m3（gpt 族））：过'], owed: ['验证建议：长度可配'] },
  highRisk: false,
  planReviewSkipped: false,
  flowSource: 'project',
  outsideBrief: [],
  ...over,
});

describe('PR 正文（fusionPrParts）', () => {
  it('#246：Lead 收下的简报外文件在「怎么验证的」里紧跟测试写一行', () => {
    const got = fusionPrParts(
      prFacts({ outsideBrief: ['docs/ops.md', 'packages/engine/test/hourly-reconcile.test.ts'] }),
    );
    expect(got.verified).toEqual([
      '会话里跑过测试命令，最后一次通过（交活时后端核实过）',
      '简报外改了：docs/ops.md、packages/engine/test/hourly-reconcile.test.ts（主导收下）',
      '开 PR 前别家验证第 1 轮（m3（gpt 族））：过',
    ]);
    // 没有简报外的就不写这一行
    expect(fusionPrParts(prFacts()).verified.join('\n')).not.toContain('简报外');
  });

  it('方案摘要打头、验证结论进「怎么验证的」、建议进「还欠什么」', () => {
    expect(fusionPrParts(prFacts())).toEqual({
      did: ['方案：登录表单加验证码 后端校验', '加了验证码输入', '加了过期校验'],
      verified: [
        '会话里跑过测试命令，最后一次通过（交活时后端核实过）',
        '开 PR 前别家验证第 1 轮（m3（gpt 族））：过',
      ],
      owed: ['验证建议：长度可配'],
      tier: 'CI 绿就合——Lead 判了一般改动（合并闸按改动路径判，这一栏只作说明）',
      assumed: [],
    });
  });

  it('问过创始人、按推荐先做了的进「按推荐先做了」一栏（#259），一条一行', () => {
    const got = fusionPrParts(prFacts({ assumed: ['验证码几位？ → 先按推荐做了「6 位」，\n创始人还没回'] }));
    expect(got.assumed).toEqual(['验证码几位？ → 先按推荐做了「6 位」， 创始人还没回']);
  });

  it('没验、Lead 单干、方案评审跳过、用的全组织默认：都明说，不空着', () => {
    const got = fusionPrParts(
      prFacts({
        mode: 'single',
        verify: null,
        highRisk: true,
        planReviewSkipped: true,
        flowSource: 'org_default',
        soloWhy: '副手渠道没接好',
        testsPassed: false,
      }),
    );
    expect(got.verified).toEqual([
      '交活时报测试没过（fleet done --tests failed）',
      '开 PR 前别家验证：单模型模式只对高风险的开，这次没验',
      '这一块由 Lead 自己写：副手渠道没接好',
    ]);
    expect(got.owed).toEqual([
      '方案评审（0003 第 5 条第 3 步）引擎还没接，这次跳过（#249）',
      '这个项目没有 .fleet/flow.json，按全组织默认的流程配置派的',
    ]);
    expect(got.tier).toMatch(/^先审后合/);
  });

  it('交活总结按换行、分号切，去掉列表记号', () => {
    expect(summaryItems('- a；b\n* c;  \n• d\ne')).toEqual(['a', 'b', 'c', 'd']);
  });
});

const closeFacts = (over: Partial<CloseFacts> = {}): CloseFacts => ({
  prNumber: 101,
  mergeCommit: 'mc0123456789abcdef',
  did: ['登录页加了验证码'],
  elapsedMs: 95 * 60_000,
  offClockMs: 20 * 60_000,
  usage: [
    {
      model: 'opus-5.5',
      runs: 5,
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 1.234,
      missingTokens: 0,
      missingCost: 1,
    },
    {
      model: 'kimi-k3',
      runs: 2,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      missingTokens: 2,
      missingCost: 2,
    },
  ],
  verified: ['开 PR 前别家验证第 1 轮：过'],
  owed: [],
  docs: specDocs(SPEC_DIR),
  flowSource: 'project',
  mode: 'fusion',
  ...over,
});

describe('关单评论（closeComment）', () => {
  it('改了什么、用时、各模型额度都写上；读不到的明说没读到', () => {
    const got = closeComment(closeFacts());
    expect(got).toContain('做完了：PR #101 已合并（合并提交 mc0123456789）。');
    expect(got).toContain('- 登录页加了验证码');
    expect(got).toContain('**用时**：从收单到合并 1 小时 35 分钟（其中等人、排队 20 分钟）');
    expect(got).toContain(
      '- opus-5.5：会话 5 次；输入 1200 token、输出 300 token；花费 $1.23（另有 1 次没读到花费）',
    );
    expect(got).toContain('- kimi-k3：会话 2 次；token 没读到；花费没读到');
    expect(got).toContain('需求 specs/12-登录验证码/需求.md · 方案 specs/12-登录验证码/方案.md');
    expect(got).not.toContain('还欠什么');
  });

  it('问过创始人的记数（#259）：按推荐先做了几条、事后被改了几条；没读的不写这一段', () => {
    expect(closeComment(closeFacts())).not.toContain('问创始人');
    const got = closeComment(
      closeFacts({ asks: { assumed: 3, confirmed: 1, changed: 1, outside: 1, legacy: 0 } }),
    );
    expect(got).toContain(
      '**问创始人**：按推荐先做了 3 条，事后被改了 1 条（他确认了 1 条，还有 1 条他没回）；超出范围另开单 1 条',
    );
    expect(
      closeComment(closeFacts({ asks: { assumed: 0, confirmed: 0, changed: 0, outside: 0, legacy: 0 } })),
    ).toContain('**问创始人**：没问过');
  });

  it('同样的事实写出同一份正文（关单评论的幂等键带正文，重试不多发）', () => {
    expect(closeComment(closeFacts())).toBe(closeComment(closeFacts()));
  });

  it('【故意造出的失败】一次会话结局都没记上、时长算不成：明说没读到，不写成 0', () => {
    const got = closeComment(closeFacts({ usage: [], elapsedMs: Number.NaN, owed: ['x'] }));
    expect(got).toContain('一次会话结局都没记上：用量没读到（不是没花）');
    expect(got).toContain('从收单到合并 没算成');
    expect(got).toContain('**还欠什么**：\n- x');
    expect(got).not.toMatch(/\$0\.00/);
  });
});
