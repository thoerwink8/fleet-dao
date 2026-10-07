// @vitest-environment happy-dom
// 任务详情「时间与用量」和会话时间线（#216）：每条「没读到」的显示都故意造一次没读到的数据，看页面怎么说。
// 原来的两个坑——token 合计把没读到的当 0 加、花费合计是 0 就写「没有按量花费」（cursor 走订阅没报花费会被说成不花钱）——
// 各钉一条。数照真后端的路子来：会话列表 + shared 的 summarizeUsage 算出的 usage，再过一遍接口约定。
import { summarizeUsage, TaskDetailResponse } from '@fleet-dao/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { Run, TaskDetail } from '../api/types';
import { RunTimeline } from '../components/run-timeline';
import { UsagePanel } from '../components/usage';

afterEach(cleanup);

const NOW = Date.parse('2026-09-27T03:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

let seq = 0;
/** 一次结束了的会话：四样 token、花费都读到（Claude 订阅，套餐内）。 */
function run(over: Partial<Run> = {}): Run {
  return {
    id: `run-${++seq}`,
    stage: 'execute',
    routeId: 'r-opus',
    modelName: 'Opus 5.5',
    whyRoute: '写码阶段排第一',
    queuedAt: at(-30),
    startedAt: at(-29),
    endedAt: at(-19),
    outcome: 'ok',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 2000,
    costUsd: 0.25,
    billing: 'subscription',
    ...over,
  };
}

function without(r: Run, ...keys: (keyof Run)[]): Run {
  const copy: Record<string, unknown> = { ...r };
  for (const k of keys) delete copy[k];
  return copy as Run;
}

/** 照真后端的路子拼任务详情：usage 由 shared 的 summarizeUsage 按路由上的模型算，整个返回过一遍接口约定。 */
function detail(runs: Run[]): TaskDetail {
  return TaskDetailResponse.parse({
    task: {
      id: 't-1',
      repoId: 'r-1',
      issueNumber: 1,
      title: '样例',
      rawRequest: '样例',
      requestedBy: 'u-1',
      state: 'running',
      priority: 1,
      createdAt: at(-60),
    },
    repo: { id: 'r-1', owner: 'acme', name: 'orbit', defaultBranch: 'main' },
    subtasks: [],
    runs,
    segmentRuns: [],
    usage: summarizeUsage(runs.map((r) => ({ ...r, model: r.routeId, modelName: r.modelName }))),
    routePins: { pins: [] },
  });
}

function dtOf(label: string): Element {
  const dt = [...document.querySelectorAll('dt')].find((d) => d.firstChild?.textContent === label);
  if (!dt) throw new Error(`面板里没有「${label}」这一项`);
  return dt;
}

/** 面板里某一项（标签 + 数 + 补充说明）的全部文字。 */
function figure(label: string): string {
  return dtOf(label).parentElement?.textContent ?? '';
}

/** 面板里某一项的数那一格（不含补充说明）。 */
function shownValue(label: string): string {
  return dtOf(label).nextElementSibling?.firstElementChild?.textContent ?? '';
}

describe('任务详情「时间与用量」：读到的照数写，没读到的写明几次，不当成 0', () => {
  test('token 有一次没读到：只加读到的、标「不全」、写明另有 1 次没读到（原来把没读到的当 0 加进合计）', () => {
    render(<UsagePanel d={detail([run(), without(run(), 'inputTokens', 'outputTokens')])} now={NOW} />);
    const tokens = figure('token');
    expect(tokens).toContain('不全');
    expect(tokens).toContain('输入 1,000');
    expect(tokens).toContain('输出 500');
    expect(tokens).toContain('另有 1 次没读到，没算进来');
    // 当量也折不成那一次：同样标不全
    expect(figure('输入当量')).toContain('不全');
    expect(figure('输入当量')).toContain('9,000');
  });

  test('token、缓存、当量一次都没读到：写「没读到」和几次，不写 0', () => {
    const blank = without(
      run(),
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    );
    render(<UsagePanel d={detail([blank, { ...blank, id: 'run-b' }])} now={NOW} />);
    for (const label of ['输入当量', 'token', '缓存']) {
      expect(shownValue(label), label).toBe('没读到');
      expect(figure(label), label).toContain('2 次会话都没读到');
    }
    expect(shownValue('套餐内')).toBe('没读到');
  });

  test('缓存读写没存下来的老会话：token 照数写，缓存和当量写没读到', () => {
    render(<UsagePanel d={detail([without(run(), 'cacheReadTokens', 'cacheWriteTokens')])} now={NOW} />);
    expect(figure('token')).toContain('输入 1,000');
    expect(figure('token')).not.toContain('不全');
    expect(figure('缓存')).toContain('1 次会话都没读到');
    expect(figure('输入当量')).toContain('没读到');
  });

  test('花费：cursor 走订阅、不报花费——写套餐内没读到，不再说「没有按量花费」', () => {
    const cursor = without(run({ routeId: 'r-cursor', modelName: 'Cursor Auto' }), 'costUsd');
    const { container } = render(<UsagePanel d={detail([cursor])} now={NOW} />);
    expect(container.textContent).not.toContain('没有按量花费');
    expect(figure('套餐内')).toContain('没读到');
    expect(figure('套餐内')).toContain('1 次会话都没读到');
    // 按量那栏说的是事实：这张单没有走按量的会话
    expect(figure('按量')).toContain('没有走按量的会话');
  });

  test('花费：套餐内的写「折合」、按量的另起一行；有一次没读到的标「不全」', () => {
    render(
      <UsagePanel
        d={detail([
          run(),
          without(run(), 'costUsd'),
          run({ routeId: 'r-ds', modelName: 'DeepSeek', billing: 'metered', costUsd: 0.04 }),
        ])}
        now={NOW}
      />,
    );
    expect(figure('按量')).toContain('$0.04');
    expect(figure('按量')).not.toContain('不全');
    const sub = figure('套餐内');
    expect(sub).toContain('折合 $0.25');
    expect(sub).toContain('不全');
    expect(sub).toContain('另有 1 次没读到');
    expect(sub).toContain('不另花钱');
  });

  test('缓存有一次没读到：照数写读到的那几次，标「不全」、写明另有 1 次', () => {
    render(<UsagePanel d={detail([run(), without(run(), 'cacheWriteTokens')])} now={NOW} />);
    const cache = figure('缓存');
    expect(cache).toContain('不全');
    expect(cache).toContain('读 3.0 万');
    expect(cache).toContain('写 2,000');
    expect(cache).toContain('另有 1 次没读到，没算进来');
    expect(figure('token')).not.toContain('不全');
  });

  test('花费：按量有一次没报——照数写读到的、标「不全」；渠道查不到又没报的——「分不清」那栏写没读到', () => {
    render(
      <UsagePanel
        d={detail([
          run({ billing: 'metered', costUsd: 0.04 }),
          without(run({ billing: 'metered' }), 'costUsd'),
          without(run(), 'billing', 'costUsd'),
        ])}
        now={NOW}
      />,
    );
    expect(shownValue('按量')).toContain('$0.04');
    expect(figure('按量')).toContain('不全');
    expect(figure('按量')).toContain('另有 1 次没读到');
    expect(shownValue('分不清')).toBe('没读到');
    expect(figure('分不清')).toContain('1 次会话都没读到');
  });

  test('花费：按量的会话没报花费——按量那栏写没读到，不写 $0.00', () => {
    render(<UsagePanel d={detail([without(run({ billing: 'metered' }), 'costUsd')])} now={NOW} />);
    expect(figure('按量')).toContain('没读到');
    expect(figure('按量')).not.toContain('$0.00');
  });

  test('花费：渠道查不到（没有计费方式）——另起一行「分不清」，不猜成套餐内', () => {
    render(<UsagePanel d={detail([without(run(), 'billing')])} now={NOW} />);
    expect(figure('分不清')).toContain('$0.25');
    expect(figure('分不清')).toContain('渠道查不到');
    expect(figure('按量')).toContain('查得到渠道的会话里没有按量的');
    expect([...document.querySelectorAll('dt')].some((d) => d.textContent === '套餐内')).toBe(false);
  });

  test('时长：时刻倒着（结束早于开工）的那次写明认不出、标不全，不当成 0 秒', () => {
    render(<UsagePanel d={detail([run(), run({ startedAt: at(-10), endedAt: at(-20) })])} now={NOW} />);
    expect(figure('干活合计')).toContain('不全');
    expect(figure('干活合计')).toContain('另有 1 次时刻认不出');
  });

  test('时长：唯一一次会话时刻认不出——排队、干活合计写「没读到」，不写 1 秒', () => {
    render(<UsagePanel d={detail([run({ startedAt: at(-10), endedAt: at(-20) })])} now={NOW} />);
    for (const label of ['排队合计', '干活合计']) {
      expect(shownValue(label), label).toBe('没读到');
      expect(figure(label), label).toContain('1 次会话都时刻认不出');
    }
  });

  test('只有在跑的会话：写「会话结束后才有数」，不写没读到', () => {
    const live = without(run(), 'endedAt', 'outcome', 'inputTokens', 'outputTokens', 'costUsd');
    render(<UsagePanel d={detail([live])} now={NOW} />);
    for (const label of ['输入当量', 'token', '缓存']) {
      expect(shownValue(label), label).toBe('会话结束后才有数');
      expect(figure(label), label).not.toContain('没读到');
    }
    expect(figure('干活合计')).toContain('含在跑的 1 个，算到现在');
    expect(screen.getByText('会话结束后才有数', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Opus 5.5').closest('li')?.textContent).toContain('在跑，用量等它结束才有');
  });

  test('按模型、按阶段分开看：一组里有没读到的写「不全：N 次没读到」', () => {
    render(
      <UsagePanel
        d={detail([
          run({ stage: 'plan' }),
          without(run({ stage: 'execute' }), 'costUsd'),
          run({ stage: 'review', routeId: 'r-grok', modelName: 'Grok 4.7', costUsd: undefined }),
        ])}
        now={NOW}
      />,
    );
    const opus = screen.getByText('Opus 5.5').closest('li')?.textContent ?? '';
    expect(opus).toContain('2 个会话');
    expect(opus).toContain('套餐内折合 $0.25');
    expect(opus).toContain('（不全：1 次没读到）');
    const grok = screen.getByText('Grok 4.7').closest('li')?.textContent ?? '';
    expect(grok).toContain('套餐内 · 花费没读到');

    fireEvent.click(screen.getByRole('tab', { name: '按阶段' }));
    expect(screen.getByText('写码').closest('li')?.textContent).toContain('套餐内 · 花费没读到');
    expect(screen.getByText('方案').closest('li')?.textContent).toContain('套餐内折合 $0.25');
  });
});

describe('会话时间线：一次会话的用量照同一个算法写', () => {
  function rowOf(text: string): string {
    const li = screen.getByText(text, { exact: false }).closest('li');
    if (!li) throw new Error(`时间线里没有「${text}」这一行`);
    return li.textContent ?? '';
  }

  test('没交终帧就断了：写「token 和缓存都没读到」「套餐内 · 花费没读到」，不写 0 token', () => {
    const blank = without(
      run({ outcome: 'failed', whyRoute: '断了的那次' }),
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    );
    render(<RunTimeline runs={[blank]} routing={undefined} now={NOW} />);
    const row = rowOf('断了的那次');
    expect(row).toContain('token 和缓存都没读到');
    expect(row).toContain('套餐内 · 花费没读到');
    expect(row).not.toMatch(/\b0 token/);
  });

  test('缓存没存下来：写 token 数和「缓存没读到，折不成当量」', () => {
    render(
      <RunTimeline
        runs={[without(run({ whyRoute: '老会话' }), 'cacheReadTokens', 'cacheWriteTokens')]}
        routing={undefined}
        now={NOW}
      />,
    );
    const row = rowOf('老会话');
    expect(row).toContain('1,500 token');
    expect(row).toContain('缓存没读到，折不成当量');
  });

  test('读到的照数写：当量；按量写「按量 $…」，套餐内写「套餐内折合 $…」', () => {
    render(
      <RunTimeline
        runs={[
          run({ whyRoute: '订阅那次' }),
          run({ whyRoute: '按量那次', billing: 'metered', costUsd: 0.0038, queuedAt: at(-18) }),
        ]}
        routing={undefined}
        now={NOW}
      />,
    );
    expect(rowOf('订阅那次')).toContain('当量 9,000');
    expect(rowOf('订阅那次')).toContain('套餐内折合 $0.25');
    expect(rowOf('按量那次')).toContain('按量 $0.0038');
  });

  test('按量没报花费：写「按量 · 花费没读到」', () => {
    render(
      <RunTimeline
        runs={[without(run({ whyRoute: '按量没报', billing: 'metered' }), 'costUsd')]}
        routing={undefined}
        now={NOW}
      />,
    );
    expect(rowOf('按量没报')).toContain('按量 · 花费没读到');
  });

  test('时刻倒着（结束早于开工）：写「时刻认不出，时长没读到」', () => {
    render(
      <RunTimeline
        runs={[run({ whyRoute: '时刻坏了', startedAt: at(-10), endedAt: at(-20) })]}
        routing={undefined}
        now={NOW}
      />,
    );
    expect(rowOf('时刻坏了')).toContain('时刻认不出，时长没读到');
  });

  test('结束了却没开工：标「没起来」，不标「排队中」', () => {
    const never = without(
      run({ whyRoute: '没起来那次', outcome: 'failed' }),
      'startedAt',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    );
    render(<RunTimeline runs={[never]} routing={undefined} now={NOW} />);
    const row = rowOf('没起来那次');
    expect(row).toContain('没起来');
    expect(row).not.toContain('排队中');
  });

  test('还在跑：只写时长，不写用量，也不写没读到', () => {
    const live = without(
      run({ whyRoute: '在跑那次', startedAt: at(-5) }),
      'endedAt',
      'outcome',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
    );
    render(<RunTimeline runs={[live]} routing={undefined} now={NOW} />);
    const row = rowOf('在跑那次');
    expect(row).toContain('干活 5 分钟');
    expect(row).not.toContain('没读到');
    expect(row).not.toContain('token');
  });
});
