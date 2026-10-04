// 分支体检（#769，方案 specs/769-分支体检/方案.md）：每天一轮（.github/workflows/github-audit.yml 的 branches），
// 本机也能手跑 pnpm branch:hygiene。判远端每条分支「删 / 留 / 等人定」，写明理由：
//   结构上不能碰的（默认分支、受保护、开着的 PR 的头或目标分支）→ 留；巡检单上人勾了删 / 留（勾的就是现在的头）→ 照勾的办；
//   开着的单或 PR 提到 → 留；有已合并 PR、头就是合并时的 PR 头 → 删（决定 0009）；
//   其余看有没有产出（branch-git.ts）：没产出、满 14 天没动静 → 删（不满 → 留）；有产出、满 3 天没动静 → 列到巡检单上等人勾
//   （不满 → 留：还在做）。
// 改这里之前必须知道：
// - 删数据是人闸：机器不经人只删「内容全在主线（或已合并 PR）里」的分支。有产出的，人在巡检单上勾了「删」、勾的那个头
//   就是现在的头才删；判完到删之间头变了也不删（删之前再读一次）。
// - 读不到、认不出一律「没查成」：整份清单（分支、PR、开着的单）读不到这一轮一条不判、一条不删；一条分支的内容或动态读不到，
//   这一条判「没查成」、不删，别的照判。不拿空冒充「没有」。每条路径在 test/branch-hygiene.test.ts 里有故意造出的失败。
// - 巡检单正文是人和机器的共用状态（勾选框）：只有带记号的那几行算数，正文每轮按这一轮的判决重写，人勾过的照抄过去。
//   只认仓里的人或 Actions 开的那张（trustedBoard）：公开仓谁都能开一张带记号、勾好删的单。
import { type ContentFacts, type FactsReader, type GitExec, gitFacts, type MainIndex } from './branch-git.ts';
import { FLOW_BRANCH_PATTERN } from './flow-branch.ts';
import type {
  BranchActivity,
  GitHubBranches,
  GitHubCommenter,
  GitHubReader,
  OpenThread,
  PullHead,
  RemoteBranch,
} from './github-api.ts';

/** 没产出的分支满这么多天没动静（最后一次提交、最后一次推送取晚的）才删：删了不丢东西，等这么久只为不打断刚建了分支的人。 */
export const STALE_DAYS = 14;
/**
 * 有产出的分支满这么多天没动静才列给人定：本仓的会话按小时算、至少 20 分钟推一次，几天没动的就是放下了；
 * 再短会把还在做的列出来打扰人。
 */
export const ASK_DAYS = 3;
const DAY_MS = 24 * 3_600_000;
/** 分支体检自己写的东西都带这个记号：带它的正文、评论不算「提到」这条分支（那是机器列的清单，不是有人要用它）。 */
export const MARK = 'fleet:branch-hygiene';
/** 巡检单正文里的记号：带它的那张开着的单就是巡检单。 */
export const BOARD_MARKER = `<!-- ${MARK} board -->`;
export const BOARD_TITLE = '分支体检：有产出的远端分支，等你勾删还是留（机器人维护）';
/** 巡检单贴的类别标签（GitHub 对账要求开着的单恰好一个类别）。 */
export const BOARD_LABELS = ['杂项'];
/** GitHub 单子正文最长 65536 个字，留点余量。 */
const BODY_LIMIT = 60_000;

export type Verdict =
  | { kind: 'keep'; why: string }
  | { kind: 'delete'; why: string; byFounder: boolean }
  | { kind: 'ask'; why: string }
  | { kind: 'unknown'; why: string };

/** 巡检单上人勾的：对哪个头勾的、勾的是删还是留。 */
export interface Decision {
  action: 'delete' | 'keep';
  sha: string;
}

