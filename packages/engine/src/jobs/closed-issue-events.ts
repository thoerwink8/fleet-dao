// 单一关，停着等人或已在检查点软暂停且没有开着会话的任务马上撤（#2103 / #3002）：后端门口放进来的 GitHub
// issues.closed 落在投递账（github_events）上，引擎每几秒捞一次还没处理的，按那一张单走和每小时对账**同一个**
// 函数（closed-issue-tasks.ts 的 abandonClosedIssueTasks）：停着等人（parked）、或 phase=paused 且 waiting.kind=paused
// 且没有开着会话的，发「放弃」、撤挂起提醒；还在跑的不碰；单状态照样回 GitHub 现读，事件只当「叫醒」，不信里面的字。
// 改这里之前必须知道：
// - 处理完把结果写进这条投递的 note，下一眼就不再捞到；同一投递编号重投在后端门口已经去重。没记上、引擎重启后再捞到，
//   那条任务已经放弃了、不再停在可放弃的检查点，不会再发第二次信号。已经记过「放弃了 0 条」的旧投递不再捞，
//   还停在检查点的由每小时对账用同一个判定收尾。
// - 列不出在跑的任务工作流（Temporal 连不上）不记，下一眼再来；只捞最近 CLOSED_ISSUE_EVENT_WINDOW_MS 之内收的，
//   更早的、这里没撤成的由每小时对账兜住。
import type { ClosedIssueDelivery } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import { abandonClosedIssueTasks, type ClosedIssueTaskDeps } from './closed-issue-tasks.ts';

/** 每几秒看一眼投递账。 */
export const CLOSED_ISSUE_EVENT_POLL_MS = 5_000;
/** 只捞这么久之内收的：引擎停了一阵，起来不翻老账，老的由每小时对账兜。 */
export const CLOSED_ISSUE_EVENT_WINDOW_MS = 60 * 60_000;
/** 按单关了的事件撤任务时记的「谁」（放弃信号的 by、撤提醒的操作记录）。 */
export const CLOSED_ISSUE_EVENT_BY = 'engine:issue-closed';

export interface ClosedIssueEventDeps {
  /** since 之后收进来、还没处理的 issues.closed 投递，先收的在前。读不到照抛。 */
  pending(since: Date): Promise<ClosedIssueDelivery[]>;
  /** 把做了什么记进这条投递；已经记过的回 false。写不进照抛。 */
  markHandled(deliveryId: string, note: string): Promise<boolean>;
  /** 和每小时对账同一份装配（问 Temporal 在跑的任务、停没停着，现读单状态，发放弃、撤提醒）。 */
  tasks(): ClosedIssueTaskDeps;
  now(): Date;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

const ClosedIssuePayload = z.object({
  issue: z.object({ number: z.number().int().positive() }),
  repository: z.object({ full_name: z.string() }),
});

/** 事件里的仓和单号；认不出回 null。 */
function issueOf(
  d: ClosedIssueDelivery,
): { repo: { owner: string; name: string }; issueNumber: number } | null {
  const p = ClosedIssuePayload.safeParse(d.payload);
  if (!p.success) return null;
  const [owner, name, ...rest] = p.data.repository.full_name.split('/');
  if (!owner || !name || rest.length > 0) return null;
  return { repo: { owner, name }, issueNumber: p.data.issue.number };
}

/** 看一眼：每条没处理的 issues.closed 撤一次那张单停着等人的任务。回这一眼处理了几条投递。 */
export async function runClosedIssueEvents(deps: ClosedIssueEventDeps): Promise<number> {
  const now = deps.now();
  const rows = await deps.pending(new Date(now.getTime() - CLOSED_ISSUE_EVENT_WINDOW_MS));
  let handled = 0;
  for (const row of rows) {
    const issue = issueOf(row);
    let note: string;
    if (!issue) {
      deps.log('warn', '单关了的事件：认不出是哪张单，不撤', { deliveryId: row.deliveryId });
      note = '单关了：认不出是哪张单，没撤任务';
    } else {
      const slug = `${issue.repo.owner}/${issue.repo.name}#${issue.issueNumber}`;
      const part = await abandonClosedIssueTasks(deps.tasks(), {
        only: issue,
        by: CLOSED_ISSUE_EVENT_BY,
        label: '单关了的事件',
      });
      if (part.failed) {
        deps.log('warn', '单关了的事件：这一眼没撤成，下一眼再来', {
          deliveryId: row.deliveryId,
          issue: slug,
          error: part.failed,
        });
        continue;
      }
      if (part.unchecked.length > 0) {
        deps.log('warn', '单关了的事件：有没查成的，留给每小时对账', {
          deliveryId: row.deliveryId,
          issue: slug,
          unchecked: part.unchecked,
        });
      }
      note = `单关了：放弃了 ${part.found} 条停着等人的任务${
        part.unchecked.length > 0 ? `；没查成 ${part.unchecked.length} 条：${part.unchecked.join('；')}` : ''
      }`;
    }
    try {
      if (await deps.markHandled(row.deliveryId, note)) handled += 1;
    } catch (err) {
      deps.log('error', '单关了的事件：处理完了，结果没记进投递账', {
        deliveryId: row.deliveryId,
        error: errMessage(err),
      });
    }
  }
  return handled;
}

export interface ClosedIssueEventPoller {
  stop(): void;
}

/** 每 everyMs 看一眼（上一眼还没完就跳过这一眼）。出错只记日志，下一眼照看。 */
export function startClosedIssueEvents(
  deps: () => ClosedIssueEventDeps,
  options: { everyMs?: number } = {},
): ClosedIssueEventPoller {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    const d = deps();
    running = runClosedIssueEvents(d)
      .then(() => undefined)
      .catch((err: unknown) => d.log('error', '单关了的事件：这一眼没看成', { error: errMessage(err) }))
      .finally(() => {
        running = null;
      });
  };
  const handle = setInterval(tick, options.everyMs ?? CLOSED_ISSUE_EVENT_POLL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
