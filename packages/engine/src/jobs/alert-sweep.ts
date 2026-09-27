// 提醒对账（每小时对账的一项，design 15.3）：提醒推一次就完、条件没了也不撤、第一次没人接住就再也不提醒——
// 两处都在这里补。
// 1. 能判断条件还在不在的，现算：条件没了就撤，写明谁撤的（engine:hourly-reconcile）、为什么（正文开头「已撤：…」，
//    操作记录里也有一条）。条件还在的原样留着。判法一种提醒一条（RULES），没列进来的不在这里判（见下面的清单）。
// 2. 卡住报警（alert 这一级）超过 24 小时没人处理：再推一次——新写一条「还没处理：<原标题>」（键 remind:<原提醒>:<北京日期>，
//    同一条一天最多一次），驾驶舱弹一条、飞书发一张新卡（原来那张卡只会原地改，沉在群里）。原来那条处理掉，再提醒跟着撤；
//    在再提醒上点「处理」，原来那条也跟着撤。日报还没有（AI 帅位写日报没做），在那之前只靠这一下。
//
// 各种提醒谁来撤（改这里之前先对一遍）：
// - 「工作树没收掉」（子任务报的 sub:<子任务>:worktree、Fusion 报的 req:<仓>#<号>:worktree）、worktree:<树>「要你拍」：
//   工作树那一部分撤（jobs/worktree-sweep.ts）。
// - <工作流>:park:<n> 挂起：工作流不在跑了、不挂着了、后来又挂起了一次（这条是旧的）就撤；「「<阶段>」没有能用的路由」
//   挂着时路由恢复了，正文开头写一句「路由已经恢复…点继续」（不撤：任务还挂着等人点继续）。
// - <工作流>:history 事件数到线：工作流结束了就撤。
// - req:<…>:failed 需求没做完：需求的状态不再是 failed（重开了、又跑了、做完了、人叫停了）就撤。
// - mq:<仓>:decide 合并队列判断出错：队列正常收工了（COMPLETED）或工作流已经不在了就撤；还在跑时判不了。
// - approval:<批准> 要人批：批了、拒了，或者在等它的工作流（子任务的；Fusion 的是需求工作流）不在跑了、不在等这一次了就撤。
// - routing:all-open:<阶段> 某阶段的路由全都熔断了：这个阶段有不在熔断的候选路由了就撤（只读判法，和选路同一套；
//   读不了记没查成，不撤）。
// - 自己会撤的，这里不管：pool-hold:<池>（探针、会话跑通就撤）、flow-config:<仓>（GitHub 对账）、deploy-lag:（后端健康检查）、
//   auto-release:（自动发布）、备份脚本的几种（fleet-backup）、canary:broken（全流程巡检下一轮通过）、
//   watchdog:job:<任务>:…、watchdog:unchecked:<日子>（看门狗 jobs/watchdog.ts：任务按期跑成了、读到登记表了就撤）、
//   watchdog-down:…（后端看着看门狗，packages/api 的 watchdog-health.ts：看门狗又按期跑完一轮就撤）。
// - 判不了、还没接的，只靠 24 小时再推：<工作流>:failure:<规则>（封号、换池接着干这类通报，条件就是「发生过」，要人知道）。
import type { AlertRow } from '@fleet-dao/db';
import type { StageKind, TaskState } from '@fleet-dao/shared';
import { duration, STAGE_NAMES } from '../routing/names.ts';
import type { AllOpenCheck } from '../routing/types.ts';
import {
  type AlertStore,
  beijingDate,
  clip,
  isStage,
  message,
  notRunningWords,
  RECONCILE_ACTOR,
  type ReconcileLog,
  type SweepPart,
  stamp,
  type WorkflowReader,
} from './reconcile-common.ts';
import { FUSION_TREE_ALERT, KEEP_ALERT_PREFIX, SUBTASK_TREE_ALERT } from './worktree-sweep.ts';

/** 再提醒的键：remind:<原提醒的编号>:<北京日期>。 */
export const REMIND_PREFIX = 'remind:';
/** 卡住报警多久没人处理就再推一次（同一条一天最多一次）。 */
export const REMIND_AFTER_MS = 24 * 60 * 60_000;
/**
 * 挂起报警是不是「现在挂着的这一次」：报警写进库（updated_at）在挂起那一刻（waiting.since）之后；早过它这么多的是
 * 之前那一次（人点继续以后又挂起了）。留一分钟余量：两个时刻一个是工作流的钟、一个是库的钟。
 */
