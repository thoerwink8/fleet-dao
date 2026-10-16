// 本机队列（单 #2731）：pnpm work queue [--json]。本机待办以前散在 6 个地方（里程碑说明、本机做标签、#1055、docs/directives、对话、
// 自动记忆），会话收不收这一轮只看「还有没有东西在跑」、不看「还有没有活」。现在队列＝这条命令的输出：
// 本机做的开着的单，每张一个状态（state）和为什么（why），外加领者、心跳、开着的 PR、挂着的引导。
// 收尾钩子（agents/hooks/queue-stop.mjs）读 --json 的 takeable 判「有活有容量就挡回」。
//
// 状态，按这个先后判，先中的算：
// - mother 母单：贴了「母单」或下面挂着子单（GitHub 的 sub-issues）。母单是目录，不直接做。
// - working 在做：有开着的 PR（pr-claims.ts 同一份认法）；或本机 git worktree list 里有分支 local/<单号>- 的工作树
//   （子代理工人不报心跳，这是最可靠的信号）；或本机记下、还没到期的领单租约；或 LIVE_MINUTES 内有分支 local/<单号>- 的会话心跳。
// - blocked 等前置：正文里有一行以「前置：」开头，提到的单号（#N）里还有开着的。前置的状态读不成也算等前置（不当成都关了）。
// - waiting-human 等人拍：贴了「要人拍」。
// - takeable 可接：上面都不是。
//
// 领单租约存在哪：在法国库的 tasks 表（executor = local、lease_until、claimed_by），本机的通行证只能 POST /api/nodes/claims，
// 没有读的口子；pnpm work claim 以前也不在本机留底——所以队列读不到、领过的单都显示「领者：无」。现在 claim / renew 成了就在
// ~/.fleet-dao/local-claims/ 记一份（单号、仓、租约到期），done 删掉；队列只认没到期的。法国自己顺延的租约（会话在动、PR 挂着）
// 本机看不到，那两种情况由工作树、PR 两个信号兜住。改这之前领的单本机没有底，要靠工作树、PR。
// 读不成的部分记进 problems 照实报；单和 PR 读不成整条命令失败，退出码 1。
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DIRECTIVE_REF, type Git, listPending, MAIN } from './directives.ts';
import { issueOfBranch } from './issue-branch.ts';
import type { Gh } from './issue-new.ts';
import { HUMAN_DECISION_LABEL, LOCAL_LABEL, MOTHER_LABEL } from './labels.ts';
import { type OpenPullRef, prClaimedIssues } from './pr-claims.ts';

/** 心跳这么多分钟以内算领者还活着 */
export const LIVE_MINUTES = 30;
/** 一次列多少张本机做的单；到这个数就算没翻全 */
export const QUEUE_LIMIT = 200;

export type QueueState = 'takeable' | 'working' | 'blocked' | 'mother' | 'waiting-human';
export const STATE_WORDS: Record<QueueState, string> = {
  takeable: '可接',
  working: '在做',
  blocked: '等前置',
  mother: '母单',
  'waiting-human': '等人拍',
};

/** 一个「有人在做」的迹象：工作树、租约、会话心跳 */
export type Claimer =
  | { kind: 'worktree'; branch: string; path: string }
  | { kind: 'lease'; until: string }
  | { kind: 'heartbeat'; session: string; worktree: string | null; branch: string; minutesAgo: number };

export interface QueueItem {
  issue: number;
  title: string;
  state: QueueState;
  /** 为什么是这个状态，一句话 */
  why: string;
  /** state === 'takeable' */
  takeable: boolean;
  /** 领者：工作树、没到期的租约、分支是 local/<单号>- 的会话心跳（最近动的在前） */
  claimers: Claimer[];
  /** 最近一次心跳几分钟前；没有心跳是 null */
  heartbeatMinutes: number | null;
  /** 开着的 PR（挂着这张单的号最小的那个）；没有是 null */
  pr: number | null;
  /** 「前置：」里提到、还开着的单（前置状态没读成时是全部提到的） */
  blockedBy: number[];
  /** 正文里写到、还没办完的引导编号 */
  directives: string[];
}

