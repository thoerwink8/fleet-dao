// 新内核单工人纵切的场景验收（#3775）：造出成功、超时、被杀、退回、重复提交、限流几种情况，按会话号把整条事件链查成可读的表。
// 不依赖 MCP：法国上接口层是影子模式，spawn_worker 不注册（harness-api 的 toolsFor），所以这里以指挥官的身份直接写
// `worker.spawn.requested` 事件，字段和 spawn_worker 的处理器写的一样（再加影子派工用的 shadow 目标，工作目录只会从它建）。
// 每个场景用自己的批次（一张单），只写 fleet2 的表；跑完 cleanupScenario 把批次、影子产物、回执、活删掉，事件留着当证据。
import { randomUUID } from 'node:crypto';
import { appendToSession } from '@fleet-dao/harness-api';
import {
  claimJobs,
  commandReceipts,
  completeJob,
  type Db,
  events,
  freezeBatch,
  jobs,
  onceByReceipt,
  queueLimits,
  schedule,
  setQueueLimit,
  shadowBatchItems,
  shadowCompare,
  shadowRuns,
} from '@fleet-dao/harness-store';
import { and, asc, eq, inArray, like, or } from 'drizzle-orm';
import { type DispatchPayload, spawnJobKey, WORKER_QUEUE } from './intake.ts';
import type { ShadowTarget, SpawnRequest } from './prompt.ts';

export const SCENARIO_NAMES = [
  'success',
  'timeout',
  'killed',
  'blocked',
  'duplicate',
  'rate-limit',
  'restart',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** 脚本造不出来、要另外处理的：写明原因，不假装跑过。 */
export const MANUAL_SCENARIOS = {
  offline:
    '断网：派工请求里没有任何字段能改工人连的模型入口（SpawnRequest 只有六项加影子目标，工人环境由 buildWorkerEnv 按白名单构造，' +
    '经 sudo / fleet-agent-scope 也带不进去）；不许改 fleet2-egress.allow、不许停 fleet2-egress，所以法国真机上没法在不动出网的前提下造出来。' +
    '代码里它的表现是：工人起来后一直没有实质事件，起步时限到点判 no_progress，确定没副作用，记 final=false 的交回并退避重试。' +
    '这一条由 test/scenarios.test.ts 用静默假工人覆盖。',
  restart:
    '重启接回的重启本身：脚本不碰系统服务。`run restart` 排一件 sleep 300 的活，工人起来后脚本打印提示并一直等；' +
    '这时在跑的是它的工人（不是影子批次的），由人手动 systemctl restart fleet2-kernel 一次，脚本等到活收尾再打事件链：' +
    '应有 released / final=false / willRetry=true，随后新进程重领、跑完的终局交回。',
} as const;

const SCENARIO_NOTE =
  '这是 fleet-dao 新内核的场景验收（#3775），不是真活，仓里的内容和你要做的事无关，只照任务做。';

type Six = Pick<SpawnRequest, 'task' | 'expected' | 'must_do' | 'must_not' | 'context' | 'stop_when'>;

export interface ScenarioSpec {
  six: Six;
  /** 活的截止时刻离排队的时刻多久（毫秒）；不给就用内核默认的 12 小时。 */
  deadlineMs?: number;
  /** 同一个 taskId 提交几次，默认 1。 */
  submits?: number;
  /** 真起了工人以后，再往流里写叫停请求。 */
  stopWhenSpawned?: boolean;
}

export function scenarioSpec(name: Exclude<ScenarioName, 'rate-limit'>): ScenarioSpec {
  // restart：见下面的 case，工人睡 300 秒给人留出重启的时间
  const base = {
    context: SCENARIO_NOTE,
    must_not: '不碰除任务要求以外的文件，不联网，不读工作目录以外的东西',
  };
  const writeOk = (file: string): Six => ({
    ...base,
    task: `在工作目录根下新建文本文件 ${file}，内容只有一行 ok`,
    expected: `一个新文件 ${file}`,
    must_do: '写好文件后用 submit_result 交 status=done',
    stop_when: '文件写好、结果交了就停',
  });
  switch (name) {
    case 'success':
      return { six: writeOk('scenario-success.txt') };
    case 'duplicate':
      return { six: writeOk('scenario-duplicate.txt'), submits: 2 };
    case 'timeout':
      return { six: writeOk('scenario-timeout.txt'), deadlineMs: 60_000 };
    case 'killed':
      return {
        six: {
          ...base,
          // 工人的 shell 工具前台最长 600 秒，900 秒的睡眠它会判做不了直接交 blocked（真机第一次就是这样）；500 秒够长，叫停（内核一轮 30 秒加心跳 20 秒）来得及
          task: '用 shell 工具运行 `sleep 500`，等它结束后再交结果',
          expected: '睡满 500 秒后用 submit_result 交 status=done',
          must_do: '必须真的运行 sleep 500，不许缩短、不许后台运行',
          stop_when: 'sleep 结束并交了结果',
        },
        stopWhenSpawned: true,
      };
    case 'restart':
      return {
        six: {
          ...base,
          task: '用 shell 工具运行 `sleep 300`，等它结束后再交结果',
          expected: '睡满 300 秒后用 submit_result 交 status=done',
          must_do: '必须真的运行 sleep 300，不许缩短、不许后台运行',
          stop_when: 'sleep 结束并交了结果',
        },
      };
    case 'blocked':
      return {
        six: {
          ...base,
          task: '把文件 /nonexistent-scenario/blocked/data.txt 的内容改成 ok',
          expected: '改好的文件；做不了就交 blocked',
          must_do:
            '这件事做不了（路径不存在、你也不许建它）：不要改别的凑数，直接用 submit_result 交 status=blocked，summary 写清做不了的原因',
          stop_when: '交了 blocked 就停',
        },
      };
  }
}

export interface ScenarioTarget {
  repo: string;
  baseSha: string;
}

export interface Submitted {
  sessionId: string;
  batchId: string;
  taskId: string;
  /** 每次提交写进流的 worker.spawn.requested 事件号（重复提交时不止一个）。 */
  eventIds: number[];
  issue: number;
}

/** 场景号：会话号和批次号共用，`scn-<戳>-<名>`。 */
export const scenarioId = (stamp: string, name: string): string => `scn-${stamp}-${name}`;

function issueOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  // 假单号取一个不会撞真单的大数
  return 9_000_000 + (Math.abs(h) % 900_000);
}

