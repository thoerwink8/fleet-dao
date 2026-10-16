// 看门狗的「今天的每日简报送到了」（简报 jobs/daily-brief.ts，每天 08:30 推飞书 + 在 #1055 发评论）。判法是 @fleet-dao/db 的
// dailyBriefProblem（fleet-api attention 用的也是它，指挥官巡检只读 attention 的结论）：09:00 以后，今天一轮都没起、没做成（#1055 评论没发成也算）、
// 那一行提醒没建、没推到飞书，报一条卡住报警进驾驶舱（键 watchdog:brief:<北京日期>）；好了自己撤。
// 改这里之前必须知道：
// - 一天一条：同一天里人点了「处理」不再打开；过了一天，昨天那条还开着就撤（「看今天的」），不让旧的堆着。
// - 读不到事实：这一轮这一步记没查成（看门狗这一轮记没跑成），开着的不撤，不当成送到了。
// - 推送渠道整个坏了还有 watchdog:push:feishu（要你拍）；法国整个挂了由香港探活（每分钟探法国 healthz）报，香港由本机巡检看；简报没到只有这一处判（GitHub Actions 的 daily-brief-guard 已删，#2369）。
import { beijingDay, type DailyBriefStatus, dailyBriefProblem } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { clip } from './reconcile-common.ts';
import type { WatchdogAlerts } from './watchdog.ts';

/** 看门狗自己撤的处理人（和 watchdog.ts 的 WATCHDOG_ACTOR 同一个；不从那边引，免得互相引用）。 */
const ACTOR = 'engine:watchdog';

export const BRIEF_ALERT_PREFIX = 'watchdog:brief:';
export const briefAlertKey = (day: string): string => `${BRIEF_ALERT_PREFIX}${day}`;
/** 点进去看驾驶舱「定时任务」页（每日简报那一行的最近一轮写着原因）。 */
export const BRIEF_ALERT_LINK = '/schedules';

export interface BriefWatchDeps {
  /** 这一天的简报事实（@fleet-dao/db 的 dailyBriefStatus）。读不到照抛。 */
  status(day: string, since: Date): Promise<DailyBriefStatus>;
  /** 这台要不要看：只有法国（有发布目录）发简报给创始人，开发机、本机环境不看。读不到照抛。 */
  here(): Promise<boolean>;
  alerts: Pick<WatchdogAlerts, 'openByPrefix' | 'byKey' | 'raise' | 'resolve'>;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface BriefWatchResult {
  scanned: number;
  found: number;
  problems: string[];
}

export function briefAlert(problem: string): { title: string; body: string } {
  return {
    title: '今天的每日简报没送到',
    body: clip(
      [
        `${problem}。`,
        '每日简报每天 08:30 由引擎定时任务 daily-brief 推进飞书团队群、并在置顶进度单 #1055 发一条评论；没送到，创始人今天就看不到昨天上线了什么、要他拍什么。',
        '先看驾驶舱「定时任务」页 daily-brief 最近一轮的原因；飞书那头不通看 `fleet-api feishu-push status`；修好后 `fleet-api daily-brief` 手动补发一条。',
      ].join('\n'),
      2000,
    ),
  };
}

export async function watchDailyBrief(deps: BriefWatchDeps, now: Date): Promise<BriefWatchResult> {
  const out: BriefWatchResult = { scanned: 0, found: 0, problems: [] };
  const { day, start } = beijingDay(now);
  const key = briefAlertKey(day);
  let problem: string | null;
  try {
    if (!(await deps.here())) return out;
    problem = dailyBriefProblem(await deps.status(day, start), now);
    out.scanned = 1;
  } catch (err) {
    out.problems.push(`读每日简报送没送到没成，这一轮没查：${errMessage(err)}`);
    return out;
  }
  let open: { dedupeKey: string; title: string; body: string }[];
  try {
    open = await deps.alerts.openByPrefix(BRIEF_ALERT_PREFIX);
  } catch (err) {
    out.problems.push(`列「每日简报没送到」开着的提醒没成：${errMessage(err)}`);
    return out;
  }
  for (const a of open) {
    if (a.dedupeKey === key && problem !== null) continue;
    try {
      await deps.alerts.resolve({
        dedupeKey: a.dedupeKey,
        why: a.dedupeKey === key ? '今天的每日简报送到了' : '过了一天，看今天的简报',
      });
    } catch (err) {
      out.problems.push(`「每日简报没送到」${a.dedupeKey} 没撤掉：${errMessage(err)}`);
    }
  }
  if (problem === null) return out;
  out.found = 1;
  const want = briefAlert(problem);
  const existing = open.find((a) => a.dedupeKey === key);
  if (existing && existing.title === want.title && existing.body === want.body) return out;
  if (!existing) {
    // 今天这条人点了「处理」：不再打开（人接手了）；看门狗自己撤的照样打开
    try {
      const row = await deps.alerts.byKey(key);
      if (row && row.resolvedAt !== null && row.resolvedBy !== ACTOR) return out;
    } catch (err) {
      out.problems.push(`读「每日简报没送到」那一条没成：${errMessage(err)}`);
      return out;
    }
  }
  try {
    await deps.alerts.raise({ dedupeKey: key, ...want, link: BRIEF_ALERT_LINK, level: 'alert' });
    deps.log('warn', '看门狗：今天的每日简报没送到', { problem });
  } catch (err) {
    out.problems.push(`今天的每日简报没送到，报警没报成：${errMessage(err)}`);
  }
  return out;
}
