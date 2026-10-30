// 置顶单 #1055「进度与创始人引导」现在只管两件事（决定 0097 #2169：创始人引导搬进仓里 docs/directives/，见 ./directives.ts）：
// - 进度流水：pnpm progress note 贴一条【进度】评论；pnpm progress read 读最近几条。
// - 外面来的引导的收件箱：驾驶舱「要你拍」拍完（packages/api 的 decision-handoff.ts，法国上没有仓的写权限）仍往这里贴
//   【创始人引导·待处理】评论。开会话钩子把它和仓里的待处理引导一起列；pnpm progress directive --kind <类> --from-inbox <评论号>：ai 把它搬进仓（编号沿用评论号、挂一张单），其余类别不写文件、评论改成【创始人引导·已处理】写明去处（决定 0111），
//   评论改成【创始人引导·已迁】并写上搬到哪。旧的引导（10-14 以前的 94 条）已整批搬进仓，这里留作只读归档。
// 【#3741 片 2c】收件箱的读和认领已改走法国账本（./ledger-read.ts、bin/progress.ts）；下面 inboxPending、readInboxComment、
// markMigrated、markHandled 是旧 #1055 评论的读写，双写期内保留不用，等真机验过再删。
// 读的上限：不再从第一页读全量（原来读满 2000 条就报错，约 11-01 会撞）。收件箱只看最近 INBOX_DAYS 天里改过的评论
// （GitHub 的 since 按更新时间筛；待处理的收件超过这么久没人动，开会话钩子早在 24 小时时就交给创始人拍了）；进度流水只读最后一页。
// 全部经 gh：读不到、认不出、写完回读对不上，一律明确报错（ProgressUnchecked，退出码 2）；参数不对拒绝（ProgressRefused，退出码 1）。
import type { Gh, GhResult } from './issue-new.ts';

/** 置顶的「进度与创始人引导」单。别处（规矩、钩子）引用的都是这个号。 */
export const PROGRESS_ISSUE = 1055;
export const NOTE_TAG = '【进度】';
export const PENDING_TAG = '【创始人引导·待处理】';
export const DONE_TAG = '【创始人引导·已处理】';
/** 搬进仓里以后，原评论第一行换成这个 */
export const MIGRATED_TAG = '【创始人引导·已迁】';
/** 引导没主。和开会话钩子 session-start.mjs 的 NO_OWNER 同一个字。 */
export const NO_OWNER = '无主';
/** 主人标记：独占一行。和 session-start.mjs 认的同一个样子。 */
const OWNER_LINE = /^〔主：([^〕\s]+)〕[ \t]*$/m;
export const ownerLine = (owner: string): string => `〔主：${owner}〕`;
/** 收件箱看最近多少天改过的评论 */
export const INBOX_DAYS = 30;

/** 先分拣的类别：ai 才记引导，discuss 指到起稿命令，其余各有去处（决定 0111、0117） */
export const DIRECTIVE_KINDS = ['ai', 'product', 'task', 'once', 'ops', 'discuss'] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];
export const isDirectiveKind = (v: unknown): v is DirectiveKind =>
  typeof v === 'string' && (DIRECTIVE_KINDS as readonly string[]).includes(v);

/**
 * 分拣表和判法原文（决定 0117：判法住在命令里，不住通用段）。不带 --kind、值认不出时打出来；ai 记成功时也打一遍。
 * 判不准的先后：先判是不是只这一次，判不准就不记（决定 0013 第 4 条）；确定以后都管再分 AI 还是产品，判不准按产品。
 */
export const KIND_JUDGE = [
  '三路分拣（回执首行写「按 照做／讨论稿／记成规矩 办」）：',
  '一、照做＝只管这一次、一件活：once 照做就行、不记；task 要去做的活，pnpm issue:new 开单、原话写进单里。',
  '二、讨论稿＝一次提了好几点、要他拍板、根因不清的：discuss 先出稿、不改代码（fleet-dao 里 pnpm discuss:new -- <短名> --ask "…"，别的仓照 discussion-draft 技能）。',
  '三、记成规矩＝以后都管的，再两问：①讲的是 AI 的做法（规矩、偏好、派活、用哪个模型/CLI），还是东西该长什么样、做成什么样（驾驶舱、引擎这些 fleet-dao 自己的产品也算）；②只管这一次，还是以后都管。',
  '  ai＝以后都管的 AI 做法：记进 fleet-dao 的 docs/directives/；只关某一个项目的，记本机 AI 记忆。',
  '  product＝产品该长什么样：记进那个产品的设计文档或决定记录，跟着正在干的 PR；没有在干的活就单开一个只改文档的 PR；对外仓照通用段「对外仓和对外内容怎么写」。',
  '  ops＝因一时情况拍的 AI 运营调整（额度、断电、他不在）：记进 docs/PROGRESS.md「## 生效中的临时调整」，到期问他。',
  '判不准的先后：先判是不是只这一次，判不准就不记（决定 0013 第 4 条）；确定以后都管再分 AI 还是产品，判不准按产品。',
  '他回答你提的问题时，答案写进你正在做的那件活，不另记。',
].join('\n');

