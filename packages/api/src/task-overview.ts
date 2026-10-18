// 任务页的概览和过程（#3140）：任务详情里的 overview。
// 读 run_transcript 的轻量行（db 的 readRunProcessRows，不读整段文本），用 shared 的 cutSteps 切步、算小计；
// 关联的 PR 状态读 PR 镜像（pull_requests，不直接查 GitHub）。
// 改这里之前必须知道：
// - 读不到就写原因，不拿空、0 顶：会话内容没接上（开发环境内存版）、库读不了 → process 为 unavailable 带原因；
//   PR 镜像没读到 → 这个 PR 的 state 是 unknown 带 note；这一段跑在记录之前（结束了、一条都没有）→ noRecord。
// - 已经结束的段过程不会再变，算好的结果按 runId 记在进程里（最多 200 段，先进先出），详情靠推送重读时不重复扫库；在跑的段每次重算。
// - PR 的「改了哪些文件」来自会话里的 Edit / Write 记录，对应同一个 PR 的那几笔会话合起来；不是 GitHub 上最终的 diff。

import {
  cutSteps,
  type FileChange,
  mergeFiles,
  type ProcessRow,
  type RunProcess,
  type SegmentRunView,
  sumRunCounts,
  type TaskDetailResponse,
  TRANSCRIPT_LIMITS,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { PullRequestRecord } from '@fleet-dao/store';
import type { z } from 'zod';
import type { RunTranscriptPort } from './run-transcript.ts';

type Overview = NonNullable<z.infer<typeof TaskDetailResponse>['overview']>;
type Pr = Overview['prs'][number];

export const OVERVIEW_CACHE_MAX = 200;

/** 已结束的段的过程缓存（进程内）。 */
export function newOverviewCache(): Map<string, RunProcess> {
  return new Map();
}

export interface OverviewInput {
  runTranscript: RunTranscriptPort | undefined;
  runs: readonly SegmentRunView[];
  /** 子任务上的 PR 号（段流水里没有 PR 的补充）。 */
  subtaskPrs: readonly number[];
  getPullRequest: (number: number) => Promise<PullRequestRecord | null>;
  cache: Map<string, RunProcess>;
  log: (msg: string, fields: Record<string, unknown>) => void;
}

export const TRANSCRIPT_NOT_WIRED =
  '会话内容没接上：这里是开发环境的内存版，没有 run_transcript 这张表，真库上才有';

export async function buildOverview(input: OverviewInput): Promise<Overview> {
  const processResult = await buildProcess(input);
  const prs = await buildPrs(input, processResult.perRun);
  return { prs, process: processResult.process };
}

interface ProcessBuilt {
  process: Overview['process'];
  perRun: Map<string, RunProcess>;
}

async function buildProcess(input: OverviewInput): Promise<ProcessBuilt> {
  const perRun = new Map<string, RunProcess>();
  if (!input.runTranscript) {
    return { process: { state: 'unavailable', reason: TRANSCRIPT_NOT_WIRED }, perRun };
  }
  const { runs, cache } = input;
  // 已结束且算过的直接用缓存；其余（在跑的、第一次见的）读库
  const need = runs.filter((r) => r.running || !cache.has(r.id));
  let rows = new Map<string, ProcessRow[]>();
  try {
    if (need.length > 0) {
      const read = await input.runTranscript.processRows(need.map((r) => r.id));
      rows = new Map(
        [...read].map(([id, list]) => [
          id,
          list.map((r) => ({
            seq: r.seq,
            at: r.at.toISOString(),
            kind: r.kind,
            ...(r.tool === null ? {} : { tool: r.tool }),
            ...(r.ok === null ? {} : { ok: r.ok }),
            text: r.text,
            sub: r.sub,
            ...(r.added === null ? {} : { added: r.added }),
            ...(r.removed === null ? {} : { removed: r.removed }),
          })),
        ]),
      );
    }
  } catch (err) {
    input.log('任务过程没读成', { error: errMessage(err) });
    return { process: { state: 'unavailable', reason: `没读成：${errMessage(err)}` }, perRun };
  }
  const outRuns: Extract<Overview['process'], { state: 'ok' }>['runs'] = [];
  for (const r of runs) {
    const cached = r.running ? undefined : cache.get(r.id);
    const list = rows.get(r.id) ?? [];
    if (!cached && list.length === 0 && !r.running) {
      // 结束了、库里一条都没有：它跑在记录会话内容之前
      outRuns.push({ runId: r.id, noRecord: true });
      continue;
    }
    const proc =
      cached ??
      cutSteps(list, {
        running: r.running,
        endedAt: r.endedAt,
        maxEntries: TRANSCRIPT_LIMITS.maxEntries,
      });
    if (!r.running && !cached) remember(input.cache, r.id, proc);
    perRun.set(r.id, proc);
    outRuns.push({ runId: r.id, noRecord: false, process: proc });
  }
  const counts = sumRunCounts([...perRun.values()].map((p) => p.counts));
  // 汇报取最新一笔「有记录」的（最后一笔是跑在记录之前的老行时，往前找）
  const recorded = new Set(outRuns.filter((o) => !o.noRecord).map((o) => o.runId));
  const latest = runs.findLast((r) => recorded.has(r.id));
  let report: { text: string; at: string; runId: string; source: 'result' | 'assistant' } | undefined;
  let reportNote: string | undefined;
  if (runs.length === 0) {
    reportNote = '这张单还没跑过，没有汇报';
  } else if (!latest) {
    reportNote = '这张单的几笔都跑在记录会话内容之前，没有汇报';
  } else {
    try {
      const got = await input.runTranscript.report(latest.id);
      if (got) report = { text: got.text, at: got.at.toISOString(), runId: latest.id, source: got.kind };
      else reportNote = '最新一笔还没有汇报（会话没说过话，或还没写进库）';
    } catch (err) {
      input.log('任务最新汇报没读成', { runId: latest.id, error: errMessage(err) });
      reportNote = `最新汇报没读成：${errMessage(err)}`;
    }
  }
  return {
    process: {
      state: 'ok',
      runs: outRuns,
      counts,
      ...(report ? { report } : {}),
      ...(reportNote ? { reportNote } : {}),
    },
    perRun,
  };
}

function remember(cache: Map<string, RunProcess>, id: string, proc: RunProcess): void {
  cache.set(id, proc);
  while (cache.size > OVERVIEW_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function buildPrs(input: OverviewInput, perRun: Map<string, RunProcess>): Promise<Pr[]> {
  const numbers = new Set<number>();
  for (const r of input.runs) if (r.prNumber !== undefined) numbers.add(r.prNumber);
  for (const n of input.subtaskPrs) numbers.add(n);
  const out: Pr[] = [];
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const runsOf = input.runs.filter((r) => r.prNumber === number);
    const branch = runsOf.map((r) => r.branch).findLast((b) => b !== undefined);
    const files: FileChange[] = mergeFiles(
      runsOf.flatMap((r) => {
        const p = perRun.get(r.id);
        return p ? [p.counts.files] : [];
      }),
    );
    let state: Pr['state'] = 'unknown';
    let note: string | undefined;
    try {
      const pr = await input.getPullRequest(number);
      if (!pr) note = '库里没有这个 PR 的镜像（还没同步到，或不是本仓的 PR）';
      else if (pr.state === 'merged') state = 'merged';
      else if (pr.state === 'closed') state = 'closed';
      else state = pr.checks === 'failure' ? 'failed' : 'open';
    } catch (err) {
      note = `PR 状态没读成：${errMessage(err)}`;
    }
    out.push({
      number,
      ...(branch === undefined ? {} : { branch }),
      state,
      ...(note === undefined ? {} : { note }),
      files,
    });
  }
  return out;
}
