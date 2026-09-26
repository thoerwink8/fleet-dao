// 版本快照（#138）：pnpm plan:snapshot [--at 2026-09-27T09:00+08:00]
// 计划以 GitHub 为准（创始人 2026-09-26 晚拍，#169 第 5 件）：版本＝里程碑，版本里的先后写在里程碑说明的
// <!-- fleet:order --> 标记之间，母单、子单用 GitHub 自带的子议题。这里把它们读下来，重写 docs/plan.md 里快照标记之间的
// 三节（现在的目标、未排期、已关的版本）。每个版本开始和结束时由总指挥跑，生成的改动照常开 PR；不定时跑、不接 CI。
// 改这里之前必须知道：
// - 读不到（没登录、接口报错）、先后标记缺了或认不出、plan.md 的快照标记不对：一律不写文件、退出码 2，不拿空快照、
//   旧快照冒充。每条都在 test/plan-snapshot.test.ts 里有一条故意造出失败的测试。
// - 输出只由读到的数据和快照时间定：版本按号、单按号排，子单按 GitHub 上排的先后；文件里唯一的时间是快照时间（--at）。
// - 快照标记外面一字不动：plan.md 的 P0–P6 几节还有人在引用（PR「对应计划」的旧写法、引擎核需求文档、文档指针检查）。
import { parseArgs } from 'node:util';
import type { MilestoneDetail, PlanIssue, PlanReader } from './github-api.ts';
import { MOTHER_LABEL, milestoneVersion } from './labels.ts';
import { snapshotMarkers } from './markdown.ts';
import { PLAN_DOC } from './pr-fields.ts';

export const SNAPSHOT_USAGE =
  '用法：pnpm plan:snapshot [--at 2026-09-27T09:00+08:00]（--at 是快照时间，要带时区；不写就取现在）';

/**
 * plan.md 里快照开始、结束的两行（各占一行；认法见 markdown.ts 的 SNAPSHOT_BEGIN_LINE、SNAPSHOT_END_LINE）：
 * 生成的只写在这两行之间，文档指针、欠账检查也按这两行认出这一段、不查它。
 */
export const SNAPSHOT_BEGIN =
  '<!-- fleet:plan-snapshot：到结束标记为止由 pnpm plan:snapshot 从 GitHub 生成（#138），别手改 -->';
export const SNAPSHOT_END = '<!-- /fleet:plan-snapshot -->';

/** 版本里程碑说明里的先后标记（design 第七节「标签与里程碑」）：之间一行一张，写成「1. #169」。 */
const ORDER_BEGIN = /<!--\s*fleet:order\s*-->/g;
const ORDER_END = /<!--\s*\/fleet:order\s*-->/g;
const ORDER_LINE = /^(\d+)\.\s+#(\d+)$/;

export type OrderParse =
  | { ok: true; order: number[]; before: string; after: string }
  | { ok: false; problem: string };

/**
 * 从里程碑说明里取先后：标记恰好一对，之间一行一张（「1. #169」），序号从 1 起挨着排，同一张不写两遍。
 * before、after 是标记前后的说明原文（去掉首尾空白），快照里照抄，标记那一段换成排好的列表。
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

export interface SnapshotVersion {
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

export interface Snapshot {
  /** 开着的版本，版本号从小到大。 */
  open: SnapshotVersion[];
  /** 关了的版本，版本号从大到小。 */
  closed: SnapshotVersion[];
  /** 未排期里最上面一层（不在别的未排期单下面的），按单号。 */
  unscheduled: PlanIssue[];
  /** 未排期的开着的单一共几张（含挂在未排期母单下面的）。 */
  unscheduledTotal: number;
  /** 母单 → 子单（按 GitHub 上排的先后）；只有读过子单的才在里面。 */
  children: ReadonlyMap<number, PlanIssue[]>;
  /** 子单 → 母单。 */
  parents: ReadonlyMap<number, number>;
  /** 给总指挥看的提醒，不挡生成（快照里也照样写出来）。 */
  notes: string[];
}

