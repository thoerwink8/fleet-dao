// 会话用户切号（#157，design 第九节「拼车用完，切独享接着干」）：路由探针每一轮探之前判一次要不要切，这里是纯判法和
// 探针那一轮用的接口（真装配在 real/org-switch.ts）。
// 平时挂拼车：拼车额度用满（和选路同一个判法：会话、探针被拒记成的读数，或读数到顶）就切独享；拼车用满的那几个窗口
// 清零时刻都过了，就切回拼车。只在手上没有在跑的 Claude 会话时切（切号会让这个家目录下在跑的 Claude 会话全断；在跑的活
// 原地接着干是 #59）。
// 明确失败，不当成到点了、不当成切好了：挂的是哪个认不出就不切；拼车用满了却读不到几点恢复（stuck），要人看——读数旧了也
// 不算恢复（读数旧了在选路里算「不知道」，可在这里当成恢复就会切回去、被拒、再切走，来回折腾）。
import type { OrgKind, RouteProbeState } from '@fleet-dao/shared';
import { ORG_NAMES } from '../routing/names.ts';
import type { LiveOrgReading } from '../routing/types.ts';

export interface OrgWindow {
  label: string;
  /** 和选路同一个判法（db 的 windowState）：ok、exhausted、stale、reset。 */
  state: 'ok' | 'exhausted' | 'stale' | 'reset';
  /** 读数本身说到顶了（被拒、用量到顶），不管读数旧不旧（db 的 windowFull）。 */
  full: boolean;
  resetsAt: Date | null;
}

export interface OrgPool {
  windows: OrgWindow[];
  /** 整池暂停着（pool-hold 那条要人拍还开着：登录失效、封号……）：切过去也派不了。 */
  held: boolean;
}

export interface OrgSwitchFacts {
  live: LiveOrgReading;
  /** 带组织类型的池（db 的 sessionOrgFacts）；库里没有这一类的池就不给。 */
  pools: Partial<Record<OrgKind, OrgPool>>;
  /** 带组织类型的池上还没结束的会话数。 */
  busy: number;
  now: Date;
}

export type OrgSwitchPlan =
  /** 不用切。 */
  | { action: 'stay'; why: string }
  /** 该切，手上还有 Claude 会话在跑：等下一轮。 */
  | { action: 'wait'; to: OrgKind; why: string }
  | { action: 'switch'; to: OrgKind; why: string }
  /** 明确失败，要人看：不知道什么时候该切回去。 */
  | { action: 'stuck'; why: string };

const stamp = (d: Date) => `${d.toISOString().replace('T', ' ').slice(0, 16)}（UTC）`;

export function planOrgSwitch(facts: OrgSwitchFacts): OrgSwitchPlan {
  const { live, now } = facts;
  if (!live.ok) return { action: 'stay', why: `会话用户挂的组织认不出（${live.why}），不切` };
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
      return { action: 'stay', why: `挂着独享；拼车 ${stamp(until)} 才恢复，到点再切回` };
    }
    if (carpool.held) {
      return { action: 'stay', why: '挂着独享；拼车池整池暂停着（等人处理），先不切回' };
    }
    want = {
      to: 'carpool',
      why: '挂着独享；拼车没有用满的读数（清零时刻过了，或本来就没用满），切回拼车（平时挂拼车）',
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

/** 这一轮探完的一条结论（jobs/route-probe.ts 交给 after；放慢没真探、结论照旧的不给）。 */
export interface ProbedRoute {
  routeId: string;
  orgKind: OrgKind | null;
  state: RouteProbeState;
  detail: string;
}

/** 探针每一轮带着的切号（真实现 real/org-switch.ts 的 orgSwitchRound）。两步都不许抛。 */
export interface OrgSwitchRound {
  /** 这一轮探之前：判、该切就切。真切过去了交回切到哪一类（这一轮探完要核对），不然 null。 */
  before(): Promise<OrgKind | null>;
  /**
   * 每一轮探完：这一轮切过号（to）就核对切过去的那个池的路由有没有探通（探通了才算切成）；没切（null）就看之前切完读回
   * 不在线的，这一轮探通了没有。
   */
  after(to: OrgKind | null, probed: readonly ProbedRoute[]): Promise<void>;
}
