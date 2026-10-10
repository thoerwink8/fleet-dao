// @vitest-environment happy-dom
// 任务页「看会话」抽屉里的会话内容（#1640、#1802）：各种条目画出来、工具调用默认折叠、出错的自动展开、只看出错 / 只看文字、
// 超长输出截断、没记录的文案、读失败能重试、在跑的段增量往后追加（done 后不再读）、不贴底时出现「跳到最新」、
// 子代理的条目带标签、条目多只画最近 200 条。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { RunTranscript as Transcript, TranscriptEntry } from '../api/types';
import type { SegmentRunView } from '../lib/segments';
import { renderApp } from '../test/harness';
import {
  CLAMP_LINES,
  filterItems,
  groupEntries,
  RunTranscriptDrawer,
  TRANSCRIPT_WINDOW,
} from './run-transcript';

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

function show(read: Reader, running = false, onClose: () => void = () => {}) {
  const api = { ...createMockApi({ live: false }), runTranscript: read } as unknown as FleetApi;
  return renderApp(
    <RunTranscriptDrawer
      taskId="t-1"
      run={{ ...RUN, running }}
      nth={2}
      now={Date.parse(at)}
      onClose={onClose}
    />,
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

describe('会话内容：各种条目', () => {
  test('抽屉顶上固定一行：段、第几次、模型、成败、时长、花费；打开才读一次接口', async () => {
    const read = vi.fn<Reader>(async () => page(FULL));
    show(read);
    const head = document.querySelector('[data-drawer-summary]') as HTMLElement;
    expect(head.textContent).toContain('动手');
    expect(head.textContent).toContain('第 2 次');
    expect(head.textContent).toContain('Opus 5.5');
    expect(head.textContent).toContain('10 分钟');
    expect(head.textContent).toContain('$1.42');
    await screen.findByText('已提交 abc123');
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('完整一段：提示词、助手的话、工具调用、报错、截断、结论都画出来；成功的工具结果默认不画，出错的自动展开', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    expect(kinds()).toEqual([
      'prompt',
      'assistant',
      'tool_call',
      'tool_call',
      'tool_result',
      'error',
      'truncated',
      'result',
    ]);
    expect(screen.getByText('后面还有 12 条没记')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('测试没过');
    const said = document.querySelector('[data-kind="assistant"]');
    expect(said?.textContent).toBe('先看一下。\n再看第二行。');
    expect(said?.className).toContain('whitespace-pre-wrap');
  });

  test('提示词只露开头几行，点「看全文」展开', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const prompt = document.querySelector('[data-kind="prompt"] p') as HTMLElement;
    expect(prompt.className).toContain('line-clamp-4');
    fireEvent.click(screen.getByRole('button', { name: '看全文' }));
    expect(prompt.className).not.toContain('line-clamp-4');
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(prompt.className).toContain('line-clamp-4');
  });

  test('工具调用默认折叠成一行，点开看到紧跟着的结果；出错的默认就展开并写没成', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const bash = screen.getAllByRole('button').filter((b) => b.textContent?.includes('Bash'));
    expect(bash).toHaveLength(2);
    const [ok, bad] = bash as [HTMLElement, HTMLElement];
    // 成功的：折叠；出错的：展开
    expect(ok.getAttribute('aria-expanded')).toBe('false');
    expect(ok.textContent).toContain('git status --short');
    expect(screen.queryByText('M README.md')).toBeNull();
    expect(bad.getAttribute('aria-expanded')).toBe('true');
    const failed = document.querySelector('[data-kind="tool_result"]') as HTMLElement;
    expect(within(failed).getByText('没成')).toBeTruthy();
    expect(failed.textContent).toContain('FAIL a.test.ts');
    // 点开成功的看到结果；人收起出错的，就听人的
    fireEvent.click(ok);
    expect(screen.getByText('M README.md')).toBeTruthy();
    expect(ok.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(bad);
    expect(bad.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/FAIL a.test.ts/)).toBeNull();
  });

  test('「只看出错」过滤后只剩出错的条目（没成的工具调用、报错），再点回到全部', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const only = screen.getByRole('button', { name: /只看出错/ });
    expect(only.textContent).toBe('只看出错（2）');
    fireEvent.click(only);
    expect(only.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('[data-seq]')).toHaveLength(2);
    const shown = [...document.querySelectorAll('[data-seq]')].map((e) => e.getAttribute('data-seq'));
    expect(shown).toEqual(['4', '6']);
    expect(screen.queryByText('先看一下。', { exact: false })).toBeNull();
    expect(screen.queryByText('git status --short')).toBeNull();
    fireEvent.click(only);
    expect(only.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('[data-seq]').length).toBeGreaterThan(2);
  });

  test('「只看文字」只留提示词、助手的话、报错、结论，不要工具调用；没有出错的会写明', async () => {
    show(async () => page(FULL.filter((e) => e.kind !== 'error' && e.ok !== false)), true);
    await screen.findByText('已提交 abc123');
    fireEvent.click(screen.getByRole('button', { name: '只看文字' }));
    expect(kinds()).toEqual(['prompt', 'assistant', 'truncated', 'result']);
    fireEvent.click(screen.getByRole('button', { name: /只看出错/ }));
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
    show(async () => page([entry(0, 'assistant', long)]), true);
    await screen.findByText(/第 0 行/);
    const p = document.querySelector('[data-kind="assistant"]') as HTMLElement;
    expect(p.textContent).not.toContain(`第 ${CLAMP_LINES + 5} 行`);
    fireEvent.click(screen.getByRole('button', { name: '显示全部' }));
    expect(p.textContent).toBe(long);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(p.textContent).not.toContain(`第 ${CLAMP_LINES + 5} 行`);
  });

  test('点遮罩、按 Esc 都会调 onClose', async () => {
    const onClose = vi.fn();
    show(async () => page(FULL), false, onClose);
    await screen.findByText('已提交 abc123');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('抽屉左边沿可用左右键拉宽，不超过 80vw', async () => {
    show(async () => page(FULL));
    await screen.findByText('已提交 abc123');
    const bar = screen.getByRole('separator');
    const before = Number(bar.getAttribute('aria-valuenow'));
    expect(before).toBe(640);
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    const after = Number(bar.getAttribute('aria-valuenow'));
    expect(after).toBeGreaterThan(before);
    for (let i = 0; i < 40; i++) fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(window.innerWidth * 0.8);
  });

  test('子代理的条目缩进并标「子代理 <类型>」，调用的结果跨过子代理那几条也能对上', () => {
    const sub = { meta: { subagent: true, subagentType: 'fleet-scout' } };
    const entries = [
      entry(0, 'tool_call', '找文件', { tool: 'Task' }),
      entry(1, 'assistant', '子代理说的话', sub),
      entry(2, 'tool_call', 'UTC @ scripts', { tool: 'Grep', ...sub }),
      entry(3, 'tool_result', 'a.ts:1', { tool: 'Grep', ok: true, ...sub }),
      entry(4, 'tool_result', '找到了', { tool: 'Task', ok: true }),
    ];
    const items = groupEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(['call', 'entry', 'call']);
    expect(items[0]?.kind === 'call' && items[0].result?.text).toBe('找到了');
    expect(items[2]?.kind === 'call' && items[2].result?.text).toBe('a.ts:1');
    show(async () => page(entries), true);
    return screen.findByText('子代理说的话').then(() => {
      const subs = document.querySelectorAll('[data-subagent]');
      expect(subs).toHaveLength(2);
      expect(subs[0]?.className).toContain('ml-4');
      // 连着的子代理条目只在第一条标一次
      expect(document.querySelectorAll('[data-subagent-tag]')).toHaveLength(1);
      expect(document.querySelector('[data-subagent-tag]')?.textContent).toBe('子代理 fleet-scout');
    });
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
    await screen.findByText(/先看一下/);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect((await screen.findByRole('alert')).textContent).toContain('这台没接上会话记录');
    expect(screen.getByText(/先看一下/)).toBeTruthy();
    // 失败后不再自动刷
    const seen = calls;
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(calls).toBe(seen);
  });
});

describe('会话内容：在跑的段', () => {
  test('每 3 秒用 after=nextAfter 读新的、往后追加；done 以后不再读', async () => {
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
    await screen.findByText(/先看一下/);
    expect(screen.queryByText('已提交 abc123')).toBeNull();
    expect(document.querySelector('[data-live]')).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(kinds()).toEqual(['prompt', 'assistant', 'tool_call']);
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await screen.findByText('已提交 abc123');
    expect(queries).toEqual([undefined, 1, 3]);
    expect(kinds()).toEqual([
      'prompt',
      'assistant',
      'tool_call',
      'tool_call',
      'tool_result',
      'error',
      'truncated',
      'result',
    ]);
    expect(document.querySelector('[data-live]')).toBeNull();
    const seen = read.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(read).toHaveBeenCalledTimes(seen);
  });

  test('在跑的那一段打开抽屉就读、顶上写「在跑」；人往上滚出现「跳到最新」，点了回到底部', async () => {
    show(async () => page(FULL.slice(0, 2), { done: false }), true);
    expect(await screen.findByText(/先看一下/)).toBeTruthy();
    expect(document.querySelector('[data-drawer-summary]')?.textContent).toContain('在跑');
    const box = document.querySelector('[data-transcript-body]') as HTMLElement;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 300 });
    expect(screen.queryByRole('button', { name: '跳到最新' })).toBeNull();
    box.scrollTop = 100;
    fireEvent.scroll(box);
    const jump = await screen.findByRole('button', { name: '跳到最新' });
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
  test('只画最近 200 条，上面有「显示更早的」，点一下多放出 200 条', async () => {
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
  });
});
