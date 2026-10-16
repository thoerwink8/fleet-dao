// 创始人引导记在仓里：docs/directives/<YYYY-MM>/<编号>.md，一条引导一个文件，随 PR 走（决定 0093）。
// 为什么不再记在置顶单 #1055 的评论里：评论分页读（约 11-01 撞 2000 条上限）、开会话钩子每次问 GitHub 常超时、改评论没锁、
// 单被误关过 22 小时没人发现、办完要另记一笔（16 条挂着没人收）。放进仓：开会话钩子读本地 origin/main（不联网、不限条数），
// 法国引擎和别家 CLI 照读文件，git 历史就是审计；「办完」那一笔和活在同一个 PR 里合进主线，合了就算办完，核得出来。
// 原文的源头是本机 prompt-log 钩子（~/.fleet-dao/prompt-log/<日>.jsonl）：pnpm progress directive 不给原话时从那里取本会话
// 创始人最近一句、准确时间和主人，取不到明确报错要人手填，不留空。#1055 只留作进度流水（progress note）和旧引导的只读归档。
//
// 文件的样子（format/parse 两边认同一个）：
//   # 创始人引导 <编号>
//
//   - 时间：2026-10-14 16:30 +0800        他说这话的时刻，一律北京时间 +0800
//   - 主：<Mirasim 会话目录名>｜无主        记它的会话的血缘；开会话钩子只叫主人办
//   - 来源：prompt-log｜手填｜#1055 评论 <号>
//   - 单：#<单号>                          这条引导挂的单（决定 0097 后）：办没办完看这张单开着还是关了，写进去以后不再改这个文件
//
//   ## 原话
//
//   <原文，一字不改>
//
// 旧文件（#2727 以前记的）还有「- 状态：待处理｜已处理｜作废」和「## 经过」：照读不报错；没有「单」行的旧文件仍按状态行判。
// 编号：新记的是北京时间 YYYYMMDDHHmmss（14 位，同一秒撞了加 1 秒）；从 #1055 迁来的沿用评论号（10 位）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Gh, GhResult } from './issue-new.ts';

export const DIRECTIVES_DIR = 'docs/directives';
export const NO_OWNER = '无主';
export const PENDING = '待处理';
export const DONE = '已处理';
export const DROPPED = '作废';
export type Status = typeof PENDING | typeof DONE | typeof DROPPED;
const STATUSES: readonly string[] = [PENDING, DONE, DROPPED];
const OWNER_NAME = /^[\w-]{1,128}$/;
/** 单、PR 正文里写到一条引导的写法（「引导 <编号>」；本机队列用它把引导对到单上） */
export const DIRECTIVE_REF = /引导\s*#?(\d{6,20})/g;
/** 参数不对、这条不是该办的那种：拒绝（入口退出码 1）。 */
export class DirectiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectiveRefused';
  }
}
/** 没查成、没写成（入口退出码 2）。 */
export class DirectiveUnchecked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectiveUnchecked';
  }
}

export interface Directive {
  id: string;
  /** 旧文件的状态行；新文件没有（状态由挂的单现判） */
  status?: Status | undefined;
  /** 「单：#N」那一行 */
  issue?: number | undefined;
  /** 北京时间 YYYY-MM-DD HH:mm +0800 */
  at: string;
  owner: string;
  source: string;
  text: string;
  /** 「## 经过」下面的各行（不带「- 」） */
  log: string[];
  /** 仓里的路径 */
  path: string;
}

// —— 时间 ——

function beijingParts(d: Date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute'), s: g('second') };
}

/** 北京时间 YYYY-MM-DD HH:mm */
export function stamp(d: Date): string {
  const p = beijingParts(d);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}`;
}

/** 北京时间 YYYY-MM-DD HH:mm +0800（引导文件「时间」一行统一这个样子） */
export const stampZ = (d: Date): string => `${stamp(d)} +0800`;

/**
 * --at 认的写法：「2026-10-14 16:30」（按北京时间）、带时区「2026-10-14 08:30 +0000」「+08:00」、ISO「2026-10-14T08:30:00Z」。
 * 一律换成北京时间 +0800。只有日期、认不出的拒绝（「94 条引导 54% 时间写错」就是各写各的时区）。
 */
export function normalizeAt(raw: string): { text: string; date: Date } {
  const s = raw.trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m)
    throw new DirectiveRefused(`--at「${raw}」认不出：要「2026-10-14 16:30」（北京时间）或带时区的时刻。`);
  const zone =
    m[5] === undefined ? '+08:00' : m[5] === 'Z' ? 'Z' : m[5].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const date = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}${zone}`);
  if (Number.isNaN(date.getTime())) throw new DirectiveRefused(`--at「${raw}」不是有效时刻。`);
  return { text: stampZ(date), date };
}

