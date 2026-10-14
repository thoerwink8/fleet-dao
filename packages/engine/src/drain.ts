// 发布不白杀在干的活：要切版本时，引擎马上不起新会话（k8s 先 cordon 再 drain 的同一个思路），发布脚本同时给手上有会话的任务发
// hard 暂停，停不下来的会话接着做手上这一步；最多等一小段宽限（RELEASE_GRACE_MS），到点还没做完的按切号那一套停下（交回 engine_stop，失败分流 KL3 不记账、
// 新引擎起来按编号续同一个会话），然后照发。发完新引擎起来就接着派；发布没成，请求一撤马上接着派。
// 这一份只管「在不在排空、截止到几点、手上还有哪些会话」；谁来叫排空、到点怎么停在 drain-control.ts，状态文件在 drain-file.ts。
// 改这里之前必须知道：
// - 叫排空的有三处：发布脚本写的排空请求（deploy/release.sh，构建完、切版本之前写，同时给手上有会话的任务发 hard 暂停）、systemd 的停机信号
//   （发布切版本、人手动重启、关机）、命令行工具升级（空闲时引擎自己挂上，升完撤；到了截止也不停会话）。
//   停机信号比发布高，发布比升级高。低的改不了高的。同一个来源只会把截止提前、不会推后。
//   发布或停机接手升级时用它们自己的截止：升级那段短钟是用来等装完的，接手以后不能拿它去停会话。
//   停机信号来的撤不掉；发布请求来的，请求撤了就撤（不连带把升级排空撤掉）。升级来的只由升级任务撤。
// - 只数这个工人进程手上的会话（起会话过了闸、还没交回工作流的）：在等额度、等空位、等人的单子不算在跑，照常算空闲
//   （帅位：拼车用满时法国多半在等额度，不能把它们当成在跑）。
// - 会话是这个进程起的（sudo → fleet-agent-scope → 会话），输出管道接在这个进程上：进程一退就接不上了。所以「等会话做完」
//   只能在这个进程里等，systemd 那头要 KillMode=mixed（停机信号只给主进程；control-group 会把 SIGTERM 发给每个 sudo，sudo 原样
//   转给会话，会话当场就死，出过两次）。TimeoutStopSec 要盖住宽限加收尾（fleet-engine.service，
//   test/drain.test.ts 核对）。
// - 会话有两路登记进来：Fusion 老会话在 real/session-launch.ts（startSession），三段的一次性会话（动手、验收）在
//   real/one-shot-sessions.ts（enter/leave，#957）。少接一路，排空就看不见那一路、会提前放行；到点停会话也是两路各停各的
//   （real/index.ts 的 stopSessions）。
// - 这里只管 AI 会话。等 CI、建树这类活动工人停下时照 Temporal 的规矩取消、到新进程上重试，丢不了干过的活。

/**
 * 宽限：发布脚本写排空请求（或者停机信号来）之后，停不下来的会话最多再做这么久。2 分钟（#2038、决定 0093）：发布脚本写请求的同时
 * 给手上有会话的任务发 hard 暂停（动手会话当场停、按会话号续上），剩下要等的只是不可暂停的那几段（验收这类）；
 * 构建在写请求之前跑完，不占这段。到点没做完的停下、按编号续上，丢的只是手上那一小步。
 */
export const RELEASE_GRACE_MS = 2 * 60_000;
/** 到点停下以后等看守把结局交回工作流最多这么久，再让工人停下（插头收进程、看守写库要一点时间）。 */
export const STOP_REPORT_MS = 2 * 60_000;
/** 多久看一次排空请求、截止到没到（有会话收场时当场醒，不等到点）。 */
export const DRAIN_POLL_MS = 5_000;
/** 引擎在排空时，选路隔多久再选：新引擎起来、或者请求撤了，下一次就选得到。 */
export const DRAIN_ROUTE_RETRY_SECONDS = 30;

export type CordonSource = 'release' | 'signal' | 'cli-upgrade';

/** 停机信号最高，发布其次，命令行工具升级最低。低的改不了已经挂着的高的。 */
function sourceRank(source: CordonSource): number {
  if (source === 'signal') return 2;
  if (source === 'release') return 1;
  return 0;
}

