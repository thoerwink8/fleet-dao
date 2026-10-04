// 会话用户切号的账本（#194，specs/194-拼车自动切换/方案-v2.md 4.4、4.6、第六节第 13 条）：每个会话用户一行。
// 「拼车恢复条件」（哪一种用不了、几点恢复、从哪读来）、切回记录、白切记账、帮手失败记账、最近几次接口读数、
// 「引擎暂不用独享」开关、渠道状态都在 doc 里（形状由引擎认，库不认；读回来认不出，引擎明确失败，不当成空）。
// 锁单独两列：切号单飞，锁过期自己放（引擎做到一半重启，下一个进程等锁过期再接手）。
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;

export const sessionOrgState = pgTable('session_org_state', {
  /** 会话用户名（SESSION_USERS 里的一个）。 */
  userName: text('user_name').primaryKey(),
  /** 账本本体（引擎的 OrgLedger，时间一律 ISO 字符串）。 */
  doc: jsonb('doc').notNull(),
  updatedAt: timestamp('updated_at', tz).notNull(),
  /** 切号的锁：谁拿着、几点过期。没人拿着两列都是空。 */
  lockHolder: text('lock_holder'),
  lockUntil: timestamp('lock_until', tz),
});
