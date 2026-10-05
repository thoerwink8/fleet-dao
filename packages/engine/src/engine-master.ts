// 引擎总开关的闸（#1086，设置 engine.master；形状和读法在 @fleet-dao/shared 的 engine-switch.ts）。
// 关着 = 不拉单、不派活、不起任何「干活」的模型会话；探针、路由探针、读额度、看门狗、对账这些看家检查照跑（创始人 2026-10-05
// 约 22:40：关着也要能看到渠道通不通）。开着 = 引擎接活，再由按项目的「让 AI 接活」（repos.auto_dispatch_since）细分哪些项目派。
// 改这里之前必须知道：
// - 闸只有三个入口读它，不在每个任务里各加一个 if：定时器入口（jobs/timers.ts，标了 needsMaster 的任务：拉单、巡检）、
//   选路（real/store-ports.ts 的 pickRoute：任务工作流要起会话先选路）、一次性会话登记（real/one-shot-sessions.ts 的 enter：
//   动手、验收）。探针自己起的最小会话不经这三处，所以关着照跑。
// - 读的是内存里的缓存，不是每次现读库：isOn() 同步（enter 是同步的）。缓存由 refresh() 刷新，起来时先刷新一次、之后每
//   REFRESH_MS 一次，定时器入口每次现刷新一次（拉单不晚于关开关那一刻）。
// - 没读过、读不到、值认不出，一律按关（isOn()=false）：不拿「读不到」当开。读不到只记一次日志，恢复了再记一次。
// - 只管「不起新的」：关的时候已经在跑的会话做完这一步（和发布排空同一个口径，drain.ts），不被腰斩；它们做完回工作流再选路，
//   选路回「过一会儿再选」，不再起下一段。

import { type EngineMasterState, engineMasterOf, type MasterSettingRow } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

/** 多久刷新一次缓存（和发布排空的请求同一个节奏）。 */
export const MASTER_REFRESH_MS = 5_000;
/** 选路被总开关挡住时，隔多久再选：开了以后下一次就选得到。 */
export const MASTER_ROUTE_RETRY_SECONDS = 30;

export interface EngineMasterGate {
  /** 总开关此刻开着吗（读缓存，同步）：没读过、读不到都是关。 */
  isOn(): boolean;
  /** 此刻的状态（给日志、拒绝时的话用）。 */
  state(): EngineMasterState | { on: false; why: 'unread'; error?: string | undefined };
  /** 现读一次库刷新缓存；不抛，读不到按关算并记日志。返回刷新后的 isOn()。 */
  refresh(): Promise<boolean>;
  /** 每 pollMs 刷新一次；返回停下的办法。 */
  start(pollMs?: number): () => void;
}

/** 选路、起会话被总开关挡住时给人看的一句（驾驶舱「在等什么」、失败原因里都是这一句）。 */
export function masterOffNote(state: ReturnType<EngineMasterGate['state']>): string {
  // 开着时不该问「为什么关」：调用方都是 !isOn() 之后才问；万一被问到也给一句不骗人的话
  if (state.on) return '总开关开着';
  const why =
    state.why === 'unread'
      ? `总开关还没读到${state.error ? `（${state.error}）` : ''}，按关算`
      : state.why === 'unreadable'
        ? '总开关的设置认不出，按关算'
        : state.why === 'never_set'
          ? '总开关从没打开过（默认关）'
          : '总开关关着';
  return `${why}：引擎不拉单、不派活、不起干活的会话，到驾驶舱环境页点开关后接着派`;
}

export function createEngineMasterGate(deps: {
  /** 读设置表 engine.master 那一行（real 里是 @fleet-dao/db 的 readEngineMasterRow）；没设过回 null；库读不了抛。 */
  read(): Promise<MasterSettingRow | null>;
  log(message: string): void;
}): EngineMasterGate {
  let current: ReturnType<EngineMasterGate['state']> = { on: false, why: 'unread' };
  let lastReported = '';
  const report = (text: string) => {
    if (text === lastReported) return;
    lastReported = text;
    deps.log(text);
  };
  let refreshing: Promise<boolean> | null = null;

  async function once(): Promise<boolean> {
    try {
      current = engineMasterOf(await deps.read());
      report(
        current.on
          ? '引擎总开关：开着，接活（只有「让 AI 接活」开着的项目才派）'
          : `引擎总开关：关着（${masterOffNote(current)}）`,
      );
    } catch (err) {
      current = { on: false, why: 'unread', error: errMessage(err) };
      report(`引擎总开关：读不到，按关算（${errMessage(err)}）`);
    }
    return current.on;
  }

  // 同一时刻只读一次：上一次还没读完（库慢）就等它
  const refresh = (): Promise<boolean> => {
    refreshing ??= once().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  return {
    isOn: () => current.on,
    state: () => current,
    refresh,
    start(pollMs = MASTER_REFRESH_MS) {
      const timer = setInterval(() => void refresh(), pollMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** 测试和假端口用：固定开或固定关，不读库。 */
export function fixedEngineMaster(on: boolean): EngineMasterGate {
  const state: ReturnType<EngineMasterGate['state']> = on ? { on: true } : { on: false, why: 'never_set' };
  return {
    isOn: () => on,
    state: () => state,
    refresh: async () => on,
    start: () => () => {},
  };
}
