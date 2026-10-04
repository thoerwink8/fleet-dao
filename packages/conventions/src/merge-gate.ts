// 合并闸（#74）：在 PR 当前头上写提交状态 merge-gate，「按我们的规矩能不能合」只看它一个（design 第五节「流程只为快」）。
// 判红只有两样（#444 收窄到四样；#654 起草稿和冲突交给 GitHub 自己拦——它本来就合不了——不再在这里判，PR 正文也没有必填栏、闸不再提醒）：
// 改到先审后合的路径（删改迁移；碰安全：密钥鉴权、CI 和卫生检查、对公网开口子和提权的生产配置）而当前头上没有通过的 second-opinion；
// #555-2 起还有一条：引擎任务工作流（#632）开的 PR（分支 fleet/<单号>-t<8 位>），当前头上要有通过的 cold-verify（合前一次冷调用，
// 换家族验「单子说要的东西真做了没有」）——**闸只读这条状态，不在这里起模型调用**（判法要确定，同一份代码什么时候跑结果都一样，
// design 第五节）；冷调用在装配侧（引擎）跑、结论贴成状态。别的 PR 不验，也就没有这条状态——那是「不用验」，不是「没验成」，
// 两者在 coldVerifyNeed 里分开。读不到、认不出写 failure（没查成）。
// merge-gate.yml 在 PR 事件（头变了）、second-opinion 或 cold-verify 状态写上来时跑它（后两种逐个重算所有开着的 PR）；主线推送只在闸认的东西
// （高风险清单、判法、工作流本身）变了才触发、同样重算所有开着的 PR——清单加了新路径，开着的 PR 上旧的 success 不能留着（#654 第二意见）；
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
import { workflowDiff } from './workflow-structure.ts';

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
  /** 某个提交上某个文件的全文；文件在那个提交里不存在回 null；读不到、认不出就抛。 */
  fileAt(path: string, ref: string): Promise<string | null>;
  /** 两个提交的共同祖先（GET /compare）；读不到、认不出就抛。PR 的改动是对它算的，比对工作流前后两份要用同一个起点。 */
  mergeBase(base: string, head: string): Promise<string>;
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
    async fileAt(path, ref) {
      const got = await api.getOrNull(
        `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
      );
      if (got === null) return null;
      if (
        !isObject(got) ||
        got.type !== 'file' ||
        got.encoding !== 'base64' ||
        typeof got.content !== 'string'
      ) {
        throw new Error(
          `${path}（${ref.slice(0, 7)}）读回来认不出（不是 base64 的文件；超过 1MB 的文件 GitHub 不给内容）`,
        );
      }
      return Buffer.from(got.content, 'base64').toString('utf8');
    },
    async mergeBase(base, head) {
      const got = await api.get(`/compare/${base}...${head}`);
      const sha = isObject(got) && isObject(got.merge_base_commit) ? got.merge_base_commit.sha : undefined;
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`${base.slice(0, 7)}...${head.slice(0, 7)} 的共同祖先认不出`);
      }
      return sha;
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
  /** PR 的目标分支现在的头（base.sha）：比对工作流要用它找共同祖先；认不出就没有，要比对时判没查成。 */
  base?: string;
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
  const base = isObject(live.base) ? live.base.sha : undefined;
  return {
    number: live.number,
    head,
    headRef,
    ...(typeof base === 'string' && /^[0-9a-f]{40}$/.test(base) ? { base } : {}),
    changedFiles,
    open: state === 'open',
  };
}

/**
 * 改了已有的工作流（hit.pending）：读改动前后两份全文做结构比对（workflow-structure.ts）。
 * 比出碰到信任的地方：留着，note 写第一条；一处都没碰：去掉这条（不用第二意见）；读不懂：留着（算碰了）；
 * 读不到文件、找不到共同祖先：没查成（notChecked，不当成「没碰」），这条也留着，免得把没查成的当成没事。
 */
export async function resolveWorkflowHits(
  hits: readonly RiskyFile[],
  meta: LiveMeta,
  gh: Pick<GitHubReads, 'fileAt' | 'mergeBase'>,
): Promise<{ hits: RiskyFile[]; notChecked: string[] }> {
  const out: RiskyFile[] = [];
  const notChecked: string[] = [];
  for (const h of hits) {
    if (!h.pending) {
      out.push(h);
      continue;
    }
    const keep = (note: string) => out.push({ file: h.file, rule: h.rule, kind: h.kind, note });
    if (!meta.base) {
      notChecked.push(`PR 读回来没有 base.sha，没法比对 ${h.file} 改动前后`);
      keep('没法比对改动前后');
      continue;
    }
    try {
      const origin = await gh.mergeBase(meta.base, meta.head);
      const [before, after] = await Promise.all([gh.fileAt(h.file, origin), gh.fileAt(h.file, meta.head)]);
      if (before === null || after === null) {
        // 改了已有的文件，两头都该在：读回「不存在」是没查成（判红、写明），不是「要审」——审过了也不放行
        notChecked.push(
          `${h.file} 改动${before === null ? '前' : '后'}的那份读不到（${(before === null ? origin : meta.head).slice(0, 7)} 上没有这个文件）`,
        );
        keep('改动前或改动后的文件读不到');
        continue;
      }
      const diff = await workflowDiff(before, after);
      if (typeof diff === 'string') keep(diff);
      else if (diff.length > 0) keep(`${diff[0]}${diff.length > 1 ? `（另有 ${diff.length - 1} 处）` : ''}`);
    } catch (e) {
      notChecked.push(`比对 ${h.file} 改动前后没成（${message(e)}）`);
      keep('没法比对改动前后');
    }
  }
  return { hits: out, notChecked };
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
      } else {
        hits = riskyFiles(files, deps.riskList);
        if (hits.some((h) => h.pending)) {
          const done = await resolveWorkflowHits(hits, meta, gh);
          hits = done.hits;
          notChecked.push(...done.notChecked);
        }
      }
    } catch (e) {
      faceProblem = `读不到 PR #${number} 改了哪些文件（${message(e)}）`;
      notChecked.push(faceProblem);
    }
  }
  // 合前一次冷调用（#555-2）要不要等：引擎任务工作流开的 PR 要（分支名认），别的不要——和改没改到先审后合的路径无关，
  // 所以上面判不了改没改到（faceProblem）也不影响这一条。
  const cold = coldVerifyNeed(isFlowBranch(meta.headRef));
  // 先合后审的（清单里 review: after-merge，CI 判法那几份；创始人 2026-10-03「1+2+3」的第 3 条）：不等第二意见，
  // 能合的结论里点名「合并后补审」，由 second-opinion.mjs --after-merge-pending / --after-merge-sweep 合并后补上
  const later = hits.filter((h) => h.afterMerge);
  hits = hits.filter((h) => !h.afterMerge);
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
  const afterMerge =
    later.length === 0
      ? []
      : [
          `合并后补审：${later.map((h) => h.file).join('、')}（先合后审；合并后跑 second-opinion.mjs --pr ${number}，没过就开修复 PR 或 revert）。`,
        ];
  return { ...base, state: 'success', notChecked: false, lines: [`能合：${why}。`, ...afterMerge] };
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

