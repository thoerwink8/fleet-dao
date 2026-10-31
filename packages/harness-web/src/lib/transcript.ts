// 工人过程（transcript:<runId> 流，#3781）在会话页上的展示模型：纯函数，不碰 DOM。
//
// 参照了两处的做法（只学思路，没有抄代码，出处和理由见 PR 描述「参照了什么」）：
// - cc-haha 的 activityGroupModel.ts：工具调用和工具结果按 toolUseId 配对（先建 resultMap，再逐个调用去查）；连续的工具调用折叠成
//   「读了 N 个文件、跑了 M 条命令」这样的一句话摘要，按首次出现的顺序排；出错的单独计数。
// - T3 Code 的历史页：行数和字节数两道上限、按游标往老的翻（服务端在 harness-api 的 readStreamHistory）。
import { MIN_RUN, summarizeTools, TOOL_OF_EVENT } from './tool-runs';
import type { FeedEvent } from './types';

export type ToolStatus = 'running' | 'ok' | 'error' | 'noresult';

export interface ToolStep {
  kind: 'tool';
  /** 排序用的事件号：有调用取调用的，只有结果（调用在更早的页里）取结果的。 */
  id: number;
  at: string;
  toolUseId: string;
  name: string;
  summary: string;
  /** 参数 JSON（已按 1KB 截断）。 */
  input: string;
  inputTruncated: boolean;
  result?: ToolResult;
  status: ToolStatus;
}

export interface ToolResult {
  id: number;
  at: string;
  text: string;
  chars: number;
  truncated: boolean;
  isError: boolean;
}

export interface SayStep {
  kind: 'say';
  id: number;
  at: string;
  text: string;
  chars: number;
  truncated: boolean;
}

export interface EndStep {
  kind: 'end';
  id: number;
  at: string;
  subtype: string;
  isError: boolean;
  text: string;
  chars: number;
  truncated: boolean;
  durationMs: number | null;
  numTurns: number | null;
}

export interface DroppedStep {
  kind: 'dropped';
  id: number;
  at: string;
  count: number;
}

export type Step = ToolStep | SayStep | EndStep | DroppedStep;

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const isTranscriptType = (type: string): boolean => type.startsWith('transcript.');

/** 过程事件 → 步骤。输入按事件号升序；调用和结果按 toolUseId 配对，结果还没来的调用是「运行中」（整次运行已有 result 时是「无结果」）。 */
export function buildSteps(events: readonly FeedEvent[]): Step[] {
  const results = new Map<string, FeedEvent>();
  const used = new Set<string>();
  let ended = false;
  for (const e of events) {
    if (e.type === 'transcript.tool_result') results.set(s(e.payload.toolUseId), e);
    if (e.type === 'transcript.result') ended = true;
  }
  const out: Step[] = [];
  const resultOf = (e: FeedEvent): ToolResult => ({
    id: e.id,
    at: e.createdAt,
    text: s(e.payload.text),
    chars: n(e.payload.chars) ?? s(e.payload.text).length,
    truncated: e.payload.truncated === true,
    isError: e.payload.isError === true,
  });
  const useIds = new Set(
    events.filter((e) => e.type === 'transcript.tool_use').map((e) => s(e.payload.toolUseId)),
  );
  for (const e of events) {
    const p = e.payload;
    switch (e.type) {
      case 'transcript.assistant':
        out.push({
          kind: 'say',
          id: e.id,
          at: e.createdAt,
          text: s(p.text),
          chars: n(p.chars) ?? s(p.text).length,
          truncated: p.truncated === true,
        });
        break;
      case 'transcript.tool_use': {
        const toolUseId = s(p.toolUseId);
        const r = results.get(toolUseId);
        used.add(toolUseId);
        out.push({
          kind: 'tool',
          id: e.id,
          at: e.createdAt,
          toolUseId,
          name: s(p.name, '工具'),
          summary: s(p.summary),
          input: s(p.input),
          inputTruncated: p.inputTruncated === true,
          ...(r ? { result: resultOf(r) } : {}),
          status: r ? (r.payload.isError === true ? 'error' : 'ok') : ended ? 'noresult' : 'running',
        });
        break;
      }
      case 'transcript.tool_result': {
        // 调用不在已加载的范围里（往上翻之前）：只显示结果，名字未知
        const toolUseId = s(p.toolUseId);
        if (useIds.has(toolUseId) || used.has(toolUseId)) break;
        out.push({
          kind: 'tool',
          id: e.id,
          at: e.createdAt,
          toolUseId,
          name: '工具',
          summary: '（调用在更早的记录里）',
          input: '',
          inputTruncated: false,
          result: resultOf(e),
          status: p.isError === true ? 'error' : 'ok',
        });
        break;
      }
      case 'transcript.result':
        out.push({
          kind: 'end',
          id: e.id,
          at: e.createdAt,
          subtype: s(p.subtype),
          isError: p.isError === true,
          text: s(p.text),
          chars: n(p.chars) ?? s(p.text).length,
          truncated: p.truncated === true,
          durationMs: n(p.durationMs),
          numTurns: n(p.numTurns),
        });
        break;
      case 'transcript.dropped':
        out.push({ kind: 'dropped', id: e.id, at: e.createdAt, count: n(p.count) ?? 0 });
        break;
      default:
        break;
    }
  }
  return out;
}

