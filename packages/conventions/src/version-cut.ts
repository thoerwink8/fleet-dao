// 版本收口（#2683，照 Linear Cycles）：版本＝一周的时间盒，到期自动收口，开着的单滚到下一版。
// 每天由 .github/workflows/github-audit.yml 的 version-cut 任务跑一次（也能手动触发）：node packages/conventions/src/bin/version-cut.ts。
//
// 规则：
// - 永远只开一个 v<N> 版本，带到期日；标题写成「v<N> MM-DD～MM-DD」，后面可以接一句目标。
// - 北京时间过了到期日（到期日当天还算这一版）→ 先开 v<N+1>（到期日 +7 天）→ 开着的单逐张先留一句再挪过去 → 旧版先后段整段接到
//   新版先后的最前面 → 旧版说明末尾写收口段（关了几张、完成/不做/重复各几、滚过去的单号、收口时主线头）→ 关旧版 → 回读核对。
// - 兜底：有人手工关了版本、里面还挂着开着的单，同一份代码把它们挪到开着的那一版；一个开着的版本都没有就先开一个（今天起 7 天）。
//
// 改这里之前必须知道：
// - 哪一步没成都不往下走：挪单没挪全就不关旧版，退出码非 0；下一次跑从断的地方接着走（旧版过期、新版已开的这一对认得出），不开第二个新版。
// - 同一天重跑不出重复：留言按标记认、先后按单号去重、收口段按标记整段换掉。
// - 读不到、认不出就停：不拿「没读到」当成「没有要挪的单」。
// - 每条规则在 test/version-cut.test.ts 里有例子。

import type { GitHubVersionWriter, MilestoneDetail, PlanIssue } from './github-api.ts';
import { milestoneVersion } from './labels.ts';
import { addToOrder, parseOrder } from './plan-view.ts';

/** 收口要读的几样（GitHubReader 的子集）加写的几样、主线头。 */
export interface VersionCutGitHub extends GitHubVersionWriter {
  milestones(): Promise<MilestoneDetail[]>;
  /** 这个里程碑里的 issue，开着的、关了的都要（不含 PR）。 */
  milestoneIssues(milestone: number): Promise<PlanIssue[]>;
  comments(n: number): Promise<string[]>;
  comment(n: number, body: string): Promise<void>;
  /** 主线头（40 位）：写进收口段。 */
  mainHead(): Promise<string>;
}

export interface CutResult {
  /** 做了什么，一行一件（给人看）。 */
  lines: string[];
  /** 要人去看的（开着的版本不止一个、当前版本没设到期日……）：退出码 1。 */
  problems: string[];
  /** 读不到、写不成、回读对不上：退出码 2，旧版不关。 */
  failed: string[];
}

/** 一周。 */
const WEEK = 7;
const ORDER_EMPTY = '<!-- fleet:order -->\n<!-- /fleet:order -->';
const CUT_BEGIN = '<!-- fleet:cut -->';
const CUT_END = '<!-- /fleet:cut -->';
const CUT_BLOCK = /<!--\s*fleet:cut\s*-->[\s\S]*?<!--\s*\/fleet:cut\s*-->/;

/** 北京时间的日期 YYYY-MM-DD。 */
export function beijingDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 日期加几天（按日历日，不受时区影响）。 */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 到期日：GitHub 的 due_on 只有日期那部分算数。没设是 null，接口没给是 undefined。 */
export function dueDateOf(m: Pick<MilestoneDetail, 'dueOn'>): string | null | undefined {
  if (m.dueOn === undefined) return undefined;
  if (m.dueOn === null) return null;
  return /^\d{4}-\d{2}-\d{2}/.exec(m.dueOn)?.[0] ?? undefined;
}

/** 新版本的标题：「v<N> MM-DD～MM-DD」（起止都是北京时间的日期）。 */
export function versionTitle(version: number, start: string, end: string): string {
  return `v${version} ${start.slice(5)}～${end.slice(5)}`;
}

