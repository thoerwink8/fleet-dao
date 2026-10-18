// 冷验收结论（runs.verdict）的形状校验（#3140）：库里写之前、接口读出来之后都过这一道。字段的意思见 run-cause.ts 的 RunVerdict。
import { z } from 'zod';
import type { RunVerdict } from './run-cause.ts';

export const RunVerdictSchema = z.object({
  pass: z.boolean(),
  problems: z.array(z.string()),
  failedCriteria: z.array(z.number().int().positive()),
  handedOver: z.array(z.string()),
});

/** 编译期闸：和 run-cause.ts 的 RunVerdict 一字不差。 */
export const RUN_VERDICT_MATCHES: z.infer<typeof RunVerdictSchema> extends RunVerdict
  ? RunVerdict extends z.infer<typeof RunVerdictSchema>
    ? true
    : false
  : false = true;
