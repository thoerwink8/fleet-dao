// 会话用户切号的真装配（#157、#59）：路由探针每一轮探之前，现读会话用户挂的组织（session-org.ts）、库里两个 Claude 池的额度、
// 整池暂停和还没结束的 Claude 会话（db 的 sessionOrgFacts），照 jobs/org-switch.ts 判。该切：先让选路停下（读组织回 pending，
// 选路过 30 秒再选），等一会儿（选路刚派出去、还没登记的会话要有时间登记）；接了停会话的那两样（#59）就把手上跑在 Claude 池上的
// 会话停下，等它们都收场：三段的一次性会话（oneShots，real/one-shot-sessions.ts）交回 org_switch，任务工作流切完在原分支上
// 重跑这一段；Fusion 的会话（sessions）交回 org_switch，切完续同一个会话、换了池 fork 续上。哪一种没接，那一种在跑就停不下：
// 手上有就不切、等它们跑完（#157 的做法），切之前也再数一遍。
// 然后经 root 帮手的 org-use 切过去（adapters 的 switchSessionOrg：帮手以会话用户读 org list 认出那一类、切、回读核对，
// 没切成、核对不了都切回原来的），切完记操作记录。这一轮探完，切过去的那个池的路由探通了才算切成（after）。
// 没切成、切完探针读回不在线、拼车用满却读不到几点恢复：写一条 session-org:* 的「要人看」提醒（驾驶舱和飞书看得到，驾驶舱
// 后端的健康检查 session_org 跟着红），条件没了自己撤。这一步出什么错都不抛：探针照探，下一轮再判。
// 事实和判法跟选路判「等不等切号」同一份（real/org-plan.ts）；经帮手动过组织就告诉读法（engineSwitched），切完读成的是新起点。
// 读数变了、引擎没切过号（real/session-org.ts 的起点变动）由 orgDriftReporter 写 session-org:drift 提醒和操作记录（#335）。
import type { SessionUser, SwitchSessionOrgResult } from '@fleet-dao/adapters';
import {
  type Db,
  openAlertsByPrefix,
  openOrgRuns,
  recordEngineAudit,
  resolveAlertWithReason,
  SESSION_ORG_ALERT_PREFIX,
  upsertAlert,
} from '@fleet-dao/db';
import type { OrgKind } from '@fleet-dao/shared';
import { type OrgSwitchRound, planOrgSwitch } from '../jobs/org-switch.ts';
import { ORG_NAMES } from '../routing/names.ts';
import { loadOrgSwitchFacts } from './org-plan.ts';
import {
  type OrgSighting,
  readingStamp,
  SESSION_ORG_SETTLE_MS,
  type SessionOrgControl,
  type SessionOrgEvent,
} from './session-org.ts';
import { POOL_HOLD_PREFIX } from './store-ports.ts';

/**
 * 切号那一刻在跑的会话（#59），一种会话一份（Fusion 的会话端口、三段的一次性会话登记）。只管这个工人进程里起的：一次性会话不脱开
 * 引擎跑，Fusion 的会话工人重启时收掉或接回，库里还开着、手上没有的都不是在跑的进程。
 * stop：把跑在这些账号池上的停下（发信号、不等），交回这一次叫停的编号（已经在停的不重复叫停）。
 * live：跑在这些账号池上、还没收场的编号，切号要等它们都收场。
 */
export interface OrgSwitchSessions {
  stop(poolIds: ReadonlySet<string>, why: string): string[];
  live(poolIds: ReadonlySet<string>): string[];
}

/** 切号没成（帮手没切过去）。下一次切成了、或者不用切了（人切好了、额度变了）撤。 */
export const ORG_SWITCH_ALERT = `${SESSION_ORG_ALERT_PREFIX}switch`;
/** 切过去了，这一轮探针读回切过去的那个池不在线。之后哪一轮挂着的那个池探通了撤。 */
export const ORG_VERIFY_ALERT = `${SESSION_ORG_ALERT_PREFIX}verify`;
/** 拼车用满了却读不到几点恢复：不知道什么时候切回。 */
export const ORG_STUCK_ALERT = `${SESSION_ORG_ALERT_PREFIX}stuck`;
/**
 * 会话用户挂的组织读数变了、引擎没切过号（#335，real/session-org.ts 的起点）：带前后两次读数。读数回到原来的、或者连着
 * SESSION_ORG_SETTLE_MS 都是新的（认它了）、或者引擎切了号，撤。
 */