/**
 * 提交一个场景：冻结只含一张单的批次，先写好影子驱动的回执（驱动看见回执就不会替这张单读 GitHub 再派一次），
 * 再按 submits 次写同一个 taskId 的派工请求。给了 deadlineMs 的，请求和活在同一个事务里排好（活的键 spawn:<事件号> 和收请求算的一样），
 * 内核稍后收到同一件请求，排活返回「已有」，截止时刻保持这里给的短值。
 */
export async function submitScenario(
  db: Db,
  id: string,
  spec: ScenarioSpec,
  target: ScenarioTarget,
): Promise<Submitted> {
  const issue = issueOf(id);
  const shadow: ShadowTarget = { batchId: id, repo: target.repo, issue, baseSha: target.baseSha };
  await freezeBatch(db, id, [{ repo: target.repo, issue, baseSha: target.baseSha, snapshotAt: new Date() }]);
  await onceByReceipt(db, `shadow-spawn:${id}:${target.repo}#${issue}`, 'shadow-spawn', async () => ({
    scenario: true,
  }));
  const taskId = randomUUID();
  const eventIds: number[] = [];
  for (let i = 0; i < (spec.submits ?? 1); i++) {
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const ev = await appendToSession(tx, id, 'worker.spawn.requested', { taskId, ...spec.six, shadow });
      eventIds.push(ev.id);
      if (spec.deadlineMs !== undefined) {
        const request = { taskId, ...spec.six, shadow } as SpawnRequest;
        const payload: DispatchPayload = { sessionId: id, eventId: ev.id, taskId, request };
        const r = await schedule(tx, {
          queue: WORKER_QUEUE,
          key: spawnJobKey(ev.id),
          payload,
          deadlineInMs: spec.deadlineMs,
          maxAttempts: 3,
        });
        if (r.kind === 'refused') throw new Error(r.why);
      }
    });
  }
  return { sessionId: id, batchId: id, taskId, eventIds, issue };
}

export interface JobView {
  key: string;
  state: string;
  attempts: number;
  maxAttempts: number;
  deadlineAt: Date | null;
  lastError: string | null;
}

