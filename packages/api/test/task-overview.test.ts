// 任务详情的 overview（#3140）：关联 PR 的状态、改动文件、命令计数、段 → 步骤、最新汇报；读不到写原因，不拿 0 顶。
import { TaskDetailResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { RunTranscriptPort } from '../src/run-transcript.ts';
import { TRANSCRIPT_NOT_WIRED } from '../src/task-overview.ts';
import { harness, IDS, T0 } from './harness.ts';

const DONE_RUN = 'e2000000-0000-4000-8000-000000000001';
const OLD_RUN = 'e2000000-0000-4000-8000-000000000002';
const LIVE_RUN = 'e2000000-0000-4000-8000-000000000003';

type Row = {
  seq: number;
  sec: number;
  kind: 'prompt' | 'assistant' | 'tool_call' | 'tool_result' | 'error' | 'result';
  tool?: string;
  ok?: boolean;
  text?: string;
  added?: number;
  removed?: number;
};
const at = (sec: number) => new Date(T0.getTime() - 3_600_000 + sec * 1000);

function port(rows: Record<string, Row[]>, opts: { fail?: boolean } = {}): RunTranscriptPort {
  return {
    async read() {
      return { entries: [], any: false, more: false };
    },
    async processRows(runIds) {
      if (opts.fail) throw new Error('connection terminated');
      return new Map(
        runIds.flatMap((id) =>
          rows[id]
            ? [
                [
                  id,
                  rows[id].map((r) => ({
                    seq: r.seq,
                    at: at(r.sec),
                    kind: r.kind,
                    tool: r.tool ?? null,
                    ok: r.ok ?? null,
                    text: r.text ?? '',
                    sub: false,
                    added: r.added ?? null,
                    removed: r.removed ?? null,
                  })),
                ] as const,
              ]
            : [],
        ),
      );
    },
    async report(runId) {
      const r = rows[runId]?.filter((x) => x.kind === 'result').at(-1);
      return r ? { kind: 'result', text: r.text ?? '', at: at(r.sec) } : null;
    },
  };
}

const DONE_ROWS: Row[] = [
  { seq: 0, sec: 0, kind: 'prompt', text: 'p' },
  { seq: 1, sec: 1, kind: 'assistant', text: '先读代码' },
  { seq: 2, sec: 2, kind: 'tool_call', tool: 'Read', text: 'a.ts' },
  { seq: 3, sec: 3, kind: 'tool_result', tool: 'Read', ok: true },
  { seq: 4, sec: 10, kind: 'assistant', text: '改文件' },
  { seq: 5, sec: 11, kind: 'tool_call', tool: 'Edit', text: 'a.ts', added: 4, removed: 2 },
  { seq: 6, sec: 12, kind: 'tool_result', tool: 'Edit', ok: true },
  { seq: 7, sec: 20, kind: 'assistant', text: '跑测试' },
  { seq: 8, sec: 21, kind: 'tool_call', tool: 'Bash', text: 'pnpm test' },
  { seq: 9, sec: 22, kind: 'tool_result', tool: 'Bash', ok: false },
  { seq: 10, sec: 30, kind: 'result', ok: true, text: '做完了 PR #7' },
];

function seed(h: ReturnType<typeof harness>) {
  const base = { segment: 'manual' as const, model: 'opus-5.5', taskId: IDS.task12 };
  h.store.data.segmentRuns.push(
    {
      ...base,
      id: OLD_RUN,
      startedAt: at(-500).toISOString(),
      endedAt: at(-400).toISOString(),
      outcome: 'done',
    },
    {
      ...base,
      id: DONE_RUN,
      startedAt: at(0).toISOString(),
      endedAt: at(31).toISOString(),
      outcome: 'done',
      prNumber: 7,
      branch: 'local/12-x',
    },
  );
}

async function detail(h: ReturnType<typeof harness>) {
  const s = await h.login();
  const res = await h.cockpit.request(`/api/tasks/${IDS.task12}`, { headers: { cookie: s.cookie } });
  expect(res.status).toBe(200);
  return TaskDetailResponse.parse(await res.json());
}

describe('任务详情的 overview', () => {
  it('段 → 步骤、命令计数、改动文件、最新汇报都读得到；跑在记录之前的那笔标 noRecord', async () => {
    const h = harness({ runTranscript: port({ [DONE_RUN]: DONE_ROWS }) });
    seed(h);
    const o = (await detail(h)).overview;
    expect(o?.process.state).toBe('ok');
    if (o?.process.state !== 'ok') return;
    expect(o.process.runs.map((r) => [r.runId, r.noRecord])).toEqual([
      [OLD_RUN, true],
      [DONE_RUN, false],
    ]);
    const steps = o.process.runs[1]?.process?.steps ?? [];
    expect(steps.map((s) => s.title)).toEqual(['先读代码', '改文件', '跑测试']);
    expect(steps[2]).toMatchObject({ failed: true, commands: 1, commandsFailed: 1 });
    expect(o.process.counts).toMatchObject({
      commands: 1,
      commandsFailed: 1,
      commandsRunning: 0,
      reads: 1,
      added: 4,
      removed: 2,
    });
    expect(o.process.counts.files).toEqual([{ path: 'a.ts', edits: 1, added: 4, removed: 2 }]);
    expect(o.process.report).toMatchObject({ source: 'result', text: '做完了 PR #7', runId: DONE_RUN });
  });

  it('PR 横条：号、分支、状态来自 PR 镜像（合并 / 开着 / CI 红 / 关了），带这个 PR 那几笔改过的文件', async () => {
    const h = harness({ runTranscript: port({ [DONE_RUN]: DONE_ROWS }) });
    seed(h);
    const pr = (number: number, state: 'open' | 'closed' | 'merged', checks: 'success' | 'failure') => ({
      repoId: IDS.repo,
      number,
      state,
      headRef: 'b',
      headSha: 'd'.repeat(40),
      checks,
      updatedAt: T0.toISOString(),
    });
    h.store.data.pullRequests.push(pr(7, 'merged', 'success'));
    const merged = (await detail(h)).overview?.prs;
    expect(merged).toEqual([
      {
        number: 7,
        branch: 'local/12-x',
        state: 'merged',
        files: [{ path: 'a.ts', edits: 1, added: 4, removed: 2 }],
      },
    ]);
    h.store.data.pullRequests.splice(0, 1, pr(7, 'open', 'failure'));
    expect((await detail(h)).overview?.prs[0]?.state).toBe('failed');
    h.store.data.pullRequests.splice(0, 1, pr(7, 'open', 'success'));
    expect((await detail(h)).overview?.prs[0]?.state).toBe('open');
    h.store.data.pullRequests.splice(0, 1, pr(7, 'closed', 'success'));
    expect((await detail(h)).overview?.prs[0]?.state).toBe('closed');
  });

  it('PR 镜像里没有：state=unknown 并写原因，不当成开着', async () => {
    const h = harness({ runTranscript: port({ [DONE_RUN]: DONE_ROWS }) });
    seed(h);
    const pr = (await detail(h)).overview?.prs[0];
    expect(pr?.state).toBe('unknown');
    expect(pr?.note).toContain('没有这个 PR 的镜像');
  });

  it('在跑的那笔：最后一步 running，没结果的命令算「在跑」，每次重算', async () => {
    const live: Row[] = [
      { seq: 0, sec: 0, kind: 'assistant', text: '跑着' },
      { seq: 1, sec: 1, kind: 'tool_call', tool: 'Bash', text: 'sleep 100' },
    ];
    const h = harness({ runTranscript: port({ [LIVE_RUN]: live }) });
    h.store.data.segmentRuns.push({
      segment: 'manual',
      model: 'opus-5.5',
      taskId: IDS.task12,
      id: LIVE_RUN,
      startedAt: at(0).toISOString(),
    });
    const o = (await detail(h)).overview;
    if (o?.process.state !== 'ok') throw new Error('应当读到');
    expect(o.process.runs[0]?.process?.steps[0]).toMatchObject({ running: true });
    expect(o.process.counts).toMatchObject({ commands: 1, commandsRunning: 1, commandsFailed: 0 });
    expect(o.process.report).toBeUndefined();
    expect(o.process.reportNote).toBeTruthy();
  });

  it('会话内容没接上：process=unavailable 写原因（不是 0 个命令），PR 条照样给', async () => {
    const h = harness();
    seed(h);
    const o = (await detail(h)).overview;
    expect(o?.process).toEqual({ state: 'unavailable', reason: TRANSCRIPT_NOT_WIRED });
    expect(o?.prs[0]?.number).toBe(7);
    expect(o?.prs[0]?.files).toEqual([]);
  });

  it('【故意造出的失败】库读不了：process=unavailable 写「没读成」和原因，详情照样 200', async () => {
    const h = harness({ runTranscript: port({}, { fail: true }) });
    seed(h);
    const o = (await detail(h)).overview;
    expect(o?.process.state).toBe('unavailable');
    if (o?.process.state === 'unavailable') {
      expect(o.process.reason).toContain('没读成');
      expect(o.process.reason).toContain('connection terminated');
    }
  });

  it('已结束的段只读一次库（进程内缓存），在跑的每次重读', async () => {
    let reads = 0;
    const inner = port({ [DONE_RUN]: DONE_ROWS });
    const h = harness({
      runTranscript: {
        ...inner,
        processRows: (ids) => {
          reads++;
          return inner.processRows(ids);
        },
      },
    });
    seed(h);
    await detail(h);
    await detail(h);
    expect(reads).toBe(2); // 第一次读两笔（OLD 没记录，不缓存）；第二次只剩 OLD 要读
  });

  it('一笔都没跑过：没有汇报，写原因', async () => {
    const h = harness({ runTranscript: port({}) });
    const o = (await detail(h)).overview;
    if (o?.process.state !== 'ok') throw new Error('应当读到');
    expect(o.process.runs).toEqual([]);
    expect(o.process.reportNote).toContain('还没跑过');
  });
});
