// 三段的一次性会话（动手 runSegment、验收 coldVerify）在这个工人进程里的登记（#59）：切号（real/org-switch.ts）照它把跑在带组织
// 类型的池上的停下、等它们都收场再切；停下的那一段交回 org_switch，任务工作流切完在原分支上重跑这一段（一次性会话不续、不 fork）。
//
// 改这里之前必须知道：
// - 一段从定了路由起就登记（建树、等内存准入、起会话都算在内），收场才走：切号的「还剩哪些」要把还没起会话的也算上，不然它们在
//   切号之后才起，跑在切过去的组织上、额度记错池。
// - stop 只发信号、不等：信号一响，还没起会话的不起了（runner/one-shot.ts 记一笔 org_switch），起了的被杀；已经叫停的不重复叫停。
// - 发布排空（drain.ts，#957）也认这份登记：登记时 track 进在途清单、leave 时 settle（leave 在调用方的 finally 里，成功、失败、
//   超时、被叫停都走）；不然排空看不见它们，手上有一段在动手就提前放行、到点也停不到它。到截止由 drainStop 不分池停下，
//   这一段交回 org_switch（工作流 OS1：不算失败、不记账，在原分支上重跑）；已经在排空时再登记的，信号一开始就是响的、不起会话。
// - 只管这个工人进程里起的：一次性会话不脱开引擎跑，上一轮工人留下的 runs 行起来时已经收掉了（sessions.ts 的 reapOrphanSessions）。

import { type EngineDrain, stoppingNote } from '../drain.ts';
import type { OrgSwitchSessions } from './org-switch.ts';

/** 一段的登记：拿着它跑完这一段，收场时 leave。 */
export interface OneShotTicket {
  /** 切号、发布排空叫停时响（reason 是一个 Error，message 写为什么停）。交给 runOneShot 的 stop。 */
  readonly signal: AbortSignal;
  /** 这一段现在跑的是哪一次（runs 的编号）：切号的操作记录写停了哪几个，发布排空的在途清单也按它认。 */
  attempt(runId: string): void;
  /** 会话进程马上要起了（交给 Spawner 之前调）：发布排空的在途清单从「在起」改成「在跑」。 */
  running(): void;
  /** 收场（成没成都要调，调几次都行）：发布排空的在途清单同时撤掉。 */
  leave(): void;
}

export interface OneShotSessions extends OrgSwitchSessions {
  /** 定了路由就登记：这一段跑在哪个账号池上、是哪一阶段（stage）哪张单（taskId）的；发布排空的在途清单也记这一条。 */
  enter(entry: { poolId: string; stage: string; taskId: string }): OneShotTicket;
  /** 发布排空到截止（或收到停机信号）：不分池，没叫停过的全停下，交回这一次叫停的；这一段交回 org_switch，新引擎起来重跑。 */
  drainStop(why: string): string[];
}

interface Entry {
  poolId: string;
  stage: string;
  taskId: string;
  since: string;
  phase: 'starting' | 'running';
  ac: AbortController;
  runId: string | undefined;
}

export interface OneShotSessionsOptions {
  /**
   * 发布排空的在途清单（drain.ts）：登记就 track、收场就 settle。不给 = 发布排空看不见这些会话（只有测试里可以不给；
   * 生产装配在 real/index.ts 里必须给，#957：不给就会提前放行、把正在动手的单打断）。
   */
  drain?: EngineDrain;
  now?: () => Date;
}

export function oneShotSessions(options: OneShotSessionsOptions = {}): OneShotSessions {
  const { drain } = options;
  const now = options.now ?? (() => new Date());
  const entries = new Map<number, Entry>();
  let seq = 0;
  // 还没起会话（没有 runs 编号）的用登记号，操作记录里也认得出是哪一段
  const idOf = (key: number, e: Entry) => e.runId ?? `one-shot-${key}`;
  const track = (id: string, e: Entry) =>
    drain?.track({ runId: id, stage: e.stage, taskId: e.taskId, phase: e.phase, since: e.since });
  return {
    enter({ poolId, stage, taskId }) {
      seq += 1;
      const key = seq;
      const entry: Entry = {
        poolId,
        stage,
        taskId,
        since: now().toISOString(),
        phase: 'starting',
        ac: new AbortController(),
        runId: undefined,
      };
      entries.set(key, entry);
      // 起会话的闸（和 session-launch.ts 的 startSession 同一个意思）：已经在排空，这一段不起——信号一开始就是响的，
      // runOneShot 当场回 org_switch（一行 runs 记账、没起进程），工作流回去选路、选路回「过一会儿再选」，新引擎起来再派
      const stopping = drain?.stopping();
      if (stopping) entry.ac.abort(new Error(`${stoppingNote(stopping)}；这一段没起会话`));
      track(idOf(key, entry), entry);
      return {
        signal: entry.ac.signal,
        attempt(runId) {
          if (!entries.has(key)) return;
          const before = idOf(key, entry);
          entry.runId = runId;
          if (before !== runId) {
            drain?.settle(before);
            track(runId, entry);
          }
        },
        running() {
          if (!entries.has(key)) return;
          entry.phase = 'running';
          track(idOf(key, entry), entry);
        },
        leave() {
          const e = entries.get(key);
          if (!e) return;
          entries.delete(key);
          drain?.settle(idOf(key, e));
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
    drainStop(why) {
      const stopped: string[] = [];
      for (const [key, e] of entries) {
        if (e.ac.signal.aborted) continue;
        e.ac.abort(new Error(`发布排空：${why}，这一段停下，新引擎起来重跑`));
        stopped.push(idOf(key, e));
      }
      return stopped;
    },
    live(poolIds) {
      return [...entries].filter(([, e]) => poolIds.has(e.poolId)).map(([key, e]) => idOf(key, e));
    },
  };
}
