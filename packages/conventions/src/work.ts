// 本机领单（决定 0096）：pnpm work claim|renew|done <单号>。本机会话要做一张单，先在法国的 tasks 登记（executor = local、带 2 小时租约），
// 法国拉单看见就不接；本机会话死了，租约到期法国收回、退回法国队列。判法和租约在 shared 的 local-claims.ts。
//
// claim：先查这张单有没有开着的 PR（「需求」栏挂着、或分支是 fleet/<单号>-、local/<单号>-）→ 有就停下不领；再经 /api/nodes/claims 登记
//        （引擎停下等人的 stalled / parked 后端一步接手，叫停它再登记；引擎还在跑、排队的回 409，停下不领）→ 贴「本机做」→ 打出要用的分支名 local/<单号>-<短名>。
// renew：续租（会话在 local/<单号>- 分支上动着、或开着 PR 挂着这张单，法国自己会顺延，不用手动续；跑超过 2 小时的长测试前续一下）。
// done：无 PR 的运维成功，凭真实验证先 issue:close --note 再记 done；有 PR 合并且单已关会自动收账。
// 未完成的验收责任仍保留，done 不等于结清验收；--failed "原因" 记没做成（还是本机的账，法国不自动接）；--release "原因" 放手，退回法国队列。
// queue [--json]：本机队列（单 #2731）——本机做的开着的单，领者、心跳、开着的 PR、挂着的引导、能不能接（work-queue.ts）。只读，不碰法国。
// run <单号> [--brief 文件] [--worktree 路径] [--again]：脱离聊天进程派一个无头工人（单 #2761，work-run.ts 开头有全貌）——先过本机容量，
//        本机没租约才领单，建或复用工作树，经 detach.mjs 起看护进程；看护进程没了再跑一次就接着同一个会话续。
//        交付停在 waiting 时再跑只起看护进程复核，不领单、不新开工人；已由其他真实 PR 交付而 stopped 的不再派。runs：列 run 派过的工人。
//
// 改这里之前必须知道：
// - 写法国只用本机会话心跳同一个通行证（~/.fleet-dao/local-sessions/config.json 的 url、token，pnpm local-sessions install 写的），
//   本机不放机器人凭据。读不到配置、法国不回，照实报「没登记上」、退出码 1，不当成领到了。
// - 通行证只放进请求头，不打印。
// 退出码：0 成了；1 没成（原因打在 stderr）。
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Git } from './directives.ts';
import { localBranchPrefix } from './issue-branch.ts';
import type { Gh } from './issue-new.ts';
import { LOCAL_LABEL } from './labels.ts';
import { managedWork, validateManagedDelivery } from './managed-work.ts';
import { type OpenPullRef, otherPrOnIssue } from './pr-claims.ts';
import { buildQueue, type LeaseRecord, type QueueDeps, readCurrentRepo, renderQueue } from './work-queue.ts';
import {
  defaultBrief,
  listRuns,
  PASS_ENV,
  prepareRunDir,
  RUN_SCHEMA,
  type RunResult,
  type RunSpec,
  type RunStatus,
  readJson,
  renderRuns,
  runDir,
  runFiles,
  runPhase,
  runsRoot,
  writeJson,
} from './work-run.ts';

/** 和 agents/local-sessions/lib.mjs 的 TOKEN_HEADER 同一个头。 */
const TOKEN_HEADER = 'X-Fleet-Node-Token';
const POST_TIMEOUT_MS = 20_000;
/** 法国收本机领单的路径：shared 的 WEB_API_PREFIX + LOCAL_CLAIMS_PATH（这里是零安装区，引不了包，test/work.test.ts 钉着两边一致）。 */
export const CLAIMS_URL_PATH = '/api/nodes/claims';

