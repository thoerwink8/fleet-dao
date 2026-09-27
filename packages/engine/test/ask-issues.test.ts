// 对账开单（jobs/ask-issues.ts，#259）：超出范围的另开一张等他拍、他改选了别的而原单已经合了的开后续单，单号回写；
// 超出范围那张开了以后他回答了，回答写到那张单上。开单、写评论没成的照实记没成、报提醒、单号不回写，不当成开了。
import type { TaskAsk } from '@fleet-dao/core';
import { describe, expect, it } from 'vitest';
import {
  type AskIssueCandidate,
  type AskIssueJobDeps,
  askAnswerAlertKey,
  askIssueAlertKey,
  openAskIssues,
} from '../src/jobs/ask-issues.ts';

const V1 = { number: 8, title: 'v1 Fusion 接活' };

const ask = (over: Partial<TaskAsk> = {}): TaskAsk => ({
  id: '11111111-2222-4333-8444-555555555555',
  question: '验证码几位？',
  options: ['6 位', '4 位'],
  scope: 'task',
  recommended: '6 位',
  answer: '4 位',
  applied: false,
  ...over,
});

const candidate = (over: Partial<AskIssueCandidate> = {}): AskIssueCandidate => ({
  ask: ask(),
  taskId: 'task-1',
  taskState: 'done',
  taskTitle: '登录页加验证码',
  issueNumber: 12,
  repo: { owner: 'example', name: 'canary' },
  ...over,
});

interface Fake {
  deps: AskIssueJobDeps;
  opened: Parameters<AskIssueJobDeps['openIssue']>[0][];
  comments: Parameters<AskIssueJobDeps['comment']>[0][];
  followUps: Map<string, number>;
  alerts: { key: string; title: string; body: string }[];
  resolved: string[];
  /** 记成转交完（applied_at）的提问编号。 */
  relayed: string[];
}

function fake(
  candidates: AskIssueCandidate[],
  over: Partial<AskIssueJobDeps> = {},
  original = { labels: ['缺陷', '母单'], milestone: V1, openMilestones: [V1] },
): Fake {
  const opened: Fake['opened'] = [];
  const comments: Fake['comments'] = [];
  const followUps = new Map<string, number>();
  const alerts: Fake['alerts'] = [];
  const resolved: string[] = [];
  const relayed: string[] = [];
  let next = 300;
  const byKey = new Map<string, number>();
  const deps: AskIssueJobDeps = {
    candidates: async () => candidates,
    original: async () => original,
    async openIssue(input) {
      opened.push(input);
      const known = byKey.get(input.key);
      if (known !== undefined) return { number: known, url: `u/${known}`, created: false };
      next += 1;
      byKey.set(input.key, next);
      return { number: next, url: `u/${next}`, created: true };
    },
    async setFollowUp(askId, issueNumber) {
      const was = followUps.get(askId);
      if (was === undefined) {
        followUps.set(askId, issueNumber);
        return 'ok';
      }
      return was === issueNumber ? 'same' : 'conflict';
    },
    async comment(input) {
      const created = !comments.some((c) => c.key === input.key && c.issueNumber === input.issueNumber);
      comments.push(input);
      return { created };
    },
    async alert(key, _taskId, title, body) {
      alerts.push({ key, title, body });
    },
    async resolve(key) {
      resolved.push(key);
    },
    async relayed(c) {
      relayed.push(c.ask.id);
    },
    log: () => undefined,
    ...over,
  };
  return { deps, opened, comments, followUps, alerts, resolved, relayed };
}

