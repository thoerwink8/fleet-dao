// 合并闸（#74）：在 PR 当前头上写提交状态 merge-gate，「按我们的规矩能不能合」只看它一个（design 第五节「流程只为快」）。
// 判红的输入：
// - 改标准（人闸第四类，design 第五节「人闸第四类：改标准」）：PR 改到的文件（含改名前的名字）落进 standard-paths.json 的清单，
//   正文里却没有创始人同意的记录（「创始人原话」那一行，原话、时间都不能空；认法是 pr-columns.ts 的 founderQuote，
//   pnpm pr:open --founder-quote 写出来的就是它）。清单用跑这段代码的那一份（主线的）：PR 改不了自己的门槛。
// - 引擎任务工作流（#632）开的 PR（分支 fleet/<单号>-t<8 位>）当前头上要有通过的 cold-verify（合前一次冷调用，换家族验
//   「单子说要的东西真做了没有」，#555-2）——**闸只读这条状态，不在这里起模型调用**（判法要确定，同一份代码什么时候跑
//   结果都一样，design 第五节）；冷调用在装配侧（引擎）跑、结论贴成状态。别的 PR 不验，也就没有这条状态——
//   那是「不用验」，不是「没验成」，两者在 coldVerifyNeed 里分开。
// 本机 local 分支的显式受信退回由 readFeedback 判；未解决或读不到均不清绿。
// 草稿、冲突 GitHub 自己拦。读不到、认不出（PR、文件列表、清单、提交状态）写 failure（没查成）。
// merge-gate.yml 在 PR 事件（头变了、正文改了——补上原话要重算）或 cold-verify 状态写上来时跑它（后一种逐个重算所有开着的 PR）；
// 主线推送只在闸认的东西（判法、清单、工作流本身）变了才触发、同样重算所有开着的 PR——判法收紧了，开着的 PR 上旧的 success
// 不能留着（#654 第二意见）；不检出、不跑 PR 里的代码：判法和清单用跑这段代码的那一份（主线的）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CI_POLICY_SOURCE_PREFIX,
  type PolicyRepo,
  policyHead,
  policyRepo,
  policySourceNumber,
} from '../../shared/src/ci-policy-bridge.ts';
import type { ClosedPolicyHead, PolicyReadResult } from './ci-policy-bridge.ts';
import { isFlowBranch } from './flow-branch.ts';
import type { GhApi } from './gh-api.ts';
import {
  COLD_VERIFY_CONTEXT,
  checkColdVerify,
  coldVerifyFrom,
  coldVerifyNeed,
  GATE_CONTEXT,
  statusDescription,
} from './merge-gates.ts';
import { founderQuote } from './pr-columns.ts';
import { type ChangedFile, type StandardPath, standardFiles } from './standard-paths.ts';
import { loadStandardPaths } from './standard-paths-file.ts';

export type GateState = 'success' | 'failure';

interface Publication {
  number: number;
  lines: string[];
  notChecked: boolean;
  policy?: 'force' | 'off';
  repo?: PolicyRepo;
  feedback?: unknown;
  failure?: string;
}

interface StatusWitness {
  number: number;
  consumed: Map<string, string>;
}

// 只保存本次计算实际读过的来源，不跨运行缓存；policyReader 的既有闭包也经过同一个 statuses 入口。
const statusWitness = new AsyncLocalStorage<StatusWitness>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function sourceSnapshot(statuses: unknown[], number: number): string {
  const contexts = new Set([COLD_VERIFY_CONTEXT, `${CI_POLICY_SOURCE_PREFIX}${number}`]);
  // policy reader 会越过陌生 writer 选择可信来源，不能仅见证每个 context 的第一条。
  return canonical(statuses.filter((raw) => isObject(raw) && contexts.has(String(raw.context))));
}

function observeSources(sha: string, statuses: unknown[]): void {
  const scope = statusWitness.getStore();
  if (!scope) return;
  const current = sourceSnapshot(statuses, scope.number);
  const consumed = scope.consumed.get(sha);
  if (consumed !== undefined && consumed !== current)
    throw new Error('本轮已消费的 cold/source 身份或内容改变，请重算');
  scope.consumed.set(sha, current);
}

