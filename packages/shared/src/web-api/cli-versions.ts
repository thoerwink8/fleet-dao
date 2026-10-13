// 法国页「命令行工具」（GET /france/cli-tools）：两个会话用户和全局 npm 的在用版本、官方最新、现算的状态。
// 读不到写读不到，官方最新认不出写没查成和原因，不拿空、0 或「最新」顶。落后不在库里，由读数现算。
import { z } from 'zod';
import { Time } from './internal.ts';

const CliToolCellSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), version: z.string().min(1) }),
  z.object({ state: z.literal('unread'), why: z.string().min(1) }),
  z.object({ state: z.literal('unreadable'), why: z.string().min(1) }),
]);

const CliToolStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current'), label: z.literal('最新') }),
  z.object({ kind: z.literal('behind'), count: z.number().int().positive(), label: z.string().min(1) }),
  z.object({
    kind: z.literal('behind-uncounted'),
    reason: z.string().min(1),
    label: z.literal('落后（数不出几个）'),
  }),
  z.object({ kind: z.literal('unread'), reason: z.string().min(1), label: z.literal('读不到') }),
  z.object({ kind: z.literal('unreadable'), reason: z.string().min(1), label: z.literal('没查成') }),
]);

export const CliToolRowSchema = z.object({
  scope: z.enum(['user', 'npm']),
  owner: z.string(),
  tool: z.string().min(1),
  name: z.string().min(1),
  installed: CliToolCellSchema,
  latest: CliToolCellSchema,
  status: CliToolStatusSchema,
  /** 从没读过是 null。 */
  checkedAt: Time.nullable(),
});

export const CliToolsResponseSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    groups: z.array(
      z.object({
        scope: z.enum(['user', 'npm']),
        owner: z.string(),
        title: z.string().min(1),
        rows: z.array(CliToolRowSchema),
      }),
    ),
    asOf: Time,
  }),
  z.object({ state: z.literal('unreadable'), why: z.string().min(1), asOf: Time }),
]);

export type CliToolsResponse = z.infer<typeof CliToolsResponseSchema>;
export type CliToolRow = z.infer<typeof CliToolRowSchema>;
