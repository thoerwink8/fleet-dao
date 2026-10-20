// 空转判断（#3294 第 2 片，决定见 docs/design.md 第十二节「法国指挥官会话」）：额度超预算停下的单，判的是空转，不是钱。
// 创始人原话：「我不在乎预算，但是我在乎异常空转烧额度」。纯函数，只看这张单已有的回合和笔：
//  - 最近几个回合收场原因相同（同一个原因一直没过）；
//  - 返工意见基本重复（一遍一遍改同一件事）；
//  - 没有新提交：回合记着「没提交」，或 PR 头一直没换，或推上去的改动行数不再变；
//  - 同一个命令反复失败（返工意见里同一条命令连着红）。
// 信号至少两条才判空转：单条信号可能是巧合（比如连着两轮 CI 红但每轮都有新提交、改动行数在变），不拦；
// 回合数据不够（不足 SPIN_WINDOW 个）也不判空转，但 `enough: false` 带出去，调用方想保守时自己拿它当「没法判」。
// 这里不读库、不读时钟：回合由调用方从 task_rounds 读好传进来。

/** 看最近几个回合。 */
export const SPIN_WINDOW = 3;
/** 返工意见相似到这个程度算「基本重复」（字符二元组的 Jaccard）。 */
export const SPIN_SIMILARITY = 0.8;
/** 至少几条信号才判空转。 */
export const SPIN_MIN_SIGNALS = 2;

/** 一个回合收场时记下的东西（task_rounds 的一行，只留判断用得到的）。 */
export interface SpinRound {
  /** 收场原因（task_rounds.outcome：verify_rejected、ci_red、no_commit……）。 */
  outcome: string;
  /** 这一轮推上去的头；没记、没推过是 null。 */
  head?: string | null;
  /** 收场时 PR 相对主线新增的行数；没量成是 null。 */
  addedLines: number | null;
  /** 这一轮为什么返工（返工意见的头一截）；没写是 null。 */
  reworkSummary: string | null;
}

export type SpinSignalKind = 'same_outcome' | 'duplicate_rework' | 'no_new_commit' | 'repeated_command';

export interface SpinSignal {
  kind: SpinSignalKind;
  /** 给人和会话看的一句，带具体数。 */
  why: string;
}

export interface SpinJudgement {
  /** 判成空转：不许原样继续。 */
  spinning: boolean;
  /** 回合数据够不够判（至少 SPIN_WINDOW 个）。不够时 spinning 一定是 false。 */
  enough: boolean;
  signals: SpinSignal[];
  /** 一句话结论，带进诊断。 */
  summary: string;
}

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  verify_rejected: '冷验收没过',
  ci_red: 'CI 红',
  leftover: '工作树有剩下的改动',
  no_commit: '没有提交',
  push_conflict: '推分支冲突',
  merge_conflict: '合并冲突',
  timeout: '会话超时',
  stopped: '被叫停',
  other: '别的原因',
  merged: '已合并',
};

export const outcomeWord = (outcome: string): string => OUTCOME_WORDS[outcome] ?? outcome;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/#?\b[0-9a-f]{7,40}\b/g, '')
    .replace(/\d+/g, '0')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < text.length; i++) out.add(text.slice(i, i + 2));
  if (out.size === 0 && text.length > 0) out.add(text);
  return out;
}

/** 两段返工意见的相似度（0~1）：去掉提交号、数字、标点之后按字符二元组算 Jaccard。两段都空算不相似（没有意见可比）。 */
export function reworkSimilarity(a: string, b: string): number {
  const x = bigrams(normalize(a));
  const y = bigrams(normalize(b));
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both += 1;
  return both / (x.size + y.size - both);
}

