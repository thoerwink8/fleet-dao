// 开 PR、挂自动合并收成一个必经命令（pnpm pr:open，全仓审查第 2 路清单 1 号）：最近 40 个 PR 里 9 个没挂自动合并、
// CI 绿了闲着共 3993 秒，兜底的引擎又关着——挂不挂不再靠人记，开 PR 的这一步就判完、挂上。
// - 没碰改标准路径（standard-paths.json）就当场 gh pr merge --auto --squash：CI 绿就合（#1114 起所有 PR 只看 CI）。
// - 碰了改标准就不挂，打「人闸：改标准，等创始人同意」；带 --founder-approved 才挂（正文里要有「创始人原话」那一行——
//   「」里是他的原话、括号里是时间，都不能空；认法是 pr-columns.ts 的 founderQuote，合并闸用同一个，开得出来的闸就认）。pnpm pr:open 的入口是 pr-compose.ts 的 prOpenCli：不给 --body-file
//   时它生成正文（--founder-quote 生成那一段），再交给这里；这里的闸不管正文怎么来的。
// - 草稿、带 --no-automerge 的不挂（工人领了改标准的活用后者）。
// - 必挂单（#1052：37 个 PR 没一个挂单，v4 里程碑页上看不出进展）：正文「需求」栏里要读到 Closes #号 / Refs #号
//   （认法在 pr-columns.ts），而且那张单真在本仓（GitHub 现查）；读不到、单不存在就一个 PR 也不开。确实没有单：
//   --no-issue "<理由>"，理由原样写进需求栏（「无：<理由>」，栏里原有的字留着——栏名那行冒号后面的原话、下面各行的原话段
//   和说明都留着，#1890）。挂了单的 PR 顺手挂上那张单所在的里程碑（单没挂里程碑就不挂；
//   这一步没成只提醒、不改退出码）。
// - 同一张单不开第二个 PR（决定 0096）：「需求」栏 Closes 的单，已经有别的开着的 PR 在做（Closes 它，或分支是 fleet/<单号>-、
//   local/<单号>-，认法是 pr-claims.ts 的 otherPrOnIssue，引擎开 PR 前用同一份）就不开，退出码 1；PR 列表读不到退出码 2。
// - 分支认单（决定 0096 落地）：当前分支是 local/<单号>-、fleet/<单号>- 就已经对应一张单：需求栏没挂单自动补 Closes #单号
//   （照常核那张单存在、是单不是 PR、还开着）；带 --no-issue 拒开；需求栏挂的单里没有分支这张单拒开（防挂错单、两条线统计对不上）。
// 退出码：0 开成了（挂上了，或照规矩不挂、写明为什么）；1 用法不对、需求栏没挂单或单不存在（什么也没做）；2 没做成：
// 清单读不到、单没查成、gh 没跑成、输出认不出、改了哪些文件没查成、自动合并没挂成（PR 可能已经开了，照实写明开了哪个、卡在哪一步）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { issueOfBranch } from './issue-branch.ts';
import { type Gh, judgePaths, listOf, loadPathLists, prFiles, reasonOf } from './pr-arm.ts';
import { type OpenPullRef, otherPrOnIssue } from './pr-claims.ts';
import { founderQuote, issueColumnRefs, withIssueColumn } from './pr-columns.ts';

/**
 * 从 gh pr create 的输出里认 PR 号。gh 正常时最后一行是 PR 地址（…/pull/<N>）；输出里认不出 PR 号直接抛错——
 * 「退出了但没拿到号」不能让开 PR 的人当「已经开了」。
 */
export function parseCreatedPr(stdout: string): { pr: number; url: string } {
  const url = stdout.trim().split('\n').pop()?.trim() ?? '';
  const m = /\/pull\/(\d+)$/.exec(url)?.[1];
  if (!m) {
    throw new Error(`gh pr create 退出码 0，可输出里认不出 PR 号：${stdout.slice(0, 200)}`);
  }
  return { pr: Number(m), url };
}

export const PR_OPEN_USAGE = `用法：pnpm pr:open --title <标题> [--body-file <正文文件> | 生成正文的参数] [--draft] [--base <分支>] [--no-automerge]
  在要开 PR 的分支上跑（命令会先 git push 当前分支，已推过则无事发生）。开 PR，没碰改标准路径就当场挂自动合并（squash）。
  正文有两种来源：
  ① --body-file <正文文件>：自己写（只有「做了什么」「需求」两栏，见 .github/pull_request_template.md）
  ② 不给 --body-file：命令自己生成。「做了什么」取这条分支相对 origin/<base> 的提交说明（多条列成短列表）；「需求」栏写：
     --closes <号>        这个 PR 做完就关单（可重复）
     --refs <号>          母单分片、关不了它（可重复）
     --new-issue "<标题>" 当场开一张单并 Closes 它：要带 --kind 需求|缺陷|杂项、--milestone <版本全名|v<N>|未排期>，缺了不开；
                          开出的单一律贴「本机做」，引擎不拉。--local 仍可加，加了不报错
     --no-issue "<理由>"  确实没有单：理由原样写进「需求」栏（「无：<理由>」）
     --founder-quote "<原话>" --at "<时间>"  改标准、创始人已经同意：在「需求」栏下面写「人闸：改标准」、再写一段「创始人原话」，
                          并挂自动合并（等价于 --founder-approved 加手写那一段）；也能配 --body-file，这两段追加到正文末尾
  需求栏要能读到 Closes #号 / Refs #号：读不到、单不存在就不开。PR 不挂里程碑（里程碑页只数单子）。
  --no-issue 在 --body-file 下也能用；需求栏已经挂了单就不能再带
  分支是 local/<单号>-、fleet/<单号>-：需求栏没挂单就自动补 Closes #<单号>；不能带 --no-issue，需求栏挂的单要含这张单
  --founder-approved  改标准、创始人已经同意（自己写正文时用）：正文里要有一行 **创始人原话**：「<原话>」（<时间>）
  --no-automerge      只开 PR、不挂自动合并`;

