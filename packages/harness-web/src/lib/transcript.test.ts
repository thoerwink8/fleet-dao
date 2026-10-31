// 工人过程的展示模型（#3781）：调用和结果按 toolUseId 配对、折叠、和会话事件按事件号串起来、跳转编号。
import { describe, expect, it } from 'vitest';
import { eventsUrl, historyUrl } from './api';
import { buildSteps, buildTimeline, runIdOfSession, summarizeToolRun, workerSessionOf } from './transcript';
import type { FeedEvent } from './types';

let id = 0;
const ev = (type: string, payload: Record<string, unknown>, at = id + 1): FeedEvent => ({
  id: ++id,
  seq: id,
  type,
  payload,
  createdAt: new Date(2026, 9, 31, 12, 0, at).toISOString(),
});
const use = (toolUseId: string, name = 'Bash') =>
  ev('transcript.tool_use', {
    runId: 'r',
    toolUseId,
    name,
    summary: `${name} 摘要`,
    input: '{"a":1}',
    inputTruncated: false,
  });
const res = (toolUseId: string, isError = false, text = '输出') =>
  ev('transcript.tool_result', {
    runId: 'r',
    toolUseId,
    isError,
    text,
    truncated: false,
    chars: text.length,
  });
const say = (text: string) =>
  ev('transcript.assistant', { runId: 'r', text, truncated: false, chars: text.length });
const progress = (summary: string) => ev('worker.progress.reported', { summary });

describe('buildSteps：调用和结果配对', () => {
  it('按 toolUseId 配对：结果夹在别的调用后面也配得上；出错标出错；没结果的是运行中', () => {
    const steps = buildSteps([
      say('开始'),
      use('a'),
      use('b', 'Read'),
      res('b'),
      res('a', true, '炸了'),
      use('c'),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['say', 'tool', 'tool', 'tool']);
    const tools = steps.filter((s) => s.kind === 'tool');
    expect(tools.map((t) => [t.toolUseId, t.status])).toEqual([
      ['a', 'error'],
      ['b', 'ok'],
      ['c', 'running'],
    ]);
    expect(tools[0]?.kind === 'tool' && tools[0].result?.text).toBe('炸了');
  });

  it('整次运行已经有 result：还没结果的调用是「无结果」，不再是运行中', () => {
    const steps = buildSteps([
      use('a'),
      ev('transcript.result', {
        runId: 'r',
        subtype: 'success',
        isError: false,
        text: '完',
        truncated: false,
        chars: 1,
        durationMs: 1000,
        numTurns: 2,
      }),
    ]);
    expect(steps[0]).toMatchObject({ kind: 'tool', status: 'noresult' });
    expect(steps[1]).toMatchObject({ kind: 'end', durationMs: 1000, numTurns: 2 });
  });

  it('调用在更早的页里（还没往上翻）：只有结果也显示一行，不丢', () => {
    const steps = buildSteps([res('old', false, '半截的结果')]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'tool', name: '工具', status: 'ok' });
  });

  it('丢弃提示、不认识的过程类型：前者显示、后者跳过', () => {
    const steps = buildSteps([
      ev('transcript.dropped', { runId: 'r', count: 7 }),
      ev('transcript.future', {}),
    ]);
    expect(steps).toEqual([expect.objectContaining({ kind: 'dropped', count: 7 })]);
  });
});

describe('buildTimeline：折叠和串联', () => {
  it('连续 3 次起的工具调用折叠，不够的摊开；摘要带名字计数和出错数', () => {
    const events = [
      use('1', 'Read'),
      res('1'),
      use('2', 'Read'),
      res('2'),
      use('3', 'Bash'),
      res('3', true),
      say('中间一句'),
      use('4'),
      res('4'),
      use('5'),
      res('5'),
    ];
    const items = buildTimeline([], buildSteps(events));
    expect(items.map((i) => i.kind)).toEqual(['toolrun', 'say', 'tool', 'tool']);
    const run = items[0];
    expect(run?.kind === 'toolrun' && run.summary).toBe('调了 3 个工具：Read×2、Bash×1 · 1 个出错');
    expect(run?.kind === 'toolrun' && run.failed).toBe(1);
  });

  it('会话里的进度和过程按事件号交错；进度把两串工具调用隔开，各自折叠', () => {
    const t1 = [use('1'), res('1'), use('2'), res('2'), use('3'), res('3')];
    const p = progress('进度一');
    const t2 = [use('4'), res('4'), use('5'), res('5'), use('6'), res('6')];
    // 事件号：先是 t1 的六条、再是进度、再是 t2 的六条（id 全库单调）
    const items = buildTimeline([p], buildSteps([...t1, ...t2]));
    expect(items.map((i) => i.kind)).toEqual(['toolrun', 'event', 'toolrun']);
  });

  it('连续的 MCP 事件（进度×3）还是折叠成一行；和工人工具调用互不混', () => {
    const p = [progress('a'), progress('b'), progress('c')];
    const items = buildTimeline(p, []);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('mcp');
    // 夹在工具调用中间就不连续了
    const before = progress('前');
    const steps = buildSteps([use('9'), res('9')]);
    const after = progress('后');
    const mixed = buildTimeline([before, after], steps);
    expect(mixed.map((i) => i.kind)).toEqual(['event', 'tool', 'event']);
  });

  it('输出里每一项的事件号严格递增', () => {
    const items = buildTimeline([progress('x')], buildSteps([say('s'), use('1'), res('1')]));
    const ids = items.flatMap((i) =>
      i.kind === 'event' ? [i.ev.id] : i.kind === 'say' || i.kind === 'tool' ? [i.step.id] : [],
    );
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('summarizeToolRun 不出错就不带出错数', () => {
    const steps = buildSteps([use('1'), res('1'), use('2'), res('2')]).filter((s) => s.kind === 'tool');
    expect(summarizeToolRun(steps as never)).toBe('调了 2 个工具：Bash×2');
  });
});

describe('跳转：指挥会话 ↔ 工人会话', () => {
  it('工人会话号 worker-<runId> 取出 runId；别的会话没有', () => {
    expect(runIdOfSession('worker-d12-a1')).toBe('d12-a1');
    expect(runIdOfSession('cmd-demo-login-fix')).toBeNull();
  });

  it('交回核验用载荷里的 runId；派工请求按 d<事件号>-a1 推；别的事件没有', () => {
    const hb: FeedEvent = {
      id: 9,
      seq: 9,
      type: 'handback.recorded',
      payload: { runId: 'd7-a2' },
      createdAt: '',
    };
    expect(workerSessionOf(hb)).toBe('worker-d7-a2');
    expect(workerSessionOf({ ...hb, payload: {} })).toBeNull();
    const sp: FeedEvent = { id: 41, seq: 1, type: 'worker.spawn.requested', payload: {}, createdAt: '' };
    expect(workerSessionOf(sp)).toBe('worker-d41-a1');
    expect(workerSessionOf({ ...sp, type: 'worker.progress.reported' })).toBeNull();
  });
});

describe('过程流的地址', () => {
  it('transcripts/<runId>/history|events，会话流的地址不变', () => {
    expect(historyUrl('/b', 'd1-a1', { before: 5, limit: 50 }, 'transcripts')).toBe(
      '/b/transcripts/d1-a1/history?before=5&limit=50',
    );
    expect(eventsUrl('/b', 'd1-a1', 'transcripts')).toBe('/b/transcripts/d1-a1/events');
    expect(historyUrl('/b', 's', {})).toBe('/b/sessions/s/history');
    expect(eventsUrl('/b', 's')).toBe('/b/sessions/s/events');
  });
});
