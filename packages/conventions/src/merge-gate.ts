// 合并闸（#74）：在 PR 当前头上写提交状态 merge-gate，「按我们的规矩能不能合」只看它一个（design 第五节「流程只为快」）。
// 判红只有：草稿、和主线冲突、改到先审后合的三种路径（删改迁移、部署生产、密钥鉴权含 CI 和卫生检查）而当前头上没有通过的
// second-opinion；读不到、认不出写 failure（没查成），GitHub 还没算完冲突写 pending。必填栏（标签、里程碑、对应计划、specs、
// 档位）只提醒。merge-gate.yml 在 PR 事件、主线推送（逐个重算所有开着的 PR）、second-opinion 状态写上来时跑它；
// pr.yml 的 pr-fields 在主线必过检查换成 merge-gate 之前用同一套判法、只报不写。
// 不检出、不跑 PR 里的代码：判法和清单都用跑这段代码的那一份（主线的）。
import { readFileSync } from 'node:fs';
import type { GhApi } from './gh-api.ts';
import { parseMd } from './markdown.ts';
import {
  type ChangedFile,
  CONFLICT_PROBLEM,
  checkSecondOpinion,
  DRAFT_PROBLEM,
  GATE_CONTEXT,
  MERGEABLE_UNKNOWN,
  parseRiskPaths,
  RISK_PATHS_FILE,
  type RiskPath,
  type RiskyFile,
  riskyFiles,
  SECOND_OPINION_CONTEXT,
  secondOpinionFrom,
  statusDescription,
} from './merge-gates.ts';
import { planPhases } from './plan.ts';
import { checkPrFields, PLAN_DOC, prColumns, prFromEvent, SPECS_COLUMN, specsPaths } from './pr-fields.ts';

export type GateState = 'success' | 'failure' | 'pending';

/** 合并闸要读写的 GitHub 上的东西；读不到、读回来认不出就抛（调用方判「没查成」）。 */
export interface GitHubReads {
  /** PR 现在的样子（GET /pulls/{n}）。 */
  pr(number: number): Promise<unknown>;
  /** PR 改到的文件（读全了才回；条数由调用方和 PR 的 changed_files 对）。 */
  files(number: number): Promise<ChangedFile[]>;
  /** 某个提交上各 context 最新的一条提交状态（翻完页）。 */
  statuses(sha: string): Promise<unknown[]>;
  /** 仓内文件在某个提交上的内容；没有这个文件回 null。 */
  fileAt(path: string, ref: string): Promise<string | null>;
  /** 仓内路径（文件或目录）在某个提交上在不在。 */
  exists(path: string, ref: string): Promise<boolean>;
  /** 开着的 PR（翻完页）。 */
  openPrs(): Promise<unknown[]>;
  /** 和某个提交有关的 PR。 */
  prsForCommit(sha: string): Promise<unknown[]>;
  writeStatus(
    sha: string,
    status: { state: GateState; description: string; targetUrl?: string },
  ): Promise<void>;
}

/** GitHub 的 PR 文件列表一页最多 100 个、总共最多 3000 个。 */
const FILES_PER_PAGE = 100;
const FILES_MAX_PAGES = 30;
const PRS_MAX_PAGES = 20;

