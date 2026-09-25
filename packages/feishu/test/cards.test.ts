// 卡片：全部 JSON 2.0、共享卡、一个主按钮、只用白名单里的组件、不超 30 KB、不出现内部代号。
// 自检器本身也要先证明能抓到违规（旧系统的日报卡用了 2.0 不支持的 note 组件，生产上一张都发不出去）。
import type { SubtaskState, TaskState } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  activeListCard,
  answerCard,
  boardCard,
  budgetAlertCard,
  checkCard,
  draftCard,
  draftWaitCard,
  expiredBoardCard,
  outboxCard,
  pickTaskCard,
  progressCard,
  type RenderContext,
  stalledListCard,
  waitingListCard,
} from '../src/cards.ts';
import type { Card } from '../src/port.ts';
import { SUBTASK_STATE_WORDS, TASK_STATE_WORDS } from '../src/words.ts';
import { buttonsOf, textIn } from './fake-feishu.ts';
import { confirmed, draft, outboxItem, snapshot, taskDetail } from './harness.ts';

const ctx: RenderContext = { publicUrl: 'https://cockpit.example.test', now: Date.now(), nonce: 'n1' };

const TASK_STATES = Object.keys(TASK_STATE_WORDS) as TaskState[];
const SUBTASK_STATES = Object.keys(SUBTASK_STATE_WORDS) as SubtaskState[];

function allCards(): Array<[string, Card]> {
  const d = draft();
  const { task: _task, ...pendingIssue } = confirmed();
  const detail = taskDetail();
  const snap = snapshot();
  const empty = snapshot({
    stalled: [],
    waiting: [],
    active: [],
    quota: [],
    counts: { running: 0, stalled: 0, waitingForYou: 0, mergedToday: 0 },
  });
  const cards: Array<[string, Card]> = [
    ['草稿', draftCard(d, ctx)],
    ['草稿·拿不准·没定仓', draftCard(draft({ unsure: true, repo: null }), ctx, { note: '先选一个仓' })],
    ['草稿·只有一个仓', draftCard(draft({ repoOptions: [] }), ctx)],
    ['草稿·正在开', draftCard(d, ctx, { state: 'confirming' })],
    ['草稿·正在改', draftCard(d, ctx, { state: 'revising' })],
    ['草稿·已确认', draftCard(confirmed(), ctx)],
    ['草稿·已确认·待开单', draftCard(pendingIssue, ctx, { note: '已确认（乙），没有重复开任务。' })],
    ['正在理解', draftWaitCard(ctx, { title: '收到，正在理解…', rawText: '原话' })],
    ['没记成', draftWaitCard(ctx, { title: '这句话没记成', failed: true, lines: ['后端没回应'] })],
    ['回答', answerCard('在等 PR 合并。', ctx, 'task-12')],
    [
      '进度·挑选',
      pickTaskCard(12, [{ taskId: 't', repo: 'acme/web', issueNumber: 12, title: 'x', state: 'done' }], ctx),
    ],
    ['盘面', boardCard(snap, ctx)],
    ['盘面·数旧了', boardCard(snap, ctx, { staleMs: 600_000, note: '已刷新' })],
    ['盘面·旧卡', expiredBoardCard(ctx)],
    ['卡住的', stalledListCard(snap, ctx)],
    ['卡住的·空', stalledListCard(empty, ctx)],
    ['等点头', waitingListCard(snap, ctx)],
    ['等点头·空', waitingListCard(empty, ctx, '我的待办')],
    ['在干的', activeListCard(snap, ctx)],
    ['超预算', budgetAlertCard(11, 10, ctx)],
  ];
  for (const state of TASK_STATES) {
    const detailIn = taskDetail({ state });
    cards.push([`进度·${state}`, progressCard(detailIn, ctx, { note: '乙 已关注' })]);
  }
  cards.push(['进度·没有子任务', progressCard({ ...detail, subtasks: [] }, ctx)]);
  for (const kind of ['decision', 'alert', 'daily', 'follow', 'ask'] as const) {
    const item = outboxItem({ kind, id: `${kind}:1` });
    cards.push([`推送·${kind}`, outboxCard(item, ctx)]);
    cards.push([`推送·${kind}·已处理`, outboxCard({ ...item, status: 'done', doneText: '已处理' }, ctx)]);
    cards.push([`推送·${kind}·本地先改`, outboxCard(item, ctx, { note: '没提交上，再试一次' })]);
    const { askId: _a, options: _o, ...noAsk } = item;
    cards.push([`推送·${kind}·没有选项`, outboxCard(noAsk, ctx)]);
  }
  return cards;
}

