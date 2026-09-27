// 飞书接口的纯函数：北京时间的「今天」、推送条目的指纹和截断、等待期、猜仓、盘面的额度挑选。
import { FeishuOutboxItemSchema } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { clip } from '../src/feishu-records.ts';
import {
  beijingDayStart,
  beijingStamp,
  composeOutbox,
  guessRepo,
  HOLD_MARGIN_MS,
  issueTitle,
  pendingOutbox,
} from '../src/feishu-views.ts';
import type { FeishuOutboxSources, FeishuOutboxState } from '../src/ports.ts';

const task = {
  id: 't1',
  title: '登录页加验证码',
  issueNumber: 12,
  state: 'running' as const,
  repo: 'example/canary',
};

function sources(over: Partial<FeishuOutboxSources> = {}): FeishuOutboxSources {
  return {
    asks: [
      {
        task,
        ask: {
          id: 'a1',
          taskId: 't1',
          question: '验证码几位？',
          options: ['4 位', '6 位'],
          askedAt: '2026-09-25T07:55:00.000Z',
        },
      },
    ],
    notifications: [],
    ...over,
  };
}

describe('北京时间', () => {
  it('「今天」从北京时间 0 点算（UTC 前一天 16:00），跨日那一刻归新的一天', () => {
    expect(beijingDayStart(new Date('2026-09-25T08:00:00.000Z')).toISOString()).toBe(
      '2026-09-24T16:00:00.000Z',
    );
    expect(beijingDayStart(new Date('2026-09-25T15:59:59.999Z')).toISOString()).toBe(
      '2026-09-24T16:00:00.000Z',
    );
    expect(beijingDayStart(new Date('2026-09-25T16:00:00.000Z')).toISOString()).toBe(
      '2026-09-25T16:00:00.000Z',
    );
    expect(beijingStamp('2026-09-25T06:02:00.000Z')).toBe('09-25 14:02');
    expect(beijingStamp('2026-09-25T16:30:00.000Z')).toBe('09-26 00:30');
  });
});