/** 判一条分支要的全部事实（结构那几样由调用方从 PR 和开着的单里算好；内容、动态只有走到要看产出时才读）。 */
export interface BranchCase {
  branch: RemoteBranch;
  isDefault: boolean;
  /** 本仓开着的 PR 里以它为头的。 */
  openHeadPrs: number[];
  /** 开着的 PR 里以它为目标分支的（fork 来的也算）。 */
  openBasePrs: number[];
  /** 已合并、合并时的头就是现在的头的 PR。 */
  mergedExact: number | undefined;
  /** 已合并、但分支后来又动过的 PR。 */
  mergedOther: number[];
  /** 关掉没合的 PR（带它最后的头：和现在的头一样，删了能在 PR 页面恢复）。 */
  closedPrs: { number: number; headSha: string }[];
  /** 提到它的开着的单和 PR。 */
  mentions: { number: number; isPr: boolean }[];
  /** 巡检单上对它的勾选（不管勾的是哪个头；对不上现在的头就不算数）。 */
  decision: Decision | undefined;
  content?: ContentFacts | { error: string } | undefined;
  activity?: BranchActivity[] | { error: string } | undefined;
  /** 分支名里那个号对应的单（只给人定的时候看，不改判决）；只在要列给人定时才读。 */
  linked?: LinkedIssue | undefined;
}

/** 分支名里的号（fleet/292-…、feat/554-3-tier）在 GitHub 上是什么。 */
export type LinkedIssue =
  | { number: number; title: string; state: 'open' | 'closed'; stateReason: string | null; isPr: boolean }
  | { number: number; missing: true }
  | { number: number; error: string };

/** 分支名里像单号的第一个数（前后是 / 或 -；日期和紧跟着日期的那串数字——时刻、序号——不算）；没有回 undefined。 */
export function issueNumberIn(branch: string): number | undefined {
  const m = /(?:^|[/-])(\d{1,6})(?=-|$)/.exec(branch.replace(/\d{4}-\d{2}-\d{2}(?:-\d+)*/g, ''));
  return m?.[1] ? Number(m[1]) : undefined;
}

function linkedStory(l: LinkedIssue | undefined): string {
  if (!l) return '';
  if ('error' in l) return `；名字里的 #${l.number} 没查成（${l.error}）`;
  if ('missing' in l) return `；名字里的 #${l.number} 在 GitHub 上查不到`;
  const what = l.isPr ? 'PR' : '单';
  const state = l.state === 'open' ? '还开着' : l.stateReason === 'not_planned' ? '已关（不做了）' : '已关';
  return `；名字里的 #${l.number} 是${what}「${l.title}」，${state}`;
}

export interface BranchReport {
  name: string;
  sha: string;
  verdict: Verdict;
  /** 谁开的（给人定的时候看，不改判决）。 */
  who: string;
  /** 巡检单上对现在这个头的勾选。 */
  decision: Decision | undefined;
}

const short = (sha: string) => sha.slice(0, 7);
const prList = (ns: readonly number[]) => ns.map((n) => `#${n}`).join('、');

/** 结构上的几条（不用读内容就判得了）；判不了回 undefined，交给 contentVerdict。 */
export function ruleVerdict(c: BranchCase): Verdict | undefined {
  const { branch: b } = c;
  const ticked = c.decision?.sha === b.sha ? c.decision : undefined;
  const blockedDelete =
    ticked?.action === 'delete' ? '（巡检单上勾了删，但删了会把 PR 关掉，没删：真要删先关 PR）' : '';
  if (c.isDefault) return { kind: 'keep', why: '默认分支' };
  if (b.protected) return { kind: 'keep', why: '受保护的分支' };
  if (c.openHeadPrs.length)
    return { kind: 'keep', why: `开着的 PR ${prList(c.openHeadPrs)} 的分支${blockedDelete}` };
  if (c.openBasePrs.length) {
    return { kind: 'keep', why: `开着的 PR ${prList(c.openBasePrs)} 以它为目标分支${blockedDelete}` };
  }
  if (ticked?.action === 'delete') {
    return { kind: 'delete', why: `巡检单上勾了删（勾的就是现在的头 ${short(b.sha)}）`, byFounder: true };
  }
  if (ticked?.action === 'keep') {
    return { kind: 'keep', why: `巡检单上勾了留（头 ${short(b.sha)}），不再问；分支头变了才重新判` };
  }
  if (c.mentions.length) {
    const refs = c.mentions.map((m) => `${m.isPr ? 'PR ' : ''}#${m.number}`).join('、');
    return { kind: 'keep', why: `开着的 ${refs} 提到它` };
  }
  if (c.mergedExact !== undefined) {
    return {
      kind: 'delete',
      why: `有已合并的 PR #${c.mergedExact}，分支头就是合并时的 PR 头：内容全在主线和这个 PR 里（决定 0009）`,
      byFounder: false,
    };
  }
  return undefined;
}

