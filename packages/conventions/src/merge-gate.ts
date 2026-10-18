// 合并闸（#74）：在 PR 当前头上写提交状态 merge-gate，「按我们的规矩能不能合」只看它一个（design 第五节「流程只为快」）。
// 判红有三样：
// - 改标准（人闸第四类，design 第五节「人闸第四类：改标准」）：PR 改到的文件（含改名前的名字）落进 standard-paths.json 的 paths 清单，
//   正文里却没有创始人同意的记录（「创始人原话」那一行，原话、时间都不能空；认法是 pr-columns.ts 的 founderQuote，
//   pnpm pr:open --founder-quote 写出来的就是它）。清单用跑这段代码的那一份（主线的）：PR 改不了自己的门槛。
// - 安全基（决定 0106）：PR 改到的文件落进同一个 standard-paths.json 的顶層 security-base 清单（.github/workflows/、CI 判法源码、发布脚本、
//   锁文件、引导文件等保护计算完整的路径）——这种改动要求**前置要你拍**：只有创始人在「要你拍」对一个具体的 head SHA 拍了，
//   那个 SHA 上贴出一条 success 的 security-base-approved 状态，闸才放行。SHA 换了（推了新提交）就算旧头上拍过也不算，
//   闸读的是当前头的状态，天然不满足。之所以不用「创始人原话」那一行：原话是贴在 PR 正文里的，不锁住 head SHA，
//   写上以后推新代码正文里那行照样在——挡不住「拍完又在安全基里加东西」；「要你拍 = billing fact」要钉到 SHA 才成立。
// - 引擎任务工作流（#632）开的 PR（分支 fleet/<单号>-t<8 位>）当前头上要有通过的 cold-verify（合前一次冷调用，换家族验
//   「单子说要的东西真做了没有」，#555-2）——**闸只读这条状态，不在这里起模型调用**（判法要确定，同一份代码什么时候跑
//   结果都一样，design 第五节）；冷调用在装配侧（引擎）跑、结论贴成状态。别的 PR 不验，也就没有这条状态——
//   那是「不用验」，不是「没验成」，两者在 coldVerifyNeed 里分开。
// 草稿、冲突 GitHub 自己拦。读不到、认不出（PR、文件列表、清单、提交状态）写 failure（没查成）。
// merge-gate.yml 在 PR 事件（头变了、正文改了——补上原话要重算）或 cold-verify / security-base-approved 状态写上来时跑它
// （后两种逐个重算所有开着的 PR）；主线推送只在闸认的东西（判法、清单、工作流本身）变了才触发、同样重算所有开着的 PR——
// 判法收紧了，开着的 PR 上旧的 success 不能留着（#654 第二意见）；不检出、不跑 PR 里的代码：判法和清单用跑这段代码的那一份（主线的）。
import { readFileSync } from 'node:fs';
import { isFlowBranch } from './flow-branch.ts';
import type { GhApi } from './gh-api.ts';
import {
  COLD_VERIFY_CONTEXT,
  checkColdVerify,
  checkSecurityBase,
  coldVerifyFrom,
  coldVerifyNeed,
  GATE_CONTEXT,
  SECURITY_BASE_CONTEXT,
  securityBaseFrom,
  statusDescription,
} from './merge-gates.ts';
import { founderQuote } from './pr-columns.ts';
import { type ChangedFile, type StandardPath, standardFiles } from './standard-paths.ts';
import { loadSecurityBase, loadStandardPaths } from './standard-paths-file.ts';

export type GateState = 'success' | 'failure';

/** 合并闸要读写的 GitHub 上的东西；读不到、读回来认不出就抛（调用方判「没查成」）。 */
export interface GitHubReads {
  /** PR 现在的样子（GET /pulls/{n}）。 */
  pr(number: number): Promise<unknown>;
  /** PR 改到的文件（GET /pulls/{n}/files，翻完页；超过 GitHub 给的上限读不全就抛）。 */
  files(number: number): Promise<unknown[]>;
  /** 某个提交上各 context 最新的一条提交状态（翻完页）。 */
  statuses(sha: string): Promise<unknown[]>;
  /** 开着的 PR（翻完页）。 */
  openPrs(): Promise<unknown[]>;
  writeStatus(
    sha: string,
    status: { state: GateState; description: string; targetUrl?: string },
  ): Promise<void>;
}

const PRS_MAX_PAGES = 20;
/** PR 的文件列表 GitHub 最多给 3000 个（每页 100、30 页）：30 页都满就是可能还有，读不全。 */
const FILES_MAX_PAGES = 30;
/** 一个提交上的状态：每个 context 最多 1000 条（GitHub 的上限），合并闸自己、冷验收两样。 */
const STATUS_MAX_PAGES = 30;

