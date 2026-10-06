// 开 PR、挂自动合并收成一个必经命令（pnpm pr:open，全仓审查第 2 路清单 1 号）：最近 40 个 PR 里 9 个没挂自动合并、
// CI 绿了闲着共 3993 秒，兜底的引擎又关着——挂不挂不再靠人记，开 PR 的这一步就判完、挂上。
// - 没碰改标准路径（standard-paths.json）就当场 gh pr merge --auto --squash：CI 绿就合（#1114 起所有 PR 只看 CI）。
// - 碰了改标准就不挂，打「人闸：改标准，等创始人同意」；带 --founder-approved 才挂（正文里要有一段含「原话」二字——
//   贴着他的原话和时间；命令只查这两个字，不做更多猜测）。pnpm pr:open 的入口是 pr-compose.ts 的 prOpenCli：不给 --body-file
//   时它生成正文（--founder-quote 生成那一段），再交给这里；这里的闸不管正文怎么来的。
// - 草稿、带 --no-automerge 的不挂（工人领了改标准的活用后者）。
// - 必挂单（#1052：2026-10-05 起 37 个 PR 没一个挂单，v4 里程碑页上看不出进展）：正文「需求」栏里要读到 Closes #号 / Refs #号
//   （认法在 pr-columns.ts），而且那张单真在本仓（GitHub 现查）；读不到、单不存在就一个 PR 也不开。确实没有单：
//   --no-issue "<理由>"，理由原样写进需求栏（「无：<理由>」）。挂了单的 PR 顺手挂上那张单所在的里程碑（单没挂里程碑就不挂；
//   这一步没成只提醒、不改退出码）。
// 退出码：0 开成了（挂上了，或照规矩不挂、写明为什么）；1 用法不对、需求栏没挂单或单不存在（什么也没做）；2 没做成：
// 清单读不到、单没查成、gh 没跑成、输出认不出、改了哪些文件没查成、自动合并没挂成（PR 可能已经开了，照实写明开了哪个、卡在哪一步）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Gh, judgePaths, listOf, loadPathLists, prFiles, reasonOf } from './pr-arm.ts';
import { issueColumnRefs, withIssueColumn } from './pr-columns.ts';
import { parseCreatedPr } from './publish-actions.ts';

export const PR_OPEN_USAGE = `用法：pnpm pr:open --title <标题> [--body-file <正文文件> | 生成正文的参数] [--draft] [--base <分支>] [--no-automerge]
  在要开 PR 的分支上跑（先 git push）。开 PR，没碰改标准路径就当场挂自动合并（squash）。
  正文有两种来源：
  ① --body-file <正文文件>：自己写（只有「做了什么」「需求」两栏，见 .github/pull_request_template.md）
  ② 不给 --body-file：命令自己生成。「做了什么」取这条分支相对 origin/<base> 的提交说明（多条列成短列表）；「需求」栏写：
     --closes <号>        这个 PR 做完就关单（可重复）
     --refs <号>          母单分片、关不了它（可重复）
     --new-issue "<标题>" 当场开一张单并 Closes 它：要带 --kind 需求|缺陷|杂项、--milestone <版本全名|v<N>|未排期>，缺了不开；
                          --local 给新单多贴「本机做」
     --no-issue "<理由>"  确实没有单：理由原样写进「需求」栏（「无：<理由>」）
     --founder-quote "<原话>" --at "<时间>"  改标准、创始人已经同意：在「需求」栏下面写「人闸：改标准」、再写一段「创始人原话」，
                          并挂自动合并（等价于 --founder-approved 加手写那一段）
  需求栏要能读到 Closes #号 / Refs #号：读不到、单不存在就不开；挂了单的 PR 顺手挂上那张单的里程碑。
  --no-issue 在 --body-file 下也能用；需求栏已经挂了单就不能再带
  --founder-approved  改标准、创始人已经同意（自己写正文时用）：正文里要有一段贴着他的原话和时间（含「原话」二字）
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

export function prOpen(argv: string[], deps: OpenDeps): number {
  const { out, err } = deps;
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
        'no-issue': { type: 'string' },
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

  // 需求栏必挂单：Closes / Refs 读得到，或者带 --no-issue 写明理由；两样都没有就什么也不做
  const linked = issueColumnRefs(body);
  const issueNumbers = [...linked.closes, ...linked.refs];
  let sendBody = bodyFile;
  let tmpBody: string | undefined;
  if (typeof values['no-issue'] === 'string') {
    const reason = values['no-issue'].trim();
    if (!reason) {
      err('--no-issue 后面要写为什么不挂单（一句话，会原样写进「需求」栏）：什么也没做。');
      return 1;
    }
    if (issueNumbers.length > 0) {
      err(
        `带了 --no-issue，正文「需求」栏却已经挂了 #${issueNumbers.join('、#')}：要么去掉 --no-issue，要么把需求栏的单号拿掉。什么也没做。`,
      );
      return 1;
    }
    tmpBody = join(mkdtempSync(join(tmpdir(), 'pr-open-')), 'body.md');
    writeFileSync(tmpBody, withIssueColumn(body, `无：${reason}`));
    sendBody = tmpBody;
  } else if (issueNumbers.length === 0) {
    err(
      '正文「需求」栏里读不到 Closes #号 / Refs #号：每个 PR 都要挂单，里程碑页才看得出进展（#1052）。\n' +
        '  这个 PR 做完就关单 → 需求栏写「Closes #号」；母单的分片、关不了它 → 写「Refs #号」；\n' +
        '  确实没有单 → 加 --no-issue "<为什么不挂单>"。没开 PR，什么也没做。',
    );
    return 1;
  }
  try {
    return openAndArm(deps, {
      title,
      sendBody,
      founderApproved,
      draft: values.draft === true,
      base: typeof values.base === 'string' ? values.base : undefined,
      noAutomerge: values['no-automerge'] === true,
      issueNumbers,
    });
  } finally {
    if (tmpBody) rmSync(join(tmpBody, '..'), { recursive: true, force: true });
  }
}

