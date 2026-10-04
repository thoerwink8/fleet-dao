// 假实现：不碰真仓、真会话、真 GitHub，用来把流程跑通（测试、联调）。行为可以按剧本改。
// #556-2：Fusion 的会话、提问、批准、验证记录、流程配置这些假端口跟着真端口一起删了；留的是任务工作流（#632）和
// 定时任务测试要的几个端口。

import type { CiResult, SyncResult } from './decisions/types.ts';
import type { PickRouteInput, PickRouteResult } from './ports.ts';
import {
  type EnginePorts,
  type OpenPrInput,
  type PortContext,
  PortError,
  type PortName,
  type PushBranchInput,
  type RaiseAlertInput,
  type RouteChoice,
  type Scope,
  type SyncMainlineInput,
  type TaskStateSnapshot,
  type TimingEntry,
  type WaitCiInput,
} from './ports.ts';

export interface FakeScript {
  /** 写这张单的会话用过的族：不给就是 claude 一族；给了 PortError 就抛它；n = 第几次问。 */
  authors: (input: Scope, n: number) => string[] | PortError | undefined;
  ci: (input: WaitCiInput, n: number) => Partial<CiResult> | undefined;
  sync: (input: SyncMainlineInput, n: number) => Partial<SyncResult> | undefined;
  /** 推分支：给了就抛它（假的卫生检查拦下、没扫成……）；n = 第几次推（从 1 开始）。 */
  push: (input: PushBranchInput, n: number) => PortError | undefined;
  /**
   * 推上去的头相对主线的净改动（推分支交回的 changedFiles）；n 同 push。不给就不交：老版端口的样子，工作流照会话交的
   * 累计算。
   */
  pushed: (input: PushBranchInput, n: number) => string[] | undefined;
  /** 开 PR：给了就抛它（假的卫生检查拦下标题或正文……）；n = 第几次开（从 1 开始）。 */
  openPr: (input: OpenPrInput, n: number) => PortError | undefined;
  route: (input: PickRouteInput, n: number) => PickRouteResult | undefined;
  /** 前 N 次调用抛可重试的 TRANSIENT。 */
  failFirst: Partial<Record<PortName, number>>;
  /** 前 N 次调用做完了再抛可重试的 TRANSIENT（事办成了、回话丢了：重试时考的是幂等）。 */
  failAfter: Partial<Record<PortName, number>>;
  /** 每次调用先等这么久（测串行、并发用）。 */
  delayMs: Partial<Record<PortName, number>>;
  /** 这几个端口的调用挂着不返回，直到 releasePort（要控制先后时用它，别赌延时够不够长）。 */
  holdPorts: PortName[];
  heartbeatMs: number;
  routes: RouteChoice[];
}

export interface FakeCall {
  port: PortName;
  input: unknown;
  attempt: number;
  at: number;
  end: number | null;
  ok: boolean | null;
}

export interface FakeWorld {
  ports: EnginePorts;
  calls: FakeCall[];
  timings: TimingEntry[];
  /** 写进「库」的任务状态，按写入顺序。 */
  states: TaskStateSnapshot[];
  /** 报过的警（按调用顺序，含重复的 dedupeKey）。 */
  alerts: RaiseAlertInput[];
  callsOf<P extends PortName>(port: P): (FakeCall & { input: Parameters<EnginePorts[P]>[0] })[];
  count(port: PortName): number;
  /** 放行 holdPorts 挂着的那个端口（挂着的和以后的调用都不再挂）。 */
  releasePort(port: PortName): void;
  /**
   * 等到 check 成立：假世界每变一下（端口调用开始、结束）当场重查，不按钟点轮询。check 只能看假
   * 东西（调用、写进库的状态……），要看 Temporal 查询结果的用 test/support.ts 的 queryUntil。
   * timeoutMs 内没等到就报错、写明在等什么，不无限挂着；check 抛错原样报出来。
   */
  until(check: () => boolean, what: string, timeoutMs?: number): Promise<void>;
}

