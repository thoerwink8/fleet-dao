// 已完成处置里的失败 run 还算不算新故障（决定 0093 的立案去重）。
// 完成边界只认 completed 单的正文，以及关闭时刻及之前写下、且关单后没改过的留言：那里绑住的 Actions 运行号才算处置过。
// 关单之后的留言（含关单后改过的）是复发、诊断或验证，里面的运行号不算。对不上关闭时刻的留言也不算。
// 没有运行号（只有 PR、文档链接）就是证据不明。
// 不放进 e2e-flaky.ts：index 从那儿再导出 outcomesOf，那个文件在包的面上。
// 改面上的文件会让依赖 conventions 的包一起进本机测试，引擎自测 30 分钟跑不完。

import {
  BROKEN_ROUND_TITLE,
  brokenRoundBody,
  FLAKY_SUMMARY_OVER,
  FLAKY_SUMMARY_TITLE,
  type FlakyFinding,
  flakySummaryBody,
  flakyTests,
  ISSUE_KIND,
  isBrokenRound,
  issueBody,
  issueTitle,
  keyText,
  MAX_NEW_ISSUES,
  type OpenIssue,
  planIssues as planOpenIssues,
  type QuarantineEntry,
  type RunOutcomes,
} from './e2e-flaky.ts';
import { domainLabel, natureLabel } from './labels.ts';

const ISSUE_LABELS = [ISSUE_KIND, domainLabel('engine'), natureLabel('bug')];

/** 失败 run 的键：GitHub Actions 运行号优先，这样正文里带 `/attempts/` 或尾斜杠也对得上。 */
export function runKey(url: string): string {
  const id = /\/actions\/runs\/(\d+)/.exec(url)?.[1];
  if (id) return `run:${id}`;
  return url.replace(/[),.;]+$/g, '').replace(/\/+$/, '');
}

const ACTION_RUN_KEY = /^run:\d+$/;

/** 是不是 GitHub Actions 运行号。PR、文档和其他链接不是失败 run，不能拿来证明修过。 */
function isActionRunKey(key: string): boolean {
  return ACTION_RUN_KEY.test(key);
}

/** 从正文或留言里抽出失败 run。只认 Actions 运行号；一个都没有就是没有证据，不把别的 URL 当成 run。 */
export function extractRunKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\/actions\/runs\/(\d+)/g)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    keys.push(`run:${id}`);
  }
  return keys;
}

/** 一张已完成处置里、某个用例点明的失败 run。`runs === null` 是证据不明，不能当成修过。 */
export interface HandledTest {
  number: number;
  runs: readonly string[] | null;
}

/**
 * 同用例已完成处置的失败 run。`ready` 才许拿来判断覆盖；
 * `unknown` 是查询失败、分页不完整或结果认不出，不能当成「没有已处置」。
 */
export type SettledEvidence =
  | { status: 'ready'; byTest: Readonly<Record<string, readonly HandledTest[]>> }
  | { status: 'unknown'; reason: string };

/** 窗口里最旧一轮的运行号。链接里没有运行号就返回 null（调用方必须当成证据不明，不能当成没有旧单）。 */
export function oldestRunId(runs: readonly { url: string }[]): string | null {
  const oldest = runs[runs.length - 1];
  if (!oldest) return null;
  return /\/actions\/runs\/(\d+)/.exec(oldest.url)?.[1] ?? null;
}

/** 这次扫描可能要开的偶发单标题（含汇总单）。已完成处置按这些标题认，不对任意关着的单。 */
export function settledTitlesOf(runs: readonly RunOutcomes[]): Set<string> {
  const titles = new Set<string>();
  for (const finding of flakyTests(runs)) titles.add(issueTitle(finding.key));
  if (titles.size > 0) titles.add(FLAKY_SUMMARY_TITLE);
  return titles;
}

/**
 * 还有偶发单要新开时，才需要读已完成处置。开着的同标题单已经挡住重开；整轮坏了不走这条。
 * 没有任何偶发时返回 false：整轮真红只走原来的整轮单，不因为证据查询失败改口。
 */
