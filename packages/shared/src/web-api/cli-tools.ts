// 法国页「命令行工具」（#1971）：root 的升级单元写在 /var/lib/fleet-dao/cli-upgrade/state.json，这里只读给页面。
// 文件不在 = 还没升过（ok、名单空），不当成没查成。读不到、认不出走 unreadable，页面写原因。
import { z } from 'zod';
import { Time } from './internal.ts';

const OUTCOMES = ['ok', 'current', 'skipped', 'failed', 'rolled-back', 'refused'] as const;

export const FranceCliToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  /** 这一版是什么时候升上去的。这轮没换、或还没升过，是 null。 */
  upgradedAt: Time.nullable(),
  channel: z.string().nullable(),
  outcome: z.enum(OUTCOMES).nullable(),
  detail: z.string(),
});

export const FranceCliToolsSchema = z.object({
  state: z.enum(['ok', 'unreadable']),
  /** 没查成的原因。查成了是 null。 */
  reason: z.string().nullable(),
  /** 最近一轮核对的时刻。还没升过是 null。 */
  checkedAt: Time.nullable(),
  /** 最近一轮是空闲触发还是发版窗口。还没升过是 null。 */
  why: z.enum(['idle', 'release']).nullable(),
  tools: z.array(FranceCliToolSchema),
});

export type FranceCliTools = z.infer<typeof FranceCliToolsSchema>;
export type FranceCliTool = z.infer<typeof FranceCliToolSchema>;