/** 文件头「时间」一行 → 时刻（认不出给 null） */
export function atDate(at: string): Date | null {
  try {
    return normalizeAt(at).date;
  } catch {
    return null;
  }
}

/** 新编号：北京时间 YYYYMMDDHHmmss；taken 里有就往后挪一秒 */
export function newId(d: Date, taken: ReadonlySet<string> = new Set()): string {
  for (let t = d.getTime(); ; t += 1000) {
    const p = beijingParts(new Date(t));
    const id = `${p.y}${p.mo}${p.d}${p.h}${p.mi}${p.s}`;
    if (!taken.has(id)) return id;
  }
}

export function directivePath(id: string, at: Date): string {
  const p = beijingParts(at);
  return `${DIRECTIVES_DIR}/${p.y}-${p.mo}/${id}.md`;
}

// —— 文件 ——

export function formatDirective(d: Omit<Directive, 'path'>): string {
  const lines = [
    `# 创始人引导 ${d.id}`,
    '',
    ...(d.status !== undefined ? [`- 状态：${d.status}`] : []),
    `- 时间：${d.at}`,
    `- 主：${d.owner}`,
    `- 来源：${d.source}`,
    ...(d.issue !== undefined ? [`- 单：#${d.issue}`] : []),
    '',
    '## 原话',
    '',
    d.text.replace(/\r\n?/g, '\n').trim(),
    ...(d.log.length > 0 ? ['', '## 经过', '', ...d.log.map((l) => `- ${l}`)] : []),
  ];
  return `${lines.join('\n')}\n`;
}

export function parseDirective(raw: string, path: string): Directive {
  const text = raw.replace(/\r\n?/g, '\n');
  // 头部字段只在「## 原话」之前找，免得原话里写了「- 单：#5」被当成字段
  const header = text.slice(0, Math.max(0, text.indexOf('\n## 原话\n')) || text.length);
  const field = (name: string) => new RegExp(`^- ${name}：(.*)$`, 'm').exec(header)?.[1]?.trim();
  const id = /^# 创始人引导 (\S+)\s*$/m.exec(text)?.[1];
  const status = field('状态');
  const issueText = field('单');
  const issue = issueText === undefined ? undefined : /^#([1-9]\d*)$/.exec(issueText)?.[1];
  const at = field('时间');
  const owner = field('主');
  const source = field('来源');
  const q = text.indexOf('\n## 原话\n');
  const l = text.lastIndexOf('\n## 经过\n');
  // 新文件没有「经过」一节；旧文件有
  const textEnd = l > q ? l : text.length;
  if (
    !id ||
    (status !== undefined && !STATUSES.includes(status)) ||
    (issueText !== undefined && issue === undefined) ||
    (status === undefined && issue === undefined) ||
    !at ||
    !owner ||
    !source ||
    q < 0
  )
    throw new DirectiveUnchecked(
      `${path} 认不出（不是引导文件的样子：标题、时间、主、来源、单（旧文件是状态）、原话）。`,
    );
  const log =
    l > q
      ? text
          .slice(l + '\n## 经过\n'.length)
          .split('\n')
          .map((x) => x.trim())
          .filter((x) => x.startsWith('- ') && x !== '- （还没有）')
          .map((x) => x.slice(2))
      : [];
  return {
    id,
    status: status as Status | undefined,
    issue: issue === undefined ? undefined : Number(issue),
    at,
    owner,
    source,
    text: text.slice(q + '\n## 原话\n'.length, textEnd).trim(),
    log,
    path,
  };
}

// —— prompt-log：原文的源头 ——

export interface PromptEntry {
  at: Date;
  sessionId: string | null;
  prompt: string;
  /** 从哪读到的（文件头「来源」那一行）；不给算 prompt-log */
  source?: string;
}

/**
 * 两份账合起来：prompt-log（Claude Code 收到的）加 Mirasim 自己的会话记录（他发出去的提问和中途引导，founder-inbox.mjs 的
 * sentByFounder）。会话开在仓外（指挥官常开在家目录）时项目级的 prompt-log 钩子不跑，只有 Mirasim 那份有他的话。
 */
