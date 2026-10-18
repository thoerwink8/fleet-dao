// 任务页的概览（#3140）：任务详情里的 overview——关联 PR（带状态和改了哪些文件）、每一笔的命令计数、最新汇报、回合、引擎在会话外做的事。
// 全从现成的表读（run_transcript 的 GROUP BY、task_rounds、step_timings、pull_requests、pr_head_files），不建步骤表；
// 每一笔切好的步骤另走 GET /tasks/:taskId/runs/:runId/steps（run-transcript.ts）。
//
// 改这里之前必须知道：
// - 读不到就写原因，不拿空、0 顶：每一块都是「读到了 / 没有（带原因）/ 读不到（带原因）」，一块读不到不连累别的块。
// - 改动卡的文件和增删行数来自按头记的 numstat（pr_head_files），不来自把每次编辑的行数加起来；记的头和 PR 镜像里现在的头不一样
//   就回 unavailable 并带旧头原因；仅当前完整头的 complete 快照才回 ok。未采过、历史无 metadata、截断、失败分别带真实原因。
// - 最新汇报取最近一笔动手的最后一条主会话助手的话，不取 result（那是执行体的收场摘要，不是对人说的话）。
// - 命令计数：每一笔一行（tallyOf：在跑的笔没有结果的命令算「在跑」，收场了算「结果未知」；老记录没调用号、Mirasim 没退出码都是结果未知）。

import {
  type RunTally,
  type SegmentRunView,
  sumTallies,
  type TaskDetailResponse,
  tallyOf,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { PullRequestRecord } from '@fleet-dao/store';
import type { z } from 'zod';
import type { RunTranscriptPort } from './run-transcript.ts';

type Overview = NonNullable<z.infer<typeof TaskDetailResponse>['overview']>;
type Pr = Overview['prs'][number];

export const TRANSCRIPT_NOT_WIRED =
  '会话内容没接上：这里是开发环境的内存版，没有 run_transcript 这张表，真库上才有';

export interface OverviewInput {
  taskId: string;
  repoId: string;
  port: RunTranscriptPort | undefined;
  runs: readonly SegmentRunView[];
  /** 子任务上的 PR 号（段流水里没有 PR 的补充）。 */
  subtaskPrs: readonly number[];
  getPullRequest: (number: number) => Promise<PullRequestRecord | null>;
  log: (msg: string, fields: Record<string, unknown>) => void;
}

const unavailable = (why: unknown, what: string) => ({
  state: 'unavailable' as const,
  reason: `${what}没读成：${errMessage(why)}`,
});

export async function buildOverview(input: OverviewInput): Promise<Overview> {
  const [tally, report, rounds, engineSteps, prs] = await Promise.all([
    buildTally(input),
    buildReport(input),
    buildRounds(input),
    buildEngineSteps(input),
    buildPrs(input),
  ]);
  return { prs, tally, report, rounds, engineSteps };
}

const notWired = () => ({ state: 'unavailable' as const, reason: TRANSCRIPT_NOT_WIRED });

async function buildTally(i: OverviewInput): Promise<Overview['tally']> {
  if (!i.port) return notWired();
  try {
    const rows = await i.port.tallies(i.runs.map((r) => r.id));
    const byRun: Record<string, RunTally> = {};
    for (const r of i.runs) {
      const row = rows.get(r.id);
      if (row) byRun[r.id] = tallyOf(row, r.running);
    }
    return { state: 'ok', total: sumTallies(Object.values(byRun)), byRun };
  } catch (err) {
    i.log('任务的命令计数没读成', { taskId: i.taskId, error: errMessage(err) });
    return unavailable(err, '命令和读文件的计数');
  }
}

async function buildReport(i: OverviewInput): Promise<Overview['report']> {
  if (!i.port) return notWired();
  const manual = i.runs.findLast((r) => r.segment === 'manual');
  if (!manual) {
    return {
      state: 'none',
      reason: i.runs.length === 0 ? '这张单还没跑过' : '这张单还没有动手的会话',
    };
  }
  try {
    const say = await i.port.lastSay(manual.id);
    if (!say) {
      return { state: 'none', reason: '最近一笔动手会话还没说过话（刚起，或跑在记录会话内容之前）' };
    }
    return { state: 'ok', text: say.text, at: say.at.toISOString(), runId: manual.id };
  } catch (err) {
    i.log('任务的最新汇报没读成', { taskId: i.taskId, error: errMessage(err) });
    return unavailable(err, '最新汇报');
  }
}

async function buildRounds(i: OverviewInput): Promise<Overview['rounds']> {
  if (!i.port) return notWired();
  try {
    const rows = await i.port.rounds(i.taskId);
    return {
      state: 'ok',
      items: rows.map((r) => ({
        seq: r.seq,
        round: r.round,
        outcome: r.outcome,
        ...(r.tier === undefined ? {} : { tier: r.tier }),
        ...(r.firstModel === undefined ? {} : { firstModel: r.firstModel }),
        ...(r.addedLines === undefined ? {} : { addedLines: r.addedLines }),
        ...(r.flowMode === undefined ? {} : { flowMode: r.flowMode }),
        ...(r.startedAt === undefined ? {} : { startedAt: r.startedAt.toISOString() }),
        endedAt: r.endedAt.toISOString(),
        ...(r.reworkSummary === undefined ? {} : { reworkSummary: r.reworkSummary }),
      })),
    };
  } catch (err) {
    i.log('任务的回合没读成', { taskId: i.taskId, error: errMessage(err) });
    return unavailable(err, '回合');
  }
}

async function buildEngineSteps(i: OverviewInput): Promise<Overview['engineSteps']> {
  if (!i.port) return notWired();
  try {
    const rows = await i.port.engineSteps(i.taskId);
    return {
      state: 'ok',
      items: rows.map((r) =>
        r.kind === 'wait'
          ? {
              kind: 'wait' as const,
              waitFor: r.waitFor,
              ...(r.detail === undefined ? {} : { detail: r.detail }),
              startedAt: r.startedAt.toISOString(),
              endedAt: r.endedAt.toISOString(),
              waitMs: r.waitMs,
            }
          : {
              kind: 'activity' as const,
              activity: r.activity,
              attempt: r.attempt,
              startedAt: r.startedAt.toISOString(),
              endedAt: r.endedAt.toISOString(),
              runMs: r.runMs,
              outcome: r.outcome,
              ...(r.errorCode === undefined ? {} : { errorCode: r.errorCode }),
            },
      ),
    };
  } catch (err) {
    i.log('任务里引擎做的事没读成', { taskId: i.taskId, error: errMessage(err) });
    return unavailable(err, '引擎在会话外做的事');
  }
}

async function buildPrs(i: OverviewInput): Promise<Pr[]> {
  const numbers = new Set<number>();
  for (const r of i.runs) if (r.prNumber !== undefined) numbers.add(r.prNumber);
  for (const n of i.subtaskPrs) numbers.add(n);
  const out: Pr[] = [];
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const branch = i.runs.findLast((r) => r.prNumber === number && r.branch !== undefined)?.branch;
    let state: Pr['state'] = 'unknown';
    let note: string | undefined;
    let headSha: string | undefined;
    try {
      const pr = await i.getPullRequest(number);
      if (!pr) note = '库里没有这个 PR 的镜像（还没同步到，或不是本仓的 PR）';
      else {
        headSha = pr.headSha;
        if (pr.state === 'merged') state = 'merged';
        else if (pr.state === 'closed') state = 'closed';
        else state = pr.checks === 'failure' ? 'failed' : 'open';
      }
    } catch (err) {
      note = `PR 状态没读成：${errMessage(err)}`;
    }
    out.push({
      number,
      ...(branch === undefined ? {} : { branch }),
      state,
      ...(note === undefined ? {} : { note }),
      ...(headSha === undefined ? {} : { headSha }),
      files: await prFiles(i, number, headSha),
    });
  }
  return out;
}