/** 返工意见里点名的命令：反引号里的、或 pnpm / npx / npm / vitest / tsc / git / make / cargo / go / pytest 打头的一行。 */
export function commandsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{3,160})`/g)) {
    const cmd = (m[1] ?? '').trim();
    if (/^(pnpm|npx|npm|yarn|vitest|tsc|git|make|cargo|go|pytest|node|bash|sh)\b/.test(cmd))
      found.add(cmd.replace(/\s+/g, ' '));
  }
  for (const line of text.split('\n')) {
    const cmd = line.replace(/^[\s>$-]+/, '').trim();
    if (
      /^(pnpm|npx|npm|yarn|vitest|tsc|git|make|cargo|go|pytest|node|bash|sh)\b/.test(cmd) &&
      cmd.length <= 160
    )
      found.add(cmd.replace(/\s+/g, ' '));
  }
  return [...found];
}

function sameOutcome(window: readonly SpinRound[]): SpinSignal | null {
  const first = window[0]?.outcome;
  if (first === undefined || first === 'merged') return null;
  if (!window.every((r) => r.outcome === first)) return null;
  return { kind: 'same_outcome', why: `最近 ${window.length} 个回合都是「${outcomeWord(first)}」收场` };
}

function duplicateRework(window: readonly SpinRound[]): SpinSignal | null {
  const notes = window.map((r) => r.reworkSummary?.trim() ?? '');
  if (notes.some((n) => n === '')) return null;
  for (let i = 1; i < notes.length; i++) {
    if (reworkSimilarity(notes[i - 1] ?? '', notes[i] ?? '') < SPIN_SIMILARITY) return null;
  }
  return {
    kind: 'duplicate_rework',
    why: `最近 ${window.length} 个回合的返工意见基本一样（相似度都 ≥ ${SPIN_SIMILARITY}）`,
  };
}

function noNewCommit(window: readonly SpinRound[]): SpinSignal | null {
  if (window.every((r) => r.outcome === 'no_commit'))
    return { kind: 'no_new_commit', why: `最近 ${window.length} 个回合都没有提交` };
  const heads = window.map((r) => r.head ?? null);
  if (heads.every((h) => h !== null) && new Set(heads).size === 1)
    return {
      kind: 'no_new_commit',
      why: `最近 ${window.length} 个回合 PR 头都停在 ${(heads[0] ?? '').slice(0, 12)}，没有新提交`,
    };
  const lines = window.map((r) => r.addedLines);
  if (lines.every((n) => n !== null) && new Set(lines).size === 1)
    return { kind: 'no_new_commit', why: `最近 ${window.length} 个回合改动行数一直是 ${lines[0]}，不再变` };
  return null;
}

function repeatedCommand(window: readonly SpinRound[]): SpinSignal | null {
  const perRound = window.map((r) => new Set(commandsIn(r.reworkSummary ?? '')));
  const [firstRound, ...rest] = perRound;
  if (!firstRound) return null;
  for (const cmd of firstRound) {
    if (rest.every((set) => set.has(cmd)))
      return { kind: 'repeated_command', why: `最近 ${window.length} 个回合同一个命令一直失败：${cmd}` };
  }
  return null;
}

/** 按这张单已有的回合（旧的在前）判空转。 */
export function judgeSpin(rounds: readonly SpinRound[]): SpinJudgement {
  if (rounds.length < SPIN_WINDOW) {
    return {
      spinning: false,
      enough: false,
      signals: [],
      summary: `只有 ${rounds.length} 个回合，不足 ${SPIN_WINDOW} 个，看不出空转`,
    };
  }
  const window = rounds.slice(-SPIN_WINDOW);
  const signals = [
    sameOutcome(window),
    duplicateRework(window),
    noNewCommit(window),
    repeatedCommand(window),
  ].filter((s): s is SpinSignal => s !== null);
  const spinning = signals.length >= SPIN_MIN_SIGNALS;
  return {
    spinning,
    enough: true,
    signals,
    summary: spinning
      ? `判成空转（${signals.length} 条信号）：${signals.map((s) => s.why).join('；')}`
      : signals.length === 0
        ? `没有空转：最近 ${SPIN_WINDOW} 个回合收场原因、返工意见、提交都在变`
        : `没有空转（只有 1 条信号，不够判）：${signals.map((s) => s.why).join('；')}`,
  };
}
