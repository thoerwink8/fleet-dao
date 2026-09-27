// 单子里问创始人（#259）的边界表：提问合不合格、他晚到的回答怎么算、记数；引擎存档点交给 Lead 照改的、PR 正文「按推荐先做了」、
// 对账另开单（开不开、放哪、写什么）。含故意造出失败的行。
import type { TaskState } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type AskFacts,
  askIssueKind,
  askIssuePlacement,
  askIssueText,
  assumedLines,
  changeLine,
  checkAsk,
  lateAnswer,
  lateChanges,
  outsideAnswerComment,
  type TaskAsk,
  tallyAsks,
} from '../src/ask.ts';
import { bodyCriteria, specOf } from '../src/criteria.ts';

describe('提问合不合格', () => {
  it('这张单范围内的岔路：推荐的排第一个（卡片上的主按钮），前后空白、重复的选项去掉', () => {
    expect(
      checkAsk({ question: ' 验证码几位？ ', options: ['4 位', ' 6 位 ', '4 位'], recommend: '6 位' }),
    ).toEqual({
      ok: true,
      ask: { question: '验证码几位？', options: ['6 位', '4 位'], recommended: '6 位', scope: 'task' },
    });
  });

  it('超出这张单的范围、碰人闸各是一种', () => {
    expect(
      checkAsk({
        question: '要不要顺手改注册页？',
        options: ['改', '不改'],
        recommend: '不改',
        outside: true,
      }),
    ).toMatchObject({
      ok: true,
      ask: { scope: 'outside', recommended: '不改' },
    });
    expect(
      checkAsk({
        question: '短信用哪家？',
        options: ['阿里云', '腾讯云'],
        recommend: '阿里云',
        hold: 'spend',
      }),
    ).toMatchObject({
      ok: true,
      ask: { scope: 'hold', hold: 'spend' },
    });
  });

  it.each([
    ['【失败】没带选项', { question: '验证码几位？' }, /至少两个选项和推荐.*fleet ask/],
    [
      '【失败】只有一个选项',
      { question: '验证码几位？', options: ['6 位'], recommend: '6 位' },
      /至少两个选项/,
    ],
    [
      '【失败】去重之后只剩一个',
      { question: '验证码几位？', options: ['6 位', ' 6 位'], recommend: '6 位' },
      /至少两个选项/,
    ],
    ['【失败】没写推荐', { question: '验证码几位？', options: ['4 位', '6 位'] }, /没写推荐哪个/],
    [
      '【失败】推荐的不在选项里',
      { question: '验证码几位？', options: ['4 位', '6 位'], recommend: '8 位' },
      /不在选项里/,
    ],
    [
      '【失败】选项太多',
      { question: '哪家？', options: ['甲', '乙', '丙', '丁', '戊'], recommend: '甲' },
      /最多 4 个/,
    ],
    [
      '【失败】超出范围和人闸同时写',
      { question: '哪家？', options: ['甲', '乙'], recommend: '甲', outside: true, hold: 'spend' },
      /只能选一个/,
    ],
    [
      '【失败】人闸认不出',
      { question: '哪家？', options: ['甲', '乙'], recommend: '甲', hold: 'buy' },
      /人闸认不出：buy/,
    ],
    ['【失败】问题是空的', { question: '  ', options: ['甲', '乙'], recommend: '甲' }, /问题是空的/],
  ])('%s', (_name, input, why) => {
    const got = checkAsk(input);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(why);
  });

  it('只有他本人才有的东西（账号、权限）：退回时写明不是提问，改用 fleet blocked --needs access', () => {
    const got = checkAsk({ question: '把短信服务的账号给我' });
    expect(!got.ok && got.why).toContain('fleet blocked "<缺什么>" --needs access');
  });
});

describe('他晚到的回答', () => {
  const at = (answer: string, taskState: TaskState, applied = false) =>
    lateAnswer({ recommended: '6 位', answer, applied, taskState });

  it.each([
    ['选的就是推荐的：只记一笔（单子在做、合了都一样）', at(' 6 位', 'running'), 'confirmed'],
    ['选的就是推荐的、已经合了', at('6 位', 'done'), 'confirmed'],
    ['选了别的、还在做：下一个存档点交给主导改', at('4 位', 'running'), 'change'],
    ['选了别的、在合并队列里还没合：照样下一个存档点改', at('4 位', 'merging'), 'change'],
    ['选了别的、已经交给主导照改了', at('4 位', 'done', true), 'applied'],
    ['选了别的、已经合了：开后续单', at('4 位', 'done'), 'follow-up'],
    ['选了别的、单子被叫停了：只记下，重开时照做', at('4 位', 'stopped'), 'recorded'],
    ['选了别的、单子失败了', at('4 位', 'failed'), 'recorded'],
    ['自己写了一句别的（不是选项）也算选了别的', at('都行，你定', 'running'), 'change'],
  ])('%s', (_name, got, want) => {
    expect(got).toBe(want);
  });
});