export const PARK_MATCH_SLACK_MS = 60_000;
/** 「「<阶段>」没有能用的路由」挂着时，路由恢复了写在正文开头的那一句以它开头（再恢复、再没了按它认出来换掉）。 */
export const ROUTE_BACK_PREFIX = '路由已经恢复';

const NO_ROUTE_TITLE = /^「([a-z]+)」没有能用的路由$/;

/** 这个阶段现在派不派得出去（真实现是选路 pickRoute：和挂起时选的是同一套）。 */
export type RouteCheck =
  | { kind: 'dispatch' }
  | { kind: 'wait'; detail: string }
  | { kind: 'none'; detail: string };

export interface ApprovalFacts {
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
  /** 在等这次批准的工作流：子任务的（sub:<子任务>），Fusion 的是需求工作流（req:<仓>#<号>）；认不出是 null（不撤）。 */
  waitingWorkflowId: string | null;
}

export interface AlertSweepDeps {
  workflows: WorkflowReader;
  taskState(taskId: string): Promise<TaskState | null>;
  approval(approvalId: string): Promise<ApprovalFacts | null>;
  stageRoutable(stage: StageKind, taskId: string | null): Promise<RouteCheck>;
  /**
   * 这个阶段现在是不是全熔断（store-ports 的 stageAllOpen：不写库、不报警）。读不了照抛。
   * 真装配（real/hourly-reconcile.ts）一定接上；可选只是让只测别的部分的装配不用带它。没接上的当没查成记下、不撤。
   */
  stageAllOpen?(stage: StageKind): Promise<AllOpenCheck>;
  alerts: AlertStore;
  now: () => Date;
  log: ReconcileLog;
}

type Verdict =
  /** 条件还在，原样留着。 */
  | { keep: true }
  /** 条件没了：撤，why 写进正文开头和操作记录。 */
  | { resolve: string }
  /** 条件还在，正文改一句（路由恢复了）。 */
  | { body: string };

interface Rule {
  name: string;
  pattern: RegExp;
  judge(deps: AlertSweepDeps, alert: AlertRow, m: RegExpExecArray): Promise<Verdict>;
}

const TASK_STATE_WORDS: Readonly<Record<TaskState, string>> = {
  queued: '排队中',
  triaging: '分诊中',
  asking: '在等人回答',
  planning: '写方案中',
  running: '在干',
  merging: '在合并',
  done: '做完了',
  stopped: '人叫停了',
  failed: '没做完',
  stalled: '停滞',
};

/** 正文开头换上（或拿掉）「路由已经恢复」那一句；别的原样。 */
export function withRouteNote(body: string, note: string | null): string {
  let rest = body;
  if (body.startsWith(ROUTE_BACK_PREFIX)) {
    const cut = body.indexOf('\n\n');
    rest = cut === -1 ? '' : body.slice(cut + 2);
  }
  if (!note) return rest;
  return rest ? `${note}\n\n${rest}` : note;
}

