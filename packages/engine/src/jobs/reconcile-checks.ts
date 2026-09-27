// 每小时对账的两处核对（design 第六节第 4 层，specs/293-对账三处核对）：开着的单都有着落、合了的 PR 都记了账。
// 第三处（额度读数不超过 30 分钟）等 #76 定时读额度上线后随它做：额度现在没有定时读进库，查它新不新鲜只会天天报过期。
// 各返回一个 SweepPart，由 hourly-reconcile 的 combineParts 并进这一轮。提醒自己报、自己撤，不进 alert-sweep 的判法表。
// 补拉只对排队中的单：照对账补漏重放同一份实现（接活那道门）再判一次派不派；在做的单工作流断了不自动重起（会和残留的
// 会话、分支撞，接活也不会再拉起在做的单），直接报要人看。记账对不上只报、不补：补账要从会话记录重算，不在这里猜。
import {
  type ActiveTaskRef,
  type IssueDeliveryRef,
  type MergedPrLedger,
  type ReconcileRepoRef,
  TERMINAL_TASK_STATES,
} from '@fleet-dao/db';
import type { TaskState } from '@fleet-dao/shared';
import { requirementWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { AlertSweepDeps } from './alert-sweep.ts';
import {
  clip,
  message,
  notRunningWords,
  RECONCILE_ACTOR,
  type SweepPart,
  type WorkflowState,
} from './reconcile-common.ts';

/** 和提醒对账里的状态说法同一套（jobs/alert-sweep.ts 的 TASK_STATE_WORDS）。 */
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

/** 开着的单没有着落（工作流不在跑、也没记为什么不派，补拉也没成）。后面是任务编号。 */
export const WORKFLOW_ALERT_PREFIX = 'reconcile:workflow:';
/** 合了的 PR 对上的单记账不全。后面是 <owner>/<name>#<PR 号>。 */
export const LEDGER_ALERT_PREFIX = 'reconcile:ledger:';
/**
 * 工作流刚收尾、库里的状态还没写上的那一下：单在这之内更新过，不查、也不撤旧的。
 * 再短会把正常收尾报出来，再长会把真断了的单多瞒一阵。
 */
export const WORKFLOW_QUIET_MS = 10 * 60_000;
/** PR 合了以后关单那一步（写关单评论、收会话、记做完）要走一会儿：合并这么久之内的不查记账。 */
export const LEDGER_GRACE_MS = 30 * 60_000;
/** 每小时一轮，往回看 26 小时：漏一轮也补得回最近一天里合的。 */
export const MERGED_PR_LOOKBACK_MS = 26 * 60 * 60_000;
/** 和 hourly-reconcile 的 OPEN_ALERT_LIMIT 同一个上限：多出来的照实记没看全，不当成没有。 */
const ALERT_LIST_LIMIT = 500;

/**
 * 接活在投递上记的「为什么不派」（`workflow=<原因>`，packages/api/src/issue-intake.ts；判法在 @fleet-dao/core 的
 * dispatch.ts）里算数的几种：排队中的单记着其中一种，没派是有意的。开关关着（dispatch_off）不在这里：项目开关开着
 * 还记着它是旧的，要重判；读不出版本、读不出建单时刻的是没判成，也要重判。
 */
export const HELD_REASONS: Readonly<Record<string, string>> = {
  opened_before_switch: '开关打开以前开的单，要人明说交给 fleet',
  unscheduled: '未排期',
  not_current_version: '不是当前版本',
  mother_ticket: '母单',
  sub_issue: '子单',
};

export function prAlertKey(owner: string, name: string, number: number): string {
  return `reconcile:pr:${owner}/${name}#${number}`;
}

export function ledgerAlertKey(owner: string, name: string, number: number): string {
  return `${LEDGER_ALERT_PREFIX}${owner}/${name}#${number}`;
}

/** 合并 PR 对账的结果，和 @fleet-dao/github 的 AuditReport 同形（这里不引那个包）。 */
export interface MergedPrAudit {
  outcome: 'ok' | 'partial' | 'unscanned';
  scanned: number;
  found: number;
  fixed: number;
  problems: string[];
  why?: string | undefined;
}

/** 补拉（重放这张 issue 最近一次的 issues 投递）的结果。 */
export type RepullResult =
  /** 库里没有这张 issue 的 issues 投递，没东西可重放。 */
  | { kind: 'no_delivery' }
  /** 那条投递正在处理：这一轮不动。 */
  | { kind: 'busy' }
  /** 接活处理完了，note 是它记的（`workflow=started` 之类）。 */
  | { kind: 'processed'; note: string }
  /** 接活说现在做不了、记成等着（上一轮还没结束、项目停派）：对账补漏每轮重放它。 */
  | { kind: 'waiting'; why: string }
  /** 门没收、或已经处理完不肯再来。 */
  | { kind: 'not_taken'; why: string };

type IssueRef = { owner: string; name: string; issueNumber: number };

export interface ReconcileCheckDeps
  extends Pick<AlertSweepDeps, 'workflows' | 'taskState' | 'alerts' | 'now' | 'log'> {
  activeTasks(): Promise<ActiveTaskRef[]>;
  /** 这张 issue 最近一次的 issues 投递（@fleet-dao/db 的 latestIssueDelivery）。 */
  latestDelivery(ref: IssueRef): Promise<Pick<IssueDeliveryRef, 'status' | 'reason' | 'note'> | null>;
  /** 照对账补漏重放同一份实现，把这张 issue 最近一次的投递重放一次（带 force）。 */
  repull(ref: IssueRef): Promise<RepullResult>;
  repos(): Promise<ReconcileRepoRef[]>;
  auditMergedPrs(repoFullName: string, since: Date): Promise<MergedPrAudit>;
  ledgers(input: {
    since: Date;
    prs: { owner: string; name: string; number: number }[];
  }): Promise<MergedPrLedger[]>;
}

const empty = (): SweepPart => ({ scanned: 0, found: 0, unchecked: [] });

const terminal = new Set<string>(TERMINAL_TASK_STATES);

function recentlyTouched(updatedAt: Date | null, now: Date): boolean {
  return updatedAt !== null && now.getTime() - updatedAt.getTime() < WORKFLOW_QUIET_MS;
}

function workflowKey(taskId: string): string {
  return `${WORKFLOW_ALERT_PREFIX}${taskId}`;
}

/** 接活记的 `workflow=<结果>`；没有是 null。 */
export function intakeResult(note: string | null): string | null {
  return note ? (/(?:^|,\s*)workflow=([a-z_]+)/.exec(note)?.[1] ?? null) : null;
}

/** 投递上记着的「为什么不派」：算数的原因（见 HELD_REASONS）、或记成等着的原因；都不是是 null。 */
export function heldWhy(d: Pick<IssueDeliveryRef, 'status' | 'reason' | 'note'> | null): string | null {
  if (!d) return null;
  if (d.status === 'waiting') return `投递记成等着：${d.reason ?? '没写原因'}`;
  if (d.status !== 'accepted') return null;
  const r = intakeResult(d.note);
  return r && Object.hasOwn(HELD_REASONS, r) ? `投递上记着不派：${HELD_REASONS[r]}` : null;
}

type Verdict =
  | { kind: 'ok'; why: string; fixed: boolean }
  | { kind: 'hold' }
  | { kind: 'stuck'; why: string };

/** 排队中的单工作流不在跑、投递上也没记为什么不派：补拉一次，看结果。 */
async function repullQueued(deps: ReconcileCheckDeps, task: ActiveTaskRef, where: string): Promise<Verdict> {
  let r: RepullResult;
  try {
    r = await deps.repull(task);
  } catch (err) {
    return { kind: 'stuck', why: `补拉了一次没成：${message(err)}` };
  }
  switch (r.kind) {
    case 'busy':
      return { kind: 'hold' };
    case 'no_delivery':
      return { kind: 'stuck', why: '库里没有这张 issue 的投递，补拉不了（接活从没收到过它？）' };
    case 'not_taken':
      return { kind: 'stuck', why: `补拉时接活没收：${r.why}` };
    case 'waiting':
      return { kind: 'ok', why: `补拉了一次，接活记成等着（${r.why}），对账补漏每轮再来`, fixed: true };
    case 'processed': {
      const got = intakeResult(r.note);
      if (got && Object.hasOwn(HELD_REASONS, got)) {
        return { kind: 'ok', why: `补拉了一次，接活判不派：${HELD_REASONS[got]}`, fixed: true };
      }
      const wf = requirementWorkflowId({ owner: task.owner, name: task.name }, task.issueNumber);
      let st: WorkflowState;
      try {
        st = await deps.workflows.state(wf);
      } catch (err) {
        deps.log('warn', '每小时对账：补拉之后问工作流没问成', { issue: where, error: message(err) });
        return { kind: 'hold' };
      }
      if (st.state === 'running') return { kind: 'ok', why: '补拉了一次，工作流起来了', fixed: true };
      return {
        kind: 'stuck',
        why: `补拉了一次还是没起来：接活记的是「${r.note || '什么都没记'}」，${notRunningWords(st)}`,
      };
    }
  }
}

/**
 * 「让 AI 接活」开着的项目里没结束的单：工作流在跑，或（排队中的）投递上记着为什么不派，就有着落；都没有的排队单补拉一次，
 * 补拉也没成、或在做的单工作流断了，报卡住。条件没了（有着落了、单结束了、项目接活关了、库里没了）撤。
 */
export async function checkWorkflows(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let tasks: ActiveTaskRef[];
  try {
    tasks = await deps.activeTasks();
  } catch (err) {
    return { ...part, failed: `列没结束的单没成：${message(err)}` };
  }
  const now = deps.now();
  /** 这一轮查成了且有着落：值是撤的时候写的原因。 */
  const clear = new Map<string, string>();
  /** 报了、没查成、或还在 10 分钟的窗口里：旧提醒留着。 */
  const hold = new Set<string>();

  for (const task of tasks) {
    if (!task.autoDispatch) {
      clear.set(task.taskId, '这个项目「让 AI 接活」关着，不要求有工作流');
      continue;
    }
    part.scanned += 1;
    const where = `${task.owner}/${task.name}#${task.issueNumber}`;
    const wf = requirementWorkflowId({ owner: task.owner, name: task.name }, task.issueNumber);
    let st: WorkflowState;
    try {
      st = await deps.workflows.state(wf);
    } catch (err) {
      hold.add(task.taskId);
      part.unchecked.push(`${where} 的工作流没问成：${message(err)}`);
      continue;
    }
    if (st.state === 'running') {
      clear.set(task.taskId, '需求工作流在跑');
      continue;
    }
    if (recentlyTouched(task.updatedAt, now)) {
      hold.add(task.taskId);
      continue;
    }
    let verdict: Verdict;
    if (task.state === 'queued') {
      let delivery: Awaited<ReturnType<ReconcileCheckDeps['latestDelivery']>>;
      try {
        delivery = await deps.latestDelivery(task);
      } catch (err) {
        hold.add(task.taskId);
        part.unchecked.push(`${where} 的投递没读成：${message(err)}`);
        continue;
      }
      const held = heldWhy(delivery);
      verdict = held ? { kind: 'ok', why: held, fixed: false } : await repullQueued(deps, task, where);
    } else {
      verdict = {
        kind: 'stuck',
        why: `${notRunningWords(st)}。接活不会再拉起在做的单，也不自动重起（会和残留的会话、分支撞），要人看`,
      };
    }
    if (verdict.kind === 'hold') {
      hold.add(task.taskId);
      continue;
    }
    if (verdict.kind === 'ok') {
      clear.set(task.taskId, verdict.why);
      if (verdict.fixed) {
        part.found += 1;
        deps.log('info', '每小时对账：排队的单补拉了一次', {
          taskId: task.taskId,
          issue: where,
          why: verdict.why,
        });
      }
      continue;
    }
    hold.add(task.taskId);
    const dedupeKey = workflowKey(task.taskId);
    try {
      await deps.alerts.raise({
        dedupeKey,
        level: 'alert',
        taskId: task.taskId,
        title: clip(`开着的单没有着落：${where}`, 300),
        body: `库里这张单是「${TASK_STATE_WORDS[task.state]}」，需求工作流不在跑。${verdict.why}。`,
        link: `https://github.com/${task.owner}/${task.name}/issues/${task.issueNumber}`,
      });
      part.found += 1;
      deps.log('info', '每小时对账：开着的单没有着落', {
        taskId: task.taskId,
        issue: where,
        why: verdict.why,
      });
    } catch (err) {
      part.unchecked.push(`${where} 没有着落，报提醒没报成：${message(err)}`);
    }
  }

  let open: { dedupeKey: string }[];
  try {
    const listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
    open = listed.alerts;
    if (listed.truncated) {
      part.unchecked.push(`没处理的提醒太多，工作流核对这一轮只看了前 ${open.length} 条，没看到的不撤`);
    }
  } catch (err) {
    part.unchecked.push(`列没处理的提醒没成，工作流核对的旧提醒这一轮不撤：${message(err)}`);
    return part;
  }

  const active = new Set(tasks.map((t) => t.taskId));
  for (const alert of open) {
    if (!alert.dedupeKey.startsWith(WORKFLOW_ALERT_PREFIX)) continue;
    const taskId = alert.dedupeKey.slice(WORKFLOW_ALERT_PREFIX.length);
    if (hold.has(taskId)) continue;
    let why = clear.get(taskId);
    if (!why) {
      if (active.has(taskId)) continue;
      try {
        const state = await deps.taskState(taskId);
        if (state !== null && !terminal.has(state)) {
          part.unchecked.push(`提醒 ${alert.dedupeKey} 对上的单还没结束，这一轮的清单里却没有，不撤`);
          continue;
        }
        why = state === null ? '库里没有这张单了' : `这张单已经结束了（${TASK_STATE_WORDS[state]}）`;
      } catch (err) {
        part.unchecked.push(`提醒 ${alert.dedupeKey} 对上的单读不了，不撤：${message(err)}`);
        continue;
      }
    }
    await resolveOne(deps, part, alert.dedupeKey, why);
  }
  return part;
}

async function resolveOne(deps: ReconcileCheckDeps, part: SweepPart, dedupeKey: string, why: string) {
  try {
    const r = await deps.alerts.resolve({ dedupeKey, by: RECONCILE_ACTOR, why });
    if (r === 'ok') {
      part.found += 1;
      deps.log('info', '每小时对账：撤了一条提醒', { dedupeKey, why });
    }
  } catch (err) {
    part.unchecked.push(`提醒 ${dedupeKey} 没撤成：${message(err)}`);
  }
}

interface Classified {
  fixed: string[];
  failed: string[];
  /** 认不出的句子：不当成没事，写进 unchecked。 */
  odd: string[];
  alerts: Map<number, string[]>;
}

function classifyProblems(problems: readonly string[]): Classified {
  const fixed: string[] = [];
  const failed: string[] = [];
  const odd: string[] = [];
  const alerts = new Map<number, string[]>();
  for (const p of problems) {
    if (p.includes('没查成')) {
      failed.push(p);
      continue;
    }
    if (p.includes('（已补）')) {
      fixed.push(p);
      continue;
    }
    const n = /^#(\d+)\s/.exec(p)?.[1];
    if (!n) {
      odd.push(p);
      continue;
    }
    const number = Number(n);
    const list = alerts.get(number) ?? [];
    list.push(p);
    alerts.set(number, list);
  }
  return { fixed, failed, odd, alerts };
}

/** 每个受管的仓，最近 26 小时合了的 PR：镜像补上算发现；机器人开的合并人、合并记录不对按 PR 报一条，不自动撤。 */
export async function checkMergedPrs(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let repos: ReconcileRepoRef[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { ...part, failed: `列受管的仓没成：${message(err)}` };
  }
  const since = new Date(deps.now().getTime() - MERGED_PR_LOOKBACK_MS);
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    let report: MergedPrAudit;
    try {
      report = await deps.auditMergedPrs(slug, since);
    } catch (err) {
      part.unchecked.push(`${slug} 审合并的 PR 没做成：${message(err)}`);
      continue;
    }
    part.scanned += report.scanned;
    part.found += report.found;
    const { fixed, failed, odd, alerts } = classifyProblems(report.problems);
    if (fixed.length > 0) {
      deps.log('info', '每小时对账：合并的 PR 镜像补记成已合并', {
        repo: slug,
        fixed: report.fixed,
        problems: fixed.slice(0, 5),
      });
    }
    if (report.outcome === 'unscanned') {
      part.unchecked.push(`${slug}：${report.why ?? '合并的 PR 这次没查成'}`);
    } else if (report.outcome === 'partial' || failed.length > 0) {
      const detail = failed.length > 0 ? failed.join('；') : (report.why ?? '有的没查成');
      part.unchecked.push(`${slug} 合并的 PR 没查全：${detail}`);
    }
    if (odd.length > 0) part.unchecked.push(`${slug} 有认不出的对账结果：${odd.join('；')}`);
    for (const [number, lines] of alerts) {
      const dedupeKey = prAlertKey(repo.owner, repo.name, number);
      try {
        await deps.alerts.insertOnce({
          dedupeKey,
          level: 'alert',
          taskId: null,
          title: clip(`合并的 PR 合并人或合并记录对不上：${slug}#${number}`, 300),
          body: lines.join('\n'),
          link: `https://github.com/${slug}/pull/${number}`,
        });
        deps.log('info', '每小时对账：合并的 PR 合并人或合并记录对不上', { dedupeKey });
      } catch (err) {
        part.unchecked.push(`${dedupeKey} 没报成：${message(err)}`);
      }
    }
  }
  return part;
}

