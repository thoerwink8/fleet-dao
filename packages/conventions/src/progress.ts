// pnpm progress:note / progress:directive / progress:claim / progress:done / progress:read：进度和创始人中途给的引导，记在 GitHub 的
// 置顶单 #1055「进度与创始人引导」下面（一条评论一件事），不再写进 docs/PROGRESS.md 走 PR（那样每条进度都占一次 CI 和合并）。
// 评论的样子（第一行是标记，命令靠它认条）：
//   进度：      【进度】2026-10-05 17:30
//   待处理引导： 【创始人引导·待处理】2026-10-05 16:20（原话的时间，由 --at 给）
//               〔主：<Mirasim 会话目录名>〕（第二行，记它的会话的血缘；取不到写「无主」）
//   办完：      【创始人引导·已处理】…，下面补一段「已处理 <时间>：<做成了什么>」
// 引导认主（创始人 2026-10-11「现在你实现的引导方式会串会话想个最佳解决方式」）：同一个仓开着几个指挥官会话时，开会话钩子
// 只叫主人那个会话办；无主的（旧的、在 Mirasim 外记的）要先 claim 成本血缘再办；已有别的主的 claim 拒绝，除非 --force 带理由
// （原会话已经没了）。主人是哪条血缘由入口算（agents/hooks/founder-inbox.mjs 的 lineageOf），这里只认传进来的名字。
// 全部经 gh：读不到、读回来认不出、写完回读对不上，一律明确报错（ProgressUnchecked，退出码 2），参数不对拒绝（ProgressRefused，
// 退出码 1）；不拿「没读到」当「没有待办」，也不拿「没报错」当「贴上了」（贴完、改完都回读核对）。
import type { Gh, GhResult } from './issue-new.ts';

/** 置顶的「进度与创始人引导」单。别处（规矩、钩子）引用的都是这个号。 */
export const PROGRESS_ISSUE = 1055;
export const NOTE_TAG = '【进度】';
export const PENDING_TAG = '【创始人引导·待处理】';
export const DONE_TAG = '【创始人引导·已处理】';
/** 引导没主（旧的、在 Mirasim 外记的）。和开会话钩子 session-start.mjs 的 NO_OWNER 同一个字。 */
export const NO_OWNER = '无主';
/** 主人标记：独占一行。和 session-start.mjs 认的同一个样子。 */
const OWNER_LINE = /^〔主：([^〕\s]+)〕[ \t]*$/m;
const OWNER_NAME = /^[\w-]{1,128}$/;
export const ownerLine = (owner: string): string => `〔主：${owner}〕`;

export const PROGRESS_USAGE =
  '用法：pnpm progress:note "<一句话进度>"｜pnpm progress:directive "<创始人原话>" --at "<原话的时间，如 2026-10-05 16:20>"｜' +
  'pnpm progress:claim <评论号> [--force --why "原会话为什么没了"]｜' +
  'pnpm progress:done <评论号> [--note "办成了什么"]｜pnpm progress:read [--pending] [--limit <条数，默认 10>]';

/** 参数不对、评论不是该办的那种：拒绝。入口退出码 1。 */
export class ProgressRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressRefused';
  }
}

/** 没查成、没写成：读不到 GitHub、读回来认不出、写完回读对不上。入口退出码 2。 */
export class ProgressUnchecked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressUnchecked';
  }
}

export interface ProgressDeps {
  gh: Gh;
  /** 测试里钉住时间；默认现在。 */
  now?: () => Date;
}

export type Kind = 'note' | 'pending' | 'done' | 'other';

export interface ProgressComment {
  id: number;
  url: string;
  kind: Kind;
  /** 第一行（标记加时间） */
  head: string;
  body: string;
  /** 主人（记它的会话的血缘）；没写主人标记的是「无主」 */
  owner: string;
}

/** 评论里的主人；没有标记就是「无主」 */
export function ownerOf(body: string): string {
  return OWNER_LINE.exec(body.replace(/\r\n/g, '\n'))?.[1] ?? NO_OWNER;
}

/** 正文去掉第一行和主人标记那一行（给开会话钩子列原话用） */
export function textOf(c: ProgressComment): string {
  return c.body.trimStart().slice(c.head.length).replace(OWNER_LINE, '').trim();
}

function requireOwner(owner: string): string {
  if (owner !== NO_OWNER && !OWNER_NAME.test(owner))
    throw new ProgressRefused(`主人「${owner}」认不出：要 Mirasim 会话目录名或「${NO_OWNER}」。`);
  return owner;
}

const PAGE = 100;
const PAGES_MAX = 20;
const ISSUE_PATH = `repos/{owner}/{repo}/issues/${PROGRESS_ISSUE}`;

