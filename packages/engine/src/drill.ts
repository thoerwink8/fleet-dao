// 一条命令起一次演练（#452「一条命令起一次完整演练」，入口 pnpm drill → bin/drill.ts）：立刻跑一轮全流程巡检——和每 6 小时
// 那一轮是同一个定时任务（canary）、同一份代码（jobs/canary.ts），不另写一套——等它有结论，打印每一步几点走完、用了多久；
// 断了照实报停在哪一步、为什么。
// 退出码：0 通过；1 断了；2 巡检自己没跑成，或这条命令自己没查成（连不上 Temporal、没有这个定时任务、触发了没见它起、
// 工作流没给结论就失败了、结局认不出）。
// 改这里之前必须知道：
// - 起一轮走定时任务的「立刻跑一次」（trigger，重叠策略照 SKIP）：已经有一轮在跑就不另起、接上它等结论——两轮叠着跑会在巡检仓里
//   抢同一个文件（jobs/schedules.ts）。
// - 每一步的时刻从这一轮的结局里读（CanaryRun 的 startedAt、endedAt、steps）；换版本之前的引擎起的一轮没有这几样，照实说读不到，
//   不拿 0 顶。
import {
  CANARY_STAGE_NAMES,
  CANARY_VERDICTS,
  type CanaryStep,
  type CanaryVerdict,
  type RecordedCanaryStage,
} from '@fleet-dao/db';
import { type Client, ScheduleNotFoundError, ScheduleOverlapPolicy } from '@temporalio/client';
import { CANARY_JOB, CANARY_MAX_MINUTES, spanWords, stepSpans } from './jobs/canary.ts';
import { message } from './jobs/reconcile-common.ts';

/** 0 通过；1 断了；2 没跑成或没查成。 */
export type DrillExit = 0 | 1 | 2;

/** 这一次演练等的是哪一轮巡检。 */
export interface DrillRound {
  workflowId: string;
  runId: string;
  /** true：已经有一轮在跑，接上它等，没另起。 */
  attached: boolean;
}

export interface DrillDeps {
  /** 起一轮（已经有一轮在跑就接上它）。连不上 Temporal、没有这个定时任务、触发了一直没见它起：照抛。 */
  start(): Promise<DrillRound>;
  /** 等这一轮的结局（工作流的返回值）。工作流没给结论就失败了：照抛。 */
  result(round: DrillRound): Promise<unknown>;
  print(line: string): void;
}

/** 认出来的这一轮结局；startedAt、endedAt、steps 换版本前的老结局里没有，是 null。 */
interface DrillRun {
  canaryRunId: number | null;
  verdict: CanaryVerdict;
  stage: string;
  issueNumber: number | null;
  why: string | null;
  startedAt: string | null;
  endedAt: string | null;
  steps: CanaryStep[] | null;
}

const asRecord = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

const isVerdict = (x: unknown): x is CanaryVerdict => CANARY_VERDICTS.some((v) => v === x);