/** 非 ai 类别该去哪。对外仓的 product 不提示贴原话。 */
export function kindDestination(kind: Exclude<DirectiveKind, 'ai'>, external: boolean): string {
  switch (kind) {
    case 'product':
      return external
        ? '那个产品的设计文档或决定记录（照那个仓的记法写成结论，原话只进私有处），跟着正在干的 PR；没有在干的活，就单开一个只改文档的 PR'
        : '那个产品的设计文档或决定记录，跟着正在干的 PR；没有在干的活，就单开一个只改文档的 PR';
    case 'task':
      return '单：pnpm issue:new 开单，原话写进单里';
    case 'once':
      return '不记：照做就行（决定 0013）';
    case 'ops':
      return 'docs/PROGRESS.md「## 生效中的临时调整」';
    case 'discuss':
      return '讨论稿：先出稿、不改代码；fleet-dao 里 pnpm discuss:new -- <短名> --ask "…"，别的仓照 discussion-draft 技能';
  }
}

export const PROGRESS_USAGE =
  '用法：pnpm progress quotes:flush｜pnpm progress note "<一句话进度>"｜pnpm progress directive --kind <ai|product|task|once|ops|discuss> ["<创始人原话>" --at "<时间>"] [--meaning "<可公开的意思>"] [--stdin] [--owner <会话目录名|无主>] [--issue <单号>]' +
  '（不给原话就从 prompt-log 取本会话他最近一句；不给 --issue 就顺手开一张单，引导办没办完看这张单开着还是关了）｜' +
  'pnpm progress directive --kind <类> --from-inbox <账本行编号，见 progress read --pending 第一列> [--issue <单号>]｜pnpm progress read [--pending] [--limit <条数，默认 10>]';

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

export type Kind = 'note' | 'pending' | 'done' | 'migrated' | 'other';

export interface ProgressComment {
  id: number;
  url: string;
  kind: Kind;
  /** 第一行（标记加时间） */
  head: string;
  body: string;
  /** 主人；没写主人标记的是「无主」 */
  owner: string;
  /** 评论贴上的时刻（ISO） */
  createdAt: string;
}

/** 评论里的主人；没有标记就是「无主」 */
export function ownerOf(body: string): string {
  return OWNER_LINE.exec(body.replace(/\r\n/g, '\n'))?.[1] ?? NO_OWNER;
}

/** 正文去掉第一行和主人标记那一行，再去掉「原话：」 */
export function textOf(c: ProgressComment): string {
  return c.body
    .trimStart()
    .slice(c.head.length)
    .replace(OWNER_LINE, '')
    .trim()
    .replace(/^原话：/, '');
}

const PAGE = 100;
const ISSUE_PATH = `repos/{owner}/{repo}/issues/${PROGRESS_ISSUE}`;
/** 收件箱按 since 读，最多翻这么多页（30 天的改动远到不了；到了照实报没读全） */
const INBOX_PAGES_MAX = 20;

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
  if (head.startsWith(MIGRATED_TAG)) return 'migrated';
  if (head.startsWith(NOTE_TAG)) return 'note';
  return 'other';
}

/** 贴一条进度。返回贴上的评论。 */
export async function progressNote(text: string, deps: ProgressDeps): Promise<ProgressComment> {
  const t = text.trim();
  if (!t) throw new ProgressRefused('进度是空的，没贴。');
  const body = `${NOTE_TAG}${stamp((deps.now ?? (() => new Date()))())}\n\n${t}`;
  const res = await deps.gh(['api', '-X', 'POST', `${ISSUE_PATH}/comments`, '-f', `body=${body}`]);
  if (res.code !== 0) {
    throw new ProgressUnchecked(`gh 往 #${PROGRESS_ISSUE} 贴评论报错：${detail(res)}。没贴上，重跑。`);
  }
  let made: ProgressComment;
  try {
    made = parseComment(JSON.parse(res.stdout));
  } catch {
    throw new ProgressUnchecked(`gh 贴完评论读回来的认不出：去 GitHub 看一眼 #${PROGRESS_ISSUE} 贴上没有。`);
  }
  if (made.body.replace(/\r\n/g, '\n').trim() !== body.trim()) {
    throw new ProgressUnchecked(`贴完回读的评论内容和要贴的对不上：去 GitHub 看一眼 ${made.url}。`);
  }
  return made;
}

/** 最近 limit 条评论（旧到新）：先读单的评论总数，再从最后一页往前读，不从头翻。 */
export async function recentComments(limit: number, deps: ProgressDeps): Promise<ProgressComment[]> {
  if (limit <= 0) return [];
  const issue = await readJson(deps.gh, ['api', ISSUE_PATH], `读 #${PROGRESS_ISSUE}`);
  const total = (issue as { comments?: unknown })?.comments;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0)
    throw new ProgressUnchecked(`gh 读 #${PROGRESS_ISSUE}：读回来的没有评论总数。`);
  const out: ProgressComment[] = [];
  for (let page = Math.ceil(total / PAGE); page >= 1 && out.length < limit; page -= 1) {
    const list = await readList(deps.gh, `${ISSUE_PATH}/comments?per_page=${PAGE}&page=${page}`);
    out.unshift(...list.map(parseComment));
  }
  return out.slice(-limit);
}