export function gateGitHub(api: GhApi): GitHubReads {
  return {
    pr: (number) => api.get(`/pulls/${number}`),
    async files(number) {
      const all: unknown[] = [];
      for (let page = 1; page <= FILES_MAX_PAGES; page++) {
        const got = await api.get(`/pulls/${number}/files?per_page=100&page=${page}`);
        if (!Array.isArray(got)) throw new Error(`PR #${number} 的文件列表第 ${page} 页认不出（不是列表）`);
        all.push(...got);
        if (got.length < 100) return all;
      }
      throw new Error(
        `PR #${number} 改的文件有 ${FILES_MAX_PAGES * 100} 个以上，GitHub 最多给这么多，读不全（拆小再开）`,
      );
    },
    async statuses(sha) {
      // 逐条的列表（新到旧）：翻完页，同一个 context 取最新的那条，旧的排在后面。
      const all: unknown[] = [];
      for (let page = 1; page <= STATUS_MAX_PAGES; page++) {
        const got = await api.get(`/commits/${sha}/statuses?per_page=100&page=${page}`);
        if (!Array.isArray(got))
          throw new Error(`提交 ${sha.slice(0, 7)} 的状态列表第 ${page} 页认不出（不是列表）`);
        all.push(...got);
        if (got.length < 100) return all;
      }
      throw new Error(`提交 ${sha.slice(0, 7)} 的状态超过 ${STATUS_MAX_PAGES * 100} 条，没读完`);
    },
    async openPrs() {
      const all: unknown[] = [];
      for (let page = 1; page <= PRS_MAX_PAGES; page++) {
        const got = await api.get(`/pulls?state=open&per_page=100&page=${page}`);
        if (!Array.isArray(got)) throw new Error(`开着的 PR 列表第 ${page} 页认不出（不是列表）`);
        all.push(...got);
        if (got.length < 100) return all;
      }
      throw new Error(`开着的 PR 超过 ${PRS_MAX_PAGES * 100} 个，没读完`);
    },
    async writeStatus(sha, s) {
      await api.post(`/statuses/${sha}`, {
        state: s.state,
        context: GATE_CONTEXT,
        description: s.description,
        ...(s.targetUrl ? { target_url: s.targetUrl } : {}),
      });
    },
  };
}

export interface LiveMeta {
  number: number;
  head: string;
  /** PR 的分支名（head.ref）：认「引擎任务工作流开的 PR」用。 */
  headRef: string;
  open: boolean;
  /** PR 正文（空正文 GitHub 给 null，当成空串）：认改标准的创始人原话用。 */
  body: string;
}

/** 从现读回来的 PR 里取合并闸要的几样；认不出返回一句为什么。 */
export function metaOf(live: unknown): LiveMeta | string {
  if (!isObject(live)) return 'PR 读回来不是对象';
  if (typeof live.number !== 'number') return 'number 认不出';
  const head = isObject(live.head) ? live.head.sha : undefined;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return 'head.sha 认不出';
  const headRef = isObject(live.head) ? live.head.ref : undefined;
  if (typeof headRef !== 'string' || !headRef) return 'head.ref 认不出';
  const { state } = live;
  if (state !== 'open' && state !== 'closed') return 'state 认不出';
  const { body } = live;
  if (body !== null && body !== undefined && typeof body !== 'string') return 'body 认不出';
  return {
    number: live.number,
    head,
    headRef,
    open: state === 'open',
    body: body ?? '',
  };
}

export interface GateResult {
  number: number;
  /** 当前头；PR 本身都没读到是 null（没处写状态）。 */
  head: string | null;
  /** PR 已经关了：不写状态。 */
  closed?: boolean;
  state: GateState;
  /** 有没有「没查成」的：有就是 failure，入口退出码 2。 */
  notChecked: boolean;
  lines: string[];
}

export interface GateDeps {
  gh: GitHubReads;
  /**
   * 这个仓的 CI 模式。不传 = 强制：闸跑在 GitHub Actions 里，读不到法国的库，
   * 不能因为没传就把引擎分支的冷验收放掉。驾驶舱设成不强制的仓，由调用方显式传入 off。
   */
  ciPolicy?: 'force' | 'off';
  /** 改标准的路径清单；不传读跑这段代码的那一份（standard-paths-file.ts，主线检出里的）。读不到、认不出就抛。 */
  standardPaths?: () => Promise<StandardPath[]>;
  /** 安全基的路径清单（standard-paths.json 的顶层 security-base 字段）；默认从主线上的那份读。读不到、认不出就抛。 */
  securityBase?: () => Promise<StandardPath[]>;
}

