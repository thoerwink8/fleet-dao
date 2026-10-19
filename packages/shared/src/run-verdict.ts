// 冷验收结论（runs.verdict）的形状校验（#3140）：库里写之前、接口读出来之后都过这一道。字段的意思见 run-cause.ts 的 RunVerdict。
import { z } from 'zod';
import type { RunVerdict } from './run-cause.ts';

export const RunVerdictSchema = z.object({
  pass: z.boolean(),
  problems: z.array(z.string()),
  failedCriteria: z.array(z.number().int().positive()),
  handedOver: z.array(z.string()),
});

/** 按精确 PR 头保存的组合裁决；各家原始裁决始终只属于各自 run。 */
export const VerifyAggregateSchema = z.object({
  taskId: z.guid(),
  workflowId: z.string().min(1).optional(),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  round: z.union([z.literal(1), z.literal(2)]),
  sourceRunIds: z.array(z.guid()).min(1),
  verdict: RunVerdictSchema,
});
export type VerifyAggregate = z.infer<typeof VerifyAggregateSchema>;

/** 编译期闸：和 run-cause.ts 的 RunVerdict 一字不差。 */
export const RUN_VERDICT_MATCHES: z.infer<typeof RunVerdictSchema> extends RunVerdict
  ? RunVerdict extends z.infer<typeof RunVerdictSchema>
    ? true
    : false
  : false = true;
