// 会话用户切号的真装配（#157、#59、#194，design 第九节「拼车用完，切独享接着干」）。
// 三个入口，同一个判法（jobs/org-decision.ts）、同一份事实（real/org-plan.ts）、同一把单飞锁（real/org-ledger.ts）：
// - now：被拒当场（拼车会话、探针交来被拒的证据）和定时读接口那一轮（real/carpool-watch.ts），不等路由探针，切完当场探一次；
// - before / after：路由探针每一轮探之前判、探完核对，当兜底（和以前一样）。
// 判之前先拿账本（落库：恢复条件、切回记录、最近几次接口读数）、现读会话用户挂的组织、现读一次接口（最近 30 秒内读过的不重读）；
// 逐个账号看状态，可用 ≥ 2 才切（创始人 2026-10-04 约 22:30 的要求）；判完先把新账本存下，再动手。
// 该切：先让选路停下（读组织回 pending，选路过 30 秒再选），等一会儿（选路刚派出去、还没登记的会话要有时间登记）；接了停会话的两样
// （#59）就把手上跑在 Claude 池上的会话停下，等它们都收场：三段的一次性会话（oneShots）交回 org_switch，任务工作流切完在原分支上重跑
// 这一段；Fusion 的会话（sessions）交回 org_switch，切完续同一个会话、换了池 fork 续上。哪一种没接，那一种在跑就停不下：手上有就不切、
// 等它们跑完（#157 的做法），切之前也再数一遍。切回拼车有宽限（方案 4.5）：新活先不往独享派，开跑不到 5 分钟的当场停，其余给 10 分钟。
// 然后经 root 帮手的 org-use 切过去（adapters 的 switchSessionOrg：帮手以会话用户读 org list 认出那一类、切、回读核对，没切成、核对不了都
// 切回原来的），切完记操作记录和账本。切完当场探切过去的那个池，探通了才算切成（after / verifyAfter）。
// 没切成、切完探针读回不在线、卡住（白切三次、切回预算用完、读不到几点恢复）、渠道不可用、账号只剩 1 个而且不是挂着的那个：写一条
// session-org:* 的「要人看」提醒（驾驶舱和飞书看得到，驾驶舱后端的健康检查 session_org 跟着红），条件没了自己撤。出什么错都不抛。
// 读数变了、引擎没切过号（real/session-org.ts 的起点变动）由 orgDriftReporter 写 session-org:drift 提醒和操作记录（#335）。

import type { SessionUser, SwitchSessionOrgResult } from '@fleet-dao/adapters';
import {
  type Db,
  openOrgRuns,
  recordEngineAudit,
  resolveAlertWithReason,
  SESSION_ORG_ALERT_PREFIX,
  upsertAlert,
} from '@fleet-dao/db';
import type { OrgKind } from '@fleet-dao/shared';
import { errMessage, sleep as realSleep } from '@fleet-dao/shared/util';
import { type CarpoolApiRead, type CarpoolOutage, classifyCarpoolRejection } from '../jobs/carpool-outage.ts';
import { readNotes } from '../jobs/carpool-read-notes.ts';
import { readBackoff } from '../jobs/carpool-watch.ts';
import { type OrgDecision, type OrgPlan, stamp } from '../jobs/org-decision.ts';
import { ledgerAfterSwitch, type OrgLedger, OrgLedgerError, withRead } from '../jobs/org-ledger.ts';
import type { OrgSwitchRound, OrgSwitchTrigger, ProbedRoute } from '../jobs/org-switch.ts';
import { ORG_NAMES } from '../routing/names.ts';
import { type LedgerStore, ledgerStore } from './org-ledger.ts';
import { decideFrom, loadOrgSwitchFacts, soloPauseOf } from './org-plan.ts';
import { type HeldPools, loadHeldPools } from './pool-holds.ts';
import {
  type OrgSighting,
  readingStamp,
  SESSION_ORG_SETTLE_MS,
  type SessionOrgControl,
  type SessionOrgEvent,
} from './session-org.ts';

/**
 * 切号那一刻在跑的会话（#59），一种会话一份（Fusion 的会话端口、三段的一次性会话登记）。只管这个工人进程里起的：一次性会话不脱开
 * 引擎跑，Fusion 的会话工人重启时收掉或接回，库里还开着、手上没有的都不是在跑的进程。
 * stop：把跑在这些账号池上的停下（发信号、不等），交回这一次叫停的编号（已经在停的不重复叫停）。only 给了就只停它认的那些
 * （切回宽限开始时只停开跑不到 5 分钟的）。
 * live：跑在这些账号池上、还没收场的编号，切号要等它们都收场。
 */
export interface OrgSwitchSessions {
  stop(poolIds: ReadonlySet<string>, why: string, only?: (runId: string) => boolean): string[];
  live(poolIds: ReadonlySet<string>): string[];
}

