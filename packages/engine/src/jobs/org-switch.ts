// 会话用户切号（#157、#59，design 第九节「拼车用完，切独享接着干」）：路由探针每一轮探之前判一次要不要切，这里是纯判法和
// 探针那一轮用的接口（真装配在 real/org-switch.ts）。
// 平时挂拼车：拼车额度用满（和选路同一个判法：会话、探针被拒记成的读数，或读数到顶）就切独享；拼车用满的那几个窗口
// 清零时刻都过了，就切回拼车。切号会让这个家目录下在跑的 Claude 会话全断：能先把它们都停下、切完接着干（#59，canStopRunning：
// 三段的一次性会话在原分支上重跑这一段，Fusion 的会话换了池 fork 续上）就照切；有停不下的就等它们跑完（#157 的做法）。
// 明确失败，不当成到点了、不当成切好了：挂的是哪个认不出就不切；拼车用满了却读不到几点恢复（stuck），要人看——读数旧了也
// 不算恢复（读数旧了在选路里算「不知道」，可在这里当成恢复就会切回去、被拒、再切走，来回折腾）。
import type { OrgKind, ReserveHit, ReserveUnknown, RouteProbeState } from '@fleet-dao/shared';
import { ORG_NAMES } from '../routing/names.ts';
import type { LiveOrgReading } from '../routing/types.ts';
import type { CarpoolApiRead, CarpoolRejection } from './carpool-outage.ts';

export interface OrgWindow {
  label: string;
  /** 和选路同一个判法（db 的 windowState）：ok、exhausted、stale、reset。 */
  state: 'ok' | 'exhausted' | 'stale' | 'reset';
  /** 读数本身说到顶了（被拒、用量到顶），不管读数旧不旧（db 的 windowFull）。 */
  full: boolean;
  resetsAt: Date | null;
}

/**
 * 这一类池的额度留量线判过的结果（real/org-plan.ts 按设置和读数算好交来；shared 的 evaluateReserve）。problem 不是 null = 线的设置
 * 认不出，不当成不限；hits 是到了线的读数；unknown 是配了线却判不了的窗口（读数缺、没给已用多少），按「额度未知」。
 */
export interface OrgReserveFacts {
  problem: string | null;
  hits: ReserveHit[];
  unknown: ReserveUnknown[];
}

export interface OrgPool {
  windows: OrgWindow[];
  /** 没给 = 没判留量线（老的输入、纯函数测试）；真装配（real/org-plan.ts 的 loadOrgSwitchFacts）一定给。 */
  reserve?: OrgReserveFacts;
  /** 整池暂停着（开关 engine.poolHolds，或 pool-hold 那条要人拍还开着：登录失效、封号……）：切过去也派不了。 */
  held: boolean;
}

export interface OrgSwitchFacts {
  live: LiveOrgReading;
  /** 带组织类型的池（db 的 sessionOrgFacts）；库里没有这一类的池就不给。 */
  pools: Partial<Record<OrgKind, OrgPool>>;
  /** 带组织类型的池上还没结束的会话数。 */
  busy: number;
  /**
   * 在跑的 Claude 会话都能先停下、切完接着干（#59：停会话的那两样接上了，real/org-switch.ts）：有会话在跑也照切。
   * 不给 = 有停不下的，等它们跑完再切。
   */
  canStopRunning?: boolean;
  now: Date;
}

export type OrgSwitchPlan =
  /** 不用切。later：到那个时刻（拼车几点恢复）要切回去，这一轮先不切。 */
  | { action: 'stay'; why: string; later?: { to: OrgKind; at: Date } }
  /** 该切，手上还有 Claude 会话在跑：等下一轮。 */
  | { action: 'wait'; to: OrgKind; why: string }
  | { action: 'switch'; to: OrgKind; why: string }
  /** 明确失败，要人看：不知道什么时候该切回去。 */
  | { action: 'stuck'; why: string };

const stamp = (d: Date) => `${d.toISOString().replace('T', ' ').slice(0, 16)}（UTC）`;