/** 一串连续工具调用的一句话：「调了 8 个工具：Read×3、Bash×5 · 1 个出错」，按首次出现的顺序。 */
export function summarizeToolRun(steps: readonly ToolStep[]): string {
  const counts = new Map<string, number>();
  for (const st of steps) counts.set(st.name, (counts.get(st.name) ?? 0) + 1);
  const parts = [...counts].map(([name, c]) => `${name}×${c}`);
  const failed = steps.filter((st) => st.status === 'error').length;
  return `调了 ${steps.length} 个工具：${parts.join('、')}${failed > 0 ? ` · ${failed} 个出错` : ''}`;
}

export type TimelineItem =
  | { kind: 'event'; ev: FeedEvent }
  /** 连续的 MCP 工具事件（派工、进度、交结果……），#3836 已有的折叠。 */
  | { kind: 'mcp'; key: number; events: FeedEvent[]; summary: string }
  | { kind: 'say'; step: SayStep }
  | { kind: 'tool'; step: ToolStep }
  /** 连续的工人工具调用折叠成一行。 */
  | { kind: 'toolrun'; key: number; steps: ToolStep[]; summary: string; failed: number }
  | { kind: 'end'; step: EndStep }
  | { kind: 'dropped'; step: DroppedStep };

/**
 * 会话事件（进度、交结果……）和工人过程按事件号串成一条时间线（事件号是全库单调的，不同流的号可以直接比）。
 * 连续 MIN_RUN 条起的 MCP 工具事件折叠一行，连续 MIN_RUN 个起的工人工具调用折叠一行；两种折叠互不混。
 */
export function buildTimeline(
  sessionEvents: readonly FeedEvent[],
  steps: readonly Step[],
  minRun = MIN_RUN,
): TimelineItem[] {
  type Entry = { id: number; ev?: FeedEvent; step?: Step };
  const merged: Entry[] = [];
  let i = 0;
  let j = 0;
  while (i < sessionEvents.length || j < steps.length) {
    const a = sessionEvents[i];
    const b = steps[j];
    if (a && (!b || a.id < b.id)) {
      merged.push({ id: a.id, ev: a });
      i++;
    } else if (b) {
      merged.push({ id: b.id, step: b });
      j++;
    }
  }

  const out: TimelineItem[] = [];
  let mcp: FeedEvent[] = [];
  let tools: ToolStep[] = [];
  const flushMcp = () => {
    const first = mcp[0];
    if (first && mcp.length >= minRun) {
      out.push({ kind: 'mcp', key: first.id, events: mcp, summary: summarizeTools(mcp) });
    } else for (const ev of mcp) out.push({ kind: 'event', ev });
    mcp = [];
  };
  const flushTools = () => {
    const first = tools[0];
    if (first && tools.length >= minRun) {
      out.push({
        kind: 'toolrun',
        key: first.id,
        steps: tools,
        summary: summarizeToolRun(tools),
        failed: tools.filter((t) => t.status === 'error').length,
      });
    } else for (const step of tools) out.push({ kind: 'tool', step });
    tools = [];
  };
  for (const m of merged) {
    if (m.ev) {
      flushTools();
      if (m.ev.type in TOOL_OF_EVENT) mcp.push(m.ev);
      else {
        flushMcp();
        out.push({ kind: 'event', ev: m.ev });
      }
    } else if (m.step) {
      flushMcp();
      if (m.step.kind === 'tool') tools.push(m.step);
      else {
        flushTools();
        out.push({ kind: m.step.kind, step: m.step } as TimelineItem);
      }
    }
  }
  flushMcp();
  flushTools();
  return out;
}

/** 这个会话是不是某次运行的工人会话：会话号 `worker-<runId>`（派工器给工人令牌绑的就是这个号）。 */
export function runIdOfSession(sessionId: string): string | null {
  const m = /^worker-(.+)$/.exec(sessionId);
  return m?.[1] ?? null;
}

/** 指挥会话里的派工请求 / 交回核验事件，对应的工人会话号；没有对应的返回 null。 */
export function workerSessionOf(ev: FeedEvent): string | null {
  if (ev.type === 'handback.recorded') {
    const runId = s(ev.payload.runId);
    return runId ? `worker-${runId}` : null;
  }
  // 派工器起工人的运行编号 = d<派工请求的事件号>-a<第几次领取>（packages/harness-dispatch/src/dispatcher.ts）；第一次一定是 a1
  if (ev.type === 'worker.spawn.requested') return `worker-d${ev.id}-a1`;
  return null;
}
