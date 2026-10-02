// 合并闸（#74）：在 PR 当前头上写提交状态 merge-gate，「按我们的规矩能不能合」只看它一个（design 第五节「流程只为快」）。
// 判红只有两样（#444 收窄到四样；#654 起草稿和冲突交给 GitHub 自己拦——它本来就合不了——不再在这里判，PR 正文也没有必填栏、闸不再提醒）：
// 改到先审后合的路径（删改迁移；碰安全：密钥鉴权、CI 和卫生检查、对公网开口子和提权的生产配置）而当前头上没有通过的 second-opinion；
// #555-2 起还有一条：引擎任务工作流（#632）开的 PR（分支 fleet/<单号>-t<8 位>），当前头上要有通过的 cold-verify（合前一次冷调用，
// 换家族验「单子说要的东西真做了没有」）——**闸只读这条状态，不在这里起模型调用**（判法要确定，同一份代码什么时候跑结果都一样，
// design 第五节）；冷调用在装配侧（引擎）跑、结论贴成状态。别的 PR 不验，也就没有这条状态——那是「不用验」，不是「没验成」，
// 两者在 coldVerifyNeed 里分开。读不到、认不出写 failure（没查成）。
// merge-gate.yml 在 PR 事件（头变了）、second-opinion 或 cold-verify 状态写上来时跑它（后两种逐个重算所有开着的 PR）；主线推送不再触发——冲突不判了，主线一变没有什么会变；
// 不检出、不跑 PR 里的代码：判法和清单都用跑这段代码的那一份（主线的）。
import { readFileSync } from 'node:fs';
import { isFlowBranch } from './flow-branch.ts';
import type { GhApi } from './gh-api.ts';
import {
  type ChangedFile,
  COLD_VERIFY_CONTEXT,
  checkColdVerify,
  checkSecondOpinion,
  coldVerifyFrom,
  coldVerifyNeed,
  GATE_CONTEXT,
  parseRiskPaths,
  RISK_PATHS_FILE,
  type RiskPath,
  type RiskyFile,
  riskyFiles,
  SECOND_OPINION_CONTEXT,
  secondOpinionFrom,
  statusDescription,
} from './merge-gates.ts';

export type GateState = 'success' | 'failure';

/** 合并闸要读写的 GitHub 上的东西；读不到、读回来认不出就抛（调用方判「没查成」）。 */
export interface GitHubReads {
  /** PR 现在的样子（GET /pulls/{n}）。 */
  pr(number: number): Promise<unknown>;
  /** PR 改到的文件（读全了才回；条数由调用方和 PR 的 changed_files 对）。 */
  files(number: number): Promise<ChangedFile[]>;
  /** 某个提交上各 context 最新的一条提交状态（翻完页）。 */
  statuses(sha: string): Promise<unknown[]>;
  /** 开着的 PR（翻完页）。 */
  openPrs(): Promise<unknown[]>;
  writeStatus(
    sha: string,
    status: { state: GateState; description: string; targetUrl?: string },
  ): Promise<void>;
}

/** GitHub 的 PR 文件列表一页最多 100 个、总共最多 3000 个。 */
const FILES_PER_PAGE = 100;
const FILES_MAX_PAGES = 30;
const PRS_MAX_PAGES = 20;
/** 一个提交上的状态：每个 context 最多 1000 条（GitHub 的上限），合并闸自己、第二意见两样。 */
const STATUS_MAX_PAGES = 30;