/** 最后动静：分支头的提交时间、动态里最后一次推送（新建、推送、强推），取晚的。 */
export function lastActivity(content: ContentFacts, activity: readonly BranchActivity[]): Date {
  let t = Date.parse(content.headDate);
  for (const a of activity) {
    if (a.type === 'push' || a.type === 'force_push' || a.type === 'branch_creation') {
      t = Math.max(t, Date.parse(a.timestamp));
    }
  }
  return new Date(t);
}

/** 北京时间的「YYYY-MM-DD HH:MM」。 */
export function bj(d: Date): string {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
}

/** PR 那几样（写进理由，给人定的时候看）。 */
function prStory(c: BranchCase): string {
  const parts: string[] = [];
  if (c.mergedOther.length) parts.push(`合并过 ${prList(c.mergedOther)}，之后分支又动过`);
  if (c.closedPrs.length) {
    const restorable = c.closedPrs.find((p) => p.headSha === c.branch.sha);
    parts.push(
      `关掉没合的 PR ${prList(c.closedPrs.map((p) => p.number))}` +
        (restorable ? `（删了能在 #${restorable.number} 页面点 Restore branch 恢复）` : ''),
    );
  }
  return parts.length ? parts.join('；') : '从没开过 PR';
}

/** 要看内容的那几条：没产出满 14 天删；有产出满 3 天等人定；还新的留；读不到没查成。 */
export function contentVerdict(c: BranchCase, now: Date): Verdict {
  const { content, activity } = c;
  if (content === undefined || 'error' in content) {
    return { kind: 'unknown', why: `内容没查成：${content?.error ?? '没读'}` };
  }
  if (activity === undefined || 'error' in activity) {
    return { kind: 'unknown', why: `GitHub 动态没查成：${activity?.error ?? '没读'}` };
  }
  const last = lastActivity(content, activity);
  // 本机钟比 GitHub 慢几秒时会算出负数：按 0 天算（还新）
  const days = Math.max(0, Math.floor((now.getTime() - last.getTime()) / DAY_MS));
  const when = `最后动静 ${bj(last)}（${days} 天前）`;
  const stale = c.decision && c.decision.sha !== c.branch.sha;
  const restale = stale
    ? `；巡检单上勾过${c.decision?.action === 'delete' ? '删' : '留'}，那时的头是 ${short(c.decision?.sha ?? '')}，后来分支又动过，重新判`
    : '';
  const out = content.output;
  if (out.kind === 'none') {
    const what =
      out.changed === 0
        ? '分支比主线多出来的改动是空的'
        : `改到的 ${out.changed} 个文件，这个版本主线历史上都有过`;
    if (days >= STALE_DAYS) {
      return { kind: 'delete', why: `没产出：${what}；${when}${restale}`, byFounder: false };
    }
    return { kind: 'keep', why: `没产出（${what}），但不满 ${STALE_DAYS} 天：${when}${restale}` };
  }
  const produced =
    out.kind === 'unrelated'
      ? '和主线没有共同祖先，判不了有没有产出'
      : `有产出：主线上没有的改动 ${out.files.length} 个文件（${out.files
          .slice(0, 3)
          .map((f) => `\`${f}\``)
          .join('、')}${out.files.length > 3 ? ' 等' : ''}）`;
  const wip = /\bwip\b/i.test(content.headSubject) ? '；最后一次提交写着 WIP，可能是半成品' : '';
  if (days < ASK_DAYS) {
    return { kind: 'keep', why: `还在做（${produced}），不满 ${ASK_DAYS} 天：${when}${restale}` };
  }
  return {
    kind: 'ask',
    why: `${produced}；${prStory(c)}${linkedStory(c.linked)}；${when}；最后一次提交「${content.headSubject}」${wip}${restale}`,
  };
}

export function judge(c: BranchCase, now: Date): Verdict {
  return ruleVerdict(c) ?? contentVerdict(c, now);
}

/** 谁开的：分支名、动态里谁建的、谁推的、提交作者和 Co-Authored-By 里的模型；都认不出写「不知道谁开的」。 */
export function whoOpened(c: BranchCase, owner: string): string {
  const parts: string[] = [];
  const name = c.branch.name;
  if (/^worktree-agent-[0-9a-f]+$/.test(name)) parts.push('本机 Claude Code 子代理的工作树');
  else if (FLOW_BRANCH_PATTERN.test(name)) parts.push('法国引擎（三段任务）');
  else if (/^fleet\/\d+-f[0-9a-f]{8}$/.test(name)) parts.push('法国引擎（Fusion，旧流程）');
  else if (name.startsWith('fleet/')) parts.push('法国引擎');
  const login = (l: string | null) =>
    l === null
      ? '账号已不在'
      : l.endsWith('[bot]')
        ? `机器人 ${l}`
        : l === owner
          ? `仓主的号 ${l}（本机或另一台机器上的会话，分不出哪台）`
          : l;
  if (c.activity && !('error' in c.activity)) {
    const created = c.activity.find((a) => a.type === 'branch_creation');
    const pushed = c.activity.find((a) => a.type === 'push' || a.type === 'force_push');
    if (created) parts.push(`建分支的是${login(created.actor)}`);
    if (pushed && pushed.actor !== created?.actor) parts.push(`最后推的是${login(pushed.actor)}`);
  }
  if (c.content && !('error' in c.content)) {
    if (c.content.authors.length) parts.push(`提交作者 ${c.content.authors.join('、')}`);
    if (c.content.coAuthors.length) parts.push(`会话模型 ${c.content.coAuthors.join('、')}`);
  }
  if (parts.length) return parts.join('；');
  // 结构上就判了的不读动态和提交：说「没看」，不说「不知道」
  return c.content === undefined && c.activity === undefined ? '没看（不用看内容就判了）' : '不知道谁开的';
}

/** 认这条分支名的正则：整段匹配，前后不能紧挨着能出现在分支名里的字（`exp/test` 不算提到了 `exp/test-graph`）。 */
export function mentionPattern(branch: string): RegExp {
  const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${esc}(?![\\w/-]|\\.\\w)`);
}

