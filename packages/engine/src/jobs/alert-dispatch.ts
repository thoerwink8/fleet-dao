// 提醒派单（design 15.3「谁在处理」；创始人 2026-09-27 夜「提醒标上谁在处理……更类似于一个派单状态」）：每 5 分钟看一遍
// 开着的提醒，按 @fleet-dao/core 的 alertHandling 现算谁在处理、修到哪，再按 escalationFor 判要不要再推：
// - 没人在处理（没人认领、引擎自己拿着卡住了、要创始人拍的还没拍）超过 alerts.claimAfterMinutes：推一条「没人认领：…」
//   （要拍的推「还没拍：…」），一段一条；没挂单的卡住报警同一轮开一张跟进单（贴「缺陷」「本机做」，挂当前版本），挂到这条提醒上，
//   之后谁在处理就是那张单上的认领（#299）。
// - 有人在处理、停在一个阶段超过 alerts.stuckAfterMinutes：推一条「停着没动（阶段）：…」，一个阶段一条。
// - 再推出来的那几条：原来那条撤了、静默了、有人接手了、往前走了就撤，写明为什么。
// 改这里之前必须知道：
// - 读不到（设置认不出、列不了提醒、读不到认领和 PR）：这一轮记没跑成，不开单、不再推（不把「没查成」当「没人认领」）。
// - 同一段里人点了「处理」的再推不再打开（人接手了）；提醒派单自己撤的，同一段里又不对了照样打开（静默到期这类）。
// - 标题正文不带「多久了」这类每轮都变的话（core 只写绝对时刻），没变就不改卡（飞书免费版每月 1 万次接口调用）。
// - 跟进单一条提醒最多开一张（开单的幂等键 alert:<提醒编号>，账丢了按正文里的隐藏标记回查）；挂单只在还没挂时写，不覆盖人挂的。
// - 每小时对账的 24 小时再推（alert-sweep.ts）不管这里再推出来的那几条，也不给有人在处理、静默了的再推。
import {
  type AlertHandling,
  type AlertSettings,
  type AlertSettingsRead,
  type AlertWorkFacts,
  alertHandling,
  alertIssueKey,
  currentVersion,
  type DeployFacts,
  type Escalation,
  escalationFor,
  FOLLOW_UP_LABELS,
  followUpIssueText,
  followUpRepo,
  isEscalationKey,
  type ManagedRepoRef,
  parseEscalationKey,
  REMIND_KEY_PREFIX,
  retireEscalationWhy,
} from '@fleet-dao/core';
import type { AlertRow, ScheduleResult } from '@fleet-dao/db';
import type { AlertDispatchRun } from '../contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { clip, message } from './reconcile-common.ts';

/** 登记进 scheduled_jobs 的那一行（看门狗照它看这个任务新不新鲜）。 */
export const ALERT_DISPATCH_JOB = {
  id: 'alert-dispatch',
  name: '提醒派单（没人认领、停着没动再推，没挂单的开跟进单）',
  schedule: '每 5 分钟',
  // 漏两轮不报，连着三轮没跑成才算过期
  expectEveryMinutes: 15,
} as const;

export const ALERT_DISPATCH_EVERY_MINUTES = 5;
/** 和看门狗（4、9、14……分）、对账补漏（整点起每 15 分钟）、路由探针（7、22、37、52 分）、每小时对账（41 分）错开：3、8、13……分。 */
export const ALERT_DISPATCH_OFFSET_MINUTES = 3;
/** 撤再推、挂跟进单、记操作记录时的「谁」；也用它认出哪些是自己撤的（同一段里又不对了照样打开）。 */
export const ALERT_DISPATCH_ACTOR = 'engine:alert-dispatch';
/** 一轮最多看多少条开着的提醒（多出来的照实记没看全）。 */
export const ALERT_DISPATCH_LIMIT = 500;
/** why 最长多少字。 */
export const ALERT_DISPATCH_WHY_MAX = 1500;