/** 这个场景排出来的活：键都是 spawn:<事件号>。 */
export async function jobsOf(db: Db, eventIds: readonly number[]): Promise<JobView[]> {
  if (eventIds.length === 0) return [];
  return db
    .select({
      key: jobs.key,
      state: jobs.state,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      deadlineAt: jobs.deadlineAt,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.queue, WORKER_QUEUE),
        inArray(
          jobs.key,
          eventIds.map((e) => spawnJobKey(e)),
        ),
      ),
    )
    .orderBy(asc(jobs.id));
}

/** 叫停：和 stop_worker 的处理器写的一样，内核下一轮把对应的活取消，工人下次心跳拿到 cancelled。回事件号。 */
export async function requestStop(
  db: Db,
  sessionId: string,
  taskId: string,
  reason: string,
): Promise<number> {
  const ev = await appendToSession(db, sessionId, 'worker.stop.requested', { taskId, reason });
  return ev.id;
}

export interface ChainRow {
  id: number;
  at: Date;
  stream: string;
  type: string;
  outcome: string;
  final: string;
  reason: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);

function describe(
  type: string,
  p: Record<string, unknown>,
): { outcome: string; final: string; reason: string } {
  const none = { outcome: '-', final: '-' };
  switch (type) {
    case 'worker.spawn.requested':
      return { ...none, reason: `任务「${clip(str(p.task), 40)}」 taskId=${str(p.taskId).slice(0, 8)}` };
    case 'worker.stop.requested':
      return { ...none, reason: `叫停：${str(p.reason)}` };
    case 'worker.spawned':
      return { ...none, reason: `起工人 model=${str(p.model)} 截止=${str(p.deadline)}` };
    case 'worker.settled': {
      const killed = p.killed as { reason?: string; detail?: string } | null | undefined;
      return {
        ...none,
        reason: `退出码=${str(p.exitCode)} 信号=${str(p.signal)}${killed ? ` 被停=${killed.reason}（${killed.detail}）` : ''} 停在=${str(p.lastStep)}${p.spawnError ? ` 没起来=${str(p.spawnError)}` : ''}`,
      };
    }
    case 'worker.cleaned':
      return { ...none, reason: p.ok === true ? '收尾干净' : `收尾有错：${str(p.errors)}` };
    case 'worker.progress.reported':
      return { ...none, reason: `进度：${str(p.summary)}` };
    case 'worker.result.submitted':
      return { ...none, reason: `工人自报 ${str(p.status)}：${str(p.summary)}` };
    case 'handback.recorded': {
      const reasons = Array.isArray(p.reasons) ? p.reasons.map(str).join('；') : '';
      const self = (p.evidence as { selfReport?: { status?: string } | null } | undefined)?.selfReport;
      return {
        outcome: str(p.outcome),
        final: `${str(p.final)}${p.willRetry === true ? '/willRetry' : ''}`,
        reason: `verdict=${str(p.verdict)} ${reasons}${self ? ` 自报=${self.status}` : ''}`,
      };
    }
    default:
      return { ...none, reason: '' };
  }
}

/** 按会话号查整条链：指挥官的流 session:<号>，加上这个会话每次尝试的工人流 worker:d<事件号>-a<次> 和工人会话 session:worker-d<事件号>-a<次>。 */
export async function readChain(db: Db, sessionId: string): Promise<ChainRow[]> {
  const main = `session:${sessionId}`;
  const spawns = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.streamId, main), eq(events.type, 'worker.spawn.requested')))
    .limit(200);
  const streams = spawns.flatMap((s) => [`worker:d${s.id}-a%`, `session:worker-d${s.id}-a%`]);
  const rows = await db
    .select()
    .from(events)
    .where(or(eq(events.streamId, main), ...streams.map((s) => like(events.streamId, s))))
    .orderBy(asc(events.id))
    .limit(1000);
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    stream: r.streamId,
    type: r.type,
    ...describe(r.type, r.payload as Record<string, unknown>),
  }));
}

/** 打成对齐的文本表：时刻、事件号、流、类型、outcome、final、原因。 */
export function formatChain(rows: readonly ChainRow[], opts: { width?: number } = {}): string {
  const width = opts.width ?? 160;
  const head = ['时刻(UTC)', '事件', '流', '类型', 'outcome', 'final', '原因'];
  const body = rows.map((r) => [
    r.at.toISOString().replace('T', ' ').replace('Z', ''),
    String(r.id),
    r.stream.replace(/^session:/, 's:').replace(/^worker:/, 'w:'),
    r.type,
    r.outcome,
    r.final,
    clip(r.reason, width),
  ]);
  const cols = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(cols[i] ?? 0))).join(' | ');
  return [line(head), cols.map((c) => '-'.repeat(Math.min(c, 40))).join('-+-'), ...body.map(line)].join('\n');
}

