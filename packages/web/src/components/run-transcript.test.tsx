// @vitest-environment happy-dom
// 一笔的会话内容（#1640、#1802、#3277，任务页右侧抽屉和弹出窗口共用）：按步骤分段、助手的话按 Markdown 排、连着的调用并成一组、
// 子代理收成卡、只看出错 / 只看文字、在会话里找、超长输出截断、没记录的文案、读失败能重试、在跑的段增量往后追加（done 后不再读）、
// 底栏「还在跑」和「跳到最新」、条目多只画最近 200 块。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { RunTranscript as Transcript, TranscriptEntry } from '../api/types';
import type { SegmentRunView } from '../lib/segments';
import { buildBlocks, filterItems, groupEntries, toolsSummary } from '../lib/transcript-items';
import { renderApp } from '../test/harness';
import { CLAMP_LINES } from './call-row';
import { RunMeta, RunOutcomeBadge, RunTranscript, runTitle, TRANSCRIPT_WINDOW } from './run-transcript';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const at = '2026-10-09T08:00:00.000Z';
const entry = (
  seq: number,
  kind: TranscriptEntry['kind'],
  text: string,
  more: Partial<TranscriptEntry> = {},
) => ({ seq, at, kind, text, ...more }) as TranscriptEntry;

const page = (entries: TranscriptEntry[], more: Partial<Transcript> = {}): Transcript => ({
  entries,
  nextAfter: entries.at(-1)?.seq ?? null,
  done: true,
  noRecord: false,
  ...more,
});

type Reader = (
  taskId: string,
  runId: string,
  query?: { after?: number; limit?: number },
) => Promise<Transcript>;

const RUN = {
  id: 'r-1',
  segment: 'manual',
  model: 'opus-5.5',
  modelName: 'Opus 5.5',
  running: false,
  outcome: 'done',
  durationMs: 600_000,
  costUsd: 1.42,
  unread: [],
} as unknown as SegmentRunView;

/** 抽屉、弹出窗口里放会话的那一套：头（第几笔、结局）、一行概况、会话内容。 */
function show(read: Reader, running = false) {
  const api = { ...createMockApi({ live: false }), runTranscript: read } as unknown as FleetApi;
  const run = { ...RUN, running };
  return renderApp(
    <div className="flex h-96 flex-col">
      <header data-run-head>
        {runTitle(run, 2)}
        <RunOutcomeBadge run={run} />
        <RunMeta run={run} now={Date.parse(at)} />
      </header>
      <RunTranscript taskId="t-1" run={run} />
    </div>,
    { api },
  );
}

const FULL = [
  entry(0, 'prompt', '第一行\n第二行\n第三行\n第四行\n第五行\n第六行'),
  entry(1, 'assistant', '先看一下。\n再看第二行。'),
  entry(2, 'tool_call', 'git status --short', { tool: 'Bash' }),
  entry(3, 'tool_result', ' M README.md', { tool: 'Bash', ok: true }),
  entry(4, 'tool_call', 'pnpm test', { tool: 'Bash' }),
  entry(5, 'tool_result', 'FAIL a.test.ts', { tool: 'Bash', ok: false }),
  entry(6, 'error', '测试没过'),
  entry(7, 'truncated', '后面还有 12 条没记'),
  entry(8, 'result', '已提交 abc123', { ok: true }),
];

const kinds = () => [...document.querySelectorAll('[data-kind]')].map((e) => e.getAttribute('data-kind'));
const filter = (name: RegExp | string) => screen.getByRole('radio', { name });

