// @vitest-environment happy-dom
// 任务页每一笔下面的「会话内容」（#1640）：各种条目画出来、工具调用默认折叠、没记录的文案、读失败能重试、
// 在跑的段增量往后追加（done 后不再读）、子代理的条目带标签、条目多只画最近 200 条。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { RunTranscript as Transcript, TranscriptEntry } from '../api/types';
import { renderApp } from '../test/harness';
import { groupEntries, RunTranscript, TRANSCRIPT_WINDOW } from './run-transcript';

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

function show(read: Reader, running = false) {
  const api = { ...createMockApi({ live: false }), runTranscript: read } as unknown as FleetApi;
  return renderApp(<RunTranscript taskId="t-1" runId="r-1" running={running} />, { api });
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
  test('默认收起，点开才读接口', async () => {
    const read = vi.fn<Reader>(async () => page(FULL));
    show(read);
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '会话内容' }));
    await screen.findByText('已提交 abc123');
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('完整一段：提示词、助手的话、工具调用、报错、截断、结论都画出来；工具结果默认不画', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    expect(kinds()).toEqual([
      'prompt',
      'assistant',
      'tool_call',
      'tool_call',
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

  test('工具调用默认折叠成一行，点开看到紧跟着的结果；失败的写没成', async () => {
    show(async () => page(FULL), true);
    await screen.findByText('已提交 abc123');
    const calls = screen
      .getAllByRole('button', { expanded: false })
      .filter((b) => b.textContent?.includes('Bash'));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.textContent).toContain('git status --short');
    expect(screen.queryByText(' M README.md')).toBeNull();
    fireEvent.click(calls[0] as HTMLElement);
    expect(screen.getByText('M README.md')).toBeTruthy();
    expect(calls[0]?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(calls[1] as HTMLElement);
    const failed = document.querySelectorAll('[data-kind="tool_result"]')[1] as HTMLElement;
    expect(within(failed).getByText('没成')).toBeTruthy();
    expect(failed.textContent).toContain('FAIL a.test.ts');
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
      'error',
      'truncated',
      'result',
    ]);
    expect(document.querySelector('[data-live]')).toBeNull();
    const seen = read.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(read).toHaveBeenCalledTimes(seen);
  });

  test('在跑的那一段默认展开，不用点', async () => {
    show(async () => page(FULL.slice(0, 2), { done: false }), true);
    expect(await screen.findByText(/先看一下/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '会话内容' }).getAttribute('aria-expanded')).toBe('true');
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
