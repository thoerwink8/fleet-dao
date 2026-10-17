// Mirasim 插头：经本机 Mirasim 服务的回环 ws 起一个会话，只留作「Mirasim 中转额度」这条路由的薄插头
// （MS-28：中转不许反代，只能用它的客户端）。执行体的工具跑在 Mirasim 服务的进程里，所以主线定的是给会话用户单独起一份
// Mirasim 服务（各自登录一次），不借旧系统那份；配好之前 Mirasim 路由保持关闭（docs/design.md 第十四节）。
// 引擎只收发帧：起会话、另开连接订阅状态、叫停、事后读账本核实走了哪条上游。
// 协议与坑见 docs/reference/adapters.md 第八节（MS-01…28）。
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProgressEvent } from '@fleet-dao/shared';
import { CallbackGate, type LineMeta } from '../cli-run.ts';
import { assertSessionEffort, SESSION_EFFORTS } from '../effort.ts';
import type { RunFacts, RunSummary } from '../judge.ts';
import { abortCause, type StopCause, stopCauseOf } from '../stop-reason.ts';
import { looksLikeQuotaExhausted, num, rec, relayQuotaNotice, str } from '../stream-kit.ts';
import type { KillReason, TranscriptEntry } from '../types.ts';
import {
  type LedgerFs,
  type LedgerReading,
  type LedgerRouting,
  ledgerRouting,
  readMirasimLedger,
} from './ledger.ts';
import { reconcileLaunchSession, type SessionsFs } from './records.ts';
import { MirasimSession } from './session.ts';
import type { MirasimConnect, MirasimFrame, MirasimWire } from './wire.ts';

export type MirasimRoute = 'local' | 'cloud' | 'auto';
export type MirasimSessionRef = { mode: 'new' } | { mode: 'resume'; key: string };

export interface MirasimLimits {
  /** 起针到会话进入 streaming 的上限；等 accepted 也在这份预算里（服务被堵时几十秒才读到 prompt 帧）。 */
  startupMs: number;
  wallClockMs: number;
  /** 进度指纹多久不变判停滞（有工具在跑不算）。360 秒的依据见 GEN-05。 */
  idleMs?: number;
  /** 叫停后等它翻终态多久（MS-15：约 3 秒才翻）。 */
  stopConfirmMs: number;
  /** 多久没收到推送就重订阅一次（推送不保证送到，重订阅拿整份快照）。 */
  resubscribeMs: number;
  /** 等 state 应答多久；等 accepted 至少这么久（上限见 startupMs）。 */
  replyMs: number;
  /** 会话结束后等账本追上多久：上游调用那一行要在调用结束后一两秒才写进去（VPS 实跑）。 */
  ledgerWaitMs: number;
}

/**
 * 订阅连不上时一共再试这么久。盖住一次看门狗重启：服务起来实测约 24 秒（boot 24197ms），再留余量。
 * 以前连试 3 次、中间不等，令牌文件被换掉的那几十秒里直接判没查成。
 */
