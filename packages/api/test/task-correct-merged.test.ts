// 合成的 #3114 反例：只在判断和读取替身上走，不连生产库、不发信号。
import { sessionLinkHolds, sessionLinkRefusal } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { TaskCliError } from '../src/task-cli.ts';
import {
  type CorrectionRequest,
  type CorrectMergedSnapshot,
  correctionIdentity,
  decideCorrection,
  type LedgerTask,
  sameReceipt,
} from '../src/task-correct-merged.ts';
import { parseCorrectMergedArgs, readGitHubCorrection } from '../src/task-correct-merged-cli.ts';
import { readCorrectMergedExecution } from '../src/temporal.ts';

const REPO = { owner: 'thoerwink8', name: 'fleet-dao' };
const HEAD = '5b52006a9cdcef60c030c5dbeec645f81a2ad86a';
const MERGE = 'bfe1b1ae69c7ae6404b068eb3ed7bde3082b3e40';
const WF = 'task:thoerwink8/fleet-dao#3114';
const RUN = '01a14fd8-fb57-741a-8c14-42e3fdba87d6';
const TASK = 'd629758a-570d-405d-be00-417b7ee6c0c7';

const req: CorrectionRequest = {
  repo: REPO,
  issueNumber: 3114,
  prNumber: 3137,
  head: HEAD,
  mergeCommit: MERGE,
  workflowId: WF,
  runId: RUN,
};

const task: LedgerTask = {
  id: TASK,
  repo: REPO,
  issueNumber: 3114,
  state: 'stopped',
  phase: 'abandoned',
  executor: 'engine',
  updatedAtMs: Date.parse('2026-10-19T01:52:06.446Z'),
  openRunCount: 0,
  startPending: false,
};

function snap(patch: Partial<CorrectMergedSnapshot> = {}): CorrectMergedSnapshot {
  return {
    task,
    sessions: [{ workflowId: WF, prNumber: 3137, temporalRunId: null, ended: true }],
    mirror: null,
    corrections: [],
    issue: { number: 3114, repo: REPO, isPullRequest: false },
    pull,
    execution: {
      generations: [{ workflowId: WF, generation: 1, runId: RUN, status: 'COMPLETED' }],
      matched: {
        workflowId: WF,
        runId: RUN,
        status: 'COMPLETED',
        result: { outcome: 'abandoned', prNumber: 3137, head: HEAD },
      },
    },
    ...patch,
  };
}

const pull = {
  repo: REPO,
  number: 3137,
  merged: true,
  head: HEAD,
  mergeCommit: MERGE,
};

function reason(operator: string, request: CorrectionRequest, facts: CorrectMergedSnapshot): string {
  const decision = decideCorrection(operator, request, facts);
  expect(decision.ok).toBe(false);
  return decision.ok ? '' : decision.reason;
}

