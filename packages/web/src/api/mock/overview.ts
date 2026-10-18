// 任务页概览和过程的演示数据（#3140）：和真后端（packages/api/src/task-overview.ts）同一个算法——
// 把会话演示数据（transcripts.ts）转成轻量行，交给 shared 的 cutSteps 切步、算小计；PR 状态按单子的状态摆。
// 网址参数 ?mockOverview=old（老后端没有这一项）、unread（会话内容读不到）演示两种「没读到」。
import {
  cutSteps,
  mergeFiles,
  type ProcessRow,
  type RunProcess,
  sumRunCounts,
  TRANSCRIPT_LIMITS,
} from '@fleet-dao/shared';
import type { TaskDetail, TranscriptEntry } from '../types';

export type MockOverviewMode = 'old' | 'unread' | undefined;

export function mockOverviewMode(search: string): MockOverviewMode {
  const v = new URLSearchParams(search).get('mockOverview');
  return v === 'old' || v === 'unread' ? v : undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** 会话条目 → 算法吃的轻量行（和库里 readRunProcessRows 取的列一致：文本按种类截短）。 */
export function processRowsOf(entries: readonly TranscriptEntry[]): ProcessRow[] {
  return entries.map((e) => ({
    seq: e.seq,
    at: e.at,
    kind: e.kind,
    ...(e.tool === undefined ? {} : { tool: e.tool }),
    ...(e.ok === undefined ? {} : { ok: e.ok }),
    text: e.kind === 'tool_result' || e.kind === 'prompt' ? '' : e.text.slice(0, 400),
    sub: e.meta?.subagent !== undefined,
    ...(num(e.meta?.added) === undefined ? {} : { added: num(e.meta?.added) as number }),
    ...(num(e.meta?.removed) === undefined ? {} : { removed: num(e.meta?.removed) as number }),
  }));
}

export function mockOverview(input: {
  mode: MockOverviewMode;
  runs: TaskDetail['segmentRuns'];
  taskState: TaskDetail['task']['state'];
  /** 这一段现在放出来的条目（在跑的段只放一部分）。 */
  entriesOf: (runId: string) => readonly TranscriptEntry[] | undefined;
  subtaskPrs: readonly number[];
}): NonNullable<TaskDetail['overview']> | undefined {
  if (input.mode === 'old') return undefined;
  const prNumbers = [
    ...new Set([
      ...input.runs.flatMap((r) => (r.prNumber === undefined ? [] : [r.prNumber])),
      ...input.subtaskPrs,
    ]),
  ].sort((a, b) => a - b);
  const prState = input.taskState === 'done' ? 'merged' : input.taskState === 'failed' ? 'failed' : 'open';
  const prsOf = (perRun: Map<string, RunProcess>) =>
    prNumbers.map((number) => {
      const runs = input.runs.filter((r) => r.prNumber === number);
      const branch = runs.map((r) => r.branch).findLast((b) => b !== undefined);
      return {
        number,
        ...(branch === undefined ? {} : { branch }),
        state: prState as 'merged' | 'failed' | 'open',
        files: mergeFiles(
          runs.flatMap((r) => (perRun.has(r.id) ? [perRun.get(r.id)?.counts.files ?? []] : [])),
        ),
      };
    });
  if (input.mode === 'unread') {
    return {
      prs: prsOf(new Map()),
      process: { state: 'unavailable', reason: '没读成：connection terminated' },
    };
  }
  const perRun = new Map<string, RunProcess>();
  const runs: Extract<NonNullable<TaskDetail['overview']>['process'], { state: 'ok' }>['runs'] = [];
  for (const r of input.runs) {
    const entries = input.entriesOf(r.id);
    if (!entries || (entries.length === 0 && !r.running)) {
      runs.push({ runId: r.id, noRecord: true });
      continue;
    }
    const p = cutSteps(processRowsOf(entries), {
      running: r.running,
      endedAt: r.endedAt,
      maxEntries: TRANSCRIPT_LIMITS.maxEntries,
    });
    perRun.set(r.id, p);
    runs.push({ runId: r.id, noRecord: false, process: p });
  }
  // 汇报取最新一笔「有记录」的（和真后端 task-overview.ts 一致）
  const recorded = new Set(runs.filter((r) => !r.noRecord).map((r) => r.runId));
  const latest = input.runs.findLast((r) => recorded.has(r.id));
  const latestEntries = latest ? input.entriesOf(latest.id) : undefined;
  const result = latestEntries?.filter((e) => e.kind === 'result' && e.meta?.subagent === undefined).at(-1);
  const said = latestEntries?.filter((e) => e.kind === 'assistant' && e.meta?.subagent === undefined).at(-1);
  const pick = result ?? said;
  return {
    prs: prsOf(perRun),
    process: {
      state: 'ok',
      runs,
      counts: sumRunCounts([...perRun.values()].map((p) => p.counts)),
      ...(latest && pick
        ? {
            report: {
              text: pick.text,
              at: pick.at,
              runId: latest.id,
              source: pick.kind === 'result' ? ('result' as const) : ('assistant' as const),
            },
          }
        : {
            reportNote:
              input.runs.length === 0
                ? '这张单还没跑过，没有汇报'
                : latest
                  ? '最新一笔还没有汇报（会话没说过话，或还没写进库）'
                  : '这张单的几笔都跑在记录会话内容之前，没有汇报',
          }),
    },
  };
}
