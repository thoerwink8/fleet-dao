// pnpm drill（#452「一条命令起一次完整演练」）：立刻跑一轮全流程巡检、等结论、打印每一步用时，断了照实报停在哪一步、退出码非 0。
// 打印和退出码拿假的巡检结局核；起一轮、接上在跑的、等结论拿假的 Temporal 客户端核。故意造出的失败：起不来、工作流没给结论、
// 结局认不出——都是没查成、退出码 2，不当成通过。
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import {
  type DrillClient,
  type DrillDeps,
  type DrillRound,
  drillReport,
  runDrill,
  temporalDrill,
} from '../src/drill.ts';

const STEPS_UNTIL_PR = [
  { stage: 'open', at: '2026-10-03T18:26:30.000Z' },
  { stage: 'intake', at: '2026-10-03T18:31:39.000Z' },
  { stage: 'implement', at: '2026-10-03T18:44:01.000Z' },
  { stage: 'pr', at: '2026-10-03T18:52:09.000Z' },
];

/** 一轮通过的结局（工作流的返回值，jobs/canary.ts 的 CanaryRun）。 */
const PASS = {
  runId: 41,
  canaryRunId: 7,
  verdict: 'pass',
  stage: 'board',
  issueNumber: 12,
  why: null,
  startedAt: '2026-10-03T18:26:00.000Z',
  endedAt: '2026-10-03T19:10:00.000Z',
  steps: [
    ...STEPS_UNTIL_PR,
    { stage: 'verify', at: '2026-10-03T18:58:00.000Z' },
    { stage: 'merge', at: '2026-10-03T19:04:00.000Z' },
    { stage: 'close', at: '2026-10-03T19:06:00.000Z' },
    { stage: 'ledger', at: '2026-10-03T19:06:00.000Z' },
    { stage: 'board', at: '2026-10-03T19:10:00.000Z' },
  ],
};

/** 一轮断在验收的结局。 */
const BROKEN = {
  ...PASS,
  verdict: 'broken',
  stage: 'verify',
  why: '断在「验收」（这一步走了 47 分 51 秒）：超过期限 45 分钟还没走完：在做：验收第 1 轮',
  endedAt: '2026-10-03T19:40:00.000Z',
  steps: STEPS_UNTIL_PR,
};

const ROUND: DrillRound = { workflowId: 'canary', runId: 'run-1', attached: false };

function drill(over: Partial<DrillDeps> = {}): { deps: DrillDeps; printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    deps: {
      start: async () => ROUND,
      result: async () => PASS,
      print: (line) => printed.push(line),
      ...over,
    },
  };
}