/** 从文件列表里的一条取 standardFiles 要的几样；认不出返回一句为什么。 */
function changedFileOf(item: unknown, i: number): ChangedFile | string {
  if (!isObject(item) || typeof item.filename !== 'string' || !item.filename)
    return `第 ${i + 1} 条没有 filename`;
  if (typeof item.status !== 'string') return `第 ${i + 1} 条（${item.filename}）没有 status`;
  const prev = item.previous_filename;
  if (prev !== undefined && typeof prev !== 'string')
    return `第 ${i + 1} 条（${item.filename}）的 previous_filename 认不出`;
  return { filename: item.filename, status: item.status, ...(prev ? { previous: prev } : {}) };
}

interface Verdict {
  ok: boolean;
  notChecked: boolean;
  lines: string[];
}

/** 改标准这一样：碰没碰清单、碰了正文里有没有创始人原话。读不到、认不出是没查成。 */
async function standardVerdict(
  meta: LiveMeta,
  deps: GateDeps,
  filesFromStandard: ChangedFile[],
): Promise<Verdict> {
  let list: StandardPath[];
  try {
    list = await (deps.standardPaths ?? loadStandardPaths)();
  } catch (e) {
    return { ok: false, notChecked: true, lines: [`没查成：改标准的路径清单读不到（${message(e)}）。`] };
  }
  const hits = standardFiles(filesFromStandard, list);
  if (hits.length === 0) return { ok: true, notChecked: false, lines: [] };
  const named = hits.map((h) => h.file).join('、');
  const quote = founderQuote(meta.body);
  if (!quote)
    return {
      ok: false,
      notChecked: false,
      lines: [
        `改标准缺创始人原话：碰了 ${named}；正文要有一行 **创始人原话**：「<原话>」（<时间>）（pnpm pr:open --founder-quote 写的就是）。`,
      ],
    };
  return {
    ok: true,
    notChecked: false,
    lines: [`改标准：碰了 ${named}，正文贴了创始人原话（${quote.at}）。`],
  };
}

/** 安全基（决定 0106）这一样：碰了清单任一文件，PR 当前头上就要有 security-base-approved 的 success（「前置要你拍」拍下来贴上的）。 */
async function securityBaseVerdict(meta: LiveMeta, deps: GateDeps, files: ChangedFile[]): Promise<Verdict> {
  const notChecked = (why: string): Verdict => ({ ok: false, notChecked: true, lines: [`没查成：${why}。`] });
  let list: StandardPath[];
  try {
    list = await (deps.securityBase ?? loadSecurityBase)();
  } catch (e) {
    return notChecked(`安全基清单读不到（${message(e)}）`);
  }
  const hits = standardFiles(files, list);
  if (hits.length === 0) return { ok: true, notChecked: false, lines: [] };
  let statuses: unknown[];
  try {
    statuses = await deps.gh.statuses(meta.head);
  } catch (e) {
    return notChecked(`读不到当前头 ${meta.head.slice(0, 7)} 的提交状态（${message(e)}）`);
  }
  const got = securityBaseFrom(statuses);
  if (typeof got === 'string') {
    return notChecked(`当前头 ${meta.head.slice(0, 7)} 的提交状态认不出：${got}`);
  }
  const named = hits.map((h) => h.file).join('、');
  const problems = checkSecurityBase(meta.head, got);
  if (problems.length > 0)
    return {
      ok: false,
      notChecked: false,
      lines: problems.map((p) => `${p}（碰了 ${named}）`),
    };
  return {
    ok: true,
    notChecked: false,
    lines: [`安全基：碰了 ${named}，当前头上有 ${SECURITY_BASE_CONTEXT}（批了）。`],
  };
}

