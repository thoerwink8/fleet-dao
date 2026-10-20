// 看门狗盯法国指挥官（#3295）：停下超过 30 分钟、这一停还没有 commander.claim 的任务，
// 报 watchdog:commander:<taskId>。指挥官一认领，这张看门狗卡自动撤；停下的任务仍由
// park-triage 负责看和处理，这里只负责发现「指挥官自己断了」。

import type { CommanderStalledTask } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { WatchdogAlerts } from './watchdog.ts';

export const COMMANDER_ALERT_PREFIX = 'watchdog:commander:';
export const COMMANDER_AFTER_MINUTES = 30;
export const COMMANDER_LINK = '/tasks';

export interface CommanderWatchDeps {
  tasks(now: Date): Promise<CommanderStalledTask[]>;
  alerts: Pick<WatchdogAlerts, 'openByPrefix' | 'byKey' | 'raise' | 'resolve'>;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface CommanderWatchResult {
  scanned: number;
  found: number;
  problems: string[];
}

const refOf = (task: CommanderStalledTask) => `${task.owner}/${task.name}#${task.issueNumber}`;
const keyOf = (task: CommanderStalledTask) => `${COMMANDER_ALERT_PREFIX}${task.taskId}`;

function raiseOnce(
  alerts: CommanderWatchDeps['alerts'],
  input: { dedupeKey: string; title: string; body: string },
): Promise<void> {
  return alerts.raise({ ...input, link: COMMANDER_LINK, level: 'alert' });
}

function watchBody(task: CommanderStalledTask): { title: string; body: string } {
  const ref = refOf(task);
  return {
    title: `停下的任务没人看：${ref}`,
    body: [
      `任务 ${ref} 已停下（停下于 ${task.stalledAt.toISOString()}），超过 30 分钟，法国指挥官还没看过。`,
      '看驾驶舱任务页和指挥官会话；指挥官认领这一次停下后，这张提醒自动撤。',
    ].join('\n'),
  };
}

/**
 * 只报已经超过阈值且没有认领的停点。标题正文不包含会随每轮变化的时长，
 * 因此同一张卡不会每 5 分钟被原地改写。
 */
export async function watchCommander(deps: CommanderWatchDeps, now: Date): Promise<CommanderWatchResult> {
  const out: CommanderWatchResult = { scanned: 0, found: 0, problems: [] };
  let tasks: CommanderStalledTask[];
  try {
    tasks = await deps.tasks(now);
    out.scanned = tasks.length;
  } catch (err) {
    out.problems.push(`读停下任务和指挥官认领记录没成：${errMessage(err)}`);
    return out;
  }

  const wanted = new Map(
    tasks
      .filter(
        (task) =>
          !task.commanderSeen && now.getTime() - task.stalledAt.getTime() >= COMMANDER_AFTER_MINUTES * 60_000,
      )
      .map((task) => {
        const text = watchBody(task);
        return [keyOf(task), { ...text, task }] as const;
      }),
  );
  out.found = wanted.size;

  for (const [dedupeKey, item] of wanted) {
    try {
      const existing = await deps.alerts.byKey(dedupeKey);
      if (existing?.resolvedAt === null && existing.title === item.title && existing.body === item.body)
        continue;
      if (existing?.resolvedAt && existing.resolvedBy !== 'engine:watchdog') continue;
      await raiseOnce(deps.alerts, { dedupeKey, title: item.title, body: item.body });
      deps.log('warn', '看门狗：指挥官没看停下的任务', { dedupeKey, taskId: item.task.taskId });
    } catch (err) {
      out.problems.push(`提醒 ${dedupeKey} 没报成：${errMessage(err)}`);
    }
  }

  let open: { dedupeKey: string; title: string; body: string }[];
  try {
    open = await deps.alerts.openByPrefix(COMMANDER_ALERT_PREFIX);
  } catch (err) {
    out.problems.push(`列指挥官看门狗提醒没成：${errMessage(err)}`);
    return out;
  }
  const byTask = new Map(tasks.map((task) => [keyOf(task), task]));
  for (const alert of open) {
    if (wanted.has(alert.dedupeKey)) continue;
    const task = byTask.get(alert.dedupeKey);
    const why =
      task?.commanderSeen === true
        ? `法国指挥官已经看过 ${refOf(task)} 这一次停下`
        : task
          ? `${refOf(task)} 已不再停着，或这一次停下还没超过 30 分钟`
          : '任务已经不再是当前停下的任务';
    try {
      await deps.alerts.resolve({ dedupeKey: alert.dedupeKey, why });
    } catch (err) {
      out.problems.push(`提醒 ${alert.dedupeKey} 没撤掉：${errMessage(err)}`);
    }
  }
  return out;
}