export function gateGitHub(api: GhApi): GitHubReads {
  return {
    pr: (number) => api.get(`/pulls/${number}`),
    async files(number) {
      const out: ChangedFile[] = [];
      for (let page = 1; page <= FILES_MAX_PAGES; page++) {
        const got = await api.get(`/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`);
        if (!Array.isArray(got))
          throw new Error(`PR #${number} 的改动文件列表第 ${page} 页认不出（不是列表）`);
        for (const f of got) {
          if (!isObject(f) || typeof f.filename !== 'string' || !f.filename || typeof f.status !== 'string') {
            throw new Error(`PR #${number} 的改动文件列表第 ${page} 页有一条认不出（没有 filename、status）`);
          }
          out.push({
            filename: f.filename,
            status: f.status,
            ...(typeof f.patch === 'string' ? { patch: f.patch } : {}),
            ...(typeof f.previous_filename === 'string' && f.previous_filename
              ? { previous: f.previous_filename }
              : {}),
          });
        }
        if (got.length < FILES_PER_PAGE) break;
      }
      return out;
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
  changedFiles: number;
  open: boolean;
}

/** 从现读回来的 PR 里取合并闸要的几样；认不出返回一句为什么。 */
export function metaOf(live: unknown): LiveMeta | string {
  if (!isObject(live)) return 'PR 读回来不是对象';
  if (typeof live.number !== 'number') return 'number 认不出';
  const head = isObject(live.head) ? live.head.sha : undefined;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return 'head.sha 认不出';
  const headRef = isObject(live.head) ? live.head.ref : undefined;
  if (typeof headRef !== 'string' || !headRef) return 'head.ref 认不出';
  const { changed_files: changedFiles, state } = live;
  if (typeof changedFiles !== 'number' || !Number.isInteger(changedFiles) || changedFiles < 0) {
    return 'changed_files 认不出';
  }
  if (state !== 'open' && state !== 'closed') return 'state 认不出';
  return { number: live.number, head, headRef, changedFiles, open: state === 'open' };
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
  /** 高风险清单：认出来的条目，或认不出的原因。 */
  riskList: RiskPath[] | string;
}

/**
 * 判一个 PR。只读，不写状态。判红只有：改到先审后合的路径而当前头上没有通过的 second-opinion；引擎任务 PR 当前头上没有通过的
 * cold-verify；读不到、认不出（没查成）。草稿、冲突 GitHub 自己就合不了，这里不判（#654）。
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

  const notChecked: string[] = [];
  const problems: string[] = [];

  let hits: RiskyFile[] = [];
  // 判不了「改没改到先审后合/N 的地方」的原因：有它就是没查成（下面两条判法都据此判红），不当成「没改到」。
  let faceProblem: string | undefined;
  if (typeof deps.riskList === 'string') {
    faceProblem = `先审后合的路径清单 ${RISK_PATHS_FILE} ${deps.riskList}`;
    notChecked.push(`${faceProblem}，没法判改没改到先审后合的地方`);
  } else {
    try {
      const files = await gh.files(number);
      if (files.length !== meta.changedFiles) {
        faceProblem = `PR #${number} 改了 ${meta.changedFiles} 个文件，只读到 ${files.length} 个（GitHub 的列表最多给 3000 个）`;
        notChecked.push(`${faceProblem}，没法判改没改到先审后合的地方`);
      } else hits = riskyFiles(files, deps.riskList);
    } catch (e) {
      faceProblem = `读不到 PR #${number} 改了哪些文件（${message(e)}）`;
      notChecked.push(faceProblem);
    }
  }
  // 合前一次冷调用（#555-2）要不要等：引擎任务工作流开的 PR 要（分支名认），别的不要——和改没改到先审后合的路径无关，
  // 所以上面判不了改没改到（faceProblem）也不影响这一条。
  const cold = coldVerifyNeed(isFlowBranch(meta.headRef));
  if (hits.length > 0 || cold.needed) {
    let statuses: unknown[] | undefined;
    try {
      statuses = await gh.statuses(meta.head);
    } catch (e) {
      notChecked.push(`读不到当前头 ${meta.head.slice(0, 7)} 的提交状态（${message(e)}）`);
    }
    if (statuses) {
      if (hits.length > 0) {
        const got = secondOpinionFrom(statuses);
        if (typeof got === 'string')
          notChecked.push(`当前头 ${meta.head.slice(0, 7)} 的提交状态认不出：${got}`);
        else problems.push(...checkSecondOpinion(meta.head, got, hits));
      }
      // 同一份 statuses 里再取一条：冷调用的结论是**另一个** context（不是 second-opinion），各认各的。
      const coldGot = coldVerifyFrom(statuses);
      if (typeof coldGot === 'string') {
        // 认不出 = 没查成（不当成没问题）：走 notChecked，不当作「还没验」往下判。
        notChecked.push(`当前头 ${meta.head.slice(0, 7)} 的提交状态认不出：${coldGot}`);
      } else {
        // 没有这条、或不是 success：都判问题（不许拿「没有」当「没问题」，通用段底线第三条）。
        problems.push(...checkColdVerify(meta.head, coldGot, cold));
      }
    }
  }

  const base = { number, head: meta.head };
  if (notChecked.length > 0) {
    return {
      ...base,
      state: 'failure',
      notChecked: true,
      lines: [...notChecked.map((w) => `没查成：${w}。`), ...problems],
    };
  }
  if (problems.length > 0) return { ...base, state: 'failure', notChecked: false, lines: problems };
  const why = [
    hits.length === 0
      ? '没改到先审后合的地方'
      : `改到 ${hits.length} 个先审后合的地方，当前头上第二意见已通过`,
    ...(cold.needed ? ['引擎任务 PR 的验收那一遍也通过'] : []),
  ].join('，');
  return { ...base, state: 'success', notChecked: false, lines: [`能合：${why}。`] };
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
      // 一轮里给好几个 PR 贴 second-opinion 时，只算最后那个的话前面几个就一直停在旧结论上（#351 演练撞到）。
      // 所以留下来的那一次把开着的 PR 全重算一遍，每个都现读自己此刻的状态。
      // 冷调用（cold-verify）写上时同理：它是另一个 context（#555-2），单子关上时这条状态才到，闸要跟着重算。
      if (ev.context !== SECOND_OPINION_CONTEXT && ev.context !== COLD_VERIFY_CONTEXT) return [];
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

export async function runMergeGate(opts: {
  eventName: string | undefined;
  eventPath: string | undefined;
  /** 高风险清单的文本；读不到是 undefined。 */
  riskListText: string | undefined;
  gh: GitHubReads;
  /** true = 把结果写成 merge-gate 状态；false = 只报（--no-write）。 */
  write: boolean;
  /** 状态上「详情」链到的地方（这次运行的页面）。 */
  targetUrl?: string;
}): Promise<RunResult> {
  const fail = (why: string): RunResult => ({ code: 2, lines: [`没查成：${why}。`] });
  if (!opts.eventName || !opts.eventPath)
    return fail('没有 GITHUB_EVENT_NAME 或 GITHUB_EVENT_PATH（合并闸在 GitHub Actions 里跑）');
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(opts.eventPath, 'utf8'));
  } catch (e) {
    return fail(`事件文件 ${opts.eventPath} 读不出来（${message(e)}）`);
  }
  let numbers: number[] | string;
  try {
    numbers = await targetPrs(opts.eventName, event, opts.gh);
  } catch (e) {
    return fail(`认不出这次要算哪些 PR（${message(e)}）`);
  }
  if (typeof numbers === 'string') return fail(numbers);
  if (!opts.write && numbers.length !== 1) return fail('只报不写时一次只算一个 PR（pull_request 事件）');
  if (numbers.length === 0) return { code: 0, lines: ['这次没有要算的 PR。'] };

  const riskList = opts.riskListText === undefined ? '读不到' : parseRiskPaths(opts.riskListText);
  const deps: GateDeps = { gh: opts.gh, riskList };
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