/** 发给法国的那一条：形状和 shared 的 LocalClaimRequestSchema 一致（法国按它 strict 收，多一个字段 400）。 */
export type LocalClaimRequest =
  | { action: 'claim'; repo: string; issue: number; title: string }
  | { action: 'renew'; repo: string; issue: number }
  | {
      action: 'finish';
      repo: string;
      issue: number;
      outcome: 'done' | 'failed' | 'released';
      reason?: string;
    };

export const WORK_USAGE =
  '用法：pnpm work claim <单号> | pnpm work renew <单号> | pnpm work done <单号> [--failed "原因" | --release "原因"] | pnpm work queue [--json]' +
  ' | pnpm work run <单号> [--brief <交代文件>] [--worktree <工作树>] [--again] | pnpm work runs';

export interface ClaimsEndpoint {
  url: string;
  token: string;
}

/** 本机会话心跳的配置（pnpm local-sessions install 写的）里的法国地址和通行证。读不到、认不出抛错，写明怎么补。 */
export function readClaimsEndpoint(home = homedir()): ClaimsEndpoint {
  const path = join(home, '.fleet-dao', 'local-sessions', 'config.json');
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(
      `读不到 ${path}（${e instanceof Error ? e.message : String(e)}）：先装本机会话上报 pnpm local-sessions install --url <法国地址>`,
    );
  }
  const c = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  if (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) throw new Error(`${path} 里 url 不对`);
  if (typeof c.token !== 'string' || c.token === '') throw new Error(`${path} 里没有 token`);
  return { url: c.url, token: c.token };
}

export type ClaimsPost = (body: LocalClaimRequest) => Promise<{ status: number; text: string }>;

/** 真发：POST <法国地址>/api/nodes/claims，通行证放请求头。 */
export function liveClaimsPost(endpoint: () => ClaimsEndpoint, fetchImpl: typeof fetch = fetch): ClaimsPost {
  return async (body) => {
    const { url, token } = endpoint();
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}${CLAIMS_URL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text() };
  };
}

export interface WorkDeps {
  gh: Gh;
  post: ClaimsPost;
  out: (line: string) => void;
  err: (line: string) => void;
  /** pnpm work queue 要的另外几样（git、心跳、租约、时钟）；不给 queue 就报没接上 */
  queue?: Omit<QueueDeps, 'gh'>;
  /**
   * 本机记下领单租约（work-queue.ts 的 writeLease / removeLease）：法国的租约本机读不到，claim / renew 成了记一份、done 删掉，
   * 队列靠它认「在做」。不给就不记（测试）；记不成只提示，不算领单没成。
   */
  leases?: {
    write: (rec: LeaseRecord) => void;
    remove: (repo: string, issue: number) => void;
  };
  /**
   * 识仓用的环境和检出根。入口传 process.env 和仓根，claim / renew / queue 才用同一份规则
   * （显式 GH_REPO、GITHUB_REPOSITORY、github origin）。不传 env 就用进程环境；没有 root 时只认 GH_REPO。
   */
  env?: NodeJS.ProcessEnv;
  root?: string;
  /** pnpm work run / runs 要的（work-run.ts）：容量、起脱离的进程、git、环境。不给就报没接上 */
  run?: {
    /** agents/hooks/capacity.mjs 的读数和判法：enough 是 null 表示没查成 */
    capacity: () => Promise<{ enough: boolean | null; text: string }>;
    /** agents/local-sessions/detach.mjs 的 spawnDetached */
    spawnDetached: (
      file: string,
      args: string[],
      opts: { cwd?: string },
    ) => { ok: true; pid: number; how: string } | { ok: false; why: string };
    git: Git;
    env: NodeJS.ProcessEnv;
    /** 入口动态加载 unattended.mjs 的同一身份选择契约，不在零安装区复制优先级。 */
    selectSessionId: (
      env: NodeJS.ProcessEnv,
    ) => { ok: true; id: string } | { ok: false; missing: boolean; why: string };
    now: () => Date;
    runsRoot: string;
    /** 跑这条命令的检出 */
    repoRoot: string;
    node: string;
    /** 看护进程的入口（bin/work-supervisor.ts） */
    supervisor: string;
    findReclaude: () => string | null;
    /** 本机记着这张单没到期的租约 */
    hasLease: (repo: string, issue: number) => boolean;
    exists: (path: string) => boolean;
    readText: (path: string) => string;
  };
}