describe('decideCorrection', () => {
  it('合成反例可以纠正，回执带上原 abandoned 和真实交付', () => {
    const decision = decideCorrection('founder', req, snap());
    expect(decision.ok).toBe(true);
    if (!decision.ok || decision.kind !== 'correct') throw new Error(JSON.stringify(decision));
    expect(decision.before).toEqual({ state: 'stopped', phase: 'abandoned' });
    expect(decision.after).toEqual({ state: 'done', phase: 'merged' });
    expect(decision.receiptAfter).toMatchObject({
      repo: 'thoerwink8/fleet-dao',
      issue: 3114,
      taskId: TASK,
      pr: 3137,
      head: HEAD,
      mergeCommit: MERGE,
      workflowId: WF,
      runId: RUN,
    });
  });

  it('未授权在别的事实之前拒绝，重复调用也一样', () => {
    const done = snap({ task: { ...task, state: 'done', phase: 'merged' } });
    expect(reason('', req, done)).toContain('未授权');
    expect(reason('  founder', req, snap())).toContain('未授权');
    expect(reason(`bad\nname`, req, snap())).toContain('未授权');
    expect(reason('x'.repeat(65), req, snap())).toContain('未授权');
  });

  it('活跃会话数不是非负安全整数时拒绝，不当成没有会话', () => {
    expect(reason('founder', req, snap({ task: { ...task, openRunCount: Number.NaN } }))).toContain(
      '活跃会话数未知',
    );
    expect(reason('founder', req, snap({ task: { ...task, openRunCount: -1 } }))).toContain('活跃会话数未知');
    expect(reason('founder', req, snap({ task: { ...task, openRunCount: 1.5 } }))).toContain(
      '活跃会话数未知',
    );
    expect(reason('founder', req, snap({ task: { ...task, openRunCount: 1 } }))).toContain('活跃会话');
  });

  // 还没合并、错 head、错 merge、本机执行、issue 读不到或是 PR：见真实装配测试的拒绝表
  it('交付对不上就拒绝', () => {
    const other = { owner: 'other', name: 'x' };
    expect(reason('founder', req, snap({ pull: null }))).toContain('读不到 GitHub');
    expect(reason('founder', req, snap({ pull: { ...pull, repo: other } }))).toContain('错仓');
    expect(reason('founder', req, snap({ pull: { ...pull, number: 1 } }))).toContain('错 PR');
    expect(reason('founder', req, snap({ task: null }))).toContain('库里没有');
    expect(reason('founder', req, snap({ task: { ...task, repo: other } }))).toContain('错仓或错单');
  });

  it('原执行必须是这一代、已完成、abandoned，而且会话账钉得住；起代结果未知就拒绝', () => {
    const exec = (status: string, runId = RUN, result: unknown = null, more: object[] = []) =>
      snap({
        execution: {
          generations: [{ workflowId: WF, generation: 1, runId, status }, ...(more as never[])],
          matched: { workflowId: WF, runId, status, result: result as never },
        },
      });
    const abandoned = { outcome: 'abandoned', prNumber: 3137, head: HEAD };
    const second = { workflowId: `${WF}:r2`, generation: 2, runId: 'other-run', status: 'COMPLETED' };
    expect(reason('founder', req, exec('RUNNING'))).toContain('仍在运行');
    expect(reason('founder', req, exec('COMPLETED', RUN, abandoned, [second]))).toContain('新的一代');
    expect(reason('founder', req, exec('FAILED'))).toContain('不是已完成');
    expect(reason('founder', req, exec('COMPLETED', 'other-run'))).toContain('错 run');
    expect(reason('founder', req, exec('COMPLETED'))).toContain('原执行结果读不到');
    expect(reason('founder', req, exec('COMPLETED', RUN, { ...abandoned, outcome: 'merged' }))).toContain(
      '不是 abandoned',
    );
    const session = (prNumber: number, temporalRunId: string | null) =>
      snap({ sessions: [{ workflowId: WF, prNumber, temporalRunId, ended: true }] });
    expect(reason('founder', req, session(1, null))).toContain('歧义');
    expect(reason('founder', req, session(3137, 'other'))).toContain('无证据');
    expect(reason('founder', req, snap({ task: { ...task, startPending: true } }))).toContain('结果未知');
  });

  it('同一工作流另有不同 PR 的会话就拒绝，旧行没记 run 时写明歧义，不能靠一条匹配记录或已有回执放行', () => {
    const matching = { workflowId: WF, prNumber: 3137, temporalRunId: null, ended: true };
    const otherPr = { workflowId: WF, prNumber: 99999, temporalRunId: null, ended: true };
    expect(sessionLinkHolds([matching, otherPr], WF, 3137, RUN)).toBe(false);
    const ambiguous = sessionLinkRefusal([matching, otherPr], WF, 3137, RUN);
    expect(ambiguous).toContain('歧义');
    expect(ambiguous).toContain('不能当作同一次执行的证据');
    expect(reason('founder', req, snap({ sessions: [matching, otherPr] }))).toBe(ambiguous);
    const recorded = { ...otherPr, temporalRunId: RUN };
    expect(sessionLinkHolds([matching, recorded], WF, 3137, RUN)).toBe(false);
    expect(sessionLinkRefusal([{ ...matching, temporalRunId: RUN }, recorded], WF, 3137, RUN)).toContain(
      '不能任取一条',
    );
    expect(sessionLinkHolds([matching, { ...otherPr, ended: false }], WF, 3137, RUN)).toBe(false);
    // 单条、重复同 PR、空 PR、别的工作流上的旧 PR 都不否决
    for (const extra of [
      [],
      [matching],
      [{ ...matching, prNumber: null }],
      [{ ...otherPr, workflowId: `${WF}:r2` }],
    ]) {
      expect(sessionLinkHolds([matching, ...extra], WF, 3137, RUN)).toBe(true);
    }

    const identity = correctionIdentity(req, TASK);
    const receipt = {
      before: { state: 'stopped', phase: 'abandoned' },
      after: { state: 'done', phase: 'merged', ...identity },
    };
    const repeat = decideCorrection(
      'founder',
      req,
      snap({
        task: { ...task, state: 'done', phase: 'merged' },
        sessions: [matching, otherPr],
        corrections: [receipt],
      }),
    );
    expect(repeat.ok).toBe(false);
    if (!repeat.ok) {
      expect(repeat.reason).toContain('歧义');
      expect(repeat.reason).toContain('不能当作同一次执行的证据');
    }
  });

  it('镜像没有不挡；对不上就拒绝。空的 issueRefs 不是矛盾', () => {
    const mirror = {
      number: 3137,
      headSha: HEAD,
      mergeSha: MERGE,
      issueRefs: [] as number[],
      state: 'merged',
    };
    expect(decideCorrection('founder', req, snap()).ok).toBe(true);
    expect(decideCorrection('founder', req, snap({ mirror })).ok).toBe(true);
    const bad = (patch: object) => reason('founder', req, snap({ mirror: { ...mirror, ...patch } }));
    expect(bad({ headSha: 'a'.repeat(40), state: 'open' })).toContain('错 head');
    expect(bad({ mergeSha: 'b'.repeat(40), issueRefs: [3114] })).toContain('错 merge');
    expect(bad({ mergeSha: null, issueRefs: [1] })).toContain('镜像没有挂这张单');
  });

  it('幂等只认同一条回执；错对象、另一条 run、没有回执都不算已纠正', () => {
    const identity = correctionIdentity(req, TASK);
    const receipt = {
      before: { state: 'stopped', phase: 'abandoned' },
      after: { state: 'done', phase: 'merged', ...identity },
    };
    const done = { ...task, state: 'done', phase: 'merged' };
    expect(decideCorrection('founder', req, snap({ task: done, corrections: [receipt] }))).toMatchObject({
      ok: true,
      kind: 'already',
    });
    expect(reason('founder', req, snap({ task: done, corrections: [] }))).toContain('审计回执');
    const other = correctionIdentity({ ...req, runId: 'other-run' }, TASK);
    const otherReceipt = {
      before: receipt.before,
      after: { state: 'done', phase: 'merged', ...other },
    };
    expect(reason('founder', req, snap({ task: done, corrections: [otherReceipt] }))).toContain('审计回执');
    expect(reason('founder', req, snap({ corrections: [receipt] }))).toContain('审计和任务状态');
    expect(reason('founder', req, snap({ task: { ...task, state: 'running', phase: null } }))).toContain(
      '不是误记',
    );
    expect(reason('founder', req, snap({ task: { ...task, updatedAtMs: null } }))).toContain('更新时间');
    expect(sameReceipt({ before: receipt.before, after: { ...receipt.after, extra: true } }, identity)).toBe(
      false,
    );
  });
});

