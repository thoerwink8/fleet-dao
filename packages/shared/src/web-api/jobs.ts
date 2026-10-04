// 驾驶舱接口约定（web-api）：定时任务。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { ScheduleOutcomeSchema } from './enums.ts';
import { Id, Time } from './internal.ts';

// —— 定时任务 ——

export const JobViewSchema = z.object({
  id: Id,
  name: z.string(),
  schedule: z.string(),
  /** 上次成功距今超过这么多分钟就算过期（登记时已含周期、抖动和一轮耗时）。 */
  expectEveryMinutes: z.number().int().positive(),
  lastRun: z
    .object({
      startedAt: Time,
      endedAt: Time.optional(),
      /**
       * 没有 = 还在跑。四种结局分开，「没跑成」「没扫到」不能当「没问题」：
       * ok = 跑完了、扫了对象；partial = 跑完了但有一部分没查成；unscanned = 跑完了但一个对象都没扫到；failed = 没跑成。
       */
      outcome: ScheduleOutcomeSchema.optional(),
      /** 扫了几个对象。 */
      scanned: z.number().int().min(0).optional(),
      /** 查出几条问题。ok 且 found=0 才是「查过，没事」。 */
      found: z.number().int().min(0).optional(),
      /** 不是 ok 时写的原因。 */
      why: z.string().optional(),
    })
    .optional(),
  /** 最近一次跑成（ok 或 partial）的结束时刻。 */
  lastSuccessAt: Time.optional(),
  /** fresh = 上次跑成在 expectEveryMinutes 之内；overdue = 超过了；never = 从没跑成过。 */
  status: z.enum(['fresh', 'overdue', 'never']),
});

export const JobsResponse = z.object({ jobs: z.array(JobViewSchema), asOf: Time });
