// 驾驶舱 e2e 的偶发失败（决定 0093）：首跑红、重试过了的用例 Playwright 标成 flaky，这一轮不算红（retries=1，packages/web/e2e/playwright.config.ts）。
// 同一条用例在近 10 轮主线 e2e 里偶发（首跑红、同一次运行里重试才过）到 2 次就算「常偶发」；重试也红的是真红，不算（#2735）。常偶发的开一张单（限期修、带最近几次失败的链接），单里写明把它加进隔离集
// （packages/web/e2e/quarantine.json：照跑、照报，不挡这一轮；ci.yml 的 e2e job 跳过它们、e2e-quarantine.yml 每天单跑，按它挑用例的是 packages/web/e2e/support/quarantine.ts）。
// 先判整轮（#2499）：一轮里首跑红的用例超过这一轮用例数的一半、或报告里有全局准备/备库的错，这轮记「整轮坏了」，不计入任何用例的次数，
// 只汇成一张固定标题的「主线 e2e 整轮坏了」单（同一时间只一张），免得环境坏一次就给每条用例各开一张偶发单。
// 这里是判法和拼单：读 Playwright 的 JSON 报告、数次数、拼单子，以及「已完成处置里的失败 run 还算不算新故障」。
// 取报告（gh run download）和开单在 .github/workflows/e2e-flaky.yml 和 bin/e2e-flaky.ts。

import { domainLabel, natureLabel } from './labels.ts';

/** 一条用例在一轮里的结局（多个视口里取最坏的：有一个红就是红，否则有一个偶发就是偶发）。 */
export type Outcome = 'passed' | 'flaky' | 'failed' | 'skipped';

/** 用例的名字：spec 文件（相对 e2e/specs）+ 用例标题。视口不算在内：两个视口是同一条用例。 */
export interface TestKey {
  file: string;
  title: string;
}

/** 一轮里每条用例的结局，键是 keyText。 */
export type Outcomes = Map<string, { key: TestKey; outcome: Outcome }>;

export const keyText = (k: TestKey): string => `${k.file} › ${k.title}`;

interface ReportTest {
  status?: unknown;
}
interface ReportSpec {
  title?: unknown;
  file?: unknown;
  tests?: unknown;
}
interface ReportSuite {
  specs?: unknown;
  suites?: unknown;
}

const RANK: Record<Outcome, number> = { skipped: 0, passed: 1, flaky: 2, failed: 3 };

function outcomeOf(status: unknown): Outcome {
  if (status === 'expected') return 'passed';
  if (status === 'flaky') return 'flaky';
  if (status === 'skipped') return 'skipped';
  if (status === 'unexpected') return 'failed';
  throw new Error(`报告里用例的结局认不出：${JSON.stringify(status)}`);
}

/** 读 Playwright JSON 报告（reporter: json）：每条用例一个结局。报告长得不对就抛，不拿空表冒充「全过」。 */
export function outcomesOf(report: unknown): Outcomes {
  const suites = (report as { suites?: unknown } | null)?.suites;
  if (!Array.isArray(suites)) throw new Error('不是 Playwright 的 JSON 报告（没有 suites）');
  const out: Outcomes = new Map();
  const walk = (suite: ReportSuite) => {
    for (const spec of (Array.isArray(suite.specs) ? suite.specs : []) as ReportSpec[]) {
      if (typeof spec.title !== 'string' || typeof spec.file !== 'string' || !Array.isArray(spec.tests))
        throw new Error(`报告里有一条用例缺标题、文件或结果：${JSON.stringify(spec).slice(0, 200)}`);
      const key = { file: spec.file.replaceAll('\\', '/'), title: spec.title };
      const id = keyText(key);
      for (const t of spec.tests as ReportTest[]) {
        const outcome = outcomeOf(t.status);
        const prev = out.get(id);
        if (!prev || RANK[outcome] > RANK[prev.outcome]) out.set(id, { key, outcome });
      }
    }
    for (const child of (Array.isArray(suite.suites) ? suite.suites : []) as ReportSuite[]) walk(child);
  };
  for (const s of suites as ReportSuite[]) walk(s);
  return out;
}