export interface QueueReport {
  items: QueueItem[];
  /** 没读成的部分：照实报，不当成没有 */
  problems: string[];
}

/** 一份心跳里这里用得到的几项 */
export interface BeatLite {
  id: string;
  branch: string | null;
  worktree: string | null;
  /** 最后一次动（毫秒时刻） */
  lastSeenMs: number;
}

/** 本机记下的一份领单租约 */
export interface LeaseRecord {
  repo: string;
  issue: number;
  /** ISO 时刻 */
  leaseUntil: string;
}

export interface QueueDeps {
  gh: Gh;
  git: Git;
  /** 本机会话心跳；读不成抛 */
  readBeats: () => BeatLite[];
  /** 本机记下的领单租约；读不成抛 */
  readLeases: () => LeaseRecord[];
  now: () => Date;
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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface IssueRow {
  number: number;
  title: string;
  body: string;
  labels: string[];
  subIssues: number;
}

async function localIssues(gh: Gh): Promise<IssueRow[]> {
  const v = await ghJson(
    gh,
    [
      'issue',
      'list',
      '--label',
      LOCAL_LABEL,
      '--state',
      'open',
      '--limit',
      String(QUEUE_LIMIT),
      '--json',
      'number,title,body,labels,subIssuesSummary',
    ],
    '本机做的单',
  );
  if (!Array.isArray(v)) throw new Error('本机做的单：gh 回的不是列表');
  if (v.length >= QUEUE_LIMIT) throw new Error(`本机做的单有 ${QUEUE_LIMIT} 张以上，没翻全，不列`);
  return v.map((raw: unknown) => {
    const i = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof i.number !== 'number' || typeof i.title !== 'string') throw new Error('本机做的单认不出');
    const labels = Array.isArray(i.labels)
      ? i.labels.map((l: unknown) =>
          typeof l === 'object' && l !== null ? String((l as { name?: unknown }).name ?? '') : '',
        )
      : [];
    const total = (i.subIssuesSummary as { total?: unknown } | undefined)?.total;
    return {
      number: i.number,
      title: i.title,
      body: typeof i.body === 'string' ? i.body : '',
      labels,
      subIssues: typeof total === 'number' ? total : 0,
    };
  });
}

async function openPullRefs(gh: Gh): Promise<OpenPullRef[]> {
  const v = await ghJson(
    gh,
    ['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,body,headRefName'],
    '开着的 PR',
  );
  if (!Array.isArray(v)) throw new Error('开着的 PR：gh 回的不是列表');
  if (v.length >= 500) throw new Error('开着的 PR 有 500 个以上，没翻全，不判');
  return v.map((raw: unknown) => {
    const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof p.number !== 'number' || typeof p.headRefName !== 'string')
      throw new Error('开着的 PR 认不出');
    return { number: p.number, body: typeof p.body === 'string' ? p.body : '', headRef: p.headRefName };
  });
}

/** 这个仓的 owner/name */
async function repoSlug(gh: Gh): Promise<string> {
  const v = (await ghJson(gh, ['repo', 'view', '--json', 'nameWithOwner'], '当前仓')) as {
    nameWithOwner?: unknown;
  };
  if (typeof v.nameWithOwner !== 'string' || !v.nameWithOwner.includes('/'))
    throw new Error('当前仓认不出（gh repo view 没给 nameWithOwner）');
  return v.nameWithOwner;
}

/** 正文里写到的引导编号（去重，按出现先后） */
export function directiveIdsIn(body: string): string[] {
  return [...new Set([...body.matchAll(DIRECTIVE_REF)].map((m) => m[1] ?? '').filter(Boolean))];
}

