// Mirasim 插头：经本机 mirasim-server 的回环 ws 起一个会话，只留作「Mirasim 中转额度」这条路由的薄插头
// （MS-28：中转不许反代，只能用它的客户端）。会话由服务端以它自己的身份（法国 VPS 上是旧系统的会话用户）起执行体，
// 引擎只收发帧：起会话、另开连接订阅状态、叫停、事后读账本核实走了哪条上游。
// 协议与坑见 docs/reference/adapters.md 第八节（MS-01…28）。
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProgressEvent } from '@fleet-dao/shared';
import { CallbackGate } from '../cli-run.ts';
import type { RunFacts, RunSummary } from '../judge.ts';
import { looksLikeQuotaExhausted, num, rec, str } from '../stream-kit.ts';
import type { KillReason } from '../types.ts';
import { type LedgerReading, type LedgerRouting, ledgerRouting, readMirasimLedger } from './ledger.ts';
import { MirasimSession } from './session.ts';
import type { MirasimConnect, MirasimFrame, MirasimWire } from './wire.ts';

export type MirasimRoute = 'local' | 'cloud' | 'auto';
export type MirasimSessionRef = { mode: 'new' } | { mode: 'resume'; key: string };

export interface MirasimLimits {
  /** 发出 prompt 到会话进入 streaming 的上限。 */
  startupMs: number;
  wallClockMs: number;
  /** 进度指纹多久不变判停滞（有工具在跑不算）。360 秒的依据见 GEN-05。 */
  idleMs?: number;
  /** 叫停后等它翻终态多久（MS-15：约 3 秒才翻）。 */
  stopConfirmMs: number;
  /** 多久没收到推送就重订阅一次（推送不保证送到，重订阅拿整份快照）。 */
  resubscribeMs: number;
  /** 等 state / accepted 应答多久。 */
  replyMs: number;
  /** 会话结束后等账本追上多久：上游调用那一行要在调用结束后一两秒才写进去（VPS 实跑）。 */
  ledgerWaitMs: number;
}

export const DEFAULT_MIRASIM_LIMITS: MirasimLimits = {
  startupMs: 180_000,
  wallClockMs: 2 * 60 * 60_000,
  idleMs: 360_000,
  stopConfirmMs: 20_000,
  resubscribeMs: 3_000,
  replyMs: 30_000,
  ledgerWaitMs: 10_000,
};

export interface MirasimRunSpec {
  runId: string;
  /**
   * 工作树。执行体以 mirasim-server 的身份在这里干活：这个用户要写得了（会话专用用户的树它进不去，见 PR 说明）。
   */
  cwd: string;
  prompt: string;
  /** 服务端的执行体名：kimi、pi、codex、grok、claude…… */
  agent: string;
  /**
   * cloud = 走 Mirasim 中转（扣 Mirasim 账号额度）；local = 执行体在这台机器上自带的登录；
   * auto = 服务端按额度窗自己选（事后看账本才知道走了哪条，MS-27）。
   */
  route: MirasimRoute;
  /** 点名模型。pi 只认 profile:<BYOK 档 id>，别的写法会被服务端静默置空（PI-02）。 */
  model?: string;
  /** 期望在快照里看到的模型（例如 kimi-code/k3、kimi-k3）：不点名也要声明，起后回读核对，不符就停（KM-01）。 */
  expectModel?: string;
  effort?: string;
  session: MirasimSessionRef;
  limits?: Partial<MirasimLimits>;
  testCommands?: readonly string[];
}

export interface MirasimAccepted {
  sessionKey: string;
  taskId?: string;
  acceptedAt: string;
}

export interface MirasimRunOptions {
  connect: MirasimConnect;
  onEvent?: (event: ProgressEvent) => unknown;
  /** 服务端接下了：引擎记下 sessionKey，重启后用 stopMirasimSession 收掉它。 */
  onAccepted?: (info: MirasimAccepted) => unknown;
  signal?: AbortSignal;
  now?: () => Date;
  /** 账本目录（mirasim-server 用户家里的 ~/.mirasim/traffic）；给了就在结束后读本会话的上游调用。 */
  ledgerDir?: string;
}