/** 查到的单：号、是不是 PR、挂的里程碑名（没挂是 undefined）。 */
interface IssueInfo {
  isPr: boolean;
  milestone: string | undefined;
}

/** 本仓这张单的样子；单不存在返回 'missing'；没查成（网络、认不出）抛错，不当成不存在。 */
function lookupIssue(gh: Gh, n: number): IssueInfo | 'missing' {
  const r = gh([
    'api',
    `repos/{owner}/{repo}/issues/${n}`,
    '--jq',
    '[(.pull_request != null), .milestone.title] | @json',
  ]);
  if (r.code !== 0) {
    if (/HTTP 404|Not Found/i.test(`${r.stderr}${r.stdout}`)) return 'missing';
    throw new Error(`没查成 #${n} 在不在（gh api ${reasonOf(r)}）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout.trim());
  } catch {
    raw = undefined;
  }
  if (!Array.isArray(raw) || typeof raw[0] !== 'boolean' || (raw[1] !== null && typeof raw[1] !== 'string'))
    throw new Error(`没查成 #${n} 在不在：gh 回的认不出（${r.stdout.trim().slice(0, 120)}）`);
  return { isPr: raw[0], milestone: raw[1] || undefined };
}

interface OpenPlan {
  title: string;
  /** 交给 gh 的正文文件（带 --no-issue 时是改过需求栏的那份）。 */
  sendBody: string;
  founderApproved: boolean;
  draft: boolean;
  base: string | undefined;
  noAutomerge: boolean;
  /** 需求栏挂的单：先 Closes 后 Refs，从小到大；空＝带了 --no-issue。 */
  issueNumbers: number[];
}

function openAndArm(deps: OpenDeps, plan: OpenPlan): number {
  const { gh, out, err } = deps;
  const { title, sendBody, founderApproved, issueNumbers } = plan;

  let lists: ReturnType<typeof loadPathLists>;
  try {
    lists = loadPathLists(deps.root);
  } catch (e) {
    err(`判不了要不要挂自动合并，没开 PR：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  // 挂的单要真在本仓：写错号、写到 PR 上去的不算（先查完再开 PR）
  let milestone: string | undefined;
  for (const n of issueNumbers) {
    let info: IssueInfo | 'missing';
    try {
      info = lookupIssue(gh, n);
    } catch (e) {
      err(`${e instanceof Error ? e.message : String(e)}：没开 PR。`);
      return 2;
    }
    if (info === 'missing' || info.isPr) {
      err(
        `需求栏写的 #${n} ${info === 'missing' ? '在本仓里不存在' : '是个 PR、不是单'}：没开 PR。改成真的单号，或者确实没有单就加 --no-issue "<理由>"。`,
      );
      return 1;
    }
    if (n === issueNumbers[0]) milestone = info.milestone;
  }

  const created = gh([
    'pr',
    'create',
    '--title',
    title,
    '--body-file',
    sendBody,
    ...(plan.draft ? ['--draft'] : []),
    ...(plan.base !== undefined ? ['--base', plan.base] : []),
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

  // 里程碑页只数单子，PR 跟着单挂上去才看得出进展；没成只提醒（PR 已经开了，不因这个退出非 0）
  if (milestone !== undefined) {
    const edited = gh(['pr', 'edit', String(pr), '--milestone', milestone]);
    if (edited.code === 0) out(`PR 挂上了里程碑「${milestone}」（跟着 #${issueNumbers[0]}）。`);
    else
      err(
        `提醒：PR #${pr} 没挂上里程碑「${milestone}」（gh pr edit ${reasonOf(edited)}）：自己跑 gh pr edit ${pr} --milestone "${milestone}"`,
      );
  } else if (issueNumbers.length > 0) {
    out(`#${issueNumbers[0]} 没挂里程碑，PR 也就没挂。`);
  }

  const manual = `gh pr merge ${pr} --auto --squash`;
  let verdict: ReturnType<typeof judgePaths>;
  try {
    verdict = judgePaths(prFiles(gh, pr), lists);
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}：没挂自动合并。自己判过没碰改标准路径再跑 ${manual}`);
    return 2;
  }

  if (plan.noAutomerge) {
    out(`没挂自动合并（带了 --no-automerge）。`);
    return 0;
  }
  if (verdict.standard.length > 0 && !founderApproved) {
    out(
      `人闸：改标准，等创始人同意（碰了 ${listOf(verdict.standard)}）。没挂自动合并；他同意后把原话和时间贴进正文，再跑 ${manual}`,
    );
    return 0;
  }
  if (plan.draft) {
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
