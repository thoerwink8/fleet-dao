// 新内核进程（#3811）：一个进程里起接口层（只听回环、影子模式）、派工器，再按节拍跑影子驱动、评分、静默报警。
// 影子模式下 outbox 不装任何真实处理器（自检据此判），新内核对外零写；GitHub 只读由部署传进来的读取器做。
// 每一步出错只记 onError，不让一步的毛病挡住别的步，也不让进程退出。
import { createHarnessApi, type HarnessApi } from '@fleet-dao/harness-api';
import type { TaskRef } from '@fleet-dao/harness-contract';
import type { Redactor } from '@fleet-dao/harness-runner';
import {
  activeBatches,
  activeRealBatches,
  type BatchItem,
  type Db,
  type MergedReader,
  type ShadowSilence,
  shadowSilence,
  sweepCompare,
} from '@fleet-dao/harness-store';
import type { ShadowProbes } from '@fleet-dao/harness-workers';
import { Dispatcher, type DispatcherOptions } from './dispatcher.ts';
import {
  PUBLISH_KINDS,
  type PublishCollected,
  type PublishDeps,
  processOutbox,
  recordPublish,
} from './publish.ts';
import { enqueueRealBatch } from './real-driver.ts';
import { enqueueShadowBatch } from './shadow-driver.ts';
import { realShadowProbes } from './shadow-probes.ts';
import { shadowWorkspaces } from './shadow-workspace.ts';
import type { AcquireResult } from './task-claim.ts';

type Six = Parameters<typeof enqueueShadowBatch>[2] extends (item: BatchItem) => Promise<infer T> ? T : never;

export interface KernelOptions {
  db: Db;
  redact: Redactor;
  /** 接口层听的口；只听 127.0.0.1。 */
  apiPort: number;
  /** 派工器的其余选项（执行体、模型、权限、预算……）。 */
  dispatcher: Omit<DispatcherOptions, 'db' | 'mcpUrl' | 'prepareWorkspace' | 'shadow' | 'onError'>;
  mirrorRoot: string;
  workRoot: string;
  /** 工人的 HOME（和会话用户同一个），影子自检看它里面有没有推送凭据。 */
  workerHome: string;
  egressPort: number;
  /** 把一张单变成六项指示（读单的快照，只读 GitHub）。 */
  taskFor(item: BatchItem): Promise<Six>;
  readMerged: MergedReader;
  onSilence(batchId: string, s: Extract<ShadowSilence, { kind: 'silent' }>): void;
  onError(step: string, err: unknown): void;
  /** 每个节拍跑完给一份报告（真执行的认领跳过、outbox 条数靠它进日志）。 */
  onTick?(report: TickReport): void;
  tickMs?: number;
  /** 只有测试换它；生产用 realShadowProbes。 */
  probes?: ShadowProbes;
  /**
   * 真执行（#3783，第 7 片）：给了才开。对冻结的真执行批次认领单、派工，工人交回后经 outbox 推分支、开 PR（不合并）。
   * 不给就是纯影子：outbox 一个处理器都不装，自检据此判。
   */
  publish?: {
    /** 在旧库认领这张单（task-claim.ts 的 acquireTask 绑上库）。 */
    acquire(ref: TaskRef, title: string): Promise<AcquireResult>;
    /** 工人用的模型（记进 PR 正文和产物）。 */
    model: string;
    /** 旧系统手上有的单歇多久再认领，默认 5 分钟（测试给 0）。 */
    heldPauseMs?: number;
    outbox: Omit<PublishDeps, 'db' | 'mirrorRoot' | 'tmpRoot' | 'redact' | 'onError'>;
  };
}

export interface TickReport {
  batches: number;
  requested: number;
  claimed: number;
  scored: number;
  silent: string[];
  /** 只在开了真执行时有。 */
  real?: {
    batches: number;
    requested: number;
    skipped: { repo: string; issue: number; why: string }[];
    outbox: Awaited<ReturnType<typeof processOutbox>> | null;
  };
}