/** 提到这条分支的开着的单和 PR；巡检单本身、带体检记号的正文和评论不算。 */
export function mentionedBy(
  branch: string,
  threads: readonly OpenThread[],
  boardNumber: number | undefined,
): { number: number; isPr: boolean }[] {
  const pattern = mentionPattern(branch);
  const found: { number: number; isPr: boolean }[] = [];
  for (const t of threads) {
    if (t.number === boardNumber) continue;
    const texts = [t.title, t.body, ...t.comments].filter((x) => !x.includes(MARK));
    if (texts.some((x) => pattern.test(x))) found.push({ number: t.number, isPr: t.isPr });
  }
  return found;
}

const DECISION_LINE = new RegExp(
  `^\\s*[-*+] \\[([ xX])\\] .*<!-- ${MARK} (delete|keep) (\\S+) ([0-9a-f]{40}) -->\\s*$`,
);

/** 读巡检单正文：勾了的（删 / 留）、列过的分支名。同一个头删和留都勾了的不算数，记进 conflicts。 */
export function parseBoard(body: string): {
  decisions: Map<string, Decision>;
  listed: Set<string>;
  conflicts: string[];
} {
  const ticks = new Map<string, Map<string, Set<'delete' | 'keep'>>>();
  const listed = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const m = DECISION_LINE.exec(line);
    if (!m) continue;
    let name: string;
    try {
      name = decodeURIComponent(m[3] ?? '');
    } catch {
      continue;
    }
    const action = m[2] === 'delete' ? 'delete' : 'keep';
    const sha = m[4] ?? '';
    listed.add(name);
    if (m[1] === ' ') continue;
    const bySha = ticks.get(name) ?? new Map<string, Set<'delete' | 'keep'>>();
    bySha.set(sha, (bySha.get(sha) ?? new Set()).add(action));
    ticks.set(name, bySha);
  }
  const decisions = new Map<string, Decision>();
  const conflicts: string[] = [];
  for (const [name, bySha] of ticks) {
    for (const [sha, actions] of bySha) {
      if (actions.size > 1) {
        conflicts.push(name);
        continue;
      }
      const action = [...actions][0];
      if (action) decisions.set(name, { action, sha });
    }
  }
  return { decisions, listed, conflicts };
}