/** 删这个场景留在 fleet2 里的批次、影子产物、回执和已收尾的活；事件留着当证据。 */
export async function cleanupScenario(db: Db, id: string, eventIds: readonly number[]): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const runIds = (
      await tx.select({ id: shadowRuns.id }).from(shadowRuns).where(eq(shadowRuns.batchId, id))
    ).map((r) => r.id);
    if (runIds.length > 0) await tx.delete(shadowCompare).where(inArray(shadowCompare.shadowRunId, runIds));
    await tx.delete(shadowRuns).where(eq(shadowRuns.batchId, id));
    await tx.delete(shadowBatchItems).where(eq(shadowBatchItems.batchId, id));
    await tx.delete(commandReceipts).where(like(commandReceipts.key, `shadow-spawn:${id}:%`));
    if (eventIds.length > 0) {
      await tx.delete(jobs).where(
        and(
          eq(jobs.queue, WORKER_QUEUE),
          inArray(
            jobs.key,
            eventIds.map((e) => spawnJobKey(e)),
          ),
          inArray(jobs.state, ['done', 'dead', 'cancelled']),
        ),
      );
    }
  });
}

export interface RateLimitReport {
  perMinute: number;
  submitted: number;
  /** 每件放行的时刻：距开始的毫秒、活的序号。 */
  releases: { atMs: number; index: number }[];
}

/**
 * 限流：在专用队列 scenario-rate-<戳> 上排多于每分钟上限的活，自己当领活的一方每隔一阵领一次、领到就完成，看放行的节奏。
 * 不用 worker 队列：那条队列是内核的，限速和在跑的影子单不能碰。跑完删这条队列的活和限速行。
 */
export async function runRateLimit(
  db: Db,
  stamp: string,
  opts: { perMinute?: number; total?: number; pollMs?: number; maxWaitMs?: number } = {},
): Promise<RateLimitReport> {
  const perMinute = opts.perMinute ?? 3;
  const total = opts.total ?? perMinute * 2 + 1;
  const queue = `scenario-rate-${stamp}`;
  await setQueueLimit(db, queue, total, perMinute);
  try {
    for (let i = 0; i < total; i++) {
      await schedule(db, { queue, key: `${queue}:${i}`, payload: { index: i }, maxAttempts: 1 });
    }
    const t0 = Date.now();
    const releases: RateLimitReport['releases'] = [];
    const pollMs = opts.pollMs ?? 2_000;
    const maxWaitMs = opts.maxWaitMs ?? (Math.ceil(total / perMinute) + 1) * 60_000;
    while (releases.length < total && Date.now() - t0 < maxWaitMs) {
      const got = await claimJobs(db, queue, total, 60_000);
      for (const j of got) {
        releases.push({ atMs: Date.now() - t0, index: Number(j.key.split(':').pop()) });
        await completeJob(db, j);
      }
      if (releases.length < total) await new Promise((r) => setTimeout(r, pollMs));
    }
    return { perMinute, submitted: total, releases };
  } finally {
    await db.delete(jobs).where(eq(jobs.queue, queue));
    await db.delete(queueLimits).where(eq(queueLimits.queue, queue));
  }
}

export function formatRateLimit(r: RateLimitReport): string {
  const rounds: { atMs: number; indexes: number[] }[] = [];
  for (const x of r.releases) {
    const last = rounds.at(-1);
    if (last && x.atMs - last.atMs < 10_000) last.indexes.push(x.index);
    else rounds.push({ atMs: x.atMs, indexes: [x.index] });
  }
  return [
    `每分钟上限 ${r.perMinute}，一口气排了 ${r.submitted} 件，放行 ${r.releases.length} 件，分 ${rounds.length} 批：`,
    ...rounds.map(
      (x) =>
        `  第 ${String(Math.round(x.atMs / 1000)).padStart(3)} 秒放行 ${x.indexes.length} 件（序号 ${x.indexes.join(',')}）`,
    ),
  ].join('\n');
}