/** 切号没成（帮手没切过去）。下一次切成了、或者不用切了（人切好了、额度变了）撤。 */
export const ORG_SWITCH_ALERT = `${SESSION_ORG_ALERT_PREFIX}switch`;
/** 切过去了，这一轮探针读回切过去的那个池不在线。之后哪一轮挂着的那个池探通了撤。 */
export const ORG_VERIFY_ALERT = `${SESSION_ORG_ALERT_PREFIX}verify`;
/** 切号卡住要人看：拼车用满读不到几点恢复、连着白切、切回预算用完。 */
export const ORG_STUCK_ALERT = `${SESSION_ORG_ALERT_PREFIX}stuck`;
/**
 * 会话用户挂的组织读数变了、引擎没切过号（#335，real/session-org.ts 的起点）：带前后两次读数。读数回到原来的、或者连着
 * SESSION_ORG_SETTLE_MS 都是新的（认它了）、或者引擎切了号，撤。
 */
export const ORG_DRIFT_ALERT = `${SESSION_ORG_ALERT_PREFIX}drift`;
/** 渠道状态不对（#194，创始人 2026-10-04 约 22:30）：可用账号 0 个（渠道不可用）、只剩 1 个且不是挂着的、读不到账号状态超过 15 分钟。 */
export const ORG_CHANNEL_ALERT = `${SESSION_ORG_ALERT_PREFIX}channel`;
/** 过了预计恢复时刻很久还挂在独享上（方案 4.4）。 */
export const ORG_OVERDUE_ALERT = `${SESSION_ORG_ALERT_PREFIX}overdue`;
/** 额度留量线（设置 engine.quotaReserve）库里没有、认不出：引擎对这类池不派、不切，要人看（#194 4.8）。 */
export const ORG_RESERVE_ALERT = `${SESSION_ORG_ALERT_PREFIX}reserve`;
/** 整池暂停的开关（设置 engine.poolHolds）读不出、认不出：对应的池按暂停办，要人看（#746，real/pool-holds.ts）。 */
export const ORG_POOL_HOLD_ALERT = `${SESSION_ORG_ALERT_PREFIX}pool-hold`;
/** 整池暂停过了复查日期还开着：不自动撤，提醒人撤或续期（#746）。 */
export const ORG_POOL_HOLD_OVERDUE_ALERT = `${SESSION_ORG_ALERT_PREFIX}pool-hold-overdue`;
/** 切号账本认不出：引擎不切号，要人看（jobs/org-ledger.ts）。 */
export const ORG_LEDGER_ALERT = `${SESSION_ORG_ALERT_PREFIX}ledger`;
/**
 * 让选路停下以后等多久、再数一遍没结束的会话才切：选路派出去到起会话那一步登记（session_runs）之间隔着一次活动调度和几次查库，
 * 平时一两秒。切号一次（一个 5 小时窗口最多两次）Claude 停派这么久，换不让刚派的会话被切号掐断。
 */
export const ORG_SWITCH_GRACE_MS = 15_000;
/**
 * 停下手上的会话以后最多等多久它们都收场（#59）：插头收进程几秒，看守每 5 秒看一次、收场后写库。等不齐这一轮就不切：
 * 停下的照样接着干（还在原来的组织上）。
 */
export const ORG_DRAIN_TIMEOUT_MS = 120_000;
export const ORG_DRAIN_POLL_MS = 2_000;
/**
 * 登记了、进程还没起来的会话（还在建树、准备）要等它起来再停；排队这么久还没起来的，是没了下文的（工作流没了），不等它。
 */
export const ORG_STARTING_MAX_MS = 10 * 60_000;
/** 当场判之前，最近这么久里读过接口就不重读（一批会话同时被拒不会砸出一排请求）。 */
export const ORG_READ_REUSE_MS = 30_000;
/** 判成要切之后的那次现读：最近这么久（几秒）里刚读过就不重读（定时盯读刚读完交过来的不用再砸一次）。方案 4.1「切号前现读一次不用缓存」。 */
export const ORG_PRESWITCH_REUSE_MS = 5_000;
const ACTOR = 'engine:org-switch';