/** 写进 GitHub 的到期时刻：那一天的最后一秒（GitHub 只认日期，回读时核日期对不对）。 */
function dueOnOf(date: string): string {
  return `${date}T23:59:59Z`;
}

/** 这一版过期了没有：北京时间的今天在到期日之后（到期日当天还算这一版）。 */
export function expired(due: string, now: Date): boolean {
  return beijingDate(now) > due;
}

/** 留在单上的那一句：带标记，重跑时按标记认出已经留过。 */
function rollComment(from: string, to: string, why: string): { key: string; body: string } {
  const key = `<!-- fleet:version-cut ${milestoneVersion(from) ?? from}→${milestoneVersion(to) ?? to} -->`;
  return { key, body: `${key}\n${why}，这张单还开着，挪到「${to}」接着做（packages/conventions/src/version-cut.ts）。` };
}

/**
 * 新版的先后：旧版先后里还开着、已经挪进新版的那些整段放最前面，后面接新版自己原来排的（去重）。
 * 一张也接不上、新版也还空着，就把挪过来的顶层单（不在挪过来的单下面的）按号排进去，免得留一段空先后（pnpm plan 认作问题）。
 */
export function rollOrder(
  oldDescription: string,
  newDescription: string,
  inNew: readonly PlanIssue[],
): { ok: true; description: string; order: number[] } | { ok: false; problem: string } {
  const openInNew = new Set(inNew.filter((i) => i.state === 'open').map((i) => i.number));
  const old = parseOrder(oldDescription);
  const carried = old.ok ? old.order.filter((n) => openInNew.has(n)) : [];
  const current = parseOrder(newDescription);
  const existing = current.ok ? current.order : [];
  let wanted = [...carried, ...existing.filter((n) => !carried.includes(n))];
  if (wanted.length === 0) {
    wanted = inNew
      .filter((i) => i.state === 'open' && (i.parent === undefined || !openInNew.has(i.parent)))
      .map((i) => i.number)
      .sort((a, b) => a - b);
  }
  // 标记之间整段按 wanted 重写：先清成空段，再一张张加（写法和认法都是 plan-view 那一份）
  const blank = newDescription.replace(/<!--\s*fleet:order\s*-->[\s\S]*?<!--\s*\/fleet:order\s*-->/, ORDER_EMPTY);
  if (blank === newDescription && !/<!--\s*fleet:order\s*-->/.test(newDescription)) {
    return { ok: false, problem: `新版说明里没有先后标记，接不上先后` };
  }
  let description = blank;
  for (const n of wanted) {
    const added = addToOrder(description, n);
    if (!added.ok) return { ok: false, problem: added.problem };
    description = added.description;
  }
  return { ok: true, description, order: wanted };
}