describe('会话内容：各种条目', () => {
  test('会话头：第几笔、段、模型、成败、时长、花费；打开才读一次接口', async () => {
    const read = vi.fn<Reader>(async () => page(FULL));
    show(read);
    const head = document.querySelector('[data-run-head]') as HTMLElement;
    expect(head.textContent).toContain('第 2 笔 · 动手');
    expect(head.textContent).toContain('Opus 5.5');
    expect(head.textContent).toContain('10 分钟');
    expect(head.textContent).toContain('$1.42');
    await screen.findByText('已提交 abc123');
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('完整一段：提示词、步骤分隔、助手的话、一组调用、报错、截断、结论卡，顺序照会话', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    expect([...document.querySelectorAll('[data-block]')].map((e) => e.getAttribute('data-block'))).toEqual([
      'entry',
      'divider',
      'say',
      'tools',
      'entry',
      'entry',
      'entry',
    ]);
    expect(kinds()).toEqual(['prompt', 'assistant', 'error', 'truncated', 'result']);
    expect(screen.getByRole('alert').textContent).toContain('测试没过');
    // 结论卡：过了是绿框
    const result = document.querySelector('[data-kind="result"]') as HTMLElement;
    expect(result.className).toContain('border-st-done-line');
    expect(result.textContent).toContain('结论');
  });

  test('步骤分隔线：序号、起始时刻；开头是一句话的写「第 N 步」（话就在下面），先调工具的写「动词 对象」', async () => {
    const entries = [
      entry(0, 'tool_call', 'gh pr checks', { tool: 'Bash', meta: { callId: 'z' } }),
      entry(1, 'tool_result', 'ok', { tool: 'Bash', ok: true, meta: { callId: 'z' } }),
      entry(2, 'assistant', '先看 CI 为什么红'),
      entry(3, 'tool_call', 'gh run view', { tool: 'Bash', meta: { callId: 'a' } }),
      entry(4, 'tool_result', 'red', { tool: 'Bash', ok: true, meta: { callId: 'a' } }),
      entry(5, 'assistant', '改测试'),
      entry(6, 'tool_call', 'a.test.ts', { tool: 'Edit', meta: { callId: 'b' } }),
      entry(7, 'tool_result', 'ok', { tool: 'Edit', ok: true, meta: { callId: 'b', added: 2, removed: 1 } }),
    ];
    show(async () => page(entries));
    await screen.findByText('改测试', { selector: 'p' });
    const dividers = [...document.querySelectorAll('[data-step-divider]')].map((d) => d.textContent);
    expect(dividers).toHaveLength(3);
    expect(dividers[0]).toMatch(/^1运行 gh pr checks· \d\d:\d\d:\d\d/);
    expect(dividers[1]).toMatch(/^2第 2 步· \d\d:\d\d:\d\d/);
    expect(dividers[2]).toMatch(/^3第 3 步/);
  });

  test('在跑的最后一步分隔线是蓝字、写「在跑」', async () => {
    show(async () => page(FULL.slice(0, 3), { done: false }), true);
    await screen.findByText(/先看一下/, { selector: 'p' });
    const d = document.querySelector('[data-step-divider]') as HTMLElement;
    expect(d.className).toContain('text-ink-run');
    expect(d.textContent).toContain('在跑');
  });

  test('助手的话按 Markdown 排：段落、列表、行内代码、加粗、代码块', async () => {
    const md = '先说结论：**测试过了**。\n\n- 改了 `a.ts`\n- 补了测试\n\n```ts\nconst x = 1;\n```';
    show(async () => page([entry(0, 'assistant', md)]));
    const said = await waitFor(() => {
      const el = document.querySelector('[data-kind="assistant"]');
      if (!el) throw new Error('还没出来');
      return el as HTMLElement;
    });
    expect(said.querySelector('strong')?.textContent).toBe('测试过了');
    expect([...said.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['改了 a.ts', '补了测试']);
    expect(said.querySelector('li code')?.textContent).toBe('a.ts');
    expect(said.querySelector('[data-md-code]')?.textContent).toBe('const x = 1;');
  });

  test('提示词收成两行，点「看全文」展开', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const prompt = document.querySelector('[data-kind="prompt"] p') as HTMLElement;
    expect(prompt.className).toContain('line-clamp-2');
    fireEvent.click(screen.getByRole('button', { name: '看全文' }));
    expect(prompt.className).not.toContain('line-clamp-2');
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(prompt.className).toContain('line-clamp-2');
  });

  test('连着的调用并成一行摘要；有失败的组默认展开，失败的调用自动展开输出，成功的折着', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const group = document.querySelector('[data-tool-group="2"]') as HTMLElement;
    const head = within(group).getAllByRole('button')[0] as HTMLElement;
    expect(head.textContent).toBe('已运行 2 个命令· 1 个失败');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const calls = group.querySelectorAll('[data-call]');
    expect(calls).toHaveLength(2);
    const [ok, bad] = [...calls].map((c) => c.querySelector('button') as HTMLElement);
    expect(ok?.getAttribute('aria-expanded')).toBe('false');
    expect(ok?.textContent).toContain('git status --short');
    expect(bad?.getAttribute('aria-expanded')).toBe('true');
    expect(bad?.textContent).toContain('运行失败');
    expect(group.querySelector('[data-call-result]')?.textContent).toContain('FAIL a.test.ts');
    // 点开成功的看到结果；人收起整组就听人的
    fireEvent.click(ok as HTMLElement);
    expect(screen.getByText(/M README.md/)).toBeTruthy();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(group.querySelectorAll('[data-call]')).toHaveLength(0);
  });

  test('组的摘要：命令、读、改、搜各写一句，失败另计', () => {
    const items = groupEntries([
      entry(0, 'tool_call', 'pnpm test', { tool: 'Bash', meta: { callId: '1' } }),
      entry(1, 'tool_result', 'x', { tool: 'Bash', ok: false, meta: { callId: '1' } }),
      entry(2, 'tool_call', 'a.ts', { tool: 'Read', meta: { callId: '2' } }),
      entry(3, 'tool_call', 'b.ts', { tool: 'Read', meta: { callId: '3' } }),
      entry(4, 'tool_call', 'c.ts', { tool: 'Edit', meta: { callId: '4' } }),
      entry(5, 'tool_call', 'UTC', { tool: 'Grep', meta: { callId: '5' } }),
    ]);
    expect(toolsSummary(items)).toEqual({
      text: '已运行 1 个命令，已读取 2 个文件，已编辑 1 次文件，已搜索 1 次',
      failed: 1,
    });
  });

  test('「只看出错」只剩出错的条目（没成的工具调用、报错），点「全部」回来', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const only = filter(/只看出错/);
    expect(only.textContent).toBe('只看出错 2');
    fireEvent.click(only);
    expect(only.getAttribute('aria-checked')).toBe('true');
    const shown = [...document.querySelectorAll('[data-seq]')].map((e) => e.getAttribute('data-seq'));
    expect(shown).toEqual(['4', '6']);
    expect(screen.queryByText('先看一下。', { exact: false })).toBeNull();
    expect(screen.queryByText('git status --short')).toBeNull();
    fireEvent.click(filter('全部'));
    expect(document.querySelectorAll('[data-block]').length).toBeGreaterThan(2);
  });

  test('「只看文字」只留提示词、助手的话、截断、结论，不要工具调用；没有出错的会写明', async () => {
    show(async () => page(FULL.filter((e) => e.kind !== 'error' && e.ok !== false)), true);
    await screen.findByText('已提交 abc123');
    fireEvent.click(filter('只看文字'));
    expect(kinds()).toEqual(['prompt', 'assistant', 'truncated', 'result']);
    fireEvent.click(filter(/只看出错/));
    expect(screen.getByText('这一笔没有出错的条目。')).toBeTruthy();
  });

  test('过滤函数：出错、文字各留哪些', () => {
    const items = groupEntries(FULL);
    expect(filterItems(items, 'all')).toHaveLength(items.length);
    expect(filterItems(items, 'errors').map((i) => (i.kind === 'call' ? i.call.seq : i.entry.seq))).toEqual([
      4, 6,
    ]);
    expect(
      filterItems(items, 'text').every((i) => i.kind === 'entry' && i.entry.kind !== 'tool_result'),
    ).toBe(true);
  });

  test('超长输出只露开头，点「显示全部」看全文，再点收起', async () => {
    const long = Array.from({ length: CLAMP_LINES + 10 }, (_, i) => `第 ${i} 行`).join('\n');
    show(async () =>
      page([
        entry(0, 'tool_call', 'cat big.log', { tool: 'Bash', meta: { callId: 'x' } }),
        entry(1, 'tool_result', long, { tool: 'Bash', ok: false, meta: { callId: 'x' } }),
      ]),
    );
    await screen.findByText(/第 0 行/);
    const p = document.querySelector('[data-call-result] p') as HTMLElement;
    expect(p.textContent).not.toContain(`第 ${CLAMP_LINES + 5} 行`);
    fireEvent.click(screen.getByRole('button', { name: '显示全部' }));
    expect(p.textContent).toBe(long);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(p.textContent).not.toContain(`第 ${CLAMP_LINES + 5} 行`);
  });

  test('子代理收成一张卡：头写类型、它在干什么、几次调用；默认收起，点开是它的话、调用和它回的话', async () => {
    const sub = { subagent: 'toolu_A', subagentType: 'fleet-scout' };
    const entries = [
      entry(0, 'tool_call', '找文件', { tool: 'Task', meta: { callId: 'toolu_A' } }),
      entry(1, 'assistant', '子代理说的话', { meta: sub }),
      entry(2, 'tool_call', 'UTC @ scripts', { tool: 'Grep', meta: { callId: 'toolu_B', ...sub } }),
      entry(3, 'tool_result', 'a.ts:1', { tool: 'Grep', ok: true, meta: { callId: 'toolu_B', ...sub } }),
      entry(4, 'tool_result', '找到了', { tool: 'Task', ok: true, meta: { callId: 'toolu_A' } }),
    ];
    show(async () => page(entries));
    const card = await waitFor(() => {
      const el = document.querySelector('[data-subagent-card]');
      if (!el) throw new Error('还没出来');
      return el as HTMLElement;
    });
    expect(document.querySelectorAll('[data-subagent-card]')).toHaveLength(1);
    expect(card.querySelector('[data-subagent-head]')?.textContent).toMatch(
      /^子代理 fleet-scout · 找文件 · 1 次调用 · \d+ 秒$/,
    );
    expect(screen.queryByText('子代理说的话')).toBeNull();
    fireEvent.click(within(card).getAllByRole('button')[0] as HTMLElement);
    expect(within(card).getByText('子代理说的话')).toBeTruthy();
    expect(within(card).getByText('UTC @ scripts')).toBeTruthy();
    expect(card.querySelector('[data-subagent-reply]')?.textContent).toContain('找到了');
  });

  test('老记录的子代理标记只有 true（没有调用号）：连着的条目归到前一张卡', () => {
    const sub = { meta: { subagent: true, subagentType: 'fleet-scout' } };
    const blocks = buildBlocks([
      entry(0, 'tool_call', '找文件', { tool: 'Task' }),
      entry(1, 'assistant', '子代理说的话', sub),
      entry(2, 'tool_call', 'UTC @ scripts', { tool: 'Grep', ...sub }),
      entry(3, 'tool_result', 'a.ts:1', { tool: 'Grep', ok: true, ...sub }),
      entry(4, 'tool_result', '找到了', { tool: 'Task', ok: true }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['subagent']);
    const card = blocks[0]?.kind === 'subagent' ? blocks[0].card : undefined;
    expect(card?.type).toBe('fleet-scout');
    expect(card?.items).toHaveLength(2);
    expect(card?.result?.text).toBe('找到了');
  });

  test('带调用号的调用和结果按调用号对：并行的同名调用、结果倒序回来也不错配；没有调用号的老记录照旧按顺序对', () => {
    const entries = [
      entry(0, 'tool_call', 'a.ts', { tool: 'Edit', meta: { callId: 'ea' } }),
      entry(1, 'tool_call', 'b.ts', { tool: 'Edit', meta: { callId: 'eb' } }),
      entry(2, 'tool_result', 'b 成了', { tool: 'Edit', ok: true, meta: { callId: 'eb' } }),
      entry(3, 'tool_result', 'a 没成', { tool: 'Edit', ok: false, meta: { callId: 'ea' } }),
      entry(4, 'tool_call', 'old-1', { tool: 'Bash' }),
      entry(5, 'tool_result', 'old-1 的结果', { tool: 'Bash', ok: true }),
    ];
    const items = groupEntries(entries);
    expect(items.map((i) => (i.kind === 'call' ? [i.call.text, i.result?.text] : ['entry']))).toEqual([
      ['a.ts', 'a 没成'],
      ['b.ts', 'b 成了'],
      ['old-1', 'old-1 的结果'],
    ]);
  });
});

describe('在会话里找', () => {
  test('数命中、回车下一个、Shift+回车上一个；命中折着的调用就展开；Esc 清空', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const box = screen.getByRole('searchbox', { name: '在会话里找' });
    expect(screen.queryByText('M README.md')).toBeNull();
    fireEvent.change(box, { target: { value: 'readme' } });
    // 「M README.md」在一个折着的成功调用里：命中就展开
    await screen.findByText(/M README.md/);
    const count = () => document.querySelector('[data-find-count]')?.textContent;
    expect(count()).toBe('1 / 1');
    fireEvent.change(box, { target: { value: '行' } });
    await waitFor(() => expect(count()).toMatch(/^1 \/ \d+$/));
    const total = Number(count()?.split(' / ')[1]);
    expect(total).toBeGreaterThan(1);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(count()).toBe(`2 / ${total}`);
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(count()).toBe(`${total} / ${total}`);
    fireEvent.change(box, { target: { value: '不存在的词' } });
    await waitFor(() => expect(count()).toBe('没找到'));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
    expect(document.querySelector('[data-find-count]')).toBeNull();
  });

  test('命中子代理卡里的话：卡自己展开', async () => {
    const sub = { subagent: 'A', subagentType: 'scout' };
    show(async () =>
      page([
        entry(0, 'tool_call', '找文件', { tool: 'Task', meta: { callId: 'A' } }),
        entry(1, 'assistant', '藏在子代理里的词', { meta: sub }),
        entry(2, 'tool_result', '好了', { tool: 'Task', ok: true, meta: { callId: 'A' } }),
      ]),
    );
    const box = await screen.findByRole('searchbox', { name: '在会话里找' });
    await waitFor(() => expect(document.querySelector('[data-subagent-card]')).not.toBeNull());
    expect(screen.queryByText('藏在子代理里的词')).toBeNull();
    fireEvent.change(box, { target: { value: '藏在' } });
    expect(await screen.findByText('藏在子代理里的词')).toBeTruthy();
  });
});