describe('记数：按推荐先走、事后被改（给检验制度用）', () => {
  it('分开数：按推荐先做的、其中回了推荐的、改选的；超出范围的、老样子的另算', () => {
    const asks: AskFacts[] = [
      { scope: 'task', recommended: '6 位' },
      { scope: 'task', recommended: '6 位', answer: '6 位' },
      { scope: 'task', recommended: '6 位', answer: '4 位' },
      { scope: 'hold', recommended: '阿里云', answer: '腾讯云' },
      { scope: 'outside', recommended: '不改' },
      {},
    ];
    expect(tallyAsks(asks)).toEqual({ assumed: 4, confirmed: 1, changed: 2, outside: 1, legacy: 1 });
  });

  it('【失败】说是按推荐先做、却没记推荐的：不算进按推荐先做，算老样子（不拿空的冒充推荐）', () => {
    expect(tallyAsks([{ scope: 'task' }])).toEqual({
      assumed: 0,
      confirmed: 0,
      changed: 0,
      outside: 0,
      legacy: 1,
    });
  });

  it('库里的一行（TaskAsk）直接能数', () => {
    expect(tallyAsks([ask({ answer: '4 位' }), ask({ id: 'b' })])).toMatchObject({ assumed: 2, changed: 1 });
  });
});

/** 一条按推荐先做了的提问（验证码几位？推荐 6 位）。 */
const ask = (over: Partial<TaskAsk> = {}): TaskAsk => ({
  id: 'a',
  question: '验证码几位？',
  options: ['6 位', '4 位'],
  scope: 'task',
  recommended: '6 位',
  applied: false,
  ...over,
});

describe('存档点交给 Lead 照改的（lateChanges）', () => {
  it('他改选了别的、还没照改、没另开后续单的才交；交出去还没照改完的不重复交', () => {
    const asks = [
      ask({ id: 'changed', answer: '4 位' }),
      ask({
        id: 'hold',
        scope: 'hold',
        hold: 'spend',
        recommended: '阿里云',
        options: ['阿里云', '腾讯云'],
        answer: '腾讯云',
      }),
      ask({ id: 'handed', answer: '4 位' }),
      ask({ id: 'confirmed', answer: ' 6 位 ' }),
      ask({ id: 'unanswered' }),
      ask({ id: 'applied', answer: '4 位', applied: true }),
      ask({ id: 'follow-up', answer: '4 位', followUpIssue: 301 }),
      ask({ id: 'outside', scope: 'outside', answer: '4 位' }),
      { id: 'legacy', question: '要不要？', options: [], applied: false, answer: '要' },
    ];
    expect(lateChanges(asks, ['handed']).map((a) => a.id)).toEqual(['changed', 'hold']);
  });

  it('【失败】说是按推荐先做、却没记推荐的：不当成改选（不拿空的当推荐比）', () => {
    expect(lateChanges([ask({ recommended: undefined, answer: '4 位' })])).toEqual([]);
  });

  it('交给 Lead 的那一句：问的什么、按推荐做的哪个、他改选了哪个；碰人闸的标出来', () => {
    expect(changeLine(ask({ answer: '4 位' }))).toBe(
      '问「验证码几位？」：按推荐先做的是「6 位」，创始人改选了「4 位」，照「4 位」改',
    );
    expect(
      changeLine(
        ask({
          scope: 'hold',
          hold: 'spend',
          recommended: '阿里云',
          options: ['阿里云', '腾讯云'],
          answer: '腾讯云',
        }),
      ),
    ).toContain('（碰人闸：花钱）');
  });
});

