// 一段会话 scope 自己的内存事件见证（#3448）：会话跑着时读它 scope 的 memory.events.local，收场再读一次，
// 把「这个 scope 里有没有发生过内存 OOM 事件」连同怎么读到的、读得全不全，一起交给 result.json。
//
// 改这里之前必须知道：
// - 只证明「这个 scope 里有 OOM 事件」。被杀的是主进程还是 tsc，这里不知道（cgroup 计数没有进程号）：终止来源永远写 unknown，
//   不能拿它、退出码 137/143、内存峰值、时间邻近去证明某个进程是被 OOM 杀的。
// - 绑定的是实际起的那个 scope：路径只由 scopeId 拼出 fleet-agent-<id>.scope 下的 memory.events.local / memory.events，
//   从不读父 slice、兄弟 scope。cgroup v2 里 memory.events 是层级统计（含子孙），memory.events.local 才是本层本地事件：
//   判断只看 local；层级那份只作旁证单列，不顶替 local。
// - scope 是 --collect 起的，收场后文件会消失，所以边跑边读、收场再读一次。读不到的每一种（还没建出来、收场后没了、拒绝读取、
//   内容非法、计数缺项或回退）都记进 problems 和完整性，不吞成「没有事件」。
// - 首读时计数就不是 0：分不清是 scope 重用、还是首读前就发生了，判 unknown，计数照记；计数中途回退同样判 unknown。
// - 文字刻意不写会触发 failure/rules.ts 里 oom_killed 文本判法的词（含「oom」后紧跟「kill」的写法）：字段叫 oomEvents / killedProcs。
//   这份见证只进 result.json 和日志，不进 stderr、failureReason、detail。
// - 读不成、保全失败都不改会话的退出事实，调用方（segment-spawner）兜住所有抛错。
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { AGENT_SLICE_PATH, CGROUP_ROOT } from './memory-admission.ts';

/** 采样间隔：和内存峰值、CPU 同一档。 */
export const SCOPE_OOM_INTERVAL_MS = 500;

export interface ScopeOomDeps {
  readText(path: string): Promise<string>;
  cgroupRoot: string;
  slicePath: string;
  intervalMs: number;
  now?: () => Date;
}

export function productionScopeOom(overrides: Partial<ScopeOomDeps> = {}): ScopeOomDeps {
  return {
    readText: (path) => readFile(path, 'utf8'),
    cgroupRoot: CGROUP_ROOT,
    slicePath: AGENT_SLICE_PATH,
    intervalMs: SCOPE_OOM_INTERVAL_MS,
    ...overrides,
  };
}

/** Mirasim 的模型会话不在本机 run scope 里（本机只有短命桥接）：不读、不写 0。 */
export const MIRASIM_OOM_UNREAD =
  'Mirasim 路不经本机 scope，scope 内存事件见证不支持：模型会话在 Mirasim 服务里，本机只有短命桥接，不伪造 0';

export interface ScopeOomCounts {
  /** memory.events 的 oom：内存分配走到 OOM 处理的次数。 */
  oomEvents: number;
  /** memory.events 的 oom_kill：被内核杀掉的进程数（不知道是哪个进程）。 */
  killedProcs: number;
}

export type ScopeOomVerdict =
  /** 本地计数在读到的窗口里增加了：这个 scope 里发生过 OOM 事件（不等于主进程是被它杀的）。 */
  | 'oom_events_in_scope'
  /** 读到的窗口里本地计数没动。完整性是 complete 才算读全了。 */
  | 'none_observed'
  /** 没读到、读不全、认不出或对不上这个 scope：不知道有没有。 */
  | 'unknown'
  /** 这一路不经本机 run scope。 */
  | 'unsupported';

export interface ScopeOomEvidence {
  verdict: ScopeOomVerdict;
  /** complete = 收场那一读读成且全程没有问题；partial = 读到过但有缺口；unknown = 一次都没读成（或不支持）。 */
  integrity: 'complete' | 'partial' | 'unknown';
  runId: string;
  /** 传给 systemd 的原始 scope id；和 runId 一起核对实际受管单元。 */
  scopeId: string;
  /** 实际受管的 scope 单元名。 */
  scope: string;
  /** 证据来源：scope 自己的本地事件文件；不支持时不写。 */
  source?: 'memory.events.local';
  sourcePath?: string;
  /** 从哪个时刻起看：start = 跟着会话一起起的采样；attach = 引擎接回后才开始（之前的事件看不到）。 */
  window: 'start' | 'attach';
  firstReadAt?: string;
  /** 最后一次读成本地计数的时刻（观测时刻）。 */
  observedAt?: string;
  reads: number;
  /** 收场那一读：ok 读成、gone 文件已不在（scope 被 --collect 收走）、failed 读不成。 */
  finalRead: 'ok' | 'gone' | 'failed';
  /** 第一次读成之前文件还不在的次数；这段窗口没有证据，不能判完整无事件。 */
  missingBeforeFirstRead: number;
  /** 第一次读成的本地计数。 */
  baseline?: ScopeOomCounts;
  /** 最后一次读成的本地计数。 */
  last?: ScopeOomCounts;
  /** last − baseline。 */
  delta?: ScopeOomCounts;
  /** memory.events（层级，含子孙）最后一次读成的计数：只作旁证，不参与判断。 */
  hierarchical?: ScopeOomCounts;
  /** 终止来源永远未知：计数里没有进程号。 */
  killTarget: 'unknown';
  problems: string[];
  note: string;
}

