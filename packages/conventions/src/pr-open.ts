// 开 PR、挂自动合并收成一个必经命令（pnpm pr:open，全仓审查第 2 路清单 1 号）：最近 40 个 PR 里 9 个没挂自动合并、
// CI 绿了闲着共 3993 秒，兜底的引擎又关着——挂不挂不再靠人记，开 PR 的这一步就判完、挂上。
// - 没碰改标准路径（standard-paths.json）就当场 gh pr merge --auto --squash。碰先审后合路径的也挂：merge-gate 是必过检查，
//   没有通过的 second-opinion 合不进去；只多打一行提醒要跑第二意见。
// - 碰了改标准就不挂，打「人闸：改标准，等创始人同意」；带 --founder-approved 才挂（正文里要有一段含「原话」二字——
//   贴着他的原话和时间；命令只查这两个字，不做更多猜测）。
// - 草稿、带 --no-automerge 的不挂（工人领了改标准的活用后者）。
// 退出码：0 开成了（挂上了，或照规矩不挂、写明为什么）；1 用法不对（什么也没做）；2 没做成：清单读不到、gh 没跑成、
// 输出认不出、改了哪些文件没查成、自动合并没挂成（PR 可能已经开了，照实写明开了哪个、卡在哪一步）。
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Gh, judgePaths, listOf, loadPathLists, prFiles, reasonOf } from './pr-arm.ts';
import { parseCreatedPr } from './publish-actions.ts';

export const PR_OPEN_USAGE = `用法：pnpm pr:open --title <标题> --body-file <正文文件> [--draft] [--base <分支>] [--founder-approved] [--no-automerge]
  在要开 PR 的分支上跑（先 git push）。开 PR，没碰改标准路径就当场挂自动合并（squash）。
  --founder-approved  改标准、创始人已经同意：正文里要有一段贴着他的原话和时间（含「原话」二字）
  --no-automerge      只开 PR、不挂自动合并`;

export interface OpenDeps {
  gh: Gh;
  /** 仓根：读两份路径清单。 */
  root: string;
  /** 正文文件的相对路径从这里算。 */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const SO = 'node agents/skills/discuss/scripts/second-opinion.mjs';

export function prOpen(argv: string[], deps: OpenDeps): number {
  const { gh, out, err } = deps;
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        title: { type: 'string', short: 't' },
        'body-file': { type: 'string', short: 'F' },
        draft: { type: 'boolean', short: 'd' },
        base: { type: 'string', short: 'B' },
        'founder-approved': { type: 'boolean' },
        'no-automerge': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n${PR_OPEN_USAGE}`);
    return 1;
  }
  if (values.help) {
    out(PR_OPEN_USAGE);
    return 0;
  }
  const title = typeof values.title === 'string' ? values.title.trim() : '';
  const bodyArg = typeof values['body-file'] === 'string' ? values['body-file'] : '';
  if (!title || !bodyArg) {
    err(`要带 --title 和 --body-file（不进交互）。\n${PR_OPEN_USAGE}`);
    return 1;
  }
  const bodyFile = isAbsolute(bodyArg) ? bodyArg : resolve(deps.cwd, bodyArg);
  let body: string;
  try {
    body = readFileSync(bodyFile, 'utf8');
  } catch (e) {
    err(`正文文件读不到（${bodyFile}）：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!body.trim()) {
    err(`正文文件是空的：${bodyFile}`);
    return 1;
  }
  const founderApproved = values['founder-approved'] === true;
  if (founderApproved && !body.includes('原话')) {
    err(
      '带了 --founder-approved，正文里却没有贴创始人原话的那一段（含「原话」二字，写明原话和时间）：什么也没做。',
    );
    return 1;
  }

  let lists: ReturnType<typeof loadPathLists>;
  try {
    lists = loadPathLists(deps.root);
  } catch (e) {
    err(`判不了要不要挂自动合并，没开 PR：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const created = gh([
    'pr',
    'create',
    '--title',
    title,
    '--body-file',
    bodyFile,
    ...(values.draft ? ['--draft'] : []),
    ...(typeof values.base === 'string' ? ['--base', values.base] : []),
  ]);
  if (created.code !== 0) {
    err(`gh pr create 没成（${reasonOf(created)}）`);
    return 2;
  }
  let pr: number;
  let url: string;
  try {
    ({ pr, url } = parseCreatedPr(created.stdout));
  } catch (e) {
    err(
      `${e instanceof Error ? e.message : String(e)}：PR 可能已经开了，自己 gh pr view 看一眼再挂自动合并。`,
    );
    return 2;
  }
  out(`开了 PR #${pr}：${url}`);

  const manual = `gh pr merge ${pr} --auto --squash`;
  let verdict: ReturnType<typeof judgePaths>;
  try {
    verdict = judgePaths(prFiles(gh, pr), lists);
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}：没挂自动合并。自己判过没碰改标准路径再跑 ${manual}`);
    return 2;
  }
  if (verdict.review.length > 0)
    out(
      `碰了先审后合的路径（${listOf(verdict.review)}）：要跑第二意见 ${SO} --pr ${pr} --high-risk --author-family <写它的模型族>，过了合并闸才放行。`,
    );
  if (verdict.afterMerge.length > 0)
    out(`碰了先合后审的路径（${listOf(verdict.afterMerge)}）：合并后补审（${SO} --after-merge-sweep）。`);

  if (values['no-automerge']) {
    out(`没挂自动合并（带了 --no-automerge）。`);
    return 0;
  }
  if (verdict.standard.length > 0 && !founderApproved) {
    out(
      `人闸：改标准，等创始人同意（碰了 ${listOf(verdict.standard)}）。没挂自动合并；他同意后把原话和时间贴进正文，再跑 ${manual}`,
    );
    return 0;
  }
  if (values.draft) {
    out(`草稿不挂自动合并：转正（gh pr ready ${pr}）后跑 ${manual}`);
    return 0;
  }
  const armed = gh(['pr', 'merge', String(pr), '--auto', '--squash']);
  if (armed.code !== 0) {
    err(`PR #${pr} 开了，自动合并没挂成（gh pr merge ${reasonOf(armed)}）：查明原因后再跑 ${manual}`);
    return 2;
  }
  out(
    `挂上了自动合并（squash）${verdict.standard.length > 0 ? '：改标准，正文里贴了创始人原话' : ''}；检查全绿就自己合。`,
  );
  return 0;
}