/**
 * gh / git 在哪个目录跑：敲命令的目录（INIT_CWD）在脚本所在仓里就用它，否则（pnpm --dir 从别的目录调用，
 * INIT_CWD 指到仓外，gh 会报 not a git repository）以脚本所在仓根为准。
 */
export function pickGitCwd(initCwd: string | undefined, root: string): string {
  if (!initCwd) return root;
  const rel = relative(resolve(root), resolve(initCwd));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? initCwd : root;
}

/**
 * 当前分支对应的单（local/<单号>-、fleet/<单号>-）：认不出是普通分支回 null；分支名没读成（git 报错）抛错，不当成普通分支。
 */
export function branchIssue(git: Gh): { branch: string; issue: number } | null {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.code !== 0) throw new Error(`当前分支没读成（${reasonOf(r)}）`);
  const branch = r.stdout.trim();
  const ref = issueOfBranch(branch);
  return ref ? { branch, issue: ref.issue } : null;
}

export interface OpenDeps {
  gh: Gh;
  /** 跑 git（在要开 PR 的仓里）：开 PR 之前先推当前分支。 */
  git: Gh;
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
  if (founderApproved && founderQuote(body) === undefined) {
    err(
      '带了 --founder-approved，正文里却没有创始人原话那一行（写成 **创始人原话**：「<原话>」（<时间>），原话和时间都不能空；合并闸也照这个认）：什么也没做。',
    );
    return 1;
  }

  // 需求栏必挂单：Closes / Refs 读得到，或者带 --no-issue 写明理由；两样都没有就什么也不做
  // 分支是 local/<单号>-、fleet/<单号>-：分支已经对应一张单，--no-issue 不收，需求栏没挂就自动补 Closes，挂了的要含这张
  const linked = issueColumnRefs(body);
  let issueNumbers = [...linked.closes, ...linked.refs];
  let closes = linked.closes;
  let sendBody = bodyFile;
  let tmpBody: string | undefined;
  let branch: ReturnType<typeof branchIssue>;
  try {
    branch = branchIssue(deps.git);
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}：没开 PR。`);
    return 2;
  }
  let autoIssue: number | undefined;
  if (typeof values['no-issue'] === 'string') {
    const reason = values['no-issue'].trim();
    if (!reason) {
      err('--no-issue 后面要写为什么不挂单（一句话，会原样写进「需求」栏）：什么也没做。');
      return 1;
    }
    if (branch) {
      err(
        `当前分支 ${branch.branch} 已经对应单 #${branch.issue}，不能带 --no-issue：去掉它（需求栏没挂单会自动补 Closes #${branch.issue}）。什么也没做。`,
      );
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
  } else if (issueNumbers.length === 0 && branch) {
    autoIssue = branch.issue;
    issueNumbers = [branch.issue];
    closes = [branch.issue];
    tmpBody = join(mkdtempSync(join(tmpdir(), 'pr-open-')), 'body.md');
    writeFileSync(tmpBody, withIssueColumn(body, `Closes #${branch.issue}`));
    sendBody = tmpBody;
    out(`分支 ${branch.branch} 对应单 #${branch.issue}，需求栏没挂单，自动补 Closes #${branch.issue}。`);
  } else if (issueNumbers.length === 0) {
    err(
      '正文「需求」栏里读不到 Closes #号 / Refs #号：每个 PR 都要挂单，里程碑页才看得出进展（#1052）。\n' +
        '  这个 PR 做完就关单 → 需求栏写「Closes #号」；母单的分片、关不了它 → 写「Refs #号」；\n' +
        '  确实没有单 → 加 --no-issue "<为什么不挂单>"。没开 PR，什么也没做。',
    );
    return 1;
  } else if (branch && !issueNumbers.includes(branch.issue)) {
    err(
      `当前分支 ${branch.branch} 对应单 #${branch.issue}，可「需求」栏挂的是 #${issueNumbers.join('、#')}：单号对不上。要么需求栏改成（或加上）#${branch.issue}，要么换到对的分支。没开 PR，什么也没做。`,
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
      closes,
      autoIssue,
    });
  } finally {
    if (tmpBody) rmSync(join(tmpBody, '..'), { recursive: true, force: true });
  }
}