describe('PR 正文「按推荐先做了」一栏（assumedLines）', () => {
  it('按推荐先做了的都列上，写明他回了没有、回了什么；超出范围的写另开的单；老式的不列', () => {
    expect(
      assumedLines([
        ask({ id: '1' }),
        ask({ id: '2', answer: '6 位' }),
        ask({ id: '3', answer: '4 位' }),
        ask({ id: '4', answer: '4 位', applied: true }),
        ask({ id: '5', scope: 'hold', hold: 'spend', recommended: '阿里云', options: ['阿里云', '腾讯云'] }),
        ask({ id: '6', scope: 'outside', question: '要不要顺手改注册页？', followUpIssue: 88 }),
        ask({ id: '7', scope: 'outside', question: '要不要顺手改注册页？' }),
        { id: '8', question: '老式的提问', options: [], applied: false },
      ]),
    ).toEqual([
      '验证码几位？ → 先按推荐做了「6 位」，创始人还没回',
      '验证码几位？ → 按推荐做了「6 位」，创始人确认了',
      '验证码几位？ → 先按推荐做了「6 位」，创始人改选了「4 位」，下个存档点照改',
      '验证码几位？ → 先按推荐做了「6 位」，创始人改选了「4 位」，已照改',
      '验证码几位？ → 先按推荐做了「阿里云」（碰人闸：花钱，合并前等他批），创始人还没回',
      '要不要顺手改注册页？ → 超出这张单的范围，绕开了，另开一张单等创始人拍（#88）',
      '要不要顺手改注册页？ → 超出这张单的范围，绕开了，另开一张单等创始人拍（对账时开）',
    ]);
  });

  it('问题再长也压成一行、截短', () => {
    const [line] = assumedLines([ask({ question: `第一行\n${'很长'.repeat(50)}` })]);
    expect(line).not.toContain('\n');
    expect(line?.indexOf(' → ')).toBeLessThanOrEqual(60);
  });
});