const code = (name: string) => (name.includes('`') ? name : `\`${name}\``);
const box = (ticked: boolean, action: 'delete' | 'keep', name: string, sha: string) =>
  `  - [${ticked ? 'x' : ' '}] ${action === 'delete' ? '删' : '留，不再问'} <!-- ${MARK} ${action} ${encodeURIComponent(name)} ${sha} -->`;

export interface BoardInput {
  reports: readonly BranchReport[];
  deleted: readonly string[];
  failed: readonly { name: string; why: string }[];
  skipped: readonly { name: string; why: string }[];
  conflicts: readonly string[];
  now: Date;
}

/** 巡检单正文（每轮重写；勾过的照抄）。 */
export function renderBoard(input: BoardInput): string {
  const { reports } = input;
  const count = (k: Verdict['kind']) => reports.filter((r) => r.verdict.kind === k).length;
  const asks = reports.filter((r) => r.verdict.kind === 'ask');
  const notDone = reports.filter((r) => r.decision?.action === 'delete' && !input.deleted.includes(r.name));
  const kept = reports.filter((r) => r.decision?.action === 'keep');
  const unknown = reports.filter((r) => r.verdict.kind === 'unknown');
  const deletedRows = reports.filter((r) => input.deleted.includes(r.name));
  const head = [
    BOARD_MARKER,
    '这张单由「分支体检」机器人维护（#769；每天一轮，`.github/workflows/github-audit.yml` 的 branches，判法在 `packages/conventions/src/branch-hygiene.ts`），正文每轮重写，只有勾选框算数。',
    '',
    `**要你定的**：下面每条分支都有主线上没有的改动，满 ${ASK_DAYS} 天没动静，也没有开着的 PR 或单子提到它。勾「删」：下一轮照删（分支头变了就不删、重新列）；勾「留，不再问」：以后不再问（分支头变了才重新判）。想马上执行就在 Actions 里手动跑一次 github-audit。没产出的（改动主线上都有）机器满 ${STALE_DAYS} 天自己删，不列在这里。`,
    '',
    `上次跑：${bj(input.now)}（北京时间）。远端 ${reports.length} 条分支：这一轮删了 ${input.deleted.length}、留着 ${count('keep')}、等你定 ${asks.length}、没查成 ${unknown.length}。`,
  ];
  const lines: string[] = [];
  const section = (title: string, rows: string[]) => {
    if (rows.length) lines.push('', `## ${title}`, '', ...rows);
  };
  const askRows: string[] = [];
  let size = head.join('\n').length;
  let cut = 0;
  for (const r of asks) {
    const row = [
      `- ${code(r.name)}（头 \`${short(r.sha)}\`）：${r.verdict.why}。谁开的：${r.who}。`,
      box(false, 'delete', r.name, r.sha),
      box(false, 'keep', r.name, r.sha),
    ].join('\n');
    if (size + row.length > BODY_LIMIT - 4000) {
      cut++;
      continue;
    }
    size += row.length;
    askRows.push(row);
  }
  if (cut) askRows.push(`- 还有 ${cut} 条正文放不下没列：先定上面的，下一轮补上。`);
  section(`等你定（${asks.length} 条）`, askRows);
  section(
    '勾了删、还没删',
    notDone.map((r) =>
      [
        `- ${code(r.name)}（头 \`${short(r.sha)}\`）：${r.verdict.why}${input.failed.find((f) => f.name === r.name) ? `；这一轮删失败：${input.failed.find((f) => f.name === r.name)?.why}` : ''}${input.skipped.find((s) => s.name === r.name) ? `；${input.skipped.find((s) => s.name === r.name)?.why}` : ''}`,
        box(true, 'delete', r.name, r.sha),
      ].join('\n'),
    ),
  );
  section(
    `定了留着的（${kept.length} 条，分支头变了会重新判）`,
    kept.map((r) =>
      [`- ${code(r.name)}（头 \`${short(r.sha)}\`）`, box(true, 'keep', r.name, r.sha)].join('\n'),
    ),
  );
  section(
    '这一轮删掉的',
    deletedRows.map((r) => `- ${code(r.name)}（头 \`${short(r.sha)}\`）：${r.verdict.why}`),
  );
  section(
    '这一轮没查成的（不删，下一轮再判）',
    unknown.map((r) => `- ${code(r.name)}：${r.verdict.why}`),
  );
  if (input.conflicts.length) {
    section(
      '删和留都勾了、没当真的',
      input.conflicts.map((n) => `- ${code(n)}：只留一个勾，下一轮照办`),
    );
  }
  return [...head, ...lines, ''].join('\n');
}