/**
 * 收件箱：最近 INBOX_DAYS 天里改过的、还待处理的引导评论（旧到新）。按 since 读，评论再多也只翻这一段。
 */
export async function inboxPending(deps: ProgressDeps): Promise<ProgressComment[]> {
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - INBOX_DAYS * 86_400_000).toISOString();
  const out: ProgressComment[] = [];
  for (let page = 1; page <= INBOX_PAGES_MAX; page += 1) {
    const list = await readList(
      deps.gh,
      `${ISSUE_PATH}/comments?since=${since}&per_page=${PAGE}&page=${page}`,
    );
    for (const c of list) {
      const p = parseComment(c);
      if (p.kind === 'pending') out.push(p);
    }
    if (list.length < PAGE) return out;
  }
  throw new ProgressUnchecked(
    `#${PROGRESS_ISSUE} 最近 ${INBOX_DAYS} 天改过的评论超过 ${PAGE * INBOX_PAGES_MAX} 条，没读全：没法说收件箱里有没有待处理的引导。`,
  );
}

/** 读一条收件箱里的引导；不在 #1055 下、不是待处理的拒绝 */
export async function readInboxComment(id: number, deps: ProgressDeps): Promise<ProgressComment> {
  if (!Number.isInteger(id) || id <= 0) throw new ProgressRefused(`评论号 ${String(id)} 不对，要正整数。`);
  const c = parseComment(
    await readJson(deps.gh, ['api', `repos/{owner}/{repo}/issues/comments/${id}`], `读评论 ${id}`),
  );
  if (!c.url.includes(`/issues/${PROGRESS_ISSUE}#`))
    throw new ProgressRefused(`评论 ${id} 不在 #${PROGRESS_ISSUE} 下面，没改。`);
  if (c.kind !== 'pending')
    throw new ProgressRefused(`评论 ${id} 不是待处理的创始人引导（${c.head.slice(0, 20)}），没改。`);
  return c;
}

/** 收件箱里的一条搬进仓以后：第一行换成【创始人引导·已迁】，下面写搬到哪。改完回读核对。 */
export async function markMigrated(c: ProgressComment, where: string, deps: ProgressDeps): Promise<void> {
  const rest = c.body.trimStart().slice(c.head.length);
  const next = `${MIGRATED_TAG}${c.head.slice(PENDING_TAG.length)}${rest}\n\n已迁到仓里：${where}（办没办完看它挂的单）`;
  const res = await deps.gh([
    'api',
    '-X',
    'PATCH',
    `repos/{owner}/{repo}/issues/comments/${c.id}`,
    '-f',
    `body=${next}`,
  ]);
  if (res.code !== 0) throw new ProgressUnchecked(`gh 改评论 ${c.id} 报错：${detail(res)}。`);
  const after = parseComment(
    await readJson(deps.gh, ['api', `repos/{owner}/{repo}/issues/comments/${c.id}`], `改完回读评论 ${c.id}`),
  );
  if (after.kind !== 'migrated')
    throw new ProgressUnchecked(`改完回读评论 ${c.id}：还不是「已迁」，去看一眼 ${after.url}。`);
}

/** 判成不该记引导的类别时，收件箱里的那条评论：第一行换成【创始人引导·已处理】，下面写记在哪。改完回读核对。 */
export async function markHandled(c: ProgressComment, where: string, deps: ProgressDeps): Promise<void> {
  const rest = c.body.trimStart().slice(c.head.length);
  const next = `${DONE_TAG}${c.head.slice(PENDING_TAG.length)}${rest}\n\n记在 ${where}（判成不进创始人引导，决定 0111）`;
  const res = await deps.gh([
    'api',
    '-X',
    'PATCH',
    `repos/{owner}/{repo}/issues/comments/${c.id}`,
    '-f',
    `body=${next}`,
  ]);
  if (res.code !== 0) throw new ProgressUnchecked(`gh 改评论 ${c.id} 报错：${detail(res)}。`);
  const after = parseComment(
    await readJson(deps.gh, ['api', `repos/{owner}/{repo}/issues/comments/${c.id}`], `改完回读评论 ${c.id}`),
  );
  if (after.kind !== 'done')
    throw new ProgressUnchecked(`改完回读评论 ${c.id}：还不是「已处理」，去看一眼 ${after.url}。`);
}

// —— 内部 ——

async function readList(gh: Gh, path: string): Promise<unknown[]> {
  const list = await readJson(gh, ['api', path], `读 #${PROGRESS_ISSUE} 的评论`);
  if (!Array.isArray(list))
    throw new ProgressUnchecked(`gh 读 #${PROGRESS_ISSUE} 的评论：读回来的不是列表。`);
  return list;
}

export function parseComment(raw: unknown): ProgressComment {
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
    createdAt: typeof o.created_at === 'string' ? o.created_at : '',
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