/** 读 GitHub、核对先后，排好快照要写的东西。读不到、认不出就抛（一句话说清是哪、怎么改）。 */
export async function readSnapshot(gh: PlanReader): Promise<Snapshot> {
  const milestones = [...(await gh.milestoneDetails())].sort((a, b) => a.number - b.number);
  const versions: Omit<SnapshotVersion, 'issues' | 'ordered' | 'unordered'>[] = [];
  const titleOf = new Map<number, string>();
  const orders = new Map<number, number[]>();
  for (const m of milestones) {
    const version = milestoneVersion(m.title);
    if (version === undefined) continue;
    const other = titleOf.get(version);
    if (other !== undefined) {
      throw new Error(
        `「${other}」和「${m.title}」都是 v${version}：一个版本号只能有一个里程碑，改个名再生成`,
      );
    }
    titleOf.set(version, m.title);
    const parsed = parseOrder(m.description);
    if (!parsed.ok)
      throw new Error(`里程碑「${m.title}」：${parsed.problem}。改好 GitHub 上的里程碑说明再生成`);
    orders.set(m.number, parsed.order);
    versions.push({ milestone: m, version, before: parsed.before, after: parsed.after });
  }
  if (versions.length === 0) {
    const all = milestones.map((m) => `「${m.title}」`).join('') || '一个也没有';
    throw new Error(`GitHub 上一个版本（v<N> 开头的里程碑）也没有，不生成空快照；现在的里程碑：${all}`);
  }
  const versionTitles = new Set(versions.map((v) => v.milestone.title));

  const open = await gh.openPlanIssues();
  const stray = byNumber(open.filter((i) => i.milestone !== null && !versionTitles.has(i.milestone)));
  if (stray.length) {
    const list = stray.map((i) => `#${i.number}（「${i.milestone}」）`).join('、');
    throw new Error(`开着的单挂在不是版本的里程碑上，快照里没地方放：${list}。挪到版本或未排期再生成`);
  }
  const unscheduledAll = byNumber(open.filter((i) => i.milestone === null));
  const inVersion = new Map<number, PlanIssue[]>();
  for (const v of versions) {
    inVersion.set(v.milestone.number, byNumber(await gh.milestonePlanIssues(v.milestone.number)));
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
        throw new Error(
          `#${kid.number} 既在 #${known} 下面、又在 #${parent.number} 下面（多半是读的时候有人在挪子单）：再跑一次`,
        );
      }
      if (kid.number === parent.number || ancestors(parents, parent.number).includes(kid.number)) {
        throw new Error(
          `子单绕成了圈（#${parent.number} 下面又挂着 #${kid.number}）：去 GitHub 上理顺再生成`,
        );
      }
      parents.set(kid.number, parent.number);
      if (hasChildren(kid)) queue.push(kid);
    }
  }

  const notes: string[] = [];
  const laidOut = versions.map((v): SnapshotVersion => {
    const issues = inVersion.get(v.milestone.number) ?? [];
    const order = orders.get(v.milestone.number) ?? [];
    const here = new Map(issues.map((i) => [i.number, i]));
    /** 这个版本里、排在它上面最近的那张（它会列在那张下面）；没有是 undefined。 */
    const nestedUnder = (n: number) => ancestors(parents, n).find((a) => here.has(a));
    const ordered = order.map((n) => {
      const issue = here.get(n);
      if (issue === undefined) {
        throw new Error(
          `里程碑「${v.milestone.title}」的先后里有 #${n}，可它不是这个版本里的单（没挂这个里程碑，或者是 PR）：在 GitHub 上把它挂进来，或者从先后里删掉，再生成`,
        );
      }
      const under = nestedUnder(n);
      if (under !== undefined) {
        throw new Error(
          `里程碑「${v.milestone.title}」的先后里有 #${n}，可它是 #${under} 的子单：先后里只排母单和单独的单，子单的先后在母单页面上排`,
        );
      }
      return issue;
    });
    const unordered = issues.filter((i) => !order.includes(i.number) && nestedUnder(i.number) === undefined);
    const loose = unordered.filter((i) => i.state === 'open');
    if (v.milestone.state === 'open' && loose.length) {
      const list = loose.map((i) => `#${i.number}`).join('、');
      notes.push(`「${v.milestone.title}」里 ${list} 开着却没排进先后（快照里列在「先后里没排的」）`);
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
    notes,
  };
}

/** 快照标记之间的内容（不含两行标记本身）。 */
export function renderSnapshot(s: Snapshot, repo: string, at: Date): string {
  const lines = [`## 现在的目标（版本快照：${formatAt(at)}；以 GitHub 上的版本为准）`, ''];
  const [last] = s.closed;
  if (s.open.length === 0) {
    lines.push(
      `现在没有开着的版本${last ? `（上一个是「${escapeText(last.milestone.title)}」，已关）` : ''}。`,
      '',
    );
  }
  for (const v of s.open) lines.push(...renderVersion(v, s, repo));
  lines.push('## 未排期', '', '没挂版本的开着的单，按单号；母单下面按 GitHub 上排的先后列子单。', '');
  if (s.unscheduled.length === 0) lines.push('没有。', '');
  for (const issue of s.unscheduled) lines.push(...renderItem(issue, '-', '', null, s, true));
  if (s.unscheduled.length) lines.push('');
  lines.push('## 已关的版本', '');
  if (s.closed.length === 0) lines.push('还没有。', '');
  for (const v of s.closed) lines.push(...renderVersion(v, s, repo));
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

function renderVersion(v: SnapshotVersion, s: Snapshot, repo: string): string[] {
  const m = v.milestone;
  const closedOn = m.closedAt ? `，${beijing(Date.parse(m.closedAt)).date}` : '';
  const openCount = v.issues.filter((i) => i.state === 'open').length;
  const out = [
    `### ${escapeText(m.title)}（${m.state === 'open' ? '开着' : `已关${closedOn}`}）`,
    '',
    `[里程碑](https://github.com/${repo}/milestone/${m.number})：${v.issues.length} 张单，开着 ${openCount} 张、关了 ${v.issues.length - openCount} 张。`,
    '',
    ...(v.before ? markdownBlock(v.before) : ['先后：']),
    '',
  ];
  v.ordered.forEach((issue, i) => {
    out.push(...renderItem(issue, `${i + 1}.`, '', m.title, s, true));
  });
  out.push('');
  if (v.after) out.push(...markdownBlock(v.after), '');
  if (v.unordered.length) {
    out.push('先后里没排的：', '');
    for (const issue of v.unordered) out.push(...renderItem(issue, '-', '', m.title, s, true));
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
  s: Snapshot,
  top: boolean,
): string[] {
  const kids = s.children.get(issue.number);
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
    notes.push(issue.milestone === null ? '未排期' : `挂在「${escapeText(issue.milestone)}」`);
  }
  const parent = top ? s.parents.get(issue.number) : undefined;
  if (parent !== undefined) notes.push(`母单 #${parent}`);
  const tail = notes.length ? `（${notes.join('；')}）` : '';
  const out = [`${indent}${marker} #${issue.number} ${escapeText(issue.title)}${tail}`];
  const inner = `${indent}${' '.repeat(marker.length + 1)}`;
  (kids ?? []).forEach((kid, i) => {
    out.push(...renderItem(kid, `${i + 1}.`, inner, section, s, false));
  });
  return out;
}

function closedNote(reason: string | null): string {
  if (reason === 'completed') return '已做完';
  if (reason === 'not_planned') return '不做了';
  if (reason === 'duplicate') return '重复了';
  return '已关';
}

/** 标题、里程碑名照抄进 Markdown：压成一行，起 Markdown 作用的几个字符前加 \（照原样显示，也不会被当成 HTML 注释）。 */
export function escapeText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*[\]<>]/g, '\\$&');
}

