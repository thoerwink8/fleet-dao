// 一次性回填（#1948）：#1946 上线前结束的 run 没有会话号，定时任务「用量补记」对不上账本。
// 按分支名最后一段（工作树目录名）加这一笔的起止，对上用量账本里 workspace 目录名相同、时刻落在起止之间的会话。
// 对上唯一一个才补；只填还空着的字段，已有的数和 usage_note 一律不动，不写会话号（写了会被定时任务整套覆盖）。
// 对不上、对上不止一个、还在等回填或认不出的，只写原因，不猜。已经写过原因、又补不上的，再跑不改。
// 默认只读。退出码：0 查完了（只读或已写）；1 账本或库没查成，一行都没写；2 参数不对，不连库。

import { meterReadingFrom, meterSessionUuid } from '@fleet-dao/adapters';
import type { HistoricalMeterRun, MeterUsageWrite } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';

export const USAGE_BACKFILL_ONCE_USAGE =
  '用法：fleet-api usage-backfill-once [--apply]（默认只读，列出会改哪些行；加 --apply 才写。按分支名最后一段加起止对上 Mirasim 用量账本里的会话，只补还空着的输入、输出、缓存、花费，已有的数和原因不动；对不上或对上不唯一的写 usage_note，不猜）';

/** 筛账本的关键字：grep -F 的 -e，不许空白、不许以 - 开头（和 real/index.ts 的 grepAsUser 同一条）。 */
const NEEDLE = /^[0-9A-Za-z][0-9A-Za-z_:.-]*$/;

const NO_BRANCH = '对不上：没有分支名，对不上 Mirasim 用量账本里的会话';
const BAD_LEAF = '对不上：分支名最后一段含筛不了账本的字符，不猜';
const NO_SESSION = '对不上：Mirasim 用量账本里没有这个分支在这一笔起止之间的会话';
const UNREADABLE = '对不上：账本里有这个分支在这一笔起止之间的一行认不出会话号，不猜';

export interface UsageBackfillOnceDeps {
  /** db 的 runsAwaitingHistoricalMeter。 */
  pending(): Promise<HistoricalMeterRun[]>;
  /**
   * 账本里含任一个 needle 的行（原文，换行分隔）。一行都没有回空串。
   * 读不了照抛：这一次一行都不写，不拿空串当成「对不上」。
   */
  readLedger(needles: readonly string[]): Promise<string>;
  /** db 的 fillHistoricalRunUsage。写了回 true。 */
  fill(runId: string, usage: MeterUsageWrite, at: Date): Promise<boolean>;
  /** db 的 noteHistoricalRunUsage。写了回 true。 */
  note(runId: string, note: string, at: Date): Promise<boolean>;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
}

type Match =
  | { kind: 'no-branch' }
  | { kind: 'bad-leaf' }
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'many'; count: number }
  | { kind: 'one'; sessionId: string };

interface LedgerLine {
  leaf: string;
  at: number;
  /** 认不出是 null：时刻和目录对得上、会话号没有的，这行让整笔变成「不猜」。 */
  sessionId: string | null;
}

type Action =
  | { kind: 'fill'; id: string; usage: MeterUsageWrite; line: string }
  | { kind: 'note'; id: string; note: string; ambiguous: boolean; line: string };

function branchLeaf(branch: string | null): string | null {
  if (!branch?.trim()) return null;
  const leaf = branch.trim().replace(/\/+$/, '').split('/').pop();
  return leaf || null;
}

function workspaceLeaf(workspace: unknown): string | null {
  if (typeof workspace !== 'string' || !workspace.trim()) return null;
  const leaf = workspace.trim().replace(/\/+$/, '').split('/').pop();
  return leaf || null;
}

/** 只认 workspace 的目录名。repo 字段可以和目录不一致，按 repo 对会把别人的会话算进来。 */
function parseLedger(text: string): Map<string, LedgerLine[]> {
  const byLeaf = new Map<string, LedgerLine[]>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        row = parsed as Record<string, unknown>;
      }
    } catch {
      row = undefined;
    }
    if (!row) continue;
    const leaf = workspaceLeaf(row.workspace);
    if (!leaf) continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    const raw = row.sessionId;
    const sessionId = typeof raw === 'string' ? (meterSessionUuid(raw) ?? null) : null;
    const list = byLeaf.get(leaf);
    const item = { leaf, at, sessionId };
    if (list) list.push(item);
    else byLeaf.set(leaf, [item]);
  }
  return byLeaf;
}

function matchWindow(lines: readonly LedgerLine[] | undefined, since: number, until: number): Match {
  if (!lines) return { kind: 'none' };
  const sessions = new Set<string>();
  let unreadable = 0;
  let any = false;
  for (const line of lines) {
    if (line.at < since || line.at > until) continue;
    any = true;
    if (line.sessionId) sessions.add(line.sessionId);
    else unreadable += 1;
  }
  if (!any) return { kind: 'none' };
  if (unreadable > 0 && sessions.size <= 1) return { kind: 'unreadable' };
  if (sessions.size === 0) return { kind: 'none' };
  if (sessions.size > 1) return { kind: 'many', count: sessions.size };
  const sessionId = [...sessions][0];
  if (!sessionId) return { kind: 'none' };
  return { kind: 'one', sessionId };
}

function classify(run: HistoricalMeterRun, byLeaf: Map<string, LedgerLine[]>): Match {
  const leaf = branchLeaf(run.branch);
  if (!leaf) return { kind: 'no-branch' };
  if (!NEEDLE.test(leaf)) return { kind: 'bad-leaf' };
  return matchWindow(byLeaf.get(leaf), run.startedAt.getTime(), run.endedAt.getTime());
}