/** 工作流交回来的结局 → 认得出的样子；认不出回 error（不猜通没通过）。 */
function parseRun(raw: unknown): DrillRun | { error: string } {
  const r = asRecord(raw);
  if (!r) return { error: '不是一个对象' };
  if (!isVerdict(r.verdict))
    return { error: `结论「${String(r.verdict)}」不是 ${CANARY_VERDICTS.join(' / ')}` };
  if (typeof r.stage !== 'string' || !r.stage) return { error: '没写停在哪一步' };
  const issueNumber = r.issueNumber;
  if (issueNumber !== null && !(typeof issueNumber === 'number' && Number.isInteger(issueNumber))) {
    return { error: '单号认不出' };
  }
  const why = r.why;
  if (why !== null && why !== undefined && typeof why !== 'string') return { error: '原因认不出' };
  const optionalText = (x: unknown): string | null | 'bad' =>
    x === undefined ? null : typeof x === 'string' ? x : 'bad';
  const startedAt = optionalText(r.startedAt);
  const endedAt = optionalText(r.endedAt);
  if (startedAt === 'bad' || endedAt === 'bad') return { error: '起止时刻认不出' };
  let steps: CanaryStep[] | null = null;
  if (r.steps !== undefined) {
    if (!Array.isArray(r.steps)) return { error: '每一步的记录不是一个列表' };
    steps = [];
    for (const s of r.steps) {
      const step = asRecord(s);
      if (!step || typeof step.stage !== 'string' || typeof step.at !== 'string') {
        return { error: '每一步的记录里有一条认不出' };
      }
      steps.push({ stage: step.stage as RecordedCanaryStage, at: step.at });
    }
  }
  return {
    canaryRunId: typeof r.canaryRunId === 'number' ? r.canaryRunId : null,
    verdict: r.verdict,
    stage: r.stage,
    issueNumber: issueNumber ?? null,
    why: why ?? null,
    startedAt,
    endedAt,
    steps,
  };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间「10-04 02:26:31」；认不出原样给。 */
function beijing(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = new Date(ms + BEIJING_OFFSET_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 19)}`;
}

const nameOf = (stage: string): string => CANARY_STAGE_NAMES[stage as RecordedCanaryStage] ?? stage;

/** 一轮的结局 → 要打印的几行和退出码（纯函数）。 */
export function drillReport(raw: unknown): { lines: string[]; exitCode: DrillExit } {
  const run = parseRun(raw);
  if ('error' in run) {
    return { lines: [`这一轮巡检的结局认不出（${run.error}），不知道通没通过`], exitCode: 2 };
  }
  const which = run.canaryRunId === null ? '这一轮' : `第 ${run.canaryRunId} 轮`;
  const where = run.issueNumber === null ? '单没开成' : `巡检单 #${run.issueNumber}`;
  const head =
    run.verdict === 'pass'
      ? '通过'
      : run.verdict === 'broken'
        ? `断在「${nameOf(run.stage)}」`
        : `巡检自己没跑成（停在「${nameOf(run.stage)}」）`;
  const lines = [`全流程巡检${which}：${head}（${where}）`];
  if (run.steps === null || run.startedAt === null) {
    lines.push('  每一步用时读不到：这一轮是换版本之前的引擎起的，结局里没记每一步的时刻');
  } else {
    if (run.steps.length === 0) lines.push('  一步都没走完');
    for (const s of stepSpans(run.startedAt, run.steps)) {
      lines.push(
        `  ${nameOf(s.stage)}  ${beijing(s.at)}  ${s.ms === null ? '用时读不到（时刻认不出）' : `用时 ${spanWords(s.ms)}`}`,
      );
    }
    const end = run.endedAt === null ? Number.NaN : Date.parse(run.endedAt);
    if (run.verdict !== 'pass') {
      const last = Date.parse(run.steps.at(-1)?.at ?? run.startedAt);
      lines.push(
        `  ${nameOf(run.stage)}  没走完${Number.isFinite(end) && Number.isFinite(last) ? `：从上一步走完到有结论过了 ${spanWords(Math.max(0, end - last))}` : ''}`,
      );
    }
    const begin = Date.parse(run.startedAt);
    if (Number.isFinite(end) && Number.isFinite(begin)) {
      lines.push(`一共用了 ${spanWords(Math.max(0, end - begin))}`);
    }
  }
  if (run.why) lines.push(run.verdict === 'pass' ? `备注：${run.why}` : `为什么：${run.why}`);
  return { lines, exitCode: run.verdict === 'pass' ? 0 : run.verdict === 'broken' ? 1 : 2 };
}