export function needsSettledEvidence(runs: readonly RunOutcomes[], open: readonly OpenIssue[]): boolean {
  const findings = flakyTests(runs);
  if (findings.length === 0) return false;
  if (findings.length > FLAKY_SUMMARY_OVER) return !open.some((issue) => issue.title === FLAKY_SUMMARY_TITLE);
  return findings.some((finding) => !open.some((issue) => issue.title === issueTitle(finding.key)));
}

const SETTLED_PAGE_CAP = 100;
const SETTLED_COMMENT_CAP = 20;
const SETTLED_PAGE_SIZE = 100;

interface ClosedTake {
  number: number;
  title: string;
  body: string;
  /** 关单原因是 completed 才采用完成边界里的 run；别的原因不证明修过。 */
  trust: boolean;
  /** 关单时刻。没有就不能证明留言是关单前写的，那些留言不进完成边界。 */
  closedAt: number | null;
}

interface IssueNote {
  body: string;
  /** 留言写成的时刻。没有就不能放进完成边界。 */
  createdAt: number | null;
  /** 留言最后改动。晚于关单说明文字可能已不是完成时的原文。没有该字段则只看写成时刻。 */
  updatedAt: number | null;
}

function parseClosedRow(
  row: unknown,
  titles: ReadonlySet<string>,
): { kind: 'skip' } | { kind: 'bad'; reason: string } | { kind: 'take'; issue: ClosedTake } {
  if (row === null || typeof row !== 'object')
    return { kind: 'bad', reason: '证据不明：已关闭的单有一条认不出' };
  const record = row as Record<string, unknown>;
  if (record.pull_request !== null && record.pull_request !== undefined) return { kind: 'skip' };
  if (typeof record.title !== 'string' || !Number.isSafeInteger(record.number))
    return { kind: 'bad', reason: '证据不明：已关闭的单有一条缺标题或单号' };
  if (!titles.has(record.title)) return { kind: 'skip' };
  const reason = record.state_reason;
  if (reason !== null && reason !== undefined && typeof reason !== 'string')
    return { kind: 'bad', reason: `证据不明：#${String(record.number)} 的关单原因认不出` };
  if (record.body !== null && record.body !== undefined && typeof record.body !== 'string')
    return { kind: 'bad', reason: `证据不明：#${String(record.number)} 的正文认不出` };
  // 明确不是完成处置的关法，不能拿来证明这批 run 修过。
  if (reason === 'not_planned' || reason === 'duplicate') return { kind: 'skip' };
  const closedAt = closedInstant(record.closed_at);
  if (closedAt === 'bad')
    return { kind: 'bad', reason: `证据不明：#${String(record.number)} 的关闭时间认不出` };
  return {
    kind: 'take',
    issue: {
      number: record.number as number,
      title: record.title,
      body: typeof record.body === 'string' ? record.body : '',
      trust: reason === 'completed',
      closedAt,
    },
  };
}

/** 关单或留言上的时间。缺字段是「没有」；写了但不是时间就是认不出。 */
function closedInstant(value: unknown): number | null | 'bad' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return 'bad';
  return instantOf(value) ?? 'bad';
}

function instantOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function createdAtOf(meta: unknown): string | null {
  if (meta === null || typeof meta !== 'object') return null;
  const created = (meta as { created_at?: unknown }).created_at;
  if (typeof created !== 'string' || instantOf(created) === null) return null;
  return created;
}

/** 汇总单按行认用例（反引号里的 `文件 › 标题`）；逐条偶发单的全部 run 都属于这一个标题。 */
function evidenceFor(
  title: string,
  text: string,
  titles: ReadonlySet<string>,
): Record<string, string[] | null> {
  if (title === FLAKY_SUMMARY_TITLE) {
    const out: Record<string, string[] | null> = {};
    const keys = [...titles].filter((item) => item !== FLAKY_SUMMARY_TITLE);
    for (const line of text.split('\n')) {
      const runs = extractRunKeys(line);
      for (const item of keys) {
        const key = item.startsWith('e2e 偶发：') ? item.slice('e2e 偶发：'.length) : '';
        if (key === '' || !line.includes(`\`${key}\``)) continue;
        if (runs.length === 0) {
          if (!(item in out)) out[item] = null;
        } else {
          const prev = out[item];
          out[item] = prev === null || prev === undefined ? runs : [...prev, ...runs];
        }
      }
    }
    return out;
  }
  const runs = extractRunKeys(text);
  return { [title]: runs.length > 0 ? runs : null };
}

