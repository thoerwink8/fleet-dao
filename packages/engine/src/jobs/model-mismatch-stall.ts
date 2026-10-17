// 已经按 MD3 挂在 stalled 上的在途单（#2742）。
// 工作流重放必须走进已经记下的那次挂起：跳过会 TMPRL1100，任务变僵尸，继续信号也送不进。
// 挂起不是终态。看门狗每 5 分钟认出 last_problem / doing 里那句旧标题，问工作流还停在这句上，
// 再发 taskContinue。醒来后按点名开新会话重派（task-session.ts，patched('model-mismatch-wake-reroute')）。
// 有能派的路由就不再停在 stalled/parked。没有可派路由时的新挂起对不上这一句，不叫醒。

import { errMessage } from '@fleet-dao/shared/util';
import { isLegacyModelMismatchStall } from '../failure/model-mismatch-stall.ts';

export interface ModelMismatchStallRow {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  doing: string | null;
  lastProblem: string | null;
  /** 最近一条记下工作流编号的 runs。没有就不猜第一代。 */
  workflowId: string | null;
}

export interface ModelMismatchStallDeps {
  /** state=stalled 且 executor=engine 的行。读不到照抛。 */
  tasks(): Promise<ModelMismatchStallRow[]>;
  /**
   * 工作流还停在旧的 model_mismatch 挂起上就发「继续」，并撤掉这一挂的提醒。
   * sent＝发了；gone＝工作流已经没了；skipped＝库里的字还是旧的，工作流已经不是这一挂。
   */
  release(workflowId: string): Promise<'sent' | 'gone' | 'skipped'>;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface ModelMismatchStallResult {
  /** 对上旧标题、拿去核对的行数（不是全部 stalled）。 */
  scanned: number;
  continued: number;
  problems: string[];
}

function refOf(row: ModelMismatchStallRow): string {
  return `${row.owner}/${row.name}#${row.issueNumber}`;
}

/** 旧标题挂着的单：有工作流编号就叫醒。列不出来的错向上抛，由看门狗记没查成。 */
export async function continueLegacyModelMismatchStalls(
  deps: ModelMismatchStallDeps,
): Promise<ModelMismatchStallResult> {
  const rows = await deps.tasks();
  const problems: string[] = [];
  let scanned = 0;
  let continued = 0;
  for (const row of rows) {
    if (!isLegacyModelMismatchStall(row.lastProblem) && !isLegacyModelMismatchStall(row.doing)) continue;
    scanned += 1;
    const ref = refOf(row);
    if (!row.workflowId) {
      problems.push(`${ref} 停在点名和读回不一致，最近的会话没记下工作流编号，没叫醒`);
      continue;
    }
    try {
      const got = await deps.release(row.workflowId);
      if (got === 'sent') {
        continued += 1;
        deps.log('info', '看门狗：点名和读回不一致的挂起已发继续，按点名重派', {
          workflowId: row.workflowId,
          taskId: row.taskId,
        });
      } else if (got === 'gone') {
        deps.log('info', '看门狗：点名和读回不一致的挂起，工作流已经没了', {
          workflowId: row.workflowId,
        });
      }
    } catch (err) {
      problems.push(`${ref} 点名和读回不一致，继续信号没发成：${errMessage(err)}`);
    }
  }
  return { scanned, continued, problems };
}