/** 报告顶层 errors 的条数：全局准备（globalSetup）、备库这类整轮的错 Playwright 记在这里，不记在某条用例上。认不出长相就抛。 */
export function globalErrorCount(report: unknown): number {
  const errors = (report as { errors?: unknown } | null)?.errors;
  if (errors === undefined) return 0;
  if (!Array.isArray(errors)) throw new Error('报告里的 errors 不是数组');
  return errors.length;
}

/** 同一轮的几份报告（分片）合成一份：同一条用例取更坏的结局，不漏掉只出现在某一片里的用例。 */
export function mergeRunReports(reports: readonly unknown[]): { outcomes: Outcomes; globalError: boolean } {
  const outcomes: Outcomes = new Map();
  let globalError = false;
  for (const report of reports) {
    if (globalErrorCount(report) > 0) globalError = true;
    for (const [id, row] of outcomesOf(report)) {
      const prev = outcomes.get(id);
      if (!prev || RANK[row.outcome] > RANK[prev.outcome]) outcomes.set(id, row);
    }
  }
  return { outcomes, globalError };
}

/**
 * artifact 名是 `e2e-<运行号>-<第几次运行>-<分片>`（ci.yml）。主线红了只重跑失败的 job（ci-rerun.yml），
 * 所以同一轮里有的分片有第二次、有的只有第一次。每一片取它自己最后一次运行的报告，再合成一轮：
 * 重跑前的失败不重复算，没重跑的那一片也不漏。
 * 名字里没有第几次运行（旧的平铺 results-N.json）就全部留下，当成分片。
 */
const ATTEMPT_NAME = /(?:^|\/)e2e-(\d+)-(\d+)-(\d+)(?:\/|$)/;

export function reportsOfLastAttempt(files: readonly { name: string; report: unknown }[]): unknown[] {
  const parsed: { attempt: number; shard: string; report: unknown }[] = [];
  let named = false;
  for (const file of files) {
    const m = ATTEMPT_NAME.exec(file.name);
    if (!m?.[2] || !m[3]) continue;
    named = true;
    parsed.push({ attempt: Number(m[2]), shard: m[3], report: file.report });
  }
  if (!named) return files.map((file) => file.report);
  const maxByShard = new Map<string, number>();
  for (const row of parsed) {
    const prev = maxByShard.get(row.shard) ?? 0;
    if (row.attempt > prev) maxByShard.set(row.shard, row.attempt);
  }
  return parsed.filter((row) => row.attempt === maxByShard.get(row.shard)).map((row) => row.report);
}

/** 一轮主线 e2e：同一运行号下只取最后一次运行，分片合成一条结局。没有报告就抛，不当成全过。 */
export function runFromArtifacts(
  url: string,
  files: readonly { name: string; report: unknown }[],
): RunOutcomes {
  const reports = reportsOfLastAttempt(files);
  if (reports.length === 0) throw new Error('这一轮没有 e2e 报告');
  const merged = mergeRunReports(reports);
  return { url, outcomes: merged.outcomes, ...(merged.globalError ? { globalError: true } : {}) };
}

/** 一轮主线 e2e：运行的链接和它的报告读出来的结局。 */
export interface RunOutcomes {
  url: string;
  outcomes: Outcomes;
  /** 报告里有全局准备/备库这类整轮的错（globalErrorCount > 0）。 */
  globalError?: boolean;
}

/**
 * 这一轮是不是整轮坏了：报告里有全局错，或首跑红（偶发、真红）的用例超过这一轮跑了的用例数的一半。
 * 整轮坏了是环境的事（备库、起服务），不是哪条用例偶发，不计入任何一条用例的次数。
 */
export function isBrokenRound(run: RunOutcomes): boolean {
  if (run.globalError) return true;
  let ran = 0;
  let bad = 0;
  for (const { outcome } of run.outcomes.values()) {
    if (outcome === 'skipped') continue;
    ran++;
    if (outcome === 'flaky' || outcome === 'failed') bad++;
  }
  return ran > 0 && bad * 2 > ran;
}