function addHandled(byTest: Record<string, HandledTest[]>, title: string, row: HandledTest): void {
  const list = byTest[title] ?? [];
  list.push(row);
  byTest[title] = list;
}

/**
 * 读同用例已完成处置里绑住的失败 run。范围从窗口最旧一轮的创建时间起（更早的单不可能写进这些 run）。
 * 查询抛错、页没翻完、单或留言认不出：返回 unknown，不返回空表（空表会变成「没有旧单、可以新开」）。
 */
export async function loadWindowEvidence(
  runs: readonly { url: string }[],
  titles: ReadonlySet<string>,
  get: (path: string) => Promise<unknown>,
  limits?: { pageCap?: number; commentCap?: number; pageSize?: number },
): Promise<SettledEvidence> {
  const pageCap = limits?.pageCap ?? SETTLED_PAGE_CAP;
  const commentCap = limits?.commentCap ?? SETTLED_COMMENT_CAP;
  const pageSize = limits?.pageSize ?? SETTLED_PAGE_SIZE;
  try {
    const id = oldestRunId(runs);
    if (!id) return { status: 'unknown', reason: '证据不明：窗口里的运行链接认不出运行号，不能查已完成处置' };
    const created = createdAtOf(await get(`/actions/runs/${id}`));
    if (!created)
      return { status: 'unknown', reason: '证据不明：运行记录没有创建时间，不能划定已完成处置的查询范围' };
    const matched: ClosedTake[] = [];
    for (let page = 1; page <= pageCap; page++) {
      const path =
        `/issues?state=closed&since=${encodeURIComponent(created)}` +
        `&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`;
      const got = await get(path);
      if (!Array.isArray(got)) return { status: 'unknown', reason: '证据不明：已关闭的单不是列表' };
      for (const row of got) {
        const parsed = parseClosedRow(row, titles);
        if (parsed.kind === 'bad') return { status: 'unknown', reason: parsed.reason };
        if (parsed.kind === 'take') matched.push(parsed.issue);
      }
      if (got.length < pageSize) return await settleMatched(matched, titles, get, commentCap, pageSize);
    }
    return {
      status: 'unknown',
      reason: `分页不完整：已关闭的单翻了 ${pageCap} 页仍是满页，不能当成没有已处置的失败 run`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'unknown', reason: `查询失败：${message}` };
  }
}

/** 关闭时刻及之前写下、且关单后没改过的留言，才算完成时绑住的。时间认不出则整次查询未知。 */
function noteBoundAtClose(note: IssueNote, closedAt: number | null): boolean {
  if (closedAt === null || note.createdAt === null || note.createdAt > closedAt) return false;
  return note.updatedAt === null || note.updatedAt <= closedAt;
}

function completionText(issue: ClosedTake, notes: readonly IssueNote[]): string {
  const bound = notes.filter((note) => noteBoundAtClose(note, issue.closedAt));
  return [issue.body, ...bound.map((note) => note.body)].join('\n');
}

async function settleMatched(
  matched: readonly ClosedTake[],
  titles: ReadonlySet<string>,
  get: (path: string) => Promise<unknown>,
  commentCap: number,
  pageSize: number,
): Promise<SettledEvidence> {
  const byTest: Record<string, HandledTest[]> = {};
  for (const issue of matched) {
    const comments = await loadComments(get, issue.number, commentCap, pageSize);
    if (!comments.ok) return { status: 'unknown', reason: comments.reason };
    // 不是完成处置的同标题单：点到哪些用例就记成证据不明，不用它的运行号证明修过。
    if (!issue.trust) {
      const allText = [issue.body, ...comments.notes.map((note) => note.body)].join('\n');
      const mentioned =
        issue.title === FLAKY_SUMMARY_TITLE
          ? Object.keys(evidenceFor(issue.title, allText, titles))
          : [issue.title];
      if (mentioned.length === 0)
        return {
          status: 'unknown',
          reason: `证据不明：#${issue.number} 的关单原因不是已完成，也没点明是哪些用例`,
        };
      for (const title of mentioned) addHandled(byTest, title, { number: issue.number, runs: null });
      continue;
    }
    const evidence = evidenceFor(issue.title, completionText(issue, comments.notes), titles);
    // 汇总单没点出任何用例：不知道它盖住了谁，不能当成「没有这张单」去新开。
    if (issue.title === FLAKY_SUMMARY_TITLE && Object.keys(evidence).length === 0)
      return {
        status: 'unknown',
        reason: `证据不明：#${issue.number} 已完成，但没有点明是哪些用例的失败 run，不能当成修过`,
      };
    for (const [title, runs] of Object.entries(evidence)) {
      addHandled(byTest, title, { number: issue.number, runs });
    }
  }
  return { status: 'ready', byTest };
}