/** 记租约：没接上不记；记不成提示一句，不把领单算失败 */
function noteLease(deps: WorkDeps, fn: (l: NonNullable<WorkDeps['leases']>) => void): void {
  if (!deps.leases) return;
  try {
    fn(deps.leases);
  } catch (e) {
    deps.err(
      `提示：法国那边登记成了，本机租约记录没写成（${e instanceof Error ? e.message : String(e)}）；pnpm work queue 可能把这张当成可接`,
    );
  }
}

/** pnpm work queue [--json]：退出码 0 列出来了（没查成的部分写在 problems / 末尾），1 单或 PR 没读成 */
async function queueCmd(rest: readonly string[], deps: WorkDeps): Promise<number> {
  const json = rest.includes('--json');
  const extra = rest.filter((a) => a !== '--json');
  if (extra.length > 0) throw new Error(`认不出的参数：${extra.join(' ')}。${WORK_USAGE}`);
  if (!deps.queue) throw new Error('pnpm work queue 没接上读 git、心跳的那几样（入口的 bug）');
  const env = deps.queue.env ?? deps.env;
  const root = deps.queue.root ?? deps.root;
  const report = await buildQueue({
    gh: deps.gh,
    ...deps.queue,
    ...(env !== undefined ? { env } : {}),
    ...(root !== undefined ? { root } : {}),
  });
  if (json) deps.out(JSON.stringify(report));
  else for (const line of renderQueue(report)) deps.out(line);
  return 0;
}

interface Parsed {
  action: 'claim' | 'renew' | 'done';
  issue: number;
  failed?: string;
  release?: string;
}

function parse(argv: readonly string[]): Parsed {
  const [action, n, ...rest] = argv;
  if (action !== 'claim' && action !== 'renew' && action !== 'done') throw new Error(WORK_USAGE);
  const issue = Number(n);
  if (!Number.isSafeInteger(issue) || issue <= 0)
    throw new Error(`单号要是正整数：${n ?? '（没给）'}。${WORK_USAGE}`);
  const out: Parsed = { action, issue };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (
      (flag === '--failed' || flag === '--release') &&
      action === 'done' &&
      value &&
      !value.startsWith('--')
    ) {
      if (flag === '--failed') out.failed = value;
      else out.release = value;
      i += 1;
      continue;
    }
    throw new Error(`认不出的参数：${flag}。${WORK_USAGE}`);
  }
  if (out.failed !== undefined && out.release !== undefined)
    throw new Error('--failed 和 --release 只能给一个');
  return out;
}

async function ghJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const r = await gh(args);
  if (r.code !== 0) throw new Error(`${what}没读成（gh 退出码 ${r.code}）：${(r.stderr || r.stdout).trim()}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${what}：gh 回的不是 JSON`);
  }
}

/** 这个仓的 owner/name。queue、claim、renew、run 都走 readCurrentRepo，不另写一套。 */
function currentRepo(deps: WorkDeps): Promise<string> {
  return readCurrentRepo(deps.gh, {
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.root !== undefined ? { root: deps.root } : {}),
  });
}

/** 这个仓开着的 PR（号、正文、分支）。翻不全就抛：不当成没有。 */
export async function openPulls(gh: Gh): Promise<OpenPullRef[]> {
  const v = await ghJson(
    gh,
    ['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body,headRefName'],
    '开着的 PR',
  );
  if (!Array.isArray(v)) throw new Error('开着的 PR：gh 回的不是列表');
  if (v.length >= 500) throw new Error('开着的 PR 有 500 个以上，没翻全，不判');
  return v.map((p: { number?: unknown; body?: unknown; headRefName?: unknown }) => {
    if (typeof p.number !== 'number' || typeof p.headRefName !== 'string')
      throw new Error('开着的 PR 认不出');
    return { number: p.number, body: typeof p.body === 'string' ? p.body : '', headRef: p.headRefName };
  });
}

