// 现在的计划：pnpm plan，从 GitHub 现读版本、先后、母单和子单，打印出来（#654 起；之前叫版本快照 pnpm plan:snapshot，#138）。
// 计划以 GitHub 为准（创始人 2026-09-26 晚拍，#169 第 5 件）：版本＝里程碑，版本里的先后写在里程碑说明的 <!-- fleet:order --> 标记
// 之间，母单、子单用 GitHub 自带的子议题。以前每个版本开始和结束时把它们抄进 docs/plan.md：抄出来的那份随时过时、还得有人记得重生成，
// 一个事实两个家（docs/decisions/0015-github-one-home.md），所以只留这个现读的入口；GitHub 对账（github-audit.ts）也用 readPlan 核对先后。
// 改这里之前必须知道：
// - 读不到（没登录、接口报错）、先后标记缺了或认不出：一律退出码 2、不打印空计划冒充，每条都在 test/plan-view.test.ts 里有一条故意造出失败的测试。
// - 输出只由读到的数据和打印时间定：版本按号、单按号排，子单按 GitHub 上排的先后；时间只出现在第一行。
import { parseArgs } from 'node:util';
import type { GitHubReader, MilestoneDetail, PlanIssue } from './github-api.ts';
import { MOTHER_LABEL, milestoneVersion } from './labels.ts';

/** 读到了、可是内容有问题（先后标记认不出、子单绕圈…）：说清是哪、怎么改。读不到 GitHub 抛的是别的错，对账靠这个分开两种。 */
export class PlanProblem extends Error {}

export const PLAN_USAGE = '用法：pnpm plan（不带参数；从 GitHub 现读，只打印、不写文件）';

/** 版本里程碑说明里的先后标记（design 第七节「标签与里程碑」）：之间一行一张，写成「1. #169」。 */
const ORDER_BEGIN = /<!--\s*fleet:order\s*-->/g;
const ORDER_END = /<!--\s*\/fleet:order\s*-->/g;
const ORDER_LINE = /^(\d+)\.\s+#(\d+)$/;

export type OrderParse =
  | { ok: true; order: number[]; before: string; after: string }
  | { ok: false; problem: string };

/**
 * 从里程碑说明里取先后：标记恰好一对，之间一行一张（「1. #169」），序号从 1 起挨着排，同一张不写两遍。
 * before、after 是标记前后的说明原文（去掉首尾空白），打印时照抄，标记那一段换成排好的列表。
 */
export function parseOrder(description: string): OrderParse {
  const text = description.replace(/\r\n?/g, '\n');
  const begins = [...text.matchAll(ORDER_BEGIN)];
  const ends = [...text.matchAll(ORDER_END)];
  const fail = (problem: string): OrderParse => ({ ok: false, problem });
  if (begins.length === 0 && ends.length === 0) {
    return fail(
      '说明里没有先后标记（<!-- fleet:order --> 和 <!-- /fleet:order --> 两行，之间一行一张写「1. #单号」）',
    );
  }
  const [begin] = begins;
  const [end] = ends;
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined) {
    return fail(`先后标记要恰好一对，现在开头的有 ${begins.length} 个、结尾的有 ${ends.length} 个`);
  }
  if (end.index < begin.index) return fail('先后的结尾标记写在了开头标记前面');
  const rows = text
    .slice(begin.index + begin[0].length, end.index)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (rows.length === 0) return fail('先后标记之间一张单也没有');
  const order: number[] = [];
  for (const [i, row] of rows.entries()) {
    const m = ORDER_LINE.exec(row);
    if (!m) return fail(`先后第 ${i + 1} 行「${row}」认不出：一行只写一张，写成「${i + 1}. #单号」`);
    if (Number(m[1]) !== i + 1) return fail(`先后第 ${i + 1} 行的序号写成了 ${m[1]}：从 1 起挨着排`);
    const n = Number(m[2]);
    if (order.includes(n)) return fail(`先后里 #${n} 写了两遍`);
    order.push(n);
  }
  return {
    ok: true,
    order,
    before: text.slice(0, begin.index).trim(),
    after: text.slice(end.index + end[0].length).trim(),
  };
}

export interface PlanVersion {
  milestone: MilestoneDetail;
  version: number;
  /** 挂在这个版本上的单（不含 PR），按单号。 */
  issues: PlanIssue[];
  /** 先后里排的，按先后。 */
  ordered: PlanIssue[];
  /** 版本里没排进先后、也不在排了的单下面的，按单号。 */
  unordered: PlanIssue[];
  /** 里程碑说明在先后标记前、后的原文。 */
  before: string;
  after: string;
}