describe('readCorrectMergedExecution', () => {
  function client(
    rows: Record<
      string,
      { runId: string; status: string; result?: unknown; missing?: boolean; boom?: boolean }
    >,
  ) {
    const resultCalls: string[] = [];
    const signals: string[] = [];
    return {
      resultCalls,
      signals,
      connection: {
        withDeadline: <T>(_deadline: number, fn: () => Promise<T>) => fn(),
      },
      workflow: {
        getHandle(workflowId: string, runId?: string) {
          return {
            signal: () => {
              signals.push(workflowId);
              throw new Error('不应发信号');
            },
            describe: async () => {
              const row = rows[workflowId];
              if (!row || row.missing) {
                const error = new Error('missing');
                error.name = 'WorkflowNotFoundError';
                throw error;
              }
              if (row.boom) throw new Error('temporal down');
              return { workflowId, runId: row.runId, status: { name: row.status } };
            },
            result: async () => {
              resultCalls.push(`${workflowId}/${runId ?? ''}`);
              const row = rows[workflowId];
              if (!row || row.result === undefined) throw new Error('result down');
              return row.result;
            },
          };
        },
      },
    };
  }

  const input = { repo: REPO, issueNumber: 3114, workflowId: WF, runId: RUN };

  it('还在跑或 run 不对时不读 result，也不发信号', async () => {
    const running = client({
      [WF]: { runId: RUN, status: 'RUNNING', result: { outcome: 'abandoned', prNumber: 3137, head: HEAD } },
    });
    const read = await readCorrectMergedExecution(running, input);
    expect(read.matched?.status).toBe('RUNNING');
    expect(read.matched?.result).toBeNull();
    expect(running.resultCalls).toEqual([]);
    expect(running.signals).toEqual([]);
    const other = client({
      [WF]: {
        runId: 'other-run',
        status: 'COMPLETED',
        result: { outcome: 'abandoned', prNumber: 3137, head: HEAD },
      },
    });
    const again = await readCorrectMergedExecution(other, input);
    expect(again.matched?.runId).toBe('other-run');
    expect(again.matched?.result).toBeNull();
    expect(other.resultCalls).toEqual([]);
  });

  it('已完成且 run 对得上才读结果；形状不对留空；不存在就停', async () => {
    const ok = client({
      [WF]: {
        runId: RUN,
        status: 'COMPLETED',
        result: { outcome: 'abandoned', prNumber: 3137, head: HEAD, rounds: 1 },
      },
    });
    const read = await readCorrectMergedExecution(ok, input);
    expect(read.matched?.result).toEqual({ outcome: 'abandoned', prNumber: 3137, head: HEAD });
    expect(ok.resultCalls).toEqual([`${WF}/${RUN}`]);
    const bad = client({ [WF]: { runId: RUN, status: 'COMPLETED', result: { outcome: 'abandoned' } } });
    expect((await readCorrectMergedExecution(bad, input)).matched?.result).toBeNull();
    const gone = client({});
    expect((await readCorrectMergedExecution(gone, input)).generations).toEqual([]);
    const down = client({ [WF]: { runId: RUN, status: 'COMPLETED', boom: true } });
    await expect(readCorrectMergedExecution(down, input)).rejects.toThrow('temporal down');
  });
});