describe('打印和退出码（drillReport、runDrill）', () => {
  it('通过：一步一行，几点走完（北京时间）、用了多久，最后写一共用了多久；退出码 0', async () => {
    const { deps, printed } = drill();
    expect(await runDrill(deps)).toBe(0);
    expect(printed[0]).toBe(`起了一轮全流程巡检（${ROUND.workflowId}），等结论（一轮最长 5 小时）`);
    expect(printed.slice(1)).toEqual([
      '全流程巡检第 7 轮：通过（巡检单 #12）',
      '  开单  10-04 02:26:30  用时 30 秒',
      '  收单  10-04 02:31:39  用时 5 分 9 秒',
      '  动手  10-04 02:44:01  用时 12 分 22 秒',
      '  开 PR、过 CI  10-04 02:52:09  用时 8 分 8 秒',
      '  验收  10-04 02:58:00  用时 5 分 51 秒',
      '  合并  10-04 03:04:00  用时 6 分 0 秒',
      '  关单  10-04 03:06:00  用时 2 分 0 秒',
      '  记账  10-04 03:06:00  用时 0 秒',
      '  驾驶舱显示  10-04 03:10:00  用时 4 分 0 秒',
      '一共用了 44 分 0 秒',
    ]);
  });

  it('【故意造出的失败】断在「验收」：走完的照打，停在哪一步、从上一步到有结论过了多久、为什么都写出来；退出码 1', async () => {
    const { deps, printed } = drill({ result: async () => BROKEN });
    expect(await runDrill(deps)).toBe(1);
    expect(printed).toContain('全流程巡检第 7 轮：断在「验收」（巡检单 #12）');
    expect(printed).toContain('  开 PR、过 CI  10-04 02:52:09  用时 8 分 8 秒');
    expect(printed).toContain('  验收  没走完：从上一步走完到有结论过了 47 分 51 秒');
    expect(printed).toContain('一共用了 1 小时 14 分');
    expect(printed.at(-1)).toBe(`为什么：${BROKEN.why}`);
  });

  it('【故意造出的失败】巡检自己没跑成（开单之前就停了）：写明一步都没走完、为什么；退出码 2，不当成断了更不当成通过', () => {
    const report = drillReport({
      ...PASS,
      verdict: 'not_run',
      stage: 'open',
      issueNumber: null,
      why: '没配巡检仓：引擎配置 /etc/fleet-dao/engine.env 里没有 FLEET_CANARY_REPO（写 owner/name）',
      endedAt: '2026-10-03T18:26:01.000Z',
      steps: [],
    });
    expect(report.exitCode).toBe(2);
    expect(report.lines).toEqual([
      '全流程巡检第 7 轮：巡检自己没跑成（停在「开单」）（单没开成）',
      '  一步都没走完',
      '  开单  没走完：从上一步走完到有结论过了 1 秒',
      '一共用了 1 秒',
      '为什么：没配巡检仓：引擎配置 /etc/fleet-dao/engine.env 里没有 FLEET_CANARY_REPO（写 owner/name）',
    ]);
  });

  it('跳过（巡检仓的「让 AI 接活」关着，#1050）：写明没开单、什么都没验、怎么打开再演练；退出码 2，不拿 0 冒充通过', () => {
    const report = drillReport({
      ...PASS,
      verdict: 'skipped',
      stage: 'open',
      issueNumber: null,
      why: '跳过：巡检仓的「让 AI 接活」关着',
      endedAt: '2026-10-03T18:26:01.000Z',
      steps: [],
    });
    expect(report.exitCode).toBe(2);
    expect(report.lines).toEqual([
      '全流程巡检第 7 轮：跳过（没开单，什么都没验）',
      '为什么：跳过：巡检仓的「让 AI 接活」关着',
      '要演练：先把巡检仓的「让 AI 接活」打开（fleet-api dispatch <owner>/<巡检仓> on），再 pnpm drill',
    ]);
  });

  it('换版本之前的引擎起的一轮（结局里没有每一步的时刻）：照实说读不到，不拿 0 顶；老步骤照样说人话，退出码照结论', () => {
    const report = drillReport({
      runId: 3,
      canaryRunId: 3,
      verdict: 'broken',
      stage: 'dispatch',
      issueNumber: 5,
      why: '断在「派活」：挂起等人',
    });
    expect(report.exitCode).toBe(1);
    expect(report.lines).toEqual([
      '全流程巡检第 3 轮：断在「派活」（巡检单 #5）',
      '  每一步用时读不到：这一轮是换版本之前的引擎起的，结局里没记每一步的时刻',
      '为什么：断在「派活」：挂起等人',
    ]);
  });

  it('【故意造出的失败】结局认不出（结论不认得、不是对象、每一步的记录坏了）：退出码 2，不猜通没通过', () => {
    for (const raw of [
      { ...PASS, verdict: 'maybe' },
      null,
      'pass',
      { ...PASS, steps: [{ stage: 'open' }] },
      { ...PASS, startedAt: 7 },
    ]) {
      const report = drillReport(raw);
      expect(report.exitCode, JSON.stringify(raw)).toBe(2);
      expect(report.lines[0]).toContain('结局认不出');
    }
  });

  it('【故意造出的失败】起不来（连不上 Temporal、没有这个定时任务）：没查成、退出码 2，不去等结论', async () => {
    let waited = false;
    const { deps, printed } = drill({
      start: async () => {
        throw new Error('Temporal 上没有定时任务 canary：引擎还没以真端口起过');
      },
      result: async () => {
        waited = true;
        return PASS;
      },
    });
    expect(await runDrill(deps)).toBe(2);
    expect(waited).toBe(false);
    expect(printed).toEqual([
      '没查成：没起成这一轮演练（Temporal 上没有定时任务 canary：引擎还没以真端口起过）',
    ]);
  });

  it('【故意造出的失败】工作流没给结论就失败了：没查成、退出码 2', async () => {
    const { deps, printed } = drill({
      result: async () => {
        throw new Error('Workflow execution failed');
      },
    });
    expect(await runDrill(deps)).toBe(2);
    expect(printed.at(-1)).toContain('没查成：这一轮巡检的工作流没给结论就失败了');
    expect(printed.at(-1)).toContain('Workflow execution failed');
  });

  it('已经有一轮在跑：不另起，写明接上的是哪一轮，照样等它的结论', async () => {
    const { deps, printed } = drill({ start: async () => ({ ...ROUND, attached: true }) });
    expect(await runDrill(deps)).toBe(0);
    expect(printed[0]).toBe(
      `已经有一轮全流程巡检在跑（${ROUND.workflowId}），不另起，接上它等结论（一轮最长 5 小时）`,
    );
  });
});