export interface FlakyFinding {
  key: TestKey;
  /** 窗口里偶发（同一次运行里首跑红、重试才过）的轮数。 */
  bad: number;
  /** 窗口里跑了这条用例的轮数。 */
  ran: number;
  /** 偶发的那几轮的链接，新的在前。 */
  urls: string[];
}

export const FLAKY_WINDOW = 10;
export const FLAKY_THRESHOLD = 2;
/** 一轮里达阈值的用例超过这么多条：只开一张汇总单，不逐条开（#2735）。 */
export const FLAKY_SUMMARY_OVER = 5;
/** 一次扫描最多新开几张单（整轮坏了、汇总、逐条偶发都算）：多出来的这次不开，下次扫描再说（#2735）。 */
export const MAX_NEW_ISSUES = 3;

/**
 * runs 是新的在前的若干轮（调用方给近 FLAKY_WINDOW 轮）。数每条用例偶发的轮数，达 threshold 的列出来。
 * 只数 `flaky`（同一次运行里首跑红、重试才过）：真红（`failed`，重试也红）是改坏了，红在主线 CI 上、由提交的人修，
 * 不是偶发——原来把它也数进去，真坏一次就按用例逐条开单（10-15 起机器人开了 253 张，#2735）。
 */
export function flakyTests(runs: readonly RunOutcomes[], threshold = FLAKY_THRESHOLD): FlakyFinding[] {
  const tally = new Map<string, FlakyFinding>();
  for (const run of runs) {
    if (isBrokenRound(run)) continue;
    for (const [id, { key, outcome }] of run.outcomes) {
      if (outcome === 'skipped') continue;
      const f = tally.get(id) ?? { key, bad: 0, ran: 0, urls: [] };
      f.ran++;
      if (outcome === 'flaky') {
        f.bad++;
        f.urls.push(run.url);
      }
      tally.set(id, f);
    }
  }
  return [...tally.values()]
    .filter((f) => f.bad >= threshold && f.urls.length > 0)
    .sort((a, b) => b.bad - a.bad || keyText(a.key).localeCompare(keyText(b.key)));
}

/** 隔离集（packages/web/e2e/quarantine.json）里的一条。 */
export interface QuarantineEntry {
  file: string;
  title: string;
  /** 跟进的单号。 */
  issue: number;
  /** 限期（YYYY-MM-DD）：过了还在隔离集里，e2e 那一步的汇总会写出来。 */
  until: string;
}

/** 读隔离集文件的内容：格式不对就抛（隔离集坏了不能悄悄当成空的）。 */
export function parseQuarantine(text: string): QuarantineEntry[] {
  const data = JSON.parse(text) as { tests?: unknown };
  if (!data || !Array.isArray(data.tests)) throw new Error('quarantine.json 要是 { "tests": [...] }');
  return data.tests.map((t, i) => {
    const e = t as Partial<QuarantineEntry>;
    if (
      typeof e.file !== 'string' ||
      !/\.e2e\.ts$/.test(e.file) ||
      typeof e.title !== 'string' ||
      e.title === '' ||
      !Number.isInteger(e.issue) ||
      typeof e.until !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(e.until)
    )
      throw new Error(
        `quarantine.json 第 ${i + 1} 条要有 file（*.e2e.ts）、title、issue（单号）、until（YYYY-MM-DD）`,
      );
    return { file: e.file, title: e.title, issue: e.issue as number, until: e.until };
  });
}

/** 开单的标题：认单也靠它（同一条用例已有开着的单就不再开）。 */
export const issueTitle = (k: TestKey): string => `e2e 偶发：${keyText(k)}`;

/**
 * 「整轮坏了」单的标题：固定，同一时间只开一张（认单靠它）。不以「e2e 偶发」开头，免得和偶发单混在一起被批量处理。
 */
export const BROKEN_ROUND_TITLE = '主线 e2e 整轮坏了';

/** 一轮里达阈值的用例超过 FLAKY_SUMMARY_OVER 条时那张汇总单的标题：固定，同一时间只一张（认单靠它）。 */
export const FLAKY_SUMMARY_TITLE = 'e2e 偶发：多条用例达阈值（汇总）';