describe('对账另开单（askIssueKind、askIssuePlacement、askIssueText）', () => {
  it.each([
    ['超出范围的：开一张等他拍（单子在做、合了、叫停都开）', ask({ scope: 'outside' }), 'running', 'outside'],
    ['超出范围的、单子叫停了也开', ask({ scope: 'outside' }), 'stopped', 'outside'],
    ['他改选了别的、原单已经合了：开后续单', ask({ answer: '4 位' }), 'done', 'follow-up'],
    ['碰人闸的一样', ask({ scope: 'hold', hold: 'spend', answer: '4 位' }), 'done', 'follow-up'],
    ['他改选了别的、单子还在做：存档点照改，不开单', ask({ answer: '4 位' }), 'running', null],
    ['他选的就是推荐的：不开', ask({ answer: '6 位' }), 'done', null],
    ['已经照改了：不开', ask({ answer: '4 位', applied: true }), 'done', null],
    ['叫停、失败的：只记下，不开', ask({ answer: '4 位' }), 'failed', null],
    ['他还没回：不开', ask({}), 'done', null],
    [
      '【失败】开过了（follow_up_issue 有值）：不再开第二张',
      ask({ answer: '4 位', followUpIssue: 9 }),
      'done',
      null,
    ],
    ['【失败】超出范围的开过了：不再开', ask({ scope: 'outside', followUpIssue: 9 }), 'running', null],
    [
      '老式的（没带推荐）不开',
      { id: 'x', question: 'q', options: [], applied: false, answer: '要' },
      'done',
      null,
    ],
  ] as const)('%s', (_name, a, state, want) => {
    expect(askIssueKind(a as TaskAsk, state as TaskState)).toBe(want);
  });

  const open = [
    { number: 3, title: 'v1 Fusion 接活' },
    { number: 4, title: 'v2 下一步' },
  ];

  it('后续单：照抄原单的类别、挂原单的同一个版本；母单这类别的标签不抄（另开的是独立单）', () => {
    expect(
      askIssuePlacement('follow-up', {
        labels: ['缺陷', '母单', '人闸'],
        milestone: { number: 3, title: 'v1 Fusion 接活' },
        openMilestones: open,
      }),
    ).toEqual({ labels: ['缺陷'], milestone: { number: 3, title: 'v1 Fusion 接活' } });
  });

  it('超出范围的一律未排期，等他拍（AI 不往进行中的版本里加他没拍过的活）', () => {
    expect(
      askIssuePlacement('outside', {
        labels: ['需求'],
        milestone: { number: 3, title: 'v1 Fusion 接活' },
        openMilestones: open,
      }),
    ).toEqual({ labels: ['需求'], milestone: null });
  });

  it('原单没挂版本：后续单一样未排期；原单的版本关了：先放未排期、写明是哪个版本', () => {
    expect(
      askIssuePlacement('follow-up', { labels: ['需求'], milestone: null, openMilestones: open }),
    ).toEqual({
      labels: ['需求'],
      milestone: null,
    });
    expect(
      askIssuePlacement('follow-up', {
        labels: ['需求'],
        milestone: { number: 2, title: 'v0 旧版本' },
        openMilestones: open,
      }),
    ).toEqual({ labels: ['需求'], milestone: null, closedMilestone: 'v0 旧版本' });
  });

  it('【失败】原单没贴类别、或贴了两个：按「需求」，不贴两个也不空着（恰好一个类别）', () => {
    for (const labels of [[], ['需求', '缺陷'], ['母单']]) {
      expect(askIssuePlacement('follow-up', { labels, milestone: null, openMilestones: [] }).labels).toEqual([
        '需求',
      ]);
    }
  });

  it('另开的单正文写全了需求（#295）：收单照收；「怎么算做完」只有那几条，说明的话不混进验收条', () => {
    for (const f of [
      {
        kind: 'follow-up' as const,
        ask: ask({ answer: '4 位' }),
        placement: { labels: ['需求'], milestone: { number: 3, title: 'v1 Fusion 接活' } },
      },
      {
        kind: 'outside' as const,
        ask: ask({ scope: 'outside', options: ['不改', '改'], recommended: '不改' }),
        placement: { labels: ['需求'], milestone: null },
      },
    ]) {
      const got = askIssueText({ ...f, original: { issueNumber: 12, title: '登录页加验证码' } });
      expect(got.body).toContain('接手时引擎照这张单的正文写需求文档，随 PR 进主线');
      const criteria = bodyCriteria(got.body);
      expect('ok' in criteria && criteria.ok).toHaveLength(2);
      expect(specOf({ body: got.body, issueNumber: 13, title: got.title })).toMatchObject({
        ok: expect.stringMatching(/^specs\/13-12/),
        requirement: expect.stringContaining('## 怎么算做完'),
      });
    }
  });

  it('后续单的标题和正文：链接原单、写明问的什么、按推荐做了哪个、他选了哪个，带「怎么算做完」', () => {
    const got = askIssueText({
      kind: 'follow-up',
      ask: ask({ answer: '4 位' }),
      original: { issueNumber: 12, title: '登录页加验证码' },
      placement: { labels: ['需求'], milestone: { number: 3, title: 'v1 Fusion 接活' } },
    });
    expect(got.title).toBe('#12 的后续：验证码几位？改成「4 位」');
    expect(got.body).toContain('创始人在 #12（登录页加验证码）的提问里改选了「4 位」。');
    expect(got.body).toContain('按推荐先做了「6 位」');
    expect(got.body).toContain('挂原单的同一个版本（v1 Fusion 接活）');
    expect(got.body).toContain('**选项**：「6 位」（AI 推荐）、「4 位」');
    expect(got.body).toContain('\n## 怎么算做完\n\n- #12 里按推荐先做的「6 位」改成创始人选的「4 位」');
  });

  it('超出范围的单：写明那张单绕开了、等他拍、他的回答记在评论里；不写他的回答', () => {
    const got = askIssueText({
      kind: 'outside',
      ask: ask({
        scope: 'outside',
        question: '要不要顺手改注册页？',
        options: ['不改', '改'],
        recommended: '不改',
        answer: '改',
      }),
      original: { issueNumber: 12, title: '登录页加验证码' },
      placement: { labels: ['需求'], milestone: null },
    });
    expect(got.title).toBe('#12 问到的、超出范围的：要不要顺手改注册页？');
    expect(got.body).toContain('那张单绕开这一块接着做');
    expect(got.body).toContain('## 怎么算做完');
    expect(got.body).not.toContain('创始人选了');
  });

  it('原单的版本关了：后续单正文写明先放未排期', () => {
    const got = askIssueText({
      kind: 'follow-up',
      ask: ask({ answer: '4 位' }),
      original: { issueNumber: 12, title: 't' },
      placement: { labels: ['需求'], milestone: null, closedMilestone: 'v0 旧版本' },
    });
    expect(got.body).toContain('原单的版本「v0 旧版本」已经关了，先放未排期');
  });

  it('超出范围那张单上记他的回答：选的就是推荐的写明', () => {
    expect(outsideAnswerComment(ask({ scope: 'outside', answer: '6 位' }), 12)).toBe(
      '创始人在 #12 的提问卡片上选了「6 位」（就是 AI 推荐的）：这一块照它做。',
    );
    expect(outsideAnswerComment(ask({ scope: 'outside', answer: '4 位' }), 12)).not.toContain('推荐');
  });
});