/** 分支名里的短名：标题里的字母数字，最多 30 个字符；一个都没有就用 work。 */
export function branchSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return s || 'work';
}

async function send(
  deps: WorkDeps,
  body: LocalClaimRequest,
): Promise<{ ok: true; leaseUntil: string | null }> {
  let res: { status: number; text: string };
  try {
    res = await deps.post(body);
  } catch (e) {
    throw new Error(`没登记上：法国没回（${e instanceof Error ? e.message : String(e)}）`);
  }
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new Error(`没登记上：法国回 ${res.status}，内容认不出：${res.text.slice(0, 200)}`);
  }
  if (res.status >= 200 && res.status < 300) {
    const r = (typeof json === 'object' && json !== null ? json : {}) as {
      ok?: unknown;
      leaseUntil?: unknown;
    };
    if (r.ok !== true || (r.leaseUntil !== null && typeof r.leaseUntil !== 'string')) {
      throw new Error(`没登记上：法国回 ${res.status}，内容认不出`);
    }
    return { ok: true, leaseUntil: r.leaseUntil };
  }
  const why = (json as { error?: { message?: unknown } })?.error?.message;
  const hint =
    res.status === 409 && body.action === 'claim'
      ? '\n（引擎已经停下等人的单 claim 会自己接手；这张是引擎还在跑或排着的，等它停下再领，或在驾驶舱叫停它；不要不登记就开 PR）'
      : '';
  throw new Error(
    `没登记上：法国回 ${res.status}：${typeof why === 'string' ? why : res.text.slice(0, 200)}${hint}`,
  );
}

/** 单的标题：认不出就用 #单号；不是开着的单抛 */
function issueTitle(issue: number, v: { title?: unknown; state?: unknown }): string {
  if (v.state !== 'OPEN') throw new Error(`#${issue} 不是开着的单（${String(v.state)}），不领`);
  return typeof v.title === 'string' && v.title.trim() ? v.title.trim() : `#${issue}`;
}

/** 领单（claim 和 run 共用）：有开着的 PR 不领 → 法国登记 → 本机记租约 → 贴「本机做」 */
async function claimIssue(
  deps: WorkDeps,
  repo: string,
  issue: number,
  title: string,
): Promise<{ leaseUntil: string | null }> {
  const other = otherPrOnIssue(await openPulls(deps.gh), issue, null);
  if (other !== null) {
    throw new Error(`#${issue} 已经有开着的 PR #${other} 在做，不再领、不重复做：先看 #${other}`);
  }
  const got = await send(deps, { action: 'claim', repo, issue, title: title.slice(0, 300) });
  const until = got.leaseUntil;
  if (until !== null) noteLease(deps, (l) => l.write({ repo, issue, leaseUntil: until }));
  const label = await deps.gh(['issue', 'edit', String(issue), '--add-label', LOCAL_LABEL]);
  if (label.code !== 0) {
    deps.err(
      `提示：登记上了，可「${LOCAL_LABEL}」没贴上（${(label.stderr || label.stdout).trim()}）；法国照样不接（看的是登记），手动补贴即可`,
    );
  }
  return got;
}

interface RunArgs {
  issue: number;
  brief?: string;
  worktree?: string;
  again: boolean;
}

function parseRun(rest: readonly string[]): RunArgs {
  const [n, ...flags] = rest;
  const issue = Number(n);
  if (!Number.isSafeInteger(issue) || issue <= 0)
    throw new Error(`单号要是正整数：${n ?? '（没给）'}。${WORK_USAGE}`);
  const out: RunArgs = { issue, again: false };
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (flag === '--again') {
      out.again = true;
      continue;
    }
    if ((flag === '--brief' || flag === '--worktree') && value && !value.startsWith('--')) {
      if (flag === '--brief') out.brief = value;
      else out.worktree = value;
      i += 1;
      continue;
    }
    throw new Error(`认不出的参数：${flag}。${WORK_USAGE}`);
  }
  return out;
}