export interface MirasimRunReport {
  runId: string;
  agent: string;
  route: MirasimRoute;
  /** 这一轮是续跑（用量里的会话累计值要按上一轮求差）。 */
  resumed: boolean;
  requestedModel?: string;
  expectModel?: string;
  serverVersion?: string;
  sessionKey?: string;
  taskId?: string;
  /** 没起来：连不上、服务端没有这个执行体、服务端拒了这一针。 */
  launchError?: string;
  /** prompt 发出去了、没等到应答：可能已经在跑（MS-18：不许重发，去对账）。 */
  launchUnknown?: boolean;
  killed?: { reason: KillReason; at: string };
  /** 叫停之后有没有看到它翻终态（MS-16：没看到就是「没查成」，不是停好了）。 */
  stop?: { confirmed: boolean; error?: string };
  /** 读状态的连接建不起来或一直断：会话后来怎样没查成。 */
  watchError?: string;
  terminal?: { isError: boolean; detail: string };
  session: ReturnType<MirasimSession['summary']>;
  ledger?: LedgerReading;
  /** 订阅连接上收到的、不属于本会话的帧（GEN-10：一律不认）。 */
  foreignFrames: number;
  resubscribes: number;
  reconnects: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  /** 发出 prompt 到会话进入 streaming。 */
  firstProgressMs?: number;
  hookError?: string;
}

const AGENT = /^[a-z0-9][a-z0-9_-]*$/;
const QUEUED = new Set(['queued', 'pending', 'starting']);

async function waitFor(
  wire: MirasimWire,
  pred: (frame: MirasimFrame) => boolean,
  ms: number,
): Promise<MirasimFrame | 'timeout' | 'closed'> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return 'timeout';
    const frame = await wire.next(left);
    if (frame === 'timeout' || frame === 'closed') return frame;
    if (pred(frame)) return frame;
  }
}

/** clientHello + getState：state 帧不会自己推（MS-02）。 */
async function hello(wire: MirasimWire, ms: number): Promise<Record<string, unknown> | string> {
  wire.send({ type: 'clientHello' });
  wire.send({ type: 'getState' });
  const frame = await waitFor(wire, (f) => f.type === 'state', ms);
  if (frame === 'timeout') return '连上了但没收到 state 帧，契约没查成——不派';
  if (frame === 'closed') return '连上之后连接马上断了';
  return rec(frame.state) ?? {};
}

function modelMatches(expected: string, observed: string): boolean {
  return expected.trim().toLowerCase() === observed.trim().toLowerCase();
}