/** 合前一次冷调用（#555-2）这一样：强制 CI 的引擎任务 PR（分支名认）当前头上要有通过的 cold-verify。 */
async function coldVerdict(meta: LiveMeta, deps: GateDeps): Promise<Verdict> {
  // 不强制 CI 的仓显式传入 off 才跳过；没传仍要，不能把别的仓放开。
  const policy = deps.ciPolicy ?? 'force';
  const flow = isFlowBranch(meta.headRef);
  const cold = coldVerifyNeed(flow, policy);
  if (!cold.needed) {
    const line =
      policy === 'off' && flow
        ? '能合：这个仓不强制 CI，引擎任务 PR 不看冷验收。'
        : '能合：不是引擎任务 PR，只看 CI。';
    return { ok: true, notChecked: false, lines: [line] };
  }
  let statuses: unknown[];
  try {
    statuses = await deps.gh.statuses(meta.head);
  } catch (e) {
    return {
      ok: false,
      notChecked: true,
      lines: [`没查成：读不到当前头 ${meta.head.slice(0, 7)} 的提交状态（${message(e)}）。`],
    };
  }
  const got = coldVerifyFrom(statuses);
  // 认不出 = 没查成（不当成没问题）：不当作「还没验」往下判。
  if (typeof got === 'string') {
    return {
      ok: false,
      notChecked: true,
      lines: [`没查成：当前头 ${meta.head.slice(0, 7)} 的提交状态认不出：${got}。`],
    };
  }
  // 没有这条、或不是 success：都判问题（不许拿「没有」当「没问题」，通用段底线第三条）。
  const problems = checkColdVerify(meta.head, got, cold);
  if (problems.length > 0) return { ok: false, notChecked: false, lines: problems };
  return { ok: true, notChecked: false, lines: ['能合：引擎任务 PR 的验收那一遍通过。'] };
}

/**
 * 判一个 PR。只读，不写状态。判红只有：碰了改标准路径、正文里没有创始人原话；引擎任务 PR 当前头上没有通过的 cold-verify；
 * 读不到、认不出（没查成）。草稿、冲突 GitHub 自己就合不了，这里不判（#654）。
 */
export async function gatePr(number: number, deps: GateDeps): Promise<GateResult> {
  const { gh } = deps;
  const broken = (why: string): GateResult => ({
    number,
    head: null,
    state: 'failure',
    notChecked: true,
    lines: [`没查成：${why}。`],
  });
  let meta: LiveMeta | string;
  try {
    meta = metaOf(await gh.pr(number));
  } catch (e) {
    return broken(`读不到 PR #${number} 现在的样子（${message(e)}）`);
  }
  if (typeof meta === 'string') return broken(`PR #${number} 读回来认不出：${meta}`);
  if (meta.number !== number)
    return { ...broken(`要的是 PR #${number}，读回来的是 #${meta.number}`), head: meta.head };
  if (!meta.open)
    return { number, head: meta.head, closed: true, state: 'failure', notChecked: false, lines: [] };

  // 先读一次文件列表（standardFiles 和 security-base 共用这一份：判红靠的都是这一遍，不重复调 GitHub）。
  const filesOk: ChangedFile[] = [];
  let filesFail: Verdict | null = null;
  {
    let raw: unknown[] = [];
    try {
      raw = await deps.gh.files(meta.number);
    } catch (e) {
      filesFail = {
        ok: false,
        notChecked: true,
        lines: [
          `没查成：读不到 PR #${meta.number} 改了哪些文件（${message(e)}），判不了碰没碰改标准和安全基。`,
        ],
      };
    }
    if (!filesFail) {
      for (const [i, item] of (raw ?? []).entries()) {
        const f = changedFileOf(item, i);
        if (typeof f === 'string') {
          filesFail = {
            ok: false,
            notChecked: true,
            lines: [`没查成：PR #${meta.number} 的文件列表认不出：${f}。`],
          };
          break;
        }
        filesOk.push(f);
      }
    }
  }

  const verdicts: Verdict[] = [
    await coldVerdict(meta, deps),
    filesFail ?? (await standardVerdict(meta, deps, filesOk)),
    ...(filesFail ? [] : [await securityBaseVerdict(meta, deps, filesOk)]),
  ];
  // `filesFail` 已在两项里充当之前的「读不到就判没查成」，别重复进安全基。
  const ok = verdicts.every((v) => v.ok);
  return {
    number,
    head: meta.head,
    state: ok ? 'success' : 'failure',
    notChecked: verdicts.some((v) => v.notChecked),
    // 不通过时只写不通过的那几样（「能合：……」夹在里面读着像能合）
    lines: verdicts.filter((v) => ok || !v.ok).flatMap((v) => v.lines),
  };
}

export interface RunResult {
  /**
   * 写状态时：0 = 每个 PR 都写上了（写的是通过还是不通过都算）；2 = 有没写上、没算成的。
   * 只报不写时（--no-write）：0 = 能合；1 = 不能合；2 = 没查成。
   */
  code: 0 | 1 | 2;
  lines: string[];
}

