// runs 表还没建（#556-4/-5/-6 才建）：runner 在会话结束后本来要写一笔（单号 / segment / 模型 / 渠道 / 起止 / token /
// 花费 / 内存峰值 / outcome）。本切片不接真库，用这个 NotWired 占位——装配时换成它，**被调到也把整包参数
// 记下来落盘到本地 JSONL**，并标记 notWired（驾驶舱 / 健康检查读到这个标记就显示「待实现 · #556」，不装成已接上）。
//
// 和 packages/api/src/draft-opening.ts 的 notWiredDraftOpener 同一个做法（「未接」和「没查成」分开）。
// 等 #556 的真实 RunsTable 接上，装配处把 notWiredRuns() 换掉即可，合约（zod schema + Record 字段）不动。

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** 健康检查 / 驾驶舱里显示的「未接」那一句（外部看得到）。 */
export const RUNS_NOT_WIRED = 'runs 表还没建（#556）';

/**
 * 会话结束要记的那一笔。zod 钉住形状：调进来的、占位要落盘的、#556 真实实现要入库的，都是这一份。
 * 所有「读不到就不给」的字段（#216：token、costUsd 不当 0）都 optional。
 */
export const RunRecordSchema = z.object({
  /** 这一次会话的编号（UUID，调用方起）。同一 runId 记第二笔由 #556 的真实实现按幂等键去重。 */
  runId: z.string().min(1),
  /** 哪一段：scope | manual | verify。 */
  segment: z.enum(['scope', 'manual', 'verify']),
  /** 需求单号（GitHub issue #）；不属于任何需求的会话（巡逻、实验）可空。 */
  issueNumber: z.number().int().positive().optional(),
  /** 挑好的模型（路由给的 modelId；不是家族的）。 */
  model: z.string().min(1),
  /** 挑好的渠道（poolId / routeId 的「渠道」那半截）；读不到不给。 */
  channel: z.string().min(1).optional(),
  /** 起止（ISO 8601）。 */
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  /** token / 花费：读不到的字段不给，不当 0（#216）。 */
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** 内存峰值（MiB）。只对挂在 cgroup 里的会话可读；本机不给。 */
  memoryPeakMb: z.number().nonnegative().optional(),
  /** 谁把它收了：done / timeout / killed / spawn_failed / admission_blocked。 */
  outcome: z.enum(['done', 'timeout', 'killed', 'spawn_failed', 'admission_blocked', 'failed']),
  /** 失败原因（exit code、错误消息），outcome != 'done' 时给。 */
  failureReason: z.string().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** 真实实现（#556 起）和 NotWired 占位都长这个样。 */
export interface RunsWriter {
  /** 装配时给的「未接」标记：配了就说明这块压根没接上；真实现不设。 */
  readonly notWired?: string;
  record(run: RunRecord): Promise<void>;
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

/** 真到 #556 接上前的临时：只是把 RunsWriter 暴露出来过类型。 */
export function assertRunsWriter(w: RunsWriter): RunsWriter {
  return w;
}
