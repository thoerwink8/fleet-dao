// fleet-api task correct-merged：已结束且误记 abandoned 的真实已合任务，受管纠正运行账。
// 合成的 #3114 反例：GitHub 上 PR #3137 已合并，Temporal 工作流按 issue-closed 以 abandoned 收场，任务行停在 stopped/abandoned。
// 全部用假的 GitHub 读取、假的 Temporal 控制和内存库，不碰真网络、不碰生产。
import { createMemoryStore, type MemoryData, type NewAuditEntry } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import type { CliDeps } from '../src/cli.ts';
import { main } from '../src/cli.ts';
import type { ClosedTaskWorkflow, TaskSignal } from '../src/ports.ts';
import { WorkflowGoneError, WorkflowUnavailableError } from '../src/ports.ts';
import { createClosedTaskWorkflow } from '../src/temporal.ts';

const NOW = new Date('2026-10-19T05:00:00.000Z');
const REPO_ID = 'a0000000-0000-4000-8000-000000003114';
const TASK_ID = 'd629758a-570d-405d-be00-417b7ee6c0c7';
const RUN_ID = 'd1000000-0000-4000-8000-000000003114';
const WF = 'task:thoerwink8/fleet-dao#3114';
const TEMPORAL_RUN = '01a14fd8-fb57-741a-8c14-42e3fdba87d6';
const HEAD = '5b52006a9cdcef60c030c5dbeec645f81a2ad86a';
const MERGE = 'bfe1b1ae69c7ae6404b068eb3ed7bde3082b3e40';
const UPDATED_AT = '2026-10-19T01:52:06.446Z';
const NOTE = '#3114 的 PR #3137 已真实合并，单子被提前关而误记 abandoned';

const FLAGS = ['--pr', '3137', '--head', HEAD, '--merge', MERGE, '--run', TEMPORAL_RUN];

const pullBody = (over: Record<string, unknown> = {}) => ({
  number: 3137,
  state: 'closed',
  merged: true,
  html_url: 'https://github.com/thoerwink8/fleet-dao/pull/3137',
  title: '任务收尾修复',
  body: 'Refs #3114',
  head: { sha: HEAD },
  base: { ref: 'main', repo: { full_name: 'thoerwink8/fleet-dao' } },
  merge_commit_sha: MERGE,
  merged_at: '2026-10-19T01:40:00Z',
  merged_by: { login: 'fleet-dao-engine[bot]' },
  ...over,
});

const closure = (over: Partial<ClosedTaskWorkflow> = {}): ClosedTaskWorkflow => ({
  workflowId: WF,
  runId: TEMPORAL_RUN,
  latestRunId: TEMPORAL_RUN,
  status: 'COMPLETED',
  closeTime: UPDATED_AT,
  result: { outcome: 'abandoned', prNumber: 3137, head: HEAD, rounds: 1, verifyRounds: 1 },
  ...over,
});

function seed(over: { state?: 'stopped' | 'running'; extraRuns?: unknown[] } = {}): Partial<MemoryData> {
  return {
    repos: [
      {
        id: REPO_ID,
        owner: 'thoerwink8',
        name: 'fleet-dao',
        defaultBranch: 'main',
        testCommand: 'pnpm check',
      },
    ],
    tasks: [
      {
        id: TASK_ID,
        repoId: REPO_ID,
        issueNumber: 3114,
        title: '任务收尾',
        rawRequest: '任务收尾',
        requestedBy: 'founder',
        state: over.state ?? 'stopped',
        priority: 1,
        acceptance: [],
        createdAt: '2026-10-18T00:00:00.000Z',
      },
    ],
    taskLedgers: new Map([
      [
        TASK_ID,
        { phase: 'abandoned', doing: '被 root 放弃：issue 已关闭', lastProblem: null, updatedAt: UPDATED_AT },
      ],
    ]),
    segmentRuns: [
      {
        id: RUN_ID,
        segment: 'manual',
        taskId: TASK_ID,
        issueNumber: 3114,
        model: 'opus-5.5',
        startedAt: '2026-10-19T00:00:00.000Z',
        endedAt: '2026-10-19T01:50:00.000Z',
        outcome: 'done',
        prNumber: 3137,
        workflowId: WF,
        temporalRunId: TEMPORAL_RUN,
      },
      ...(over.extraRuns ?? []),
    ] as unknown as MemoryData['segmentRuns'],
  };
}