export function createKernel(o: KernelOptions) {
  let api: HarnessApi | undefined;
  let dispatcher: Dispatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<TickReport> | undefined;
  const cursors = new Map<string, number>();
  const heldUntil = new Map<string, number>();

  const guard = async <T>(step: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      o.onError(step, err);
      return fallback;
    }
  };

  async function tick(): Promise<TickReport> {
    const d = dispatcher;
    if (!d) throw new Error('内核还没起');
    const report: TickReport = { batches: 0, requested: 0, claimed: 0, scored: 0, silent: [] };
    const batches = await guard('列批次', () => activeBatches(o.db), [] as string[]);
    report.batches = batches.length;
    for (const b of batches) {
      const q = await guard(`派影子 ${b}`, () => enqueueShadowBatch(o.db, b, o.taskFor), {
        requested: 0,
        already: 0,
      });
      report.requested += q.requested;
    }
    const pub = o.publish;
    if (pub) {
      const real: NonNullable<TickReport['real']> = { batches: 0, requested: 0, skipped: [], outbox: null };
      const rb = await guard('列真执行批次', () => activeRealBatches(o.db), [] as string[]);
      real.batches = rb.length;
      for (const b of rb) {
        const q = await guard(
          `派真执行 ${b}`,
          () =>
            enqueueRealBatch(o.db, b, o.taskFor, pub.acquire, {
              pause: { until: heldUntil, ms: pub.heldPauseMs ?? 5 * 60_000 },
            }),
          {
            requested: 0,
            already: 0,
            skipped: [] as { repo: string; issue: number; why: string }[],
          },
        );
        real.requested += q.requested;
        real.skipped.push(...q.skipped);
      }
      report.real = real;
    }
    report.claimed = await guard('领活', () => d.poll(), 0);
    if (pub && report.real) {
      report.real.outbox = await guard(
        '处理 outbox',
        () =>
          processOutbox({
            ...pub.outbox,
            db: o.db,
            mirrorRoot: o.mirrorRoot,
            tmpRoot: o.workRoot,
            redact: o.redact,
            onError: (err, op) => o.onError(op ? `outbox ${op.kind} ${op.opKey}` : 'outbox', err),
          }),
        null,
      );
    }
    for (const b of batches) {
      const s = await guard(
        `评分 ${b}`,
        () => sweepCompare(o.db, b, o.readMerged, { afterRunId: cursors.get(b) ?? 0 }),
        undefined,
      );
      if (s) {
        report.scored += s.scored;
        cursors.set(b, s.nextAfter);
        for (const f of s.failed) o.onError(`评分 ${b} #${f.shadowRunId}`, new Error(f.error));
      }
      const silence = await guard(`静默 ${b}`, () => shadowSilence(o.db, b), undefined);
      if (silence?.kind === 'silent') {
        report.silent.push(b);
        o.onSilence(b, silence);
      }
    }
    return report;
  }

  return {
    async start(): Promise<number> {
      api = createHarnessApi({ db: o.db, shadow: true });
      const port = await api.listen(o.apiPort, '127.0.0.1');
      dispatcher = new Dispatcher({
        ...o.dispatcher,
        db: o.db,
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        prepareWorkspace: shadowWorkspaces({
          db: o.db,
          mirrorRoot: o.mirrorRoot,
          tmpRoot: o.workRoot,
          redact: o.redact,
          ...(o.dispatcher.sandbox ? { sandbox: o.dispatcher.sandbox } : {}),
          ...(o.publish
            ? {
                publish: async (r: PublishCollected) => {
                  await recordPublish(o.db, { ...r, model: o.publish?.model ?? '' });
                },
              }
            : {}),
        }),
        // 纯影子：outbox 一个真实处理器都不装；开了真执行：只装推分支和开 PR，别的种类（尤其合并）装了自检就不过
        shadow:
          o.probes ??
          realShadowProbes({
            home: o.workerHome,
            ...(o.dispatcher.sandbox ? { sandbox: o.dispatcher.sandbox } : {}),
            egressPort: o.egressPort,
            realHandlers: () => (o.publish ? PUBLISH_KINDS : []),
            allowedHandlers: PUBLISH_KINDS,
            redact: o.redact,
          }),
        onError: (err) => o.onError('派工', err),
      });
      await dispatcher.init();
      if (o.tickMs) {
        timer = setInterval(() => {
          if (ticking) return;
          ticking = tick()
            .then((r) => {
              o.onTick?.(r);
              return r;
            })
            .finally(() => {
              ticking = undefined;
            });
        }, o.tickMs);
      }
      return port;
    },
    tick,
    /** 等跑着的工人收完再关接口层。 */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      await ticking;
      await dispatcher?.stop();
      await api?.close();
    },
    get dispatcher() {
      return dispatcher;
    },
  };
}
