// 连续的工具调用折叠成一行摘要。契约里的“工具调用”就是接口层 MCP 工具落成的四种事件（派工、叫停、进度、交结果）。
import type { FeedEvent } from './types';

/** 事件类型 → 工具名（和 packages/harness-api/src/tools.ts 里注册的一致）。 */
export const TOOL_OF_EVENT: Readonly<Record<string, string>> = {
  'worker.spawn.requested': 'spawn_worker',
  'worker.stop.requested': 'stop_worker',
  'worker.progress.reported': 'report_progress',
  'worker.result.submitted': 'submit_result',
};

/** 连续几次起折叠：1、2 条直接摊开，3 条起收成一行。 */
export const MIN_RUN = 3;

export type StreamItem =
  | { kind: 'event'; ev: FeedEvent }
  | { kind: 'tools'; key: number; events: FeedEvent[]; summary: string };

export function summarizeTools(events: readonly FeedEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    const name = TOOL_OF_EVENT[e.type] ?? e.type;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts].map(([n, c]) => `${n}×${c}`);
  return `调了 ${events.length} 次工具：${parts.join('、')}`;
}

/** 把事件序列切成“单条事件”和“一串工具调用”；key 取这串第一条的事件号，新事件接在后面时不变。 */
export function groupToolRuns(events: readonly FeedEvent[], minRun = MIN_RUN): StreamItem[] {
  const out: StreamItem[] = [];
  let run: FeedEvent[] = [];
  const flush = () => {
    const first = run[0];
    if (first && run.length >= minRun) {
      out.push({ kind: 'tools', key: first.id, events: run, summary: summarizeTools(run) });
    } else {
      for (const ev of run) out.push({ kind: 'event', ev });
    }
    run = [];
  };
  for (const ev of events) {
    if (ev.type in TOOL_OF_EVENT) run.push(ev);
    else {
      flush();
      out.push({ kind: 'event', ev });
    }
  }
  flush();
  return out;
}