/** 这次事件要算哪几个 PR；认不出返回一句为什么，不用算返回 []。 */
export async function targetPrs(
  eventName: string,
  event: unknown,
  gh: GitHubReads,
): Promise<number[] | string> {
  const ev = isObject(event) ? event : {};
  switch (eventName) {
    case 'pull_request':
    case 'pull_request_target': {
      const pr = isObject(ev.pull_request) ? ev.pull_request.number : undefined;
      return typeof pr === 'number' ? [pr] : '事件里没有 pull_request.number';
    }
    case 'status':
      // 不按事件里的 sha 只算那一个 PR：status 事件共用一个排队组（merge-gate.yml），排着的只留最新一个，中间的被取消——
      // 一轮里给好几个 PR 贴 cold-verify 时，只算最后那个的话前面几个就一直停在旧结论上（#351 演练撞到）。
      // 所以留下来的那一次把开着的 PR 全重算一遍，每个都现读自己此刻的状态。
      // security-base-approved 同理：「要你拍」批拍下来贴上新状态时，开着的 PR 要重算。
      if (ev.context !== COLD_VERIFY_CONTEXT && ev.context !== SECURITY_BASE_CONTEXT) return [];
      return numbersOf(await gh.openPrs(), () => true);
    case 'push':
      // 工作流的 paths 只放行了闸认的那几个文件（merge-gate.yml），到这里就是「判定输入变了」：开着的 PR 全重算，每个都现读自己此刻的状态。
      return numbersOf(await gh.openPrs(), () => true);
    case 'workflow_dispatch': {
      const input = isObject(ev.inputs) ? String(ev.inputs.pr ?? '').trim() : '';
      if (!input || input === 'all') return numbersOf(await gh.openPrs(), () => true);
      return /^\d+$/.test(input)
        ? [Number(input)]
        : `手动运行填的 PR 号「${input}」认不出（填数字，或留空算所有开着的）`;
    }
    default:
      return `不认得的事件 ${eventName}`;
  }
}

function numbersOf(list: unknown[], keep: (p: Record<string, unknown>) => boolean): number[] {
  return list
    .map((p) => {
      if (!isObject(p) || typeof p.number !== 'number')
        throw new Error('PR 列表里有一条认不出（没有 number）');
      return p;
    })
    .filter(keep)
    .map((p) => p.number as number);
}

/** 读事件文件、认出这次要算哪些 PR；认不出返回一句为什么。 */
async function eventTargets(
  eventName: string | undefined,
  eventPath: string | undefined,
  gh: GitHubReads,
): Promise<number[] | string> {
  if (!eventName || !eventPath)
    return '没有 GITHUB_EVENT_NAME 或 GITHUB_EVENT_PATH（合并闸在 GitHub Actions 里跑）';
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch (e) {
    return `事件文件 ${eventPath} 读不出来（${message(e)}）`;
  }
  try {
    return await targetPrs(eventName, event, gh);
  } catch (e) {
    return `认不出这次要算哪些 PR（${message(e)}）`;
  }
}

export async function runMergeGate(opts: {
  eventName: string | undefined;
  eventPath: string | undefined;
  gh: GitHubReads;
  /** true = 把结果写成 merge-gate 状态；false = 只报（--no-write）。 */
  write: boolean;
  /** 状态上「详情」链到的地方（这次运行的页面）。 */
  targetUrl?: string;
}): Promise<RunResult> {
  const fail = (why: string): RunResult => ({ code: 2, lines: [`没查成：${why}。`] });
  const numbers = await eventTargets(opts.eventName, opts.eventPath, opts.gh);
  if (typeof numbers === 'string') return fail(numbers);
  if (!opts.write && numbers.length !== 1) return fail('只报不写时一次只算一个 PR（pull_request 事件）');
  if (numbers.length === 0) return { code: 0, lines: ['这次没有要算的 PR。'] };

  const deps: GateDeps = { gh: opts.gh };
  const lines: string[] = [];
  let code: 0 | 1 | 2 = 0;
  for (const n of numbers) {
    const r = await gatePr(n, deps);
    if (r.closed) {
      lines.push(`PR #${n} 已经关了，不算。`);
      continue;
    }
    lines.push(`PR #${n}：${GATE_CONTEXT} ${r.state}`, ...r.lines.map((l) => `  ${l}`));
    if (!opts.write) {
      code = r.notChecked ? 2 : r.state === 'success' ? 0 : 1;
      continue;
    }
    if (r.notChecked) code = 2;
    if (r.head === null) {
      lines.push('  没写上状态：连 PR 的头都没读到。');
      code = 2;
      continue;
    }
    try {
      await opts.gh.writeStatus(r.head, {
        state: r.state,
        description: statusDescription(r.lines),
        ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}),
      });
    } catch (e) {
      lines.push(`  没写上状态（${message(e)}）。`);
      code = 2;
    }
  }
  return { code, lines };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