describe('卡片', () => {
  it('每一种卡都过自检：JSON 2.0 共享卡、正好一个主按钮、白名单组件、回传值认得、不超 30 KB、没有内部代号', () => {
    for (const [name, card] of allCards()) {
      expect({ name, problems: checkCard(card) }).toEqual({ name, problems: [] });
    }
  });

  it('子任务的每个状态都换成白话', () => {
    const detail = taskDetail();
    const base = detail.subtasks[0];
    if (!base) throw new Error('样例没有子任务');
    for (const state of SUBTASK_STATES) {
      const card = progressCard({ ...detail, subtasks: [{ ...base, state }] }, ctx);
      expect(checkCard(card)).toEqual([]);
      expect(textIn(card)).toContain(SUBTASK_STATE_WORDS[state]);
    }
  });

  it('上游新出、归不了类的额度窗口（other）：带了原名显示原名，没带才写「其它额度」', () => {
    const line = (q: Partial<ReturnType<typeof snapshot>['quota'][number]>) =>
      textIn(
        boardCard(
          snapshot({ quota: [{ poolName: 'Cursor 甲', window: 'other', reading: 'measured', ...q }] }),
          ctx,
        ),
      );
    expect(line({ label: 'auto_percent', remaining: 0.25 })).toContain(
      'Cursor 甲 额度「auto_percent」：剩 25%',
    );
    expect(line({})).toContain('Cursor 甲 其它额度：');
    // 归得了类的窗口照旧写白话，原名不上卡
    expect(line({ window: '7d', label: '7d_claude' })).toContain('Cursor 甲 周额度：');
  });

  it('超长的原话、超多的行：截断后仍不超 30 KB', () => {
    const huge = '很长的一句话'.repeat(5000);
    const d = draft({ rawText: huge, understanding: huge.slice(0, 1000) });
    expect(checkCard(draftCard(d, ctx))).toEqual([]);
    const item = outboxItem({ title: huge.slice(0, 100), lines: Array(10).fill(huge.slice(0, 500)) });
    expect(checkCard(outboxCard(item, ctx))).toEqual([]);
  });

  it('原话里的符号原样显示，不当成格式（动态文字只进 plain_text）', () => {
    const d = draft({ rawText: '把 **首页** 改成 <font color=red>红</font> [链接](http://x)' });
    const card = draftCard(d, ctx);
    expect(textIn(card)).toContain('原话：把 **首页** 改成 <font color=red>红</font> [链接](http://x)');
    expect(JSON.stringify(card)).not.toContain('"tag":"markdown"');
  });

  it('按钮回传值的随机值 _n 排在最前面：按插入顺序、按键名排序都在前 128 个字符里（SDK 只按这 128 个字符去重）', () => {
    const long = outboxItem({
      id: 'ask:long',
      kind: 'ask',
      askId: 'a'.repeat(200),
      options: ['批准'.repeat(20)],
    });
    const cards: Array<[string, Card]> = [...allCards(), ['回传值很长的追问卡', outboxCard(long, ctx)]];
    let checked = 0;
    for (const [name, card] of cards) {
      for (const b of buttonsOf(card)) {
        if (!b.value) continue;
        checked += 1;
        const asIs = JSON.stringify(b.value);
        const sorted = JSON.stringify(
          Object.fromEntries(Object.entries(b.value as object).sort(([x], [y]) => (x < y ? -1 : 1))),
        );
        expect({
          name,
          asIs: asIs.startsWith('{"_n":"n1"'),
          sorted: sorted.startsWith('{"_n":"n1"'),
        }).toEqual({
          name,
          asIs: true,
          sorted: true,
        });
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('要人拍的卡写明「拍板请点按钮、回复不算拍板」；AI 追问卡写明「回复就是作答」', () => {
    expect(textIn(outboxCard(outboxItem({ kind: 'decision' }), ctx))).toContain('回复不算拍板');
    expect(textIn(outboxCard(outboxItem({ kind: 'decision' }), ctx))).not.toContain('回复这张卡片作答');
    expect(textIn(outboxCard(outboxItem({ kind: 'ask' }), ctx))).toContain('也可以直接回复这张卡片作答');
  });

  it('确认了、issue 还没开出来（后端的「待开单」）：写明正在开，不再出「确认」「改一下」', () => {
    const { task: _task, ...pendingIssue } = confirmed();
    const card = draftCard(pendingIssue, ctx);
    expect(textIn(card)).toContain('已确认，正在开成任务');
    expect(textIn(card)).toContain('确认：甲');
    const actions = buttonsOf(card).map((b) => (b.value as { a?: string } | undefined)?.a);
    expect(actions).not.toContain('draft.confirm');
    expect(actions).not.toContain('draft.revise');
    expect(buttonsOf(card).map((b) => b.url)).toEqual(['https://cockpit.example.test/overview']);
  });

  it('「打开驾驶舱」直达对应页', () => {
    const urls = (card: Card) => buttonsOf(card).flatMap((b) => (b.url ? [b.url] : []));
    expect(urls(draftCard(confirmed(), ctx))).toEqual(['https://cockpit.example.test/tasks/task-12']);
    expect(urls(waitingListCard(snapshot(), ctx))).toEqual(['https://cockpit.example.test/notifications']);
    expect(urls(outboxCard(outboxItem(), ctx))).toEqual(['https://cockpit.example.test/tasks/task-7']);
  });

  it('自检器能抓到违规：2.0 不支持的 note 组件、两个主按钮、没有主按钮、内部代号、坏回传值、超大卡', () => {
    const good = draftCard(draft(), ctx);
    const withNote = { ...good, body: { elements: [{ tag: 'note', elements: [] }, ...elementsOf(good)] } };
    expect(checkCard(withNote)).toContain('用了不在白名单里的组件 note');

    const twoPrimary = outboxCard(outboxItem(), ctx);
    const twoPrimaryBroken = JSON.parse(
      JSON.stringify(twoPrimary).replace('"type":"default"', '"type":"primary"'),
    );
    expect(checkCard(twoPrimaryBroken)).toContain('主按钮有 2 个，应当正好 1 个');

    const noPrimary = JSON.parse(JSON.stringify(expiredBoardCard(ctx)).replace('primary_filled', 'default'));
    expect(checkCard(noPrimary)).toContain('主按钮有 0 个，应当正好 1 个');

    const leak = answerCard('任务状态 stalled，排在 in_merge_queue', ctx);
    expect(checkCard(leak).some((p) => p.includes('内部代号'))).toBe(true);

    const badValue = JSON.parse(
      JSON.stringify(boardCard(snapshot(), ctx)).replace('board.refresh', 'board.explode'),
    );
    expect(checkCard(badValue).some((p) => p.includes('回传值不认识'))).toBe(true);

    const huge = answerCard('字'.repeat(100), ctx);
    const inflated = {
      ...huge,
      body: { elements: [...elementsOf(huge), ...Array(40).fill(elementsOf(huge)[0])] },
    };
    (inflated.body.elements[0] as { text: { content: string } }).text.content = 'x'.repeat(40_000);
    expect(checkCard(inflated).some((p) => p.includes('超过 30 KB'))).toBe(true);

    const v1 = { ...good, schema: undefined };
    expect(checkCard(v1)).toContain('schema 不是 2.0');
  });
});

function elementsOf(card: Card): unknown[] {
  return (card.body as { elements: unknown[] }).elements;
}