describe('会话内容：没记录、读失败', () => {
  test('noRecord 写「这一段跑在记录会话内容之前，没有记录」', async () => {
    show(async () => page([], { noRecord: true, nextAfter: null }), true);
    expect(await screen.findByText('这一段跑在记录会话内容之前，没有记录')).toBeTruthy();
  });

  test('503 写「没读成」和原因，重试能恢复；读到过的条目失败后留着', async () => {
    let calls = 0;
    const read = vi.fn<Reader>(async () => {
      calls += 1;
      if (calls === 1) throw new ApiError(503, 'run_transcript_unreadable', '没读成：connection terminated');
      return page(FULL);
    });
    show(read, true);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('没读成：connection terminated');
    expect(alert.textContent).not.toContain('没读成：没读成');
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await screen.findByText('已提交 abc123');
    expect(screen.queryByText(/connection terminated/)).toBeNull();
  });

  test('已经读到的条目，后一次读失败时不清空', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    show(async () => {
      calls += 1;
      if (calls === 1) return page(FULL.slice(0, 2), { done: false });
      throw new ApiError(503, 'run_transcript_not_wired', '这台没接上会话记录');
    }, true);
    await screen.findByText(/先看一下/, { selector: 'p' });
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect((await screen.findByRole('alert')).textContent).toContain('这台没接上会话记录');
    expect(screen.getByText(/先看一下/, { selector: 'p' })).toBeTruthy();
    // 失败后不再自动刷
    const seen = calls;
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(calls).toBe(seen);
  });
});

