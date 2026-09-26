// PR 补贴入口（.github/workflows/pr-labels.yml）：node packages/conventions/src/bin/pr-labels.ts [--dry-run]
// 从事件（GITHUB_EVENT_PATH）认出是哪个 PR，用 GITHUB_TOKEN 现读它和对应 issue，缺类别标签、里程碑就照抄 issue 的。
// 提醒写进 job summary（GITHUB_STEP_SUMMARY），不失败；退出码 2 = 没补成（读、写 GitHub 出错，summary 写不进去）。
// 本机试跑：GITHUB_EVENT_PATH 指向一个 {"pull_request":{"number":N}} 的文件，带 --dry-run 只说要补什么。
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveGitHub, repoName } from '../github-api.ts';
import { annotation } from '../pr-fields.ts';
import { runPrLabels } from '../pr-labels.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const env = process.env;
const inActions = env.GITHUB_ACTIONS === 'true';
const repo = repoName(env, root);
const result = repo
  ? await runPrLabels({
      eventPath: env.GITHUB_EVENT_PATH,
      gh: liveGitHub(repo, env),
      dryRun: process.argv.includes('--dry-run'),
    })
  : {
      code: 2 as const,
      lines: ['没补成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也认不出）。'],
      notes: [],
    };

let code: number = result.code;
for (const line of result.lines) {
  if (code === 0) console.log(line);
  else console.error(inActions ? annotation(line) : line);
}
for (const note of result.notes)
  console.log(inActions ? `::warning::${note.replace(/%/g, '%25')}` : `提醒：${note}`);

const summary = [
  '### PR 补贴（类别标签、里程碑）',
  '',
  ...result.lines.map((l) => `- ${l}`),
  ...result.notes.map((n) => `- 提醒：${n}`),
  ...(result.lines.length + result.notes.length === 0 ? ['- 不用补。'] : []),
  '',
].join('\n');
if (env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  } catch (e) {
    console.error(
      `没补成：job summary 写不进去（${e instanceof Error ? e.message : String(e)}），提醒没人看得到。`,
    );
    code = 2;
  }
} else if (inActions) {
  console.error('没补成：Actions 里没有 GITHUB_STEP_SUMMARY，提醒没地方写。');
  code = 2;
}
process.exitCode = code;