export interface OrgSwitchWiring {
  db: Db;
  /** 和选路、探针共用的那一个（real/index.ts）：切的时候让选路停下，切完丢掉留着的读数。 */
  org: SessionOrgControl;
  user: SessionUser;
  /** 经 root 帮手切号（生产是 adapters 的 switchSessionOrg）。 */
  switchOrg(to: OrgKind): Promise<SwitchSessionOrgResult>;
  /** 这台机器给人看的名字：提醒里写清去哪台机器看。 */
  machine: string;
  /**
   * Fusion 会话端口的切号那两样（real/sessions.ts，#59）：它的会话在跑也照切——先停下、等收场、再切，切完续上。
   * 不给就等它的会话跑完再切（#157 的做法）。
   */
  sessions?: OrgSwitchSessions;
  /**
   * 三段的一次性会话（动手、验收）的登记（real/one-shot-sessions.ts，#59）：在跑也照切——先停下、等收场、再切，切完任务工作流
   * 在原分支上重跑这一段。不给就等它们跑完再切（#157）。
   */
  oneShots?: OrgSwitchSessions;
  /** 账本和锁（默认按 db、user 建）。测试可换。 */
  store?: LedgerStore;
  /** 现读一次 reclaude 开放接口（real/carpool-api.ts）。不给就不读：没有账号清单，判法一律「读不到状态、不切」。 */
  readApi?: () => Promise<CarpoolApiRead>;
  /** 切完当场探一次切过去的那个组织的池（jobs/route-probe.ts 的 probeOrgNow）。不给就等下一轮路由探针核对。 */
  probeNow?: (to: OrgKind) => Promise<ProbedRoute[]>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  drainTimeoutMs?: number;
  pollMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

const NOW_NAMES: Readonly<Record<string, string>> = {
  ...ORG_NAMES,
  other: '类型认不出的',
  unknown: '认不出的',
};

const sameOutage = (a: CarpoolOutage | null, b: CarpoolOutage | null) =>
  a !== null && b !== null && a.kind === b.kind && a.since.getTime() === b.since.getTime();

export function orgSwitchRound(w: OrgSwitchWiring): OrgSwitchRound {
  const clock = w.now ?? (() => new Date());
  const sleep = w.sleep ?? realSleep;
  const log =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const target = `session-user:${w.user}`;
  const fix = `在${w.machine}上看会话用户现在挂的是哪个、额度几点清零，照 docs/ops.md 第五节「会话用户挂的组织」处理`;
  const store =
    w.store ?? ledgerStore({ db: w.db, user: w.user, holder: `${w.machine}:${process.pid}`, now: clock });

  const alert = (dedupeKey: string, title: string, body: string) =>
    upsertAlert(w.db, { dedupeKey, level: 'alert', taskId: null, title, body });
  // 条件没了就撤（本来就没有、撤过了都不算错）
  const settle = (dedupeKey: string, why: string) =>
    resolveAlertWithReason(w.db, { dedupeKey, by: ACTOR, why, at: clock() });

  // 和选路判「等不等切号」同一份事实（real/org-plan.ts）
  async function facts() {
    const now = clock();
    const holds = await loadHeldPools(w.db, now);
    return { ...(await loadOrgSwitchFacts(w.db, { now, held: holds.all })), holds };
  }

  /**
   * 整池暂停开关（#746）读不出、过了复查日期，写一条要人看的提醒（好了自己撤）：认不出的按暂停办（不当成能用），到期的不自动撤，
   * 只提醒人撤或写明理由续期。
   */
  async function publishPoolHolds(holds: HeldPools) {
    const { problems, holds: known } = holds.facts;
    if (problems.length > 0) {
      await alert(
        ORG_POOL_HOLD_ALERT,
        '整池暂停的设置读不出或认不出，对应的池按暂停办',
        `${problems.map((p) => p.why).join('；')}。到驾驶舱设置页「整池暂停」改好（缺哪项补哪项）；${fix}`,
      );
    } else {
      await settle(ORG_POOL_HOLD_ALERT, '整池暂停的设置读得出、认得出了');
    }
    const overdue = known.filter((h) => h.overdue);
    if (overdue.length > 0) {
      await alert(
        ORG_POOL_HOLD_OVERDUE_ALERT,
        `整池暂停到了复查日期：${overdue.map((h) => h.poolId).join('、')}`,
        `${overdue.map((h) => `${h.poolId}：复查日期 ${h.reviewBy}（${h.overdueDays === 0 ? '就是今天' : `已过 ${h.overdueDays} 天`}），原因：${h.reason}；撤回条件：${h.revokeWhen}；谁拍的：${h.decidedBy}`).join('\n')}\n引擎不会自动撤它。到驾驶舱设置页「整池暂停」撤回（要写原因），或改复查日期续期。`,
      );
    } else {
      await settle(ORG_POOL_HOLD_OVERDUE_ALERT, '没有到期没复查的整池暂停');
    }
  }

  // 停会话的：接了哪一种就停得下哪一种（两种都接了，一起停、一起等）
  const parts = [w.sessions, w.oneShots].filter((s): s is OrgSwitchSessions => s !== undefined);
  const stopper: OrgSwitchSessions | null =
    parts.length === 0
      ? null
      : {
          stop: (poolIds, why, only) => parts.flatMap((s) => s.stop(poolIds, why, only)),
          live: (poolIds) => parts.flatMap((s) => s.live(poolIds)),
        };
  /** 停不下的在跑会话有几个：哪一种没接，那一种在跑的都停不下，只能等它们跑完。 */
  const unstoppable = (f: { busy: number; busyOneShot: number }) =>
    (w.sessions ? 0 : f.busy - f.busyOneShot) + (w.oneShots ? 0 : f.busyOneShot);

  const audit = (
    action: string,
    fields: {
      before?: unknown;
      after?: unknown;
      reason: string;
      ok?: boolean;
      error?: string;
    },
  ) =>
    recordEngineAudit(w.db, {
      action,
      target,
      actorId: ACTOR,
      ...(fields.before === undefined ? {} : { before: fields.before }),
      ...(fields.after === undefined ? {} : { after: fields.after }),
      reason: fields.reason,
      ok: fields.ok ?? true,
      ...(fields.error ? { error: fields.error } : {}),
      at: clock(),
    });

  /**
   * 切之前把手上跑在 Claude 池上的会话停下，等它们都收场（#59）。登记了、进程还没起来的（还在建树）等它起来再停；三段的一段
   * 选定了路由、预占着名额还没开跑的（#757，库里 startedAt 为空的那几行）一样等：它们一登记、下一圈就停得下。
   * 排队很久还没起来的、库里还开着可这个工人手上没有的（上一轮工人留下的，起来时已经收掉了），都不是在跑的进程，不等。
   * 交回这一次叫停的会话；等不齐交回原因。
   */
  async function drain(
    sessions: OrgSwitchSessions,
    poolIds: ReadonlySet<string>,
    why: string,
  ): Promise<{ stopped: string[]; problem?: string }> {
    const timeoutMs = w.drainTimeoutMs ?? ORG_DRAIN_TIMEOUT_MS;
    const pollMs = w.pollMs ?? ORG_DRAIN_POLL_MS;
    const deadline = clock().getTime() + timeoutMs;
    const stopped = new Set<string>();
    // 按次数也有个头：时钟不走（测试里）也会停
    for (let round = 0; ; round += 1) {
      for (const id of sessions.stop(poolIds, why)) stopped.add(id);
      const live = new Set(sessions.live(poolIds));
      const now = clock().getTime();
      const starting = (await openOrgRuns(w.db, new Date(now))).filter(
        (r) => r.startedAt === null && !live.has(r.runId) && now - r.queuedAt.getTime() < ORG_STARTING_MAX_MS,
      );
      if (live.size === 0 && starting.length === 0) return { stopped: [...stopped] };
      if (now >= deadline || round >= Math.ceil(timeoutMs / pollMs)) {
        return {
          stopped: [...stopped],
          problem: `让手上的 Claude 会话停下等了 ${Math.round(timeoutMs / 1000)} 秒，还有 ${live.size} 个没收场、${starting.length} 个还在起，这一轮不切（停下的照样接着干）`,
        };
      }
      await sleep(pollMs);
    }
  }

  /** 切回宽限开始：只停开跑不到 youngMs 的（还没开跑的也停，它们没有进度）；发信号、不等。 */
  async function stopYoung(poolIds: ReadonlySet<string>, youngMs: number, why: string): Promise<string[]> {
    if (!stopper) return [];
    const now = clock().getTime();
    const older = new Set(
      (await openOrgRuns(w.db, new Date(now)))
        .filter((r) => r.startedAt !== null && now - r.startedAt.getTime() >= youngMs)
        .map((r) => r.runId),
    );
    return stopper.stop(poolIds, why, (runId) => !older.has(runId));
  }

  /** 切完探针（当场或一轮探完）读回切过去的那个池：探通了才算切成。 */
  async function verifyAfter(to: OrgKind, probed: readonly ProbedRoute[]) {
    const name = ORG_NAMES[to];
    const mine = probed.filter((p) => p.orgKind === to);
    const answered = mine.filter((p) => p.state === 'ok');
    if (answered.length > 0) {
      await audit('session-org.verify', {
        after: { org: to },
        reason: `切到${name}组织以后，${name}池的路由探通了 ${answered.length} 条`,
      });
      await settle(ORG_VERIFY_ALERT, `切到${name}组织，探针读回在线`);
      return;
    }
    const why =
      mine.length === 0
        ? `这一轮没有真探${name}池的路由，核对不了`
        : `${name}池的路由一条都没探通：${mine.map((p) => `${p.routeId}：${p.detail}`).join('；')}`;
    await audit('session-org.verify', {
      after: { org: to },
      reason: `切到${name}组织以后核对`,
      ok: false,
      error: why,
    });
    await alert(
      ORG_VERIFY_ALERT,
      `切到${name}组织以后探针读回不在线`,
      `${why}。下一轮路由探针探通了自己撤；${fix}`,
    );
    log('error', '会话用户切号：切完探针读回不在线', { to, why });
  }

  async function switchOver(
    from: OrgKind,
    to: OrgKind,
    why: string,
    poolIds: ReadonlySet<string>,
    mode: 'confirmed' | 'trial' | null,
    ledger: OrgLedger,
  ): Promise<OrgKind | null> {
    const release = w.org.hold(`正在把会话用户从${ORG_NAMES[from]}组织切到${ORG_NAMES[to]}组织`);
    let result: SwitchSessionOrgResult;
    let stopped: string[] = [];
    // 经帮手动过组织（成没成都算）：切完读成的第一次就是新起点，不算没记录的变动（real/session-org.ts）
    let touched = false;
    try {
      await sleep(w.graceMs ?? ORG_SWITCH_GRACE_MS);
      if (stopper) {
        const drained = await drain(
          stopper,
          poolIds,
          `切号：会话用户从${ORG_NAMES[from]}组织切到${ORG_NAMES[to]}组织，先停下，切完接着干`,
        );
        stopped = drained.stopped;
        if (drained.problem) {
          await audit('session-org.switch', {
            before: { org: from },
            after: { org: to, stopped },
            reason: why,
            ok: false,
            error: drained.problem,
          });
          await alert(
            ORG_SWITCH_ALERT,
            `会话用户切号没成：${ORG_NAMES[from]} → ${ORG_NAMES[to]}`,
            `为什么切：${why}。没成：${drained.problem}。下一次判断还会再试；${fix}`,
          );
          log('error', '会话用户切号：手上的会话没停齐，这一轮不切', { from, to, problem: drained.problem });
          return null;
        }
      }
      // 再数一遍：让选路停下以前派出去的，这一会儿登记了。停得下的上面已经停下、收场了；停不下的（没接的那一种）还在就这一轮不切
      const again = await facts();
      if (unstoppable(again) > 0) {
        log('info', '会话用户切号：让选路停下以后又有会话登记了，这一轮不切', {
          busy: again.busy,
          busyOneShot: again.busyOneShot,
        });
        return null;
      }
      touched = true;
      result = await w.switchOrg(to);
    } finally {
      if (touched) await w.org.engineSwitched();
      release();
    }
    const halted =
      stopped.length > 0 ? `（切之前停下了 ${stopped.length} 个在跑的 Claude 会话，切完各自接着干）` : '';
    if (result.ok) {
      await audit('session-org.switch', {
        before: { org: from },
        after: { org: to, ...(stopped.length > 0 ? { stopped } : {}), ...(mode ? { mode } : {}) },
        reason: `${result.changed ? why : `${why}（帮手读到本来就挂着${ORG_NAMES[to]}）`}${halted}`,
      });
      await store.save(
        ledgerAfterSwitch(ledger, to, clock(), to === 'carpool' ? (mode ?? 'confirmed') : null),
      );
      await settle(ORG_SWITCH_ALERT, `这一次切成了：${ORG_NAMES[from]} → ${ORG_NAMES[to]}`);
      log('info', '会话用户切号：切过去了，这一轮探完核对', { from, to, changed: result.changed });
      return to;
    }
    const error = `${result.detail}（现在挂的是${NOW_NAMES[result.now] ?? '认不出的'}组织）`;
    await audit('session-org.switch', {
      before: { org: from },
      after: { org: to, ...(stopped.length > 0 ? { stopped } : {}) },
      reason: `${why}${stopped.length > 0 ? `（切之前停下了 ${stopped.length} 个在跑的 Claude 会话，切号没成，它们照样接着干）` : ''}`,
      ok: false,
      error,
    });
    // 帮手连着失败按退避（2、10、30 分钟），不每分钟砸一次（方案第六节第 10 条）
    await store.save({ ...ledger, helperFailures: [...ledger.helperFailures, clock()].slice(-5) });
    await alert(
      ORG_SWITCH_ALERT,
      `会话用户切号没成：${ORG_NAMES[from]} → ${ORG_NAMES[to]}`,
      `为什么切：${why}。没成：${error}。下一次判断（帮手失败后按 2、10、30 分钟退避）还会再试；${fix}`,
    );
    log('error', '会话用户切号没成', { from, to, error });
    return null;
  }

  /** 判完之后把值得记的写进库：渠道状态、提醒、恢复条件、顺手发生的事。 */
  async function publish(decision: OrgDecision, before: OrgLedger) {
    const { channel, ledger } = decision;
    if (channel.alert)
      await alert(ORG_CHANNEL_ALERT, channel.alert.title, `${channel.alert.body}${fix ? `（${fix}）` : ''}`);
    else await settle(ORG_CHANNEL_ALERT, `渠道状态：${channel.summary}`);
    if (channel.changed) {
      await audit('session-org.channel', {
        ...(before.channel ? { before: { state: before.channel.state } } : {}),
        after: { state: channel.state },
        reason: channel.summary,
        ok: channel.state !== 'unavailable',
        ...(channel.state === 'unavailable' ? { error: '渠道不可用：没有一个可用账号' } : {}),
      });
    }
    if (ledger.outage && !sameOutage(before.outage, ledger.outage)) {
      await audit('session-org.outage', {
        after: {
          kind: ledger.outage.kind,
          since: ledger.outage.since.toISOString(),
          resetsAt: ledger.outage.resetsAt ? ledger.outage.resetsAt.toISOString() : null,
          resetsFrom: ledger.outage.resetsFrom,
        },
        reason: `拼车用不了（${ledger.outage.kind}）：${ledger.outage.evidence}`,
      });
    }
    for (const note of decision.notes) await audit('session-org.note', { reason: note });
    if (decision.overdue)
      await alert(ORG_OVERDUE_ALERT, '拼车恢复了却还挂在独享上', `${decision.overdue}。${fix}`);
    else await settle(ORG_OVERDUE_ALERT, '没有「在独享上待太久」的情况');
  }

  /** 一条读数入账：按它记该记的几笔（拼车上限变了、进退避、退避结束），写不进操作记录不挡切号。 */
  async function ingestRead(l: OrgLedger, read: CarpoolApiRead): Promise<OrgLedger> {
    for (const n of readNotes(l, read)) {
      try {
        await audit(n.action, {
          ...(n.before === undefined ? {} : { before: n.before }),
          ...(n.after === undefined ? {} : { after: n.after }),
          reason: n.reason,
          ok: n.ok,
          ...(n.error ? { error: n.error } : {}),
        });
      } catch (err) {
        log('error', '会话用户切号：读数的操作记录写不进库', { action: n.action, error: errMessage(err) });
      }
    }
    return withRead(l, read);
  }

  /** 切完现读一次（方案 4.1），存进账本：切完的新读数给下一轮判恢复、给驾驶舱烧速用。退避期里不读；出什么错都不抛。 */
  async function readAfterSwitch(): Promise<void> {
    const readApi = w.readApi;
    if (!readApi) return;
    try {
      await store.withLock(async () => {
        const l = await store.load();
        if (readBackoff(l, clock()).active) return;
        await store.save(await ingestRead(l, await readApi()));
      });
    } catch (err) {
      log('error', '会话用户切号：切完现读一次接口这一步出错', { error: errMessage(err) });
    }
  }

  /** 一次判断 + 动手。在锁里跑。交回切到哪一类（没切 null）。 */
  async function run(trigger: OrgSwitchTrigger): Promise<{ to: OrgKind | null }> {
    let loaded: OrgLedger;
    try {
      loaded = await store.load();
    } catch (err) {
      if (err instanceof OrgLedgerError) {
        await alert(ORG_LEDGER_ALERT, '切号账本认不出：引擎不切号', `${err.message}。${fix}`);
        log('error', '会话用户切号：账本认不出，这一轮不切', { error: err.message });
        return { to: null };
      }
      throw err;
    }
    await settle(ORG_LEDGER_ALERT, '切号账本读得出了');
    const t0 = clock();
    let read = trigger.read;
    // 退避期里谁都不砸接口（方案 4.1）：这一轮拿不到新读数，按「读不到」办——不当拼车能用、也不当额度满
    if (!read && w.readApi && !readBackoff(loaded, t0).active) {
      const last = loaded.reads.at(-1);
      if (!last || t0.getTime() - last.requestedAt.getTime() > ORG_READ_REUSE_MS) read = await w.readApi();
    }
    let ledger = read ? await ingestRead(loaded, read) : loaded;
    // 切不切看现在的真实状态：留着的读数可能是半分钟前的（起点不动：读数刚变、没定下来就这一轮不切）
    w.org.forget();
    const live = await w.org({ by: trigger.by });
    const f = await facts();
    await publishPoolHolds(f.holds);
    // 额度留量线读不到、认不出（种子没装上、值被人改坏）：要人看，引擎对这类池不派、不切；好了自己撤
    const reserveProblems = [
      ...new Set(
        Object.values(f.pools)
          .map((p) => p?.reserve?.problem)
          .filter((p): p is string => typeof p === 'string'),
      ),
    ];
    if (reserveProblems.length > 0) {
      await alert(
        ORG_RESERVE_ALERT,
        '额度留量线读不到或认不出，引擎不派、不切独享',
        `${reserveProblems.join('；')}。线只存在库里（种子 packages/db/quota-reserve.default.json 由发布时的装载器只补缺装进去，驾驶舱设置页改）；${fix}`,
      );
    } else {
      await settle(ORG_RESERVE_ALERT, '额度留量线读得出、认得出了');
    }
    const { pause, problem } = await soloPauseOf(w.db);
    if (problem) log('error', '设置「引擎暂不用独享」的值认不出，按暂停办', { problem });
    let rejection: CarpoolOutage | undefined;
    if (trigger.rejection) {
      const verdict = classifyCarpoolRejection(trigger.rejection, ledger.reads.at(-1) ?? null);
      if (verdict.kind === 'outage') rejection = verdict.outage;
      else log('info', '会话用户切号：这次被拒不是拼车用不了的那几种，不据此切', { verdict });
    }
    const decide = (l: OrgLedger, at: Date) =>
      decideFrom({
        live,
        facts: f,
        ledger: l,
        now: at,
        ...(stopper && unstoppable(f) === 0 ? { canStopRunning: true } : {}),
        ...(rejection ? { rejection } : {}),
        pause,
      });
    let decision = decide(ledger, t0);
    // 切号前现读一次（方案 4.1）：判成要切，就用一次不重用旧读数的新读数再判一遍，免得凭半分钟前的读数动手；
    // 刚读过（几秒内）的不重读，退避期里不读。重判的结果为准（可能变成不切）。
    if (decision.plan.action === 'switch' && w.readApi && !readBackoff(ledger, t0).active) {
      const last = ledger.reads.at(-1);
      if (!last || t0.getTime() - last.requestedAt.getTime() > ORG_PRESWITCH_REUSE_MS) {
        ledger = await ingestRead(ledger, await w.readApi());
        decision = decide(ledger, clock());
      }
    }
    // 先存账本再动手：恢复条件、切回记录、白切记账不因为后面的动作没成就丢
    await store.save(decision.ledger);
    await publish(decision, loaded);
    const plan: OrgPlan = decision.plan;
    log('info', '会话用户切号：这一轮的判断', { by: trigger.by, action: plan.action, why: plan.why });
    if (plan.action === 'stuck') {
      await alert(ORG_STUCK_ALERT, '会话用户切号卡住了，要人看', `${plan.why}。${fix}`);
      return { to: null };
    }
    await settle(ORG_STUCK_ALERT, `不再卡着：${plan.why}`);
    // 挂的是哪个认得出、又不用切：之前没切成的那条过去了（人切好了，或者额度变了不用切了）
    if (plan.action === 'stay' && live.ok) await settle(ORG_SWITCH_ALERT, `现在不用切了：${plan.why}`);
    if (plan.action === 'drain') {
      if (plan.stopYoungerThanMs !== null) {
        const stopped = await stopYoung(
          f.poolIds,
          plan.stopYoungerThanMs,
          '切回拼车的宽限开始：开跑不到几分钟的先停下，重跑丢得少',
        );
        await audit('session-org.drain', {
          after: { stopped, until: plan.until.toISOString() },
          reason: `${plan.why}（先停下了 ${stopped.length} 个）`,
        });
        log('info', '会话用户切号：切回宽限开始', { stopped: stopped.length, until: stamp(plan.until) });
      }
      return { to: null };
    }
    if (plan.action !== 'switch' || !live.ok) return { to: null };
    const to = await switchOver(live.org, plan.to, plan.why, f.poolIds, plan.mode ?? null, decision.ledger);
    return { to };
  }

  /** 单飞：同一时刻只一个判断在跑；撞上的这一次不判。出什么错都不抛。 */
  async function evaluate(trigger: OrgSwitchTrigger, probeRound: boolean): Promise<OrgKind | null> {
    let outcome: { ran: true; value: { to: OrgKind | null } } | { ran: false; why: string };
    try {
      outcome = await store.withLock(() => run(trigger));
    } catch (err) {
      log('error', '会话用户切号这一步出错（这一轮不切，探针照探）', {
        by: trigger.by,
        error: errMessage(err),
      });
      return null;
    }
    if (!outcome.ran) {
      log('info', '会话用户切号：撞上另一个切号判断，这一次不判', { by: trigger.by, why: outcome.why });
      return null;
    }
    const to = outcome.value.to;
    // 当场触发的：切完当场探一次切过去的那个池（探针那一轮的由探针自己核对）。放在锁外：探一次最长几分钟
    if (to !== null && !probeRound && w.probeNow) {
      try {
        await verifyAfter(to, await w.probeNow(to));
      } catch (err) {
        log('error', '会话用户切号：切完当场探这一步出错', { to, error: errMessage(err) });
      }
    }
    if (to !== null) await readAfterSwitch();
    return to;
  }

  return {
    now: (trigger) => evaluate(trigger, false),

    before: () => evaluate({ by: '切号' }, true),

    async after(to, probed) {
      try {
        if (to === null) {
          // 这一轮没切：之前切完读回不在线的那条，挂着的那个池这一轮探通了就撤（探针只探挂着的那个池）
          const up = probed.find((p) => p.orgKind !== null && p.state === 'ok');
          if (up?.orgKind) {
            await settle(ORG_VERIFY_ALERT, `${ORG_NAMES[up.orgKind]}池的路由探通了（${up.routeId}）`);
          }
          return;
        }
        await verifyAfter(to, probed);
      } catch (err) {
        log('error', '会话用户切号：探完核对这一步出错', { to, error: errMessage(err) });
      }
    },
  };
}

export interface OrgDriftWiring {
  db: Db;
  user: SessionUser;
  machine: string;
  settleMs?: number;
  now?: () => Date;
}

const DRIFT_ACTOR = 'engine:session-org';

/** 「09-27 21:54:00 选路读到独享」。 */
const sighting = (s: OrgSighting) => `${readingStamp(s.at)} ${s.by}读到${ORG_NAMES[s.org]}`;

/**
 * 起点变动（real/session-org.ts 的 onEvent）写进库：读数变了、引擎没切过号，推一条 session-org:drift「要人看」提醒（带前后
 * 两次读数，驾驶舱和飞书都推，健康检查 session_org 跟着红），记一条操作记录 session-org.drift；定下来了（回到原来的、认了新的、
 * 引擎切了号）撤掉，再记一条 session-org.settle。写不进库照抛，由读法记错误日志（读数照样按没定下来给，不当成 ok）。
 */
export function orgDriftReporter(w: OrgDriftWiring): (event: SessionOrgEvent) => Promise<void> {
  const clock = w.now ?? (() => new Date());
  const target = `session-user:${w.user}`;
  const settleMinutes = Math.round((w.settleMs ?? SESSION_ORG_SETTLE_MS) / 60_000);
  return async (event) => {
    const from = ORG_NAMES[event.from.org];
    const to = ORG_NAMES[event.to.org];
    const readings = `前后两次读数（北京时间）：${sighting(event.from)}，${sighting(event.to)}`;
    if (event.kind === 'drift') {
      await upsertAlert(w.db, {
        dedupeKey: ORG_DRIFT_ALERT,
        level: 'alert',
        taskId: null,
        title: `会话用户挂的组织变了，引擎没切过号：${from} → ${to}`,
        body: [
          `${readings}。库里没有引擎这一下的切号记录（引擎自己切的都记 session-org.switch）：多半是有人在${w.machine}上手动切了（fleet-agent-scope org-use，或以会话用户跑 reclaude org use），也可能是 reclaude 自己换了挂的组织。`,
          `引擎先不照它来：选路过一会儿再选、路由探针不探 Claude 池、切号不判；读数回到${from}就照常，连着 ${settleMinutes} 分钟都是${to}才认它（要不要切回由下一轮路由探针的切号照常判）。`,
          `要查是谁切的：在${w.machine}上跑 journalctl _COMM=sudo | grep org-use 看有没有人经帮手手动切；照 docs/ops.md 第五节「会话用户挂的组织」。`,
        ].join('\n'),
      });
      await recordEngineAudit(w.db, {
        action: 'session-org.drift',
        target,
        actorId: DRIFT_ACTOR,
        before: { org: event.from.org, at: event.from.at.toISOString(), by: event.from.by },
        after: { org: event.to.org, at: event.to.at.toISOString(), by: event.to.by },
        reason: `读数变了、引擎没切过号：${readings}`,
        ok: true,
        at: clock(),
      });
      return;
    }
    const why =
      event.how === 'back'
        ? `读数回到了${from}（${event.last ? sighting(event.last) : '之后又读'}）：${to}那一下没定下来，照${from}接着派。${readings}`
        : event.how === 'accepted'
          ? `读数定下来了：从${readingStamp(event.to.at)}起连着 ${settleMinutes} 分钟都是${to}（${event.last ? sighting(event.last) : ''}），照${to}来；要不要切回由下一轮路由探针的切号判。${readings}`
          : `引擎切了号，以切完读到的为准。${readings}`;
    await resolveAlertWithReason(w.db, { dedupeKey: ORG_DRIFT_ALERT, by: DRIFT_ACTOR, why, at: clock() });
    await recordEngineAudit(w.db, {
      action: 'session-org.settle',
      target,
      actorId: DRIFT_ACTOR,
      before: { org: event.from.org },
      // 引擎切了号的那种：切到哪个看同一时刻那条 session-org.switch
      after:
        event.how === 'engine'
          ? { how: event.how }
          : { org: event.how === 'back' ? event.from.org : event.to.org, how: event.how },
      reason: why,
      ok: true,
      at: clock(),
    });
  };
}