export interface Plan {
  /** 开着的版本，版本号从小到大。 */
  open: PlanVersion[];
  /** 关了的版本，版本号从大到小。 */
  closed: PlanVersion[];
  /** 未排期里最上面一层（不在别的未排期单下面的），按单号。 */
  unscheduled: PlanIssue[];
  /** 未排期的开着的单一共几张（含挂在未排期母单下面的）。 */
  unscheduledTotal: number;
  /** 母单 → 子单（按 GitHub 上排的先后）；只有读过子单的才在里面。 */
  children: ReadonlyMap<number, PlanIssue[]>;
  /** 子单 → 母单。 */
  parents: ReadonlyMap<number, number>;
  /** 开着的版本里开着、却没排进先后（也不在排了的单下面）的单，按版本。打印时当提醒，对账按单留言。 */
  loose: { milestone: string; issues: PlanIssue[] }[];
}

/** 给人看的提醒（一个版本一句），不挡打印。 */
export function planNotes(p: Plan): string[] {
  return p.loose.map(
    (g) =>
      `「${g.milestone}」里 ${g.issues.map((i) => `#${i.number}`).join('、')} 开着却没排进先后（列在「先后里没排的」）`,
  );
}

/** 读 GitHub、核对先后，排好要打印的东西。读不到、认不出就抛（一句话说清是哪、怎么改）。 */
export async function readPlan(gh: GitHubReader): Promise<Plan> {
  const milestones = [...(await gh.milestones())].sort((a, b) => a.number - b.number);
  const versions: Omit<PlanVersion, 'issues' | 'ordered' | 'unordered'>[] = [];
  const titleOf = new Map<number, string>();
  const orders = new Map<number, number[]>();
  for (const m of milestones) {
    const version = milestoneVersion(m.title);
    if (version === undefined) continue;
    const other = titleOf.get(version);
    if (other !== undefined) {
      throw new PlanProblem(
        `「${other}」和「${m.title}」都是 v${version}：一个版本号只能有一个里程碑，改个名再看`,
      );
    }
    titleOf.set(version, m.title);
    const parsed = parseOrder(m.description);
    if (!parsed.ok)
      throw new PlanProblem(`里程碑「${m.title}」：${parsed.problem}。改好 GitHub 上的里程碑说明再看`);
    orders.set(m.number, parsed.order);
    versions.push({ milestone: m, version, before: parsed.before, after: parsed.after });
  }
  if (versions.length === 0) {
    const all = milestones.map((m) => `「${m.title}」`).join('') || '一个也没有';
    throw new PlanProblem(`GitHub 上一个版本（v<N> 开头的里程碑）也没有，不打印空计划；现在的里程碑：${all}`);
  }
  const versionTitles = new Set(versions.map((v) => v.milestone.title));

  const open = await gh.openIssues();
  const stray = byNumber(open.filter((i) => i.milestone !== null && !versionTitles.has(i.milestone)));
  if (stray.length) {
    const list = stray.map((i) => `#${i.number}（「${i.milestone}」）`).join('、');
    throw new PlanProblem(`开着的单挂在不是版本的里程碑上，计划里没地方放：${list}。挪到版本或未排期再看`);
  }
  const unscheduledAll = byNumber(open.filter((i) => i.milestone === null));
  const inVersion = new Map<number, PlanIssue[]>();
  for (const v of versions) {
    inVersion.set(v.milestone.number, byNumber(await gh.milestoneIssues(v.milestone.number)));
  }

  // 子单：贴了母单标签的、GitHub 记着有子单的都读，子单的子单接着读；每张只读一次
  const children = new Map<number, PlanIssue[]>();
  const parents = new Map<number, number>();
  const queue = [...[...inVersion.values()].flat(), ...unscheduledAll].filter(hasChildren);
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    if (children.has(parent.number)) continue;
    const kids = await gh.subIssues(parent.number);
    children.set(parent.number, kids);
    for (const kid of kids) {
      const known = parents.get(kid.number);
      if (known !== undefined && known !== parent.number) {
        throw new PlanProblem(
          `#${kid.number} 既在 #${known} 下面、又在 #${parent.number} 下面（多半是读的时候有人在挪子单）：再跑一次`,
        );
      }
      if (kid.number === parent.number || ancestors(parents, parent.number).includes(kid.number)) {
        throw new PlanProblem(
          `子单绕成了圈（#${parent.number} 下面又挂着 #${kid.number}）：去 GitHub 上理顺再看`,
        );
      }
      parents.set(kid.number, parent.number);
      if (hasChildren(kid)) queue.push(kid);
    }
  }

  const looseByVersion: Plan['loose'] = [];
  const laidOut = versions.map((v): PlanVersion => {
    const issues = inVersion.get(v.milestone.number) ?? [];
    const order = orders.get(v.milestone.number) ?? [];
    const here = new Map(issues.map((i) => [i.number, i]));
    /** 这个版本里、排在它上面最近的那张（它会列在那张下面）；没有是 undefined。 */
    const nestedUnder = (n: number) => ancestors(parents, n).find((a) => here.has(a));
    const ordered = order.map((n) => {
      const issue = here.get(n);
      if (issue === undefined) {
        throw new PlanProblem(
          `里程碑「${v.milestone.title}」的先后里有 #${n}，可它不是这个版本里的单（没挂这个里程碑，或者是 PR）：在 GitHub 上把它挂进来，或者从先后里删掉`,
        );
      }
      const under = nestedUnder(n);
      if (under !== undefined) {
        throw new PlanProblem(
          `里程碑「${v.milestone.title}」的先后里有 #${n}，可它是 #${under} 的子单：先后里只排母单和单独的单，子单的先后在母单页面上排`,
        );
      }
      return issue;
    });
    const unordered = issues.filter((i) => !order.includes(i.number) && nestedUnder(i.number) === undefined);
    const loose = unordered.filter((i) => i.state === 'open');
    if (v.milestone.state === 'open' && loose.length) {
      looseByVersion.push({ milestone: v.milestone.title, issues: loose });
    }
    return { ...v, issues, ordered, unordered };
  });

  const unscheduledSet = new Set(unscheduledAll.map((i) => i.number));
  return {
    open: laidOut.filter((v) => v.milestone.state === 'open').sort((a, b) => a.version - b.version),
    closed: laidOut.filter((v) => v.milestone.state === 'closed').sort((a, b) => b.version - a.version),
    unscheduled: unscheduledAll.filter(
      (i) => !ancestors(parents, i.number).some((a) => unscheduledSet.has(a)),
    ),
    unscheduledTotal: unscheduledAll.length,
    children,
    parents,
    loose: looseByVersion,
  };
}