export interface AlertDispatchDeps {
  /** 设置里提醒那三项（core 的 readAlertSettings 判过的）。读不到照抛。 */
  settings(): Promise<AlertSettingsRead>;
  /** 开着的提醒，老的在前（@fleet-dao/db 的 listOpenAlerts）。读不到照抛。 */
  listOpen(limit: number): Promise<{ alerts: AlertRow[]; truncated: boolean }>;
  /** 一批提醒（编号，最多 500）现算要的事实（@fleet-dao/api 的 AlertWorkPort.read，按库的 now）。读不到照抛。 */
  read(ids: readonly string[]): Promise<{ now: string; facts: AlertWorkFacts[] }>;
  /** 法国的发布记录；这台机器上没有是 null。 */
  deploy(): Promise<DeployFacts | null>;
  alerts: {
    /** 这个键的那一条（处理没处理都给）。 */
    byKey(dedupeKey: string): Promise<AlertRow | null>;
    /** 报：没有就建、开着的原地改、处理过的重新打开（upsertAlert）。 */
    raise(input: {
      dedupeKey: string;
      level: 'alert' | 'decision';
      taskId: string | null;
      title: string;
      body: string;
      link?: string | undefined;
    }): Promise<void>;
    /** 撤：处理人记 ALERT_DISPATCH_ACTOR，正文开头写「已撤：why」，进操作记录（resolveAlertWithReason）。 */
    resolve(input: { dedupeKey: string; why: string }): Promise<'ok' | 'already_resolved' | 'not_found'>;
  };
  issues: {
    /** 驾驶舱导入过的项目（repos 表）。 */
    repos(): Promise<ManagedRepoRef[]>;
    /** 巡检仓（引擎配置 FLEET_CANARY_REPO，owner/仓名）：跟进单不开在那儿；没配是 null。 */
    canaryRepo: string | null;
    /** 仓里此刻还开着的里程碑（「引擎」机器人现读）。读不到抛，不拿「一个都没有」顶。 */
    openMilestones(repo: { owner: string; name: string }): Promise<{ number: number; title: string }[]>;
    /** 开一张单（@fleet-dao/github 的 openIssue）：同一个 key 只开一张。 */
    open(input: {
      repo: { owner: string; name: string };
      key: string;
      title: string;
      body: string;
      labels: string[];
      milestone: number | null;
    }): Promise<{ number: number; url: string; created: boolean }>;
    /** 挂到提醒上（@fleet-dao/db 的 linkAlertWork，if_absent：已经挂了别的不动）。 */
    link(input: {
      notificationId: string;
      repoId: string;
      issueNumber: number;
      note: string;
    }): Promise<'linked' | 'same' | 'kept' | 'not_found'>;
  };
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮没跑成：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class AlertDispatchFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'AlertDispatchFailedError';
    this.runId = runId;
  }
}

interface Round {
  deps: AlertDispatchDeps;
  settings: AlertSettings;
  deploy: DeployFacts | null;
  now: string;
  /** 写没写进去的（推、撤、开单），一条一句：这一轮记没跑成，下一轮照库里的样子重来。 */
  problems: string[];
  /** 没看全的（太多了、刚列出来又读不到了、认不出的键）：记只查了一部分。 */
  notes: string[];
}

/** 做一件事；没做成的记进 problems，回 null，不抛。 */
async function attempt<T>(r: Round, what: string, fn: () => Promise<T>): Promise<{ value: T } | null> {
  try {
    return { value: await fn() };
  } catch (err) {
    r.problems.push(`${what}：${message(err)}`);
    return null;
  }
}

/** 按编号读事实（一次最多 500 条）。 */
async function readFacts(deps: AlertDispatchDeps, ids: readonly string[]) {
  const facts = new Map<string, AlertWorkFacts>();
  let now: string | null = null;
  for (let i = 0; i < ids.length; i += 500) {
    const got = await deps.read(ids.slice(i, i + 500));
    now = got.now;
    for (const f of got.facts) facts.set(f.alert.id, f);
  }
  return { facts, now };
}

/**
 * 报一条再推：同一段里人处理过的不再打开（回 handled）；开着的、标题正文都没变的不动（回 same，不改卡）；
 * 别的（没有、开着要改、自己撤过的）报出去。
 */
async function raiseOnce(
  deps: AlertDispatchDeps,
  alert: { taskId: string | null; link: string | null },
  e: Extract<Escalation, { key: string }>,
  body: string,
): Promise<'raised' | 'same' | 'handled'> {
  const existing = await deps.alerts.byKey(e.key);
  if (existing?.resolvedAt && existing.resolvedBy !== ALERT_DISPATCH_ACTOR) return 'handled';
  if (existing && !existing.resolvedAt && existing.title === e.title && existing.body === body) return 'same';
  await deps.alerts.raise({
    dedupeKey: e.key,
    level: e.level,
    taskId: alert.taskId,
    title: e.title,
    body,
    link: alert.link ?? undefined,
  });
  return 'raised';
}