interface Options {
  seed?: Parameters<typeof seed>[0];
  pull?: Record<string, unknown>;
  pullError?: Error;
  closure?: Partial<ClosedTaskWorkflow>;
  closureError?: Error;
  latestWorkflow?: string;
  /** 控制端没接最新一代的查询（runningTaskWorkflow）。 */
  noLatestLookup?: boolean;
  operator?: string | null;
}

function setup(options: Options = {}) {
  const store = createMemoryStore(seed(options.seed), { now: () => new Date(NOW) });
  const out: string[] = [];
  const err: string[] = [];
  const signals: unknown[] = [];
  const redos: unknown[] = [];
  const pullReads: string[] = [];
  let correctCalls = 0;
  // 让 Store 的纠正在写操作记录时失败（ok=false 没带原因）：验证任务和记录一起回滚
  let breakAudit = false;
  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'correctMergedAbandoned')
        return (input: never, entry: NewAuditEntry) => {
          correctCalls += 1;
          return target.correctMergedAbandoned(input, breakAudit ? { ...entry, ok: false } : entry);
        };
      return Reflect.get(target, prop, receiver);
    },
  });
  let currentPull = options.pull;
  let currentClosure = options.closure;
  const deps = (): CliDeps => ({
    env: {
      DATABASE_URL: 'postgres:///fleet',
      ...(options.operator === null ? {} : { FLEET_OPS_OPERATOR: options.operator ?? 'root' }),
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => NOW,
    openStore: async () => ({ store: wrapped, close: async () => {} }),
    openHistoricalAuditSource: async () => ({
      source: {
        async read(repo, path) {
          pullReads.push(`${repo}/${path}`);
          if (options.pullError) throw options.pullError;
          return pullBody(currentPull);
        },
      },
      close: async () => {},
    }),
    openTaskControl: async () => ({
      workflows: {
        async signal(workflowId: string, signal: TaskSignal) {
          signals.push({ workflowId, signal });
        },
        ...(options.noLatestLookup
          ? {}
          : {
              async runningTaskWorkflow() {
                return options.latestWorkflow ?? WF;
              },
            }),
        async closedTaskWorkflow() {
          if (options.closureError) throw options.closureError;
          return closure(currentClosure);
        },
      },
      taskRedo: {
        redo: async (input) => {
          redos.push(input);
          return { ok: true as const, workflowId: WF, generation: 2 };
        },
      },
      close: async () => {},
    }),
  });
  return {
    store,
    out,
    err,
    signals,
    redos,
    pullReads,
    correctCalls: () => correctCalls,
    breakAudit: (on = true) => {
      breakAudit = on;
    },
    /** 换 GitHub 回的 PR 字段；不给就回到原样的已合 PR。 */
    changeEvidence: (pull?: Record<string, unknown>) => {
      currentPull = pull;
    },
    changeClosure: (c: Partial<ClosedTaskWorkflow>) => {
      currentClosure = c;
    },
    run: (args: string[]) =>
      main(['task', 'correct-merged', 'thoerwink8/fleet-dao', '3114', ...args], deps()),
  };
}

describe('createClosedTaskWorkflow（只读核原 run）', () => {
  const fake = (statusName: string, latestRunId = TEMPORAL_RUN) => {
    const calls: string[] = [];
    const client = {
      connection: { withDeadline: <R>(_d: number | Date, fn: () => Promise<R>) => fn() },
      workflow: {
        getHandle(workflowId: string, runId?: string) {
          return {
            async describe() {
              calls.push(`describe ${workflowId} ${runId ?? 'latest'}`);
              return {
                workflowId,
                runId: runId ?? latestRunId,
                status: { name: statusName },
                closeTime: new Date(UPDATED_AT),
              };
            },
            async result() {
              calls.push(`result ${runId}`);
              return { outcome: 'abandoned', prNumber: 3137, head: HEAD };
            },
          };
        },
      },
    };
    return { client, calls };
  };

  it('COMPLETED：回终态、最新 run 和 Temporal 里的返回值，只调 describe / result，不发信号不起工作流', async () => {
    const { client, calls } = fake('COMPLETED');
    const read = createClosedTaskWorkflow(client);
    expect(await read(WF, TEMPORAL_RUN)).toEqual({
      workflowId: WF,
      runId: TEMPORAL_RUN,
      latestRunId: TEMPORAL_RUN,
      status: 'COMPLETED',
      closeTime: UPDATED_AT,
      result: { outcome: 'abandoned', prNumber: 3137, head: HEAD },
    });
    expect(calls).toEqual([
      `describe ${WF} latest`,
      `describe ${WF} ${TEMPORAL_RUN}`,
      `result ${TEMPORAL_RUN}`,
    ]);
  });

  it('没结束：只回状态，不取返回值；之后又起过新 run 如实带出最新 run', async () => {
    const { client, calls } = fake('RUNNING', '01a14fd8-fb57-741a-8c14-42e3fdba8888');
    const got = await createClosedTaskWorkflow(client)(WF, TEMPORAL_RUN);
    expect(got).toMatchObject({ status: 'RUNNING', latestRunId: '01a14fd8-fb57-741a-8c14-42e3fdba8888' });
    expect(got.result).toBeUndefined();
    expect(calls.some((c) => c.startsWith('result'))).toBe(false);
  });
});

