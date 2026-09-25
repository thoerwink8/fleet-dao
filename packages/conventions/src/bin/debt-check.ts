// 欠账检查入口（#67、#87，见 ../debt.ts）：node packages/conventions/src/bin/debt-check.ts [--live [--comment]]
// 不带参数：只看文件（推后的话带没带单号、需求.md 写没写怎么算做完），不读 GitHub，没网也能跑；
//   .github/workflows/debt.yml 在 PR 和主线上跑它，只报告、不挡 PR（创始人 2026-09-26「流程只为快」）。
// --live：另读 GitHub——挂的单号开没开着、开着的 issue 有没有需求文档。只给 .github/workflows/debt.yml 的定时任务用，
//   别接进 PR 的必过检查（#87）。加 --comment 把查出来的留言到对应的单上（同一条只留一次）。
// 退出码 0 = 没欠账，或查出来的都留言到单上了；1 = 有欠账没落到单上（逐条列出）；2 = 没查成（读不到文档或 GitHub、留言没留成）。
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkDebtDocs, liveDebt, reportFindings } from '../debt.ts';
import { liveGitHub, repoName } from '../github-api.ts';
import { annotation } from '../pr-fields.ts';
import { fsRepo } from '../repo.ts';

const USAGE = '用法：debt-check.ts [--live [--comment]]';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const inActions = process.env.GITHUB_ACTIONS === 'true';
const out = (line: string) => console.log(line);
const err = (line: string) => console.error(inActions ? annotation(line) : line);

let live = false;
let comment = false;
try {
  const { values } = parseArgs({
    options: { live: { type: 'boolean' }, comment: { type: 'boolean' } },
    strict: true,
  });
  live = values.live === true;
  comment = values.comment === true;
  if (comment && !live) throw new Error('--comment 要和 --live 一起用');
} catch (e) {
  console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
  process.exit(2);
}

const repo = fsRepo(root);
if (!live) {
  const { code, lines } = checkDebtDocs(repo);
  for (const line of lines) (code === 0 ? out : err)(line);
  process.exitCode = code;
} else {
  const name = repoName(process.env, root);
  if (!name) {
    err('没查成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。');
    process.exit(2);
  }
  const gh = liveGitHub(name, process.env);
  const r = await liveDebt({ repo, gh });
  for (const line of r.docs.lines) (r.docs.code === 0 ? out : err)(line);
  for (const n of r.notes) out(`提醒：${n}。`);
  let code: 0 | 1 | 2 = r.docs.code;
  const notQueried = [...r.notQueried];
  let loose = r.findings;
  if (comment && r.findings.length) {
    const rep = await reportFindings(r.findings, gh);
    if (rep.posted.length) out(`留言了：${rep.posted.map((n) => `#${n}`).join('、')}。`);
    if (rep.already) out(`${rep.already} 条以前留过言，这次没再留。`);
    notQueried.push(...rep.errors);
    loose = rep.unattached;
  }
  for (const f of loose) err(f.text);
  for (const w of notQueried) err(`没查成：${w}。`);
  if (notQueried.length) code = 2;
  else if (loose.length && code === 0) code = 1;
  if (code === 0 && r.findings.length === 0) out('挂的单号都开着，开着的 issue 都有需求文档。');
  process.exitCode = code;
}