export function planOrgSwitch(facts: OrgSwitchFacts): OrgSwitchPlan {
  const { live, now } = facts;
  if (!live.ok) {
    // 读数刚变、引擎没切过号（real/session-org.ts 的起点）也回 pending：定下来之前不切，下一轮再判
    return live.pending
      ? { action: 'stay', why: `会话用户挂的组织这会儿定不下来（${live.why}），这一轮不切` }
      : { action: 'stay', why: `会话用户挂的组织认不出（${live.why}），不切` };
  }
  const carpool = facts.pools.carpool;
  const solo = facts.pools.solo;
  if (!carpool || !solo) return { action: 'stay', why: '库里拼车、独享两个池不全，没得切' };
  let want: { to: OrgKind; why: string };
  if (live.org === 'carpool') {
    // 和选路同一个判法：选路不再往拼车派的时候才切
    const full = carpool.windows.filter((w) => w.state === 'exhausted');
    if (full.length === 0) return { action: 'stay', why: '挂着拼车，拼车额度没用满' };
    const labels = full.map((w) => w.label).join('、');
    if (solo.held) {
      return {
        action: 'stay',
        why: `拼车额度用满了（${labels}），可独享池整池暂停着（等人处理），切过去也派不了`,
      };
    }
    if (solo.windows.some((w) => w.state === 'exhausted')) {
      return { action: 'stay', why: `拼车（${labels}）、独享的额度都用满了，切过去也派不了，等清零` };
    }
    const known = full.map((w) => w.resetsAt).filter((d): d is Date => d !== null);
    const when =
      known.length === full.length
        ? `，${stamp(new Date(Math.max(...known.map((d) => d.getTime()))))} 清零`
        : '，清零时刻不知道';
    want = { to: 'solo', why: `拼车额度用满了（${labels}${when}），切到独享接着干` };
  } else {
    // 拼车那边说用满、清零时刻还没过的窗口（读数旧了也算：没有新读数说它恢复了）
    const pending = carpool.windows.filter(
      (w) => w.full && (w.resetsAt === null || w.resetsAt.getTime() > now.getTime()),
    );
    const unknown = pending.filter((w) => w.resetsAt === null);
    if (unknown.length > 0) {
      return {
        action: 'stuck',
        why: `挂着独享；拼车额度用满了（${unknown.map((w) => w.label).join('、')}），却读不到几点恢复：不知道什么时候切回拼车，要人看`,
      };
    }
    if (pending.length > 0) {
      const until = new Date(Math.max(...pending.map((w) => (w.resetsAt as Date).getTime())));
      // 到点了拼车整池还暂停着，也不切回（下面那条）：那就不算打算切回
      return carpool.held
        ? { action: 'stay', why: `挂着独享；拼车 ${stamp(until)} 才恢复，拼车池还整池暂停着（等人处理）` }
        : {
            action: 'stay',
            why: `挂着独享；拼车 ${stamp(until)} 才恢复，到点再切回`,
            later: { to: 'carpool', at: until },
          };
    }
    if (carpool.held) {
      return { action: 'stay', why: '挂着独享；拼车池整池暂停着（等人处理），先不切回' };
    }
    want = {
      to: 'carpool',
      why: '挂着独享；拼车没有用满的读数（清零时刻过了，或本来就没用满），切回拼车（平时挂拼车）',
    };
  }
  if (facts.busy > 0 && facts.canStopRunning) {
    return {
      action: 'switch',
      to: want.to,
      why: `${want.why}；手上 ${facts.busy} 个 Claude 会话先停下，切完接着干`,
    };
  }
  if (facts.busy > 0) {
    return {
      action: 'wait',
      to: want.to,
      why: `${want.why}；手上还有 ${facts.busy} 个 Claude 会话没结束，等跑完再切到${ORG_NAMES[want.to]}`,
    };
  }
  return { action: 'switch', to: want.to, why: want.why };
}

/**
 * 引擎打算让会话用户挂到哪个组织（选路判「不是挂着的那个组织的池」等不等得来，和切号同一个判法、同一份事实）：
 * switch、wait 是下一轮路由探针就切过去（at 为空）；stay 带 later 是到那个时刻以后的那一轮切回；别的（不用切、认不出、
 * 卡住要人看）to 为空，why 写为什么不切。
 */
export interface OrgIntent {
  to: OrgKind | null;
  at: Date | null;
  why: string;
}

export function orgIntent(plan: OrgSwitchPlan): OrgIntent {
  if (plan.action === 'switch' || plan.action === 'wait') return { to: plan.to, at: null, why: plan.why };
  if (plan.action === 'stay' && plan.later) return { to: plan.later.to, at: plan.later.at, why: plan.why };
  return { to: null, at: null, why: plan.why };
}

/** 这一轮探完的一条结论（jobs/route-probe.ts 交给 after；放慢没真探、结论照旧的不给）。 */
export interface ProbedRoute {
  routeId: string;
  orgKind: OrgKind | null;
  state: RouteProbeState;
  detail: string;
}

/**
 * 当场判一次要不要切（#194，方案 4.3）：不等路由探针那一轮。by 写进日志和操作记录；read 是刚读成的接口读数（定时读接口那一轮给），
 * rejection 是刚被拒的证据（拼车会话、探针当场交来）。两样都不给就是只按库里现有的事实判一次。
 */
export interface OrgSwitchTrigger {
  by: string;
  read?: CarpoolApiRead;
  rejection?: CarpoolRejection;
}

/** 探针每一轮带着的切号（真实现 real/org-switch.ts 的 orgSwitchRound）。三步都不许抛。 */
export interface OrgSwitchRound {
  /**
   * 当场判、该切就切，切完当场探一次切过去的那个池（方案 4.3：不等下一轮探针）。真切过去了交回切到哪一类，不然 null。
   * 同一台机器同一时刻只有一个切号在跑（单飞锁）：撞上的这一次不判、交回 null，操作记录只有一条。
   */
  now(trigger: OrgSwitchTrigger): Promise<OrgKind | null>;
  /** 这一轮探之前：判、该切就切。真切过去了交回切到哪一类（这一轮探完要核对），不然 null。 */
  before(): Promise<OrgKind | null>;
  /**
   * 每一轮探完：这一轮切过号（to）就核对切过去的那个池的路由有没有探通（探通了才算切成）；没切（null）就看之前切完读回
   * 不在线的，这一轮探通了没有。
   */
  after(to: OrgKind | null, probed: readonly ProbedRoute[]): Promise<void>;
}
