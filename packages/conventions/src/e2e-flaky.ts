// 驾驶舱 e2e 的偶发失败（决定 0093）：首跑红、重试过了的用例 Playwright 标成 flaky，这一轮不算红（retries=1，packages/web/e2e/playwright.config.ts）。
// 同一条用例在近 10 轮主线 e2e 里首跑红到 2 次就算「常偶发」：开一张单（限期修、带最近几次失败的链接），单里写明把它加进隔离集
// （packages/web/e2e/quarantine.json：照跑、照报，不挡这一轮；ci.yml 的 e2e job 跳过它们、e2e-quarantine.yml 每天单跑，按它挑用例的是 packages/web/e2e/support/quarantine.ts）。
// 这里只有纯函数：读 Playwright 的 JSON 报告、数次数、拼单子；取报告（gh run download）和开单在 .github/workflows/e2e-flaky.yml 和 bin/e2e-flaky.ts。

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

/** 一轮主线 e2e：运行的链接和它的报告读出来的结局。 */
export interface RunOutcomes {
  url: string;
  outcomes: Outcomes;
}

export interface FlakyFinding {
  key: TestKey;
  /** 窗口里首跑红（偶发或真红）的轮数。 */
  bad: number;
  /** 窗口里跑了这条用例的轮数。 */
  ran: number;
  /** 首跑红的那几轮的链接，新的在前。 */
  urls: string[];
}

export const FLAKY_WINDOW = 10;
export const FLAKY_THRESHOLD = 2;

/**
 * runs 是新的在前的若干轮（调用方给近 FLAKY_WINDOW 轮）。数每条用例首跑红的轮数（偶发和真红都算：真红是还没修的，
 * 偶发是重试才过的），达 threshold 的列出来。只真红过一次、其余都过的不算（那是改坏了又修好了）。
 */
export function flakyTests(runs: readonly RunOutcomes[], threshold = FLAKY_THRESHOLD): FlakyFinding[] {
  const tally = new Map<string, FlakyFinding>();
  for (const run of runs) {
    for (const [id, { key, outcome }] of run.outcomes) {
      if (outcome === 'skipped') continue;
      const f = tally.get(id) ?? { key, bad: 0, ran: 0, urls: [] };
      f.ran++;
      if (outcome === 'flaky' || outcome === 'failed') {
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

/** 限期：今天起 7 天。 */
export function deadline(now: Date, days = 7): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function issueBody(f: FlakyFinding, until: string, quarantined: boolean): string {
  const entry = JSON.stringify({ file: f.key.file, title: f.key.title, issue: 0, until });
  return [
    `驾驶舱 e2e 的用例 \`${keyText(f.key)}\` 在近 ${FLAKY_WINDOW} 轮主线 e2e 里首跑红了 ${f.bad} 次（跑了 ${f.ran} 次），达到偶发阈值（${FLAKY_THRESHOLD} 次，决定 0093）。`,
    '',
    `**限期 ${until} 前修掉**：找到时序或隔离上的根子，修好后从隔离集删掉这一条。`,
    '',
    quarantined
      ? '它已经在隔离集（`packages/web/e2e/quarantine.json`）里：照跑、照报，不挡发版。'
      : `先把它放进隔离集（\`packages/web/e2e/quarantine.json\` 的 tests 里加一条，issue 填本单号），放进去后照跑、照报，不挡发版：\n\n\`\`\`json\n${entry}\n\`\`\``,
    '',
    '最近首跑红的几轮：',
    ...f.urls.map((u) => `- ${u}`),
    '',
    '（这张单由 `.github/workflows/e2e-flaky.yml` 自动开，统计法在 `packages/conventions/src/e2e-flaky.ts`。）',
  ].join('\n');
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
