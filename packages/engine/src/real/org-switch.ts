// 会话用户切号的真装配（#157）：路由探针每一轮探之前，现读会话用户挂的组织（session-org.ts）、库里两个 Claude 池的额度、
// 整池暂停和还没结束的 Claude 会话（db 的 sessionOrgFacts），照 jobs/org-switch.ts 判。该切又空着：先让选路停下（读组织回
// pending，选路过 30 秒再选），等一会儿、再数一遍会话（选路刚派出去、还没登记的会话要有时间登记），还空着就经 root 帮手的
// org-use 切过去（adapters 的 switchSessionOrg：帮手以会话用户读 org list 认出那一类、切、回读核对，没切成切回原来的），
// 切完记操作记录。这一轮探完，切过去的那个池的路由探通了才算切成（after）。
// 没切成、切完探针读回不在线、拼车用满却读不到几点恢复：写一条 session-org:* 的「要人看」提醒（驾驶舱和飞书看得到，驾驶舱
// 后端的健康检查 session_org 跟着红），条件没了自己撤。这一步出什么错都不抛：探针照探，下一轮再判。
import type { SessionUser, SwitchSessionOrgResult } from '@fleet-dao/adapters';
import {
  type Db,
  openAlertsByPrefix,
  recordEngineAudit,
  resolveAlertWithReason,
  SESSION_ORG_ALERT_PREFIX,
  sessionOrgFacts,
  upsertAlert,
} from '@fleet-dao/db';
import type { OrgKind } from '@fleet-dao/shared';
import { type OrgPool, type OrgSwitchRound, planOrgSwitch } from '../jobs/org-switch.ts';
import { ORG_NAMES } from '../routing/names.ts';
import type { SessionOrgControl } from './session-org.ts';
import { POOL_HOLD_PREFIX } from './store-ports.ts';

/** 切号没成（帮手没切过去）。下一次切成了、或者不用切了（人切好了、额度变了）撤。 */
export const ORG_SWITCH_ALERT = `${SESSION_ORG_ALERT_PREFIX}switch`;
/** 切过去了，这一轮探针读回切过去的那个池不在线。之后哪一轮挂着的那个池探通了撤。 */
export const ORG_VERIFY_ALERT = `${SESSION_ORG_ALERT_PREFIX}verify`;
/** 拼车用满了却读不到几点恢复：不知道什么时候切回。 */
export const ORG_STUCK_ALERT = `${SESSION_ORG_ALERT_PREFIX}stuck`;
/**
 * 让选路停下以后等多久、再数一遍没结束的会话才切：选路派出去到起会话那一步登记（session_runs）之间隔着一次活动调度和几次查库，
 * 平时一两秒。切号一次（一个 5 小时窗口最多两次）Claude 停派这么久，换不让刚派的会话被切号掐断。
 */
export const ORG_SWITCH_GRACE_MS = 15_000;
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
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
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

  async function facts() {
    const [f, holds] = await Promise.all([
      sessionOrgFacts(w.db, { now: clock() }),
      openAlertsByPrefix(w.db, POOL_HOLD_PREFIX),
    ]);
    const held = new Set(holds.map((a) => a.dedupeKey.slice(POOL_HOLD_PREFIX.length)));
    const pools: Partial<Record<OrgKind, OrgPool>> = {};
    for (const p of f.pools) {
      const seen = pools[p.orgKind];
      pools[p.orgKind] = {
        windows: [...(seen?.windows ?? []), ...p.windows],
        held: (seen?.held ?? false) || held.has(p.poolId),
      };
    }
    return { pools, busy: f.busy };
  }

  async function switchOver(from: OrgKind, to: OrgKind, why: string): Promise<OrgKind | null> {
    const release = w.org.hold(`正在把会话用户从${ORG_NAMES[from]}组织切到${ORG_NAMES[to]}组织`);
    let result: SwitchSessionOrgResult;
    try {
      await sleep(w.graceMs ?? ORG_SWITCH_GRACE_MS);
      const again = await facts();
      if (again.busy > 0) {
        log('info', '会话用户切号：让选路停下以后又有会话登记了，这一轮不切', { busy: again.busy });
        return null;
      }
      result = await w.switchOrg(to);
    } finally {
      release();
    }
    if (result.ok) {
      await recordEngineAudit(w.db, {
        action: 'session-org.switch',
        target,
        actorId: ACTOR,
        before: { org: from },
        after: { org: to },
        reason: result.changed ? why : `${why}（帮手读到本来就挂着${ORG_NAMES[to]}）`,
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
      after: { org: to },
      reason: why,
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
        // 切不切看现在的真实状态：留着的读数可能是半分钟前的
        w.org.forget();
        const live = await w.org();
        const { pools, busy } = await facts();
        const plan = planOrgSwitch({ live, pools, busy, now: clock() });
        log('info', '会话用户切号：这一轮的判断', { action: plan.action, why: plan.why });
        if (plan.action === 'stuck') {
          await alert(ORG_STUCK_ALERT, '拼车恢复时刻读不到，不知道什么时候切回拼车', `${plan.why}。${fix}`);
          return null;
        }
        await settle(ORG_STUCK_ALERT, `不再卡着：${plan.why}`);
        // 挂的是哪个认得出、又不用切：之前没切成的那条过去了（人切好了，或者额度变了不用切了）
        if (plan.action === 'stay' && live.ok) await settle(ORG_SWITCH_ALERT, `现在不用切了：${plan.why}`);
        if (plan.action !== 'switch' || !live.ok) return null;
        return await switchOver(live.org, plan.to, plan.why);
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