export const WATCH_CONNECT_BUDGET_MS = 60_000;

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
  /** 工作树。执行体以这份 Mirasim 服务的用户（会话用户）的身份在这里干活。 */
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
  /** 不给就不写进 prompt 帧。引擎起会话时总是给。不认识的值在发出去之前抛错。 */
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
  /**
   * meta：和 cli-run.ts 的 spawn 类插头共用同一个形状。Mirasim 没有收发目录：工具在已经在跑的 Mirasim 服务里执行，
   * 引擎重启只是这条 ws 断了，下一个引擎按会话号重新订阅（attach，#2815；session.ts 的 seq 自己会丢旧快照、拒绝倒退
   * 的补丁）。seq 只是单调递增；replay 只在接回时订阅回的第一份整份快照上为 true（放手前已经交过的旧内容），
   * 其余恒为 false：事件在进 onEvent 之前已经被 MirasimSession 按 seq 去重过。
   */
  onEvent?: (event: ProgressEvent, meta: LineMeta) => unknown;
  /**
   * 会话过程记录（#1640，见 TranscriptEntry）：和 onEvent 同一个节拍。seq 同样只是单调递增；replay 同 onEvent
   * （接回时第一份快照为 true）。
   */
  onTranscript?: (entry: TranscriptEntry, meta: LineMeta) => unknown;
  /** 服务端接下了：引擎记下 sessionKey，重启后用 stopMirasimSession 收掉它。对账接回时也报一次（没收到 accepted 帧）。 */
  onAccepted?: (info: MirasimAccepted) => unknown;
  signal?: AbortSignal;
  /**
   * 放手（#2815，引擎停机、发版重启）：响了就只断开连接，不发 stop、不记成被叫停，报告里带 detached（会话号、轮次号）：
   * Mirasim 服务端的会话不靠引擎的 ws 连接活着，下一个引擎用 attach 按会话号重新订阅接回。和 signal（叫停，要收掉会话）
   * 不是一回事：两个都响时放手优先；已经叫停了（切号、总时长、卡住）的不再放手，照旧等它翻终态。
   * 还没等到 accepted（没有会话号可交）时放手不生效，等到 accepted 再放。
   */
  release?: AbortSignal;
  /**
   * 接回（#2815）：上一个引擎放手时记下的会话号和轮次号。不握手、不发 prompt，直接按会话号订阅，读到收场；
   * 订阅回的第一份快照是整份旧内容，交出去的事件和过程记录标 replay（meta.replay）。
   */
  attach?: { sessionKey: string; taskId?: string };
  now?: () => Date;
  /**
   * 毫秒钟。不给用 Date.now。没等到 accepted 时对账要等到时间窗上沿（MS-18）：测试用它和 pause 一起把这段拨快。
   */
  clock?: () => number;
  /**
   * 订阅连不上时的退避等待，对账两次翻档案之间也用它。不给就真等。测试用它把时钟拨快，不睡满。
   */
  pause?: (ms: number) => Promise<void>;
  /**
   * 账本目录（Mirasim 服务那个用户家里的 ~/.mirasim/traffic）：结束后读本会话的上游调用。
   * 走中转（route=cloud）时不给就判「中转没查成」：快照说 done 不等于上游真干了活。
   */
  ledgerDir?: string;
  /**
   * 账本怎么读：不给就直接读本机文件系统（开发机、测试）。账本在别的系统用户家里、调用方（引擎）进不去那个家目录时
   * 换成这个——例如经 fleet-agent-scope 以那个会话用户的身份读（real/index.ts 的生产装配）。
   */
  ledgerFs?: LedgerFs;
  /**
   * 会话档案目录（Mirasim 服务那个用户家里的 ~/.mirasim/sessions）。没等到 accepted 时按工作目录和起针时间窗在这里对账
   * （MS-18）。不给就对不了，照旧报「没查成」——引擎进不去那个家时必须给，并配上 sessionsFs。
   */
  sessionsDir?: string;
  /** 档案怎么读。不给就直接读本机文件系统。生产经 fleet-agent-scope 以会话用户的身份读（和 ledgerFs 同一条路）。 */
  sessionsFs?: SessionsFs;
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
  /** 没起来：连不上、服务端没有这个执行体、服务端拒了这一针。launchUnknown 时是「没查成」的原因。 */
  launchError?: string;
  /**
   * prompt 发出去了、没等到带本次 clientRef 的应答，并且按工作目录和起针时间对账没有对上唯一一条
   * （没有、多条、档案读不了，或没给档案目录）。可能已经在跑（MS-18：不许重发）。
   */
  launchUnknown?: boolean;
  killed?: { reason: KillReason; at: string; cause?: StopCause };
  /** 叫停之后有没有看到它翻终态（MS-16：没看到就是「没查成」，不是停好了）。 */
  stop?: { confirmed: boolean; error?: string };
  /** 放手了（options.release，#2815）：连接断了、会话在服务端接着跑，没发 stop；没有终态。 */
  detached?: { sessionKey: string; taskId?: string };
  /** 读状态的连接建不起来或一直断：会话后来怎样没查成。 */
  watchError?: string;
  terminal?: { isError: boolean; detail: string };
  session: ReturnType<MirasimSession['summary']>;
  /** 没给账本目录就没有。 */
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