async function loadComments(
  get: (path: string) => Promise<unknown>,
  number: number,
  commentCap: number,
  pageSize: number,
): Promise<{ ok: true; notes: IssueNote[] } | { ok: false; reason: string }> {
  const notes: IssueNote[] = [];
  for (let page = 1; page <= commentCap; page++) {
    const got = await get(`/issues/${number}/comments?per_page=${pageSize}&page=${page}`);
    if (!Array.isArray(got)) return { ok: false, reason: `证据不明：#${number} 的留言不是列表` };
    for (const comment of got) {
      if (comment === null || typeof comment !== 'object')
        return { ok: false, reason: `证据不明：#${number} 的留言有一条认不出` };
      const record = comment as { body?: unknown; created_at?: unknown; updated_at?: unknown };
      if (record.body !== null && record.body !== undefined && typeof record.body !== 'string')
        return { ok: false, reason: `证据不明：#${number} 的留言正文认不出` };
      const createdAt = closedInstant(record.created_at);
      const updatedAt = closedInstant(record.updated_at);
      if (createdAt === 'bad' || updatedAt === 'bad')
        return { ok: false, reason: `证据不明：#${number} 的留言时间认不出` };
      notes.push({
        body: typeof record.body === 'string' ? record.body : '',
        createdAt,
        updatedAt,
      });
    }
    if (got.length < pageSize) return { ok: true, notes };
  }
  return { ok: false, reason: `分页不完整：#${number} 的留言翻了 ${commentCap} 页仍是满页` };
}

type FlakyJudgement =
  | { kind: 'file' }
  | { kind: 'covered'; numbers: number[] }
  | { kind: 'unknown'; reason: string };

function uniqNumbers(numbers: readonly number[]): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/**
 * 当前失败 run（新的在前）有没有超出完成边界里绑住的那些。
 * 最新一轮失败 run 已在完成边界里：窗口里更旧的失败不是新增（汇总单以前只写「最近一次」也算盖住）。
 * 有更新的失败 run、并且每张相关单都列得出运行号：立刻立案。有一张单列不出、又盖不住这个新 run：未知，不当没有故障。
 */
function judgeFlaky(
  title: string,
  urls: readonly string[],
  settled: SettledEvidence | undefined,
): FlakyJudgement {
  if (!settled) return { kind: 'file' };
  if (settled.status === 'unknown') return { kind: 'unknown', reason: settled.reason };
  const rows = settled.byTest[title] ?? [];
  if (rows.length === 0) return { kind: 'file' };
  const keys = urls.map(runKey);
  const known = new Set<string>();
  const unclear: number[] = [];
  for (const row of rows) {
    // 没有运行号，或混进了 PR、文档链接：这张单证明不了修过哪些 run。
    const runs = row.runs;
    if (runs === null || runs.length === 0 || runs.some((run) => !isActionRunKey(run))) {
      unclear.push(row.number);
      continue;
    }
    for (const run of runs) known.add(run);
  }
  const newest = keys[0];
  if (newest !== undefined && known.has(newest)) {
    const numbers = uniqNumbers(rows.filter((row) => row.runs?.includes(newest)).map((row) => row.number));
    if (numbers.length === 0) return { kind: 'file' };
    return { kind: 'covered', numbers };
  }
  if (unclear.length > 0) {
    return {
      kind: 'unknown',
      reason: `证据不明：#${unclear.join('、#')} 已关闭，但没有点明失败 run，不能当成修过`,
    };
  }
  return { kind: 'file' };
}