export async function runMirasim(
  spec: MirasimRunSpec,
  options: MirasimRunOptions,
): Promise<MirasimRunReport> {
  if (!spec.prompt.trim()) throw new Error('提示词是空的');
  if (!AGENT.test(spec.agent)) throw new Error(`执行体名不合法：${JSON.stringify(spec.agent)}`);
  if (spec.agent === 'pi' && spec.model && !spec.model.startsWith('profile:')) {
    throw new Error(
      '经 Mirasim 起 pi 时 model 只认 profile:<BYOK 档 id>：别的写法会被服务端静默置空、落到默认腿上（PI-02）',
    );
  }
  if (spec.session.mode === 'resume' && !spec.session.key.startsWith(`${spec.agent}:`)) {
    throw new Error(`续跑的 sessionKey 不是 ${spec.agent} 的：${spec.session.key}`);
  }
  const dir = await stat(spec.cwd).catch(() => undefined);
  if (!dir?.isDirectory()) throw new Error(`工作目录不存在：${spec.cwd}`);

  const now = options.now ?? (() => new Date());
  const limits: MirasimLimits = { ...DEFAULT_MIRASIM_LIMITS, ...spec.limits };
  const t0 = Date.now();
  const startedAt = now().toISOString();
  const gate = new CallbackGate();
  const session = new MirasimSession({
    runId: spec.runId,
    cwd: spec.cwd,
    ...(spec.testCommands ? { testCommands: spec.testCommands } : {}),
    now,
  });
  const expect = spec.expectModel ?? (spec.agent !== 'pi' ? spec.model : undefined);
  const report: Omit<MirasimRunReport, 'session' | 'endedAt' | 'wallMs'> = {
    runId: spec.runId,
    agent: spec.agent,
    route: spec.route,
    resumed: spec.session.mode === 'resume',
    ...(spec.model ? { requestedModel: spec.model } : {}),
    ...(expect ? { expectModel: expect } : {}),
    foreignFrames: 0,
    resubscribes: 0,
    reconnects: 0,
    startedAt,
  };
  let control: MirasimWire | undefined;
  let sub: MirasimWire | undefined;
  const deliver = (events: ProgressEvent[]) => {
    for (const event of events) gate.call(() => options.onEvent?.(event));
  };
  const done = async (): Promise<MirasimRunReport> => {
    control?.close();
    sub?.close();
    const hookError = await gate.settle();
    return {
      ...report,
      session: session.summary(),
      endedAt: now().toISOString(),
      wallMs: Date.now() - t0,
      ...(hookError === undefined ? {} : { hookError }),
    };
  };

  // 1. 连上、握手、核对执行体
  try {
    control = await options.connect();
  } catch (err) {
    report.launchError = (err as Error).message;
    return done();
  }
  const state = await hello(control, limits.replyMs);
  if (typeof state === 'string') {
    report.launchError = state;
    return done();
  }
  const version = str(state.version);
  if (version) report.serverVersion = version;
  if (!Array.isArray(state.agentsAvailable)) {
    report.launchError = 'state 帧里没有 agentsAvailable，契约没查成——不派';
    return done();
  }
  if (!state.agentsAvailable.includes(spec.agent)) {
    report.launchError = `服务端没有 ${spec.agent} 这个执行体（有：${state.agentsAvailable.join('、')}）`;
    return done();
  }
  if (options.signal?.aborted) {
    report.killed = { reason: 'aborted', at: now().toISOString() };
    return done();
  }

  // 2. 起会话 / 续跑：同一个 prompt 帧带上已有的 sessionKey（MS-17）
  const clientRef = `fleet-${spec.runId}-${t0}`;
  control.send({
    type: 'prompt',
    prompt: spec.prompt,
    agent: spec.agent,
    workdir: spec.cwd,
    route: spec.route === 'auto' ? null : spec.route,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.session.mode === 'resume' ? { sessionKey: spec.session.key } : {}),
    clientRef,
  });
  const reply = await waitFor(
    control,
    (f) =>
      (f.type === 'accepted' && (f.clientRef === undefined || f.clientRef === clientRef)) ||
      f.type === 'error',
    limits.replyMs,
  );
  if (reply === 'timeout' || reply === 'closed') {
    report.launchUnknown = true;
    report.launchError =
      '起会话没查成：prompt 发出去了，没等到应答。它可能已经在跑——别重发（会烧两次额度），按工作目录和起针时间去 ~/.mirasim/sessions 对账';
    return done();
  }
  if (reply.type === 'error') {
    report.launchError = `服务端拒了这一针：${str(reply.message) ?? JSON.stringify(reply)}`;
    return done();
  }
  const sessionKey = str(reply.sessionKey);
  if (!sessionKey?.startsWith(`${spec.agent}:`)) {
    report.launchError = `应答里的 sessionKey 认不出：${JSON.stringify(reply.sessionKey)}`;
    return done();
  }
  report.sessionKey = sessionKey;
  const taskId = str(reply.taskId);
  if (taskId) report.taskId = taskId;
  const accepted: MirasimAccepted = {
    sessionKey,
    acceptedAt: now().toISOString(),
    ...(taskId ? { taskId } : {}),
  };
  gate.call(() => options.onAccepted?.(accepted));
  session.expectTurn(taskId, spec.session.mode === 'resume');

  // 3. 叫停：stop 帧只在失败时回 error，送没送到要看它翻不翻终态（MS-16）。过半个确认期还没翻，换条新连接再发一次。
  let killedAt = 0;
  let stopResent = false;
  const sendStop = async (fresh: boolean) => {
    try {
      if (fresh) {
        const wire = await options.connect();
        const st = await hello(wire, limits.replyMs);
        if (typeof st === 'string') throw new Error(st);
        wire.send({ type: 'stop', sessionKey });
        wire.close();
      } else control?.send({ type: 'stop', sessionKey });
    } catch (err) {
      if (report.stop) report.stop.error = `stop 帧没发出去：${(err as Error).message}`;
    }
  };
  const kill = (reason: KillReason) => {
    if (report.killed) return;
    report.killed = { reason, at: now().toISOString() };
    killedAt = Date.now();
    report.stop = { confirmed: false };
    void sendStop(false);
  };
  if (spec.session.mode === 'resume' && sessionKey !== spec.session.key) kill('session_mismatch');

  // 4. 另开一条连接订阅（推送不保证送到发起连接，MS-03）
  const openSub = async (): Promise<MirasimWire | undefined> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const wire = await options.connect();
        const st = await hello(wire, limits.replyMs);
        if (typeof st !== 'string') {
          wire.send({ type: 'subscribe', sessionKey });
          return wire;
        }
        report.watchError = st;
        wire.close();
      } catch (err) {
        report.watchError = `读状态的连接建不起来：${(err as Error).message}`;
      }
    }
    return undefined;
  };
  sub = await openSub();
  let lastFingerprint = '';
  let lastProgress = Date.now();
  while (sub) {
    const elapsed = Date.now() - t0;
    if (options.signal?.aborted) kill('aborted');
    if (!report.killed) {
      const phase = session.state.phase;
      if ((!session.current || !phase || QUEUED.has(phase)) && elapsed > limits.startupMs) {
        kill('startup_timeout');
      } else if (elapsed > limits.wallClockMs) kill('wall_clock_timeout');
      else if (
        limits.idleMs !== undefined &&
        session.current &&
        phase &&
        !QUEUED.has(phase) &&
        session.toolsInFlight === 0 &&
        Date.now() - lastProgress > limits.idleMs
      ) {
        kill('idle_timeout');
      }
    }
    if (report.killed && Date.now() - killedAt > limits.stopConfirmMs) break;
    if (report.killed && !stopResent && Date.now() - killedAt > limits.stopConfirmMs / 2) {
      stopResent = true;
      void sendStop(true);
    }
    const frame = await sub.next(limits.resubscribeMs);
    if (frame === 'closed') {
      report.reconnects++;
      sub.close();
      sub = await openSub();
      continue;
    }
    if (frame === 'timeout') {
      sub.send({ type: 'subscribe', sessionKey });
      report.resubscribes++;
      continue;
    }
    if (frame.sessionKey !== sessionKey) {
      report.foreignFrames++;
      continue;
    }
    if (frame.type === 'snapshot') {
      deliver(session.applySnapshot(num(frame.seq) ?? 0, rec(frame.snapshot) ?? {}));
    } else if (frame.type === 'session') {
      const events = session.applyPatch(num(frame.seq) ?? 0, rec(frame.patch) ?? {});
      if (events === 'gap') {
        sub.send({ type: 'subscribe', sessionKey });
        report.resubscribes++;
      } else deliver(events);
    }
    const fingerprint = session.fingerprint();
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastProgress = Date.now();
    }
    const phase = session.state.phase;
    if (report.firstProgressMs === undefined && session.current && phase && !QUEUED.has(phase)) {
      report.firstProgressMs = Date.now() - t0;
    }
    const model = session.state.model;
    if (!report.killed && session.current && expect && model && !modelMatches(expect, model)) {
      kill('model_mismatch');
    }
    const terminal = session.terminal();
    if (terminal) {
      report.terminal = terminal;
      if (report.stop) report.stop.confirmed = true;
      break;
    }
  }
  if (!sub && !report.terminal) {
    report.watchError ??= '读状态的连接建不起来';
    // 看不见它了：停掉，免得它在服务端一直跑；它后来怎样照实记「没查成」，不记成我们叫停
    report.stop ??= { confirmed: false };
    await sendStop(true);
  }
  deliver(session.flush());

  // 5. 账本：这次到底走了哪条上游、有没有真的 2xx（MS-27）
  if (options.ledgerDir) {
    // 中转路由要看到起针之后的 2xx：行是调用结束后才写的，刚结束就读会读空，等它追上来（最多 ledgerWaitMs）
    const deadline = Date.now() + limits.ledgerWaitMs;
    for (;;) {
      report.ledger = await readMirasimLedger(options.ledgerDir, sessionKey, t0 - 5_000);
      const settled =
        spec.route !== 'cloud' ||
        !report.terminal ||
        (report.ledger.state === 'read' && ledgerRouting(report.ledger.rows).ok > 0);
      if (settled || Date.now() >= deadline) break;
      await sleep(500);
    }
  }
  return done();
}