async function prFiles(i: OverviewInput, number: number, prHead: string | undefined): Promise<Pr['files']> {
  if (!i.port) return { state: 'unavailable', reason: TRANSCRIPT_NOT_WIRED };
  if (prHead === undefined || !/^[0-9a-f]{40}$/.test(prHead)) {
    return { state: 'unavailable', reason: 'PR 当前完整头没读到，无法核对文件清单' };
  }
  try {
    const got = await i.port.prFiles(i.repoId, number, prHead);
    if (!got) {
      return {
        state: 'none',
        reason: '这个 PR 没有记过改了哪些文件（在记这个账之前推的，或推分支时没数成）',
      };
    }
    const snapshot =
      got.snapshot === undefined
        ? undefined
        : {
            headSha: got.snapshot.headSha,
            status: got.snapshot.status,
            total: got.snapshot.total,
            kept: got.snapshot.kept,
            recordedAt: got.snapshot.recordedAt.toISOString(),
            ...(got.snapshot.reason === null ? {} : { reason: got.snapshot.reason }),
          };
    if (got.headSha !== prHead)
      return {
        state: 'unavailable',
        reason: `当前头 ${prHead} 尚未采集，只有旧头 ${got.headSha} 的清单`,
        ...(snapshot === undefined ? {} : { snapshot }),
      };
    if (!snapshot)
      return { state: 'unavailable', reason: '旧记录没有文件快照完整性 metadata，无法确认完整清单' };
    if (snapshot.status !== 'complete')
      return { state: 'unavailable', reason: snapshot.reason ?? '文件清单采集不可用', snapshot };
    return {
      state: 'ok',
      headSha: got.headSha,
      current: true,
      items: got.files,
      snapshot,
    };
  } catch (err) {
    i.log('PR 改了哪些文件没读成', { taskId: i.taskId, number, error: errMessage(err) });
    return { state: 'unavailable', reason: `没读成：${errMessage(err)}` };
  }
}