function judgeSummary(
  findings: readonly FlakyFinding[],
  settled: SettledEvidence | undefined,
): FlakyJudgement {
  if (!settled) return { kind: 'file' };
  if (settled.status === 'unknown') return { kind: 'unknown', reason: settled.reason };
  let file = false;
  let unknown: string | null = null;
  const numbers: number[] = [];
  for (const finding of findings) {
    const judged = judgeFlaky(issueTitle(finding.key), finding.urls, settled);
    if (judged.kind === 'file') file = true;
    else if (judged.kind === 'unknown') unknown ??= judged.reason;
    else numbers.push(...judged.numbers);
  }
  // 已经能确定有新的失败 run：不明的旧单不挡住这次立案。
  if (file) return { kind: 'file' };
  if (unknown) return { kind: 'unknown', reason: unknown };
  const cited = uniqNumbers(numbers);
  if (cited.length === 0) return { kind: 'file' };
  return { kind: 'covered', numbers: cited };
}

function coveredLabel(title: string, numbers: readonly number[]): string {
  return `旧采样已被覆盖，不开：${title}（原单 ${numbers.map((number) => `#${number}`).join('、')}；这些失败 run 已经处置过，没有新增）`;
}

function unknownLabel(title: string, reason: string): string {
  return `证据未知，不开、也不当没有故障：${title}（${reason}）`;
}

/** 开着的单去重、整轮坏了、限流仍走 e2e-flaky.ts；这里多两种结局：旧采样已被盖住，或证据没读清。 */
export type SettledAction =
  | {
      kind: 'create';
      title: string;
      body: string;
      labels: string[];
      label: string;
    }
  | { kind: 'comment'; number: number; body: string; label: string }
  | { kind: 'close'; number: number; body: string; label: string }
  | { kind: 'exists'; label: string }
  | { kind: 'deferred'; title: string; label: string }
  | { kind: 'covered'; title: string; numbers: number[]; label: string }
  | { kind: 'unknown'; title: string; reason: string; label: string };

function flakyAction(title: string, judged: FlakyJudgement, create: () => SettledAction): SettledAction {
  if (judged.kind === 'covered')
    return { kind: 'covered', title, numbers: judged.numbers, label: coveredLabel(title, judged.numbers) };
  if (judged.kind === 'unknown')
    return { kind: 'unknown', title, reason: judged.reason, label: unknownLabel(title, judged.reason) };
  return create();
}

const IDLE_SCAN_LINE = '没有达到偶发阈值的用例，也没有要处理的「整轮坏了」单';

/** 没有任何动作时才说「没有偶发」。证据未知也是动作，不能说成没有故障。 */
export function idleScanLine(actions: readonly { label: string }[]): string | null {
  return actions.length === 0 ? IDLE_SCAN_LINE : null;
}

/** 有一张偶发单因为证据没读清而没开：扫描不能以成功收场。 */
export function evidenceUnresolved(actions: readonly { kind: string }[]): boolean {
  return actions.some((action) => action.kind === 'unknown');
}

/** 一次最多新开 max 张：盖住的、证据未知的、留言和关单不占名额。 */
function capCreates(actions: readonly SettledAction[], max = MAX_NEW_ISSUES): SettledAction[] {
  let created = 0;
  return actions.map((action) => {
    if (action.kind !== 'create') return action;
    if (created < max) {
      created++;
      return action;
    }
    return {
      kind: 'deferred',
      title: action.title,
      label: `这次不开：${action.title}（一次扫描最多新开 ${max} 张，下次扫描还达阈值再开）`,
    };
  });
}

/**
 * 近几轮（新的在前）→ 要开/留言/关的单。不传 `settled` 时和 `e2e-flaky.ts` 的 planIssues 同一条路
 * （只按开着的单去重）。传了之后，当前失败 run 没有超出完成边界里绑住的那些就不新开，并写明原单；
 * 有更新的失败 run 且仍达阈值就照常开。查询没读全、或运行号认不出，是「未知」，不开、也不当没有故障。
 * 判在限流之前：被盖住的不占这一次的新开名额。
 */