/** 查到的单：是不是 PR、开没开着。 */
interface IssueInfo {
  isPr: boolean;
  open: boolean;
}

/** 本仓这张单的样子；单不存在返回 'missing'；没查成（网络、认不出）抛错，不当成不存在。 */
function lookupIssue(gh: Gh, n: number): IssueInfo | 'missing' {
  const r = gh([
    'api',
    `repos/{owner}/{repo}/issues/${n}`,
    '--jq',
    '[(.pull_request != null), .milestone.title, .state] | @json',
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
  if (
    !Array.isArray(raw) ||
    typeof raw[0] !== 'boolean' ||
    (raw[1] !== null && typeof raw[1] !== 'string') ||
    typeof raw[2] !== 'string'
  )
    throw new Error(`没查成 #${n} 在不在：gh 回的认不出（${r.stdout.trim().slice(0, 120)}）`);
  return { isPr: raw[0], open: raw[2] === 'open' };
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
  /** 其中 Closes 的那些（这个 PR 做完就关的单）：开之前查有没有别的 PR 在做。 */
  closes: number[];
  /** 分支对应的单、需求栏是自动补的：这张单必须还开着（手写挂的不查，老规矩）。 */
  autoIssue: number | undefined;
}

/** 开着的 PR 里有没有别的在做 closes 里的单。有回不开的原因和退出码；没有回 null。 */
function closesFence(deps: OpenDeps, closes: readonly number[]): { message: string; code: number } | null {
  if (closes.length === 0) return null;
  const branch = deps.git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.code !== 0) return { message: `当前分支没读成（${reasonOf(branch)}）：没开 PR。`, code: 2 };
  const listed = deps.gh([
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '500',
    '--json',
    'number,body,headRefName',
  ]);
  if (listed.code !== 0) {
    return {
      message: `开着的 PR 没列成（${reasonOf(listed)}），判不了同一张单有没有别人在做：没开 PR。`,
      code: 2,
    };
  }
  let pulls: OpenPullRef[];
  try {
    const raw: unknown = JSON.parse(listed.stdout);
    if (!Array.isArray(raw) || raw.length >= 500) throw new Error('不是列表，或 500 个以上没翻全');
    pulls = raw.map((p: { number?: unknown; body?: unknown; headRefName?: unknown }) => {
      if (typeof p.number !== 'number' || typeof p.headRefName !== 'string') throw new Error('PR 认不出');
      return { number: p.number, body: typeof p.body === 'string' ? p.body : '', headRef: p.headRefName };
    });
  } catch (e) {
    return {
      message: `开着的 PR 认不出（${e instanceof Error ? e.message : String(e)}）：没开 PR。`,
      code: 2,
    };
  }
  const own = branch.stdout.trim();
  for (const n of closes) {
    const other = otherPrOnIssue(pulls, n, own);
    if (other !== null) {
      return {
        message: `#${n} 已经有开着的 PR #${other} 在做（Closes 它，或分支是这张单的固定前缀）：不开第二个。先看 #${other}，合了这张单就收；要换人做先关掉 #${other}。`,
        code: 1,
      };
    }
  }
  return null;
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
  for (const n of issueNumbers) {
    let info: IssueInfo | 'missing';
    try {
      info = lookupIssue(gh, n);
    } catch (e) {
      err(`${e instanceof Error ? e.message : String(e)}：没开 PR。`);
      return 2;
    }
    if (info === 'missing') {
      err(`需求栏写的 #${n} 在本仓里不存在：没开 PR。改成真的单号，或者确实没有单就加 --no-issue "<理由>"。`);
      return 1;
    }
    if (info.isPr) {
      err(
        `#${n} 是个 PR、不是单：这是 PR，请用 --no-issue 并写理由（--no-issue "<为什么不挂单>"），或改成真的单号。没开 PR。`,
      );
      return 1;
    }
    if (plan.autoIssue === n && !info.open) {
      err(
        `分支对应的单 #${n} 已经关了，不能自动挂：没开 PR。换一张开着的单（需求栏写 Closes #号），或重新 pnpm work claim 一张新单。`,
      );
      return 1;
    }
  }

  // 同一张单别有第二个 PR（决定 0096）：Closes 的单已经有别的开着的 PR 在做（「需求」栏 Closes 它，或分支是 fleet/<单号>-、local/<单号>-）
  // 就不开。自己这条分支已经开过的不算（重跑幂等）。读不到就不开：不当成没有
  const fence = closesFence(deps, plan.closes);
  if (fence !== null) {
    err(fence.message);
    return fence.code;
  }

  // gh pr create 要远端有这条分支：先推（已推过则幂等）。推不成就不开，免得 gh 报一句看不懂的「must first push」
  const pushed = deps.git(['push', '--set-upstream', 'origin', 'HEAD']);
  if (pushed.code !== 0) {
    err(`git push 当前分支没成（${reasonOf(pushed)}）：没开 PR。查明原因（权限、网络、远端拒绝）后重跑。`);
    return 2;
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
  // PR 不挂里程碑（决定 0015 第 1 条）：里程碑页只数单子，进度才不虚

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