// —— 真的那一层：起一轮（和引擎的定时器同一个起法）、认出是哪一轮、等结局（假的 Temporal 客户端）——

/** 假的 Temporal：start 按 startError 抛或回一个带 run 编号的句柄；getHandle 回的句柄 describe 给在跑的那一次、result 记下等的是哪一轮。 */
function fakeTemporal(o: { startError?: unknown; running?: string; result?: unknown } = {}) {
  const calls: string[] = [];
  const started: { workflowType: string; options: Record<string, unknown> }[] = [];
  const client = {
    workflow: {
      start: async (workflowType: string, options: Record<string, unknown>) => {
        started.push({ workflowType, options });
        if (o.startError) throw o.startError;
        return { firstExecutionRunId: 'run-new' };
      },
      getHandle: (workflowId: string, runId?: string) => ({
        describe: async () => {
          calls.push(`describe:${workflowId}`);
          return { runId: o.running ?? 'run-old' };
        },
        result: async () => {
          calls.push(`result:${workflowId}:${runId}`);
          return o.result ?? PASS;
        },
      }),
    },
  } as unknown as DrillClient;
  return { client, calls, started };
}

const alreadyRunning = () => new WorkflowExecutionAlreadyStartedError('already', 'canary', 'canaryWorkflow');

describe('起一轮、等结论（temporalDrill，假的 Temporal 客户端）', () => {
  it('没有在跑的：用固定编号 canary 起一条 canaryWorkflow（在跑的会被 Temporal 拒掉），回它的 run 编号', async () => {
    const t = fakeTemporal();
    const drill = temporalDrill(t.client, { print: () => {}, taskQueue: 'fleet' });
    expect(await drill.start()).toEqual({ workflowId: 'canary', runId: 'run-new', attached: false });
    expect(t.started).toHaveLength(1);
    expect(t.started[0]?.workflowType).toBe('canaryWorkflow');
    expect(t.started[0]?.options).toMatchObject({
      taskQueue: 'fleet',
      workflowId: 'canary',
      workflowIdConflictPolicy: 'FAIL',
    });
  });

  it('已经有一轮在跑：接上它（问一句才知道是哪一次执行），不另起（两轮叠着跑会在巡检仓里抢同一个文件）', async () => {
    const t = fakeTemporal({ startError: alreadyRunning(), running: 'run-old' });
    const drill = temporalDrill(t.client, { print: () => {}, taskQueue: 'fleet' });
    expect(await drill.start()).toEqual({ workflowId: 'canary', runId: 'run-old', attached: true });
    expect(t.calls).toEqual(['describe:canary']);
  });

  it('【故意造出的失败】起的时候出了别的错（连不上、没权限）：原样抛出，不当成「已经有一轮在跑」', async () => {
    const t = fakeTemporal({ startError: new Error('UNAVAILABLE') });
    const drill = temporalDrill(t.client, { print: () => {}, taskQueue: 'fleet' });
    await expect(drill.start()).rejects.toThrow('UNAVAILABLE');
    expect(t.calls).toEqual([]);
  });

  it('等结论：按编号和这一次的 run 等工作流的返回值', async () => {
    const t = fakeTemporal({ result: BROKEN });
    const drill = temporalDrill(t.client, { print: () => {}, taskQueue: 'fleet' });
    expect(await drill.result(ROUND)).toEqual(BROKEN);
    expect(t.calls).toEqual([`result:${ROUND.workflowId}:${ROUND.runId}`]);
  });
});
