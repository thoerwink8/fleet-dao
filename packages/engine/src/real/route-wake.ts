// 叫醒等路由的活（#194 方案 4.3）：切号切完、切过去的池探通以后，给所有在跑的任务工作流发 taskRouteWake 信号，
// 让正在「等路由」的那几张单当场重新选一次，不睡满 MAX_ROUTE_WAIT_SECONDS（real/store-ports.ts）。
//
// 改这里之前必须知道：
// - 叫醒只是加速，不是正确性所在：信号丢了、没发出去，等路由的活照样最多再等 MAX_ROUTE_WAIT_SECONDS 就醒；所以这里绝不抛错、
//   不挡切号（切号流程在 real/org-switch.ts 的 probeNow 之后调它，抛错会把「切成了」报成出错）。
// - 三种结局分得清，不混：收信人不在（没有这个编号、已经结束）是正常的、直接略过、不报；发成功了；收信失败（连不上、超时、别的错）
//   和列不出在跑的工作流都要报警（`route-wake:signal`），全部成功了再撤。报警自己写不进去也不静默：记 error 日志并回在结果里。
// - 给每个在跑的任务工作流都发，不先查谁在等：不在等路由的那几张收到只是记个数，下一次等路由取新记号，不会被旧信号叫醒；
//   在两次「问选路」之间、正在问的那张靠「问之前取记号」不丢（workflows/task-runtime.ts 的 pauseForRoute）。