describe('推送条目', () => {
  it('同样的内容指纹不变；答了（内容变了）指纹就变', () => {
    const [before] = composeOutbox(sources());
    const [again] = composeOutbox(sources());
    expect(again?.fingerprint).toBe(before?.fingerprint);
    const [answered] = composeOutbox(
      sources({
        asks: [
          {
            task,
            ask: {
              id: 'a1',
              taskId: 't1',
              question: '验证码几位？',
              options: ['4 位', '6 位'],
              askedAt: '2026-09-25T07:55:00.000Z',
              answer: '6 位',
              answeredBy: 'u1',
              answeredAt: '2026-09-25T08:00:00.000Z',
            },
            answeredByName: '创始人甲',
          },
        ],
      }),
    );
    expect(answered?.fingerprint).not.toBe(before?.fingerprint);
    expect(answered?.content).toMatchObject({
      status: 'done',
      doneText: '已回答：6 位 · 创始人甲 · 09-25 16:00',
    });
  });

  it('超长、超多的字段按约定的上限截好（一条超长整批就回不出去）：标题、正文行数和每行、选项个数和长度、站外链接', () => {
    const long = '很长'.repeat(400);
    const [ask, note] = composeOutbox(
      sources({
        asks: [
          {
            task: { ...task, title: long },
            ask: {
              id: 'a1',
              taskId: 't1',
              question: `${long}\n${Array.from({ length: 30 }, (_, i) => `第 ${i} 行`).join('\n')}`,
              options: ['一', '二', '三', '四', '五', '选项'.repeat(40), '  '],
              askedAt: '2026-09-25T07:55:00.000Z',
            },
          },
        ],
        notifications: [
          {
            notification: {
              id: 'n1',
              level: 'alert',
              title: '  ',
              body: Array.from({ length: 20 }, () => long).join('\n'),
              link: 'https://evil.example/x',
              createdAt: '2026-09-25T07:00:00.000Z',
            },
          },
        ],
      }),
    );
    for (const c of [ask, note]) {
      if (!c) throw new Error('应当有两条');
      const parsed = FeishuOutboxItemSchema.safeParse({ ...c.content, revision: 1 });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
    expect(ask?.content.options).toEqual(['一', '二', '三', '四']);
    expect(ask?.content.lines).toHaveLength(10);
    expect(note?.content.title).toBe('有任务卡住了');
    expect(note?.content.link).toBeUndefined();
    expect(note?.content.lines.at(-1)).toBe('……其余见驾驶舱');
  });

  it('需求已经结束、追问还没答：这张卡了结（不用再答）；从没发过的不再给，发过的给一版「了结」', () => {
    const open = sources().asks[0];
    if (!open) throw new Error('样例里应当有一条追问');
    const ended = composeOutbox(sources({ asks: [{ task: { ...task, state: 'stopped' }, ask: open.ask }] }));
    expect(ended[0]?.content).toMatchObject({ status: 'done', doneText: '需求已叫停，不用再答了' });
    const now = new Date('2026-09-25T08:00:00.000Z');
    const never: FeishuOutboxState = { id: 'ask:a1', revision: 2, createdAt: now.toISOString() };
    expect(pendingOutbox(ended, new Map([['ask:a1', never]]), now, 100).items).toEqual([]);
    const delivered: FeishuOutboxState = {
      ...never,
      ack: { revision: 1, status: 'sent' },
      delivered: { messageId: 'om_1', chatId: 'oc_1', sentAt: now.toISOString(), revision: 1 },
    };
    expect(
      pendingOutbox(ended, new Map([['ask:a1', delivered]]), now, 100).items.map((i) => i.revision),
    ).toEqual([2]);
  });

  describe('问他不挡路（#259）的卡', () => {
    const scoped = {
      id: 'a2',
      taskId: 't1',
      question: '验证码用哪家短信？',
      options: ['阿里云', '腾讯云'],
      askedAt: '2026-09-25T07:55:00.000Z',
      scope: 'task' as const,
      recommended: '阿里云',
    };
    const answered = (answer: string, more: object = {}) => ({
      ...scoped,
      answer,
      answeredBy: 'u1',
      answeredAt: '2026-09-25T08:00:00.000Z',
      ...more,
    });
    const card = (
      ask: FeishuOutboxSources['asks'][number]['ask'],
      state: typeof task.state | 'done' | 'stopped' | 'failed' = 'running',
    ) => {
      const [item] = composeOutbox(
        sources({ asks: [{ task: { ...task, state }, ask, answeredByName: '创始人甲' }] }),
      );
      if (!item) throw new Error('应当有一张卡');
      const parsed = FeishuOutboxItemSchema.safeParse({ ...item.content, revision: 1 });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      return item.content;
    };

    it('还没回：第一行写明已按推荐先做、改选会怎样，推荐的是第一个按钮；单子合进去了照样能改（改了开后续单）', () => {
      expect(card(scoped)).toMatchObject({
        status: 'open',
        lines: ['已按推荐先做：阿里云。改选别的，下个存档点交给 AI 改。', '需求：登录页加验证码'],
        options: ['阿里云', '腾讯云'],
      });
      expect(card(scoped, 'done')).toMatchObject({
        status: 'open',
        lines: ['已按推荐先做：阿里云。这张单已经合进去了，改选别的会另开后续单。', '需求：登录页加验证码'],
      });
      // 叫停、失败的收起（老式的追问单子一结束就收起，见上一条）
      expect(card(scoped, 'stopped')).toMatchObject({ status: 'done', doneText: '需求已叫停，不用再答了' });
    });

    it('回了之后原地改成「你选了 X」和怎么生效：就是推荐的、下个存档点改、已照改、合并后开后续单、单子停了只记下', () => {
      const by = ' · 创始人甲 · 09-25 16:00';
      expect(card(answered('阿里云')).doneText).toBe(`你选了：阿里云（就是推荐的），已生效${by}`);
      expect(card(answered('腾讯云'))).toMatchObject({
        status: 'done',
        doneText: `你选了：腾讯云，下个存档点生效${by}`,
      });
      expect(card(answered('腾讯云', { appliedAt: '2026-09-25T08:10:00.000Z' })).doneText).toBe(
        `你选了：腾讯云，已生效${by}`,
      );
      expect(card(answered('腾讯云'), 'done').doneText).toBe(
        `你选了：腾讯云；这张单已经合进去了，会另开后续单${by}`,
      );
      expect(card(answered('腾讯云', { followUpIssue: 31 }), 'done').doneText).toBe(
        `你选了：腾讯云；这张单已经合进去了，另开了后续单 #31${by}`,
      );
      expect(card(answered('腾讯云'), 'failed').doneText).toBe(
        `你选了：腾讯云；这张单没做成就停了，只记下${by}`,
      );
    });

    it('碰了人闸：写明碰的哪类、合并前等批；超出范围的：写明另开单、这张单绕开接着做', () => {
      expect(card({ ...scoped, scope: 'hold', hold: 'spend' }).lines[0]).toBe(
        '碰了人闸（花钱）：先按推荐做（阿里云），合并前等你批。',
      );
      expect(card({ ...scoped, scope: 'outside' }).lines[0]).toBe(
        '超出这张单的范围：这张单绕开它接着做，另开一张单等你拍。',
      );
      expect(card({ ...scoped, scope: 'outside', followUpIssue: 40 }).lines[0]).toBe(
        '超出这张单的范围：这张单绕开它接着做，另开一张单等你拍（#40）。',
      );
      expect(card({ ...answered('腾讯云'), scope: 'outside', followUpIssue: 40 }).doneText).toBe(
        '你选了：腾讯云，记在 #40 上 · 创始人甲 · 09-25 16:00',
      );
    });
  });

  it('等待期：到了时刻再多等一小会儿（两台机器的钟差一点也不会被网关当成重复）；下一个到点的时刻报给长轮询', () => {
    const item = composeOutbox(sources());
    const until = '2026-09-25T09:00:00.000Z';
    const state: FeishuOutboxState = {
      id: 'ask:a1',
      revision: 1,
      createdAt: until,
      ack: { revision: 1, status: 'deferred', reason: 'quiet_hours', holdUntil: until },
    };
    const at = (ms: number) => new Date(Date.parse(until) + ms);
    const held = pendingOutbox(item, new Map([['ask:a1', state]]), at(0), 100);
    expect(held).toEqual({ items: [], nextHoldAt: Date.parse(until) + HOLD_MARGIN_MS });
    expect(pendingOutbox(item, new Map([['ask:a1', state]]), at(HOLD_MARGIN_MS), 100).items).toHaveLength(1);
  });
});

describe('草稿的小工具', () => {
  it('猜仓：只有一个仓就是它；原话恰好提到一个仓名就是它；提到两个或没提到就是空', () => {
    const repo = (name: string) => ({ id: name, owner: 'o', name, defaultBranch: 'main', testCommand: 't' });
    expect(guessRepo('随便', [repo('web')])?.name).toBe('web');
    expect(guessRepo('给 API 加个接口', [repo('web'), repo('api')])?.name).toBe('api');
    expect(guessRepo('web 和 api 都要改', [repo('web'), repo('api')])).toBeUndefined();
    expect(guessRepo('随便', [repo('web'), repo('api')])).toBeUndefined();
    expect(guessRepo('随便', [])).toBeUndefined();
  });

  it('截断不切在 emoji 中间（半个代理对写进 jsonb 会被库整条拒收）', () => {
    expect(clip('a😀b', 3)).toBe('a…');
    expect(clip('😀😀😀', 3)).toBe('😀…');
    expect(clip('ab', 3)).toBe('ab');
    for (const s of ['😀'.repeat(50), `x${'😀'.repeat(50)}`]) {
      const out = clip(s, 21);
      expect(out.length).toBeLessThanOrEqual(21);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
    }
  });

  it('issue 标题取「我理解为」第一行，截到 80 字', () => {
    expect(issueTitle('第一行\n第二行')).toBe('第一行');
    expect(issueTitle('字'.repeat(100))).toHaveLength(80);
  });
});