function noteFor(match: Match, shared: boolean): { note: string; ambiguous: boolean } {
  if (match.kind === 'no-branch') return { note: NO_BRANCH, ambiguous: false };
  if (match.kind === 'bad-leaf') return { note: BAD_LEAF, ambiguous: false };
  if (match.kind === 'unreadable') return { note: UNREADABLE, ambiguous: false };
  if (match.kind === 'many') {
    return { note: `对不上：对上不唯一（这一笔起止之间有 ${match.count} 个会话，不猜）`, ambiguous: true };
  }
  if (match.kind === 'one' && shared) {
    return { note: '对不上：对上不唯一（这个会话还对上了另一笔，不猜）', ambiguous: true };
  }
  return { note: NO_SESSION, ambiguous: false };
}

function toWrite(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}): MeterUsageWrite {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  };
}

/** 这一笔还会改哪些空字段。都有值就不是「能补」。 */
function holes(run: HistoricalMeterRun, usage: MeterUsageWrite): string[] {
  const parts: string[] = [];
  if (run.inputTokens === null) parts.push(`输入 ${usage.inputTokens}`);
  if (run.outputTokens === null) parts.push(`输出 ${usage.outputTokens}`);
  if (run.cacheReadTokens === null) parts.push(`缓存读 ${usage.cacheReadTokens}`);
  if (run.cacheWriteTokens === null) parts.push(`缓存写 ${usage.cacheWriteTokens}`);
  if (run.costUsd === null && usage.costUsd !== undefined) parts.push(`花费 ${usage.costUsd}`);
  return parts;
}

function where(run: HistoricalMeterRun): string {
  return run.branch ?? '（没有分支）';
}

async function plan(rows: readonly HistoricalMeterRun[], deps: UsageBackfillOnceDeps): Promise<Action[]> {
  const leaves = [
    ...new Set(
      rows.flatMap((run) => {
        const leaf = branchLeaf(run.branch);
        return leaf && NEEDLE.test(leaf) ? [leaf] : [];
      }),
    ),
  ];
  const byLeaf = parseLedger(leaves.length > 0 ? await deps.readLedger(leaves) : '');
  const prelim = rows.map((run) => ({ run, match: classify(run, byLeaf) }));
  const claims = new Map<string, number>();
  for (const item of prelim) {
    if (item.match.kind !== 'one') continue;
    claims.set(item.match.sessionId, (claims.get(item.match.sessionId) ?? 0) + 1);
  }
  const uniqueIds = [...claims].filter(([, n]) => n === 1).map(([id]) => id);
  // 第二次按会话号读：同一次会话里、不在这个工作树目录下的调用也要算进合计
  const second = uniqueIds.length > 0 ? await deps.readLedger(uniqueIds) : '';
  const actions: Action[] = [];
  for (const item of prelim) {
    const { run, match } = item;
    const shared = match.kind === 'one' && (claims.get(match.sessionId) ?? 0) > 1;
    if (match.kind === 'one' && !shared) {
      const reading = meterReadingFrom(second, {
        sessionKey: match.sessionId,
        since: run.startedAt.getTime(),
        until: run.endedAt.getTime(),
      });
      if (reading.state === 'settled') {
        const usage = toWrite(reading.usage);
        const parts = holes(run, usage);
        if (parts.length === 0) continue;
        actions.push({
          kind: 'fill',
          id: run.id,
          usage,
          line: `${run.id} ${where(run)} 补 ${parts.join('、')}`,
        });
        continue;
      }
      if (run.usageNote) continue;
      const note = `对不上：${reading.detail}`;
      actions.push({
        kind: 'note',
        id: run.id,
        note,
        ambiguous: false,
        line: `${run.id} ${where(run)} ${note}`,
      });
      continue;
    }
    if (run.usageNote) continue;
    const { note, ambiguous } = noteFor(match, shared);
    actions.push({ kind: 'note', id: run.id, note, ambiguous, line: `${run.id} ${where(run)} ${note}` });
  }
  return actions;
}

function headline(apply: boolean, actions: readonly Action[]): string {
  const canFill = actions.filter((a) => a.kind === 'fill').length;
  const notes = actions.filter((a) => a.kind === 'note');
  const ambiguous = notes.filter((a) => a.ambiguous).length;
  const lead = apply ? '已写入' : '只读，没写库';
  return `${lead}。能补 ${canFill} 笔，对不上 ${notes.length} 笔（对上不唯一 ${ambiguous} 笔）。`;
}

/**
 * 跑一次。参数不对不连库。账本或库抛错：还没写就停，退出码 1。
 * 先把要改的都算完再写，读账本失败不会写一半。
 */
export async function runUsageBackfillOnce(
  argv: readonly string[],
  deps: UsageBackfillOnceDeps,
): Promise<number> {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    deps.out(USAGE_BACKFILL_ONCE_USAGE);
    return 0;
  }
  const apply = argv.length === 1 && argv[0] === '--apply';
  if (!(argv.length === 0 || apply)) {
    deps.err(USAGE_BACKFILL_ONCE_USAGE);
    return 2;
  }
  try {
    const rows = await deps.pending();
    const actions = await plan(rows, deps);
    if (apply) {
      const at = deps.now();
      for (const action of actions) {
        const wrote =
          action.kind === 'fill'
            ? await deps.fill(action.id, action.usage, at)
            : await deps.note(action.id, action.note, at);
        if (!wrote) throw new Error(`没写上 ${action.id}（这行可能刚被别的写入改过）`);
      }
    }
    deps.out(headline(apply, actions));
    for (const action of actions) deps.out(action.line);
    return 0;
  } catch (err) {
    deps.err(`没查成：${errMessage(err)}`);
    return 1;
  }
}