/** 读事件文件、认出这次要算哪些 PR；认不出返回一句为什么（runMergeGate 和 workflowParseNeeded 共用，两边认的 PR 必须是同一批）。 */
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

/**
 * 这次要算的 PR 里，有没有改了已有 ci.yml 的（要把前后两份解析成结构，得装 yaml 依赖）。merge-gate.yml 先问这个、再决定装不装依赖：
 * 绝大多数 PR 不碰 ci.yml，装依赖那几步（约 8–10 秒、占着一台机器）白做。
 * 只有「查实了一个都没有」才回 needed=false；认不出事件、读不到文件列表、清单读不出、文件数和 PR 说的对不上，一律 needed=true
 * （装了依赖，真正的判定那一步照旧自己再 fail loud），不拿「没查成」当「不需要」。判「改没改到 ci.yml」和闸用的是同一个 riskyFiles。
 */
export async function workflowParseNeeded(opts: {
  eventName: string | undefined;
  eventPath: string | undefined;
  riskListText: string | undefined;
  gh: GitHubReads;
}): Promise<{ needed: boolean; why: string }> {
  const numbers = await eventTargets(opts.eventName, opts.eventPath, opts.gh);
  if (typeof numbers === 'string') return { needed: true, why: `没判成这次算哪些 PR：${numbers}` };
  const riskList = opts.riskListText === undefined ? '读不到' : parseRiskPaths(opts.riskListText);
  if (typeof riskList === 'string')
    return { needed: true, why: `先审后合的路径清单 ${RISK_PATHS_FILE} ${riskList}` };
  for (const n of numbers) {
    try {
      const meta = metaOf(await opts.gh.pr(n));
      if (typeof meta === 'string') return { needed: true, why: `PR #${n} 读回来认不出：${meta}` };
      if (!meta.open) continue;
      const files = await opts.gh.files(n);
      if (files.length !== meta.changedFiles)
        return { needed: true, why: `PR #${n} 改了 ${meta.changedFiles} 个文件，只读到 ${files.length} 个` };
      if (riskyFiles(files, riskList).some((h) => h.pending))
        return { needed: true, why: `PR #${n} 改了已有的工作流，要解析前后两份` };
    } catch (e) {
      return { needed: true, why: `PR #${n} 改了哪些文件没读成（${message(e)}）` };
    }
  }
  return { needed: false, why: `${numbers.length} 个 PR 都没有改已有的工作流，不用装 YAML 依赖` };
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
  const numbers = await eventTargets(opts.eventName, opts.eventPath, opts.gh);
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