export const FAKE_ROUTES: readonly RouteChoice[] = [
  { routeId: 'r1', poolId: 'p1', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
  { routeId: 'r2', poolId: 'p2', modelId: 'm1', family: 'claude', hostId: 'claude-code' },
  { routeId: 'r3', poolId: 'p3', modelId: 'm2', family: 'kimi', hostId: 'api-shell' },
];

/** 假的提交号：40 位（验证、方案交回的都要完整提交号），末尾是序号。 */
export function fakeHead(n: number): string {
  return `${n}`.padStart(40, 'f');
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function createFakeWorld(script: Partial<FakeScript> = {}): FakeWorld {
  const calls: FakeCall[] = [];
  const timings: TimingEntry[] = [];
  const states: TaskStateSnapshot[] = [];
  const alerts: RaiseAlertInput[] = [];
  const heldPorts = new Set<PortName>(script.holdPorts ?? []);
  const counters = new Map<string, number>();
  const prByBranch = new Map<string, number>();
  const heartbeatMs = script.heartbeatMs ?? 50;
  const routes = script.routes ?? [...FAKE_ROUTES];
  const next = (key: string) => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return n;
  };
  /** until 挂着的等待：假世界每变一下都叫一遍，各自重查自己的条件。 */
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const probe of [...waiters]) probe();
  };

  const impl: EnginePorts = {
    async pickRoute(input) {
      const scripted = script.route?.(input, next('pickRoute'));
      if (scripted) return scripted;
      // 整族避开（开 PR 前验证只派别家）：点名的、续会话的也照样避开，和真选路一样。给验证留一家时副手先避开的族
      // （keepVerifier.spare）这里也一律避开：假世界不排验证那一步的路由，判不了别家会不会让验证没人可派——和真选路
      // 没有候选会让验证落空时一样（给验证留一家的真判法测在 test/routing/verifier.test.ts、test/real/store-ports.test.ts）
      const families = new Set(
        [...(input.avoidFamilies ?? []), ...(input.keepVerifier?.spare ?? [])].map((f) =>
          f.trim().toLowerCase(),
        ),
      );
      // 流程配置的模型顺序：只派这几个模型的路由，按这个先后（和真选路一样）
      const models = input.models;
      const usable = routes
        .filter(
          (r) =>
            !input.avoidRouteIds.includes(r.routeId) &&
            !input.avoidPoolIds.includes(r.poolId) &&
            !input.avoidModelIds.includes(r.modelId) &&
            !families.has(r.family.toLowerCase()) &&
            (!models || models.includes(r.modelId)),
        )
        .sort((a, b) => (models ? models.indexOf(a.modelId) - models.indexOf(b.modelId) : 0));
      const preferred = input.preferRouteId
        ? usable.find((r) => r.routeId === input.preferRouteId)
        : undefined;
      // 续同一个会话：还是那一条（和真选路一样，避开的照样不派）。
      const stuck = input.stickRouteId ? usable.find((r) => r.routeId === input.stickRouteId) : undefined;
      const route = preferred ?? stuck ?? usable[0];
      if (!route) {
        return {
          ok: false,
          waitFor: 'none',
          detail:
            families.size > 0
              ? `没有别家可验：写这张单的是 ${[...families].join('、')} 族，这一步只派别家，不拿同族顶`
              : models
                ? `流程配置里这一步的模型（${models.join('、') || '一个都没配'}）没有能派的路由`
                : '能用的路由都被避开了',
        };
      }
      return {
        ok: true,
        route,
        why: preferred ? '点名的路由' : stuck ? '续同一个会话' : '排第一的可用路由',
      };
    },
    async createWorktree(input) {
      return {
        path: `/fake/worktrees/${input.taskId}/${input.subtaskKey ?? 'main'}`,
        branch: input.branch,
        baseSha: 'base',
      };
    },
    async removeWorktree(input) {
      return {
        removed: true,
        gone: false,
        ...(input.archive
          ? { archivedTo: `/fake/archive/${input.taskId}/${input.subtaskKey ?? 'main'}` }
          : {}),
      };
    },
    async pushBranch(input) {
      const n = next('pushBranch');
      const refused = script.push?.(input, n);
      if (refused) throw refused;
      const changedFiles = script.pushed?.(input, n);
      return { head: input.head, ...(changedFiles ? { changedFiles } : {}) };
    },
    async openPr(input) {
      const refused = script.openPr?.(input, next('openPr'));
      if (refused) throw refused;
      let pr = prByBranch.get(input.branch);
      if (pr === undefined) {
        pr = 100 + prByBranch.size;
        prByBranch.set(input.branch, pr);
      }
      return { prNumber: pr };
    },
    async waitCi(input) {
      return { state: 'green', head: input.head, failedChecks: [], ...script.ci?.(input, next('waitCi')) };
    },
    async syncMainline(input) {
      return {
        state: 'clean',
        head: input.head,
        conflictFiles: [],
        ...script.sync?.(input, next('syncMainline')),
      };
    },
    async saveTaskState(input) {
      states.push(input);
    },
    async closeIssue() {},
    async authorFamilies(input) {
      const scripted = script.authors?.(input, next('authorFamilies'));
      if (scripted instanceof PortError) throw scripted;
      return { families: scripted ?? ['claude'] };
    },
    async raiseAlert(input) {
      alerts.push(input);
      return { alertId: `alert-${next('alert')}` };
    },
    async recordTiming(input) {
      timings.push(input);
    },
  };

  const ports = {} as Record<PortName, (input: unknown, ctx: PortContext) => Promise<unknown>>;
  for (const name of Object.keys(impl) as PortName[]) {
    const fn = impl[name] as (input: unknown, ctx: PortContext) => Promise<unknown>;
    ports[name] = async (input, ctx) => {
      const call: FakeCall = { port: name, input, attempt: ctx.attempt, at: Date.now(), end: null, ok: null };
      calls.push(call);
      changed();
      try {
        while (heldPorts.has(name) && !ctx.signal.aborted) await pause(heartbeatMs, ctx.signal);
        const delay = script.delayMs?.[name] ?? 0;
        if (delay > 0) await pause(delay, ctx.signal);
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('取消');
        const failures = script.failFirst?.[name] ?? 0;
        if (failures > 0 && calls.filter((c) => c.port === name).length <= failures) {
          throw new PortError('TRANSIENT', `${name} 假失败`, { retryable: true });
        }
        const out = await fn(input, ctx);
        const lostReplies = script.failAfter?.[name] ?? 0;
        if (lostReplies > 0 && calls.filter((c) => c.port === name).length <= lostReplies) {
          throw new PortError('TRANSIENT', `${name} 做完了、回话丢了（假）`, { retryable: true });
        }
        call.ok = true;
        return out;
      } catch (error) {
        call.ok = false;
        throw error;
      } finally {
        call.end = Date.now();
        changed();
      }
    };
  }

  return {
    ports: ports as unknown as EnginePorts,
    calls,
    timings,
    states,
    alerts,
    callsOf: (<P extends PortName>(port: P) => calls.filter((c) => c.port === port)) as FakeWorld['callsOf'],
    count: (port) => calls.filter((c) => c.port === port).length,
    releasePort(port) {
      heldPorts.delete(port);
      changed();
    },
    until(check, what, timeoutMs = 20_000) {
      return new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown) => {
          waiters.delete(probe);
          clearTimeout(timer);
          if (error === undefined) resolve();
          else reject(error);
        };
        const probe = () => {
          try {
            if (check()) settle();
          } catch (error) {
            settle(error ?? new Error(`查「${what}」时出错`));
          }
        };
        const timer = setTimeout(
          () => settle(new Error(`等了 ${timeoutMs} 毫秒还没等到：${what}`)),
          timeoutMs,
        );
        waiters.add(probe);
        probe();
      });
    },
  };
}