export const RULES: readonly Rule[] = [
  {
    name: '挂起',
    pattern: /^((?:req|sub):.+):park:\d+$/,
    async judge(deps, alert, m) {
      const wf = m[1] as string;
      const st = await deps.workflows.state(wf);
      if (st.state !== 'running') return { resolve: `任务已经不挂着了：${notRunningWords(st)}` };
      const view = await deps.workflows.view(wf);
      if (!view.parked) {
        return { resolve: `任务已经不挂着了：挂起已经解除、接着干了（现在：${view.doing || '没写'}）` };
      }
      const since = view.waiting?.kind === 'human' ? Date.parse(view.waiting.since) : Number.NaN;
      if (Number.isFinite(since) && alert.updatedAt.getTime() < since - PARK_MATCH_SLACK_MS) {
        return { resolve: '这一次挂起已经过去了：人点继续以后又挂起了一次，看新报的那条' };
      }
      const stage = NO_ROUTE_TITLE.exec(alert.title)?.[1];
      if (!stage || !isStage(stage)) return { keep: true };
      const route = await deps.stageRoutable(stage, alert.taskId);
      const note =
        route.kind === 'none'
          ? null
          : `${ROUTE_BACK_PREFIX}（「${stage}」阶段现在有能用的路由了）：任务还挂着等人，在驾驶舱点「继续」就接着干。`;
      const body = withRouteNote(alert.body, note);
      return body === alert.body ? { keep: true } : { body };
    },
  },
  {
    name: '事件数到线',
    pattern: /^((?:req|sub|mq):.+):history$/,
    async judge(deps, _alert, m) {
      const st = await deps.workflows.state(m[1] as string);
      return st.state === 'running'
        ? { keep: true }
        : { resolve: `${notRunningWords(st)}，事件数不会再涨了` };
    },
  },
  {
    name: '需求没做完',
    pattern: /^req:.+:failed$/,
    async judge(deps, alert) {
      if (!alert.taskId) return { keep: true };
      const state = await deps.taskState(alert.taskId);
      if (state === null || state === 'failed') return { keep: true };
      return { resolve: `需求现在是「${TASK_STATE_WORDS[state]}」，不再是没做完` };
    },
  },
  {
    name: '合并队列判断出错',
    pattern: /^(mq:.+):decide$/,
    async judge(deps, _alert, m) {
      const st = await deps.workflows.state(m[1] as string);
      if (st.state === 'missing') return { resolve: `合并队列${notRunningWords(st)}` };
      if (st.state === 'closed' && st.status === 'COMPLETED') {
        return { resolve: '合并队列已经排空、正常收工了：判断出错的那一步后来过去了' };
      }
      return { keep: true };
    },
  },
  {
    name: '要人批',
    pattern: /^approval:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    async judge(deps, _alert, m) {
      const id = m[1] as string;
      const a = await deps.approval(id);
      if (!a) return { keep: true };
      if (a.decision) {
        return {
          resolve: `已经${a.decision === 'approved' ? '批准' : '拒绝'}了（${a.decidedBy ?? '没记是谁'}）`,
        };
      }
      const wf = a.waitingWorkflowId;
      if (!wf) return { keep: true };
      const st = await deps.workflows.state(wf);
      if (st.state !== 'running') return { resolve: `在等批准的${notRunningWords(st)}，不用再批了` };
      const view = await deps.workflows.view(wf);
      if (view.approval?.approvalId === id && view.approval.state === 'pending') return { keep: true };
      return {
        resolve: `任务已经不在等这次批准了（${view.approval ? '它在等的是另一次' : '现在没在等批准'}）`,
      };
    },
  },
  {
    name: '全熔断',
    pattern: /^routing:all-open:([a-z]+)$/,
    async judge(deps, _alert, m) {
      const stage = m[1] as string;
      if (!isStage(stage)) return { keep: true };
      if (!deps.stageAllOpen) throw new Error('全熔断判不了：没接上只读判法');
      const check = await deps.stageAllOpen(stage);
      if (check.allOpen) return { keep: true };
      return { resolve: `${STAGE_NAMES[stage]}有路由不熔断了：${check.detail}` };
    },
  },
];

/** 工作树那一部分撤的，这里不碰。 */
const handledByTrees = (key: string) =>
  SUBTASK_TREE_ALERT.test(key) || FUSION_TREE_ALERT.test(key) || key.startsWith(KEEP_ALERT_PREFIX);

interface Ctx {
  deps: AlertSweepDeps;
  part: SweepPart;
  /** 这一轮之后还开着的原提醒（按编号）。 */
  stillOpen: Map<string, AlertRow>;
}

async function resolve(c: Ctx, alert: AlertRow, why: string, by = RECONCILE_ACTOR): Promise<boolean> {
  const r = await c.deps.alerts.resolve({
    dedupeKey: alert.dedupeKey,
    by,
    why,
    ...(by === RECONCILE_ACTOR ? {} : { auditActor: RECONCILE_ACTOR }),
  });
  c.stillOpen.delete(alert.id);
  if (r !== 'ok') return false;
  c.part.found += 1;
  c.deps.log('info', '每小时对账：撤了一条提醒', { dedupeKey: alert.dedupeKey, why });
  return true;
}

function reminderBody(alert: AlertRow, now: Date): string {
  const updated =
    alert.updatedAt.getTime() - alert.createdAt.getTime() >= 60_000
      ? `（最近一次更新 ${stamp(alert.updatedAt)}）`
      : '';
  return [
    `这条卡住报警北京时间 ${stamp(alert.createdAt)} 就报了，到现在 ${duration(now.getTime() - alert.createdAt.getTime())} 没人处理${updated}。`,
    '每天最多再提醒一次；原来那条处理掉，这条跟着撤；在这条上点「处理」也算把原来那条处理了。',
    '',
    '原来那条的正文：',
    clip(alert.body, 2000) || '（没写）',
  ].join('\n');
}

