// 驾驶舱 e2e 的偶发统计（决定 0093，判法在 ../e2e-flaky.ts）。两种用法：
//   node packages/conventions/src/bin/e2e-flaky.ts summary <Playwright JSON 报告>...
//     一轮的汇总（偶发的、隔离集里的结局、过了限期的），打到标准输出；ci.yml 的 e2e job 接进 job 摘要。
//   node packages/conventions/src/bin/e2e-flaky.ts scan <runs.json> <报告目录>
//     runs.json 是 `gh run list --json databaseId,url` 的输出（新的在前），报告目录下 <运行号>/results*.json 是那一轮下载下来的报告；
//     取有报告的近 10 轮，数每条用例首跑红的次数，达阈值的开单（同标题已有开着的单就不开）。要 GITHUB_TOKEN、GITHUB_REPOSITORY。
// 读不到、认不出就退出码 1 并明说，不把「没查成」当「没有偶发」。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROKEN_ROUND_TITLE,
  deadline,
  FLAKY_WINDOW,
  flakyTests,
  globalErrorCount,
  isBrokenRound,
  type OpenIssue,
  type Outcomes,
  outcomesOf,
  parseQuarantine,
  planIssues,
  type RunOutcomes,
  runSummary,
} from '../e2e-flaky.ts';
import { exitWith, runMain } from '../exit.ts';
import { ghApi } from '../gh-api.ts';

// 退出不用 process.exit（Windows 上偶发崩成 3221226505，../exit.ts）：提前退出用 exitWith，runMain 接住设退出码。
runMain(async () => {
  const QUARANTINE = join(import.meta.dirname, '..', '..', '..', 'web', 'e2e', 'quarantine.json');
  const quarantine = parseQuarantine(readFileSync(QUARANTINE, 'utf8'));

  function readReports(files: readonly string[]) {
    const all: Outcomes = new Map();
    for (const f of files)
      for (const [k, v] of outcomesOf(JSON.parse(readFileSync(f, 'utf8')))) all.set(k, v);
    return all;
  }

  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'summary' && args.length > 0) {
    const present = args.filter((f) => existsSync(f));
    if (present.length === 0) {
      console.log('## 驾驶舱 e2e：偶发与隔离集\n\n没有报告（e2e 没跑到出报告那一步，看上面的日志）。');
    } else {
      process.stdout.write(
        runSummary(readReports(present), quarantine, new Date().toISOString().slice(0, 10)),
      );
    }
  } else if (mode === 'scan' && args.length === 2) {
    const [runsFile, dir] = args as [string, string];
    const runs = JSON.parse(readFileSync(runsFile, 'utf8')) as { databaseId: number; url: string }[];
    const window: RunOutcomes[] = [];
    for (const run of runs) {
      if (window.length >= FLAKY_WINDOW) break;
      const runDir = join(dir, String(run.databaseId));
      if (!existsSync(runDir)) continue;
      const files = readdirSync(runDir)
        .filter((f) => /^results.*\.json$/.test(f))
        .map((f) => join(runDir, f));
      if (files.length === 0) continue;
      const reports = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as unknown);
      const all: Outcomes = new Map();
      for (const r of reports) for (const [k, v] of outcomesOf(r)) all.set(k, v);
      window.push({
        url: run.url,
        outcomes: all,
        globalError: reports.some((r) => globalErrorCount(r) > 0),
      });
    }
    console.log(`近 ${window.length} 轮有报告的主线 e2e（最多看 ${FLAKY_WINDOW} 轮）`);
    const brokenCount = window.filter(isBrokenRound).length;
    if (brokenCount > 0) console.log(`其中 ${brokenCount} 轮整轮坏了，不计入用例的偶发次数`);
    if (brokenCount === 0 && flakyTests(window).length === 0) {
      console.log('没有达到偶发阈值的用例');
    } else {
      const api = ghApi(process.env);
      const open: OpenIssue[] = [];
      for (let page = 1; page <= 5; page++) {
        const got = (await api.get(`/issues?state=open&per_page=100&page=${page}`)) as OpenIssue[];
        open.push(...got);
        if (got.length < 100) break;
      }
      const broken = open.find((i) => i.title === BROKEN_ROUND_TITLE);
      if (broken) {
        const comments = (await api.get(`/issues/${broken.number}/comments?per_page=100`)) as {
          body?: string | null;
        }[];
        broken.body = [broken.body ?? '', ...comments.map((c) => c.body ?? '')].join('\n');
      }
      for (const a of planIssues(window, open, quarantine, deadline(new Date()))) {
        if (a.kind === 'create') await api.post('/issues', { title: a.title, body: a.body });
        else if (a.kind === 'comment') await api.post(`/issues/${a.number}/comments`, { body: a.body });
        console.log(a.label);
      }
    }
  } else {
    console.error('用法：e2e-flaky.ts summary <报告>... | e2e-flaky.ts scan <runs.json> <报告目录>');
    exitWith(2);
  }
  return undefined;
});