const NOTE_KILL_UNKNOWN = '被杀的是哪个进程、主执行体是否因此退出，这份见证证明不了（终止来源未知）';
const MAX_PROBLEMS = 8;

/** 报错里可能带着读到的原文（含 key 名）：打上标记，免得写进见证的文字意外命中 oom_killed 的文本判法。 */
const defuse = (raw: string) =>
  raw.replace(/oom([-_ ]?)kill/gi, 'oom~$1~kill').replace(/out of memory/gi, 'out~of~memory');

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** memory.events(.local) 的 oom、oom_kill 两行；缺项、重复、不是非负整数、行不认识都抛。别的 key（low、high、max……）忽略。 */
export function parseScopeOomCounts(text: string): ScopeOomCounts {
  const seen = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([a-z_]+) (\d+)$/.exec(line);
    if (!m) throw new Error(`memory.events 的行认不出：${JSON.stringify(line.slice(0, 80))}`);
    const key = m[1] as string;
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n))
      throw new Error(`memory.events 的 ${key} 太大，认不出：${(m[2] as string).slice(0, 40)}`);
    if (seen.has(key)) throw new Error(`memory.events 的 ${key} 出现了不止一行`);
    seen.set(key, n);
  }
  const oomEvents = seen.get('oom');
  const killedProcs = seen.get('oom_kill');
  if (oomEvents === undefined || killedProcs === undefined) {
    throw new Error(
      `memory.events 缺 oom 或被杀进程数那一行（前 80 字节）：${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  return { oomEvents, killedProcs };
}

export function scopeEventsPath(
  deps: Pick<ScopeOomDeps, 'cgroupRoot' | 'slicePath'>,
  scopeId: string,
  file: 'memory.events.local' | 'memory.events' = 'memory.events.local',
): string {
  if (!SCOPE_ID.test(scopeId)) throw new Error(`scope id 认不出：${scopeId}`);
  return posix.join(deps.cgroupRoot, deps.slicePath, `fleet-agent-${scopeId}.scope`, file);
}

/** 没有可读证据（不支持、保全抛错）时的占位：不写计数。 */
export function unavailableScopeOom(
  runId: string,
  scopeId: string,
  verdict: 'unknown' | 'unsupported',
  why: string,
  window: 'start' | 'attach' = 'start',
): ScopeOomEvidence {
  if (!SCOPE_ID.test(scopeId)) throw new Error(`scope id 认不出：${scopeId}`);
  return {
    verdict,
    integrity: 'unknown',
    runId,
    scopeId,
    scope: `fleet-agent-${scopeId}.scope`,
    window,
    reads: 0,
    finalRead: 'failed',
    missingBeforeFirstRead: 0,
    killTarget: 'unknown',
    problems: [defuse(why)],
    note: `${defuse(why)}；${NOTE_KILL_UNKNOWN}`,
  };
}

/**
 * 开始采样这个 scope 的 memory.events.local；会话收场后调 stop() 拿见证。stop() 里再读一次，之后不再读；stop 可重复调，返回同一份。
 * 不抛：所有读错、解析错都记进 problems。
 */
export function sampleScopeOom(
  deps: ScopeOomDeps,
  ids: { runId: string; scopeId: string; window?: 'start' | 'attach' },
): { stop(): Promise<ScopeOomEvidence> } {
  const { runId, scopeId } = ids;
  const window = ids.window ?? 'start';
  const now = deps.now ?? (() => new Date());
  const localPath = scopeEventsPath(deps, scopeId, 'memory.events.local');
  const treePath = scopeEventsPath(deps, scopeId, 'memory.events');
  let reads = 0;
  let missingBeforeFirstRead = 0;
  let baseline: ScopeOomCounts | undefined;
  let last: ScopeOomCounts | undefined;
  let firstReadAt: string | undefined;
  let observedAt: string | undefined;
  let hierarchical: ScopeOomCounts | undefined;
  let regressed = false;
  const problems: string[] = [];
  let lastReadOutcome: 'ok' | 'gone' | 'failed' = 'failed';
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let evidence: Promise<ScopeOomEvidence> | undefined;

  const problem = (raw: string) => {
    const text = defuse(raw);
    if (problems.length < MAX_PROBLEMS && !problems.includes(text)) problems.push(text);
  };

  const readOnce = async (): Promise<void> => {
    try {
      const counts = parseScopeOomCounts(await deps.readText(localPath));
      const at = now().toISOString();
      reads += 1;
      lastReadOutcome = 'ok';
      if (!last) {
        baseline = counts;
        firstReadAt = at;
      } else if (counts.oomEvents < last.oomEvents || counts.killedProcs < last.killedProcs) {
        regressed = true;
        problem(
          `本地计数回退（oom ${last.oomEvents}→${counts.oomEvents}，被杀进程数 ${last.killedProcs}→${counts.killedProcs}）：可能不是同一个 scope`,
        );
        return;
      }
      last = counts;
      observedAt = at;
    } catch (err) {
      if (isMissing(err)) {
        lastReadOutcome = 'gone';
        if (!last) missingBeforeFirstRead += 1;
      } else {
        lastReadOutcome = 'failed';
        problem(`${localPath} 读不成或认不出：${message(err)}`);
      }
      return;
    }
    // 层级那份只作旁证：读不成不影响判断，也不记成问题
    try {
      hierarchical = parseScopeOomCounts(await deps.readText(treePath));
    } catch {
      // 旁证缺了就缺了
    }
  };
  const tick = () => {
    if (stopped) return;
    inFlight = inFlight.then(readOnce, readOnce);
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs);
  timer.unref?.();

  const build = async (): Promise<ScopeOomEvidence> => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
    // 收场再读一次：scope 还在就读到最后一段；已被 --collect 收走就用跑着时的
    await readOnce();
    const finalRead = lastReadOutcome;
    if (finalRead === 'gone' && last)
      problem('收场时文件已不在（scope 被收走），最后一次读数之后的事件看不到');
    if (missingBeforeFirstRead > 0)
      problem(`首次采样时文件尚未创建（${localPath}），首次成功读数前的事件无法核对`);
    if (window === 'attach') problem('引擎接回后才开始读，接回之前的事件看不到');
    const base = {
      runId,
      scope: `fleet-agent-${scopeId}.scope`,
      window,
      reads,
      finalRead,
      missingBeforeFirstRead,
      killTarget: 'unknown' as const,
    };
    if (!baseline || !last) {
      if (missingBeforeFirstRead > 0) {
        problem(`${localPath} 从头到尾都不在（这台没有 cgroup，或 scope 没建出来）`);
      } else if (problems.length === 0) {
        problem(`收场前一次都没读成（${localPath}）`);
      }
      const why = problems.join('；');
      return {
        ...base,
        verdict: 'unknown',
        integrity: 'unknown',
        scopeId,
        source: 'memory.events.local',
        sourcePath: localPath,
        problems: [...problems],
        note: `没读到这个 scope 的内存事件计数：${why}；${NOTE_KILL_UNKNOWN}`,
      };
    }
    const delta: ScopeOomCounts = {
      oomEvents: last.oomEvents - baseline.oomEvents,
      killedProcs: last.killedProcs - baseline.killedProcs,
    };
    const baselineZero = baseline.oomEvents === 0 && baseline.killedProcs === 0;
    if (!baselineZero) {
      problem('首读时计数就不是 0：分不清是 scope 重用还是首读前已发生，不能认作这一次运行的事件');
    }
    const complete = finalRead === 'ok' && problems.length === 0;
    let verdict: ScopeOomVerdict;
    let note: string;
    if (regressed || !baselineZero) {
      verdict = 'unknown';
      note = `这个 scope 的计数对不上，不能认作这一次运行的事件：${problems.join('；')}；${NOTE_KILL_UNKNOWN}`;
    } else if (delta.oomEvents > 0 || delta.killedProcs > 0) {
      verdict = 'oom_events_in_scope';
      note = `这个 scope（${base.scope}）自己的本地计数里有 OOM 事件（oom ${delta.oomEvents} 次、被杀进程 ${delta.killedProcs} 个）；${NOTE_KILL_UNKNOWN}`;
    } else if (complete) {
      verdict = 'none_observed';
      note = `读到的窗口里这个 scope 的本地计数没有 OOM 事件（${reads} 次读数，收场那一读也读成了）`;
    } else {
      verdict = 'unknown';
      note = `读到的计数没动，但读得不全，不能说没有事件：${problems.join('；')}`;
    }
    return {
      ...base,
      scopeId,
      verdict,
      integrity: complete ? 'complete' : 'partial',
      source: 'memory.events.local',
      sourcePath: localPath,
      ...(firstReadAt ? { firstReadAt } : {}),
      ...(observedAt ? { observedAt } : {}),
      baseline,
      last,
      delta,
      ...(hierarchical ? { hierarchical } : {}),
      problems: [...problems],
      note,
    };
  };

  return {
    stop() {
      evidence ??= build();
      return evidence;
    },
  };
}
