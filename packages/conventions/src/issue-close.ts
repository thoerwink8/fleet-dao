// pnpm issue:close <号>（#241）：一张单做完，主线上要有 specs/<号>-<短名>/结果.md（做成什么样、怎么验的、还欠什么）才关。
// 「这张单有没有结果」和合并闸、每天对账是同一份判断（close-rule.ts 的 resultDocOf）。
// 经 gh 读写：读不到 GitHub、读不到主线一律明确报错、不关（CloseUnchecked，退出码 2），条件不够的拒关（CloseRefused，
// 退出码 1），不拿「没读到」当「没有」，也不拿「没报错」当「关上了」（关完回读）。
import { RESULT_FILE, resultDocOf } from './close-rule.ts';
import type { Gh, GhResult } from './issue-new.ts';

// —— pnpm issue:close <号> ——

export const CLOSE_USAGE =
  '用法：pnpm issue:close <单号> [--reason <completed|not_planned|duplicate>] [--superseded-by <号>]' +
  '（默认走 completed：主线上要有 specs/<号>-<短名>/结果.md 才关、评论里贴结果链接；' +
  '--superseded-by 关成 not_planned、不查结果.md，评论里写「被 #<号> 取代」；' +
  '--reason 单独用：只换关成的样子，其余「completed 才要的结果.md、子单、是 PR」规则照走）';

/** 拒关：条件不够（没有结果文档、子单还开着、是 PR、参数不对）。入口退出码 1。 */
export class CloseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseRefused';
  }
}

/** 没查成、没关成：读不到 GitHub 或主线、读回来认不出、关单报错、关完回读对不上。入口退出码 2。 */
export class CloseUnchecked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseUnchecked';
  }
}

export interface IssueCloseDeps {
  gh: Gh;
}

export type IssueCloseResult =
  | {
      outcome: 'closed';
      number: number;
      issueUrl: string;
      /** completed 才有——主线上那张 结果.md 的仓内路径和 GitHub 链接。superseded-by / 其它 reason 没有。 */
      resultDoc?: string;
      resultUrl?: string;
    }
  | { outcome: 'already'; number: number; issueUrl: string; stateReason: string | null };

/** GitHub 的目录列表一次最多给 1000 项，到了就算没列全。 */
const LISTING_MAX = 1000;
/** 子单一次读 100 张，到了就算没读全。 */
const SUB_ISSUES_MAX = 100;

export async function issueClose(argv: readonly string[], deps: IssueCloseDeps): Promise<IssueCloseResult> {
  const args = parseArgs(argv);
  const { gh } = deps;
  const n = args.number;
  const reason = args.supersededBy === undefined ? (args.reason ?? 'completed') : ('not_planned' as const);
  if (args.supersededBy !== undefined && args.reason !== undefined && args.reason !== 'not_planned') {
    throw new CloseRefused(
      `--superseded-by 隐含关成 not_planned（被取代、留史）；想关成 ${args.reason} 就别带 --superseded-by。没关。`,
    );
  }
  const supersededBy = args.supersededBy;
  const isCompleted = reason === 'completed';
  const repo = asObject(await readJson(gh, ['api', 'repos/{owner}/{repo}'], '读仓'), '仓');
  const branch = repo.default_branch;
  const repoUrl = repo.html_url;
  if (typeof branch !== 'string' || !branch || typeof repoUrl !== 'string' || !repoUrl) {
    throw new CloseUnchecked('gh 读回来的仓认不出（没有 default_branch、html_url），没关。');
  }

  const issue = await readIssue(gh, n, `读 #${n}`);
  if (issue.pull) throw new CloseRefused(`#${n} 是 PR，不是单，没关。`);
  if (issue.state === 'closed') {
    return { outcome: 'already', number: n, issueUrl: issue.url, stateReason: issue.stateReason };
  }

  const openSubs = await openSubIssues(gh, n);
  if (openSubs.length > 0) {
    throw new CloseRefused(
      `#${n} 下面还有 ${openSubs.length} 张子单开着（${openSubs.map((s) => `#${s}`).join('、')}），没关：子单都做完、各自用 pnpm issue:close 关了，再关这张。`,
    );
  }

  // --superseded-by 给的号要真实存在、是一张开着的单——不然评论里写了个死链，留史也没意义。
  if (supersededBy !== undefined) await checkSupersededBy(gh, n, supersededBy);

  // completed 必须主线上有结果.md；superseded-by（或显式 --reason not_planned / duplicate）跳过这一项。
  let resultDoc: string | undefined;
  let resultUrl: string | undefined;
  if (isCompleted) {
    const main = await mainSpecs(gh, branch, n);
    const result = resultDocOf(n, main.files);
    if (!result) throw new CloseRefused(missingResult(n, branch, main.dirs));
    resultDoc = result;
    resultUrl = `${repoUrl}/blob/${encodePath(branch)}/${encodePath(result)}`;
  }

  const comment =
    supersededBy !== undefined
      ? `被 #${supersededBy} 取代，留史。（pnpm issue:close --superseded-by 关的，不查结果.md。）`
      : isCompleted && resultDoc && resultUrl
        ? `做完了：结果见 [${resultDoc}](${resultUrl})。\n\n（pnpm issue:close 查过主线上有结果文档才关的。）`
        : `关成 ${reason}。（pnpm issue:close --reason 关的，「完成」之外的关法走这里。）`;
  const closed = await gh(['issue', 'close', String(n), '--reason', reason, '--comment', comment]);
  if (closed.code !== 0) {
    throw new CloseUnchecked(
      `gh 关单报错（退出码 ${closed.code}）：${detail(closed)}。单可能关了也可能没关：去 GitHub 看一眼 #${n}，没关就重跑。`,
    );
  }
  const after = await readIssue(gh, n, `关完回读 #${n}`);
  const reasonCn =
    reason === 'completed'
      ? '完成'
      : reason === 'not_planned'
        ? '不做了（not_planned）'
        : '重复（duplicate）';
  if (after.state !== 'closed' || after.stateReason !== reason) {
    throw new CloseUnchecked(
      `关完回读 #${n}：state=${after.state}、state_reason=${after.stateReason ?? '（空）'}，不是「关了、${reasonCn}」：去 GitHub 看一眼。`,
    );
  }
  if (isCompleted && resultDoc !== undefined && resultUrl !== undefined) {
    return { outcome: 'closed', number: n, issueUrl: after.url, resultDoc, resultUrl };
  }
  return { outcome: 'closed', number: n, issueUrl: after.url };
}