/**
 * 给没挂单的卡住报警开跟进单、挂上，回挂好以后重读的事实。开在哪（core 的 followUpRepo）、挂哪个版本（当前版本，
 * 仓里没有就未排期）；挑不出仓、读不到里程碑、开单没成、挂不上一律抛，写明为什么。
 */
async function openFollowUp(r: Round, f: AlertWorkFacts): Promise<AlertWorkFacts> {
  const { deps } = r;
  const where = followUpRepo(await deps.issues.repos(), r.settings.issueRepo, deps.issues.canaryRepo);
  if (!where.ok) throw new Error(where.why);
  const repo = { owner: where.repo.owner, name: where.repo.name };
  const slug = `${repo.owner}/${repo.name}`;
  const version = currentVersion(await deps.issues.openMilestones(repo));
  const text = followUpIssueText(f, r.settings, version?.milestone.title ?? null);
  const opened = await deps.issues.open({
    repo,
    key: alertIssueKey(f.alert.id),
    title: text.title,
    body: text.body,
    labels: [...FOLLOW_UP_LABELS],
    milestone: version?.milestone.number ?? null,
  });
  const linked = await deps.issues.link({
    notificationId: f.alert.id,
    repoId: where.repo.id,
    issueNumber: opened.number,
    note: `提醒派单开的跟进单 ${slug}#${opened.number}`,
  });
  if (linked === 'not_found') throw new Error(`单开了（${slug}#${opened.number}），可提醒不在了：没处挂`);
  deps.log('info', '提醒派单：开了跟进单', {
    dedupeKey: f.alert.dedupeKey,
    issue: `${slug}#${opened.number}`,
    created: opened.created,
    linked,
  });
  // 挂好（或者别人刚挂了别的：kept）以后照库里的样子重读，谁在处理从挂着的那张算
  const again = (await deps.read([f.alert.id])).facts[0];
  if (!again) throw new Error(`跟进单挂上了（${slug}#${opened.number}），再读这条提醒却没了`);
  return again;
}

/** 一条原来的提醒：要再推就推，没挂单的先开跟进单。回这一轮要不要推（found 计数）。 */
async function dispatchOne(r: Round, first: AlertWorkFacts, handling: Map<string, AlertHandling>) {
  let f = first;
  let h = alertHandling(f, r.deploy, r.now);
  let e = escalationOf(r, f, h);
  if (e.kind === 'none') {
    handling.set(f.alert.id, h);
    return false;
  }
  let issueNote: string | null = null;
  if (e.openIssue) {
    try {
      f = await openFollowUp(r, f);
      h = alertHandling(f, r.deploy, r.now);
      e = escalationOf(r, f, h);
    } catch (err) {
      const why = message(err);
      r.problems.push(`提醒 ${f.alert.dedupeKey} 的跟进单没开成：${why}`);
      issueNote = `跟进单没开成：${clip(why, 300)}。下一轮（5 分钟后）再试，按提醒编号幂等、开不出两张。`;
    }
  }
  handling.set(f.alert.id, h);
  if (e.kind === 'none') return false;
  const body = issueNote ? `${e.body}\n${issueNote}` : e.body;
  const got = await attempt(r, `再推 ${e.key} 没写进去`, () => raiseOnce(r.deps, f.alert, e, body));
  if (got?.value === 'raised') r.deps.log('warn', '提醒派单：推了一条', { dedupeKey: e.key, title: e.title });
  return true;
}

const escalationOf = (r: Round, f: AlertWorkFacts, h: AlertHandling): Escalation =>
  escalationFor(f, h, r.settings, r.now);