/**
 * 回读的模型名是不是点名的那个。
 * 服务端会给出比点名多一个后缀的写法：claude 的点名 `claude-opus-5-5`、回读 `claude-opus-5-5[1m]`，
 * `[1m]` 只是上下文窗口标记，是同一个模型（实测：7 个 claude 模型全被这条一字不差
 * 的比对判成 model_mismatch 当场叫停，叫停发生在发出任何上游请求之前，一次真话都没收到）。
 * 只剥末尾的方括号标记，不宽松到「前缀相同就算」——那样点 `gpt-5.6-luna` 回 `gpt-5.6-luna-preview`
 * 也会被认成对。
 *
 * #2742 不是这里剥错了：点名 `claude-sonnet-5-5`、读回 `claude-opus-5-5[1m]`，剥掉末尾方括号仍是
 * sonnet 对 opus。也不是中转静默换模：新会话的快照在出上游请求之前就是点名加 `[1m]`（下面那条实测）；
 * sonnet 在名册里，照点名起会对得上。#1298 才是换模——新会话、点名不在中转名单里，服务端换成名单第一个
 * （gpt-6-sol → gpt-6-astra）。#2797 的发版叫停只让上一段收场，叫停本身不改快照里的模型。
 * 这一例是发版叫停后误续上一段 opus：续会话不比模型，同一 mirasim-relay 池点名 sonnet 仍续上 opus，
 * 快照 model 还是那段会话的 `claude-opus-5-5[1m]`。这里只停这一段。怎么重派由失败分流 MD3 和任务工作流
 * `model-mismatch-reroute` 管，不在插头里挂整张单。
 */
function modelMatches(expected: string, observed: string): boolean {
  const strip = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\[[^\]]*\]$/, '');
  return strip(expected) === strip(observed);
}

/** 没等到应答、又没对上唯一一条。没去对账（没给档案目录）时的那句要和以前一字不差。 */
function launchMissMessage(stray: string | undefined, looked: string | undefined): string {
  const strayBit = stray ? `（收到过一条认不出是冲这一针来的报错：${stray}）` : '';
  const tail = looked ?? '按工作目录和起针时间去 ~/.mirasim/sessions 对账';
  return `起会话没查成：prompt 发出去了，没等到应答${strayBit}。它可能已经在跑——别重发（会烧两次额度），${tail}`;
}

