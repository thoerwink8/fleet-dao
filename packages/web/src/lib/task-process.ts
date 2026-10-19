// 任务页「概览」和「过程」的说法与排法（#3140）：数都是后端算好的（shared 的 task-process.ts，接口回），这里只管怎么说、怎么排。
// 读到的照数写；读不到的由组件写「没读到」和原因，这里不出 0。
import { RUN_CAUSE_LABELS, toolClass } from '@fleet-dao/shared';
import type { EngineStep, ProcessStep, TaskOverview, TaskPr, TaskRound } from '../api/types';
import type { LayoutTone } from '../components/layout/tone';
import type { SegmentRunView } from './segments';

export type { TaskPr };

/** PR 横条上的状态：字和状态色（横条底色固定是 PR 的紫，状态色只给那颗标签）。 */
export const PR_STATE: Record<TaskPr['state'], { label: string; tone: LayoutTone; hint?: string }> = {
  merged: { label: '已合并', tone: 'done' },
  open: { label: '开着', tone: 'run' },
  failed: { label: '失败', tone: 'fail', hint: 'PR 还开着，但 CI 红了' },
  closed: { label: '已关闭', tone: 'stop', hint: '关了，没合并' },
  unknown: { label: '没读到状态', tone: 'doubt' },
};

/** 文件路径拆成「目录/」和文件名，行里文件名加粗、目录灰字。 */
export function fileParts(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** 增删小徽标的悬停话：有几次编辑没记行数，合计少了。 */
export function uncountedHint(uncounted: number): string | undefined {
  return uncounted > 0 ? `有 ${uncounted} 次编辑没记行数，+/- 合计比实际少` : undefined;
}

/** 单个调用一行的动词（灰字）：已运行 / 已读取 / 已编辑 / 创建……；还没结果是进行时，没成的写「没成」。 */
export function callVerb(tool: string | undefined, state: 'pending' | 'ok' | 'failed' | 'unknown'): string {
  const cls = toolClass(tool);
  const name = tool ?? '工具';
  if (state === 'failed') {
    return cls === 'command'
      ? '运行失败'
      : cls === 'read'
        ? '读取失败'
        : cls === 'edit'
          ? '编辑失败'
          : `${name} 没成`;
  }
  if (state === 'pending') {
    return cls === 'command'
      ? '正在运行'
      : cls === 'read'
        ? '正在读取'
        : cls === 'edit'
          ? '正在编辑'
          : cls === 'search'
            ? '正在搜索'
            : cls === 'agent'
              ? '正在派子代理'
              : `正在调用 ${name}`;
  }
  switch (cls) {
    case 'command':
      return '已运行';
    case 'read':
      return '已读取';
    case 'edit':
      return (tool ?? '').toLowerCase() === 'write' ? '创建' : '已编辑';
    case 'search':
      return '已搜索';
    case 'agent':
      return '已派';
    default:
      return `已调用 ${name}`;
  }
}

/** 缺标题的步骤写什么（先调工具的步骤已有「动词 对象」标题，这里是真的什么都没有）。 */
export const UNTITLED_STEP = '（没有说明，直接调用了工具）';

/** 一步的用时（毫秒）：结束了用算好的，在跑的按现在算。 */
export function stepDurationMs(step: ProcessStep, now: number): number {
  return step.durationMs ?? Math.max(0, now - Date.parse(step.startedAt));
}

/** 时间条：每段宽度按用时比例，最窄给总数的 1.5%，免得几秒的看不见；全是 0 就平分。 */
export function barWeights(ms: readonly number[]): number[] {
  const total = ms.reduce((a, b) => a + b, 0);
  if (total <= 0) return ms.map(() => 1);
  const floor = total * 0.015;
  return ms.map((v) => Math.max(v, floor));
}

// —— 回合 → 笔 → 引擎做的事 ——

/** 回合怎么收场的说法和状态色；名单是引擎的 RoundOutcome，认不出的原样写。 */
export const ROUND_OUTCOME: Record<string, { label: string; tone: LayoutTone }> = {
  merged: { label: '做成了', tone: 'done' },
  verify_rejected: { label: '验收没过', tone: 'fail' },
  ci_red: { label: 'CI 红了', tone: 'fail' },
  leftover: { label: '交活有剩', tone: 'stall' },
  no_commit: { label: '没提交', tone: 'fail' },
  push_conflict: { label: '推分支时冲突', tone: 'fail' },
  merge_conflict: { label: '等合并时冲突', tone: 'fail' },
  timeout: { label: '超时', tone: 'fail' },
  stopped: { label: '被叫停', tone: 'stop' },
  other: { label: '别的原因收场', tone: 'stall' },
};

export function roundOutcome(outcome: string): { label: string; tone: LayoutTone } {
  return ROUND_OUTCOME[outcome] ?? { label: outcome, tone: 'doubt' };
}

/**
 * 返工意见去掉开头和结局重复的那几个字：引擎记的意见常以结局开头（「CI 红了：……」），
 * 页面前面已经写了「上一回合 CI 红了」，再写一遍就成了「CI 红了——CI 红了：……」。没记意见给 undefined。
 */
export function reworkDetail(outcome: string, summary: string | undefined): string | undefined {
  const s = summary?.trim();
  if (!s) return undefined;
  const label = roundOutcome(outcome).label;
  if (!s.startsWith(label)) return s;
  const rest = s
    .slice(label.length)
    .replace(/^[\s：:，,。.—-]+/, '')
    .trim();
  return rest || undefined;
}

/** 引擎在会话外做的事，翻成白话。别的活动名原样写（不编）。 */
export const ACTIVITY_LABEL: Record<string, string> = {
  createWorktree: '建工作树',
  selfCheck: '自测',
  syncMainline: '并最新主线',
  pushBranch: '推分支',
  openPr: '开 PR',
  waitCi: '等 CI',
  coldVerify: '验收',
  armAutoMerge: '挂自动合并',
  waitMerged: '等合并',
  mergeNow: '合并',
  removeWorktree: '清工作树',
};

/** 等的是什么。 */
export const WAIT_LABEL: Record<string, string> = {
  human: '人',
  slot: '空位',
  quota: '额度',
  memory: '内存',
  none: '条件',
};

export const waitLabel = (waitFor: string): string => WAIT_LABEL[waitFor] ?? waitFor;

/**
 * 一笔为什么起：名单里的写白话；动手的老记录没记写「老记录没记起因」，不拿「主写」顶。
 * 只有动手这一段记起因（对题在对话里做、验收是冷调用，本来就没有），那两段返回 undefined，页面不写。
 */
export function causeLabel(
  run: Pick<SegmentRunView, 'cause' | 'segment'>,
): { text: string; recorded: boolean } | undefined {
  if (run.cause !== undefined) return { text: RUN_CAUSE_LABELS[run.cause], recorded: true };
  return run.segment === 'manual' ? { text: '老记录没记起因', recorded: false } : undefined;
}

/** 是新会话还是接上一笔的会话；两样都没记（老记录）返回 undefined，页面不替它猜。 */
export function sessionLink(run: Pick<SegmentRunView, 'resumed'>): '接上一笔的会话' | '新会话' | undefined {
  return run.resumed === undefined ? undefined : run.resumed ? '接上一笔的会话' : '新会话';
}

type ActivityStep = Extract<EngineStep, { kind: 'activity' }>;

export type TimelineItem =
  | { kind: 'run'; key: string; at: number; run: SegmentRunView }
  | { kind: 'engine'; key: string; at: number; step: ActivityStep }
  | {
      kind: 'waits';
      key: string;
      at: number;
      waitFor: string;
      count: number;
      totalMs: number;
      detail: string | undefined;
    };

export interface RoundGroup {
  key: string;
  /** 回合号（task_rounds.seq 或笔上记的 roundSeq）；没归回合的（老记录）是 undefined。 */
  seq: number | undefined;
  /** 库里这一回合的收场记录；没有是还没收场（进行中）。 */
  round: TaskRound | undefined;
  /** 上一回合没做成时它写的返工意见：这一回合是接着它返工的。 */
  reworkOf: { outcome: string; summary: string | undefined; seq: number } | undefined;
  items: TimelineItem[];
  /** 其中几笔笔上没记回合号（旧引擎跑的），是按回合收场时刻归进来的；页面照实写出来，不冒充是记下的。 */
  byTime?: number;
}

const ms = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso));
const sortKey = (n: number): number => (Number.isNaN(n) ? Number.POSITIVE_INFINITY : n);