/** 一条合了的 PR 对上的单缺什么；都齐是空的。 */
export function ledgerGaps(l: MergedPrLedger): string[] {
  const gaps: string[] = [];
  const open = l.sessions.filter((s) => s.endedAt === null || s.outcome === null);
  if (open.length > 0) {
    gaps.push(`${open.length} 次会话没有结局（${[...new Set(open.map((s) => s.stage))].join('、')}）`);
  }
  // 读不到的用量留空（不记 0），关单评论照写「没读到」；真跑过的会话 token 记成 0 就是拿 0 冒充读到了
  const zero = l.sessions.filter(
    (s) => s.endedAt !== null && s.startedAt !== null && s.inputTokens === 0 && s.outputTokens === 0,
  );
  if (zero.length > 0) {
    gaps.push(`${zero.length} 次跑过的会话用量记成了 0（读不到要留空、写明没读到，不记 0）`);
  }
  if (l.taskState !== 'done') {
    gaps.push(`合并关单那一步没写完：库里这张单是「${TASK_STATE_WORDS[l.taskState]}」，不是「做完了」`);
  }
  return gaps;
}

function parseLedgerKey(key: string): { owner: string; name: string; number: number } | null {
  const m = /^([^/]+)\/(.+)#(\d+)$/.exec(key.slice(LEDGER_ALERT_PREFIX.length));
  return m?.[1] && m[2] && m[3] ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}