export function mergeLogs(
  log: { entries: PromptEntry[] } | { why: string },
  mirasim: PromptEntry[],
): { entries: PromptEntry[] } | { why: string } {
  if (mirasim.length === 0) return log;
  return { entries: [...('entries' in log ? log.entries : []), ...mirasim] };
}

/** 系统消息、斜杠命令、后台通知不是他说的话 */
const NOT_FOUNDER =
  /^\s*(?:<task-notification|<system-reminder|<prior-conversation|<command-|\[SYSTEM NOTIFICATION|\/[a-z])/i;

/**
 * 读 prompt-log 最近两天（北京时间今天、昨天）的记录。目录不存在、一份都读不到给 why；单行认不出跳过。
 */
export function readPromptLog(dir: string, now: Date): { entries: PromptEntry[] } | { why: string } {
  if (!existsSync(dir)) return { why: `${dir} 不存在（这台没装 prompt-log 钩子？）` };
  const days = [now, new Date(now.getTime() - 86_400_000)].map((d) => {
    const p = beijingParts(d);
    return `${p.y}-${p.mo}-${p.d}.jsonl`;
  });
  const entries: PromptEntry[] = [];
  let read = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    return { why: `${dir} 列不了（${e instanceof Error ? e.message : String(e)}）` };
  }
  for (const name of days) {
    if (!names.includes(name)) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch (e) {
      return { why: `${join(dir, name)} 读不了（${e instanceof Error ? e.message : String(e)}）` };
    }
    read++;
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      try {
        const o = JSON.parse(row) as Record<string, unknown>;
        const at = new Date(String(o.at));
        if (typeof o.prompt !== 'string' || Number.isNaN(at.getTime())) continue;
        entries.push({
          at,
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
          prompt: o.prompt,
        });
      } catch {
        // 一行认不出：跳过，别的照用
      }
    }
  }
  if (read === 0) return { why: `${dir} 里没有今天、昨天的记录` };
  return { entries };
}

/** 本会话（这些原生会话号）创始人最近说的一句；没有给 null */
export function latestFounderPrompt(
  entries: readonly PromptEntry[],
  sessionIds: readonly string[],
): PromptEntry | null {
  const mine = new Set(sessionIds);
  let best: PromptEntry | null = null;
  for (const e of entries) {
    if (e.sessionId === null || !mine.has(e.sessionId)) continue;
    if (!e.prompt.trim() || NOT_FOUNDER.test(e.prompt)) continue;
    if (best === null || e.at.getTime() >= best.at.getTime()) best = e;
  }
  return best;
}

export interface DirectiveInput {
  text?: string | undefined;
  at?: string | undefined;
  owner?: string | undefined;
}
export type LineageInfo =
  | { status: 'found'; dir: string; sessionIds: string[] }
  | { status: 'none' | 'unchecked'; why: string };

const HAND_FILL =
  '手填：pnpm progress directive "<创始人原话>" --at "<他说话的时间，如 2026-10-14 16:30>" [--owner <Mirasim 会话目录名或「无主」>]';

/**
 * 定下要记的原话、时间、主人。原话不给就取 prompt-log 里本会话他最近一句（连时间）；原话给了、--at 没给，只有和 prompt-log
 * 里那一句一字不差才借它的时间。主人：本会话认得出血缘就是它，认不出要 --owner 明说（含「无主」）。哪样取不到都拒绝，不留空。
 */