async function round(deps: AlertDispatchDeps): Promise<ScheduleResult> {
  const read = await deps.settings();
  if (!read.ok)
    return {
      outcome: 'failed',
      why: clip(`设置认不出，这一轮不推不开单：${read.why}`, ALERT_DISPATCH_WHY_MAX),
    };
  const { alerts: open, truncated } = await deps.listOpen(ALERT_DISPATCH_LIMIT);
  const notes: string[] = [];
  if (truncated) notes.push(`开着的提醒太多，这一轮只看了前 ${open.length} 条`);

  // 再推出来的（unclaimed:、stuck:）和原来的分开；每小时对账的 24 小时再推（remind:）归它自己管，日报不推
  const escalations = open.filter(
    (a) => isEscalationKey(a.dedupeKey) && !a.dedupeKey.startsWith(REMIND_KEY_PREFIX),
  );
  const originals = open.filter((a) => !isEscalationKey(a.dedupeKey) && a.level !== 'daily');
  const parsed = escalations.map((a) => ({ alert: a, key: parseEscalationKey(a.dedupeKey) }));
  const ids = [
    ...new Set([...originals.map((a) => a.id), ...parsed.flatMap((p) => (p.key ? [p.key.alertId] : []))]),
  ];
  const { facts, now: dbNow } = await readFacts(deps, ids);
  let deploy: DeployFacts | null;
  try {
    deploy = await deps.deploy();
  } catch (err) {
    deploy = { ok: false, why: `发布记录读不了：${message(err)}` };
  }
  const r: Round = {
    deps,
    settings: read.settings,
    deploy,
    now: dbNow ?? deps.now().toISOString(),
    problems: [],
    notes,
  };

  // 1. 原来的提醒：要再推的推，没挂单的开跟进单
  const handling = new Map<string, AlertHandling>();
  let found = 0;
  for (const a of originals) {
    const f = facts.get(a.id);
    if (!f) {
      notes.push(`提醒 ${a.dedupeKey} 刚列出来、再读就没了`);
      continue;
    }
    try {
      if (await dispatchOne(r, f, handling)) found += 1;
    } catch (err) {
      r.problems.push(`提醒 ${a.dedupeKey} 没判成：${message(err)}`);
    }
  }
  // 原来那条已经撤了的（不在开着的里面）：也要算一遍，下面撤再推按它
  for (const f of facts.values()) {
    if (!handling.has(f.alert.id)) handling.set(f.alert.id, alertHandling(f, r.deploy, r.now));
  }

  // 2. 再推出来的：不用再推了就撤
  for (const { alert, key } of parsed) {
    if (!key) {
      notes.push(`再推的提醒 ${alert.dedupeKey} 的键认不出，不碰它`);
      continue;
    }
    const why = retireEscalationWhy(key, handling.get(key.alertId) ?? null);
    if (!why) continue;
    const done = await attempt(r, `再推 ${alert.dedupeKey} 没撤掉`, () =>
      deps.alerts.resolve({ dedupeKey: alert.dedupeKey, why }),
    );
    if (done) deps.log('info', '提醒派单：撤了一条再推', { dedupeKey: alert.dedupeKey, why });
  }

  const scanned = open.length + 1;
  if (r.problems.length > 0) {
    const why = `${r.problems.length > 1 ? `${r.problems.length} 处没做成：` : ''}${r.problems.join('；')}`;
    return { outcome: 'failed', why: clip(why, ALERT_DISPATCH_WHY_MAX), scanned, found };
  }
  if (notes.length > 0) {
    return { outcome: 'partial', why: clip(notes.join('；'), ALERT_DISPATCH_WHY_MAX), scanned, found };
  }
  return { outcome: 'ok', scanned, found };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，看门狗看得见。
 * 没跑成（读不到、推撤开单没写进去）：记成 failed 再抛 AlertDispatchFailedError。记结局失败：原样抛出。
 */
export async function runAlertDispatchJob(deps: AlertDispatchDeps): Promise<AlertDispatchRun> {
  const runId = await deps.runs.start(ALERT_DISPATCH_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = {
      outcome: 'failed',
      why: clip(`提醒派单没跑成（这一轮不开单、不再推）：${message(err)}`, ALERT_DISPATCH_WHY_MAX),
    };
  }
  await deps.runs.finish(runId, result, deps.now());
  const run: AlertDispatchRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, why: run.why };
  if (run.outcome === 'failed') {
    deps.log('error', '提醒派单这一轮没跑成', fields);
    throw new AlertDispatchFailedError(runId, run.why ?? '提醒派单没跑成');
  }
  deps.log(run.outcome === 'ok' ? 'info' : 'warn', '提醒派单看完一轮', fields);
  return run;
}