export function planIssues(
  runs: readonly RunOutcomes[],
  open: readonly OpenIssue[],
  quarantine: readonly QuarantineEntry[],
  until: string,
  settled?: SettledEvidence,
): SettledAction[] {
  if (settled === undefined) return planOpenIssues(runs, open, quarantine, until);
  const actions: SettledAction[] = [];
  const streak = runs.findIndex((run) => !isBrokenRound(run));
  const broken = (streak === -1 ? runs : runs.slice(0, streak)).map((run) => run.url);
  const existing = open.find((issue) => issue.title === BROKEN_ROUND_TITLE);
  if (broken.length === 0) {
    const latest = runs[0];
    if (existing && latest) {
      actions.push({
        kind: 'close',
        number: existing.number,
        body: `最新一轮 ${latest.url} 已正常，关单；再坏会重开`,
        label: `关单：${BROKEN_ROUND_TITLE}（#${existing.number}），最新一轮已正常`,
      });
    }
  } else if (!existing) {
    actions.push({
      kind: 'create',
      title: BROKEN_ROUND_TITLE,
      body: brokenRoundBody(broken),
      labels: [...ISSUE_LABELS],
      label: `${BROKEN_ROUND_TITLE}（${broken.length} 轮）`,
    });
  } else {
    const fresh = broken.filter((url) => !(existing.body ?? '').includes(url));
    actions.push(
      fresh.length > 0
        ? {
            kind: 'comment',
            number: existing.number,
            body: ['又有整轮坏了的轮：', ...fresh.map((url) => `- ${url}`)].join('\n'),
            label: `${BROKEN_ROUND_TITLE}：补 ${fresh.length} 轮链接到 #${existing.number}`,
          }
        : { kind: 'exists', label: `已有开着的单：${BROKEN_ROUND_TITLE}（#${existing.number}）` },
    );
  }
  const findings = flakyTests(runs);
  if (findings.length > FLAKY_SUMMARY_OVER) {
    const summary = open.find((issue) => issue.title === FLAKY_SUMMARY_TITLE);
    if (!summary) {
      actions.push(
        flakyAction(FLAKY_SUMMARY_TITLE, judgeSummary(findings, settled), () => ({
          kind: 'create',
          title: FLAKY_SUMMARY_TITLE,
          body: flakySummaryBody(findings, until),
          labels: [...ISSUE_LABELS],
          label: `开了单：${FLAKY_SUMMARY_TITLE}（${findings.length} 条）`,
        })),
      );
    } else {
      const fresh = findings.filter((finding) => !(summary.body ?? '').includes(keyText(finding.key)));
      actions.push(
        fresh.length > 0
          ? {
              kind: 'comment',
              number: summary.number,
              body: [
                '又有用例达到偶发阈值：',
                ...fresh.map(
                  (finding) =>
                    `- \`${keyText(finding.key)}\`：${finding.bad}/${finding.ran}，失败 run ${finding.urls.join('、')}`,
                ),
              ].join('\n'),
              label: `${FLAKY_SUMMARY_TITLE}：补 ${fresh.length} 条到 #${summary.number}`,
            }
          : { kind: 'exists', label: `已有开着的单：${FLAKY_SUMMARY_TITLE}（#${summary.number}）` },
      );
    }
  } else {
    for (const finding of findings) {
      const title = issueTitle(finding.key);
      if (open.some((issue) => issue.title === title)) {
        actions.push({ kind: 'exists', label: `已有开着的单：${title}（${finding.bad}/${finding.ran}）` });
        continue;
      }
      const quarantined = quarantine.some((entry) => keyText(entry) === keyText(finding.key));
      actions.push(
        flakyAction(title, judgeFlaky(title, finding.urls, settled), () => ({
          kind: 'create',
          title,
          body: issueBody(finding, until, quarantined),
          labels: [...ISSUE_LABELS],
          label: `开了单：${title}（${finding.bad}/${finding.ran}）`,
        })),
      );
    }
  }
  return capCreates(actions, MAX_NEW_ISSUES);
}