/** --superseded-by 给的号要真实存在、是一张单（不能是 PR、不能是被关的这张自己）。读不到、认不出报 CloseUnchecked；指错位置报 CloseRefused。 */
async function checkSupersededBy(gh: Gh, n: number, by: number): Promise<void> {
  if (by === n) {
    throw new CloseRefused(`--superseded-by 不能给这张单自己（#${n}）。被谁取代，写谁的号。`);
  }
  const target = await readIssue(gh, by, `读取代它的 #${by}`);
  if (target.pull) {
    throw new CloseRefused(
      `--superseded-by #${by} 是 PR，不是单。取代关系指向一张单；要给 PR 留史挂链接，直接评论、别用 --superseded-by。`,
    );
  }
}

interface ParsedCloseArgs {
  number: number;
  reason: 'completed' | 'not_planned' | 'duplicate' | undefined;
  supersededBy: number | undefined;
}

function parseArgs(argv: readonly string[]): ParsedCloseArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let number: number | undefined;
  let reason: ParsedCloseArgs['reason'];
  let supersededBy: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
    const bad = (): never => {
      throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
    };
    let flag: string | null = null;
    let value: string | undefined;
    if (a === '--reason' || a === '--superseded-by') {
      flag = a;
      value = args[++i];
    } else if (a.startsWith('--reason=')) {
      flag = '--reason';
      value = a.slice('--reason='.length);
    } else if (a.startsWith('--superseded-by=')) {
      flag = '--superseded-by';
      value = a.slice('--superseded-by='.length);
    }
    if (flag !== null) {
      if (seen.has(flag)) bad();
      seen.add(flag);
      if (value === undefined || value === '') {
        throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
      }
      if (flag === '--reason') {
        if (value !== 'completed' && value !== 'not_planned' && value !== 'duplicate') {
          throw new CloseRefused(
            `--reason 只认 completed / not_planned / duplicate（读到：${value}）。${CLOSE_USAGE}`,
          );
        }
        reason = value;
      } else {
        const m = /^#?([1-9]\d*)$/.exec(value.trim());
        if (!m || !m[1]) {
          throw new CloseRefused(`--superseded-by 要给存在的单号（读到：${value}）。${CLOSE_USAGE}`);
        }
        supersededBy = Number(m[1]);
      }
      continue;
    }
    if (a.startsWith('-') || number !== undefined) bad();
    const m = /^#?([1-9]\d*)$/.exec(a.trim());
    if (!m || !m[1]) {
      throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
    }
    number = Number(m[1]);
  }
  if (number === undefined) throw new CloseRefused(`没给单号。${CLOSE_USAGE}`);
  return { number, reason, supersededBy };
}

interface IssueFacts {
  state: 'open' | 'closed';
  stateReason: string | null;
  pull: boolean;
  url: string;
}