/** 打印出来的计划（Markdown 的写法，终端里直接看，也能贴进别处）。at 是读 GitHub 的时刻，只出现在第一行。 */
export function renderPlan(p: Plan, repo: string, at: Date): string {
  const lines = [`## 现在的目标（GitHub 现读：${formatAt(at)}）`, ''];
  const [last] = p.closed;
  if (p.open.length === 0) {
    lines.push(
      `现在没有开着的版本${last ? `（上一个是「${oneLine(last.milestone.title)}」，已关）` : ''}。`,
      '',
    );
  }
  for (const v of p.open) lines.push(...renderVersion(v, p, repo));
  lines.push('## 未排期', '', '没挂版本的开着的单，按单号；母单下面按 GitHub 上排的先后列子单。', '');
  if (p.unscheduled.length === 0) lines.push('没有。', '');
  for (const issue of p.unscheduled) lines.push(...renderItem(issue, '-', '', null, p, true));
  if (p.unscheduled.length) lines.push('');
  lines.push('## 已关的版本', '');
  if (p.closed.length === 0) lines.push('还没有。', '');
  for (const v of p.closed) lines.push(...renderVersion(v, p, repo));
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

function renderVersion(v: PlanVersion, p: Plan, repo: string): string[] {
  const m = v.milestone;
  const closedOn = m.closedAt ? `，${beijing(Date.parse(m.closedAt)).date}` : '';
  const openCount = v.issues.filter((i) => i.state === 'open').length;
  const out = [
    `### ${oneLine(m.title)}（${m.state === 'open' ? '开着' : `已关${closedOn}`}）`,
    '',
    `里程碑 https://github.com/${repo}/milestone/${m.number} ：${v.issues.length} 张单，开着 ${openCount} 张、关了 ${v.issues.length - openCount} 张。`,
    '',
    ...(v.before ? [v.before] : ['先后：']),
    '',
  ];
  v.ordered.forEach((issue, i) => {
    out.push(...renderItem(issue, `${i + 1}.`, '', m.title, p, true));
  });
  out.push('');
  if (v.after) out.push(v.after, '');
  if (v.unordered.length) {
    out.push('先后里没排的：', '');
    for (const issue of v.unordered) out.push(...renderItem(issue, '-', '', m.title, p, true));
    out.push('');
  }
  return out;
}

/**
 * 一张单一行，读过子单的在下面按 GitHub 上的先后缩进列出。括号里写：母单和子单关了几张、关单原因、
 * 和这一节挂的不是同一个版本（section：这一节的里程碑名，未排期是 null）、最上面一层的写它的母单。
 */
function renderItem(
  issue: PlanIssue,
  marker: string,
  indent: string,
  section: string | null,
  p: Plan,
  top: boolean,
): string[] {
  const kids = p.children.get(issue.number);
  const notes: string[] = [];
  if (kids !== undefined) {
    const done = kids.filter((k) => k.state === 'closed').length;
    const progress = kids.length ? `子单关了 ${done}/${kids.length}` : '还没有子单';
    notes.push(
      issue.labels.includes(MOTHER_LABEL) ? `母单，${progress}` : `${progress}，没贴「${MOTHER_LABEL}」标签`,
    );
  }
  if (issue.state === 'closed') notes.push(closedNote(issue.stateReason));
  if (issue.milestone !== section) {
    notes.push(issue.milestone === null ? '未排期' : `挂在「${oneLine(issue.milestone)}」`);
  }
  const parent = top ? p.parents.get(issue.number) : undefined;
  if (parent !== undefined) notes.push(`母单 #${parent}`);
  const tail = notes.length ? `（${notes.join('；')}）` : '';
  const out = [`${indent}${marker} #${issue.number} ${oneLine(issue.title)}${tail}`];
  const inner = `${indent}${' '.repeat(marker.length + 1)}`;
  (kids ?? []).forEach((kid, i) => {
    out.push(...renderItem(kid, `${i + 1}.`, inner, section, p, false));
  });
  return out;
}

function closedNote(reason: string | null): string {
  if (reason === 'completed') return '已做完';
  if (reason === 'not_planned') return '不做了';
  if (reason === 'duplicate') return '重复了';
  return '已关';
}

/** 标题、里程碑名压成一行（里面有换行、连着的空白，一行一张单的版面就乱了）。 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 时间写成北京时间：「北京时间 2026-09-27 09:00」。 */
export function formatAt(at: Date): string {
  const { date, time } = beijing(at.getTime());
  return `北京时间 ${date} ${time}`;
}

function beijing(ms: number): { date: string; time: string } {
  const iso = new Date(ms + 8 * 3_600_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export interface PlanDeps {
  /** 读 GitHub 的；拿不到令牌（没登录）时是 undefined。 */
  reader: GitHubReader | undefined;
  /** owner/名字：里程碑的链接用。 */
  repo: string;
  now(): Date;
}

export interface PlanRun {
  /** 0 = 打印出来了；2 = 没读成（没登录、GitHub 读不到、先后认不出）。 */
  code: 0 | 2;
  lines: string[];
}

export async function planCommand(argv: readonly string[], deps: PlanDeps): Promise<PlanRun> {
  const fail = (why: string): PlanRun => ({ code: 2, lines: [`没读成：${why}。`] });
  try {
    parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : [...argv],
      options: {},
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    return fail(`参数不对（${message(e)}）。${PLAN_USAGE}`);
  }
  if (deps.reader === undefined) {
    return fail(
      '没登录 GitHub（没有 GITHUB_TOKEN、GH_TOKEN，本机 gh 也没登录）：先 gh auth login，或者设好 GITHUB_TOKEN 再跑',
    );
  }
  try {
    const plan = await readPlan(deps.reader);
    const notes = planNotes(plan).map((n) => `提醒：${n}。`);
    return {
      code: 0,
      lines: [renderPlan(plan, deps.repo, deps.now()), ...(notes.length ? ['', ...notes] : [])],
    };
  } catch (e) {
    return fail(message(e));
  }
}

function hasChildren(issue: PlanIssue): boolean {
  return issue.labels.includes(MOTHER_LABEL) || (issue.subIssues ?? 0) > 0;
}

/** 从近到远的母单、母单的母单……（parents 里读得到的那几层）。 */
function ancestors(parents: ReadonlyMap<number, number>, n: number): number[] {
  const out: number[] = [];
  for (let p = parents.get(n); p !== undefined && !out.includes(p); p = parents.get(p)) out.push(p);
  return out;
}

function byNumber(issues: readonly PlanIssue[]): PlanIssue[] {
  return [...issues].sort((a, b) => a.number - b.number);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