export async function runMirasim(
  spec: MirasimRunSpec,
  options: MirasimRunOptions,
): Promise<MirasimRunReport> {
  if (!options.attach && !spec.prompt.trim()) throw new Error('提示词是空的');
  if (options.attach && !options.attach.sessionKey.startsWith(`${spec.agent}:`)) {
    throw new Error(`接回的 sessionKey 不是 ${spec.agent} 的：${options.attach.sessionKey}`);
  }
  if (spec.effort !== undefined) assertSessionEffort(spec.effort, SESSION_EFFORTS, 'Mirasim');
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
  const clock = options.clock ?? Date.now;
  const limits: MirasimLimits = { ...DEFAULT_MIRASIM_LIMITS, ...spec.limits };
  const t0 = clock();
  // 等应答和「排队等到第一帧」共用 startupMs，从起针算。对账接上时改成接上的时刻：
  // 等应答已经把预算用完，接到的会话（多半在跑或跑完了）不该因此被 startup_timeout 停掉。
  let startupAt = t0;
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
  let eventSeq = -1;
  let transcriptSeq = -1;
  // 接回后订阅回的第一份快照是整份旧内容（放手前已经交出去过的、加上引擎不在时服务端新长的）：交出去标 replay，
  // 调用方只拿它重建状态、别再当新事件记。之后的补丁才是新的。
  let replaying = options.attach !== undefined;
  const deliver = (events: ProgressEvent[]) => {
    for (const event of events) {
      eventSeq += 1;
      const meta: LineMeta = { seq: eventSeq, replay: replaying };
      gate.call(() => options.onEvent?.(event, meta));
    }
    for (const entry of session.drainTranscript()) {
      transcriptSeq += 1;
      const meta: LineMeta = { seq: transcriptSeq, replay: replaying };
      gate.call(() => options.onTranscript?.(entry, meta));
    }
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

  const pause = options.pause ?? sleep;
  let sessionKey: string;
  let taskId: string | undefined;
  if (options.attach) {
    // 接回（#2815）：会话早就在服务端跑着，上一个引擎放手时记下了会话号和轮次号。不握手、不发 prompt，直接订阅；
    // 等应答的预算用不上，排队超时从接回起算。
    sessionKey = options.attach.sessionKey;
    taskId = options.attach.taskId;
    startupAt = Date.now();
  } else {
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
      report.killed = { reason: 'aborted', at: now().toISOString(), ...abortCause(options.signal) };
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
    // 被拒只认带本次 clientRef 的 error 帧。认不出是冲这一针来的报错不当成「被拒」：被拒的会重派，
    // 而会话可能已经起了，重派就扣两次额度。记下原话接着等 accepted，等不到按「没查成」收。
    // 等 accepted 的上限是起会话的总预算（startupMs，从起针算），不是一问一答的 replyMs：服务单线程，被别的会话堵住时
    // 几十秒才读到这一帧（MS-08；#2249 那次 prompt 帧发出 16 秒后服务才读到、34 秒才起会话，按 30 秒收就报了没查成，
    // 会话其实起了、跑完了）。起不来的照旧由下面的 startup_timeout 管。
    const acceptMs = Math.max(limits.replyMs, limits.startupMs - (Date.now() - t0));
    let stray: string | undefined;
    const reply = await waitFor(
      control,
      (f) => {
        if (f.type === 'accepted') return f.clientRef === undefined || f.clientRef === clientRef;
        if (f.type !== 'error') return false;
        if (f.clientRef === clientRef) return true;
        stray ??= str(f.message) ?? JSON.stringify(f);
        return false;
      },
      acceptMs,
    );
    // 没等到应答：先按工作目录 + 起针时间窗对账（MS-18）。对上唯一一条就接上，不重发 prompt。
    // 没给档案目录、对上多条、一条都没有、档案读不了，才照旧报没查成。
    if (reply === 'timeout' || reply === 'closed') {
      const found = options.sessionsDir
        ? await reconcileLaunchSession({
            sessionsDir: options.sessionsDir,
            agent: spec.agent,
            cwd: spec.cwd,
            t0,
            startupMs: limits.startupMs,
            ...(options.sessionsFs ? { sessionsFs: options.sessionsFs } : {}),
            clock,
            pause,
            ...(options.signal ? { signal: options.signal } : {}),
          })
        : undefined;
      if (found?.kind !== 'unique') {
        report.launchUnknown = true;
        report.launchError = launchMissMessage(stray, found?.detail);
        return done();
      }
      sessionKey = found.sessionKey;
      taskId = found.taskId;
      startupAt = Date.now();
    } else if (reply.type === 'error') {
      report.launchError = `服务端拒了这一针：${str(reply.message) ?? JSON.stringify(reply)}`;
      return done();
    } else {
      const key = str(reply.sessionKey);
      if (!key?.startsWith(`${spec.agent}:`)) {
        report.launchError = `应答里的 sessionKey 认不出：${JSON.stringify(reply.sessionKey)}`;
        return done();
      }
      sessionKey = key;
      taskId = str(reply.taskId);
    }
  }
  report.sessionKey = sessionKey;
  if (taskId) report.taskId = taskId;
  const accepted: MirasimAccepted = {
    sessionKey,
    acceptedAt: now().toISOString(),
    ...(taskId ? { taskId } : {}),
  };
  gate.call(() => options.onAccepted?.(accepted));
  // 接回：服务端的会话早已是这一轮，订阅回的整份快照就是它（有轮次号的按轮次号认）；不是「续跑先回上一轮收尾」那回事
  session.expectTurn(taskId, options.attach ? false : spec.session.mode === 'resume');

  // 3. 叫停：stop 帧只在失败时回 error，送没送到要看它翻不翻终态（MS-16）。过半个确认期还没翻，换条新连接再发一次。
  let killedAt = 0;
  let stopResent = false;
  const sendStop = async (fresh: boolean) => {
    try {
      // 接回的没有发起连接：一律另开一条发
      if (fresh || !control) {
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
  const kill = (reason: KillReason, cause?: StopCause) => {
    if (report.killed) return;
    report.killed = { reason, at: now().toISOString(), ...(cause ? { cause } : {}) };
    killedAt = Date.now();
    report.stop = { confirmed: false };
    void sendStop(false);
  };
  if (!options.attach && spec.session.mode === 'resume' && sessionKey !== spec.session.key) {
    kill('session_mismatch');
  }

  // 4. 另开一条连接订阅（推送不保证送到发起连接，MS-03）。
  // 连不上（服务正在重启、令牌文件还没写回来）按退避再试，总时长盖住一次重启，不是连试 3 次就放弃。
  const openSub = async (): Promise<MirasimWire | undefined> => {
    const deadline = Date.now() + WATCH_CONNECT_BUDGET_MS;
    let wait = 500;
    for (;;) {
      // 放手了就不再重连：下一个引擎接回
      if (options.release?.aborted && !report.killed) return undefined;
      try {
        const wire = await options.connect();
        const st = await hello(wire, limits.replyMs);
        if (typeof st !== 'string') {
          delete report.watchError;
          wire.send({ type: 'subscribe', sessionKey });
          return wire;
        }
        report.watchError = st;
        wire.close();
      } catch (err) {
        report.watchError = `读状态的连接建不起来：${(err as Error).message}`;
      }
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await pause(Math.min(wait, left));
      wait = Math.min(wait * 2, 8_000);
    }
  };
  sub = await openSub();
  let lastFingerprint = '';
  let lastProgress = Date.now();
  let detached = false;
  while (sub) {
    const elapsed = Date.now() - t0;
    const sinceStartup = Date.now() - startupAt;
    // 放手优先于叫停：引擎停机时放手信号先响，随后活动被取消（signal 也响）也不能走发 stop 那条路
    if (options.release?.aborted && !report.killed) {
      detached = true;
      break;
    }
    if (options.signal?.aborted) kill('aborted', stopCauseOf(options.signal.reason));
    if (!report.killed) {
      const phase = session.state.phase;
      if ((!session.current || !phase || QUEUED.has(phase)) && sinceStartup > limits.startupMs) {
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
      if (replaying) {
        // 旧内容到此为止：没说完的话也算旧的，免得之后和新长出来的粘在一起重复交
        deliver(session.flush());
        replaying = false;
      }
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
    // 子代理（#1641 的 fleet-* 子代理，可能是 Haiku）跑的时候，Mirasim 会不会把快照里的 model 换成子代理的模型：没查成。
    // 这里不改判法，留给指挥官发版后按 specs/1641-子代理分档/法国实装.md 第一节第 6 条实测；会换就改成只核第一次读到的 model。
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
  if (!sub && !report.terminal && !report.killed && options.release?.aborted) detached = true;
  if (detached) {
    report.detached = { sessionKey, ...(taskId ? { taskId } : {}) };
    delete report.watchError;
  } else if (!sub && !report.terminal) {
    report.watchError ??= '读状态的连接建不起来';
    // 看不见它了：停掉，免得它在服务端一直跑；它后来怎样照实记「没查成」，不记成我们叫停
    report.stop ??= { confirmed: false };
    await sendStop(true);
  }
  deliver(session.flush());

  // 5. 账本：这次到底走了哪条上游、有没有真的 2xx（MS-27）
  if (options.ledgerDir && !detached) {
    // 中转路由要看到起针之后的 2xx：行是调用结束后才写的，刚结束就读会读空，等它追上来（最多 ledgerWaitMs）
    const deadline = Date.now() + limits.ledgerWaitMs;
    for (;;) {
      report.ledger = await readMirasimLedger(options.ledgerDir, sessionKey, t0 - 5_000, options.ledgerFs);
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
  let terminal = report.terminal;
  let relayUnknown: string | undefined;
  // 来源校验必须在成功进入统一记账前完成；2xx 本身不能证明用了平台额度。
  if (terminal && !terminal.isError && report.route === 'cloud') {
    const ledger = report.ledger;
    if (!ledger) relayUnknown = '没给账本目录，上游有没有真的干活核实不了';
    else if (ledger.state === 'unknown') relayUnknown = `账本没读成：${ledger.detail}`;
    else if (ledger.unparsed > 0) relayUnknown = '账本有格式无法识别的行，实际额度来源核实不了';
    else {
      const successes = ledger.rows.filter(
        (r) =>
          r.status !== undefined &&
          r.status >= 200 &&
          r.status < 300 &&
          !r.path?.split('?')[0]?.endsWith('/messages/count_tokens') &&
          !r.path?.split('?')[0]?.endsWith('/v1/models'),
      );
      if (successes.length === 0) {
        terminal = { isError: true, detail: '快照说 done，但账本里起针之后没有一次 2xx 的上游调用' };
      } else if (successes.some((r) => r.viaRelay === false)) {
        terminal = {
          isError: true,
          detail: '选择了平台，但成功的上游调用包含自有或直连来源，拒绝按平台成功入账',
        };
      } else if (successes.some((r) => r.viaRelay !== true)) {
        relayUnknown = '成功的上游调用缺少中继来源标记，实际额度来源核实不了';
      }
    }
  }
  // 中转把额度用完 / 欠费的通知当成回答回来（phase=done、error 为空，账本里照样是 2xx）：整段回答就是那条通知才算
  const relayQuota =
    report.terminal && !report.terminal.isError && report.route !== 'local'
      ? relayQuotaNotice(report.session.state.text)
      : undefined;
  const error = report.session.state.error;
  const words = report.watchError ?? error;
  const launch = report.launchError;
  // 因模型对不上被停的：把点名的和读回的两个串一起交给判定（读回的是服务端快照里的 model，不是我们猜的）
  const observed = report.session.state.model;
  const modelMismatch =
    report.killed?.reason === 'model_mismatch' && report.expectModel && observed
      ? { kind: 'model' as const, expected: report.expectModel, observed }
      : undefined;
  return {
    ...(modelMismatch ? { mismatch: modelMismatch } : {}),
    ...(launch ? (report.launchUnknown ? { launchUnknown: launch } : { spawnError: launch }) : {}),
    ...(report.killed
      ? { killed: report.killed.reason, ...(report.killed.cause ? { stopCause: report.killed.cause } : {}) }
      : {}),
    ...(terminal ? { terminal } : {}),
    quotaExhausted: looksLikeQuotaExhausted(error),
    ...(relayQuota ? { relayQuota } : {}),
    ...(words ? { lastWords: words } : {}),
    ...(relayUnknown ? { relayUnknown } : {}),
  };
}

/** 快照 usage 里的会话累计值（codex 给 sessionTotals；claude、dsh、pi、kimi 不给）。 */
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
 * 用量：有会话累计值（codex）就按上一轮求差（续跑不给上一轮就不带）；没有的只剩 turnOutputTokens（本轮累计输出），
 * 读不到就不带，不记成 0。claude、dsh 的快照里也有 inputTokens、cachedInputTokens，但那是最近一次上游调用的数、
 * 不是本轮合计（Mirasim 服务端每来一条助手消息就整个换掉），拿来记就是少记——输入、缓存照实不带（#1933）。
 * 账本（ledger.ts 读的流量账本）每行没有 token 字段；每次调用的真用量在 Mirasim 的用量账本里、靠中转计量事后回填，
 * 会话结束时多半还没有：这里只给会话结束那一刻读得到的，四样整套由引擎的定时任务「用量补记」凭会话号按中转计量补齐
 * （meter.ts、engine 的 jobs/usage-backfill.ts，#1935；docs/design.md 第十节「经 Mirasim 起的会话用量从哪读」）。
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
  return { ...base, usage: mirasimUsageFromSnapshot(report.session) };
}

/** 从真实 snapshot 的 usage 读本轮累计输出；没有 sessionTotals 的执行体只有这一项可靠。 */
export function mirasimUsageFromSnapshot(
  session: Pick<MirasimRunReport['session'], 'state'>,
): RunSummary['usage'] {
  const output = num(rec(session.state.usage)?.turnOutputTokens);
  return output === undefined ? {} : { outputTokens: output };
}