export interface HygieneDeps {
  gh: GitHubBranches & GitHubCommenter & Pick<GitHubReader, 'issue'>;
  git: GitExec;
  /** owner/名字。 */
  repo: string;
  now: Date;
  /** 内容那几样怎么读（默认 branch-git.ts 的 gitFacts：缺提交先 fetch 一次，用上面的 git；测试换成假的）。 */
  facts?: FactsReader;
}

export interface HygieneOptions {
  /** 真删判了「删」的（不带就只判不删）。 */
  delete: boolean;
  /** 写巡检单（正文、新列的留言）。 */
  board: boolean;
}

export interface HygieneResult {
  reports: BranchReport[];
  deleted: string[];
  /** 删的时候已经不在了的。 */
  gone: string[];
  /** 判完到删之间头变了、没删的。 */
  skipped: { name: string; why: string }[];
  failed: { name: string; why: string }[];
  /** 没查成的（整份清单读不到、某条分支读不到、巡检单没写成）。 */
  notQueried: string[];
  /** 不算毛病、要告诉人的。 */
  notes: string[];
  board?: { number: number; created: boolean; newAsks: string[] } | undefined;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 认得的巡检单：仓主、组织成员、协作者开的，或 Actions 自己开的（定时任务第一次跑开的那张）。公开仓谁都能开单，
 * 外人开一张带记号、勾好「删」的单，要是也认，就能借机器的手删掉有产出的分支。改正文只有开单的人和有写权限的人能改。
 */
export function trustedBoard(t: Pick<OpenThread, 'author' | 'association'>): boolean {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(t.association) || t.author === 'github-actions[bot]';
}

export async function branchHygiene(deps: HygieneDeps, opts: HygieneOptions): Promise<HygieneResult> {
  const { gh, git, now } = deps;
  const facts = deps.facts ?? gitFacts(git);
  const result: HygieneResult = {
    reports: [],
    deleted: [],
    gone: [],
    skipped: [],
    failed: [],
    notQueried: [],
    notes: [],
  };
  let defaultBranch: string;
  let branches: RemoteBranch[];
  let openPulls: PullHead[];
  let threads: OpenThread[];
  try {
    defaultBranch = await gh.defaultBranch();
    branches = await gh.branches();
    openPulls = await gh.openPulls();
    threads = await gh.openThreads();
  } catch (e) {
    result.notQueried.push(`读不到 GitHub（${errText(e)}），这一轮一条没判、一条没删`);
    return result;
  }
  const main = branches.find((b) => b.name === defaultBranch);
  if (!main) {
    result.notQueried.push(
      `读回来的分支清单里没有默认分支 ${defaultBranch}，认不出，这一轮一条没判、一条没删`,
    );
    return result;
  }

  const marked = threads.filter((t) => !t.isPr && t.body.includes(BOARD_MARKER));
  const boards = marked.filter(trustedBoard).sort((a, b) => a.number - b.number);
  const board = boards[0];
  if (boards.length > 1) {
    result.notes.push(
      `有 ${boards.length} 张巡检单（${prList(boards.map((b) => b.number))}），用最早的 #${board?.number}；别的关掉`,
    );
  }
  const fake = marked.filter((t) => !trustedBoard(t)).map((t) => t.number);
  if (fake.length) {
    result.notes.push(
      `${prList(fake)} 正文带巡检单记号，但不是仓里的人或 Actions 开的：不认，上面的勾一个不算`,
    );
  }
  const parsed = parseBoard(board?.body ?? '');
  const owner = deps.repo.split('/')[0] ?? '';
  const own = (p: PullHead) => p.headRepo?.toLowerCase() === deps.repo.toLowerCase();
  const openBases = new Map<string, number[]>();
  for (const p of openPulls) openBases.set(p.baseRef, [...(openBases.get(p.baseRef) ?? []), p.number]);

  let index: MainIndex | { error: string } | undefined;
  const mainIdx = () => {
    if (index === undefined) {
      try {
        index = facts.index(main.sha);
      } catch (e) {
        index = { error: `主线没读成（${errText(e)}）` };
      }
    }
    return index;
  };

  for (const b of [...branches].sort((x, y) => x.name.localeCompare(y.name))) {
    const c: BranchCase = {
      branch: b,
      isDefault: b.name === defaultBranch,
      openHeadPrs: openPulls.filter((p) => own(p) && p.headRef === b.name).map((p) => p.number),
      openBasePrs: openBases.get(b.name) ?? [],
      mergedExact: undefined,
      mergedOther: [],
      closedPrs: [],
      mentions: mentionedBy(b.name, threads, board?.number),
      decision: parsed.decisions.get(b.name),
    };
    // 结构上就判得了的（默认、受保护、开着的 PR、勾了的、被提到的）不用再按分支查 PR；判不了再查它合过、关过的 PR
    let verdict = ruleVerdict(c);
    if (!verdict) {
      try {
        const mine = (await gh.pullsForHead(b.name)).filter(own);
        // 两次读之间刚开的 PR 也算开着的（不删它的分支）
        c.openHeadPrs = mine.filter((p) => p.state === 'open').map((p) => p.number);
        c.mergedExact = mine.find((p) => p.merged && p.headSha === b.sha)?.number;
        c.mergedOther = mine.filter((p) => p.merged && p.headSha !== b.sha).map((p) => p.number);
        c.closedPrs = mine
          .filter((p) => p.state === 'closed' && !p.merged)
          .map((p) => ({ number: p.number, headSha: p.headSha }));
        verdict = ruleVerdict(c);
      } catch (e) {
        verdict = { kind: 'unknown', why: `这条分支的 PR 没查成：${errText(e)}` };
      }
    }
    if (!verdict) {
      const idx = mainIdx();
      try {
        if ('error' in idx) throw new Error(idx.error);
        c.content = facts.content(idx, b.sha);
      } catch (e) {
        c.content = { error: errText(e) };
      }
      try {
        c.activity = await gh.activity(b.name);
      } catch (e) {
        c.activity = { error: errText(e) };
      }
      verdict = contentVerdict(c, now);
      const n = issueNumberIn(b.name);
      if (verdict.kind === 'ask' && n !== undefined) {
        // 只给人定的时候看：读不到就在理由里照实写「没查成」，不改判决
        try {
          const i = await gh.issue(n);
          c.linked =
            i === undefined
              ? { number: n, missing: true }
              : { number: n, title: i.title, state: i.state, stateReason: i.stateReason, isPr: i.isPr };
        } catch (e) {
          c.linked = { number: n, error: errText(e) };
        }
        verdict = contentVerdict(c, now);
      }
    }
    const decision = c.decision?.sha === b.sha ? c.decision : undefined;
    result.reports.push({ name: b.name, sha: b.sha, verdict, who: whoOpened(c, owner), decision });
    // 主线没读成的那一条下面统一报一次，不在每条分支上重复
    if (verdict.kind === 'unknown' && !(index && 'error' in index && c.content && 'error' in c.content)) {
      result.notQueried.push(`${b.name}：${verdict.why}`);
    }
  }
  if (index && 'error' in index) {
    const n = result.reports.filter((r) => r.verdict.kind === 'unknown').length;
    result.notQueried.push(`${index.error}：要看内容的 ${n} 条分支都没判、都没删`);
  }

  if (opts.delete) {
    for (const r of result.reports) {
      if (r.verdict.kind !== 'delete') continue;
      try {
        const head = await gh.branchHead(r.name);
        if (head === undefined) {
          result.gone.push(r.name);
          continue;
        }
        if (head !== r.sha) {
          result.skipped.push({
            name: r.name,
            why: `判的时候头是 ${short(r.sha)}，删之前读到 ${short(head)}：没删，下一轮重判`,
          });
          continue;
        }
        if (await gh.deleteBranch(r.name)) result.deleted.push(r.name);
        else result.gone.push(r.name);
      } catch (e) {
        result.failed.push({ name: r.name, why: errText(e) });
      }
    }
  }

  if (opts.board) {
    const asks = result.reports.filter((r) => r.verdict.kind === 'ask');
    const pending = result.reports.some((r) => r.decision !== undefined);
    if (board || asks.length || pending) {
      const body = renderBoard({
        reports: result.reports,
        // 删的时候已经不在了的也算删掉了：巡检单上不再列它
        deleted: [...result.deleted, ...result.gone],
        failed: result.failed,
        skipped: result.skipped,
        conflicts: parsed.conflicts,
        now,
      });
      const newAsks = asks.filter((r) => !parsed.listed.has(r.name)).map((r) => r.name);
      try {
        let number = board?.number;
        const created = number === undefined;
        if (number === undefined) number = await gh.createIssue(BOARD_TITLE, body, BOARD_LABELS);
        else if (board?.body !== body) await gh.updateIssueBody(number, body);
        result.board = { number, created, newAsks };
        if (newAsks.length) {
          await gh.comment(
            number,
            `<!-- ${MARK} -->\n分支体检新列了 ${newAsks.length} 条等你定（勾选框在正文里）：${newAsks.map(code).join('、')}`,
          );
        }
      } catch (e) {
        result.notQueried.push(`巡检单没写成（${errText(e)}）`);
      }
    }
  }
  return result;
}

/** 给人看的一张表（Actions 的运行摘要、本机 --report）：每条分支落哪档、为什么、谁开的。 */
export function reportMarkdown(r: HygieneResult, now: Date): string {
  const label: Record<Verdict['kind'], string> = {
    delete: '删',
    keep: '留',
    ask: '等人定',
    unknown: '没查成',
  };
  const done = (name: string) =>
    r.deleted.includes(name)
      ? '已删'
      : r.gone.includes(name)
        ? '删时已不在'
        : r.failed.find((f) => f.name === name)
          ? '删失败'
          : r.skipped.find((s) => s.name === name)
            ? '头变了没删'
            : '';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `<!-- ${MARK} -->`,
    `### 分支体检（${bj(now)} 北京时间）`,
    '',
    '| 分支 | 判 | 理由 | 谁开的 |',
    '|---|---|---|---|',
    ...r.reports.map(
      (x) =>
        `| ${cell(code(x.name))} | ${label[x.verdict.kind]}${done(x.name) ? `（${done(x.name)}）` : ''} | ${cell(x.verdict.why)} | ${cell(x.who)} |`,
    ),
    '',
  ].join('\n');
}