export interface Cordon {
  /** release = 发布脚本的排空请求；signal = systemd 的停机信号（撤不掉）；cli-upgrade = 升级命令行工具（到点不停会话）。 */
  source: CordonSource;
  /** 从什么时候起不起新会话（ISO）。 */
  since: string;
  /** 截止（ISO）：过了这一刻还在跑的会话停下、按编号续上。 */
  until: string;
  why: string;
  /** 发布请求要发的提交。 */
  sha?: string;
}

export interface InFlightSession {
  runId: string;
  stage: string;
  taskId: string;
  /** starting = 起会话这一步还在跑（建树）；running = 进程起来了，还没交回工作流。 */
  phase: 'starting' | 'running';
  /** 这一段从什么时候起（ISO）。 */
  since: string;
}

export interface EngineDrain {
  /** 在排空吗：在排空就不起新会话。 */
  stopping(): Cordon | null;
  /** 在排空、而且过了截止：还在跑的该停下了。 */
  overdue(nowMs: number): boolean;
  /** 开始排空，或者更新。同一个来源截止只提前不推后；更高的来源接手。低的来源改不了已经挂着的高的。有变化返回 true。 */
  cordon(c: Cordon): boolean;
  /**
   * 撤掉这个来源的排空。不写来源时只撤发布的：停机信号撤不掉，升级排空也不跟着发布请求一起撤。撤了返回 true。
   */
  lift(source?: CordonSource): boolean;
  /** 起会话过了闸就登记；同一个 runId 再登记是改它的阶段。 */
  track(session: InFlightSession): void;
  /** 会话交回工作流了（或者没起来）：不再等它。没登记过的不算错。 */
  settle(runId: string): void;
  inFlight(): InFlightSession[];
  /** 排空的开始、更新、撤掉，登记、交回都会通知；返回退订。 */
  onChange(listener: () => void): () => void;
}