describe('参数和 GitHub 读取', () => {
  const argv = ['correct-merged', 'thoerwink8/fleet-dao', '3114', '--pr', '3137', '--head', HEAD];
  argv.push('--merge', MERGE, '--workflow', WF, '--run', RUN, '--note', '为什么');

  it('缺 sha 或认不出的参数直接拒绝', () => {
    expect(parseCorrectMergedArgs([...argv, '--apply']).apply).toBe(true);
    expect(() => parseCorrectMergedArgs(argv.filter((part) => part !== HEAD && part !== '--head'))).toThrow(
      TaskCliError,
    );
    try {
      parseCorrectMergedArgs(argv.map((part) => (part === HEAD ? 'abc' : part)));
    } catch (err) {
      expect(err).toBeInstanceOf(TaskCliError);
      expect((err as TaskCliError).exitCode).toBe(2);
      expect((err as Error).message).toContain('完整 sha');
    }
  });

  it('issue 的 state 不进结果；缺 merged 是读不全；404 是没有', async () => {
    const pullBody = {
      number: 3137,
      head: { sha: HEAD },
      merge_commit_sha: MERGE,
      base: { repo: { full_name: 'thoerwink8/fleet-dao' } },
      state: 'closed',
    };
    const githubWith = (pullData: object) => ({
      request: async ({ path }: { path: string }) => {
        if (path.endsWith('/issues/3114')) {
          return { status: 200, data: { number: 3114, state: 'closed', title: 'x' } };
        }
        return path.endsWith('/pulls/3137') ? { status: 200, data: pullData } : { status: 404, data: {} };
      },
    });
    const read = await readGitHubCorrection(githubWith({ ...pullBody, merged: true }), REPO, 3114, 3137);
    expect(read.issue).toEqual({ number: 3114, repo: REPO, isPullRequest: false });
    expect(JSON.stringify(read.issue)).not.toContain('closed');
    expect(read.pull?.merged).toBe(true);
    await expect(readGitHubCorrection(githubWith(pullBody), REPO, 3114, 3137)).rejects.toThrow('读不全');
    const missing = { request: async () => ({ status: 404, data: {} }) };
    expect(await readGitHubCorrection(missing, REPO, 3114, 3137)).toEqual({ issue: null, pull: null });
  });
});