/** 收口段里记的滚过去的单号（重跑时并上，上一次已经挪走的也算）。 */
function rolledFrom(description: string): number[] {
  const block = CUT_BLOCK.exec(description)?.[0] ?? '';
  const line = block.split('\n').find((l) => l.startsWith('- 滚到')) ?? '';
  return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/** 收口段：关了几张（按关单原因分）、滚过去的单号、主线头。写在说明末尾，按标记整段换。 */
export function cutSection(input: {
  issues: readonly PlanIssue[];
  rolled: readonly number[];
  to: string;
  head: string;
  at: Date;
  done: boolean;
}): string {
  const closed = input.issues.filter((i) => i.state === 'closed');
  const count = (reason: string) => closed.filter((i) => i.stateReason === reason).length;
  const other = closed.length - count('completed') - count('not_planned') - count('duplicate');
  const rolled = [...new Set(input.rolled)].sort((a, b) => a - b);
  const at = new Date(input.at.getTime() + 8 * 3_600_000).toISOString();
  return [
    CUT_BEGIN,
    `## 收口（北京时间 ${at.slice(0, 10)} ${at.slice(11, 16)}${input.done ? '' : '，收口中、还没关'}）`,
    '',
    `- 关了 ${closed.length} 张：完成 ${count('completed')}、不做 ${count('not_planned')}、重复 ${count('duplicate')}${other ? `、别的 ${other}` : ''}`,
    `- 滚到「${input.to}」：${rolled.length ? `${rolled.map((n) => `#${n}`).join('、')}（${rolled.length} 张）` : '没有'}`,
    `- 收口时主线头：${input.head}`,
    CUT_END,
  ].join('\n');
}

function withCutSection(description: string, section: string): string {
  if (CUT_BLOCK.test(description)) return description.replace(CUT_BLOCK, section);
  return `${description.replace(/\s+$/, '')}\n\n${section}`;
}

interface Version {
  milestone: MilestoneDetail;
  version: number;
}

function versionsOf(milestones: readonly MilestoneDetail[]): Version[] {
  const out: Version[] = [];
  for (const m of milestones) {
    const version = milestoneVersion(m.title);
    if (version !== undefined) out.push({ milestone: m, version });
  }
  return out.sort((a, b) => a.version - b.version);
}

/** 跑一轮收口。只在这里写 GitHub；判断都在上面的纯函数里。 */
export async function cutVersions(gh: VersionCutGitHub, now: Date): Promise<CutResult> {
  const r: CutResult = { lines: [], problems: [], failed: [] };
  let all: Version[];
  try {
    all = versionsOf(await gh.milestones());
  } catch (e) {
    r.failed.push(`读不到里程碑（${message(e)}），这一轮什么也没做`);
    return r;
  }
  const open = all.filter((v) => v.milestone.state === 'open');
  const today = beijingDate(now);

  let current: Version | undefined;
  if (open.length === 0) {
    // 兜底：一个开着的版本都没有（有人手工关了）：今天起开一版
    const next = (all.at(-1)?.version ?? 0) + 1;
    const end = addDays(today, WEEK - 1);
    const made = await openVersion(gh, next, today, end, r);
    if (!made) return r;
    current = made;
  } else if (open.length === 1) {
    current = open[0];
  } else if (open.length === 2 && open[1] && open[0] && open[1].version === open[0].version + 1) {
    // 上一轮收口断在半路：旧版过期了、新版已经开了，接着走（不开第二个新版）
    const due = dueDateOf(open[0].milestone);
    if (typeof due === 'string' && expired(due, now)) {
      await rollOver(gh, open[0], open[1], now, r);
      current = open[1];
    } else {
      r.problems.push(
        `开着两个版本（${open.map((v) => `「${v.milestone.title}」`).join('')}），前一个还没过期：只该开一个，手工关掉多开的那个`,
      );
      return r;
    }
  } else {
    r.problems.push(
      `开着的 v<N> 版本有 ${open.length} 个（${open.map((v) => `「${v.milestone.title}」`).join('')}）：只该开一个，手工理顺再跑`,
    );
    return r;
  }
  if (!current || r.failed.length) return r;

  if (open.length === 1) {
    const due = dueDateOf(current.milestone);
    if (due === undefined) {
      r.failed.push(`读回来的「${current.milestone.title}」认不出到期日（due_on），这一轮不收口`);
      return r;
    }
    if (due === null) {
      r.problems.push(`当前版本「${current.milestone.title}」没设到期日：在里程碑页上设一个（一周一版），设了才会到期自动收口`);
    } else if (expired(due, now)) {
      const next = await openVersion(gh, current.version + 1, addDays(due, 1), addDays(due, WEEK), r);
      if (!next) return r;
      await rollOver(gh, current, next, now, r);
      if (r.failed.length) return r;
      current = next;
    } else {
      r.lines.push(`「${current.milestone.title}」${due} 到期，还没过期，什么也不做。`);
    }
  }

  // 兜底：已关的版本里还挂着开着的单，挪到当前版本
  for (const v of all) {
    if (v.milestone.state !== 'closed' || v.milestone.number === current.milestone.number) continue;
    await sweepClosed(gh, v, current, r);
  }
  return r;
}

/** 开新版本（同号的已经有了就用它，不开第二个），回读核对到期日。没成记 failed、回 undefined。 */
async function openVersion(
  gh: VersionCutGitHub,
  version: number,
  start: string,
  end: string,
  r: CutResult,
): Promise<Version | undefined> {
  const title = versionTitle(version, start, end);
  let made: MilestoneDetail;
  try {
    made = await gh.createMilestone({
      title,
      description: `一周一版，到期自动收口（packages/conventions/src/version-cut.ts）。\n\n${ORDER_EMPTY}`,
      dueOn: dueOnOf(end),
    });
  } catch (e) {
    r.failed.push(`没开成「${title}」（${message(e)}），旧版不收口`);
    return undefined;
  }
  if (milestoneVersion(made.title) !== version || dueDateOf(made) !== end || made.state !== 'open') {
    r.failed.push(
      `开了「${made.title}」，可回读对不上（要的是 v${version}、${end} 到期、开着；读回来到期日 ${String(made.dueOn)}、${made.state}）：先打开看一眼`,
    );
    return undefined;
  }
  r.lines.push(`开了「${made.title}」（${end} 到期）。`);
  return { milestone: made, version };
}

/** 到期收口：挪单 → 接先后 → 写收口段 → 关旧版 → 回读。哪一步没成都记 failed、不往下走。 */
async function rollOver(gh: VersionCutGitHub, from: Version, to: Version, now: Date, r: CutResult): Promise<void> {
  const fromTitle = from.milestone.title;
  const toTitle = to.milestone.title;
  let issues: PlanIssue[];
  let head: string;
  try {
    issues = await gh.milestoneIssues(from.milestone.number);
    head = await gh.mainHead();
  } catch (e) {
    r.failed.push(`读不到「${fromTitle}」里的单或主线头（${message(e)}），旧版不关`);
    return;
  }
  const moving = issues.filter((i) => i.state === 'open').map((i) => i.number);
  const rolled = [...new Set([...rolledFrom(from.milestone.description), ...moving])];

  // 先把要滚的单记进旧版说明（收口中）：挪到一半断了，下一次跑还知道哪些滚过
  let fromDescription = from.milestone.description;
  if (moving.length) {
    const draft = withCutSection(
      fromDescription,
      cutSection({ issues, rolled, to: toTitle, head, at: now, done: false }),
    );
    try {
      fromDescription = (await gh.setMilestoneDescription(from.milestone.number, draft)).description;
    } catch (e) {
      r.failed.push(`没把收口记进「${fromTitle}」的说明（${message(e)}），一张单也没挪，旧版不关`);
      return;
    }
  }

  const why = `版本「${fromTitle}」到期收口（北京时间 ${beijingDate(now)}）`;
  const moved = await moveAll(gh, moving, fromTitle, to, why, r);
  if (moved.length !== moving.length) {
    r.failed.push(`「${fromTitle}」还有 ${moving.length - moved.length} 张单没挪过去，旧版不关；下一轮接着挪`);
    return;
  }

  // 先后：旧版先后整段接到新版最前
  try {
    const inNew = await gh.milestoneIssues(to.milestone.number);
    const next = rollOrder(fromDescription, to.milestone.description, inNew);
    if (!next.ok) {
      r.failed.push(`「${toTitle}」的先后没接上（${next.problem}），旧版不关`);
      return;
    }
    if (next.description !== to.milestone.description) {
      const back = await gh.setMilestoneDescription(to.milestone.number, next.description);
      const check = parseOrder(back.description);
      const got = check.ok ? check.order : [];
      if (got.join() !== next.order.join()) {
        r.failed.push(`「${toTitle}」的先后改完回读对不上（要 ${next.order.join('、')}，读回来 ${got.join('、')}），旧版不关`);
        return;
      }
      to.milestone = back;
      r.lines.push(`「${toTitle}」的先后接上了：${next.order.map((n) => `#${n}`).join('、') || '空'}。`);
    }
  } catch (e) {
    r.failed.push(`「${toTitle}」的先后没接上（${message(e)}），旧版不关`);
    return;
  }

  // 收口段写定、关旧版、回读
  try {
    const finalIssues = await gh.milestoneIssues(from.milestone.number);
    const left = finalIssues.filter((i) => i.state === 'open');
    if (left.length) {
      r.failed.push(`「${fromTitle}」里又冒出开着的单 ${left.map((i) => `#${i.number}`).join('、')}，旧版不关；下一轮接着挪`);
      return;
    }
    const section = cutSection({ issues: finalIssues, rolled, to: toTitle, head, at: now, done: true });
    await gh.setMilestoneDescription(from.milestone.number, withCutSection(fromDescription, section));
    const closed = await gh.closeMilestone(from.milestone.number);
    if (closed.state !== 'closed') {
      r.failed.push(`关「${fromTitle}」回读还是 ${closed.state}：先打开看一眼`);
      return;
    }
    const after = versionsOf(await gh.milestones()).filter((v) => v.milestone.state === 'open');
    if (after.length !== 1 || after[0]?.milestone.number !== to.milestone.number) {
      r.failed.push(
        `收口完回读，开着的版本是 ${after.map((v) => `「${v.milestone.title}」`).join('') || '一个也没有'}，不是只有「${toTitle}」：先打开看一眼`,
      );
      return;
    }
  } catch (e) {
    r.failed.push(`「${fromTitle}」没收完口（${message(e)}）：单都挪过去了，下一轮接着关`);
    return;
  }
  r.lines.push(
    `「${fromTitle}」收口：关了，${rolled.length ? `滚到「${toTitle}」${rolled.length} 张（${rolled.map((n) => `#${n}`).join('、')}）` : '没有要滚的单'}。`,
  );
}

/** 已关的版本里还挂着开着的单（有人手工关了）：挪到当前版本、各留一句。 */
async function sweepClosed(gh: VersionCutGitHub, closed: Version, current: Version, r: CutResult): Promise<void> {
  let left: number[];
  try {
    left = (await gh.milestoneIssues(closed.milestone.number)).filter((i) => i.state === 'open').map((i) => i.number);
  } catch (e) {
    r.failed.push(`读不到已关的「${closed.milestone.title}」里的单（${message(e)}），没核它还挂没挂着开着的单`);
    return;
  }
  if (left.length === 0) return;
  const why = `版本「${closed.milestone.title}」已经关了`;
  const moved = await moveAll(gh, left, closed.milestone.title, current, why, r);
  if (moved.length) {
    r.lines.push(
      `已关的「${closed.milestone.title}」还挂着开着的单，挪到「${current.milestone.title}」：${moved.map((n) => `#${n}`).join('、')}。`,
    );
  }
}

/** 逐张先留一句（按标记认，留过不再留）再挪。回挪成了的号；没成的记 failed。 */
async function moveAll(
  gh: VersionCutGitHub,
  numbers: readonly number[],
  fromTitle: string,
  to: Version,
  why: string,
  r: CutResult,
): Promise<number[]> {
  const moved: number[] = [];
  const note = rollComment(fromTitle, to.milestone.title, why);
  for (const n of numbers) {
    try {
      const said = (await gh.comments(n)).some((c) => c.includes(note.key));
      if (!said) await gh.comment(n, note.body);
      await gh.setIssueMilestone(n, to.milestone.number);
      moved.push(n);
    } catch (e) {
      r.failed.push(`#${n} 没挪到「${to.milestone.title}」（${message(e)}）`);
    }
  }
  return moved;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
