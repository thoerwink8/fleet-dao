// 退役停点（#3407）：成果已经由别的 PR 合进主线、只差收掉的停点，按名单在每小时对账里放弃这一代并撤挂起提醒。
// 起因：#3207 停在「改动超出体量预算」（park:1），指挥官 2026-10-20 裁决拆单，两片 #3306 / PR #3324、#3352 / PR #3358
// 都已合；#3358 正文只挂了 #3352，没人收原单，单开着、任务停着，提醒挂着没人接。指挥官用途还没配模型（#3374），
// 新白名单的「停掉」到不了这一停，所以写成名单，发版后对账确定地收掉。
// 规矩：
// - 名单只放核过成果已在主线的停点，身份写全（工作流、run、第几次停下、停法）；任何一样对不上（已继续、换代、换 run、
//   已结束）都不动，名单那一条就此作废，不猜。
// - 放弃走关单收尾同一个 Update（taskCloseClosedIssue，绑精确 run 和停法凭据），只有 accepted 才算数、才撤挂起提醒；
//   stale / busy 不算，读不到、回执未知记没查成。工作流已经没了不算问题（提醒清扫看「不在跑了」会撤）。
// - 只放弃这一代：单子、分支存档照旧，不关单、不开单。

import { errMessage } from '@fleet-dao/shared/util';
import type { ParkKind } from '../task-contract.ts';
import type { ClosedIssueTaskDeps } from './closed-issue-tasks.ts';
import type { SweepPart } from './reconcile-common.ts';

export interface RetiredPark {
  workflowId: string;
  /** 停着的那一代的 Temporal run。 */
  runId: string;
  /** 第几次停下（提醒键 <工作流>:park:<n> 的 n）。 */
  parkSeq: number;
  kind: ParkKind;
  /** 放弃信号的 reason，也是撤提醒正文「已撤：」和操作记录里的那一句。 */
  reason: string;
}

/** 放弃信号、撤挂起提醒记的「谁」。 */
export const RETIRED_PARK_BY = 'engine:retired-park';

export const RETIRED_PARKS: readonly RetiredPark[] = [
  {
    workflowId: 'task:thoerwink8/fleet-dao#3207',
    runId: '01a151f8-4299-7884-b4c3-ff20c7268305',
    parkSeq: 1,
    kind: 'size',
    reason: '成果已由 #3324、#3358 分片合入主线（指挥官 2026-10-20 裁决拆单），停点退役（#3407）',
  },
];

export interface RetiredParkDeps {
  closedIssueTasks: Pick<
    ClosedIssueTaskDeps['closedIssueTasks'],
    'parkOf' | 'holdForClose' | 'abandon' | 'resolveParkAlerts'
  >;
  log: ClosedIssueTaskDeps['log'];
}

/** 名单里的停点逐个核身份，对得上的放弃这一代、撤挂起提醒。没有 parkOf / holdForClose（旧装配）就什么都不做。 */
export async function abandonRetiredParks(
  deps: RetiredParkDeps,
  list: readonly RetiredPark[] = RETIRED_PARKS,
): Promise<SweepPart> {
  const part: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  const port = deps.closedIssueTasks;
  const { parkOf, holdForClose } = port;
  if (!parkOf || !holdForClose) return part;
  for (const entry of list) {
    part.scanned += 1;
    const id = entry.workflowId;
    try {
      const park = await parkOf.call(port, id);
      if (park === 'gone' || park === null) continue;
      if (park.seq !== entry.parkSeq || park.kind !== entry.kind) continue;
      const hold = await holdForClose.call(port, id);
      if (hold.kind !== 'parked' || !hold.token || hold.token.runId !== entry.runId) continue;
      const result = await port.abandon(id, { by: RETIRED_PARK_BY, reason: entry.reason }, hold.token);
      if (result !== 'accepted') continue;
      part.found += 1;
      deps.log('info', '每小时对账：退役停点已放弃这一代', { workflowId: id, parkSeq: entry.parkSeq });
      try {
        await port.resolveParkAlerts(id, entry.reason, RETIRED_PARK_BY);
      } catch (err) {
        part.unchecked.push(`${id} 退役停点已放弃，挂起提醒没撤成：${errMessage(err)}`);
      }
    } catch (err) {
      part.unchecked.push(`${id} 退役停点（park:${entry.parkSeq}）没收成，任务不动：${errMessage(err)}`);
    }
  }
  return part;
}