function sameRepoRun(url: URL, repo: PolicyRepo | undefined): boolean {
  return (
    !!repo &&
    url.origin === 'https://github.com' &&
    new RegExp(`^/${repo.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/actions/runs/[1-9]\\d*$`, 'i').test(
      url.pathname,
    )
  );
}

function publicationUrl(targetUrl: string, proof: unknown, repo: PolicyRepo | undefined): string {
  const url = new URL(targetUrl);
  if (url.protocol !== 'https:') throw new Error('状态详情 URL 不是 HTTPS');
  // Actions runId 只是首次发表的追溯位置，不是判定输入；其他链接（含自带 fragment）完整绑定。
  const target =
    repo && sameRepoRun(url, repo) && !url.search && !url.hash
      ? `${url.origin}/${repo.repo.toLowerCase()}/actions/runs/`
      : url.href;
  const digest = createHash('sha256').update(canonical({ target, proof })).digest('hex');
  url.hash = `fleet-merge-gate-v1=${digest}`;
  return url.href;
}

function samePublicationUrl(left: unknown, right: string, repo: PolicyRepo | undefined): boolean {
  if (typeof left !== 'string') return false;
  try {
    const old = new URL(left);
    const current = new URL(right);
    if (sameRepoRun(old, repo) && sameRepoRun(current, repo)) {
      old.pathname = old.pathname.replace(/\d+$/, '1');
      current.pathname = current.pathname.replace(/\d+$/, '1');
    }
    return old.href === current.href;
  } catch {
    return false;
  }
}

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
    status: { state: GateState; description: string; targetUrl?: string; publication?: Publication },
  ): Promise<undefined | 'unchanged' | 'closed'>;
}

const PRS_MAX_PAGES = 20;
/** PR 的文件列表 GitHub 最多给 3000 个（每页 100、30 页）：30 页都满就是可能还有，读不全。 */
const FILES_MAX_PAGES = 30;
/** 一个提交上的状态：每个 context 最多 1000 条（GitHub 的上限），合并闸自己、冷验收两样。 */
const STATUS_MAX_PAGES = 30;

export function gateGitHub(api: GhApi): GitHubReads {
  const gh: GitHubReads = {
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
        if (got.length < 100) {
          observeSources(sha, all);
          return all;
        }
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
      let targetUrl = s.targetUrl;
      if (s.publication && targetUrl) {
        const statuses = await gh.statuses(sha);
        for (const raw of statuses) {
          if (!isObject(raw) || typeof raw.context !== 'string' || !raw.context.trim())
            throw new Error('发表前提交状态列表有认不出的条目或 context');
        }
        const scope = statusWitness.getStore();
        targetUrl = publicationUrl(
          targetUrl,
          {
            sha,
            state: s.state,
            description: s.description,
            ...s.publication,
            sources: scope?.consumed.get(sha) ?? null,
          },
          s.publication.repo,
        );
        const latest = statuses.find((raw) => isObject(raw) && raw.context === GATE_CONTEXT);
        let unchanged = false;
        if (latest !== undefined) {
          if (!isObject(latest) || !isObject(latest.creator) || !api.globalGet)
            throw new Error('最新 merge-gate 的发表者身份未核实');
          const writer = await api.globalGet('/users/github-actions%5Bbot%5D');
          if (
            !isObject(writer) ||
            writer.login !== 'github-actions[bot]' ||
            writer.type !== 'Bot' ||
            !Number.isSafeInteger(writer.id) ||
            Number(writer.id) < 1 ||
            latest.creator.id !== writer.id ||
            latest.creator.login !== writer.login ||
            latest.creator.type !== writer.type
          )
            throw new Error('最新 merge-gate 不是已核实的 Actions Bot');
          if (
            !Number.isSafeInteger(latest.id) ||
            Number(latest.id) < 1 ||
            !['success', 'failure', 'pending', 'error'].includes(String(latest.state)) ||
            (latest.description !== null && typeof latest.description !== 'string') ||
            (latest.target_url !== null && typeof latest.target_url !== 'string')
          )
            throw new Error('最新 merge-gate 状态认不出');
          if (
            s.publication.repo &&
            (typeof latest.url !== 'string' ||
              latest.url.toLowerCase() !==
                `https://api.github.com/repos/${s.publication.repo.repo}/statuses/${sha}`.toLowerCase())
          )
            throw new Error('最新 merge-gate 状态 URL 的仓或 SHA 对不上');
          unchanged =
            !!s.publication.repo &&
            latest.state === s.state &&
            latest.description === s.description &&
            samePublicationUrl(latest.target_url, targetUrl, s.publication.repo);
        }
        // 分页与发表者读取也可能耗时；去重和写入共用这次最后的 head 守卫。
        if (!s.publication.failure) {
          const raw = await gh.pr(s.publication.number);
          const current = metaOf(raw);
          if (typeof current === 'string') throw new Error(current);
          if (current.number !== s.publication.number || current.head !== sha)
            throw new Error('发表前 PR 身份或 head 改变，请重算');
          if (s.publication.repo) {
            const identity = policyHead(raw, s.publication.repo);
            if (identity.number !== current.number || identity.head !== sha)
              throw new Error('发表前 PR 仓身份改变，请重算');
          }
          if (!current.open) return 'closed';
        }
        if (unchanged) return 'unchanged';
      }
      await api.post(`/statuses/${sha}`, {
        state: s.state,
        context: GATE_CONTEXT,
        description: s.description,
        ...(targetUrl ? { target_url: targetUrl } : {}),
      });
    },
  };
  return gh;
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
  /** 本轮已验证的模式；发表前再读，不能沿用旧 off。 */
  policy?: 'force' | 'off';
  repo?: PolicyRepo;
}