export function resolveDirective(
  input: DirectiveInput,
  lineage: LineageInfo,
  log: { entries: PromptEntry[] } | { why: string },
  nativeSessionId: string | null,
): { text: string; at: string; atDate: Date; owner: string; source: string } {
  let owner: string;
  if (input.owner !== undefined) {
    owner = input.owner.trim();
    if (owner !== NO_OWNER && !OWNER_NAME.test(owner))
      throw new DirectiveRefused(`--owner「${owner}」认不出：要 Mirasim 会话目录名或「${NO_OWNER}」。没记。`);
  } else if (lineage.status === 'found') owner = lineage.dir;
  else
    throw new DirectiveRefused(
      `本会话认不出是哪个 Mirasim 会话（${lineage.why}），主人定不下来：加 --owner <会话目录名>，确实没有主写 --owner ${NO_OWNER}。没记。`,
    );
  const ids =
    lineage.status === 'found' ? lineage.sessionIds : nativeSessionId !== null ? [nativeSessionId] : [];
  const pick = 'entries' in log ? latestFounderPrompt(log.entries, ids) : null;
  const pickWhy =
    'why' in log ? log.why : ids.length === 0 ? '不知道本会话的会话号' : 'prompt-log 里没有本会话他说的话';
  const text = input.text?.trim() ?? '';
  if (!text) {
    if (input.at !== undefined)
      throw new DirectiveRefused(
        '给了 --at 却没给原话：原话和时间要么都手填，要么都从 prompt-log 取。没记。',
      );
    if (pick === null)
      throw new DirectiveRefused(`没给原话，prompt-log 也取不到（${pickWhy}）。${HAND_FILL}`);
    return {
      text: pick.prompt.trim(),
      at: stampZ(pick.at),
      atDate: pick.at,
      owner,
      source: pick.source ?? 'prompt-log',
    };
  }
  if (input.at !== undefined && input.at.trim()) {
    const n = normalizeAt(input.at);
    return { text, at: n.text, atDate: n.date, owner, source: '手填' };
  }
  if (pick !== null && pick.prompt.trim() === text)
    return { text, at: stampZ(pick.at), atDate: pick.at, owner, source: pick.source ?? 'prompt-log' };
  throw new DirectiveRefused(
    `缺 --at "<原话的时间>"：给的原话和 prompt-log 里本会话最近一句对不上（${pick === null ? pickWhy : '不是同一句'}），时间借不来。没记。`,
  );
}

// —— 仓里读写 ——

export type Git = (
  args: string[],
  opts?: { env?: Record<string, string>; input?: string },
) => Promise<GhResult>;

export interface StoreDeps {
  git: Git;
  gh: Gh;
  now?: () => Date;
}

const one = (r: GhResult) =>
  (r.stderr.trim() || r.stdout.trim() || '（没说）').replace(/\s+/g, ' ').slice(0, 300);

async function must(git: Git, args: string[], what: string, opts?: Parameters<Git>[1]): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new DirectiveUnchecked(`git ${what}报错：${one(r)}。`);
  return r.stdout;
}