/** 起一轮、等结论、照实打印。哪一步没成都照实说、退出码 2，不当成通过。 */
export async function runDrill(deps: DrillDeps): Promise<DrillExit> {
  let round: DrillRound;
  try {
    round = await deps.start();
  } catch (err) {
    deps.print(`没查成：没起成这一轮演练（${message(err)}）`);
    return 2;
  }
  const most = `一轮最长 ${CANARY_MAX_MINUTES / 60} 小时`;
  deps.print(
    round.attached
      ? `已经有一轮全流程巡检在跑（${round.workflowId}），不另起，接上它等结论（${most}）`
      : `起了一轮全流程巡检（${round.workflowId}），等结论（${most}）`,
  );
  let result: unknown;
  try {
    result = await deps.result(round);
  } catch (err) {
    deps.print(
      `没查成：这一轮巡检的工作流没给结论就失败了（看一回的活动连着失败，多半是库或 Temporal 出事；库里这一轮停在「在跑」）：${message(err)}`,
    );
    return 2;
  }
  const report = drillReport(result);
  for (const line of report.lines) deps.print(line);
  return report.exitCode;
}

/** 起一轮、等结论用到的 Temporal 那几下（真客户端满足它；测试给假的）。 */
export type DrillClient = Pick<Client, 'schedule' | 'workflow'>;

export interface TemporalDrillOptions {
  print: (line: string) => void;
  /** 定时任务编号；默认 canary（jobs/schedules.ts 的 CANARY_SCHEDULE_ID）。 */
  scheduleId?: string;
  /** 触发以后多久没见它起一轮算没起成（毫秒）。 */
  startTimeoutMs?: number;
  /** 触发以后隔多久看一次起没起（毫秒）。 */
  pollMs?: number;
  /** 等结论时隔多久打印一句「还在等」（毫秒）。 */
  noteEveryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 真的 Temporal：触发定时任务、认出起的是哪一轮、等它的结局。 */
export function temporalDrill(client: DrillClient, o: TemporalDrillOptions): Omit<DrillDeps, 'print'> {
  const scheduleId = o.scheduleId ?? CANARY_JOB.id;
  const startTimeoutMs = o.startTimeoutMs ?? 60_000;
  const pollMs = o.pollMs ?? 2_000;
  const noteEveryMs = o.noteEveryMs ?? 10 * 60_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? (() => Date.now());
  const handle = client.schedule.getHandle(scheduleId);
  const describe = async () => {
    try {
      return await handle.describe();
    } catch (err) {
      if (err instanceof ScheduleNotFoundError) {
        throw new Error(
          `Temporal 上没有定时任务 ${scheduleId}：引擎还没以真端口起过（定时任务是引擎起来时建的）`,
        );
      }
      throw err;
    }
  };
  return {
    async start() {
      const before = await describe();
      const running = before.info.runningActions.at(-1);
      if (running) {
        return {
          workflowId: running.workflow.workflowId,
          runId: running.workflow.firstExecutionRunId,
          attached: true,
        };
      }
      const taken = before.info.numActionsTaken;
      await handle.trigger(ScheduleOverlapPolicy.SKIP);
      const deadline = now() + startTimeoutMs;
      for (;;) {
        const d = await describe();
        const fresh =
          d.info.runningActions.at(-1) ??
          (d.info.numActionsTaken > taken ? d.info.recentActions.at(-1)?.action : undefined);
        if (fresh) {
          return {
            workflowId: fresh.workflow.workflowId,
            runId: fresh.workflow.firstExecutionRunId,
            attached: false,
          };
        }
        if (now() >= deadline) {
          throw new Error(
            `触发了定时任务 ${scheduleId}，${Math.round(startTimeoutMs / 1000)} 秒里没见它起一轮（看 fleet-temporal schedule describe --schedule-id ${scheduleId}）`,
          );
        }
        await sleep(pollMs);
      }
    },
    async result(round) {
      const since = now();
      const note = setInterval(() => {
        const minutes = Math.round((now() - since) / 60_000);
        o.print(`还在等这一轮的结论（已经 ${minutes} 分钟；走到哪看健康页「全流程巡检」或库里 canary_runs）`);
      }, noteEveryMs);
      try {
        return await client.workflow.getHandle(round.workflowId, round.runId).result();
      } finally {
        clearInterval(note);
      }
    },
  };
}