/** 自动开的单贴的类别：引擎拉单要类别标签（对账也查），e2e 坏了都是缺陷。 */
export const ISSUE_KIND = '缺陷';
const ISSUE_LABELS = [ISSUE_KIND, domainLabel('engine'), natureLabel('bug')];

/** 正文的四节（场景、原话、已知的模块、怎么算做完）和 pnpm issue:new 开的单一样，不然引擎不拉、对账报缺。 */
function issueSections(s: { scene: string[]; modules: string[]; done: string[] }): string {
  return [
    '## 场景',
    '',
    ...s.scene,
    '',
    '## 原话',
    '',
    '无（AI 发现）',
    '',
    '## 已知的模块',
    '',
    ...s.modules.map((m) => `- ${m}`),
    '',
    '## 怎么算做完',
    '',
    ...s.done.map((d) => `- ${d}`),
    '',
    '（这张单由 `.github/workflows/e2e-flaky.yml` 自动开，判法在 `packages/conventions/src/e2e-flaky.ts`。）',
  ].join('\n');
}

export function brokenRoundBody(urls: readonly string[]): string {
  return issueSections({
    scene: [
      `最近连着 ${urls.length} 轮主线 e2e 整轮坏了：报告里有全局准备/备库的错，或首跑红的用例超过这一轮用例数的一半。这是环境或备库的事，不是哪条用例偶发，这几轮没有计入任何用例的偶发次数。同一时间只开这一张；最新一轮恢复正常时扫描会自动关掉它，再坏会重开。`,
      '',
      '先看这几轮的日志找整轮的根子（备库、起服务、全局准备）：',
      ...urls.map((u) => `- ${u}`),
    ],
    modules: [
      '`packages/web/e2e/`（全局准备、备库、起服务）',
      '`packages/store/src/testing/pg-fixtures.ts`（样例库）',
    ],
    done: [
      '找到整轮坏的根子并修掉，修法带能复现它的测试（或说明为什么只能靠主线 e2e 复现）',
      '修好之后主线 e2e 连着几轮没有整轮坏，下一次 `e2e-flaky.yml` 扫描不再报这张单',
    ],
  });
}

/** 汇总单的正文：达阈值的每条用例、偶发次数和最近一轮的链接。 */
export function flakySummaryBody(findings: readonly FlakyFinding[], until: string): string {
  return issueSections({
    scene: [
      `近 ${FLAKY_WINDOW} 轮主线 e2e 里有 ${findings.length} 条用例偶发（同一次运行里首跑红、重试才过）达到阈值（${FLAKY_THRESHOLD} 次）。超过 ${FLAKY_SUMMARY_OVER} 条一起出现多半是同一个根子（时序、夹具、环境），所以只开这一张汇总单，不逐条开。**限期 ${until} 前修掉。**`,
      '',
      ...findings.map(
        (f) => `- \`${keyText(f.key)}\`：${f.bad}/${f.ran}，失败 run ${f.urls.join('、') || '（没有链接）'}`,
      ),
    ],
    modules: ['`packages/web/e2e/`', '`packages/web/e2e/quarantine.json`'],
    done: [
      '找到这批用例共同的偶发根子并修掉（改用例、夹具或页面，不为凑绿放宽断言）；修不完的放进隔离集并各自开单限期',
      '下一次 `e2e-flaky.yml` 扫描达阈值的用例不超过 5 条',
    ],
  });
}

/** 失败 run 的键：GitHub Actions 运行号优先，这样正文里带 `/attempts/` 或尾斜杠也对得上。 */
export function runKey(url: string): string {
  const id = /\/actions\/runs\/(\d+)/.exec(url)?.[1];
  if (id) return `run:${id}`;
  return url.replace(/[),.;]+$/g, '').replace(/\/+$/, '');
}

/** 从正文或留言里抽出失败 run。有 Actions 运行号就只用运行号，避免把别的链接当成 run。 */
export function extractRunKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  for (const match of text.matchAll(/\/actions\/runs\/(\d+)/g)) {
    if (match[1]) add(`run:${match[1]}`);
  }
  if (keys.length === 0) {
    for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/g)) {
      if (match[0]) add(runKey(match[0]));
    }
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
  /** 关单原因是 completed 才采用正文里的 run；别的原因不证明修过。 */
  trust: boolean;
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
  return {
    kind: 'take',
    issue: {
      number: record.number as number,
      title: record.title,
      body: typeof record.body === 'string' ? record.body : '',
      trust: reason === 'completed',
    },
  };
}

