// 三段的一次性会话（动手 runSegment、验收 coldVerify）在这个工人进程里的登记（#59）：切号（real/org-switch.ts）照它把跑在带组织
// 类型的池上的停下、等它们都收场再切；停下的那一段交回 org_switch，任务工作流切完在原分支上重跑这一段（一次性会话不续、不 fork）。
//
// 改这里之前必须知道：
// - 一段从定了路由起就登记（建树、等内存准入、起会话都算在内），收场才走：切号的「还剩哪些」要把还没起会话的也算上，不然它们在
//   切号之后才起，跑在切过去的组织上、额度记错池。
// - stop 只发信号、不等：信号一响，还没起会话的不起了（runner/one-shot.ts 记一笔 org_switch），起了的被杀；已经叫停的不重复叫停。
// - 只管这个工人进程里起的：一次性会话不脱开引擎跑，上一轮工人留下的 runs 行起来时已经收掉了（sessions.ts 的 reapOrphanSessions）。

import type { OrgSwitchSessions } from './org-switch.ts';

/** 一段的登记：拿着它跑完这一段，收场时 leave。 */
export interface OneShotTicket {
  /** 切号叫停时响（reason 是一个 Error，message 写为什么停）。交给 runOneShot 的 stop。 */
  readonly signal: AbortSignal;
  /** 这一段现在跑的是哪一次（runs 的编号）：切号的操作记录写停了哪几个。 */
  attempt(runId: string): void;
  /** 收场（成没成都要调，调几次都行）。 */
  leave(): void;
}

export interface OneShotSessions extends OrgSwitchSessions {
  /** 定了路由就登记：这一段跑在哪个账号池上。 */
  enter(entry: { poolId: string }): OneShotTicket;
}

interface Entry {
  poolId: string;
  ac: AbortController;
  runId: string | undefined;
}

export function oneShotSessions(): OneShotSessions {
  const entries = new Map<number, Entry>();
  let seq = 0;
  // 还没起会话（没有 runs 编号）的用登记号，操作记录里也认得出是哪一段
  const idOf = (key: number, e: Entry) => e.runId ?? `one-shot-${key}`;
  return {
    enter({ poolId }) {
      seq += 1;
      const key = seq;
      const entry: Entry = { poolId, ac: new AbortController(), runId: undefined };
      entries.set(key, entry);
      return {
        signal: entry.ac.signal,
        attempt(runId) {
          entry.runId = runId;
        },
        leave() {
          entries.delete(key);
        },
      };
    },
    stop(poolIds, why) {
      const stopped: string[] = [];
      for (const [key, e] of entries) {
        if (!poolIds.has(e.poolId) || e.ac.signal.aborted) continue;
        e.ac.abort(new Error(why));
        stopped.push(idOf(key, e));
      }
      return stopped;
    },
    live(poolIds) {
      return [...entries].filter(([, e]) => poolIds.has(e.poolId)).map(([key, e]) => idOf(key, e));
    },
  };
}