async function readIssue(gh: Gh, n: number, what: string): Promise<IssueFacts> {
  const raw = asObject(await readJson(gh, ['api', `repos/{owner}/{repo}/issues/${n}`], what), `#${n}`);
  const { number, state, state_reason: reason, pull_request: pull, html_url: url } = raw;
  if (number !== n)
    throw new CloseUnchecked(`gh ${what}：要的是 #${n}，读回来的是 ${String(number)}，没关。`);
  if ((state !== 'open' && state !== 'closed') || typeof url !== 'string') {
    throw new CloseUnchecked(`gh ${what}：读回来的 state、html_url 认不出，没关。`);
  }
  if (reason !== null && reason !== undefined && typeof reason !== 'string') {
    throw new CloseUnchecked(`gh ${what}：读回来的 state_reason 认不出，没关。`);
  }
  return {
    state,
    stateReason: typeof reason === 'string' ? reason : null,
    pull: pull !== undefined && pull !== null,
    url,
  };
}

/** 下面还开着的子单（GitHub 自带的子议题）。读不到、认不出、没读全都抛 CloseUnchecked。 */
async function openSubIssues(gh: Gh, n: number): Promise<number[]> {
  const subs = await readJson(
    gh,
    ['api', `repos/{owner}/{repo}/issues/${n}/sub_issues?per_page=${SUB_ISSUES_MAX}`],
    `读 #${n} 的子单`,
  );
  if (!Array.isArray(subs)) throw new CloseUnchecked(`gh 读 #${n} 的子单：读回来的不是列表，没关。`);
  if (subs.length >= SUB_ISSUES_MAX) {
    throw new CloseUnchecked(`#${n} 的子单有 ${SUB_ISSUES_MAX} 张以上，这里只读一页，没读全，没关。`);
  }
  const open: number[] = [];
  for (const s of subs) {
    const o = isObject(s) ? s : {};
    if (typeof o.number !== 'number' || (o.state !== 'open' && o.state !== 'closed')) {
      throw new CloseUnchecked(`gh 读 #${n} 的子单：有一张认不出（没有 number、state），没关。`);
    }
    if (o.state === 'open') open.push(o.number);
  }
  return open.sort((a, b) => a - b);
}

/** 主线上 specs/ 下这张单的需求目录（<号>-<短名>）和里面的文件（仓内路径）。读不到、认不出、没列全都抛 CloseUnchecked。 */
async function mainSpecs(gh: Gh, branch: string, n: number): Promise<{ dirs: string[]; files: string[] }> {
  const where = `主线（${branch}）上的 specs/`;
  const ref = encodeURIComponent(branch);
  const top = await listDir(gh, `specs?ref=${ref}`, where);
  const dirs = top
    .filter((e) => e.type === 'dir' && e.name.startsWith(`${n}-`))
    .map((e) => e.name)
    .sort();
  const files: string[] = [];
  for (const d of dirs) {
    for (const e of await listDir(gh, `specs/${encodeURIComponent(d)}?ref=${ref}`, `${where}${d}/`)) {
      if (e.type === 'file') files.push(`specs/${d}/${e.name}`);
    }
  }
  return { dirs, files };
}

async function listDir(gh: Gh, path: string, where: string): Promise<{ name: string; type: string }[]> {
  const got = await readJson(gh, ['api', `repos/{owner}/{repo}/contents/${path}`], `列${where}`);
  if (!Array.isArray(got)) throw new CloseUnchecked(`gh 列${where}：读回来的不是目录列表，没关。`);
  if (got.length >= LISTING_MAX) {
    throw new CloseUnchecked(
      `${where}下有 ${LISTING_MAX} 项以上，GitHub 的目录列表只给前 ${LISTING_MAX} 项，没列全，没关。`,
    );
  }
  return got.map((e) => {
    if (!isObject(e) || typeof e.name !== 'string' || !e.name || typeof e.type !== 'string') {
      throw new CloseUnchecked(`gh 列${where}：有一项认不出（没有 name、type），没关。`);
    }
    return { name: e.name, type: e.type };
  });
}

function missingResult(n: number, branch: string, dirs: readonly string[]): string {
  const how = `写好 结果.md（做成什么样、怎么验的、还欠什么），随 PR 合进主线再关；也可以让最后那个 PR「这个 PR 做完就关单」填「是」、正文写 Closes #${n}，合并时自动关`;
  if (dirs.length === 0) {
    return `主线（${branch}）上没有 #${n} 的需求目录 specs/${n}-<短名>/，更没有 ${RESULT_FILE}，#${n} 没关：${how}。`;
  }
  return `主线（${branch}）上的 ${dirs.map((d) => `specs/${d}/`).join('、')} 里没有 ${RESULT_FILE}，#${n} 没关：${how}。`;
}

async function readJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const r = await gh(args);
  if (r.code !== 0) throw new CloseUnchecked(`gh ${what}失败（退出码 ${r.code}）：${detail(r)}，没关。`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new CloseUnchecked(
      `gh ${what}读回来的不是 JSON（${e instanceof Error ? e.message : String(e)}），没关。`,
    );
  }
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!isObject(v)) throw new CloseUnchecked(`gh 读回来的${what}认不出（不是一个对象），没关。`);
  return v;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function detail(r: GhResult): string {
  return (r.stderr.trim() || r.stdout.trim() || '（gh 什么也没说）').replace(/\s+/g, ' ');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
