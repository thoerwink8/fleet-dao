// 驾驶舱 e2e 的偶发统计（决定 0093，判法在 ../e2e-flaky.ts）。两种用法：
//   node packages/conventions/src/bin/e2e-flaky.ts summary <Playwright JSON 报告>...
//     一轮的汇总（偶发的、隔离集里的结局、过了限期的），打到标准输出；ci.yml 的 e2e job 接进 job 摘要。
//   node packages/conventions/src/bin/e2e-flaky.ts scan <runs.json> <报告目录>
//     runs.json 是 `gh run list --json databaseId,url` 的输出（新的在前）。报告目录下 <运行号>/<artifact 名>/results*.json
//     是那一轮下载下来的报告（artifact 名 e2e-<运行号>-<第几次运行>-<分片>）。主线红了只重跑失败的分片：每一片取它最后一次，
//     再合成一轮，不把两次运行当成两轮，也别漏掉没重跑的那一片。旧的平铺 results*.json 仍当成分片合在一起。
//     取有报告的近 10 轮，数每条用例偶发（重试才过）的次数，达阈值的开单（同标题已有开着的单就不开；超过 5 条只开一张汇总单；
//     一次最多新开 3 张，多的下次再开）；
//     最新一轮整轮坏了开「整轮坏了」单，最新一轮好了就把开着的那张留言关掉。要 GITHUB_TOKEN、GITHUB_REPOSITORY。
// 读不到、认不出就退出码 1 并明说，不把「没查成」当「没有偶发」。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROKEN_ROUND_TITLE,
  deadline,
  FLAKY_WINDOW,
  isBrokenRound,
  type OpenIssue,
  type Outcomes,
  outcomesOf,
  parseQuarantine,
  planIssues,
  type RunOutcomes,
  runFromArtifacts,
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
      const files = collectReports(runDir);
      if (files.length === 0) continue;
      window.push(runFromArtifacts(run.url, files));
    }
    console.log(`近 ${window.length} 轮有报告的主线 e2e（最多看 ${FLAKY_WINDOW} 轮）`);
    const brokenCount = window.filter(isBrokenRound).length;
    if (brokenCount > 0) console.log(`其中 ${brokenCount} 轮整轮坏了，不计入用例的偶发次数`);
    // 开着的「整轮坏了」单要核对最新一轮（好了就关），所以每次都读开着的单，不再「没偶发就不读」。
    {
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
      const actions = planIssues(window, open, quarantine, deadline(new Date()));
      if (actions.length === 0) console.log('没有达到偶发阈值的用例，也没有要处理的「整轮坏了」单');
      for (const a of actions) {
        if (a.kind === 'create')
          await api.post('/issues', { title: a.title, body: a.body, labels: a.labels });
        else if (a.kind === 'comment') await api.post(`/issues/${a.number}/comments`, { body: a.body });
        else if (a.kind === 'close') {
          await api.post(`/issues/${a.number}/comments`, { body: a.body });
          await api.patch(`/issues/${a.number}`, { state: 'closed', state_reason: 'completed' });
        }
        console.log(a.label);
      }
    }
  } else {
    console.error('用法：e2e-flaky.ts summary <报告>... | e2e-flaky.ts scan <runs.json> <报告目录>');
    exitWith(2);
  }
  return undefined;
});

/** 一轮目录里的报告：子目录名是 artifact 名（带第几次运行），根上的 results*.json 是旧的平铺。 */
function collectReports(runDir: string): { name: string; report: unknown }[] {
  const out: { name: string; report: unknown }[] = [];
  const push = (name: string, file: string) => {
    out.push({ name, report: JSON.parse(readFileSync(file, 'utf8')) as unknown });
  };
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = join(runDir, entry.name);
      for (const name of readdirSync(sub)) {
        if (/^results.*\.json$/.test(name)) push(`${entry.name}/${name}`, join(sub, name));
      }
    } else if (/^results.*\.json$/.test(entry.name)) {
      push(entry.name, join(runDir, entry.name));
    }
  }
  return out;
}