describe('对账开单', () => {
  it('他改选了别的、原单已经合了：开后续单，照抄类别（不抄母单）、挂原单的同一个版本，单号回写', async () => {
    const f = fake([candidate()]);
    const r = await openAskIssues(f.deps);
    expect(r).toMatchObject({ scanned: 1, found: 1, unchecked: [] });
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]).toMatchObject({
      repo: { owner: 'example', name: 'canary' },
      key: `ask:${ask().id}`,
      title: '#12 的后续：验证码几位？改成「4 位」',
      labels: ['缺陷'],
      milestone: V1.number,
    });
    expect(f.opened[0]?.body).toContain('创始人在 #12（登录页加验证码）的提问里改选了「4 位」');
    expect(f.followUps.get(ask().id)).toBe(301);
    expect(f.resolved).toEqual([askIssueAlertKey(ask().id)]);
    expect(f.alerts).toEqual([]);
  });

  it('超出范围的：开一张未排期的等他拍（单子还在做也开）；他已经回答了，回答写到那张单的评论里', async () => {
    const outside = ask({
      scope: 'outside',
      question: '要不要顺手改注册页？',
      recommended: '不改',
      options: ['不改', '改'],
      answer: '改',
    });
    const f = fake([candidate({ ask: outside, taskState: 'running' })]);
    const r = await openAskIssues(f.deps);
    expect(r).toMatchObject({ found: 2, unchecked: [] });
    expect(f.opened[0]).toMatchObject({ milestone: null, labels: ['缺陷'] });
    expect(f.opened[0]?.title).toBe('#12 问到的、超出范围的：要不要顺手改注册页？');
    expect(f.comments).toEqual([
      {
        repo: { owner: 'example', name: 'canary' },
        issueNumber: 301,
        key: `ask-answer:${outside.id}`,
        body: '创始人在 #12 的提问卡片上选了「改」：这一块照它做。',
      },
    ]);
    // 写上了记成转交完：之后不再进候选
    expect(f.relayed).toEqual([outside.id]);
  });

  it('超出范围的、开过单了：他后来回答了，只把回答写上去（不再开单）；写过的不重写', async () => {
    const outside = ask({
      scope: 'outside',
      followUpIssue: 88,
      answer: '改',
      recommended: '不改',
      options: ['不改', '改'],
    });
    const f = fake([candidate({ ask: outside, taskState: 'running' })]);
    expect((await openAskIssues(f.deps)).found).toBe(1);
    expect((await openAskIssues(f.deps)).found).toBe(0);
    expect(f.opened).toEqual([]);
    expect(f.comments.map((c) => c.issueNumber)).toEqual([88, 88]);
    // 以前写过、按键认下的也记成转交完（上一轮写上了、记转交没成的，这一轮补记）
    expect(f.relayed).toEqual([outside.id, outside.id]);
    expect(f.resolved).toEqual([askAnswerAlertKey(outside.id), askAnswerAlertKey(outside.id)]);
  });

  it('不该开的一张都不开：单子还在做（存档点照改）、选的就是推荐的、已经照改了、叫停了', async () => {
    const f = fake([
      candidate({ taskState: 'running' }),
      candidate({ ask: ask({ answer: '6 位' }) }),
      candidate({ ask: ask({ applied: true }) }),
      candidate({ taskState: 'stopped' }),
    ]);
    const r = await openAskIssues(f.deps);
    expect(r).toMatchObject({ scanned: 4, found: 0, opened: [], unchecked: [] });
    expect(f.opened).toEqual([]);
  });

  it('【失败】开单的端口报错：记成没开成、报提醒，单号不回写（下一轮再开），不当成开了', async () => {
    const f = fake([candidate()], {
      openIssue: async () => {
        throw new Error('HYGIENE_BLOCKED：单子正文里有名单里的敏感值（第 5 行）');
      },
    });
    const r = await openAskIssues(f.deps);
    expect(r.found).toBe(0);
    expect(r.opened).toEqual([]);
    expect(r.unchecked).toEqual([
      expect.stringMatching(/^#12 的提问 11111111 开后续单没成：HYGIENE_BLOCKED/),
    ]);
    expect(f.followUps.size).toBe(0);
    expect(f.alerts).toEqual([
      expect.objectContaining({ key: askIssueAlertKey(ask().id), title: '#12 的提问开后续单没成' }),
    ]);
    expect(f.resolved).toEqual([]);
  });

  it('【失败】读不到原单挂在哪个版本：不开（不拿「未排期」顶），记没成', async () => {
    const f = fake([candidate()], {
      original: async () => {
        throw new Error('GitHub 502');
      },
    });
    const r = await openAskIssues(f.deps);
    expect(r.unchecked).toEqual([expect.stringContaining('GitHub 502')]);
    expect(f.opened).toEqual([]);
  });

  it('【失败】单开了、库里这条已经记着别的单号：不改库里的，记没成、报提醒要人核对', async () => {
    const f = fake([candidate()]);
    f.followUps.set(ask().id, 77);
    const r = await openAskIssues(f.deps);
    expect(r.unchecked).toEqual([expect.stringContaining('已经记着别的单号')]);
    expect(f.followUps.get(ask().id)).toBe(77);
    expect(f.alerts).toHaveLength(1);
  });

  it('【失败】回答写不到超出范围的那张单上：记没成、报提醒（按提问编号一条）', async () => {
    const outside = ask({
      scope: 'outside',
      followUpIssue: 88,
      answer: '改',
      recommended: '不改',
      options: ['不改', '改'],
    });
    const f = fake([candidate({ ask: outside, taskState: 'running' })], {
      comment: async () => {
        throw new Error('NOT_AN_ISSUE');
      },
    });
    const r = await openAskIssues(f.deps);
    expect(r.unchecked).toEqual([expect.stringContaining('把回答写到 #88 上没成：NOT_AN_ISSUE')]);
    expect(f.alerts.map((a) => a.key)).toEqual([askAnswerAlertKey(outside.id)]);
    expect(f.relayed).toEqual([]);
  });

  it('【失败】回答写上了、记转交没成：记没成、报提醒，不撤提醒（下一轮按键认下评论、补记）', async () => {
    const outside = ask({
      scope: 'outside',
      followUpIssue: 88,
      answer: '改',
      recommended: '不改',
      options: ['不改', '改'],
    });
    const f = fake([candidate({ ask: outside, taskState: 'running' })], {
      relayed: async () => {
        throw new Error('库连不上');
      },
    });
    const r = await openAskIssues(f.deps);
    expect(r.unchecked).toEqual([expect.stringContaining('把回答写到 #88 上没成：库连不上')]);
    expect(f.alerts.map((a) => a.key)).toEqual([askAnswerAlertKey(outside.id)]);
    expect(f.resolved).toEqual([]);
  });

  it('【失败】读库里的提问就没成：原样抛出（这一步记成没跑成），不当成没有要开的', async () => {
    const f = fake([], {
      candidates: async () => {
        throw new Error('库连不上');
      },
    });
    await expect(openAskIssues(f.deps)).rejects.toThrow('库连不上');
  });
});