/** 里程碑说明照抄：行首的 # 前加 \，免得说明里的标题打乱 plan.md 的分节（也免得被认成「### P1」这样的阶段）。 */
function markdownBlock(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/\s+$/, '').replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, '$1\\$2'));
}

/** plan.md 里两行快照标记的位置（行下标，从 0 起）；认不出返回一句为什么。 */
export function findSnapshot(text: string): { begin: number; end: number } | string {
  const { begins, ends } = snapshotMarkers(text.replace(/\r\n?/g, '\n').split('\n'));
  const [begin] = begins;
  const [end] = ends;
  if (begin === undefined && end === undefined) {
    return `${PLAN_DOC} 里没有快照标记（开始、结束各一行 HTML 注释），不知道往哪写`;
  }
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined) {
    return `${PLAN_DOC} 里的快照标记要恰好一对，现在开始的有 ${begins.length} 行、结束的有 ${ends.length} 行`;
  }
  if (end < begin) return `${PLAN_DOC} 里快照的结束标记写在了开始标记前面`;
  return { begin, end };
}

/** 把 plan.md 快照标记之间换成 block，标记外面一字不动（换行统一成 \n）。标记认不出、换完不成对就抛。 */
export function spliceSnapshot(text: string, block: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const at = findSnapshot(normalized);
  if (typeof at === 'string') throw new Error(at);
  const lines = normalized.split('\n');
  const next = [
    ...lines.slice(0, at.begin),
    SNAPSHOT_BEGIN,
    '',
    block,
    '',
    SNAPSHOT_END,
    ...lines.slice(at.end + 1),
  ].join('\n');
  if (typeof findSnapshot(next) === 'string') {
    throw new Error('生成的快照里混进了快照标记（多半是哪个里程碑说明里写了）：去 GitHub 上删掉再生成');
  }
  return next;
}

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** --at 的值：ISO 时间，必须带时区（Z 或 +08:00）；认不出返回 undefined。 */
export function parseAt(value: string): Date | undefined {
  if (!AT.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/** 快照时间写成北京时间：「北京时间 2026-09-27 09:00」（不带括号：标题末尾的括号里再套括号，别处就指不到这个标题了）。 */
export function formatAt(at: Date): string {
  const { date, time } = beijing(at.getTime());
  return `北京时间 ${date} ${time}`;
}

function beijing(ms: number): { date: string; time: string } {
  const iso = new Date(ms + 8 * 3_600_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export interface PlanSnapshotDeps {
  /** 读 GitHub 的；拿不到令牌（没登录）时是 undefined。 */
  reader: PlanReader | undefined;
  /** owner/名字：里程碑的链接用。 */
  repo: string;
  /** 读 docs/plan.md；读不到返回 undefined。 */
  read(): string | undefined;
  /** 写 docs/plan.md；写不成就抛。 */
  write(text: string): void;
  now(): Date;
}

export interface SnapshotRun {
  /** 0 = 写好了（或者和原来一样）；2 = 没生成，docs/plan.md 没动。 */
  code: 0 | 2;
  lines: string[];
}

export async function planSnapshot(argv: readonly string[], deps: PlanSnapshotDeps): Promise<SnapshotRun> {
  const fail = (why: string): SnapshotRun => ({ code: 2, lines: [`没生成：${why}。${PLAN_DOC} 没动。`] });
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let at: Date;
  try {
    const { values } = parseArgs({
      args,
      options: { at: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    const parsed = values.at === undefined ? deps.now() : parseAt(values.at.trim());
    if (parsed === undefined) throw new Error(`--at 的「${values.at}」认不出`);
    at = parsed;
  } catch (e) {
    return fail(`参数不对（${message(e)}）。${SNAPSHOT_USAGE}`);
  }
  if (deps.reader === undefined) {
    return fail(
      '没登录 GitHub（没有 GITHUB_TOKEN、GH_TOKEN，本机 gh 也没登录）：先 gh auth login，或者设好 GITHUB_TOKEN 再跑',
    );
  }
  const current = deps.read();
  if (current === undefined) return fail(`读不到 ${PLAN_DOC}`);
  const where = findSnapshot(current);
  if (typeof where === 'string') return fail(where);
  let snap: Snapshot;
  let next: string;
  try {
    snap = await readSnapshot(deps.reader);
    next = spliceSnapshot(current, renderSnapshot(snap, deps.repo, at));
  } catch (e) {
    return fail(message(e));
  }
  const versions = snap.open.map((v) => `「${v.milestone.title}」`).join('') || '没有';
  const summary = `${formatAt(at)} 的快照；开着的版本：${versions}；未排期 ${snap.unscheduledTotal} 张；已关的版本 ${snap.closed.length} 个`;
  const notes = snap.notes.map((n) => `提醒：${n}。`);
  if (next === current)
    return { code: 0, lines: [`${PLAN_DOC} 的版本快照和原来一样（${summary}）。`, ...notes] };
  try {
    deps.write(next);
  } catch (e) {
    return {
      code: 2,
      lines: [`没写成：${PLAN_DOC}（${message(e)}）。它可能只写了一半，先 git diff 看一眼。`],
    };
  }
  return {
    code: 0,
    lines: [`写好了 ${PLAN_DOC} 的版本快照（${summary}）：git diff 看一眼，照常开 PR。`, ...notes],
  };
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