const text = (h: ReturnType<typeof setup>) => [...h.out, ...h.err].join('\n');
const audits = (h: ReturnType<typeof setup>) =>
  h.store.data.audit.filter((a) => a.action.startsWith('task.'));

/** 预检并从输出里取执行要带的 --task / --seen。 */
async function preflight(h: ReturnType<typeof setup>) {
  expect(await h.run([...FLAGS, '--note', NOTE])).toBe(0);
  const line = h.out.at(-1) ?? '';
  const seen = /--seen ([0-9a-f]{16})/.exec(line)?.[1];
  const task = /--task ([0-9a-f-]{36})/.exec(line)?.[1];
  expect(seen).toBeDefined();
  expect(task).toBe(TASK_ID);
  return ['--execute', '--task', task as string, '--seen', seen as string];
}

const task = (h: ReturnType<typeof setup>) => h.store.data.tasks.find((t) => t.id === TASK_ID);

describe('fleet-api task correct-merged（#3114 反例）', () => {
  it('参数不对：缺 PR/head/merge/run、sha 不是 40 位、--execute 没带预检的 --task/--seen，都是退出码 2、不连库', async () => {
    const h = setup();
    const bad = [
      ['--head', HEAD, '--merge', MERGE, '--run', TEMPORAL_RUN],
      ['--pr', '3137', '--merge', MERGE, '--run', TEMPORAL_RUN],
      ['--pr', '3137', '--head', HEAD, '--run', TEMPORAL_RUN],
      ['--pr', '3137', '--head', HEAD, '--merge', MERGE],
      ['--pr', '3137', '--head', 'abc', '--merge', MERGE, '--run', TEMPORAL_RUN],
      ['--pr', '3137', '--head', HEAD, '--merge', 'abc', '--run', TEMPORAL_RUN],
      [...FLAGS, '--execute'],
      [...FLAGS, '--task', TASK_ID, '--seen', '0123456789abcdef'],
      [...FLAGS, '--base', HEAD],
    ];
    for (const flags of bad) expect(await h.run([...flags, '--note', NOTE]), flags.join(' ')).toBe(2);
    expect(await h.run(FLAGS)).toBe(2);
    expect(h.pullReads).toEqual([]);
    expect(audits(h)).toEqual([]);
  });

  it('预检只读：呈现精确对象和拟修正结果，不改任务、不写操作记录、不发信号', async () => {
    const h = setup();
    expect(await h.run([...FLAGS, '--note', NOTE])).toBe(0);
    const line = h.out.join('\n');
    expect(line).toContain('预检通过（只读，没改任何数据）');
    expect(line).toContain(`${TASK_ID}`);
    expect(line).toContain(WF);
    expect(line).toContain(TEMPORAL_RUN);
    expect(line).toContain(HEAD);
    expect(line).toContain(MERGE);
    expect(line).toContain('stopped/abandoned 改成 done');
    expect(h.pullReads).toEqual(['thoerwink8/fleet-dao/pulls/3137']);
    expect(task(h)?.state).toBe('stopped');
    expect(audits(h)).toEqual([]);
    expect(h.signals).toEqual([]);
    expect(h.redos).toEqual([]);
    expect(h.correctCalls()).toBe(0);
  });

  it('正常纠正：任务改 done，原 abandoned 结论、原 run、Temporal 历史都在操作记录和库里保留；不发信号、不重做', async () => {
    const h = setup();
    const execute = await preflight(h);
    const before = structuredClone(h.store.data.segmentRuns);
    expect(await h.run([...FLAGS, ...execute, '--note', NOTE])).toBe(0);
    expect(h.out.at(-1)).toContain('已纠正：');
    expect(task(h)?.state).toBe('done');
    expect(h.store.data.taskLedgers.get(TASK_ID)).toMatchObject({ phase: 'done', lastProblem: null });
    expect(h.store.data.taskLedgers.get(TASK_ID)?.doing).toContain('PR #3137 已合并');
    // 旧 run 一个字都没动
    expect(h.store.data.segmentRuns).toEqual(before);
    expect(h.signals).toEqual([]);
    expect(h.redos).toEqual([]);
    const [record, ...rest] = audits(h);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      action: 'task.correct-merged',
      target: `task:${TASK_ID}`,
      ok: true,
      via: 'ops',
      actor: { kind: 'ops', id: 'ops:task' },
      before: {
        state: 'stopped',
        phase: 'abandoned',
        doing: '被 root 放弃：issue 已关闭',
        updatedAt: UPDATED_AT,
        runIds: [RUN_ID],
        temporalRunId: TEMPORAL_RUN,
        workflowResult: { outcome: 'abandoned', prNumber: 3137, head: HEAD },
      },
      after: {
        who: 'root',
        taskId: TASK_ID,
        pr: 3137,
        head: HEAD,
        mergeCommit: MERGE,
        temporalRunId: TEMPORAL_RUN,
        workflowId: WF,
        state: 'done',
        evidence: {
          pull: { mergedAt: '2026-10-19T01:40:00Z', mergedBy: 'fleet-dao-engine[bot]', baseRef: 'main' },
          workflow: { status: 'COMPLETED', closeTime: UPDATED_AT },
        },
      },
    });
    expect(record?.reason).toContain(NOTE);
    expect(record?.reason).toContain('root');
    // 状态变化账：stopped → done
    expect(h.store.data.stateChanges.at(-1)).toMatchObject({
      entityId: TASK_ID,
      from: 'stopped',
      to: 'done',
    });
  });

  it('重复同一请求：幂等，不再改、不再记；预检也如实说已纠正过', async () => {
    const h = setup();
    const execute = await preflight(h);
    expect(await h.run([...FLAGS, ...execute, '--note', NOTE])).toBe(0);
    h.out.length = 0;
    expect(await h.run([...FLAGS, ...execute, '--note', NOTE])).toBe(0);
    expect(h.out.join('\n')).toContain('已纠正过');
    expect(await h.run([...FLAGS, '--note', NOTE])).toBe(0);
    expect(h.out.at(-1)).toContain('已纠正过');
    expect(audits(h)).toHaveLength(1);
    // 重复请求在入口就认出已纠正过，不再走写入
    expect(h.correctCalls()).toBe(1);
  });

  it('纠正之后用不同的 PR / head / 合并提交 / run / 证据再来：拒绝，不冒充成功', async () => {
    const h = setup();
    await h.run([...FLAGS, ...(await preflight(h)), '--note', NOTE]);
    // 换证据：GitHub 回的合并人变了 → 已纠正过，但证据不同，不能冒充幂等成功
    h.changeEvidence({ merged_by: { login: 'someone-else' } });
    const code = await h.run([...FLAGS, '--note', NOTE]);
    expect(code).toBe(1);
    expect(text(h)).toContain('已做过受管纠正');
    expect(task(h)?.state).toBe('done');
    expect(audits(h)).toHaveLength(1);
    // 换 head / 合并提交 / run 的请求同样被拒（GitHub、Temporal 现读对不上，根本到不了写入）
    for (const flags of [
      ['--pr', '3137', '--head', 'c'.repeat(40), '--merge', MERGE, '--run', TEMPORAL_RUN],
      ['--pr', '3137', '--head', HEAD, '--merge', 'c'.repeat(40), '--run', TEMPORAL_RUN],
      ['--pr', '3137', '--head', HEAD, '--merge', MERGE, '--run', '01a14fd8-fb57-741a-8c14-42e3fdba8888'],
    ]) {
      h.changeEvidence();
      expect(await h.run([...flags, '--note', NOTE]), flags.join(' ')).toBe(1);
    }
    expect(audits(h)).toHaveLength(1);
  });

  it('不是真实已合并：没合、关了没合、读到的形状不对 → 明确拒绝，不拿 issue 关闭当 done', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ merged: false, state: 'open', merged_at: null, merge_commit_sha: null }, '没有合并'],
      [{ merged: false, state: 'closed', merged_at: null }, '没有合并'],
      [{ number: 3000 }, '不是请求的 #3137'],
      [{ base: { ref: 'main', repo: { full_name: 'thoerwink8/other' } } }, '不是 thoerwink8/fleet-dao'],
      [{ head: { sha: 'c'.repeat(40) } }, '合的头是'],
      [{ merge_commit_sha: 'c'.repeat(40) }, '真实合并提交是'],
      [{ merge_commit_sha: null }, '真实合并提交是'],
      [{ base: { ref: 'release', repo: { full_name: 'thoerwink8/fleet-dao' } } }, '不是默认分支'],
      [{ title: '别的事', body: '无关' }, '没有指向'],
      [{ body: 'Refs #31140' }, '没有指向'],
      [{ head: 'broken' }, '形状认不出'],
    ];
    for (const [pull, why] of cases) {
      const h = setup({ pull });
      expect(await h.run([...FLAGS, '--note', NOTE]), JSON.stringify(pull)).toBe(1);
      expect(text(h)).toContain(why);
      expect(task(h)?.state).toBe('stopped');
      expect(audits(h)).toEqual([]);
    }
  });

  it('错 run / 错 head / 错 PR 的 Temporal 终态 → 拒绝', async () => {
    const cases: [Partial<ClosedTaskWorkflow>, string][] = [
      [{ runId: '01a14fd8-fb57-741a-8c14-42e3fdba8888' }, '不一致'],
      [{ latestRunId: '01a14fd8-fb57-741a-8c14-42e3fdba8888' }, '拒绝陈旧请求'],
      [{ status: 'RUNNING' }, '不是已 COMPLETED'],
      [{ status: 'FAILED' }, '不是已 COMPLETED'],
      [{ result: { outcome: 'merged', prNumber: 3137, head: HEAD } }, '不是 abandoned'],
      [{ result: { outcome: 'abandoned', prNumber: 3138, head: HEAD } }, '与请求的'],
      [{ result: { outcome: 'abandoned', prNumber: 3137, head: 'c'.repeat(40) } }, '与请求的'],
      [{ result: 'garbage' }, '返回值认不出'],
    ];
    for (const [over, why] of cases) {
      const h = setup({ closure: over });
      expect(await h.run([...FLAGS, '--note', NOTE]), JSON.stringify(over)).toBe(1);
      expect(text(h)).toContain(why);
      expect(task(h)?.state).toBe('stopped');
    }
    // 请求的 run 编号和 Temporal 里的不一样
    const h = setup();
    const flags = FLAGS.map((f) => (f === TEMPORAL_RUN ? '01a14fd8-fb57-741a-8c14-42e3fdba8888' : f));
    expect(await h.run([...flags, '--note', NOTE])).toBe(1);
    expect(task(h)?.state).toBe('stopped');
  });

  it('控制端没接最新一代的查询：不回退成请求里的旧编号，预检和执行都拒绝', async () => {
    const h = setup({ noLatestLookup: true });
    expect(await h.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(h)).toContain('不能确认原 run 是最新一代');
    expect(task(h)?.state).toBe('stopped');
    expect(h.correctCalls()).toBe(0);
  });

  it('关联用的 PR 标题 / 正文进证据：审计留原文和正文摘要，之后标题或正文变了不能冒充同一请求的幂等成功', async () => {
    const h = setup();
    await h.run([...FLAGS, ...(await preflight(h)), '--note', NOTE]);
    const record = audits(h)[0];
    expect(record?.after).toMatchObject({
      evidence: {
        pull: {
          title: '任务收尾修复',
          body: 'Refs #3114',
          linksIssue: true,
          state: 'closed',
          baseRepo: 'thoerwink8/fleet-dao',
        },
      },
    });
    const after = record?.after as { evidence: { pull: { bodySha256: string } } };
    expect(after.evidence.pull.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    // 标题和正文变了（仍然指向 #3114）：证据不同，拒绝，不再记
    for (const changed of [{ title: '改了标题' }, { body: 'Refs #3114\n后来又补了一段' }]) {
      h.changeEvidence(changed);
      expect(await h.run([...FLAGS, '--note', NOTE]), JSON.stringify(changed)).toBe(1);
      expect(text(h)).toContain('已做过受管纠正');
    }
    expect(audits(h)).toHaveLength(1);
    // 预检之后标题变了：--seen 对不上
    const fresh = setup();
    const execute = await preflight(fresh);
    fresh.changeEvidence({ title: '改了标题' });
    expect(await fresh.run([...FLAGS, ...execute, '--note', NOTE])).toBe(1);
    expect(text(fresh)).toContain('--seen 对不上');
    expect(fresh.correctCalls()).toBe(0);
  });

  it('换代：这张单已有更新一代的工作流 → 拒绝陈旧请求', async () => {
    const h = setup({ latestWorkflow: `${WF}:r2` });
    expect(await h.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(h)).toContain('更新的一代');
    expect(task(h)?.state).toBe('stopped');
  });

  it('读不到或结果未知：GitHub、Temporal 读失败 → 拒绝，不当成已合并', async () => {
    const gh = setup({ pullError: new Error('GitHub 502') });
    expect(await gh.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(gh)).toContain('结果未知');
    const tg = setup({ closureError: new WorkflowGoneError(WF) });
    expect(await tg.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(tg)).toContain('查不到');
    const tu = setup({ closureError: new WorkflowUnavailableError('连不上') });
    expect(await tu.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(tu)).toContain('结果未知');
    const to = setup({ closureError: new Error('boom') });
    expect(await to.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(to)).toContain('结果未知');
    for (const h of [gh, tg, tu, to]) {
      expect(task(h)?.state).toBe('stopped');
      expect(audits(h)).toEqual([]);
    }
  });

  it('读任务账失败：拒绝', async () => {
    const h = setup();
    h.store.readMergedCorrection = async () => {
      throw new Error('库读失败');
    };
    expect(await h.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(h)).toContain('读任务账没成');
  });

  it('未授权：没经 bin/fleet-api（没有 FLEET_OPS_OPERATOR）不许执行；预检仍只读可看', async () => {
    const h = setup({ operator: null });
    expect(await h.run([...FLAGS, '--note', NOTE])).toBe(0);
    const execute = await preflight(h);
    h.out.length = 0;
    expect(await h.run([...FLAGS, ...execute, '--note', NOTE])).toBe(1);
    expect(text(h)).toContain('没有可信的实际操作者');
    expect(task(h)?.state).toBe('stopped');
    expect(h.correctCalls()).toBe(0);
    // 只留一条失败记录（预检不记）
    expect(audits(h)).toEqual([expect.objectContaining({ action: 'task.correct-merged', ok: false })]);
  });

  it('--task 不是预检打印的任务编号：拒绝', async () => {
    const h = setup();
    const execute = await preflight(h);
    const other = 'e629758a-570d-405d-be00-417b7ee6c0c7';
    const bad = execute.map((v) => (v === TASK_ID ? other : v));
    expect(await h.run([...FLAGS, ...bad, '--note', NOTE])).toBe(1);
    expect(text(h)).toContain('--task 要写预检打印的任务编号');
    expect(task(h)?.state).toBe('stopped');
  });

  it('活任务：任务不是 stopped、或还有没结束的会话 → 拒绝', async () => {
    const running = setup({ seed: { state: 'running' } });
    expect(await running.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(running)).toContain('不是已结束的 stopped/abandoned');
    const live = setup({
      seed: {
        extraRuns: [
          {
            id: 'd1000000-0000-4000-8000-000000003115',
            segment: 'manual',
            taskId: TASK_ID,
            issueNumber: 3114,
            model: 'opus-5.5',
            startedAt: '2026-10-19T04:00:00.000Z',
            workflowId: WF,
          },
        ],
      },
    });
    expect(await live.run([...FLAGS, '--note', NOTE])).toBe(1);
    expect(text(live)).toContain('未结束的会话');
    for (const h of [running, live]) {
      expect(audits(h)).toEqual([]);
      expect(h.correctCalls()).toBe(0);
    }
  });

  it('并发变化：预检之后出现新会话、任务账被改、证据变了 → 拒绝陈旧请求，不覆盖新的运行状态', async () => {
    // 1. 预检之后出现了新 run
    const a = setup();
    const executeA = await preflight(a);
    a.store.data.segmentRuns.push({
      id: 'd1000000-0000-4000-8000-000000003116',
      segment: 'manual',
      taskId: TASK_ID,
      issueNumber: 3114,
      model: 'opus-5.5',
      startedAt: '2026-10-19T04:30:00.000Z',
      endedAt: '2026-10-19T04:40:00.000Z',
      workflowId: WF,
      temporalRunId: TEMPORAL_RUN,
    } as unknown as MemoryData['segmentRuns'][number]);
    expect(await a.run([...FLAGS, ...executeA, '--note', NOTE])).toBe(1);
    expect(text(a)).toContain('--seen 对不上');
    // 2. 预检之后任务账被改（引擎又写了一次快照）
    const b = setup();
    const executeB = await preflight(b);
    b.store.data.taskLedgers.set(TASK_ID, {
      phase: 'abandoned',
      doing: '另一句话',
      lastProblem: null,
      updatedAt: '2026-10-19T03:00:00.000Z',
    });
    expect(await b.run([...FLAGS, ...executeB, '--note', NOTE])).toBe(1);
    expect(text(b)).toContain('--seen 对不上');
    // 3. 预检之后任务已被重新跑起来
    const c = setup();
    const executeC = await preflight(c);
    const t = task(c);
    if (t) t.state = 'running';
    expect(await c.run([...FLAGS, ...executeC, '--note', NOTE])).toBe(1);
    expect(text(c)).toContain('不是已结束的 stopped/abandoned');
    // 4. 预检之后 GitHub / Temporal 证据变了
    const d = setup();
    const executeD = await preflight(d);
    d.changeEvidence({ merged_at: '2026-10-19T01:41:00Z' });
    expect(await d.run([...FLAGS, ...executeD, '--note', NOTE])).toBe(1);
    expect(text(d)).toContain('--seen 对不上');
    const e = setup();
    const executeE = await preflight(e);
    e.changeClosure({ closeTime: '2026-10-19T01:53:00.000Z' });
    expect(await e.run([...FLAGS, ...executeE, '--note', NOTE])).toBe(1);
    expect(text(e)).toContain('--seen 对不上');
    for (const h of [a, b, c, d, e]) {
      expect(h.correctCalls()).toBe(0);
      expect(audits(h).filter((r) => r.ok)).toEqual([]);
    }
    expect(a.store.data.taskLedgers.get(TASK_ID)?.phase).toBe('abandoned');
  });

  it('操作记录写不进：任务一起回滚，退出码 1，不打成功；之后原样重试可以成功', async () => {
    const h = setup();
    const execute = await preflight(h);
    h.breakAudit();
    expect(await h.run([...FLAGS, ...execute, '--note', NOTE])).toBe(1);
    expect(h.out.join('\n')).not.toContain('已纠正');
    expect(task(h)?.state).toBe('stopped');
    expect(h.store.data.taskLedgers.get(TASK_ID)).toMatchObject({
      phase: 'abandoned',
      updatedAt: UPDATED_AT,
    });
    expect(audits(h).filter((r) => r.ok)).toEqual([]);
    h.breakAudit(false);
    expect(await h.run([...FLAGS, ...execute, '--note', NOTE])).toBe(0);
    expect(task(h)?.state).toBe('done');
  });

  it('不替人验收、不关单：纠正只动任务行；通知、PR 镜像、仓配置原样', async () => {
    const h = setup();
    const snapshot = structuredClone({
      notifications: h.store.data.notifications,
      pullRequests: h.store.data.pullRequests,
      repos: h.store.data.repos,
      settings: h.store.data.settings,
      subtasks: h.store.data.subtasks,
    });
    await h.run([...FLAGS, ...(await preflight(h)), '--note', NOTE]);
    expect({
      notifications: h.store.data.notifications,
      pullRequests: h.store.data.pullRequests,
      repos: h.store.data.repos,
      settings: h.store.data.settings,
      subtasks: h.store.data.subtasks,
    }).toEqual(snapshot);
    expect(h.pullReads.every((p) => p.includes('/pulls/'))).toBe(true);
  });
});

