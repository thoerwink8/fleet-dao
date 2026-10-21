// 组织编号泄漏检查的取文本帮手（org-leak.ts，#3487）：固定输入确定地验两头——
// 合法的不透明身份（uuid 里带 1111 / 2222）不误报；组织编号真进了展示内容（通知标题/正文/去重键/链接/选项，
// 审计的原因/错误/前后值/对象）一律确定失败。不靠随机碰撞。

import type { auditLog, notifications } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { expectNoOrgIds, shownAudits, shownNotifications } from './org-leak.ts';

type AuditRow = typeof auditLog.$inferSelect;
type NotificationRow = typeof notifications.$inferSelect;

const BAD = ['1111', '2222'];
/** CI run39565578277 里真出现过的通知 id（#3487）。 */
const UUID_1111 = '98fd158c-bfd1-428a-839c-1111ffbbd085';
const UUID_2222 = '0b6e2f0e-2222-4c1d-9a55-3c1d2222aa01';
const AT = new Date('2026-09-25T08:00:00.000Z');

const notification = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: UUID_1111,
  level: 'alert',
  dedupeKey: 'session-org:drift',
  taskId: UUID_2222,
  repoId: UUID_1111,
  title: '会话用户挂的组织变了，引擎没切过号：拼车 → 独享',
  body: '前后两次读数（北京时间）：09-25 16:00:00 切号读到拼车，09-25 16:02:00 选路读到独享',
  link: null,
  createdAt: AT,
  raisedAt: AT,
  updatedAt: AT,
  resolvedAt: null,
  resolvedBy: null,
  decisionOptions: null,
  decisionReason: null,
  answer: null,
  ...over,
});

const audit = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: 3,
  at: AT,
  actorKind: 'engine',
  actorId: 'engine:session-org',
  action: 'notification.resolve',
  target: `notification:${UUID_1111}`,
  before: null,
  after: null,
  reason: '读数回到了拼车',
  via: 'engine',
  ok: true,
  error: null,
  ...over,
});

const check = (audits: AuditRow[], notes: NotificationRow[]) =>
  expectNoOrgIds([shownAudits(audits), shownNotifications(notes)], BAD);

describe('合法的不透明身份里带 1111 / 2222：不是泄漏', () => {
  it('固定复现：老写法整行串成 JSON 会被通知 uuid 里的 1111 误报，现在的取文本不误报', () => {
    const audits = [audit(), audit({ target: `notification:${UUID_2222}` })];
    const notes = [notification(), notification({ id: UUID_2222, dedupeKey: 'pool-hold:claude-solo' })];
    // 老写法：确定红（原失败 CI run39565578277 的同一类输入）
    expect(() => expectNoOrgIds([audits, notes], BAD)).toThrow(/1111|2222/);
    // 现在：通过
    expect(() => check(audits, notes)).not.toThrow();
  });

  it('只去掉 uuid：target 的前缀、其它字段的内容仍在被查的文本里', () => {
    const text = JSON.stringify([shownAudits([audit()]), shownNotifications([notification()])]);
    expect(text).toContain('notification:<uuid>');
    expect(text).toContain('会话用户挂的组织变了');
    expect(text).not.toContain(UUID_1111);
  });
});

describe('组织编号真进了展示内容：确定失败（含和 uuid 同处一个字段）', () => {
  const cases: [string, () => void][] = [
    ['通知标题', () => check([], [notification({ title: '切到组织 1111 失败' })])],
    ['通知正文', () => check([], [notification({ body: '读到 2222' })])],
    ['通知去重键', () => check([], [notification({ dedupeKey: 'session-org:2222' })])],
    ['通知链接', () => check([], [notification({ link: '/org/1111' })])],
    [
      '通知选项',
      () =>
        check(
          [],
          [
            notification({
              level: 'decision',
              decisionReason: 'human-only',
              decisionOptions: [
                { id: 'a', label: '切到 2222', action: { kind: 'note-only' }, detail: '', recommended: '' },
                { id: 'b', label: '先留着', action: { kind: 'note-only' }, detail: '', recommended: '' },
              ],
            }),
          ],
        ),
    ],
    [
      '通知回答',
      () =>
        check([], [notification({ answer: { text: '组织 1111' } as unknown as NotificationRow['answer'] })]),
    ],
    ['审计原因', () => check([audit({ reason: '帮手切到 2222 失败' })], [])],
    ['审计错误', () => check([audit({ ok: false, error: 'org 1111: boom' })], [])],
    ['审计 before', () => check([audit({ before: { org: 1111 } })], [])],
    ['审计 after', () => check([audit({ after: { org: '2222' } })], [])],
    [
      '审计对象（uuid 之外的部分）',
      () => check([audit({ target: `org:1111/notification:${UUID_1111}` })], []),
    ],
    ['通知正文里编号和 uuid 同在', () => check([], [notification({ body: `组织 1111，通知 ${UUID_2222}` })])],
    ['审计原因里编号紧贴 uuid', () => check([audit({ reason: `1111 ${UUID_1111}` })], [])],
  ];
  it.each(cases)('%s', (_name, run) => {
    expect(run).toThrow(/1111|2222/);
  });
});
