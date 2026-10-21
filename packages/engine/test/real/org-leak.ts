// 「组织编号不许进库里会展示的内容」这类断言共用的取文本帮手（#3487）。
//
// 老写法把整行 audit_log、notifications 串成 JSON 再查 1111/2222 这类短编号，会把随机生成的不透明身份
// （通知主键 uuid、挂单/挂仓的 uuid、audit_log.target 里 `notification:<uuid>` 的那段）里碰巧出现的 1111 当成泄漏。
// 这里只把「不透明身份」这一小撮字段去掉或打码，其余（通知标题/正文/去重键/链接/选项/回答，
// 审计的动作/对象前缀/前后值/原因/错误……）原样留着查：组织编号真进了这些地方，照样确定失败。
//
// 不按键名全局忽略 id：每个字段为什么合法写在下面。

import type { auditLog, notifications } from '@fleet-dao/db';
import { expect } from 'vitest';

type AuditRow = typeof auditLog.$inferSelect;
type NotificationRow = typeof notifications.$inferSelect;

/** 标准 8-4-4-4-12 的 uuid：只认完整形状，`1111` 单独出现在正文里不会被它盖住。 */
const UUID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * 审计行拿去查泄漏的样子：`target` 形如 `notification:<uuid>`，里面的 uuid 是随机的对象身份，打成 `<uuid>`；
 * 前缀（`notification:`、`session-user:…`）和其它所有字段原样保留。`id` 是自增整数，不会长成 1111 这种串，不动。
 */
export function shownAudits(rows: readonly AuditRow[]): AuditRow[] {
  return rows.map((row) => ({ ...row, target: row.target.replace(UUID_TOKEN, '<uuid>') }));
}

/**
 * 通知行拿去查泄漏的样子：去掉三个随机 uuid 列——`id`（通知主键）、`taskId`、`repoId`（外键，指向别的表的主键）。
 * 它们只是身份，不是展示内容；title/body/dedupeKey/link/decisionOptions/answer/resolvedBy 全部留着。
 */
export function shownNotifications(
  rows: readonly NotificationRow[],
): Omit<NotificationRow, 'id' | 'taskId' | 'repoId'>[] {
  return rows.map(({ id: _id, taskId: _taskId, repoId: _repoId, ...shown }) => shown);
}

/** 展示内容（任意可串成 JSON 的东西）里不许出现这些组织编号。 */
export function expectNoOrgIds(shown: unknown, bad: readonly string[]): void {
  const text = JSON.stringify(shown);
  for (const b of bad) expect(text).not.toContain(b);
}