import { type Db, resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';
import type { OrgKind } from '@fleet-dao/shared';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { WORKFLOW_TYPES } from '../contract.ts';
import type { OrgSwitchRound, ProbedRoute } from '../jobs/org-switch.ts';
import { type RouteWakeCommand, taskRouteWakeSignal } from '../task-contract.ts';

export const ROUTE_WAKE_ALERT_KEY = 'route-wake:signal';
export const ROUTE_WAKE_ACTOR = 'engine:route-wake';
/** 给一个工作流发一次信号最多等多久（连接的 deadline，到点由连接取消调用，不是本地空等）。 */
export const ROUTE_WAKE_SIGNAL_TIMEOUT_MS = 5_000;

/** 叫醒要的两个动作；真实现见 temporalWakeClient。signal 回 'gone' 表示收信人不在（正常）；别的错照抛。 */
export interface RouteWakeClient {
  /** 在跑的任务工作流的编号。列不出来照抛。 */
  runningTaskWorkflowIds(): Promise<string[]>;
  signal(workflowId: string, command: RouteWakeCommand): Promise<'sent' | 'gone'>;
}

export interface RouteWakeResult {
  /** 在跑的任务工作流有几个（列出来的）。 */
  total: number;
  sent: number;
  /** 收信人不在了（列出来之后到发信号之前结束的）：正常，不报。 */
  gone: number;
  /** 收信失败的：编号和原因。有就报警。 */
  failed: { workflowId: string; error: string }[];
  /** 列不出在跑的工作流：整次没叫醒。有就报警。 */
  listError?: string;
  /** 报警自己写不进库：结果里带上（日志也记过 error），不吞。 */
  alertError?: string;
}

export interface RouteWaker {
  /** 叫醒所有在跑的任务工作流。不抛错。 */
  wake(reason: string): Promise<RouteWakeResult>;
}

export interface RouteWakerDeps {
  client: RouteWakeClient;
  /** 报：没有就建、开着的原地改。 */
  raise(input: { key: string; title: string; body: string }): Promise<void>;
  /** 撤：全部发成功了再撤，没有开着的也不算错。 */
  resolve(key: string, why: string): Promise<void>;
  by?: string;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 错误文字连原因一起写（Temporal 客户端把真原因包在 cause 里，只写外层是一句「Failed to signal Workflow」）。 */
function message(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 4; depth++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join('；原因：');
}

export function routeWaker(deps: RouteWakerDeps): RouteWaker {
  const log = deps.log ?? (() => {});
  const by = deps.by ?? '切号';

  async function settle(result: RouteWakeResult): Promise<RouteWakeResult> {
    const problem =
      result.listError !== undefined
        ? `列不出在跑的任务工作流（${result.listError}）`
        : result.failed.length > 0
          ? `${result.failed.length} 个任务工作流没收到叫醒：${result.failed
              .slice(0, 3)
              .map((f) => `${f.workflowId}（${f.error}）`)
              .join('、')}`
          : null;
    try {
      if (problem === null) await deps.resolve(ROUTE_WAKE_ALERT_KEY, '这一次叫醒全部发出去了');
      else
        await deps.raise({
          key: ROUTE_WAKE_ALERT_KEY,
          title: '叫醒等路由的活没发成',
          body: `${problem}。等路由的活不会丢（最多再等一个选路间隔就自己醒），只是没当场重新选；连不上 Temporal 或信号超时的话先看引擎和 Temporal 是否正常。`,
        });
    } catch (err) {
      log('error', '叫醒等路由的活：报警/撤警没写进库', { error: message(err), problem });
      return { ...result, alertError: message(err) };
    }
    return result;
  }

  return {
    async wake(reason) {
      const command: RouteWakeCommand = { by, reason };
      let ids: string[];
      try {
        ids = await deps.client.runningTaskWorkflowIds();
      } catch (err) {
        log('error', '叫醒等路由的活：列不出在跑的任务工作流', { error: message(err) });
        return settle({ total: 0, sent: 0, gone: 0, failed: [], listError: message(err) });
      }
      // 同时发：一个慢不拖别的（每个自带 deadline）
      const outcomes = await Promise.allSettled(ids.map((id) => deps.client.signal(id, command)));
      const result: RouteWakeResult = { total: ids.length, sent: 0, gone: 0, failed: [] };
      outcomes.forEach((o, i) => {
        const workflowId = ids[i] as string;
        if (o.status === 'fulfilled') {
          if (o.value === 'sent') result.sent += 1;
          else result.gone += 1;
        } else {
          result.failed.push({ workflowId, error: message(o.reason) });
        }
      });
      if (result.failed.length > 0) {
        log('error', '叫醒等路由的活：有任务工作流没收到信号', {
          failed: result.failed.length,
          first: result.failed[0],
        });
      } else {
        log('info', '叫醒等路由的活', { reason, total: result.total, sent: result.sent, gone: result.gone });
      }
      return settle(result);
    },
  };
}

const KIND_NAMES: Readonly<Record<OrgKind, string>> = { carpool: '拼车', solo: '独享' };

/**
 * 当场切号那条路（org-switch 的 probeNow）：切完探一次切过去的池，探完叫醒。探这一步抛了就是没切成、不叫醒，错照抛给切号去记；
 * 探没通也叫醒：重选选不到会回去接着等（pauseForRoute 取新记号），不空转。
 */
export function wakeAfterProbeNow(
  probeNow: (to: OrgKind) => Promise<ProbedRoute[]>,
  waker: RouteWaker,
): (to: OrgKind) => Promise<ProbedRoute[]> {
  return async (to) => {
    const probed = await probeNow(to);
    await waker.wake(`切到${KIND_NAMES[to]}并探过`);
    return probed;
  };
}

/**
 * 探针那一轮里切的号（orgSwitch.before 切了、这一轮探完 after 核对）：核对完叫醒；这一轮没切（to 为 null）不叫。
 * 核对（after）抛了照抛、不叫醒。
 */
export function wakeAfterProbeRound(round: OrgSwitchRound, waker: RouteWaker): OrgSwitchRound {
  return {
    now: (trigger) => round.now(trigger),
    before: () => round.before(),
    after: async (to, probed) => {
      await round.after(to, probed);
      if (to !== null) await waker.wake(`探针那一轮切到${KIND_NAMES[to]}并探过`);
    },
  };
}

/** 工作流不在（没有这个编号，或已经结束）：客户端抛 WorkflowNotFoundError；服务端 NOT_FOUND 的另一种文案也认。 */
export function isWorkflowGone(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    if (
      e instanceof WorkflowNotFoundError ||
      e.name === 'WorkflowNotFoundError' ||
      /workflow execution already completed/i.test(e.message)
    )
      return true;
  }
  return false;
}

/** 真客户端：对着一个 Temporal 客户端（测试可传测试服务端的 client）。 */
export function temporalWakeClient(
  client: Pick<Client, 'workflow' | 'connection'>,
  timeoutMs = ROUTE_WAKE_SIGNAL_TIMEOUT_MS,
): RouteWakeClient {
  return {
    async runningTaskWorkflowIds() {
      const ids: string[] = [];
      for await (const info of client.workflow.list({
        query: `WorkflowType = '${WORKFLOW_TYPES.task}' AND ExecutionStatus = 'Running'`,
      })) {
        ids.push(info.workflowId);
      }
      return ids;
    },
    async signal(workflowId, command) {
      try {
        await client.connection.withDeadline(Date.now() + timeoutMs, () =>
          client.workflow.getHandle(workflowId).signal(taskRouteWakeSignal, command),
        );
        return 'sent';
      } catch (err) {
        if (isWorkflowGone(err)) return 'gone';
        throw err;
      }
    },
  };
}

/**
 * 引擎进程里用的：第一次叫醒时才连 Temporal（切号、被拒证据这些路径在 Temporal 活动之外，手上没有客户端）；连不上这一次抛错
 * （由 routeWaker 报警），不缓存失败，下一次再连。
 */
export function lazyTemporalWakeClient(opts: {
  address: string;
  namespace: string;
  timeoutMs?: number;
}): RouteWakeClient & { close(): Promise<void> } {
  let connecting: Promise<{ connection: Connection; wake: RouteWakeClient }> | undefined;
  const get = () => {
    connecting ??= Connection.connect({ address: opts.address }).then(
      (connection) => ({
        connection,
        wake: temporalWakeClient(new Client({ connection, namespace: opts.namespace }), opts.timeoutMs),
      }),
      (err: unknown) => {
        connecting = undefined;
        throw err;
      },
    );
    return connecting;
  };
  return {
    runningTaskWorkflowIds: async () => (await get()).wake.runningTaskWorkflowIds(),
    signal: async (workflowId, command) => (await get()).wake.signal(workflowId, command),
    close: async () => {
      const c = connecting;
      connecting = undefined;
      if (c) await (await c).connection.close();
    },
  };
}

/** 引擎的装配：报警走 upsertAlert、撤警走 resolveAlertWithReason（和切号的提醒同一个做法）。 */
export function routeWakerFromDb(db: Db, client: RouteWakeClient, log?: RouteWakerDeps['log']): RouteWaker {
  return routeWaker({
    client,
    raise: async (a) => {
      await upsertAlert(db, { dedupeKey: a.key, level: 'alert', taskId: null, title: a.title, body: a.body });
    },
    resolve: async (key, why) => {
      await resolveAlertWithReason(db, { dedupeKey: key, by: ROUTE_WAKE_ACTOR, why });
    },
    ...(log ? { log } : {}),
  });
}