export function createEngineDrain(): EngineDrain {
  let cordon: Cordon | null = null;
  const sessions = new Map<string, InFlightSession>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 通知只是叫醒等的人、写状态文件；它出错不影响排空本身
      }
    }
  };
  return {
    stopping: () => cordon,
    overdue(nowMs) {
      if (!cordon) return false;
      const until = Date.parse(cordon.until);
      // 截止认不出就当已经到了：宁可早停（会话按编号续上），不拿「没截止」当「一直等」
      return Number.isNaN(until) || nowMs >= until;
    },
    cordon(c) {
      if (!cordon) {
        cordon = { ...c };
        changed();
        return true;
      }
      const old = cordon;
      const oldRank = sourceRank(old.source);
      const newRank = sourceRank(c.source);
      if (newRank < oldRank) return false;
      // 升级排空不杀会话。发布或停机接手时用它们自己的截止，不把升级那一段短钟继承过来再拿去停会话。
      // 其余（停机接手发布、同一个来源）仍是截止只提前不推后。
      const adoptUntil = newRank > oldRank && old.source === 'cli-upgrade';
      const until = adoptUntil || Date.parse(c.until) < Date.parse(old.until) ? c.until : old.until;
      const source: CordonSource = newRank > oldRank ? c.source : old.source;
      const why = source !== old.source ? `${old.why}；${c.why}` : old.why;
      const sha = newRank > oldRank ? c.sha : old.sha;
      if (until === old.until && source === old.source && why === old.why && sha === old.sha) return false;
      const next: Cordon = { source, since: old.since, until, why };
      if (sha) next.sha = sha;
      cordon = next;
      changed();
      return true;
    },
    lift(source: CordonSource = 'release') {
      if (cordon?.source !== source) return false;
      cordon = null;
      changed();
      return true;
    },
    track(session) {
      sessions.set(session.runId, { ...session });
      changed();
    },
    settle(runId) {
      if (sessions.delete(runId)) changed();
    },
    inFlight: () => [...sessions.values()],
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 选路、起会话被拒时给人看的一句（驾驶舱「在等什么」、失败原因里都是这一句）。 */
export function stoppingNote(c: Cordon): string {
  if (c.source === 'cli-upgrade') {
    return `在升级命令行工具（${c.why}）：${c.since} 起不起新会话，升完接着派（在跑的会话不停）`;
  }
  const what = c.source === 'release' ? `要发新版本（${c.why}）` : `引擎在停（${c.why}）`;
  return `${what}：${c.since} 起不起新会话，在跑的最晚做到 ${c.until}，新引擎起来接着派`;
}

/** 截止：从现在起宽限这么久。 */
export function deadlineFrom(nowMs: number, graceMs: number = RELEASE_GRACE_MS): string {
  return new Date(nowMs + graceMs).toISOString();
}

export type DrainEnd =
  /** 手上没有会话了。 */
  | 'empty'
  /** 到了截止、停下以后等交回也等到了上限：照停，没交回的新引擎起来按编号续上。 */
  | 'overdue'
  /** 又收到一次停机信号：不等了。 */
  | 'forced';

export interface WaitDrainedOptions {
  /** 到了截止怎么停下还在跑的会话（切号那一套，交回 engine_stop）；返回这次叫停的。 */
  stopSessions(why: string): string[];
  forced(): boolean;
  now?: () => number;
  pollMs?: number;
  stopReportMs?: number;
  /** 睡一觉；醒得早（有会话收场、又来了停机信号）由 wake 叫醒。 */
  sleep?: (ms: number, wake: Promise<void>) => Promise<void>;
  /** 每醒一次报一下还在等谁。 */
  onTick?(waiting: InFlightSession[], nowMs: number): void;
  /** 到截止叫停了哪些。 */
  onStopped?(runIds: string[]): void;
}

const defaultSleep = (ms: number, wake: Promise<void>) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void wake.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * 停机时等排空：手上没会话就停；到了截止先把还在跑的停下（stopSessions），再等它们交回最多 stopReportMs；被叫停（第二次信号）
 * 马上停。交回怎么结束的、还剩下谁（照停时断掉的就是它们，新引擎起来按编号续上）。不抛。
 */
export async function waitDrained(
  drain: EngineDrain,
  options: WaitDrainedOptions,
): Promise<{ end: DrainEnd; left: InFlightSession[] }> {
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? DRAIN_POLL_MS;
  const stopReportMs = options.stopReportMs ?? STOP_REPORT_MS;
  const sleep = options.sleep ?? defaultSleep;
  let stoppedAt: number | null = null;
  for (;;) {
    const t = now();
    if (options.forced()) return { end: 'forced', left: drain.inFlight() };
    const inFlight = drain.inFlight();
    if (inFlight.length === 0) return { end: 'empty', left: [] };
    if (drain.overdue(t)) {
      if (stoppedAt === null) stoppedAt = t;
      // 每一圈都叫一次：截止之后才起来的进程也停下（已经在停的不重复叫）
      const stopped = options.stopSessions('到了发布宽限的截止');
      if (stopped.length > 0) options.onStopped?.(stopped);
      if (t - stoppedAt >= stopReportMs) return { end: 'overdue', left: inFlight };
    }
    options.onTick?.(inFlight, t);
    let unsubscribe: () => void = () => {};
    const wake = new Promise<void>((resolve) => {
      unsubscribe = drain.onChange(resolve);
    });
    const until = Date.parse(drain.stopping()?.until ?? '');
    const toDeadline = stoppedAt === null && Number.isFinite(until) ? Math.max(0, until - t) : pollMs;
    try {
      await sleep(Math.max(1, Math.min(pollMs, toDeadline)), wake);
    } finally {
      unsubscribe();
    }
  }
}

/** 引擎写给发布脚本、演练看的排空状态（FLEET_ENGINE_STATE_DIR 下的 drain.json）：在不在排空、截止到几点、手上还有谁。 */
export interface DrainStatus {
  schema: 2;
  /** 写这份的引擎进程号：发布脚本拿它和 systemd 的 MainPID 比，对上了才信（对不上就是上一个进程留下的）。 */
  pid: number;
  writtenAt: string;
  cordon: Cordon | null;
  /** 在排空、而且过了截止。 */
  overdue: boolean;
  sessions: InFlightSession[];
}

export function drainStatus(drain: EngineDrain, meta: { pid: number; nowMs: number }): DrainStatus {
  return {
    schema: 2,
    pid: meta.pid,
    writtenAt: new Date(meta.nowMs).toISOString(),
    cordon: drain.stopping(),
    overdue: drain.overdue(meta.nowMs),
    sessions: drain.inFlight(),
  };
}
