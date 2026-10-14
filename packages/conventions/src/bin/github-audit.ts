// GitHub 对账入口（见 ../github-audit.ts）：node packages/conventions/src/bin/github-audit.ts [--comment] [--soft]
// pnpm github:audit：只打印查出来的。--comment：再把挂得到单上的留言到那张单上（同一条只留一次）。
// 只给 .github/workflows/github-audit.yml 的定时任务和人手跑用，别接进 PR 的必过检查（#87：必过检查必须确定）。
// 退出码 0 = 没有断裂；1 = 有断裂（逐条列出；留言留过了也一样红，修好才绿）；2 = 没查成（读不到 GitHub、留言没留成），同样是红。
// --soft（定时任务用）：有断裂只列成警告、退出 0——断裂已经留言到各自的单上，天天标红没人修只是噪音；没查成仍退出 2。
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exitWith, runMain } from '../exit.ts';
import { reportFindings } from '../findings.ts';
import { liveGitHub, repoName } from '../github-api.ts';
import { auditGitHub } from '../github-audit.ts';
import { annotation } from '../pr-fields.ts';

// 退出不用 process.exit（Windows 上偶发崩成 3221226505，../exit.ts）：提前退出用 exitWith，runMain 接住设退出码。
runMain(async () => {
  const USAGE = '用法：github-audit.ts [--comment] [--soft]';
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const out = (line: string) => console.log(line);
  let comment = false;
  let soft = false;
  try {
    const { values } = parseArgs({
      options: { comment: { type: 'boolean' }, soft: { type: 'boolean' } },
      strict: true,
    });
    comment = values.comment === true;
    soft = values.soft === true;
  } catch (e) {
    console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
    exitWith(2);
  }

  const err = (line: string, level: 'error' | 'warning' = 'error') =>
    console.error(inActions ? annotation(line, level) : line);

  const name = repoName(process.env, root);
  if (!name) {
    err('没查成：认不出是哪个仓（没有 GITHUB_REPOSITORY，origin 也不是 GitHub 地址）。');
    exitWith(2);
  }
  const gh = liveGitHub(name, process.env);
  const r = await auditGitHub(gh, new Date());
  const notQueried = [...r.notQueried];

  for (const f of r.findings) err(f.text, soft ? 'warning' : 'error');
  if (comment && r.findings.length) {
    const rep = await reportFindings(
      r.findings,
      gh,
      'GitHub 对账（.github/workflows/github-audit.yml，#654）查出来的，挂在这张单上，修好它就不再报：',
    );
    if (rep.posted.length) out(`留言了：${rep.posted.map((n) => `#${n}`).join('、')}。`);
    if (rep.already) out(`${rep.already} 条以前留过言，这次没再留。`);
    notQueried.push(...rep.errors);
  }
  for (const w of notQueried) err(`没查成：${w}。`);

  if (notQueried.length) process.exitCode = 2;
  else if (r.findings.length) process.exitCode = soft ? 0 : 1;
  else out(`GitHub 对账过了：开着的单 ${r.checked.issues} 张、版本 ${r.checked.versions} 个，没有断裂。`);
  return undefined;
});
