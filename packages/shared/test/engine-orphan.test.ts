// #1739：发版暂停后总开关没开回。用法国机上读到的 .history 真行 + 操作记录形状，钉死「有意关」和「发版断链」的判法。
import { describe, expect, it } from 'vitest';
import {
  ENGINE_MASTER_DISABLE,
  ENGINE_MASTER_ENABLE,
  ENGINE_PAUSE_REASON_PREFIX,
  ENGINE_RESTORE_REASON_PREFIX,
  type EngineMasterAuditSlice,
  orphanReleasePause,
  releaseHistoryAfter,
} from '../src/web-api/engine-switch.ts';

/** 法国 `/srv/fleet-dao-releases/.history` 在 2026-10-10 会话里读到的末两行（UTC）。 */
const HISTORY_1739 = [
  '2026-10-10T07:42:51Z 6ae542cc8c438df353a80f26b335b054b9cde0a2 release',
  '2026-10-10T08:51:34Z 45401408114c4ce2c6609528b0fb4e668d28d20a release',
] as const;

describe('orphanReleasePause（#1739）', () => {
  it('最近一条是发版前暂停关上、没有后来的打开：断链，应开回', () => {
    const audits: EngineMasterAuditSlice[] = [
      {
        action: ENGINE_MASTER_DISABLE,
        at: '2026-10-10T08:00:00.000Z',
        reason: `${ENGINE_PAUSE_REASON_PREFIX}（驾驶舱点击发布，目标 45401408114c）`,
      },
      {
        action: ENGINE_MASTER_ENABLE,
        at: '2026-10-10T07:48:00.000Z',
        reason: '本机 SSH 开回（#1732）',
      },
    ];
    expect(orphanReleasePause(audits)).toBe(true);
  });

  it('发版后恢复开回过：不算断链', () => {
    expect(
      orphanReleasePause([
        {
          action: ENGINE_MASTER_ENABLE,
          at: '2026-10-10T08:55:00.000Z',
          reason: `${ENGINE_RESTORE_REASON_PREFIX}（驾驶舱点击发布，目标 45401408114c）`,
        },
        {
          action: ENGINE_MASTER_DISABLE,
          at: '2026-10-10T08:40:00.000Z',
          reason: `${ENGINE_PAUSE_REASON_PREFIX}（驾驶舱点击发布，目标 45401408114c）`,
        },
      ]),
    ).toBe(false);
  });

  it('人手关着（原因不是发版前暂停）：不算断链，别自动开', () => {
    expect(
      orphanReleasePause([
        {
          action: ENGINE_MASTER_DISABLE,
          at: '2026-10-10T09:00:00.000Z',
          reason: '创始人在驾驶舱点了关',
        },
      ]),
    ).toBe(false);
  });

  it('没有开关操作记录：不算断链', () => {
    expect(orphanReleasePause([])).toBe(false);
  });
});

describe('#1739 法国现场旁证（.history + 操作记录形状）', () => {
  it('第 1 条：#1732 15:48 CST 开回之后、监督 16:41 之前没有新的 release——总开关再关不是又一次发完未恢复，而是暂停后驱动没走完', () => {
    // #1732 关单约 15:48 CST = 07:48Z；监督旁证 16:41 CST = 08:41Z
    const after1732 = releaseHistoryAfter(HISTORY_1739, '2026-10-10T07:48:00.000Z');
    expect(after1732.map((r) => r.sha.slice(0, 8))).toEqual(['45401408']);
    // 07:48→08:41 窗口内没有 history 行：08:51 那次还在监督之后
    expect(
      releaseHistoryAfter(HISTORY_1739, '2026-10-10T07:48:00.000Z').filter(
        (r) => r.at < '2026-10-10T08:41:00Z',
      ),
    ).toEqual([]);
  });

  it('第 1/4 条：叠上「发版前暂停」操作记录后判为断链，不是有意关；根因与 #1674/#1732 同一条暂停链', () => {
    // 现场：15:42Z 发过一版（#1732 那次未恢复）→ 15:48 人手 engine on → 之后又一次「发版前暂停」关着、驱动死掉、
    // .train 空了继承不了 before → 16:51 再发时 OLD 逻辑把已经关着记成「本来就关着」。
    const audits: EngineMasterAuditSlice[] = [
      {
        action: ENGINE_MASTER_DISABLE,
        at: '2026-10-10T08:10:00.000Z',
        reason: `${ENGINE_PAUSE_REASON_PREFIX}（驾驶舱点击发布，目标 45401408114c）`,
      },
      {
        action: ENGINE_MASTER_ENABLE,
        at: '2026-10-10T07:48:00.000Z',
        reason: '账号被封了…（#1732 本机 SSH fleet-api engine on）',
      },
      {
        action: ENGINE_MASTER_DISABLE,
        at: '2026-10-10T07:42:00.000Z',
        reason: `${ENGINE_PAUSE_REASON_PREFIX}（release-train，目标 6ae542cc8c43）`,
      },
    ];
    expect(orphanReleasePause(audits)).toBe(true);
    // 16:51 那次发版在断链暂停之后：旁证「又一次发版叠在未恢复的暂停上」
    const pauseAt = audits[0]?.at ?? '';
    expect(pauseAt).not.toBe('');
    expect(releaseHistoryAfter(HISTORY_1739, pauseAt).map((r) => r.sha.slice(0, 8))).toEqual(['45401408']);
  });

  it('第 3 条：有意关着时 orphan 为假——监督不应反复当断链开新单', () => {
    expect(
      orphanReleasePause([
        {
          action: ENGINE_MASTER_DISABLE,
          at: '2026-10-10T09:00:00.000Z',
          reason: '有意关着，预计明日重开',
        },
      ]),
    ).toBe(false);
  });
});