const encodePath = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

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
      const all: unknown[] = [];
      for (let page = 1; ; page++) {
        const got = await api.get(`/commits/${sha}/status?per_page=100&page=${page}`);
        if (!isObject(got) || !Array.isArray(got.statuses) || typeof got.total_count !== 'number') {
          throw new Error(`提交 ${sha.slice(0, 7)} 的状态读回来认不出（没有 statuses、total_count）`);
        }
        if (got.sha !== sha) {
          throw new Error(`要的是提交 ${sha.slice(0, 7)} 的状态，读回来的是 ${String(got.sha).slice(0, 7)}`);
        }
        all.push(...got.statuses);
        if (all.length >= got.total_count) return all;
        if (got.statuses.length === 0) {
          throw new Error(`提交 ${sha.slice(0, 7)} 的状态有 ${got.total_count} 条，只读到 ${all.length} 条`);
        }
      }
    },
    async fileAt(path, ref) {
      const got = await api.getOrNull(`/contents/${encodePath(path)}?ref=${ref}`);
      if (got === null) return null;
      if (
        !isObject(got) ||
        got.type !== 'file' ||
        got.encoding !== 'base64' ||
        typeof got.content !== 'string'
      ) {
        throw new Error(`${path} 读回来认不出（不是 base64 的文件内容）`);
      }
      return Buffer.from(got.content, 'base64').toString('utf8');
    },
    async exists(path, ref) {
      return (await api.getOrNull(`/contents/${encodePath(path)}?ref=${ref}`)) !== null;
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
    async prsForCommit(sha) {
      const got = await api.get(`/commits/${sha}/pulls?per_page=100`);
      if (!Array.isArray(got)) throw new Error(`提交 ${sha.slice(0, 7)} 的 PR 列表认不出（不是列表）`);
      return got;
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
  changedFiles: number;
  draft: boolean;
  /** GitHub 还在算是 null。 */
  mergeable: boolean | null;
  mergeCommit: string | null;
  open: boolean;
}

/** 从现读回来的 PR 里取合并闸要的几样；认不出返回一句为什么。 */
export function metaOf(live: unknown): LiveMeta | string {
  if (!isObject(live)) return 'PR 读回来不是对象';
  if (typeof live.number !== 'number') return 'number 认不出';
  const head = isObject(live.head) ? live.head.sha : undefined;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return 'head.sha 认不出';
  const { changed_files: changedFiles, draft, mergeable, merge_commit_sha: mergeCommit, state } = live;
  if (typeof changedFiles !== 'number' || !Number.isInteger(changedFiles) || changedFiles < 0) {
    return 'changed_files 认不出';
  }
  if (typeof draft !== 'boolean') return 'draft 认不出';
  if (mergeable !== null && typeof mergeable !== 'boolean') return 'mergeable 认不出';
  if (mergeCommit !== null && mergeCommit !== undefined && typeof mergeCommit !== 'string') {
    return 'merge_commit_sha 认不出';
  }
  if (state !== 'open' && state !== 'closed') return 'state 认不出';
  return {
    number: live.number,
    head,
    changedFiles,
    draft,
    mergeable,
    mergeCommit: typeof mergeCommit === 'string' ? mergeCommit : null,
    open: state === 'open',
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
  /** 高风险清单：认出来的条目，或认不出的原因。 */
  riskList: RiskPath[] | string;
  sleep?: (ms: number) => Promise<void>;
  /** GitHub 还在算冲突时再读几次、每次隔多久。 */
  mergeablePolls?: number;
  mergeablePollMs?: number;
}

/**
 * 判一个 PR。只读，不写状态。判红只有：草稿、和主线冲突（这两样 GitHub 本来就合不了）、改到先审后合的三种路径
 * 而当前头上没有通过的 second-opinion；读不到、认不出也判红（没查成）。必填栏只提醒。
 */
export async function gatePr(number: number, deps: GateDeps): Promise<GateResult> {
  const { gh } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const broken = (why: string): GateResult => ({
    number,
    head: null,
    state: 'failure',
    notChecked: true,
    lines: [`没查成：${why}。`],
  });
  let live: unknown;
  let meta: LiveMeta | string;
  try {
    live = await gh.pr(number);
    meta = metaOf(live);
    // mergeable 是 GitHub 读的时候才开始算的：第一次多半是 null，隔一会儿再读
    for (let i = 0; typeof meta !== 'string' && meta.open && meta.mergeable === null; i++) {
      if (i >= (deps.mergeablePolls ?? 10)) break;
      await sleep(deps.mergeablePollMs ?? 3000);
      live = await gh.pr(number);
      meta = metaOf(live);
    }
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
  if (meta.draft) problems.push(DRAFT_PROBLEM);
  if (meta.mergeable === false) problems.push(CONFLICT_PROBLEM);

  let hits: RiskyFile[] = [];
  if (typeof deps.riskList === 'string') {
    notChecked.push(`先审后合的路径清单 ${RISK_PATHS_FILE} ${deps.riskList}，没法判改没改到那三种地方`);
  } else {
    try {
      const files = await gh.files(number);
      if (files.length !== meta.changedFiles) {
        notChecked.push(
          `PR #${number} 改了 ${meta.changedFiles} 个文件，只读到 ${files.length} 个（GitHub 的列表最多给 3000 个），没法判改没改到先审后合的地方`,
        );
      } else hits = riskyFiles(files, deps.riskList);
    } catch (e) {
      notChecked.push(`读不到 PR #${number} 改了哪些文件（${message(e)}）`);
    }
  }
  if (hits.length > 0) {
    try {
      const got = secondOpinionFrom(await gh.statuses(meta.head));
      if (typeof got === 'string')
        notChecked.push(`当前头 ${meta.head.slice(0, 7)} 的提交状态认不出：${got}`);
      else problems.push(...checkSecondOpinion(meta.head, got, hits));
    } catch (e) {
      notChecked.push(`读不到当前头 ${meta.head.slice(0, 7)} 的提交状态（${message(e)}）`);
    }
  }
  const notes = (await reminders(live, meta, gh)).map((r) => `提醒：${r}`);

  const base = { number, head: meta.head };
  if (notChecked.length > 0) {
    return {
      ...base,
      state: 'failure',
      notChecked: true,
      lines: [...notChecked.map((w) => `没查成：${w}。`), ...problems, ...notes],
    };
  }
  if (problems.length > 0)
    return { ...base, state: 'failure', notChecked: false, lines: [...problems, ...notes] };
  if (meta.mergeable === null)
    return { ...base, state: 'pending', notChecked: false, lines: [MERGEABLE_UNKNOWN, ...notes] };
  const why =
    hits.length === 0
      ? '没改到先审后合的地方'
      : `改到 ${hits.length} 个先审后合的地方，当前头上第二意见已通过`;
  return {
    ...base,
    state: 'success',
    notChecked: false,
    lines: [`能合：不是草稿、没冲突，${why}。`, ...notes],
  };
}

/**
 * 必填栏（标签、里程碑、对应计划、specs、档位）只提醒、不挡合并（创始人 2026-09-26「流程只为快」）。
 * 这里的任何读不到、认不出都只变成一条提醒，影响不了合并闸的结论——所以 pr-fields.ts 那套判法不在先审后合的清单里。
 */
export async function reminders(live: unknown, meta: LiveMeta, gh: GitHubReads): Promise<string[]> {
  const pr = prFromEvent({ pull_request: live });
  if (typeof pr === 'string') return [`必填栏没查成：${pr}`];
  // plan.md、specs 目录按「合进去之后的样子」查；有冲突、还在算时退回按头查
  const ref = meta.mergeable === true && meta.mergeCommit ? meta.mergeCommit : meta.head;
  const cols = prColumns(pr.body);
  const out: string[] = [];
  try {
    const planText = await gh.fileAt(PLAN_DOC, ref);
    const phases = planText === null ? undefined : planPhases(parseMd(PLAN_DOC, planText));
    if (!phases) out.push(`必填栏没查成：这个 PR 里读不到 ${PLAN_DOC}`);
    else if (phases.size === 0) out.push(`必填栏没查成：${PLAN_DOC} 里一个阶段（### P0 …）也没认出来`);
    else {
      const there = new Map<string, boolean>();
      for (const p of specsPaths(cols.get(SPECS_COLUMN) ?? '')) {
        const rel = p.replace(/\/+$/, '');
        if (!rel.split('/').includes('..') && !there.has(rel)) there.set(rel, await gh.exists(rel, ref));
      }
      out.push(...checkPrFields(pr, { phases, exists: (rel) => there.get(rel) ?? false }));
    }
  } catch (e) {
    out.push(`必填栏没查成：读不到这个 PR 里的 ${PLAN_DOC} 或 specs 目录（${message(e)}）`);
  }
  return out;
}

export interface RunResult {
  /**
   * 写状态时：0 = 每个 PR 都写上了（写的是通过还是不通过都算）；2 = 有没写上、没算成的。
   * 只报不写时（pr.yml）：0 = 能合；1 = 不能合；2 = 没查成。
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
    case 'push':
      return numbersOf(await gh.openPrs(), () => true);
    case 'status': {
      if (ev.context !== SECOND_OPINION_CONTEXT) return [];
      const sha = ev.sha;
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return '事件里的 sha 认不出';
      return numbersOf(
        await gh.prsForCommit(sha),
        (p) => p.state === 'open' && isObject(p.head) && p.head.sha === sha,
      );
    }
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
  /** true = 把结果写成 merge-gate 状态；false = 只报（pr.yml）。 */
  write: boolean;
  /** 状态上「详情」链到的地方（这次运行的页面）。 */
  targetUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  mergeablePollMs?: number;
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
  const deps: GateDeps = {
    gh: opts.gh,
    riskList,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.mergeablePollMs === undefined ? {} : { mergeablePollMs: opts.mergeablePollMs }),
  };
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