/** 引擎重启后收掉记下的旧会话：发 stop，订阅看它翻终态。看到了才算收好。 */
export async function stopMirasimSession(
  connect: MirasimConnect,
  sessionKey: string,
  confirmMs = DEFAULT_MIRASIM_LIMITS.stopConfirmMs,
): Promise<{ confirmed: boolean; detail: string }> {
  let wire: MirasimWire | undefined;
  try {
    wire = await connect();
    const st = await hello(wire, DEFAULT_MIRASIM_LIMITS.replyMs);
    if (typeof st === 'string') return { confirmed: false, detail: st };
    wire.send({ type: 'stop', sessionKey });
    wire.send({ type: 'subscribe', sessionKey });
    const probe = new MirasimSession({ runId: 'stop', cwd: '/' });
    const deadline = Date.now() + confirmMs;
    while (Date.now() < deadline) {
      const frame = await wire.next(Math.min(3_000, Math.max(1, deadline - Date.now())));
      if (frame === 'closed') return { confirmed: false, detail: '连接断了，停没停没查成' };
      if (frame === 'timeout') {
        wire.send({ type: 'subscribe', sessionKey });
        continue;
      }
      if (frame.sessionKey !== sessionKey) continue;
      if (frame.type === 'error') return { confirmed: false, detail: str(frame.message) ?? '服务端报错' };
      if (frame.type === 'snapshot') probe.applySnapshot(num(frame.seq) ?? 0, rec(frame.snapshot) ?? {});
      if (frame.type === 'session') probe.applyPatch(num(frame.seq) ?? 0, rec(frame.patch) ?? {});
      const terminal = probe.terminal();
      if (terminal) return { confirmed: true, detail: terminal.detail };
    }
    return { confirmed: false, detail: `${Math.round(confirmMs / 1000)} 秒内没看到它翻终态` };
  } catch (err) {
    return { confirmed: false, detail: (err as Error).message };
  } finally {
    wire?.close();
  }
}