async function gitOk(git: Git, args: string[], what: string): Promise<string> {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`${what}没成（git ${args.join(' ')}）：${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** 建或复用这张单的工作树；回路径和分支 */
async function ensureWorktree(
  r: NonNullable<WorkDeps['run']>,
  issue: number,
  title: string,
  given: string | undefined,
): Promise<{ worktree: string; branch: string }> {
  const prefix = localBranchPrefix(issue);
  if (given !== undefined) {
    const worktree = resolve(given);
    if (!r.exists(worktree)) throw new Error(`--worktree ${worktree} 不在`);
    const branch = await gitOk(
      r.git,
      ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'],
      '读工作树的分支',
    );
    if (!branch.startsWith(prefix))
      throw new Error(`${worktree} 的分支是 ${branch}，不是 ${prefix}…：本机做单的分支要带单号`);
    return { worktree, branch };
  }
  const common = await gitOk(r.git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], '找主检出');
  const branch = `${prefix}${branchSlug(title)}`;
  const worktree = join(dirname(common), '.claude', 'worktrees', `${issue}-${branchSlug(title)}`);
  if (r.exists(worktree)) return { worktree, branch };
  const has = await r.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (has.code === 0) {
    await gitOk(r.git, ['worktree', 'add', worktree, branch], '建工作树');
  } else {
    await gitOk(r.git, ['fetch', 'origin', 'main'], '拉 origin/main');
    await gitOk(r.git, ['worktree', 'add', worktree, '-b', branch, 'origin/main'], '建工作树');
  }
  return { worktree, branch };
}

/** pnpm work run <单号>：脱离聊天进程派一个无头工人（work-run.ts 开头有全貌） */
async function runCmd(rest: readonly string[], deps: WorkDeps): Promise<number> {
  const a = parseRun(rest);
  const r = deps.run;
  if (!r) throw new Error('pnpm work run 没接上容量、起进程的那几样（入口的 bug）');
  const repo = await currentRepo(deps);
  const dir = runDir(r.runsRoot, repo, a.issue);
  const files = runFiles(dir);
  const phase = runPhase(dir, r.now());
  const status = readJson<RunStatus>(files.state);
  const recorded = readJson<RunResult>(files.result);
  if (
    a.again &&
    (phase === 'waiting' ||
      status?.state === 'waiting' ||
      status?.hold?.kind === 'external' ||
      recorded?.state === 'stopped')
  ) {
    throw new Error(`#${a.issue} 在等待复核或已由其他真实PR交付，不重派工人、不另开运行`);
  }
  if (a.again && phase !== 'none') {
    const old = readJson<RunSpec>(files.spec);
    if (old) await validateManagedDelivery(deps.gh, old, false, r.runsRoot);
  }
  if (phase === 'live') throw new Error(`#${a.issue} 已经有工人在跑（pnpm work runs 看），不再派第二个`);
  if (phase === 'terminal' && !a.again) {
    const done = recorded;
    if (done?.state === 'done') {
      const old = readJson<RunSpec>(files.spec);
      if (old) await validateManagedDelivery(deps.gh, old, true, r.runsRoot);
    }
    if (done?.state === 'stopped') {
      throw new Error(`#${a.issue} 已停，不再派工（${files.result}）。不要 --again 重开工人`);
    }
    const word = done?.state === 'done' ? '做完' : '没做成';
    throw new Error(
      `#${a.issue} 上次派的工人已经${word}（${files.result}）；要重来加 --again（旧记录改名留着）`,
    );
  }
  const cap = await r.capacity();
  if (cap.enough !== true) {
    throw new Error(
      cap.enough === null ? `${cap.text}——没查成不当成够，不派` : `${cap.text}——等一个工人收口再派`,
    );
  }
  const resume = (phase === 'lost' || phase === 'waiting') && !a.again;
  // 续跑沿用原 spec，不把另一会话或旧的无归属记录偷偷重绑。
  let dispatcher: string | null = null;
  if (!resume) {
    const session = r.selectSessionId(r.env);
    if (!session.ok && !session.missing) throw new Error(session.why);
    const claude = r.env.CLAUDE_CODE_SESSION_ID;
    const codex = r.env.CODEX_THREAD_ID;
    if (claude && codex && claude !== codex)
      throw new Error('Claude 会话和 Codex thread 身份冲突，不登记另一会话的归属、不派工');
    // CODEX_SESSION_ID 是 root-session，不能据此承诺匹配 Stop 的 thread session_id。
    if (session.ok && (claude || codex)) dispatcher = session.id;
    else
      deps.out(
        '没有可验证的 Claude session / Codex thread 归属（Codex 需真实 CODEX_THREAD_ID，CODEX_SESSION_ID 不代替 thread）；结果仍保留，用 pnpm work runs 手工读取。',
      );
  }
  // 「看护进程没了」叫醒过一次；接着续就要能再叫醒到终态
  if (resume) rmSync(files.reported, { force: true });
  if (!resume) {
    const issue = (await ghJson(
      deps.gh,
      ['issue', 'view', String(a.issue), '--json', 'title,state'],
      `#${a.issue}`,
    )) as {
      title?: unknown;
      state?: unknown;
    };
    const title = issueTitle(a.issue, issue);
    if (r.hasLease(repo, a.issue)) deps.out(`#${a.issue} 本机已经领着（租约没到期），不再领`);
    else {
      const got = await claimIssue(deps, repo, a.issue, title);
      deps.out(`领了 #${a.issue}（租约到 ${got.leaseUntil ?? '？'}）`);
    }
    const reclaude = r.findReclaude();
    if (reclaude === null) throw new Error('PATH 上找不到 reclaude（Claude 一律经 reclaude 起），不派');
    const { worktree, branch } = await ensureWorktree(r, a.issue, title, a.worktree);
    prepareRunDir(dir, r.now(), a.again);
    const extra = a.brief === undefined ? '' : `\n\n## 另外的交代\n\n${r.readText(resolve(a.brief)).trim()}`;
    writeFileSync(files.brief, `${defaultBrief({ issue: a.issue, title, worktree, branch })}${extra}\n`);
    const env: Record<string, string> = {};
    for (const k of PASS_ENV) {
      const v = r.env[k];
      if (typeof v === 'string' && v !== '') env[k] = v;
    }
    const spec: RunSpec = {
      v: RUN_SCHEMA,
      repo,
      issue: a.issue,
      title,
      repoRoot: r.repoRoot,
      worktree,
      branch,
      dispatcher,
      reclaude,
      env,
      createdAt: r.now().toISOString(),
    };
    writeJson(files.spec, spec);
  }
  const started = r.spawnDetached(r.node, [r.supervisor, dir], { cwd: r.repoRoot });
  if (!started.ok) {
    throw new Error(
      `看护进程没起成：${started.why}（记录在 ${dir}，修好再跑一次 pnpm work run ${a.issue} 接着起）`,
    );
  }
  const spec = readJson<RunSpec>(files.spec);
  const how = phase === 'waiting' ? '复核等待，不新开工人' : resume ? '接着上次的会话续' : '派出去了';
  deps.out(
    `${how} #${a.issue}：看护进程 ${started.pid}（${started.how === 'wmi' ? 'WMI 起，' : ''}不在聊天进程的进程树里），工作树 ${spec?.worktree ?? '？'}`,
  );
  deps.out(`状态 ${files.state}；做完写 ${files.result}。${cap.text}`);
  deps.out(
    spec?.dispatcher
      ? '已关联原派工会话：无人值守开启时，同步 Stop 消费一次终态；Codex 不会因后台完成主动开启新轮，Claude 原生 asyncRewake 能力另计。续跑不改变归属。看全部：pnpm work runs'
      : '记录 dispatcher=null：没有会话会被主动叫醒，也不自动补绑旧记录；结果仍保留，用 pnpm work runs 看',
  );
  return 0;
}

