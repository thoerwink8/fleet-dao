// 看门狗盯法国指挥官（#3295）：停下超过 30 分钟，或 PR 合并超过 30 分钟仍有 open 验收责任，
// 且还没有 commander.claim 的任务，报 watchdog:commander:<taskId>。指挥官一认领，这张卡自动撤；
// 这里仍只负责发现「指挥官自己断了」，不执行验收或停下任务动作。

import type { CommanderAcceptanceTask, CommanderStalledTask } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { WatchdogAlerts } from './watchdog.ts';

export const COMMANDER_ALERT_PREFIX = 'watchdog:commander:';
export const COMMANDER_AFTER_MINUTES = 30;
export const COMMANDER_LINK = '/tasks';

export type CommanderWatchTask =
  | CommanderStalledTask
  | (CommanderAcceptanceTask & {
      kind: 'acceptance';
      commanderSeen: boolean;
      stalledAt: Date;
      retry: null;
    });

export interface CommanderWatchDeps {
  tasks(now: Date): Promise<CommanderWatchTask[]>;
  alerts: Pick<WatchdogAlerts, 'openByPrefix' | 'byKey' | 'raise' | 'resolve'>;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface CommanderWatchResult {
  scanned: number;
  found: number;
  problems: string[];
}

const refOf = (task: CommanderWatchTask) => `${task.owner}/${task.name}#${task.issueNumber}`;
const isAcceptance = (
  task: CommanderWatchTask,
): task is Extract<CommanderWatchTask, { kind: 'acceptance' }> =>
  'kind' in task && task.kind === 'acceptance';
const keyOf = (task: CommanderWatchTask) =>
  `${COMMANDER_ALERT_PREFIX}${task.taskId}${isAcceptance(task) ? `:acceptance:${task.prNumber}` : ''}`;

function raiseOnce(
  alerts: CommanderWatchDeps['alerts'],
  input: { dedupeKey: string; title: string; body: string },
): Promise<void> {
  return alerts.raise({ ...input, link: COMMANDER_LINK, level: 'alert' });
}

/** park-triage 报的两张全局卡（jobs/park-triage.ts）：开着就是指挥官整体没在看的原因。 */
export const COMMANDER_CAP_KEY = 'commander:daily-cap';
export const COMMANDER_NO_MODEL_KEY = 'commander:no-model';

/**
 * 这张单没人看的原因，按能查到的先后写：全局上限卡开着 → 用途没配模型卡开着 → 这一次停下有「会话没起成」的记录
 * （选不到路由、主线头没读到、会话报错……原文照写）→ 都不是就写「没查出原因」，不编。
 */
function whyUnseen(task: CommanderWatchTask, open: ReadonlySet<string>): string {
  if (open.has(COMMANDER_CAP_KEY))
    return `原因：指挥官 24 小时内的认领到了熔断上限（见提醒 ${COMMANDER_CAP_KEY}，里面有等着的单和下一个名额什么时候空出来），名额空出来之前不再看新的停下。`;
  if (open.has(COMMANDER_NO_MODEL_KEY))
    return `原因：路由用途「指挥官」没配模型（见提醒 ${COMMANDER_NO_MODEL_KEY}），指挥官会话起不来。`;
  if (isAcceptance(task))
    return `原因：PR #${task.prNumber} 已合并超过 30 分钟，但这张单仍有验收责任 open，指挥官还没有记验收认领。`;
  if (task.retry)
    return `原因：指挥官会话没起成${task.retry.attempt === null ? '' : `（第 ${task.retry.attempt} 次）`}：${task.retry.why}；这一次停下不算处理过，下一轮再看，同一次停下最多试 3 次，第 3 次还没起成按默认动作执行。`;
  return '原因：没查出原因（没有上限、没配模型、没有「会话没起成」的记录）；查 park-triage 定时任务这几轮的结果和日志，看指挥官开关（设置 engine.commander）是不是关着。';
}

function watchBody(task: CommanderWatchTask, open: ReadonlySet<string>): { title: string; body: string } {
  const ref = refOf(task);
  return {
    title: `停下的任务没人看：${ref}`,
    body: [
      isAcceptance(task)
        ? `任务 ${ref} 的 PR #${task.prNumber} 已合并超过 30 分钟，法国指挥官还没看验收责任。`
        : `任务 ${ref} 已停下（停下于 ${task.stalledAt.toISOString()}），超过 30 分钟，法国指挥官还没看过。`,
      whyUnseen(task, open),
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
  let tasks: CommanderWatchTask[];
  try {
    tasks = await deps.tasks(now);
    out.scanned = tasks.length;
  } catch (err) {
    out.problems.push(`读停下任务和指挥官认领记录没成：${errMessage(err)}`);
    return out;
  }

  const due = tasks.filter(
    (task) =>
      !task.commanderSeen && now.getTime() - task.stalledAt.getTime() >= COMMANDER_AFTER_MINUTES * 60_000,
  );
  // 全局原因（上限、没配模型）只读一次；读不到记进 problems，正文照常发（原因落到下一条能查到的）
  const globalOpen = new Set<string>();
  if (due.length > 0) {
    for (const key of [COMMANDER_CAP_KEY, COMMANDER_NO_MODEL_KEY]) {
      try {
        const card = await deps.alerts.byKey(key);
        if (card && card.resolvedAt === null) globalOpen.add(key);
      } catch (err) {
        out.problems.push(`读提醒 ${key} 没成，没人看的原因可能写得不全：${errMessage(err)}`);
      }
    }
  }
  const wanted = new Map(
    due.map((task) => {
      const text = watchBody(task, globalOpen);
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