/** 正文里以「前置：」开头的那几行提到的单号（去重，按出现先后） */
export function prerequisitesIn(body: string): number[] {
  const out: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!/^\s*前置[：:]/.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) {
      const n = Number(m[1]);
      if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** 一批单号（单或 PR）开没开着：一次 GraphQL 问完。读不成抛。 */
async function openNumbers(gh: Gh, repo: string, numbers: readonly number[]): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  const [owner, name] = repo.split('/');
  const fields = numbers
    .map(
      (n) =>
        `n${n}: issueOrPullRequest(number: ${n}) { ... on Issue { state } ... on PullRequest { state } }`,
    )
    .join(' ');
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
  const v = (await ghJson(gh, ['api', 'graphql', '-f', `query=${query}`], '前置单的状态')) as {
    data?: { repository?: Record<string, { state?: unknown } | null> };
  };
  const repoData = v.data?.repository;
  if (!repoData) throw new Error('前置单的状态：GraphQL 回的认不出');
  const open = new Set<number>();
  for (const n of numbers) {
    const node = repoData[`n${n}`];
    if (node === null || node === undefined) throw new Error(`前置单 #${n} 查不到`);
    if (node.state === 'OPEN') open.add(n);
    else if (node.state !== 'CLOSED' && node.state !== 'MERGED')
      throw new Error(`前置单 #${n} 的状态认不出：${String(node.state)}`);
  }
  return open;
}

/** git worktree list --porcelain 里每棵工作树的路径和分支（不带 refs/heads/） */
export function parseWorktrees(text: string): { path: string; branch: string }[] {
  const out: { path: string; branch: string }[] = [];
  let path = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch refs/heads/') && path)
      out.push({ path, branch: line.slice('branch refs/heads/'.length).trim() });
  }
  return out;
}