export async function work(argv: readonly string[], deps: WorkDeps): Promise<number> {
  try {
    if (['return', 'feedback', 'ack', 'resolve', 'deliver'].includes(argv[0] ?? '')) {
      const repo = await currentRepo(deps);
      return await managedWork(argv[0] ?? '', argv.slice(1), {
        gh: deps.gh,
        repo,
        env: deps.env ?? process.env,
        out: deps.out,
      });
    }
    if (argv[0] === 'queue') return await queueCmd(argv.slice(1), deps);
    if (argv[0] === 'run') return await runCmd(argv.slice(1), deps);
    if (argv[0] === 'runs') {
      if (!deps.run) throw new Error('pnpm work runs 没接上（入口的 bug）');
      for (const line of renderRuns(listRuns(deps.run.runsRoot), deps.run.now())) deps.out(line);
      return 0;
    }
    const p = parse(argv);
    const repo = await currentRepo(deps);
    if (p.action === 'claim') {
      const issue = (await ghJson(
        deps.gh,
        ['issue', 'view', String(p.issue), '--json', 'title,state'],
        `#${p.issue}`,
      )) as {
        title?: unknown;
        state?: unknown;
      };
      const title = issueTitle(p.issue, issue);
      const got = await claimIssue(deps, repo, p.issue, title);
      deps.out(
        `领了 #${p.issue}（租约到 ${got.leaseUntil ?? '？'}）。分支用：${localBranchPrefix(p.issue)}${branchSlug(title)}`,
      );
      deps.out(
        `PR 合并且单已关会自动收账；无 PR 运维成功凭真实验证先 pnpm issue:close ${p.issue} --note "验证结果"，再 pnpm work done ${p.issue}；未完成验收责任保留，不用 done 代替结清。放手 pnpm work done ${p.issue} --release "原因"`,
      );
      return 0;
    }
    if (p.action === 'renew') {
      const got = await send(deps, { action: 'renew', repo, issue: p.issue });
      const until = got.leaseUntil;
      if (until !== null) noteLease(deps, (l) => l.write({ repo, issue: p.issue, leaseUntil: until }));
      deps.out(`续上了 #${p.issue}（租约到 ${got.leaseUntil ?? '？'}）`);
      return 0;
    }
    const outcome = p.failed !== undefined ? 'failed' : p.release !== undefined ? 'released' : 'done';
    const reason = p.failed ?? p.release;
    if (outcome === 'done') {
      const spec = readJson<RunSpec>(runFiles(runDir(runsRoot(deps.env), repo, p.issue)).spec);
      if (spec) await validateManagedDelivery(deps.gh, spec, true, runsRoot(deps.env));
    }
    await send(deps, { action: 'finish', repo, issue: p.issue, outcome, ...(reason ? { reason } : {}) });
    noteLease(deps, (l) => l.remove(repo, p.issue));
    if (outcome === 'released') {
      const label = await deps.gh(['issue', 'edit', String(p.issue), '--remove-label', LOCAL_LABEL]);
      if (label.code !== 0) {
        deps.err(
          `提示：放手登记上了，可「${LOCAL_LABEL}」没摘掉（${(label.stderr || label.stdout).trim()}）：不摘法国不接，手动摘`,
        );
        return 1;
      }
    }
    deps.out(
      outcome === 'done'
        ? `#${p.issue} 记做完`
        : outcome === 'failed'
          ? `#${p.issue} 记没做成：${reason}`
          : `#${p.issue} 放手，退回法国队列：${reason}`,
    );
    return 0;
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