describe('fleet-api task correct-merged：--workflow 预检回执与 --apply 执行（运维单入口）', () => {
  const RECEIPT_FLAGS = [...FLAGS, '--workflow', WF];
  const receipt = (h: ReturnType<typeof setup>) => JSON.parse(h.out.at(-1) ?? '{}');

  it('带 --workflow 的预检回 JSON：mode=precheck、status=precheck，预览精确的任务/原 run/PR/head 和拟改成的 done/merged，不写任何东西', async () => {
    const h = setup();
    expect(await h.run([...RECEIPT_FLAGS, '--note', NOTE])).toBe(0);
    expect(receipt(h)).toMatchObject({
      mode: 'precheck',
      status: 'precheck',
      preview: {
        repo: 'thoerwink8/fleet-dao',
        issue: 3114,
        taskId: TASK_ID,
        workflowId: WF,
        run: TEMPORAL_RUN,
        pr: 3137,
        head: HEAD,
        mergeCommit: MERGE,
        current: { state: 'stopped', phase: 'abandoned' },
        proposed: { state: 'done', phase: 'done', merged: true },
      },
    });
    expect(task(h)?.state).toBe('stopped');
    expect(audits(h)).toEqual([]);
    expect(h.correctCalls()).toBe(0);
  });

  it('--workflow 与按单号推出的工作流不一致：拒绝，什么都不改', async () => {
    const h = setup();
    expect(await h.run([...FLAGS, '--workflow', 'task:thoerwink8/fleet-dao#3115', '--note', NOTE])).toBe(1);
    expect(text(h)).toContain(WF);
    expect(task(h)?.state).toBe('stopped');
    expect(audits(h)).toEqual([]);
  });

  it('--apply 只在预检同一命令末尾加：自己重读事实并事务 CAS，首次 status=corrected；之后预检和再 apply 都是 already，审计不新增', async () => {
    const h = setup();
    const before = structuredClone(h.store.data.segmentRuns);
    expect(await h.run([...RECEIPT_FLAGS, '--note', NOTE])).toBe(0);
    expect(await h.run([...RECEIPT_FLAGS, '--note', NOTE, '--apply'])).toBe(0);
    expect(receipt(h)).toMatchObject({ mode: 'apply', status: 'corrected', preview: { taskId: TASK_ID } });
    expect(task(h)?.state).toBe('done');
    expect(h.store.data.segmentRuns).toEqual(before);
    expect(h.signals).toEqual([]);
    expect(h.redos).toEqual([]);
    const [record, ...rest] = audits(h);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      action: 'task.correct-merged',
      target: `task:${TASK_ID}`,
      actor: { kind: 'ops', id: 'ops:task' },
      after: {
        who: 'root',
        workflowId: WF,
        temporalRunId: TEMPORAL_RUN,
        pr: 3137,
        head: HEAD,
        mergeCommit: MERGE,
      },
    });

    expect(await h.run([...RECEIPT_FLAGS, '--note', NOTE])).toBe(0);
    expect(receipt(h)).toMatchObject({ mode: 'precheck', status: 'already' });
    expect(await h.run([...RECEIPT_FLAGS, '--note', NOTE, '--apply'])).toBe(0);
    expect(receipt(h)).toMatchObject({ mode: 'apply', status: 'already' });
    expect(audits(h)).toHaveLength(1);
  });

  it('--apply 不与 --execute、--task、--seen 同用：退出码 2，不连 GitHub', async () => {
    const h = setup();
    for (const extra of [['--execute'], ['--task', TASK_ID], ['--seen', '0123456789abcdef']])
      expect(await h.run([...FLAGS, ...extra, '--apply', '--note', NOTE]), extra.join(' ')).toBe(2);
    expect(h.pullReads).toEqual([]);
    expect(task(h)?.state).toBe('stopped');
  });

  it('--apply 没有可信操作者（没经 bin/fleet-api）：拒绝，任务不动', async () => {
    const h = setup({ operator: null });
    expect(await h.run([...RECEIPT_FLAGS, '--note', NOTE, '--apply'])).not.toBe(0);
    expect(task(h)?.state).toBe('stopped');
    expect(h.correctCalls()).toBe(0);
  });

  it('--apply 遇证据对不上（GitHub 回的 head 不是请求的）：拒绝，任务不动、不调 Store 纠正', async () => {
    const h = setup({ pull: { head: { sha: 'f'.repeat(40) } } });
    expect(await h.run([...RECEIPT_FLAGS, '--note', NOTE, '--apply'])).toBe(1);
    expect(task(h)?.state).toBe('stopped');
    expect(h.correctCalls()).toBe(0);
  });
});
