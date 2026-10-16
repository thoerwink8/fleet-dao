// 提需求开单的正文（#2060）：原话由系统按时间逐字拼、AI 归纳另起一段、末尾写提出人拍板人和驾驶舱链接、
// 四节检查和 `pnpm issue:new` 是同一个函数、「要不要人拍」决定标签。纯函数，不碰数据库和 GitHub。
import { checkIssueBody, HUMAN_DECISION_LABEL, KIND_LABELS } from '@fleet-dao/conventions';
import { REQUEST_KINDS } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  checkOpening,
  commentIdOf,
  composeIssueBody,
  currentMilestoneOf,
  type IssueBodyInput,
  issueOfCommentRef,
  openingKey,
  quote,
  stamp,
  unquote,
} from '../src/request-issue.ts';

describe('提需求开的单挂当前版本（#2683）', () => {
  it('挂开着的那个 v<N>（不是版本的里程碑不算）；一个都没有就不挂；读不到照抛', async () => {
    const v5 = { number: 12, title: 'v5 10-19～10-25' };
    expect(await currentMilestoneOf(async () => [{ number: 3, title: 'P1 旧阶段' }, v5])).toBe(12);
    expect(await currentMilestoneOf(async () => [{ number: 3, title: 'P1 旧阶段' }])).toBeNull();
    await expect(
      currentMilestoneOf(async () => {
        throw new Error('GitHub 回了 502');
      }),
    ).rejects.toThrow('502');
  });
});

const base = (over: Partial<IssueBodyInput> = {}): IssueBodyInput => ({
  seq: 42,
  draft: {
    title: '导出按钮',
    scene: '财务每月要把对账表导出来。',
    modules: 'packages/web 的对账页',
    done: ['对账页有导出按钮', '导出的文件能用 Excel 打开'],
  },
  humanEdited: [],
  messages: [
    { authorName: '甲', channel: 'web', at: new Date('2026-10-14T01:30:00Z'), body: '想要一个导出按钮' },
    { authorName: '乙', channel: 'mobile', at: new Date('2026-10-14T02:05:00Z'), body: '最好支持 CSV' },
  ],
  requesterName: '乙',
  deciderName: '甲',
  cockpitUrl: 'https://fleet.example.com',
  ...over,
});