/** ref 上全部引导文件的路径 */
export async function listPaths(git: Git, ref: string): Promise<string[]> {
  const out = await must(
    git,
    ['ls-tree', '-r', '--name-only', ref, '--', `${DIRECTIVES_DIR}/`],
    `列 ${ref} 的引导`,
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.md') && l.startsWith(`${DIRECTIVES_DIR}/`) && !l.endsWith('/README.md'));
}

export async function readAt(git: Git, ref: string, path: string): Promise<Directive> {
  return parseDirective(await must(git, ['show', `${ref}:${path}`], `读 ${ref}:${path} `), path);
}

/** 开着的单的号（gh 读；读不到、读不全都报没查成，不当成「没有开着的」） */
export async function openIssueNumbers(gh: Gh): Promise<Set<number>> {
  const limit = 1000;
  const r = await gh(['issue', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number']);
  if (r.code !== 0)
    throw new DirectiveUnchecked(`gh 读开着的单报错：${one(r)}。引导办没办完看挂的单，读不到就判不了。`);
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    throw new DirectiveUnchecked(`gh 读开着的单：输出不是 JSON（${one(r)}）。`);
  }
  if (!Array.isArray(list)) throw new DirectiveUnchecked('gh 读开着的单：读回来的不是列表。');
  if (list.length >= limit)
    throw new DirectiveUnchecked(`开着的单多到 ${limit} 张以上，没读全：判不了哪些引导挂的单还开着。`);
  const out = new Set<number>();
  for (const x of list) {
    const n = (x as { number?: unknown }).number;
    if (typeof n !== 'number') throw new DirectiveUnchecked('gh 读开着的单：有一项没有 number。');
    out.add(n);
  }
  return out;
}

/**
 * ref 上还没办完的引导（旧到新）。办没办完由挂的单现判：文件里有「单：#N」的，N 开着就是没办完、关了就是办完（#2727）；
 * 没有「单」行的旧文件仍按状态行（待处理才算）。先用 git grep 挑文件，再只读要列的：条数多少都不分页；没有挂单的文件就不联网。
 */
export async function listPending(git: Git, gh: Gh, ref: string): Promise<Directive[]> {
  const grep = async (pattern: string, what: string): Promise<string[]> => {
    const r = await git(['grep', '-n', '-e', pattern, ref, '--', `${DIRECTIVES_DIR}/`]);
    if (r.code === 1 && !r.stderr.trim()) return [];
    if (r.code !== 0) throw new DirectiveUnchecked(`git 找${what}报错：${one(r)}。`);
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  };
  // 一行是 <ref>:<路径>:<行号>:<内容>
  const pathOf = (l: string) => l.slice(ref.length + 1).replace(/:\d+:.*$/, '');
  const legacy = (await grep(`^- 状态：${PENDING}$`, '待处理的旧引导')).map(pathOf);
  const linked = new Map<string, number>();
  for (const l of await grep('^- 单：#[0-9][0-9]*$', '引导挂的单')) {
    const n = /- 单：#(\d+)$/.exec(l)?.[1];
    if (n !== undefined) linked.set(pathOf(l), Number(n));
  }
  const open = linked.size > 0 ? await openIssueNumbers(gh) : new Set<number>();
  const paths = new Set<string>([...legacy, ...[...linked].filter(([, n]) => open.has(n)).map(([p]) => p)]);
  const out: Directive[] = [];
  for (const p of paths) {
    const d = await readAt(git, ref, p);
    // 挂了单的以单为准（旧状态行写什么都不看）；没挂单的才看状态行
    if (d.issue !== undefined ? open.has(d.issue) : d.status === PENDING) out.push(d);
  }
  return out.sort((a, b) => (atDate(a.at)?.getTime() ?? 0) - (atDate(b.at)?.getTime() ?? 0));
}

export const MAIN = 'origin/main';
const branchOf = (id: string) => `directive/${id}`;

/**
 * 把一个文件的新内容开成 PR 合进主线：不碰任何检出（临时索引上拼一个提交，父提交是刚取的 origin/main），推到
 * directive/<编号>，开 PR、挂自动合并。分支已经在（别的会话正改同一条、PR 还没合）就推不上——这就是锁，返回拒绝不硬推。
 */
export async function proposeFile(
  deps: StoreDeps,
  change: { id: string; path: string; content: string; title: string; did: string },
): Promise<string> {
  const { git, gh } = deps;
  await must(git, ['fetch', '-q', 'origin', 'main'], '取主线');
  const parent = (await must(git, ['rev-parse', MAIN], '读主线')).trim();
  const index = join(tmpdir(), `fleet-directive-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  await must(git, ['read-tree', parent], '读主线的树', { env });
  const blob = (
    await must(git, ['hash-object', '-w', '--stdin'], '写文件', { input: change.content })
  ).trim();
  await must(git, ['update-index', '--add', '--cacheinfo', `100644,${blob},${change.path}`], '放进索引', {
    env,
  });
  const tree = (await must(git, ['write-tree'], '写树', { env })).trim();
  const commit = (
    await must(git, ['commit-tree', tree, '-p', parent, '-m', `${change.title}（决定 0093）`], '写提交')
  ).trim();
  const branch = branchOf(change.id);
  const push = await git([
    'push',
    '-q',
    `--force-with-lease=refs/heads/${branch}:`,
    'origin',
    `${commit}:refs/heads/${branch}`,
  ]);
  if (push.code !== 0) {
    if (/stale info|rejected|already exists|fetch first/i.test(push.stderr))
      throw new DirectiveRefused(
        `分支 ${branch} 已经在（别的会话正在改这条引导、PR 还没合）：等它合了再来，没改。`,
      );
    throw new DirectiveUnchecked(`git 推 ${branch} 报错：${one(push)}。没改成。`);
  }
  const body = `**做了什么**：${change.did}\n\n**需求**：无：创始人引导记录（docs/directives，决定 0093）\n`;
  const pr = await gh([
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    branch,
    '--title',
    change.title,
    '--body',
    body,
  ]);
  if (pr.code !== 0)
    throw new DirectiveUnchecked(`推上了 ${branch}，gh 开 PR 报错：${one(pr)}。去 GitHub 补开。`);
  const url = pr.stdout.trim().split('\n').pop() ?? '';
  const arm = await gh(['pr', 'merge', url || branch, '--auto', '--squash']);
  if (arm.code !== 0) throw new DirectiveUnchecked(`开了 ${url}，挂自动合并报错：${one(arm)}。手挂一下。`);
  return url;
}

// —— 记 ——

/** 挂的单：开着的才能挂；关了、不存在、读不到都明确报 */
export async function checkIssueOpen(gh: Gh, issue: number): Promise<void> {
  const r = await gh(['issue', 'view', String(issue), '--json', 'state', '--jq', '.state']);
  if (r.code !== 0)
    throw new DirectiveUnchecked(`gh 读单 #${issue} 报错：${one(r)}。没记（引导要挂一张开着的单）。`);
  const state = r.stdout.trim();
  if (state !== 'OPEN')
    throw new DirectiveRefused(
      `单 #${issue} 是「${state || '读不出'}」，不是开着的：引导挂已关的单一开始就算办完。没记。`,
    );
}

/** 没给 --issue 时顺手开的单：标题取原话前几个字，正文四节照 issue-new 的要求写 */
export function directiveIssueDraft(r: { text: string; at: string; source: string }): {
  title: string;
  body: string;
} {
  const flat = r.text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  const title = `创始人引导：${chars.slice(0, 30).join('')}${chars.length > 30 ? '…' : ''}`;
  const body = [
    '## 场景',
    '',
    `创始人 ${r.at} 的引导（来源：${r.source}），随 pnpm progress directive 记进 docs/directives/，这张单就是它办没办完的凭据：单开着引导就算没办完，单关了就算办完。`,
    '',
    '## 原话',
    '',
    r.text.replace(/\r\n?/g, '\n').trim(),
    '',
    '## 已知的模块',
    '',
    '暂无',
    '',
    '## 怎么算做完',
    '',
    '- 这条引导要的事做成并合进主线，CI 全绿。',
    '',
  ].join('\n');
  return { title, body };
}

export interface RecordDeps extends StoreDeps {
  /** 没给 --issue 时开一张单，返回单号（入口用 issueNew 实现；测试给假的） */
  newIssue?: (draft: { title: string; body: string }) => Promise<number>;
}

/**
 * 记一条新引导（开 PR）。返回编号、路径、挂的单、PR。
 * 要挂单：给了 issue 就先查它开着；没给就开一张（没有 newIssue 就拒绝，不留空）。文件写进去以后不再改。
 */
export async function recordDirective(
  r: { text: string; at: string; atDate: Date; owner: string; source: string },
  deps: RecordDeps,
  issue?: number,
): Promise<{ id: string; path: string; issue: number; url: string }> {
  await must(deps.git, ['fetch', '-q', 'origin', 'main'], '取主线');
  const taken = new Set(
    (await listPaths(deps.git, MAIN)).map((p) => p.replace(/^.*\//, '').replace(/\.md$/, '')),
  );
  let n = issue;
  if (n !== undefined) await checkIssueOpen(deps.gh, n);
  else {
    if (!deps.newIssue) throw new DirectiveRefused('没给 --issue，也没法开单：没记。');
    n = await deps.newIssue(directiveIssueDraft(r));
  }
  const id = newId(r.atDate, taken);
  const path = directivePath(id, r.atDate);
  const content = formatDirective({
    id,
    issue: n,
    at: r.at,
    owner: r.owner,
    source: r.source,
    text: r.text,
    log: [],
  });
  const url = await proposeFile(deps, {
    id,
    path,
    content,
    title: `记创始人引导 ${id}`,
    did: `记下创始人 ${r.at} 的引导（主：${r.owner}，来源：${r.source}，挂单 #${n}）`,
  });
  return { id, path, issue: n, url };
}

// —— #1055 收件箱里的一条搬进仓 ——

/** 评论 → 引导（编号沿用评论号，挂 issue 这张单）。时间取第一行标记后面写的，认不出（只有日期、没写）用评论贴上的时刻。 */
export function directiveFromComment(
  c: {
    id: number;
    head: string;
    owner: string;
    createdAt: string;
    text: string;
  },
  issue: number,
): Directive {
  const written = c.head.replace(/^【[^】]*】/, '').trim();
  let at: { text: string; date: Date };
  try {
    at = normalizeAt(written);
  } catch {
    const d = new Date(c.createdAt);
    if (Number.isNaN(d.getTime()))
      throw new DirectiveUnchecked(`评论 ${c.id} 的时间认不出（「${written}」，也没有贴上的时刻）。`);
    at = { text: stampZ(d), date: d };
  }
  const id = String(c.id);
  return {
    id,
    issue,
    at: at.text,
    owner: c.owner,
    source: `#1055 评论 ${c.id}`,
    text: c.text,
    log: [],
    path: directivePath(id, at.date),
  };
}