describe('会话内容：在跑的段', () => {
  test('每 3 秒用 after=nextAfter 读新的、往后追加；done 以后不再读，底栏「还在跑」也收起', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const all = FULL;
    const queries: Array<number | undefined> = [];
    const read = vi.fn<Reader>(async (_t, _r, q) => {
      queries.push(q?.after);
      const from = q?.after === undefined ? 0 : q.after + 1;
      const upto = queries.length === 1 ? 2 : queries.length === 2 ? 4 : all.length;
      const entries = all.slice(from, upto);
      return page(entries, {
        done: upto >= all.length,
        nextAfter: entries.at(-1)?.seq ?? q?.after ?? null,
      });
    });
    show(read, true);
    await screen.findByText(/先看一下/, { selector: 'p' });
    expect(screen.queryByText('已提交 abc123')).toBeNull();
    const live = document.querySelector('[data-live]') as HTMLElement;
    expect(live.textContent).toMatch(/^还在跑 · 每 3 秒读一次 · 上次 \d\d:\d\d:\d\d$/);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll('[data-call]')).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await screen.findByText('已提交 abc123');
    expect(queries).toEqual([undefined, 1, 3]);
    expect(kinds()).toEqual(['prompt', 'assistant', 'error', 'truncated', 'result']);
    expect(document.querySelector('[data-live]')).toBeNull();
    const seen = read.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(read).toHaveBeenCalledTimes(seen);
  });

  test('在跑的那一段打开就读、顶上写「在跑」；人往上滚底栏出现「跳到最新」，点了回到底部', async () => {
    show(async () => page(FULL.slice(0, 2), { done: false }), true);
    expect(await screen.findByText(/先看一下/, { selector: 'p' })).toBeTruthy();
    expect(document.querySelector('[data-run-head]')?.textContent).toContain('在跑');
    const box = document.querySelector('[data-transcript-body]') as HTMLElement;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 300 });
    expect(screen.queryByRole('button', { name: '跳到最新' })).toBeNull();
    box.scrollTop = 100;
    fireEvent.scroll(box);
    const jump = await screen.findByRole('button', { name: '跳到最新' });
    expect(document.querySelector('[data-live]')?.contains(jump)).toBe(true);
    fireEvent.click(jump);
    expect(box.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: '跳到最新' })).toBeNull();
    // 滚回底部附近，不再出现
    box.scrollTop = 700;
    fireEvent.scroll(box);
    expect(screen.queryByRole('button', { name: '跳到最新' })).toBeNull();
  });
});

describe('会话内容：条目多', () => {
  test('只画最近 200 块，上面有「显示更早的」，点一下多放出 200 块', async () => {
    const many = Array.from({ length: 450 }, (_, i) => entry(i, 'assistant', `第 ${i} 句`));
    show(async () => page(many), true);
    await screen.findByText('第 449 句');
    expect(document.querySelectorAll('[data-kind="assistant"]')).toHaveLength(TRANSCRIPT_WINDOW);
    expect(screen.queryByText('第 249 句')).toBeNull();
    expect(screen.getByText('第 250 句')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示更早的（还有 250 条）' }));
    expect(document.querySelectorAll('[data-kind="assistant"]')).toHaveLength(400);
    fireEvent.click(screen.getByRole('button', { name: '显示更早的（还有 50 条）' }));
    expect(document.querySelectorAll('[data-kind="assistant"]')).toHaveLength(450);
    expect(screen.queryByRole('button', { name: /显示更早的/ })).toBeNull();
    // 放全了，开头那条步骤分隔线也回来
    expect(document.querySelectorAll('[data-step-divider]')).toHaveLength(1);
  });
});