/** 北京时间 YYYY-MM-DD HH:mm */
export function stamp(d: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

export function kindOf(body: string): Kind {
  const head = body.trimStart();
  if (head.startsWith(PENDING_TAG)) return 'pending';
  if (head.startsWith(DONE_TAG)) return 'done';
  if (head.startsWith(NOTE_TAG)) return 'note';
  return 'other';
}

/** 贴一条进度。返回贴上的评论。 */
export async function progressNote(text: string, deps: ProgressDeps): Promise<ProgressComment> {
  const t = requireText(text, '进度');
  const body = `${NOTE_TAG}${stamp((deps.now ?? (() => new Date()))())}\n\n${t}`;
  return post(deps.gh, body);
}

/**
 * 记一条创始人的引导（待处理）。`at` 是他说这话的时间，必须给。`owner` 是记它的会话的血缘（Mirasim 会话目录名），
 * 取不到给「无主」：开会话钩子只叫主人那个会话办它。
 */
export async function progressDirective(
  text: string,
  at: string,
  owner: string,
  deps: ProgressDeps,
): Promise<ProgressComment> {
  const t = requireText(text, '创始人原话');
  if (!at.trim()) {
    throw new ProgressRefused('缺 --at "<原话的时间>"：引导要记他是什么时候说的。没贴。');
  }
  const body = `${PENDING_TAG}${at.trim()}\n${ownerLine(requireOwner(owner))}\n\n原话：${t}`;
  return post(deps.gh, body);
}

export interface ClaimOptions {
  /** 已归别的会话也改成本会话的（原会话已经没了）；必须带 why */
  force?: boolean | undefined;
  why?: string | undefined;
}

/**
 * 认领一条待处理的引导：主人改成 `owner`（本会话的血缘）。无主的直接改；已是本会话的不动；已归别的会话的拒绝，
 * 除非 force 并写理由（理由记进评论）。不是待处理的、不在 #1055 下的拒绝。改完回读核对主人。
 */
export async function progressClaim(
  id: number,
  owner: string,
  opts: ClaimOptions,
  deps: ProgressDeps,
): Promise<ProgressComment> {
  const { gh } = deps;
  if (owner === NO_OWNER || !OWNER_NAME.test(owner))
    throw new ProgressRefused(
      `认不出本会话是哪个 Mirasim 会话（${owner}），认领不了：在 Mirasim 起的会话里认领，或交给记它的会话办。没改。`,
    );
  const current = await readPending(gh, id);
  const was = ownerOf(current.body);
  if (was === owner) return current;
  const why = opts.why?.trim() ?? '';
  if (was !== NO_OWNER && !opts.force)
    throw new ProgressRefused(
      `评论 ${id} 已归别的会话（${was}），不归你，没改。原会话确实已经没了才用 --force --why "<为什么>"。`,
    );
  if (was !== NO_OWNER && !why) throw new ProgressRefused('--force 要带 --why "<原会话为什么没了>"，没改。');
  const at = stamp((deps.now ?? (() => new Date()))());
  const rest = current.body
    .trimStart()
    .slice(current.head.length)
    .replace(OWNER_LINE, '')
    .replace(/^\n+/, '');
  const moved = was === NO_OWNER ? '' : `\n\n改主 ${at}：${was} → ${owner}（${why}）`;
  const next = `${current.head}\n${ownerLine(owner)}\n\n${rest.trimEnd()}${moved}`;
  const after = await patch(gh, id, next);
  if (after.kind !== 'pending' || after.owner !== owner) {
    throw new ProgressUnchecked(`改完回读评论 ${id}：主人不是 ${owner}，去 GitHub 看一眼 ${after.url}。`);
  }
  return after;
}

/** 把一条待处理的引导标成已处理。不是待处理的拒绝。 */
export async function progressDone(
  id: number,
  note: string | undefined,
  deps: ProgressDeps,
): Promise<ProgressComment> {
  const { gh } = deps;
  const current = await readPending(gh, id);
  const at = stamp((deps.now ?? (() => new Date()))());
  const tail = `已处理 ${at}${note?.trim() ? `：${note.trim()}` : ''}`;
  const next = `${DONE_TAG}${current.head.slice(PENDING_TAG.length)}${current.body.trimStart().slice(current.head.length)}\n\n${tail}`;
  const after = await patch(gh, id, next);
  if (after.kind !== 'done') {
    throw new ProgressUnchecked(`改完回读评论 ${id}：还不是「已处理」，去 GitHub 看一眼 ${after.url}。`);
  }
  return after;
}

export interface ProgressView {
  /** 最近的评论（旧到新），最多 limit 条 */
  recent: ProgressComment[];
  /** 全部待处理的引导（旧到新）。读全了才返回；没读全抛 ProgressUnchecked */
  pending: ProgressComment[];
}

/** 读这张单：最近 limit 条评论加全部没处理的引导。 */
export async function progressRead(limit: number, deps: ProgressDeps): Promise<ProgressView> {
  const all = await readAll(deps.gh);
  return {
    recent: limit > 0 ? all.slice(-limit) : [],
    pending: all.filter((c) => c.kind === 'pending'),
  };
}

// —— 内部 ——

/** 读一条要改的引导：评论号不对、不在 #1055 下、不是待处理的都拒绝 */
async function readPending(gh: Gh, id: number): Promise<ProgressComment> {
  if (!Number.isInteger(id) || id <= 0) throw new ProgressRefused(`评论号 ${String(id)} 不对，要正整数。`);
  const current = parseComment(
    await readJson(gh, ['api', `repos/{owner}/{repo}/issues/comments/${id}`], `读评论 ${id}`),
  );
  if (!current.url.includes(`/issues/${PROGRESS_ISSUE}#`)) {
    throw new ProgressRefused(`评论 ${id} 不在 #${PROGRESS_ISSUE} 下面，没改。`);
  }
  if (current.kind !== 'pending') {
    throw new ProgressRefused(
      `评论 ${id} ${current.kind === 'done' ? '已经标过已处理' : '不是待处理的创始人引导'}，没改。`,
    );
  }
  return current;
}

/** 改一条评论的正文，回读返回（核对由调用方做） */
async function patch(gh: Gh, id: number, body: string): Promise<ProgressComment> {
  const res = await gh([
    'api',
    '-X',
    'PATCH',
    `repos/{owner}/{repo}/issues/comments/${id}`,
    '-f',
    `body=${body}`,
  ]);
  if (res.code !== 0) throw new ProgressUnchecked(`gh 改评论 ${id} 报错：${detail(res)}。没改成，重跑。`);
  return parseComment(
    await readJson(gh, ['api', `repos/{owner}/{repo}/issues/comments/${id}`], `改完回读评论 ${id}`),
  );
}

function requireText(text: string, what: string): string {
  const t = text.trim();
  if (!t) throw new ProgressRefused(`${what}是空的，没贴。`);
  return t;
}

async function post(gh: Gh, body: string): Promise<ProgressComment> {
  const res = await gh(['api', '-X', 'POST', `${ISSUE_PATH}/comments`, '-f', `body=${body}`]);
  if (res.code !== 0) {
    throw new ProgressUnchecked(`gh 往 #${PROGRESS_ISSUE} 贴评论报错：${detail(res)}。没贴上，重跑。`);
  }
  let made: ProgressComment;
  try {
    made = parseComment(JSON.parse(res.stdout));
  } catch {
    throw new ProgressUnchecked(`gh 贴完评论读回来的认不出：去 GitHub 看一眼 #${PROGRESS_ISSUE} 贴上没有。`);
  }
  const echoed = made.body.replace(/\r\n/g, '\n').trim();
  if (echoed !== body.trim()) {
    throw new ProgressUnchecked(`贴完回读的评论内容和要贴的对不上：去 GitHub 看一眼 ${made.url}。`);
  }
  return made;
}

async function readAll(gh: Gh): Promise<ProgressComment[]> {
  const out: ProgressComment[] = [];
  for (let page = 1; page <= PAGES_MAX; page += 1) {
    const list = await readJson(
      gh,
      ['api', `${ISSUE_PATH}/comments?per_page=${PAGE}&page=${page}`],
      `读 #${PROGRESS_ISSUE} 的评论`,
    );
    if (!Array.isArray(list))
      throw new ProgressUnchecked(`gh 读 #${PROGRESS_ISSUE} 的评论：读回来的不是列表。`);
    for (const c of list) out.push(parseComment(c));
    if (list.length < PAGE) return out;
  }
  throw new ProgressUnchecked(
    `#${PROGRESS_ISSUE} 的评论超过 ${PAGE * PAGES_MAX} 条，没读全：没法说有没有待处理的引导。`,
  );
}

function parseComment(raw: unknown): ProgressComment {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof o.id !== 'number' || typeof o.body !== 'string' || typeof o.html_url !== 'string') {
    throw new ProgressUnchecked('gh 读回来的评论认不出（没有 id、body、html_url）。');
  }
  const body = o.body.replace(/\r\n/g, '\n');
  return {
    id: o.id,
    url: o.html_url,
    kind: kindOf(body),
    head: body.trimStart().split('\n')[0] ?? '',
    body,
    owner: ownerOf(body),
  };
}

async function readJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const r = await gh(args);
  if (r.code !== 0) throw new ProgressUnchecked(`gh ${what}报错：${detail(r)}。`);
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    throw new ProgressUnchecked(`gh ${what}：读回来的不是 JSON。`);
  }
}

function detail(r: GhResult): string {
  return (r.stderr.trim() || r.stdout.trim() || '（gh 什么也没说）').replace(/\s+/g, ' ');
}