/** 再推：卡住报警超过 24 小时没人处理，一天一条；人在再提醒上点了处理，原来那条跟着撤。 */
async function remind(c: Ctx, alert: AlertRow): Promise<void> {
  const { deps } = c;
  const now = deps.now();
  const last = await deps.alerts.latestByPrefix(`${REMIND_PREFIX}${alert.id}:`);
  if (
    last?.resolvedAt &&
    last.resolvedBy !== RECONCILE_ACTOR &&
    last.resolvedAt.getTime() >= alert.updatedAt.getTime()
  ) {
    await resolve(
      c,
      alert,
      `人在再提醒上点了处理（北京时间 ${stamp(last.resolvedAt)}），原来这条跟着撤`,
      last.resolvedBy ?? RECONCILE_ACTOR,
    );
    return;
  }
  const since = Math.max(alert.createdAt.getTime(), last?.createdAt.getTime() ?? 0);
  if (now.getTime() - since < REMIND_AFTER_MS) return;
  const { created } = await deps.alerts.insertOnce({
    dedupeKey: `${REMIND_PREFIX}${alert.id}:${beijingDate(now)}`,
    level: 'alert',
    taskId: alert.taskId,
    title: clip(`还没处理：${alert.title}`, 300),
    body: reminderBody(alert, now),
    link: alert.link,
  });
  if (created) {
    c.part.found += 1;
    deps.log('info', '每小时对账：卡住报警超过 24 小时没人处理，再推了一次', { dedupeKey: alert.dedupeKey });
  }
}

/**
 * 跑提醒这一部分。open 是这一轮列出的没处理的提醒（truncated = 没列全，照实记没查全）。
 * 某一条判不成（查不了 Temporal、库）进 unchecked，别的照判。
 */
export async function sweepAlerts(
  deps: AlertSweepDeps,
  open: readonly AlertRow[],
  truncated: boolean,
): Promise<SweepPart> {
  const c: Ctx = {
    deps,
    part: { scanned: open.length, found: 0, unchecked: [] },
    stillOpen: new Map(open.filter((a) => !a.dedupeKey.startsWith(REMIND_PREFIX)).map((a) => [a.id, a])),
  };
  if (truncated) c.part.unchecked.push(`没处理的提醒太多，这一轮只看了前 ${open.length} 条`);
  // 1. 条件没了的撤掉；还在的留着（路由恢复了的改一句正文）
  for (const alert of open) {
    if (alert.dedupeKey.startsWith(REMIND_PREFIX) || handledByTrees(alert.dedupeKey)) continue;
    for (const rule of RULES) {
      const m = rule.pattern.exec(alert.dedupeKey);
      if (!m) continue;
      try {
        const verdict = await rule.judge(deps, alert, m);
        if ('resolve' in verdict) await resolve(c, alert, verdict.resolve);
        else if ('body' in verdict) {
          if ((await deps.alerts.updateOpen({ dedupeKey: alert.dedupeKey, body: verdict.body })) === 'ok') {
            deps.log('info', '每小时对账：挂着的任务路由恢复了，提醒里写上一句', {
              dedupeKey: alert.dedupeKey,
            });
          }
        }
      } catch (err) {
        c.part.unchecked.push(`提醒 ${alert.dedupeKey}（${rule.name}）没查成：${message(err)}`);
      }
      break;
    }
  }
  // 2. 还开着的卡住报警（工作树的也算），超过 24 小时没人处理就再推
  for (const alert of [...c.stillOpen.values()]) {
    if (alert.level !== 'alert') continue;
    try {
      await remind(c, alert);
    } catch (err) {
      c.part.unchecked.push(`提醒 ${alert.dedupeKey} 的再提醒没做成：${message(err)}`);
    }
  }
  // 3. 原来那条已经处理了的再提醒，跟着撤
  for (const alert of open) {
    if (!alert.dedupeKey.startsWith(REMIND_PREFIX)) continue;
    const origin = alert.dedupeKey.slice(REMIND_PREFIX.length).split(':')[0] ?? '';
    if (c.stillOpen.has(origin)) continue;
    try {
      await resolve(c, alert, '原来那条已经处理了');
    } catch (err) {
      c.part.unchecked.push(`再提醒 ${alert.dedupeKey} 没撤成：${message(err)}`);
    }
  }
  return c.part;
}
