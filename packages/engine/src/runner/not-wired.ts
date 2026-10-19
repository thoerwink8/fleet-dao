// runs 表还没建（#556-4/-5/-6 才建）：runner 在会话结束后本来要写一笔（单号 / segment / 模型 / 渠道 / 起止 / token /
// 花费 / 内存峰值 / outcome）。本切片不接真库，用这个 NotWired 占位——装配时换成它，**被调到也把整包参数
// 记下来落盘到本地 JSONL**，并标记 notWired（驾驶舱 / 健康检查读到这个标记就显示「待实现 · #556」，不装成已接上）。
//
// 和 packages/api/src/judge-health.ts 没配判断题时的 notWired 同一个做法（「未接」和「没查成」分开）。
// 等 #556 的真实 RunsTable 接上，装配处把 notWiredRuns() 换掉即可，合约（zod schema + Record 字段）不动。

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUN_CAUSE_SUMMARY_MAX, RUN_CAUSES, type RunVerdict } from '@fleet-dao/shared';
import { z } from 'zod';
import { TierEnum } from './tier.ts';

/** 健康检查 / 驾驶舱里显示的「未接」那一句（外部看得到）。 */
export const RUNS_NOT_WIRED = 'runs 表还没建（#556）';

/** runs 一行的各列（下面 RunRecordSchema、RunStartSchema 都从这里取；zod 的 pick 不收带 refine 的对象）。 */
const RunRecordFields = z.object({
  /** 这一次会话的编号（UUID，调用方起）。同一 runId 记第二笔由 #556 的真实实现按幂等键去重。 */
  runId: z.string().min(1),
  /** 哪一段：scope | manual | verify。 */
  segment: z.enum(['scope', 'manual', 'verify']),
  /** 这一笔挂在哪张单上：库里的 tasks.id（uuid）。不属于任何需求的会话（巡逻、实验）不给。 */
  taskId: z.guid().optional(),
  /** 需求单号（GitHub issue #）；不属于任何需求的会话（巡逻、实验）可空。 */
  issueNumber: z.number().int().positive().optional(),
  /** 挑好的模型（路由给的 modelId；不是家族的）。 */
  model: z.string().min(1),
  /** 挑好的渠道（poolId / routeId 的「渠道」那半截）；读不到不给。 */
  channel: z.string().min(1).optional(),
  /** 跑在哪条路由上（选路给的）：切号靠它认出这一段跑在哪个池（#157）；不经选路起的不给。 */
  routeId: z.string().min(1).optional(),
  /** 派工档（runner/tier.ts 的三档）：只有动手段分档（决定 0010 第 3 条），对题、验收带了就拒收。 */
  tier: TierEnum.optional(),
  /** 选路时那句「为什么派它」（写进 runs.route_why）。没经选路、老历史不给。 */
  routeWhy: z.string().min(1).optional(),
  /** 跑在哪条 Temporal 工作流里（任务工作流是 taskWorkflowId(仓, 单号)）；不在工作流里跑的不给。 */
  workflowId: z.string().min(1).optional(),
  /** 这一段对着的 PR；还没开 PR 的（动手第一轮）不给。 */
  prNumber: z.number().int().positive().optional(),
  /** 会话干活的分支。 */
  branch: z.string().min(1).optional(),
  /** 会话起在哪个目录（工作树路径，写进 runs.worktree_path）：每小时对账删树前认树里有没有没结束的会话。 */
  worktreePath: z.string().min(1).optional(),
  /** 起止（ISO 8601）。 */
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  /** token / 花费：读不到的字段不给，不当 0（#216）。 */
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** 执行体报的会话号（收场才有）；没开成会话、读不到不给。经 Mirasim 起的会话靠它事后补读用量（#1935）。 */
  sessionId: z.string().min(1).optional(),
  /** 这一段起跑前判定要续的会话号；新会话判定则由 resumeReason 说明原因。 */
  resumeSessionId: z.string().min(1).optional(),
  resumeReason: z.string().min(1).optional(),
  /** 为什么起这一笔（#3140，shared 的 RUN_CAUSES）；不经任务工作流起的会话不给。 */
  cause: z.enum(RUN_CAUSES).optional(),
  /** 起因摘要（≤500 字）：为什么、接着做什么。 */
  causeSummary: z.string().min(1).max(RUN_CAUSE_SUMMARY_MAX).optional(),
  /** 这一笔属于第几个回合（task_rounds.seq，#3140）。 */
  roundSeq: z.number().int().positive().optional(),
  /** 内存峰值（MiB）。只对挂在 cgroup 里的会话可读；本机不给。 */
  memoryPeakMb: z.number().int().nonnegative().optional(),
  /** 这一次会话的 CPU 秒数（大于 0）。读不到不给，不写 0（#1980）。 */
  cpuSeconds: z.number().int().positive().optional(),
  /**
   * 谁把它收了：done / timeout / killed / spawn_failed / admission_blocked / failed；org_switch = 切号先停下这一段，
   * 切完任务工作流在原分支上重跑（#59，不算失败）。
   */
  outcome: z.enum(['done', 'timeout', 'killed', 'spawn_failed', 'admission_blocked', 'failed', 'org_switch']),
  /**
   * 这一次算不算这条路由的账（runner/evidence.ts 的 routeOutcomeOf：跑通了 ok、失败分流判路由的错 fail、别的 neutral）：
   * 选路的熔断、战绩读它（#758）。收场必带，漏了当场拒，不让熔断看不见这一次。
   */
  routeOutcome: z.enum(['ok', 'fail', 'neutral']),
  /** 失败原因（exit code、错误消息），outcome != 'done' 时给。 */
  failureReason: z.string().optional(),
  /**
   * 用量为什么没记全、记的是怎么来的（写进 runs.usage_note）：会话被叫停、超时杀，没走到执行体报用量的终帧时给（例如
   * 「cursor 只在终帧报用量……读不到」「按每次调用的用量帧加起来」）。四样都读到了、照终帧记的不给。
   */
  usageNote: z.string().min(1).optional(),
});

