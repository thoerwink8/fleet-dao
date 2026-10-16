// 本机队列（单 #2731）：pnpm work queue [--json]。本机待办以前散在 6 个地方（里程碑说明、本机做标签、#1055、docs/directives、对话、
// 自动记忆），会话收不收这一轮只看「还有没有东西在跑」、不看「还有没有活」。现在队列＝这条命令的输出：
// 本机做的开着的单，每张写领者、心跳几分钟前、开着的 PR、挂着的引导，以及能不能接（可接 = 没有开着的 PR、没有活着的领者、没贴「要人拍」）。
// 收尾钩子（agents/hooks/queue-stop.mjs）读 --json 的输出判「有活有容量就挡回」。
//
// 读法：
// - 单：gh issue list --label 本机做 --state open（一次最多 200 张，翻不全就报错，不当成只有这些）。
// - 开着的 PR：和 pnpm work claim 同一份认法（pr-claims.ts：需求栏 Closes / Refs、local/<单号>-、fleet/<单号>- 分支）。
// - 领者、心跳：本机会话心跳（~/.fleet-dao/local-sessions/sessions/*.json，agents/local-sessions 写的）里分支是 local/<单号>- 的会话，
//   最后一次动取心跳和会话记录修改时间里晚的那个；LIVE_MINUTES 以内算活着。心跳只写元信息，这里也只读会话号、分支、工作树名、时刻。
// - 挂着的引导：单正文里写到的「引导 <编号>」，在 origin/main 上还是「待处理」的那些（读本地 origin/main，不联网）。
// 读不成的部分记进 problems 照实报（心跳、引导读不成不挡列单；单和 PR 读不成整条命令失败，退出码 1）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DIRECTIVE_REF, type Git, listPending, MAIN } from './directives.ts';
import { issueOfBranch } from './issue-branch.ts';
import type { Gh } from './issue-new.ts';
import { HUMAN_DECISION_LABEL, LOCAL_LABEL } from './labels.ts';
import { type OpenPullRef, prClaimedIssues } from './pr-claims.ts';

/** 心跳这么多分钟以内算领者还活着 */
export const LIVE_MINUTES = 30;
/** 一次列多少张本机做的单；到这个数就算没翻全 */
export const QUEUE_LIMIT = 200;

export interface Claimer {
  /** 会话号（子代理是 <会话>~<编号>）的前 8 位 */
  session: string;
  worktree: string | null;
  branch: string;
  minutesAgo: number;
}

export interface QueueItem {
  issue: number;
  title: string;
  /** 领者：分支是 local/<单号>- 的本机会话，最近动的在前 */
  claimers: Claimer[];
  /** 最近一次心跳几分钟前；没有领者是 null */
  heartbeatMinutes: number | null;
  /** 开着的 PR（挂着这张单的号最小的那个）；没有是 null */
  pr: number | null;
  /** 正文里写到、还没办完的引导编号 */
  directives: string[];
  /** 贴了「要人拍」 */
  waitingHuman: boolean;
  /** 能不能接：没有开着的 PR、没有活着的领者、没贴「要人拍」 */
  takeable: boolean;
}

export interface QueueReport {
  items: QueueItem[];
  /** 没读成的部分（心跳、引导）：照实报，不当成没有 */
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

export interface QueueDeps {
  gh: Gh;
  git: Git;
  /** 本机会话心跳；读不成抛 */
  readBeats: () => BeatLite[];
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

interface IssueRow {
  number: number;
  title: string;
  body: string;
  labels: string[];
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
      'number,title,body,labels',
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
    return { number: i.number, title: i.title, body: typeof i.body === 'string' ? i.body : '', labels };
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

/** 正文里写到的引导编号（去重，按出现先后） */
export function directiveIdsIn(body: string): string[] {
  return [...new Set([...body.matchAll(DIRECTIVE_REF)].map((m) => m[1] ?? '').filter(Boolean))];
}

/** 列队列。单、PR 读不成抛；心跳、引导读不成记进 problems。 */
export async function buildQueue(deps: QueueDeps): Promise<QueueReport> {
  const [issues, pulls] = await Promise.all([localIssues(deps.gh), openPullRefs(deps.gh)]);
  const claimed = prClaimedIssues(pulls);
  const problems: string[] = [];
  const nowMs = deps.now().getTime();

  let beats: BeatLite[] = [];
  try {
    beats = deps.readBeats();
  } catch (e) {
    problems.push(
      `本机会话心跳没读成（领者、心跳这两栏不全）：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let pending: Set<string> | null = null;
  try {
    pending = new Set((await listPending(deps.git, MAIN)).map((d) => d.id));
  } catch (e) {
    problems.push(`挂着的引导没读成（引导这一栏不全）：${e instanceof Error ? e.message : String(e)}`);
  }

  const items = issues
    .sort((a, b) => a.number - b.number)
    .map((i): QueueItem => {
      const claimers = beats
        .filter((b) => b.branch !== null && issueOfBranch(b.branch)?.executor === 'local')
        .filter((b) => issueOfBranch(b.branch ?? '')?.issue === i.number)
        .map((b) => ({
          session: b.id.slice(0, 8),
          worktree: b.worktree,
          branch: b.branch ?? '',
          minutesAgo: Math.max(0, Math.floor((nowMs - b.lastSeenMs) / 60_000)),
        }))
        .sort((a, b) => a.minutesAgo - b.minutesAgo);
      const heartbeatMinutes = claimers[0]?.minutesAgo ?? null;
      const pr = claimed.get(i.number) ?? null;
      const directives = pending === null ? [] : directiveIdsIn(i.body).filter((id) => pending.has(id));
      const waitingHuman = i.labels.includes(HUMAN_DECISION_LABEL);
      const alive = heartbeatMinutes !== null && heartbeatMinutes <= LIVE_MINUTES;
      return {
        issue: i.number,
        title: i.title,
        claimers,
        heartbeatMinutes,
        pr,
        directives,
        waitingHuman,
        takeable: pr === null && !alive && !waitingHuman,
      };
    });
  return { items, problems };
}

/** 一张单一行 */
export function queueLine(i: QueueItem): string {
  const who =
    i.claimers.length === 0
      ? '领者：无'
      : `领者：${i.claimers.map((c) => `${c.session}${c.worktree ? `（${c.worktree}）` : ''}`).join('、')}`;
  const beat = i.heartbeatMinutes === null ? '心跳：无' : `心跳 ${i.heartbeatMinutes} 分钟前`;
  const pr = i.pr === null ? 'PR：无' : `PR #${i.pr}`;
  const dir = i.directives.length === 0 ? '引导：无' : `引导 ${i.directives.join('、')}`;
  const state = i.takeable ? '可接' : i.waitingHuman ? '等人拍' : '在做';
  return `[${state}] #${i.issue} ${i.title} | ${who} | ${beat} | ${pr} | ${dir}`;
}

/** 文字版：一张一行，可接的数在最前，problems 写在最后 */
export function renderQueue(r: QueueReport): string[] {
  const takeable = r.items.filter((i) => i.takeable).length;
  const head = `本机队列：${r.items.length} 张本机做的开着的单，可接 ${takeable} 张（可接 = 没有开着的 PR、没有 ${LIVE_MINUTES} 分钟内的心跳、没贴「${HUMAN_DECISION_LABEL}」）`;
  return [head, ...r.items.map(queueLine), ...r.problems.map((p) => `没查成：${p}`)];
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
