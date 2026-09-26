// 起会话前看仓的流程配置副本（docs/decisions/0003-fusion-flow.md 第 9 条；副本由对账从仓里 .fleet/flow.json 同步，
// jobs/flow-config.ts）：认不出、从没同步过、太久没同步成就停派；写码阶段项目没写测试命令明确失败，不拿空串、旧值顶。
// 判法在 @fleet-dao/core 的 replica.ts，这里只把库里读到的换成它要的样子，不能派就换成 PortError。
import { sessionTestCommand } from '@fleet-dao/core';
import type { TaskContext } from '@fleet-dao/db';
import type { StageKind } from '@fleet-dao/shared';
import { PortError } from '../ports.ts';

/**
 * 这次会话交代的测试命令：写码阶段一定有，别的阶段项目没写就是 null。不能派就抛 CONFIG_MISSING（不可重试）：
 * 失败分流 HM1 挂起、报警，原因写明是哪个仓、为什么；人把仓里的配置改好（或等对账恢复）后点「继续」。
 * 要在登记会话那一行之前调：不能派的不在库里留一行没起也没结束的会话。
 */
export function sessionTestCommandOrStop(task: TaskContext, stage: StageKind, now: Date): string | null {
  const { flow } = task.repo;
  const got = sessionTestCommand(
    {
      syncedAt: flow.syncedAt ? flow.syncedAt.toISOString() : null,
      error: flow.error,
      unread: flow.unread,
      testCommand: flow.testCommand,
    },
    stage,
    now,
  );
  if (!got.ok) {
    throw new PortError('CONFIG_MISSING', `${task.repo.owner}/${task.repo.name} 停派：${got.why}`, {
      retryable: false,
    });
  }
  return got.command;
}