async function localWorktrees(git: Git): Promise<{ path: string; branch: string }[]> {
  const r = await git(['worktree', 'list', '--porcelain']);
  if (r.code !== 0) throw new Error(`git worktree list 报错：${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return parseWorktrees(r.stdout);
}

/** 列队列。单、PR 读不成抛；别的读不成记进 problems。 */
export async function buildQueue(deps: QueueDeps): Promise<QueueReport> {
  const [issues, pulls] = await Promise.all([localIssues(deps.gh), openPullRefs(deps.gh)]);
  const claimed = prClaimedIssues(pulls);
  const problems: string[] = [];
  const nowMs = deps.now().getTime();

  let beats: BeatLite[] = [];
  try {
    beats = deps.readBeats();
  } catch (e) {
    problems.push(`本机会话心跳没读成（心跳这一栏不全）：${msg(e)}`);
  }
  let worktrees: { path: string; branch: string }[] = [];
  try {
    worktrees = await localWorktrees(deps.git);
  } catch (e) {
    problems.push(`本机工作树没读成（在做的可能被当成可接）：${msg(e)}`);
  }
  let repo: string | null = null;
  try {
    repo = await repoSlug(deps.gh);
  } catch (e) {
    problems.push(`当前仓没认出（租约、前置这两项不全）：${msg(e)}`);
  }
  let leases: LeaseRecord[] = [];
  try {
    leases = deps.readLeases().filter((l) => repo !== null && l.repo.toLowerCase() === repo.toLowerCase());
  } catch (e) {
    problems.push(`本机记下的领单租约没读成（在做的可能被当成可接）：${msg(e)}`);
  }
  let pending: Set<string> | null = null;
  try {
    pending = new Set((await listPending(deps.git, deps.gh, MAIN)).map((d) => d.id));
  } catch (e) {
    problems.push(`挂着的引导没读成（引导这一栏不全）：${msg(e)}`);
  }
  const allPre = [...new Set(issues.flatMap((i) => prerequisitesIn(i.body)))].sort((a, b) => a - b);
  let openPre: Set<number> | null = null;
  try {
    if (repo === null) throw new Error('不知道是哪个仓');
    openPre = await openNumbers(deps.gh, repo, allPre);
  } catch (e) {
    if (allPre.length > 0) problems.push(`前置单的状态没读成（写了前置的一律按等前置算）：${msg(e)}`);
  }

  const items = issues
    .sort((a, b) => a.number - b.number)
    .map((i): QueueItem => {
      const mine = (branch: string) => {
        const o = issueOfBranch(branch);
        return o?.executor === 'local' && o.issue === i.number;
      };
      const heartbeats = beats
        .filter((b) => b.branch !== null && mine(b.branch))
        .map(
          (b): Claimer => ({
            kind: 'heartbeat',
            session: b.id.slice(0, 8),
            worktree: b.worktree,
            branch: b.branch ?? '',
            minutesAgo: Math.max(0, Math.floor((nowMs - b.lastSeenMs) / 60_000)),
          }),
        )
        .sort((a, b) => (a.kind === 'heartbeat' && b.kind === 'heartbeat' ? a.minutesAgo - b.minutesAgo : 0));
      const trees = worktrees
        .filter((w) => mine(w.branch))
        .map((w): Claimer => ({ kind: 'worktree', branch: w.branch, path: w.path }));
      const lease = leases
        .filter((l) => l.issue === i.number && Date.parse(l.leaseUntil) > nowMs)
        .map((l): Claimer => ({ kind: 'lease', until: l.leaseUntil }));
      const claimers = [...trees, ...lease, ...heartbeats];
      const first = heartbeats[0];
      const heartbeatMinutes = first?.kind === 'heartbeat' ? first.minutesAgo : null;
      const pr = claimed.get(i.number) ?? null;
      const pre = prerequisitesIn(i.body);
      const blockedBy = openPre === null ? pre : pre.filter((n) => openPre.has(n));
      const directives = pending === null ? [] : directiveIdsIn(i.body).filter((id) => pending.has(id));
      const alive = heartbeatMinutes !== null && heartbeatMinutes <= LIVE_MINUTES;

      let state: QueueState;
      let why: string;
      if (i.labels.includes(MOTHER_LABEL) || i.subIssues > 0) {
        state = 'mother';
        why =
          i.subIssues > 0
            ? `母单：下面挂着 ${i.subIssues} 张子单，做子单`
            : `母单：贴了「${MOTHER_LABEL}」，做子单`;
      } else if (pr !== null || trees.length > 0 || lease.length > 0 || alive) {
        state = 'working';
        const how: string[] = [];
        if (pr !== null) how.push(`PR #${pr} 开着`);
        for (const t of trees) if (t.kind === 'worktree') how.push(`工作树 ${t.branch}`);
        for (const l of lease) if (l.kind === 'lease') how.push(`租约到 ${l.until}`);
        if (alive) how.push(`心跳 ${heartbeatMinutes} 分钟前`);
        why = `在做：${how.join('、')}`;
      } else if (blockedBy.length > 0) {
        state = 'blocked';
        why =
          openPre === null
            ? `等前置 ${blockedBy.map((n) => `#${n}`).join('、')}（前置状态没查成，按没关算）`
            : `等前置 ${blockedBy.map((n) => `#${n}`).join('、')}（还开着）`;
      } else if (i.labels.includes(HUMAN_DECISION_LABEL)) {
        state = 'waiting-human';
        why = `等人拍：贴了「${HUMAN_DECISION_LABEL}」`;
      } else {
        state = 'takeable';
        why = '可接：没有 PR、工作树、租约、活着的心跳，没有没关的前置';
      }
      return {
        issue: i.number,
        title: i.title,
        state,
        why,
        takeable: state === 'takeable',
        claimers,
        heartbeatMinutes,
        pr,
        blockedBy,
        directives,
      };
    });
  return { items, problems };
}

function claimerText(c: Claimer): string {
  if (c.kind === 'worktree') return `工作树 ${c.branch}`;
  if (c.kind === 'lease') return `租约到 ${c.until}`;
  return `会话 ${c.session}${c.worktree ? `（${c.worktree}）` : ''}`;
}

/** 一张单一行 */
export function queueLine(i: QueueItem): string {
  const who = i.claimers.length === 0 ? '领者：无' : `领者：${i.claimers.map(claimerText).join('、')}`;
  const beat = i.heartbeatMinutes === null ? '心跳：无' : `心跳 ${i.heartbeatMinutes} 分钟前`;
  const pr = i.pr === null ? 'PR：无' : `PR #${i.pr}`;
  const dir = i.directives.length === 0 ? '引导：无' : `引导 ${i.directives.join('、')}`;
  const tag =
    i.state === 'blocked'
      ? `${STATE_WORDS.blocked} ${i.blockedBy.map((n) => `#${n}`).join('、')}`
      : STATE_WORDS[i.state];
  return `[${tag}] #${i.issue} ${i.title} | ${i.why} | ${who} | ${beat} | ${pr} | ${dir}`;
}