function createdAtOf(meta: unknown): string | null {
  if (meta === null || typeof meta !== 'object') return null;
  const created = (meta as { created_at?: unknown }).created_at;
  if (typeof created !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(created)) return null;
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
 * 读同用例已完成处置里点名的失败 run。范围从窗口最旧一轮的创建时间起（更早的单不可能写进这些 run）。
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
    const text = [issue.body, ...comments.bodies].join('\n');
    if (!issue.trust) {
      const mentioned =
        issue.title === FLAKY_SUMMARY_TITLE
          ? Object.keys(evidenceFor(issue.title, text, titles))
          : [issue.title];
      if (mentioned.length === 0)
        return {
          status: 'unknown',
          reason: `证据不明：#${issue.number} 的关单原因不是已完成，也没点明是哪些用例`,
        };
      for (const title of mentioned) addHandled(byTest, title, { number: issue.number, runs: null });
      continue;
    }
    for (const [title, runs] of Object.entries(evidenceFor(issue.title, text, titles))) {
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
): Promise<{ ok: true; bodies: string[] } | { ok: false; reason: string }> {
  const bodies: string[] = [];
  for (let page = 1; page <= commentCap; page++) {
    const got = await get(`/issues/${number}/comments?per_page=${pageSize}&page=${page}`);
    if (!Array.isArray(got)) return { ok: false, reason: `证据不明：#${number} 的留言不是列表` };
    for (const comment of got) {
      if (comment === null || typeof comment !== 'object')
        return { ok: false, reason: `证据不明：#${number} 的留言有一条认不出` };
      const body = (comment as { body?: unknown }).body;
      if (body !== null && body !== undefined && typeof body !== 'string')
        return { ok: false, reason: `证据不明：#${number} 的留言正文认不出` };
      bodies.push(typeof body === 'string' ? body : '');
    }
    if (got.length < pageSize) return { ok: true, bodies };
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
 * 当前失败 run（新的在前）有没有超出已完成处置。
 * 最新一轮失败 run 已经点过名：窗口里更旧的失败不是新增（汇总单以前只写「最近一次」也算盖住）。
 * 有更新的失败 run、并且每张相关单都点得清：立刻立案。有一张单点不清、又盖不住这个新 run：未知，不当没有故障。
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
    if (row.runs === null || row.runs.length === 0) {
      unclear.push(row.number);
      continue;
    }
    for (const run of row.runs) known.add(run);
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

function flakyAction(title: string, judged: FlakyJudgement, create: () => IssueAction): IssueAction {
  if (judged.kind === 'covered')
    return { kind: 'covered', title, numbers: judged.numbers, label: coveredLabel(title, judged.numbers) };
  if (judged.kind === 'unknown')
    return { kind: 'unknown', title, reason: judged.reason, label: unknownLabel(title, judged.reason) };
  return create();
}

/** 一件要做的事：开新单，或给已开着的单留言补新的轮链接，或留言后关单（整轮坏的已恢复），或已有单不用动，或这次超了开单上限、下次再开，或旧采样已被已完成处置盖住，或证据没读清。 */
export type IssueAction =
  | { kind: 'create'; title: string; body: string; labels: string[]; label: string }
  | { kind: 'comment'; number: number; body: string; label: string }
  | { kind: 'close'; number: number; body: string; label: string }
  | { kind: 'exists'; label: string }
  | { kind: 'deferred'; title: string; label: string }
  | { kind: 'covered'; title: string; numbers: number[]; label: string }
  | { kind: 'unknown'; title: string; reason: string; label: string };

export interface OpenIssue {
  number: number;
  title: string;
  /** 正文；「整轮坏了」那张要把留言也拼在后面（补链接是留言），不然每次都会重复留。 */
  body?: string | null;
}

const IDLE_SCAN_LINE = '没有达到偶发阈值的用例，也没有要处理的「整轮坏了」单';

/** 没有任何动作时才说「没有偶发」。证据未知也是动作，不能说成没有故障。 */
export function idleScanLine(actions: readonly IssueAction[]): string | null {
  return actions.length === 0 ? IDLE_SCAN_LINE : null;
}

/** 有一张偶发单因为证据没读清而没开：扫描不能以成功收场。 */
export function evidenceUnresolved(actions: readonly IssueAction[]): boolean {
  return actions.some((action) => action.kind === 'unknown');
}

/**
 * 近几轮（新的在前）→ 要开/留言/关的单。「整轮坏了」只看最新一段：最新一轮是整轮坏的，才开那张固定标题的单
 * （已有开着的就只补没写过的轮链接），链接只列从最新往回连着坏的几轮；最新一轮是好的就不开，
 * 已有开着的「整轮坏了」单则留言关掉（再坏会重开）。没有任何一轮时不动（读不到不当成已恢复）。
 * 整轮坏了的轮不计入偶发；其余轮里偶发达阈值的用例各开一张偶发单，同标题已有开着的就不重开；达阈值的超过
 * FLAKY_SUMMARY_OVER 条只开（或补）一张汇总单。一次最多新开 MAX_NEW_ISSUES 张（capCreates），多的下次扫描再开（#2735）。
 * `settled` 是同用例已完成处置里的失败 run：不传则只按开着的单去重（旧调用）。传了之后，当前失败 run 没有超出
 * 已点名的那些就不新开，并写明原单；有更新的失败 run 且仍达阈值就照常开。查询没读全是「未知」，不开、也不当没有故障。
 */
export function planIssues(
  runs: readonly RunOutcomes[],
  open: readonly OpenIssue[],
  quarantine: readonly QuarantineEntry[],
  until: string,
  settled?: SettledEvidence,
): IssueAction[] {
  const actions: IssueAction[] = [];
  const streak = runs.findIndex((r) => !isBrokenRound(r));
  const broken = (streak === -1 ? runs : runs.slice(0, streak)).map((r) => r.url);
  const existing = open.find((i) => i.title === BROKEN_ROUND_TITLE);
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
  } else {
    if (!existing) {
      actions.push({
        kind: 'create',
        title: BROKEN_ROUND_TITLE,
        body: brokenRoundBody(broken),
        labels: [...ISSUE_LABELS],
        label: `${BROKEN_ROUND_TITLE}（${broken.length} 轮）`,
      });
    } else {
      const fresh = broken.filter((u) => !(existing.body ?? '').includes(u));
      actions.push(
        fresh.length > 0
          ? {
              kind: 'comment',
              number: existing.number,
              body: ['又有整轮坏了的轮：', ...fresh.map((u) => `- ${u}`)].join('\n'),
              label: `${BROKEN_ROUND_TITLE}：补 ${fresh.length} 轮链接到 #${existing.number}`,
            }
          : { kind: 'exists', label: `已有开着的单：${BROKEN_ROUND_TITLE}（#${existing.number}）` },
      );
    }
  }
  const findings = flakyTests(runs);
  if (findings.length > FLAKY_SUMMARY_OVER) {
    // 一轮里达阈值的太多：多半是同一个根子，只开（或补）一张汇总单，不逐条开
    const summary = open.find((i) => i.title === FLAKY_SUMMARY_TITLE);
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
      const fresh = findings.filter((f) => !(summary.body ?? '').includes(keyText(f.key)));
      actions.push(
        fresh.length > 0
          ? {
              kind: 'comment',
              number: summary.number,
              body: [
                '又有用例达到偶发阈值：',
                ...fresh.map(
                  (f) => `- \`${keyText(f.key)}\`：${f.bad}/${f.ran}，失败 run ${f.urls.join('、')}`,
                ),
              ].join('\n'),
              label: `${FLAKY_SUMMARY_TITLE}：补 ${fresh.length} 条到 #${summary.number}`,
            }
          : { kind: 'exists', label: `已有开着的单：${FLAKY_SUMMARY_TITLE}（#${summary.number}）` },
      );
    }
  } else {
    for (const f of findings) {
      const title = issueTitle(f.key);
      if (open.some((i) => i.title === title)) {
        actions.push({ kind: 'exists', label: `已有开着的单：${title}（${f.bad}/${f.ran}）` });
        continue;
      }
      const quarantined = quarantine.some((q) => keyText(q) === keyText(f.key));
      actions.push(
        flakyAction(title, judgeFlaky(title, f.urls, settled), () => ({
          kind: 'create',
          title,
          body: issueBody(f, until, quarantined),
          labels: [...ISSUE_LABELS],
          label: `开了单：${title}（${f.bad}/${f.ran}）`,
        })),
      );
    }
  }
  return capCreates(actions, MAX_NEW_ISSUES);
}

/** 一次最多新开 max 张单：按顺序（整轮坏了、汇总或逐条偶发在前的先开），多出来的改成「这次不开、下次再说」，留言、关单不受限。 */
export function capCreates(actions: readonly IssueAction[], max = MAX_NEW_ISSUES): IssueAction[] {
  let created = 0;
  return actions.map((a) => {
    if (a.kind !== 'create') return a;
    if (created < max) {
      created++;
      return a;
    }
    return {
      kind: 'deferred',
      title: a.title,
      label: `这次不开：${a.title}（一次扫描最多新开 ${max} 张，下次扫描还达阈值再开）`,
    };
  });
}

/** 限期：今天起 7 天。 */
export function deadline(now: Date, days = 7): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function issueBody(f: FlakyFinding, until: string, quarantined: boolean): string {
  const entry = JSON.stringify({ file: f.key.file, title: f.key.title, issue: 0, until });
  return issueSections({
    scene: [
      `驾驶舱 e2e 的用例 \`${keyText(f.key)}\` 在近 ${FLAKY_WINDOW} 轮主线 e2e 里偶发（首跑红、重试才过）${f.bad} 次（跑了 ${f.ran} 次），达到偶发阈值（${FLAKY_THRESHOLD} 次，决定 0093）。**限期 ${until} 前修掉。**`,
      '',
      quarantined
        ? '它已经在隔离集（`packages/web/e2e/quarantine.json`）里：照跑、照报，不挡发版。'
        : `先把它放进隔离集（\`packages/web/e2e/quarantine.json\` 的 tests 里加一条，issue 填本单号），放进去后照跑、照报，不挡发版：\n\n\`\`\`json\n${entry}\n\`\`\``,
      '',
      '最近偶发的几轮：',
      ...f.urls.map((u) => `- ${u}`),
    ],
    modules: [`\`packages/web/e2e/specs/${f.key.file}\``, '`packages/web/e2e/quarantine.json`'],
    done: [
      `找到 \`${keyText(f.key)}\` 首跑红的时序或隔离上的根子并修掉（改用例或改页面，不为凑绿放宽断言）`,
      '`packages/web/e2e/quarantine.json` 里没有这一条',
    ],
  });
}

/** 一轮的汇总（写进 Actions 的 job 摘要）：偶发的、隔离集里的各自结局、过了限期还在隔离集里的。 */
export function runSummary(
  outcomes: Outcomes,
  quarantine: readonly QuarantineEntry[],
  today: string,
): string {
  const lines: string[] = ['## 驾驶舱 e2e：偶发与隔离集'];
  const flaky = [...outcomes.values()].filter((o) => o.outcome === 'flaky');
  lines.push(
    '',
    flaky.length ? `首跑红、重试过了（flaky）${flaky.length} 条：` : '没有偶发（flaky）的用例。',
  );
  for (const o of flaky) lines.push(`- ${keyText(o.key)}`);
  if (quarantine.length) {
    lines.push('', `隔离集 ${quarantine.length} 条（照跑、照报，不挡）：`);
    for (const q of quarantine) {
      const got = outcomes.get(keyText(q));
      const overdue = q.until < today ? '，**过了限期**' : '';
      lines.push(
        `- ${keyText(q)}：${got ? got.outcome : '这一轮没跑'}（#${q.issue}，限期 ${q.until}${overdue}）`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