export const ORG_DRIFT_ALERT = `${SESSION_ORG_ALERT_PREFIX}drift`;
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
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  drainTimeoutMs?: number;
  pollMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const NOW_NAMES: Readonly<Record<string, string>> = {
  ...ORG_NAMES,
  other: '类型认不出的',
  unknown: '认不出的',
};

export function orgSwitchRound(w: OrgSwitchWiring): OrgSwitchRound {
  const clock = w.now ?? (() => new Date());
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const target = `session-user:${w.user}`;
  const fix = `在${w.machine}上看会话用户现在挂的是哪个、额度几点清零，照 docs/ops.md 第五节「会话用户挂的组织」处理`;

  const alert = (dedupeKey: string, title: string, body: string) =>
    upsertAlert(w.db, { dedupeKey, level: 'alert', taskId: null, title, body });
  // 条件没了就撤（本来就没有、撤过了都不算错）
  const settle = (dedupeKey: string, why: string) =>
    resolveAlertWithReason(w.db, { dedupeKey, by: ACTOR, why, at: clock() });

  // 和选路判「等不等切号」同一份事实（real/org-plan.ts）
  async function facts() {
    const holds = await openAlertsByPrefix(w.db, POOL_HOLD_PREFIX);
    const held = new Set(holds.map((a) => a.dedupeKey.slice(POOL_HOLD_PREFIX.length)));
    return loadOrgSwitchFacts(w.db, { now: clock(), held });
  }

  // 停会话的：接了哪一种就停得下哪一种（两种都接了，一起停、一起等）
  const parts = [w.sessions, w.oneShots].filter((s): s is OrgSwitchSessions => s !== undefined);
  const stopper: OrgSwitchSessions | null =
    parts.length === 0
      ? null
      : {
          stop: (poolIds, why) => parts.flatMap((s) => s.stop(poolIds, why)),
          live: (poolIds) => parts.flatMap((s) => s.live(poolIds)),
        };
  /** 停不下的在跑会话有几个：哪一种没接，那一种在跑的都停不下，只能等它们跑完。 */
  const unstoppable = (f: { busy: number; busyOneShot: number }) =>
    (w.sessions ? 0 : f.busy - f.busyOneShot) + (w.oneShots ? 0 : f.busyOneShot);

  /**
   * 切之前把手上跑在 Claude 池上的会话停下，等它们都收场（#59）。登记了、进程还没起来的（还在建树）等它起来再停；
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
      const starting = (await openOrgRuns(w.db)).filter(
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

  async function switchOver(
    from: OrgKind,
    to: OrgKind,
    why: string,
    poolIds: ReadonlySet<string>,
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
          await recordEngineAudit(w.db, {
            action: 'session-org.switch',
            target,
            actorId: ACTOR,
            before: { org: from },
            after: { org: to, stopped },
            reason: why,
            ok: false,
            error: drained.problem,
            at: clock(),
          });
          await alert(
            ORG_SWITCH_ALERT,
            `会话用户切号没成：${ORG_NAMES[from]} → ${ORG_NAMES[to]}`,
            `为什么切：${why}。没成：${drained.problem}。下一轮路由探针还会再判、再试；${fix}`,
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
      await recordEngineAudit(w.db, {
        action: 'session-org.switch',
        target,
        actorId: ACTOR,
        before: { org: from },
        after: { org: to, ...(stopped.length > 0 ? { stopped } : {}) },
        reason: `${result.changed ? why : `${why}（帮手读到本来就挂着${ORG_NAMES[to]}）`}${halted}`,
        ok: true,
        at: clock(),
      });
      await settle(ORG_SWITCH_ALERT, `这一次切成了：${ORG_NAMES[from]} → ${ORG_NAMES[to]}`);
      log('info', '会话用户切号：切过去了，这一轮探完核对', { from, to, changed: result.changed });
      return to;
    }
    const error = `${result.detail}（现在挂的是${NOW_NAMES[result.now] ?? '认不出的'}组织）`;
    await recordEngineAudit(w.db, {
      action: 'session-org.switch',
      target,
      actorId: ACTOR,
      before: { org: from },
      after: { org: to, ...(stopped.length > 0 ? { stopped } : {}) },
      reason: `${why}${stopped.length > 0 ? `（切之前停下了 ${stopped.length} 个在跑的 Claude 会话，切号没成，它们照样接着干）` : ''}`,
      ok: false,
      error,
      at: clock(),
    });
    await alert(
      ORG_SWITCH_ALERT,
      `会话用户切号没成：${ORG_NAMES[from]} → ${ORG_NAMES[to]}`,
      `为什么切：${why}。没成：${error}。下一轮路由探针还会再判、再试；${fix}`,
    );
    log('error', '会话用户切号没成', { from, to, error });
    return null;
  }

  return {
    async before() {
      try {
        // 切不切看现在的真实状态：留着的读数可能是半分钟前的（起点不动：读数刚变、没定下来就这一轮不切）
        w.org.forget();
        const live = await w.org({ by: '切号' });
        const { pools, busy, busyOneShot, poolIds } = await facts();
        const plan = planOrgSwitch({
          live,
          pools,
          busy,
          // 手上在跑的都停得下就照切（先停下、切完接着干）；有停不下的（没接的那一种）就等它们跑完
          ...(stopper && unstoppable({ busy, busyOneShot }) === 0 ? { canStopRunning: true } : {}),
          now: clock(),
        });
        log('info', '会话用户切号：这一轮的判断', { action: plan.action, why: plan.why });
        if (plan.action === 'stuck') {
          await alert(ORG_STUCK_ALERT, '拼车恢复时刻读不到，不知道什么时候切回拼车', `${plan.why}。${fix}`);
          return null;
        }
        await settle(ORG_STUCK_ALERT, `不再卡着：${plan.why}`);
        // 挂的是哪个认得出、又不用切：之前没切成的那条过去了（人切好了，或者额度变了不用切了）
        if (plan.action === 'stay' && live.ok) await settle(ORG_SWITCH_ALERT, `现在不用切了：${plan.why}`);
        if (plan.action !== 'switch' || !live.ok) return null;
        return await switchOver(live.org, plan.to, plan.why, poolIds);
      } catch (err) {
        log('error', '会话用户切号这一步出错（这一轮不切，探针照探）', { error: message(err) });
        return null;
      }
    },

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
        const name = ORG_NAMES[to];
        const mine = probed.filter((p) => p.orgKind === to);
        const answered = mine.filter((p) => p.state === 'ok');
        if (answered.length > 0) {
          await recordEngineAudit(w.db, {
            action: 'session-org.verify',
            target,
            actorId: ACTOR,
            after: { org: to },
            reason: `切到${name}组织以后，${name}池的路由探通了 ${answered.length} 条`,
            ok: true,
            at: clock(),
          });
          await settle(ORG_VERIFY_ALERT, `切到${name}组织，探针读回在线`);
          return;
        }
        const why =
          mine.length === 0
            ? `这一轮没有真探${name}池的路由，核对不了`
            : `${name}池的路由一条都没探通：${mine.map((p) => `${p.routeId}：${p.detail}`).join('；')}`;
        await recordEngineAudit(w.db, {
          action: 'session-org.verify',
          target,
          actorId: ACTOR,
          after: { org: to },
          reason: `切到${name}组织以后核对`,
          ok: false,
          error: why,
          at: clock(),
        });
        await alert(
          ORG_VERIFY_ALERT,
          `切到${name}组织以后探针读回不在线`,
          `${why}。下一轮路由探针探通了自己撤；${fix}`,
        );
        log('error', '会话用户切号：切完探针读回不在线', { to, why });
      } catch (err) {
        log('error', '会话用户切号：探完核对这一步出错', { to, error: message(err) });
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