/** 只有动手段分档：对题不分档、验收是冷调用，带了派工档就是调用方弄错了。 */
function onlyManualTiered(run: { segment: string; tier?: string | undefined }, ctx: z.RefinementCtx): void {
  if (run.tier !== undefined && run.segment !== 'manual') {
    ctx.addIssue({
      code: 'custom',
      path: ['tier'],
      message: `只有动手段分档（决定 0010 第 3 条），${run.segment} 段不该带派工档「${run.tier}」`,
    });
  }
}

/**
 * 会话结束要记的那一笔。zod 钉住形状：调进来的、占位要落盘的、#556 真实实现要入库的，都是这一份。
 * 所有「读不到就不给」的字段（#216：token、costUsd、PR 号不当 0，分支不当空串）都 optional。
 * 每一样的取值照库里 runs 表的约束收（task_id 是 uuid、派工档三档、PR 号正数……）：对不上的在这里就拒，不等写库时被拒。
 */
export const RunRecordSchema = RunRecordFields.superRefine(onlyManualTiered);
export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * 开跑那一刻记的一行（还没结束：没有止、没有结局、没有用量）：字段和 RunRecord 同名同义。
 * 记到谁名下的几样（单子、派工档、工作流、PR、分支）开跑就带上：在跑的那一笔才挂得上单，不靠单号兜底。
 */
export const RunStartSchema = RunRecordFields.pick({
  runId: true,
  segment: true,
  taskId: true,
  issueNumber: true,
  model: true,
  channel: true,
  routeId: true,
  tier: true,
  routeWhy: true,
  resumeSessionId: true,
  resumeReason: true,
  cause: true,
  causeSummary: true,
  roundSeq: true,
  workflowId: true,
  prNumber: true,
  branch: true,
  worktreePath: true,
  startedAt: true,
}).superRefine(onlyManualTiered);
export type RunStart = z.infer<typeof RunStartSchema>;

/** 真实实现（#556 起）和 NotWired 占位都长这个样。 */
export interface RunsWriter {
  /** 装配时给的「未接」标记：配了就说明这块压根没接上；真实现不设。 */
  readonly notWired?: string;
  /**
   * 开跑：留一行没结束的（#157，切号数在跑的会话靠它）。写不进去要抛——调用方就不起会话，不让一个切号看不见的会话跑起来。
   * 带路由的这一行就是这一次会话占上了池的名额（#757）：给了 reservationId（选路时预占的名额），同一下把它换成这一行；没预占
   * 着名额、池又满了，抛 NoSlotError、一行不写。
   */
  start(run: RunStart, options?: { reservationId?: string }): Promise<void>;
  /** 收场（或没开跑就收了，比如内存放不下）：整行记下；开跑时留过那一行的，补完同一行。 */
  record(run: RunRecord): Promise<void>;
  /** 流里拿到真会话号时提前记回；占位实现可不做。 */
  observeSessionId?(runId: string, sessionId: string): Promise<void>;
  /** 冷验收有结论了（#3140）：写在验收那一笔上（runs.verdict）。占位实现可不做；真实现写不进抛。 */
  noteVerdict?(runId: string, verdict: RunVerdict): Promise<void>;
  noteVerifyAggregate?(input: import('@fleet-dao/shared').VerifyAggregate): Promise<void>;
}

/**
 * 开跑时池的名额满了（#757）：这一段选路时预占的名额过期了（建树、等内存卡得太久）或没预占，空位已经给了别的会话。开跑那一行
 * 没写，会话不起；不是库写不进（那是别的错），过一会儿重新选路就行。
 */
export class NoSlotError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoSlotError';
  }
}

/**
 * 装配用占位：没接 runs 表时**也能落盘、也能暴露「未接」的事实**，但不装成「记了」。
 * 落盘是一份 append-only JSONL（`_tmp/runs-not-wired/<日期>.jsonl`）——等 #556 接上可以一把补导入、
 * 中途机器坏了也不丢已经跑过的会话账。
 */
export function notWiredRuns(deps: { tmpDir: string; now?: () => Date }): RunsWriter {
  const now = deps.now ?? (() => new Date());
  return {
    notWired: RUNS_NOT_WIRED,
    async start(run) {
      // 只挡形状、不落盘：占位不进库，切号（只读库）本来就看不见它；收场那一笔是整行，开跑这一行它都有
      RunStartSchema.parse(run);
    },
    async record(run) {
      // 先把进来的形状挡一道——写进 JSONL 的一定是钉死的那份（schema 漏字段当场红、不许降级）。
      const parsed = RunRecordSchema.parse(run);
      const day = now().toISOString().slice(0, 10);
      const dir = join(deps.tmpDir, 'runs-not-wired');
      await mkdir(dir, { recursive: true });
      const line = `${JSON.stringify({ ...parsed, notWired: RUNS_NOT_WIRED })}\n`;
      await writeFile(join(dir, `${day}.jsonl`), line, { flag: 'a' });
    },
  };
}
