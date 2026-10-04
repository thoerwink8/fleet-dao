// 分支体检入口（见 ../branch-hygiene.ts）：node packages/conventions/src/bin/branch-hygiene.ts [--delete] [--board] [--report <文件>]
// pnpm branch:hygiene：只判、只打（每条分支落哪档、为什么、谁开的），一条不删。先 git fetch origin：内容按本地 git 比。
// --delete：真删判了「删」的；--board：写巡检单（正文和新列的留言）；--report：把整张表写进这个文件（Markdown）。
// 在 Actions 里（.github/workflows/github-audit.yml 的 branches）带 --delete --board 跑，整张表另写进运行摘要。
// 只给定时任务和人手跑用，别接进 PR 的必过检查（#87：必过检查必须确定）。
// 退出码 0 = 都判了（有等人定的也是 0：那是排着等人的事）；1 = 有删失败的；2 = 没查成（读不到 GitHub、某条分支读不到、
// 巡检单没写成），同样是红。
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { GitExec } from '../branch-git.ts';
import { branchHygiene, reportMarkdown } from '../branch-hygiene.ts';
import { liveGitHub, repoName } from '../github-api.ts';
import { annotation } from '../pr-fields.ts';

const USAGE = '用法：branch-hygiene.ts [--delete] [--board] [--report <文件>]';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const inActions = process.env.GITHUB_ACTIONS === 'true';
const out = (line: string) => console.log(line);
const err = (line: string) => console.error(inActions ? annotation(line) : line);

let values: { delete?: boolean; board?: boolean; report?: string };
try {
  values = parseArgs({
    options: { delete: { type: 'boolean' }, board: { type: 'boolean' }, report: { type: 'string' } },
    strict: true,
  }).values;
} catch (e) {
  console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
  process.exit(2);
}

const name = repoName(process.env, root);
if (!name) {
  err('没查成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。');
  process.exit(2);
}

const git: GitExec = (args, input) => {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

const now = new Date();
const r = await branchHygiene(
  { gh: liveGitHub(name, process.env), git, repo: name, now },
  { delete: values.delete === true, board: values.board === true },
);

const label = { delete: '删', keep: '留', ask: '等人定', unknown: '没查成' } as const;
for (const kind of ['delete', 'ask', 'keep', 'unknown'] as const) {
  for (const x of r.reports.filter((y) => y.verdict.kind === kind)) {
    out(`${label[kind]}  ${x.name}（${x.sha.slice(0, 9)}）：${x.verdict.why}｜谁开的：${x.who}`);
  }
}
const md = reportMarkdown(r, now);
if (values.report) writeFileSync(values.report, md);
if (inActions && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

const count = (k: keyof typeof label) => r.reports.filter((x) => x.verdict.kind === k).length;
out(
  `远端 ${r.reports.length} 条分支：判删 ${count('delete')}、留 ${count('keep')}、等人定 ${count('ask')}、没查成 ${count('unknown')}。`,
);
if (values.delete) {
  out(`删了 ${r.deleted.length} 条${r.gone.length ? `，删时已不在 ${r.gone.length} 条` : ''}。`);
  for (const s of r.skipped) out(`没删 ${s.name}：${s.why}`);
} else if (count('delete')) {
  out('只判没删（带 --delete 才删）。');
}
if (r.board) {
  out(
    `巡检单 #${r.board.number}${r.board.created ? '（这次新开的）' : ''}${r.board.newAsks.length ? `：新列了 ${r.board.newAsks.length} 条等人定` : ''}。`,
  );
}
for (const n of r.notes) out(n);
for (const f of r.failed) err(`删失败：${f.name}：${f.why}`);
for (const w of r.notQueried) err(`没查成：${w}。`);

if (r.notQueried.length) process.exitCode = 2;
else if (r.failed.length) process.exitCode = 1;