/**
 * 合了的 PR 对上的单（引擎开的：PR 头分支上有这张单的会话）：会话都有结局、用量不拿 0 冒充、关单那一步写完（单记成做完）。
 * 缺的按 PR 报一条，写明哪张单缺什么；不自动补。都齐了（还开着的提醒复查，出了回看窗口也查）就撤。
 */
export async function checkLedgers(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  const now = deps.now();
  let open: { dedupeKey: string }[] | null = null;
  try {
    const listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
    open = listed.alerts.filter((a) => a.dedupeKey.startsWith(LEDGER_ALERT_PREFIX));
    if (listed.truncated) {
      part.unchecked.push(
        `没处理的提醒太多，记账核对这一轮只看了前 ${listed.alerts.length} 条，没看到的不撤`,
      );
    }
  } catch (err) {
    part.unchecked.push(`列没处理的提醒没成，记账核对的旧提醒这一轮不复查、不撤：${message(err)}`);
  }
  const named = (open ?? []).flatMap((a) => {
    const pr = parseLedgerKey(a.dedupeKey);
    return pr ? [pr] : [];
  });
  let ledgers: MergedPrLedger[];
  try {
    ledgers = await deps.ledgers({ since: new Date(now.getTime() - MERGED_PR_LOOKBACK_MS), prs: named });
  } catch (err) {
    return { ...part, failed: `读合了的 PR 和会话记账没成：${message(err)}` };
  }

  const byPr = new Map<string, MergedPrLedger[]>();
  for (const l of ledgers) {
    const key = ledgerAlertKey(l.owner, l.name, l.prNumber);
    byPr.set(key, [...(byPr.get(key) ?? []), l]);
  }
  const hold = new Set<string>();
  const clear = new Set<string>();
  for (const [dedupeKey, list] of byPr) {
    const first = list[0];
    if (!first) continue;
    part.scanned += 1;
    if (now.getTime() - first.prUpdatedAt.getTime() < LEDGER_GRACE_MS) {
      hold.add(dedupeKey);
      continue;
    }
    const slug = `${first.owner}/${first.name}`;
    const lines = list.flatMap((l) => ledgerGaps(l).map((g) => `- 单 #${l.issueNumber}：${g}`));
    if (lines.length === 0) {
      clear.add(dedupeKey);
      continue;
    }
    hold.add(dedupeKey);
    try {
      await deps.alerts.raise({
        dedupeKey,
        level: 'alert',
        taskId: list.length === 1 ? first.taskId : null,
        title: clip(`合了的 PR 记账不全：${slug}#${first.prNumber}`, 300),
        body: [
          `PR 合进去了，对上的单记账不全（不自动补：补账要从会话记录重算）：`,
          ...lines,
          '都补齐了这条自己撤。',
        ].join('\n'),
        link: `https://github.com/${slug}/pull/${first.prNumber}`,
      });
      part.found += 1;
      deps.log('info', '每小时对账：合了的 PR 记账不全', { dedupeKey, gaps: lines });
    } catch (err) {
      part.unchecked.push(`${dedupeKey} 记账不全，报提醒没报成：${message(err)}`);
    }
  }

  for (const alert of open ?? []) {
    if (hold.has(alert.dedupeKey)) continue;
    if (clear.has(alert.dedupeKey)) {
      await resolveOne(deps, part, alert.dedupeKey, '会话结局、用量、关单都记齐了');
    } else if (!byPr.has(alert.dedupeKey)) {
      if (!parseLedgerKey(alert.dedupeKey)) {
        part.unchecked.push(`提醒 ${alert.dedupeKey} 认不出是哪条 PR，不撤`);
        continue;
      }
      await resolveOne(deps, part, alert.dedupeKey, '镜像里这条 PR 不再是已合并、或对不上单了');
    }
  }
  return part;
}