/**
 * 把笔、回合、引擎做的事排成「回合 → 笔（和笔之间引擎做的事）」。
 * - 笔按 roundSeq 归回合；没记的（旧引擎跑的）按回合收场时刻归，归不进任何回合的单列一组放最前，不猜。
 * - 回合有收场记录的用记录里的结局、用时；没有的是进行中。
 * - 引擎做的事（自测、推分支、开 PR、等 CI……）按开始时刻放进它落在的那个回合，落在所有回合之外的放进最近的上一个。
 * - 连着的同一种等待折成一行（等内存每 30 秒记一行，页面写「等内存 N 次，共 X」）。
 */
export function buildTimeline(
  runs: readonly SegmentRunView[],
  overview: Pick<TaskOverview, 'rounds' | 'engineSteps'> | undefined,
): RoundGroup[] {
  const rounds = overview?.rounds.state === 'ok' ? overview.rounds.items : [];
  const engine = overview?.engineSteps.state === 'ok' ? overview.engineSteps.items : [];
  const bySeq = new Map<number, RoundGroup>();
  const orphan: RoundGroup = { key: 'old', seq: undefined, round: undefined, reworkOf: undefined, items: [] };
  const groupFor = (seq: number): RoundGroup => {
    let g = bySeq.get(seq);
    if (!g) {
      g = { key: `round-${seq}`, seq, round: undefined, reworkOf: undefined, items: [] };
      bySeq.set(seq, g);
    }
    return g;
  };
  const ended = [...rounds].sort((a, b) => a.seq - b.seq);
  for (const r of ended) groupFor(r.seq).round = r;
  // 还没收场的回合：笔上记了回合号、库里还没有它的收场记录，取号最大的那个
  const lastEndedSeq = ended.at(-1)?.seq ?? 0;
  const openSeq = Math.max(
    0,
    ...runs.map((r) => r.roundSeq ?? 0).filter((s) => s > lastEndedSeq && !ended.some((r) => r.seq === s)),
  );
  // 笔上没记回合号（旧引擎跑的）：按回合收场时刻归——第 N 回合管（第 N-1 回合收场, 第 N 回合收场]，第 1 回合从头算起，
  // 不看开始时刻；落在所有已收场回合之后的归还没收场的那个回合；都不沾的进「更早的几笔」。
  // 对题本来就不进回合，不按时间归。
  const homeByTime = (at: number): RoundGroup | undefined => {
    if (Number.isNaN(at)) return undefined;
    const r = ended.find((x, i) => {
      const from = i > 0 ? ms(ended[i - 1]?.endedAt) : -Infinity;
      return at > from && at <= ms(x.endedAt);
    });
    if (r) return groupFor(r.seq);
    const lastEnd = ms(ended.at(-1)?.endedAt);
    return openSeq > 0 && !(at <= lastEnd) ? groupFor(openSeq) : undefined;
  };
  for (const run of runs) {
    const item: TimelineItem = { kind: 'run', key: `run-${run.id}`, at: ms(run.startedAt), run };
    if (run.roundSeq !== undefined) {
      groupFor(run.roundSeq).items.push(item);
      continue;
    }
    const home = run.segment === 'scope' ? undefined : homeByTime(item.at);
    if (!home) {
      orphan.items.push(item);
      continue;
    }
    home.items.push(item);
    home.byTime = (home.byTime ?? 0) + 1;
  }
  const groups = [...bySeq.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  // 返工：上一回合没做成，这一回合顶上写它的返工意见
  groups.forEach((g, i) => {
    const prev = groups[i - 1]?.round;
    if (prev && prev.outcome !== 'merged') {
      g.reworkOf = { outcome: prev.outcome, summary: prev.reworkSummary, seq: prev.seq };
    }
  });
  // 回合的时间窗：开始 = 记录里的开始时刻，老行没有就退回第一笔的起跑；结束 = 收场时刻，进行中的没有
  const windows = groups.map((g) => {
    const firstRun = Math.min(...g.items.map((i) => i.at).filter((x) => !Number.isNaN(x)));
    const start =
      g.round?.startedAt !== undefined
        ? ms(g.round.startedAt)
        : Number.isFinite(firstRun)
          ? firstRun
          : Number.NaN;
    return { g, start, end: g.round ? ms(g.round.endedAt) : Number.NaN };
  });
  // 落在某个回合的时间窗里就归它；落在两个回合之间的空档：等待是在等着开下一回合的笔，归后面那个，别的活动归前面那个
  const homeOf = (at: number, isWait: boolean): RoundGroup => {
    const inside = windows.find((w) => at >= w.start && (Number.isNaN(w.end) || at <= w.end))?.g;
    if (inside) return inside;
    const next = windows.find((w) => w.start > at)?.g;
    const prev = [...windows].reverse().find((w) => at >= w.start)?.g;
    return (isWait ? (next ?? prev) : (prev ?? next)) ?? orphan;
  };
  const waitsOf = new Map<RoundGroup, TimelineItem[]>();
  for (const s of engine) {
    const at = ms(s.startedAt);
    const home = homeOf(at, s.kind === 'wait');
    if (s.kind === 'activity') {
      home.items.push({ kind: 'engine', key: `eng-${s.activity}-${s.startedAt}`, at, step: s });
    } else {
      waitsOf.set(home, [
        ...(waitsOf.get(home) ?? []),
        {
          kind: 'waits',
          key: `wait-${s.waitFor}-${s.startedAt}`,
          at,
          waitFor: s.waitFor,
          count: 1,
          totalMs: s.waitMs,
          detail: s.detail,
        },
      ]);
    }
  }
  const all = orphan.items.length > 0 || waitsOf.has(orphan) ? [orphan, ...groups] : groups;
  for (const g of all) {
    const merged = [...g.items, ...(waitsOf.get(g) ?? [])].sort((a, b) => sortKey(a.at) - sortKey(b.at));
    const folded: TimelineItem[] = [];
    for (const it of merged) {
      const last = folded.at(-1);
      if (it.kind === 'waits' && last?.kind === 'waits' && last.waitFor === it.waitFor) {
        folded[folded.length - 1] = {
          ...last,
          count: last.count + it.count,
          totalMs: last.totalMs + it.totalMs,
          detail: last.detail ?? it.detail,
        };
      } else folded.push(it);
    }
    g.items = folded;
  }
  return all;
}

/** 回合的用时（毫秒）：有收场时刻、又有开始时刻（老行退回第一笔的起跑）才有；进行中的没有。 */
export function roundDurationMs(g: Pick<RoundGroup, 'round' | 'items'>): number | undefined {
  if (!g.round) return undefined;
  const firstRun = g.items.find((i) => i.kind === 'run');
  const start = g.round.startedAt ?? (firstRun?.kind === 'run' ? firstRun.run.startedAt : undefined);
  if (start === undefined) return undefined;
  return Math.max(0, Date.parse(g.round.endedAt) - Date.parse(start));
}

/** 一笔的用时：收场的用算好的，在跑的按现在算；起止没读到的没有。 */
export function runDurationMs(run: SegmentRunView, now: number): number | undefined {
  if (run.durationMs !== undefined) return run.durationMs;
  return run.running && run.startedAt !== undefined
    ? Math.max(0, now - Date.parse(run.startedAt))
    : undefined;
}

/** 一个回合的五步（#3169）：页头下面那条「这一回合走到哪」。 */
/** 第几笔：整张单的笔按起跑先后一起数（三段不分开），过程和页头进度条同一个数。 */
export function runOrder(runs: readonly SegmentRunView[]): Map<string, number> {
  return new Map(
    [...runs]
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
      .map((r, i) => [r.id, i + 1] as const),
  );
}

export const ROUND_STAGES = ['动手', '自测', '推分支 · CI', '验收', '合并'] as const;
export type RoundStageState = 'done' | 'now' | 'todo' | 'failed';

/** 一笔、一件引擎做的事落在五步里的哪一步；认不出的（等待、清工作树之外的新活动）不推进。 */
const STAGE_OF_ACTIVITY: Record<string, number> = {
  createWorktree: 0,
  selfCheck: 1,
  syncMainline: 2,
  pushBranch: 2,
  openPr: 2,
  waitCi: 2,
  coldVerify: 3,
  armAutoMerge: 4,
  waitMerged: 4,
  mergeNow: 4,
};

function stageOf(item: TimelineItem): number | undefined {
  if (item.kind === 'run') {
    return item.run.segment === 'manual' ? 0 : item.run.segment === 'verify' ? 3 : undefined;
  }
  if (item.kind === 'engine') return STAGE_OF_ACTIVITY[item.step.activity];
  return undefined;
}

export interface RoundProgress {
  /** 第几回合（task_rounds.seq；还没开跑的下一回合是上一回合 + 1）。 */
  seq: number;
  /** 五步各自的状态，和这一回合里落在这一步的笔、引擎做的事（页面拿它写每格第二行：用了多久、第几笔在跑）。 */
  stages: { label: (typeof ROUND_STAGES)[number]; state: RoundStageState; items: TimelineItem[] }[];
  /** 这一回合是返工：上一回合怎么收场、返工意见（老行没有意见）。 */
  reworkOf: RoundGroup['reworkOf'];
  /** 一句话：在做哪一步 / 合并了 / 停在哪。 */
  note: string;
}

/**
 * 这一回合走到哪（#3169）：取 buildTimeline 的最后一个回合。回合里最后到过的那一步之前的都算做完；
 * 回合还没收场是「在做」，单子已经停了（叫停、失败）是「没成」；合并收场五步全做完；
 * 返工收场、单子还在走，是下一回合还没开跑，停在动手。没有回合记录的老单回 undefined，不画、不猜。
 */
export function roundProgress(groups: readonly RoundGroup[], taskState: string): RoundProgress | undefined {
  const last = [...groups].reverse().find((g) => g.seq !== undefined);
  if (!last || last.seq === undefined) return undefined;
  const reached = Math.max(-1, ...last.items.map(stageOf).filter((s): s is number => s !== undefined));
  const stopped = taskState === 'stopped' || taskState === 'failed';
  const itemsAt = ROUND_STAGES.map((_, i) => last.items.filter((it) => stageOf(it) === i));
  const build = (upTo: number, at: RoundStageState, fresh = false) =>
    ROUND_STAGES.map((label, i) => ({
      label,
      state: (i < upTo ? 'done' : i === upTo ? at : 'todo') as RoundStageState,
      // 下一回合还没开跑：格子里不放上一回合的东西
      items: fresh ? [] : (itemsAt[i] ?? []),
    }));
  if (last.round?.outcome === 'merged') {
    return {
      seq: last.seq,
      stages: build(ROUND_STAGES.length, 'done'),
      reworkOf: last.reworkOf,
      note: '合并了',
    };
  }
  if (last.round) {
    const outcome = roundOutcome(last.round.outcome).label;
    if (stopped || taskState === 'done') {
      return {
        seq: last.seq,
        stages: build(Math.max(0, reached), 'failed'),
        reworkOf: last.reworkOf,
        note: `${outcome}，停在${ROUND_STAGES[Math.max(0, reached)]}`,
      };
    }
    return {
      seq: last.seq + 1,
      stages: build(0, 'now', true),
      reworkOf: { outcome: last.round.outcome, summary: last.round.reworkSummary, seq: last.seq },
      note: '返工，下一笔动手还没开跑',
    };
  }
  const at = Math.max(0, reached);
  return {
    seq: last.seq,
    stages: build(at, stopped ? 'failed' : 'now'),
    reworkOf: last.reworkOf,
    note: stopped ? `停在${ROUND_STAGES[at]}` : `在${ROUND_STAGES[at]}`,
  };
}