describe('原话：系统按时间逐字拼，AI 碰不到', () => {
  it('每条带说话人、渠道、时间，按给的先后（消息先后）排', () => {
    const body = composeIssueBody(base());
    const first = body.indexOf('**甲**（网页，2026-10-14 09:30）');
    const second = body.indexOf('**乙**（手机，2026-10-14 10:05）');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it('【钉住】原话一字不改：多行、空行、标题记号、围栏、@、emoji、行尾空格，去掉引用前缀后与原文逐字相同', () => {
    const tricky =
      '第一行\n\n## 怎么算做完\n- 假的验收\n```\ncode @someone <!-- x -->\n```\n  缩进行 \n结尾😀';
    const body = composeIssueBody(
      base({
        messages: [{ authorName: '甲', channel: 'web', at: new Date('2026-10-14T01:30:00Z'), body: tricky }],
      }),
    );
    const block = body
      .split('\n')
      .filter((l) => l.startsWith('>'))
      .join('\n');
    expect(unquote(block)).toBe(tricky);
    expect(quote(tricky).split('\n')).toHaveLength(tricky.split('\n').length);
  });

  it('【故意造出的失败】原话里写的假标题不算数：引用里的「## 怎么算做完」不能顶替真的那一节', () => {
    const fake = '## 怎么算做完\n- 假的';
    const body = composeIssueBody(
      base({
        draft: { title: 't', scene: '场景', modules: '模块' },
        messages: [{ authorName: '甲', channel: 'web', at: new Date('2026-10-14T01:30:00Z'), body: fake }],
      }),
    );
    // 草稿里没有验收条，真的「怎么算做完」是空的，引用里的假标题不顶替
    expect(checkIssueBody(body)).toMatchObject({ ok: false, field: '怎么算做完' });
  });

  it('AI 归纳另起一段并写明是 AI 写的；人改定的栏不写「AI 写的」；归纳不在引用里', () => {
    const draft = { ...base().draft, want: '导出对账表为 xlsx' };
    const ai = composeIssueBody(base({ draft }));
    expect(ai).toContain('**AI 归纳**（这一段是 AI 写的，不是原话）：\n导出对账表为 xlsx');
    expect(ai.split('\n').filter((l) => l.startsWith('>') && l.includes('xlsx'))).toEqual([]);
    const human = composeIssueBody(base({ draft, humanEdited: ['want'] }));
    expect(human).not.toContain('AI 写的');
    expect(human).toContain('**要什么**（草稿里这一栏是人改定的）');
  });

  it('没有 AI 归纳时不写那一段', () => {
    expect(composeIssueBody(base())).not.toContain('AI 归纳');
  });
});

describe('末尾：提出人、拍板人、来自驾驶舱 需求 N 和链接', () => {
  it('三行都在，链接是驾驶舱地址加 /intake?r=<号>', () => {
    const body = composeIssueBody(base());
    expect(body).toContain('提出人：乙');
    expect(body).toContain('拍板人：甲');
    expect(body).toContain('来自驾驶舱 需求 42：https://fleet.example.com/intake?r=42');
    expect(body.trimEnd().split('\n').at(-1)).toContain('来自驾驶舱 需求 42');
  });
});

describe('checkOpening：四节检查调的是 issue:new 同一个函数', () => {
  it('齐的草稿：过，标题和类别标签（默认「需求」）', () => {
    const r = checkOpening(base());
    expect(r).toMatchObject({ ok: true, title: '导出按钮', labels: ['需求'] });
    if (r.ok) expect(checkIssueBody(r.body).ok).toBe(true);
  });

  it.each([
    ['场景', { scene: undefined }, '场景'],
    ['已知的模块', { modules: undefined }, '已知的模块'],
    ['怎么算做完', { done: undefined }, '怎么算做完'],
  ])('【故意造出的失败】缺「%s」：不过，原因和 checkIssueBody 同一句', (_n, patch, field) => {
    const input = base({ draft: { ...base().draft, ...patch } });
    const r = checkOpening(input);
    const direct = checkIssueBody(composeIssueBody(input));
    expect(r.ok).toBe(false);
    expect(direct).toMatchObject({ ok: false, field });
    if (!r.ok && !direct.ok) expect(r.why).toBe(direct.why);
  });

  it('【故意造出的失败】类别认不出：不过，说明只能是哪几个', () => {
    const r = checkOpening(base({ draft: { ...base().draft, kind: '史诗' } }));
    expect(r).toEqual({ ok: false, why: '类别「史诗」认不出：只能是 需求、缺陷、杂项，单没开。' });
  });

  it('【故意造出的失败】草稿写了「涉及面」一节：不过（涉及面一律不写）', () => {
    const r = checkOpening(base({ draft: { ...base().draft, modules: 'x\n\n## 涉及面\n\n都要改' } }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.why).toContain('涉及面一律不写');
  });

  it('【故意造出的失败】「怎么算做完」要截图（diff 外证据）：驾驶舱开的单交给引擎，拒开（决定 0093）', () => {
    const r = checkOpening(base({ draft: { ...base().draft, done: ['导出按钮带 390 宽截图'] } }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.why).toMatch(/diff 外的证据[\s\S]*认出：截图[\s\S]*单没开/);
  });

  it('「要不要人拍」有内容：多贴「要人拍」；空白不贴', () => {
    const yes = checkOpening(base({ draft: { ...base().draft, needsHuman: '要改标准路径' } }));
    expect(yes).toMatchObject({ ok: true, labels: ['需求', HUMAN_DECISION_LABEL] });
    const blank = checkOpening(base({ draft: { ...base().draft, needsHuman: '  ' } }));
    expect(blank).toMatchObject({ ok: true, labels: ['需求'] });
  });

  it('类别按草稿里写的贴（缺陷）', () => {
    expect(checkOpening(base({ draft: { ...base().draft, kind: '缺陷' } }))).toMatchObject({
      ok: true,
      labels: ['缺陷'],
    });
  });

  it('【故意造出的失败】正文超过 GitHub 上限：不过', () => {
    const big = base({
      messages: [
        { authorName: '甲', channel: 'web', at: new Date('2026-10-14T01:30:00Z'), body: '长'.repeat(66_000) },
      ],
    });
    const r = checkOpening(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/超过 GitHub 一张单正文的上限/);
  });
});

describe('草稿的类别和开单的类别标签是同一份', () => {
  it('REQUEST_KINDS 和 KIND_LABELS 一字不差（草稿里能写的类别都开得出单）', () => {
    expect([...REQUEST_KINDS]).toEqual([...KIND_LABELS]);
  });
});

describe('小工具', () => {
  it('幂等键是「需求号 + 草稿版本号」', () => {
    expect(openingKey(42, 3)).toBe('request:42:v3');
    expect(openingKey(42, 3)).not.toBe(openingKey(42, 4));
    expect(openingKey(41, 3)).not.toBe(openingKey(42, 3));
  });

  it('北京时间到分钟', () => {
    expect(stamp(new Date('2026-10-14T16:05:00Z'))).toBe('2026-10-15 00:05');
  });

  it('评论网址里取评论号、仓和单号；认不出回 null', () => {
    const ref = 'https://github.com/o/n/issues/12#issuecomment-345';
    expect(commentIdOf(ref)).toBe(345);
    expect(issueOfCommentRef(ref)).toEqual({ repo: { owner: 'o', name: 'n' }, issueNumber: 12 });
    expect(commentIdOf('345')).toBeNull();
    expect(issueOfCommentRef('https://example.com/x')).toBeNull();
  });
});