/** 文字版：头一行写各状态的数，一张一行，problems 写在最后 */
export function renderQueue(r: QueueReport): string[] {
  const count = (s: QueueState) => r.items.filter((i) => i.state === s).length;
  const parts = (Object.keys(STATE_WORDS) as QueueState[]).map((s) => `${STATE_WORDS[s]} ${count(s)}`);
  const head = `本机队列：${r.items.length} 张本机做的开着的单，${parts.join('、')}`;
  return [head, ...r.items.map(queueLine), ...r.problems.map((p) => `没查成：${p}`)];
}

// —— 本机记下的领单租约 ——

/** ~/.fleet-dao/local-claims */
export const leaseDir = (home = homedir()) => join(home, '.fleet-dao', 'local-claims');
const leaseFile = (dir: string, repo: string, issue: number) =>
  join(dir, `${repo.replace(/[^\w.-]/g, '_')}_${issue}.json`);

/** claim / renew 成了：记下（覆盖）这张单的租约 */
export function writeLease(rec: LeaseRecord, dir = leaseDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(leaseFile(dir, rec.repo, rec.issue), `${JSON.stringify(rec)}\n`);
}

/** done（做完、没做成、放手）：删掉这张单的租约 */
export function removeLease(repo: string, issue: number, dir = leaseDir()): void {
  rmSync(leaseFile(dir, repo, issue), { force: true });
}

/** 读全部租约；目录不在是空，坏文件跳过 */
export function readLeases(dir = leaseDir()): LeaseRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return [];
    throw e;
  }
  const out: LeaseRecord[] = [];
  for (const n of names) {
    try {
      const v = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Partial<LeaseRecord>;
      if (
        typeof v.repo === 'string' &&
        typeof v.issue === 'number' &&
        typeof v.leaseUntil === 'string' &&
        !Number.isNaN(Date.parse(v.leaseUntil))
      )
        out.push({ repo: v.repo, issue: v.issue, leaseUntil: v.leaseUntil });
    } catch {
      // 坏的跳过
    }
  }
  return out;
}

/** 读本机会话心跳（~/.fleet-dao/local-sessions/sessions/*.json）：最后一次动取心跳时刻和会话记录修改时间里晚的那个。目录不在是空。 */
export function readLocalBeats(
  home = homedir(),
  claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
): BeatLite[] {
  const dir = join(home, '.fleet-dao', 'local-sessions', 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return [];
    throw e;
  }
  const projects = join(claudeDir, 'projects');
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projects, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    projectDirs = [];
  }
  const out: BeatLite[] = [];
  for (const n of names) {
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(join(dir, n), 'utf8'));
    } catch {
      continue; // 写到一半的、坏的：推送那一头会报，这里不重复
    }
    const b = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    if (typeof b.id !== 'string' || typeof b.lastSeenAt !== 'string') continue;
    const seen = Date.parse(b.lastSeenAt);
    if (Number.isNaN(seen)) continue;
    const [session, agent] = b.id.split('~');
    const rel =
      agent === undefined ? `${session}.jsonl` : join(session ?? '', 'subagents', `agent-${agent}.jsonl`);
    let last = seen;
    if (session && /^[\w.-]+$/.test(session) && (agent === undefined || /^[\w.-]+$/.test(agent))) {
      for (const d of projectDirs) {
        try {
          last = Math.max(last, statSync(join(projects, d, rel)).mtimeMs);
          break;
        } catch {
          // 不在这个目录
        }
      }
    }
    out.push({
      id: b.id,
      branch: typeof b.branch === 'string' ? b.branch : null,
      worktree: typeof b.worktree === 'string' ? b.worktree : null,
      lastSeenMs: last,
    });
  }
  return out;
}
