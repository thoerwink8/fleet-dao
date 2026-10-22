// 驾驶舱 e2e 的偶发失败（决定 0093）：首跑红、重试过了的用例 Playwright 标成 flaky，这一轮不算红（retries=1，packages/web/e2e/playwright.config.ts）。
// 同一条用例在近 10 轮主线 e2e 里偶发（首跑红、同一次运行里重试才过）到 2 次就算「常偶发」；重试也红的是真红，不算（#2735）。常偶发的开一张单（限期修、带最近几次失败的链接），单里写明把它加进隔离集
// （packages/web/e2e/quarantine.json：照跑、照报，不挡这一轮；ci.yml 的 e2e job 跳过它们、e2e-quarantine.yml 每天单跑，按它挑用例的是 packages/web/e2e/support/quarantine.ts）。
// 先判整轮（#2499）：一轮里首跑红的用例超过这一轮用例数的一半、或报告里有全局准备/备库的错，这轮记「整轮坏了」，不计入任何用例的次数，
// 只汇成一张固定标题的「主线 e2e 整轮坏了」单（同一时间只一张），免得环境坏一次就给每条用例各开一张偶发单。
// 这里只有纯函数：读 Playwright 的 JSON 报告、数次数、拼单子；取报告（gh run download）和开单在 .github/workflows/e2e-flaky.yml 和 bin/e2e-flaky.ts。

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

/** 正文的四节（场景、原话、已知的模块、怎么算做完）加缺陷类必填的「影响」，和 pnpm issue:new 开的单一样，不然引擎不拉、对账报缺。 */
function issueSections(s: { scene: string[]; impact: string; modules: string[]; done: string[] }): string {
  return [
    '## 场景',
    '',
    ...s.scene,
    '',
    '## 影响',
    '',
    s.impact,
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
    impact: '主线 CI 红：整轮 e2e 坏着，发版前的 e2e 把关形同虚设，每轮红都会打扰创始人。',
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
        (f) => `- \`${keyText(f.key)}\`：${f.bad}/${f.ran}，最近一次 ${f.urls[0] ?? '（没有链接）'}`,
      ),
    ],
    impact: `主线 CI 红：${findings.length} 条用例偶发，主线 e2e 时红时绿，一轮做成率被拖低、冷验收可能被误拒。`,
    modules: ['`packages/web/e2e/`', '`packages/web/e2e/quarantine.json`'],
    done: [
      '找到这批用例共同的偶发根子并修掉（改用例、夹具或页面，不为凑绿放宽断言）；修不完的放进隔离集并各自开单限期',
      '下一次 `e2e-flaky.yml` 扫描达阈值的用例不超过 5 条',
    ],
  });
}

/** 一件要做的事：开新单，或给已开着的单留言补新的轮链接，或留言后关单（整轮坏的已恢复），或已有单不用动，或这次超了开单上限、下次再开。 */
export type IssueAction =
  | { kind: 'create'; title: string; body: string; labels: string[]; label: string }
  | { kind: 'comment'; number: number; body: string; label: string }
  | { kind: 'close'; number: number; body: string; label: string }
  | { kind: 'exists'; label: string }
  | { kind: 'deferred'; title: string; label: string };

export interface OpenIssue {
  number: number;
  title: string;
  /** 正文；「整轮坏了」那张要把留言也拼在后面（补链接是留言），不然每次都会重复留。 */
  body?: string | null;
}

/**
 * 近几轮（新的在前）→ 要开/留言/关的单。「整轮坏了」只看最新一段：最新一轮是整轮坏的，才开那张固定标题的单
 * （已有开着的就只补没写过的轮链接），链接只列从最新往回连着坏的几轮；最新一轮是好的就不开，
 * 已有开着的「整轮坏了」单则留言关掉（再坏会重开）。没有任何一轮时不动（读不到不当成已恢复）。
 * 整轮坏了的轮不计入偶发；其余轮里偶发达阈值的用例各开一张偶发单，同标题已有开着的就不重开；达阈值的超过
 * FLAKY_SUMMARY_OVER 条只开（或补）一张汇总单。一次最多新开 MAX_NEW_ISSUES 张（capCreates），多的下次扫描再开（#2735）。
 */
export function planIssues(
  runs: readonly RunOutcomes[],
  open: readonly OpenIssue[],
  quarantine: readonly QuarantineEntry[],
  until: string,
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
      actions.push({
        kind: 'create',
        title: FLAKY_SUMMARY_TITLE,
        body: flakySummaryBody(findings, until),
        labels: [...ISSUE_LABELS],
        label: `开了单：${FLAKY_SUMMARY_TITLE}（${findings.length} 条）`,
      });
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
                  (f) => `- \`${keyText(f.key)}\`：${f.bad}/${f.ran}，最近一次 ${f.urls[0] ?? ''}`,
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
      actions.push({
        kind: 'create',
        title,
        body: issueBody(f, until, quarantined),
        labels: [...ISSUE_LABELS],
        label: `开了单：${title}（${f.bad}/${f.ran}）`,
      });
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
    impact: `主线 CI 红：\`${keyText(f.key)}\` 近 ${FLAKY_WINDOW} 轮偶发 ${f.bad} 次，主线 e2e 时红时绿，一轮做成率被拖低、冷验收可能被误拒。`,
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