/** 账本读成了就给出路由汇总；没查成就是 undefined。 */
export function mirasimRouting(report: MirasimRunReport): LedgerRouting | undefined {
  return report.ledger?.state === 'read' ? ledgerRouting(report.ledger.rows) : undefined;
}

export function mirasimRunFacts(report: MirasimRunReport): RunFacts {
  const routing = mirasimRouting(report);
  let terminal = report.terminal;
  // 中转路由：快照说 done 还要账本里起针之后有 2xx 行（8.4）；账本没查成就不下这个结论
  if (terminal && !terminal.isError && report.route === 'cloud' && routing && routing.ok === 0) {
    terminal = { isError: true, detail: '快照说 done，但账本里起针之后没有一次 2xx 的上游调用' };
  }
  const error = report.session.state.error;
  const words = report.watchError ?? error;
  return {
    ...(report.launchError ? { spawnError: report.launchError } : {}),
    ...(report.killed ? { killed: report.killed.reason } : {}),
    ...(terminal ? { terminal } : {}),
    quotaExhausted: looksLikeQuotaExhausted(error),
    ...(words ? { lastWords: words } : {}),
  };
}

/** 快照 usage 里的会话累计值（codex 给 sessionTotals；kimi、pi 不给）。 */
function sessionTotals(report: MirasimRunReport | undefined) {
  const totals = rec(rec(report?.session.state.usage)?.sessionTotals);
  if (!totals) return undefined;
  return {
    input: num(totals.input),
    output: num(totals.output),
    cached: num(totals.cachedInput),
    cachedIncluded: totals.cachedIncluded === true,
  };
}

/**
 * 交给引擎的统一摘要。续跑用的会话号就是 sessionKey；实际模型取快照里的观测值。中转扣的是 Mirasim 账号额度，不折美元。
 * 用量：有会话累计值（codex）就按上一轮求差（续跑不给上一轮就不带）；没有的只剩 turnOutputTokens（pi 是本轮累计输出），
 * kimi 什么都不给——读不到就不带，不记成 0。
 */
export function mirasimRunSummary(report: MirasimRunReport, previous?: MirasimRunReport): RunSummary {
  const base = {
    facts: mirasimRunFacts(report),
    ...(report.session.state.model ? { actualModel: report.session.state.model } : {}),
    ...(report.sessionKey ? { sessionId: report.sessionKey } : {}),
  };
  const now = sessionTotals(report);
  if (now) {
    const before = sessionTotals(previous);
    if (report.resumed && !before) return { ...base, usage: {} };
    const minus = (a: number | undefined, b: number | undefined) =>
      a === undefined ? undefined : before ? (b === undefined ? undefined : Math.max(0, a - b)) : a;
    const input = minus(now.input, before?.input);
    const cached = minus(now.cached, before?.cached);
    const output = minus(now.output, before?.output);
    return {
      ...base,
      usage: {
        ...(input !== undefined
          ? { inputTokens: now.cachedIncluded && cached !== undefined ? Math.max(0, input - cached) : input }
          : {}),
        ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
      },
    };
  }
  const output = num(rec(report.session.state.usage)?.turnOutputTokens);
  return { ...base, usage: output === undefined ? {} : { outputTokens: output } };
}