export interface GateDeps {
  gh: GitHubReads;
  /**
   * 纯判法可注入 CI 模式，不给一律 force；生产入口只用可信 source 的现读 DB reader。
   */
  ciPolicy?: 'force' | 'off';
  readCiPolicy?: (number: number, head: string) => Promise<PolicyReadResult>;
  readFeedback?: (number: number, head: string) => Promise<{ records: { resolved: boolean }[] }>;
  /** 改标准的路径清单；不传读跑这段代码的那一份（standard-paths-file.ts，主线检出里的）。读不到、认不出就抛。 */
  standardPaths?: () => Promise<StandardPath[]>;
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
async function standardVerdict(meta: LiveMeta, deps: GateDeps): Promise<Verdict> {
  const notChecked = (why: string): Verdict => ({ ok: false, notChecked: true, lines: [`没查成：${why}。`] });
  let list: StandardPath[];
  try {
    list = await (deps.standardPaths ?? loadStandardPaths)();
  } catch (e) {
    return notChecked(`改标准的路径清单读不到（${message(e)}）`);
  }
  let raw: unknown[];
  try {
    raw = await deps.gh.files(meta.number);
  } catch (e) {
    return notChecked(`读不到 PR #${meta.number} 改了哪些文件（${message(e)}），判不了碰没碰改标准`);
  }
  const files: ChangedFile[] = [];
  for (const [i, item] of raw.entries()) {
    const f = changedFileOf(item, i);
    if (typeof f === 'string') return notChecked(`PR #${meta.number} 的文件列表认不出：${f}`);
    files.push(f);
  }
  const hits = standardFiles(files, list);
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

/** 合前一次冷调用（#555-2）这一样：强制 CI 的引擎任务 PR（分支名认）当前头上要有通过的 cold-verify。 */
async function coldVerdict(meta: LiveMeta, deps: GateDeps): Promise<Verdict> {
  // 只跳过本轮已经核实的 off；缺模式仍 force。
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

async function managedVerdict(meta: LiveMeta, deps: GateDeps): Promise<Verdict> {
  if (!/^local\/\d+-/.test(meta.headRef)) return { ok: true, notChecked: false, lines: [] };
  if (!deps.readFeedback) return { ok: false, notChecked: true, lines: ['本机退回 reader 未装配。'] };
  try {
    const { records } = await deps.readFeedback(meta.number, meta.head);
    const open = records.filter((r) => !r.resolved);
    return {
      ok: open.length === 0,
      notChecked: false,
      lines: open.length ? [`本机审查有 ${open.length} 条未解决退回；消费确认不等于解决。`] : [],
    };
  } catch (e) {
    return { ok: false, notChecked: true, lines: [`本机退回没查成（${message(e)}）。`] };
  }
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
  let raw: unknown;
  try {
    raw = await gh.pr(number);
    meta = metaOf(raw);
  } catch (e) {
    return broken(`读不到 PR #${number} 现在的样子（${message(e)}）`);
  }
  if (typeof meta === 'string') return broken(`PR #${number} 读回来认不出：${meta}`);
  if (meta.number !== number)
    return { ...broken(`要的是 PR #${number}，读回来的是 #${meta.number}`), head: meta.head };
  if (!meta.open)
    return { number, head: meta.head, closed: true, state: 'failure', notChecked: false, lines: [] };

  let policy = deps.ciPolicy ?? 'force';
  let repo: PolicyRepo | undefined;
  try {
    if (deps.readCiPolicy) {
      repo = prRepo(raw);
      const read = await deps.readCiPolicy(number, meta.head);
      if (typeof read !== 'string') {
        assertClosed(read, number, meta.head, repo);
        return { number, head: meta.head, closed: true, state: 'failure', notChecked: false, lines: [] };
      }
      policy = read;
    }
  } catch (e) {
    return { ...broken(`CI 策略来源未查成（${message(e)}）`), head: meta.head };
  }
  const verdicts = [
    await coldVerdict(meta, { ...deps, ciPolicy: policy }),
    await standardVerdict(meta, deps),
    await managedVerdict(meta, deps),
  ];
  const ok = verdicts.every((v) => v.ok);
  return {
    number,
    head: meta.head,
    state: ok ? 'success' : 'failure',
    notChecked: verdicts.some((v) => v.notChecked),
    ...(deps.readCiPolicy ? { policy } : {}),
    ...(repo ? { repo } : {}),
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
    case 'pull_request_target':
    case 'pull_request_review': {
      const pr = isObject(ev.pull_request) ? ev.pull_request.number : undefined;
      return typeof pr === 'number' ? [pr] : '事件里没有 pull_request.number';
    }
    case 'status': {
      // 只算这条状态挂着的那个 PR：每个状态事件各起一次计划（plan 不进排队组），不会被后来的事件吞掉。
      // 曾经每条状态都把开着的 PR 全重算，十几个 PR 各写一条，老 PR 的头攒满 GitHub 每个 context 1000 条的上限后再写回 422（#3765）。
      const source = policySourceNumber(ev.context);
      if (source !== null) return [source];
      if (ev.context !== COLD_VERIFY_CONTEXT) {
        if (typeof ev.context === 'string' && ev.context.startsWith(CI_POLICY_SOURCE_PREFIX))
          return 'source status 的 PR 号不是规范正安全整数';
        return [];
      }
      const sha = ev.sha;
      if (typeof sha !== 'string' || sha === '') return '状态事件里没有 sha';
      return numbersOf(await gh.openPrs(), (p) => isObject(p.head) && p.head.sha === sha);
    }
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
export async function eventTargets(
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
  /** Actions matrix 已计划的精确 PR；所有写者必须共用该 PR 的 concurrency。 */
  targetPr?: number;
  /** 状态上「详情」链到的地方（这次运行的页面）。 */
  targetUrl?: string;
  readCiPolicy?: GateDeps['readCiPolicy'];
  readFeedback?: GateDeps['readFeedback'];
}): Promise<RunResult> {
  const witness: StatusWitness = { number: 0, consumed: new Map() };
  return statusWitness.run(witness, async () => {
    const fail = (why: string): RunResult => ({ code: 2, lines: [`没查成：${why}。`] });
    if (opts.targetPr !== undefined && (!Number.isSafeInteger(opts.targetPr) || opts.targetPr < 1))
      return fail('精确 PR 号不是正安全整数');
    const numbers =
      opts.targetPr === undefined
        ? await eventTargets(opts.eventName, opts.eventPath, opts.gh)
        : [opts.targetPr];
    if (typeof numbers === 'string') return fail(numbers);
    if (!opts.write && numbers.length !== 1) return fail('只报不写时一次只算一个 PR（pull_request 事件）');
    if (numbers.length === 0) return { code: 0, lines: ['这次没有要算的 PR。'] };

    let feedback: unknown;
    const readFeedback = opts.readFeedback;
    const deps: GateDeps = {
      gh: opts.gh,
      ...(readFeedback
        ? {
            readFeedback: async (n: number, head: string) => {
              const result = await readFeedback(n, head);
              feedback = result;
              return result;
            },
          }
        : {}),
      ...(opts.readCiPolicy ? { readCiPolicy: opts.readCiPolicy } : {}),
    };
    const lines: string[] = [];
    let code: 0 | 1 | 2 = 0;
    for (const n of numbers) {
      witness.number = n;
      witness.consumed.clear();
      feedback = undefined;
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
      const head = r.head;
      try {
        if (opts.readCiPolicy && r.policy) {
          const policy = await opts.readCiPolicy(n, r.head);
          if (!r.repo) throw new Error('本轮 PR 仓身份未查成');
          if (typeof policy !== 'string') {
            assertClosed(policy, n, r.head, r.repo);
            lines.push(`PR #${n} 已经关了，不发表状态。`);
            continue;
          }
          if (policy !== r.policy) throw new Error('发表前 DB 策略改变，请重算');
          const raw = await opts.gh.pr(n);
          const identity = policyHead(raw, r.repo);
          if (identity.number !== n || identity.head !== r.head)
            throw new Error('发表前 PR 身份或 head 改变，请重算');
          const current = metaOf(raw);
          if (typeof current === 'string') throw new Error(current);
          if (!current.open) {
            lines.push(`PR #${n} 已经关了，不发表状态。`);
            continue;
          }
        }
        const publication = await opts.gh.writeStatus(r.head, {
          state: r.state,
          description: statusDescription(r.lines),
          publication: {
            number: n,
            lines: r.lines,
            notChecked: r.notChecked,
            ...(r.policy ? { policy: r.policy } : {}),
            ...(r.repo ? { repo: r.repo } : {}),
            ...(feedback === undefined ? {} : { feedback }),
          },
          ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}),
        });
        if (publication === 'unchanged')
          lines.push('  本轮现读判定与最新可信状态的完整凭证一致，未追加状态。');
        if (publication === 'closed') lines.push(`PR #${n} 已经关了，不发表状态。`);
      } catch (e) {
        lines.push(`  最终核验或发表失败（${message(e)}）。`);
        // 已知头上撤掉旧结论；不能在来源读取失败时留下本轮准备的 success。
        try {
          const failure = message(e);
          // 兜底的结论是「本轮未核成」，不能把变后的来源签进先前的 success。
          await statusWitness.run({ number: n, consumed: new Map() }, () =>
            opts.gh.writeStatus(head, {
              state: 'failure',
              description: '没查成：发表前策略/head 核验或状态写入失败',
              publication: {
                number: n,
                lines: [failure],
                notChecked: true,
                failure,
                ...(r.repo ? { repo: r.repo } : {}),
              },
              ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}),
            }),
          );
        } catch (writeError) {
          lines.push(`  失败状态也没写上（${message(writeError)}）。`);
        }
        code = 2;
      }
    }
    return { code, lines };
  });
}

function prRepo(raw: unknown): PolicyRepo {
  if (!isObject(raw) || !isObject(raw.base) || !isObject(raw.base.repo))
    throw new Error('PR 的 base 仓身份未查成');
  return policyRepo({ ...raw.base.repo, private: false });
}

function assertClosed(value: ClosedPolicyHead, number: number, head: string, repo: PolicyRepo): void {
  if (
    value.closed !== true ||
    value.number !== number ||
    value.head !== head ||
    value.repo.githubId !== repo.githubId ||
    value.repo.repo.toLowerCase() !== repo.repo.toLowerCase()
  )
    throw new Error('已关闭 PR 的仓身份、单号或 head 不匹配');
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
