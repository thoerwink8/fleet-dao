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
  releasePauseStillActive,
} from '../src/web-api/engine-switch.ts';

/**
 * 法国 `/srv/fleet-dao-releases/.history` 在本会话（2026-10-10，主机 vmi3551059）`tail` 读到的末五行（UTC）。
 * 第 1 条核对用：#1732 开回（≈07:48Z）到监督旁证（08:41Z）之间没有新 release。
 */
const HISTORY_1739 = [
  '2026-10-10T02:40:27Z ccf3560a713fd7d9690ced2d6c83a27fa2aa33da release',
  '2026-10-10T04:11:04Z 5d7e2a98f1a67e1244e729c883aac36ab87b61df release',
  '2026-10-10T04:29:56Z 4d0dc28ebe29894f135fcefeacb5907d0669fa58 release',
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

  it('有意关着但原因里提到「发版前暂停」字样：仍不算断链（必须以前缀开头，#1739 返工）', () => {
    expect(
      orphanReleasePause([
        {
          action: ENGINE_MASTER_DISABLE,
          at: '2026-10-10T09:00:00.000Z',
          reason: '排查发版前暂停问题，预计明日重开',
        },
      ]),
    ).toBe(false);
  });

  it('没有开关操作记录：不算断链', () => {
    expect(orphanReleasePause([])).toBe(false);
  });
});

describe('releasePauseStillActive（#1739：驱动死了不能挡开回）', () => {
  const alive = () => true;
  const dead = () => false;

  it('没有暂停标记：不挡', () => {
    expect(
      releasePauseStillActive({
        markerPresent: false,
        train: { status: 'running', pid: 1 },
        pidAlive: alive,
      }),
    ).toBe(false);
  });

  it('标记在、驱动 pid 还活着：挡（真发版中途）', () => {
    expect(
      releasePauseStillActive({
        markerPresent: true,
        train: { status: 'running', pid: 42 },
        pidAlive: alive,
      }),
    ).toBe(true);
  });

  it('标记在、进度还写 running 但驱动已死：不挡，巡检应开回', () => {
    expect(
      releasePauseStillActive({
        markerPresent: true,
        train: { status: 'running', pid: 42 },
        pidAlive: dead,
      }),
    ).toBe(false);
  });

  it('标记在、进度已是 failed/blocked：不挡', () => {
    expect(
      releasePauseStillActive({
        markerPresent: true,
        train: { status: 'failed', pid: 42 },
        pidAlive: alive,
      }),
    ).toBe(false);
    expect(
      releasePauseStillActive({
        markerPresent: true,
        train: { status: 'blocked', pid: null },
        pidAlive: alive,
      }),
    ).toBe(false);
  });

  it('标记在、没有进度文件：不挡（孤儿标记）', () => {
    expect(releasePauseStillActive({ markerPresent: true, train: null, pidAlive: alive })).toBe(false);
  });

  it('标记在、running 但老记录没写 pid：挡（不敢猜）', () => {
    expect(
      releasePauseStillActive({
        markerPresent: true,
        train: { status: 'running', pid: null },
        pidAlive: dead,
      }),
    ).toBe(true);
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

  it('第 1/4 条现场：本会话读到 .train 空（无 paused、无 json）——暂停标记已不在，挡开回的应是未部署的 heal 逻辑或操作记录仍为发版前暂停', () => {
    // 2026-10-10 本会话在 vmi3551059 上 ls /srv/fleet-dao-releases/.train → 空目录。
    // 有标记才谈「驱动死了仍挡」；当前复发窗口更像：暂停后驱动没走完 → 16:51 又发一版叠在「本来就关着」上。
    expect(releasePauseStillActive({ markerPresent: false, train: null, pidAlive: () => true })).toBe(false);
    expect(
      orphanReleasePause([
        {
          action: ENGINE_MASTER_DISABLE,
          at: '2026-10-10T08:10:00.000Z',
          reason: `${ENGINE_PAUSE_REASON_PREFIX}（驾驶舱点击发布，目标 45401408114c）`,
        },
      ]),
    ).toBe(true);
  });
});
