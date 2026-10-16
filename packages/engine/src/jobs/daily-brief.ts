// 每日简报（决定 0096：放法国引擎定时任务；创始人规矩：只为四类事和 AI 判定要他的事即时打扰他，其余每天早上看一条）。
// 每天 08:30（北京时间）一轮：昨天上线了什么（版本 + 一句话）、要你拍的（带链接）、失败了要你看的、关键指标（开单→上线中位、一轮做成率）、
// 写成一行提醒（键 feishu:brief:<北京日期>，驾驶舱后端马上推飞书团队群），
// 同时用引擎机器人在置顶进度单 #1055 发一条评论（GitHub 会通知创始人）。
// 一节最多列 15 条，多出来的只写「另 N 条」。发版开始、成功不再写通知（#2368），简报没有「日报」一节。
// 简报自己那一行（feishu:brief:）是日报级，开满 48 小时由每小时对账收（jobs/alert-sweep.ts），飞书要它还开着才推。
// 改这里之前必须知道：
// - 不拉单、不起会话：不标 needsMaster（总开关每次发版都会关，标了简报常常发不出去）。
// - 上线以发布历史（发布目录的 .history：时间 提交号 事件 [unmerged]）为准：release、rollback、auto-rollback 是切过去，unhealthy、recovered 不换在用版本，
//   unmerged 的不算（不在主线上）。昨天零点在用的 → 今天零点在用的之间的提交就是昨天上线的（GitHub compare，最多列最近 100 个）；
//   每个提交第一次上线的时刻取昨天第一个包含它的版本切过去的时刻。
//   「昨天上线了什么」按 PR 关的单归并成每单一行、没挂单的合成一行计数，整节不超过 SHIPPED_MAX_LINES 行（一天几十个 PR 也一屏读完），见 shippedByIssue。
// - 某一块读不到：那一块写「没查成：原因」，照样发，这一轮记 partial；提醒写不进库、#1055 评论没发成：记 failed 再抛（看门狗、巡检按
//   @fleet-dao/db 的 dailyBriefProblem 报「今天的简报没送到」，只此一处判）。
// - 公开仓：#1055 的评论里不写驾驶舱的地址（私有值），只写「驾驶舱里看」；单子、PR 写 GitHub 链接。飞书那条后端会接上驾驶舱链接。
// - 零点到 08:30 之间起来、定时器补的是昨天那一格：不发、记 unscanned（发了就占了今天的键，08:30 那一轮只能原地更新、不再推）。
// - 同一天再跑（重启补跑、手动触发）：定时那条键不变，提醒原地更新、不再推第二次，#1055 同一个键只发一条；手动触发（fleet-api daily-brief）
//   用另一个键和另一个标题，不冒充当天定时那一条（看门狗只认定时那一条）。
import {
  type BriefNote,
  type BriefPull,
  type BriefStoppedTask,
  beijingDay,
  DAILY_BRIEF_AT_MINUTES,
  DAILY_BRIEF_JOB_ID,
  dailyBriefKey,
  type ExecutorLineStat,
  type ScheduleResult,
} from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { clip, stamp } from './reconcile-common.ts';

export const DAILY_BRIEF_EVERY_MINUTES = 24 * 60;
/** 每天 08:30（北京时间，UTC+8）= 00:30 UTC：从 epoch（00:00 UTC）起错开 30 分钟。 */
export const DAILY_BRIEF_OFFSET_MINUTES = 30;

export const DAILY_BRIEF_JOB = {
  id: DAILY_BRIEF_JOB_ID,
  name: '每日简报（推飞书 + #1055）',
  schedule: '每天 08:30（北京时间）',
  // 两天没跑成才算过期：一天一次，多给一格余量（当天没送到由看门狗的「每日简报没送到」报，不靠这条）。
  expectEveryMinutes: DAILY_BRIEF_EVERY_MINUTES * 2,
} as const;

/** 置顶进度单（packages/conventions 的 PROGRESS_ISSUE）。 */
export const BRIEF_ISSUE = 1055;
/** 简报那一行提醒点进去看的驾驶舱页面。 */
export const BRIEF_LINK = '/notifications';
/** 「昨天上线了什么」整节最多几行（含头一行和收尾链接），一屏读完。 */
const SHIPPED_MAX_LINES = 10;
/** 其余几块每块最多列几条（多的写「另 N 条」）。 */
const LIST_MAX = { decisions: 15, alerts: 10, stopped: 10 } as const;

/** 定时那一条的标题（#1055 上今天的简报按这几个字认）。 */
export const briefTitle = (day: string): string => `【每日简报】${day}`;
/** 手动触发那一条的标题：不和定时那条同名，不冒充定时的送到了。 */
export const manualBriefTitle = (day: string): string => `【每日简报·手动触发】${day}`;

/** 发布历史的一条切版本。 */
export interface LiveSwitch {
  at: Date;
  sha: string;
}

/** 发布历史原文 → 按时间排好的切版本（unmerged 的、不换在用版本的事件不要）。认不出的行照抛（不当成没有上线）。 */
export function liveSwitches(history: string): LiveSwitch[] {
  const out: LiveSwitch[] = [];
  for (const raw of history.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const [at, sha, event, tag] = line.split(/\s+/);
    const t = at ? Date.parse(at) : Number.NaN;
    if (!sha || !event || Number.isNaN(t) || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`发布历史有一行认不出：「${line.slice(0, 80)}」`);
    }
    if (tag === 'unmerged') continue;
    if (event === 'release' || event === 'rollback' || event === 'auto-rollback')
      out.push({ at: new Date(t), sha });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** before 之前（不含）最后切过去的那一版；没有是 null。 */
export function liveAt(switches: readonly LiveSwitch[], before: Date): LiveSwitch | null {
  let last: LiveSwitch | null = null;
  for (const s of switches) {
    if (s.at.getTime() >= before.getTime()) break;
    last = s;
  }
  return last;
}

export interface CompareResult {
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  aheadBy: number;
  /** head 一侧的提交，新到旧，最多 100 个。 */
  recent: { sha: string; title: string }[];
}

export interface DailyBriefDeps {
  /** 发布历史原文；这台没有发布目录（不是法国）回 null。读不到照抛。 */
  history(): Promise<string | null>;
  /** 自己这个仓（fleet-dao）在 GitHub 上的 owner/name。认不出照抛。 */
  selfRepo(): Promise<{ owner: string; name: string; id: string }>;
  compare(repo: { owner: string; name: string }, base: string, head: string): Promise<CompareResult>;
  pulls(repoId: string, shas: readonly string[]): Promise<BriefPull[]>;
  /** 库里没登记标题的单（不是引擎拉的、本机登记漏的）现去 GitHub 读标题。读不到照抛（简报里写「标题没查成」）。 */
  issueTitle(repo: { owner: string; name: string }, number: number): Promise<string>;
  decisions(): Promise<BriefNote[]>;
  alerts(): Promise<BriefNote[]>;
  stopped(from: Date, to: Date): Promise<BriefStoppedTask[]>;
  /** pnpm line:stats 同一条查询（@fleet-dao/db 的 executorLineStats）。 */
  lineStats(now: Date): Promise<ExecutorLineStat[]>;
  /** 写那一行提醒（有就原地更新）。写不进照抛。 */
  publish(input: { dedupeKey: string; title: string; body: string; link: string }): Promise<void>;
  /** 在 #1055 发评论（幂等：同一个 key 只发一条）。没发成照抛。 */
  comment(input: {
    repo: { owner: string; name: string };
    issueNumber: number;
    key: string;
    body: string;
  }): Promise<{
    url: string;
  }>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export class DailyBriefFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'DailyBriefFailedError';
    this.runId = runId;
  }
}

/** 一块：标题、几行；读不到时 unread 是原因（行里写「没查成：…」）。 */
export interface BriefSection {
  heading: string;
  lines: string[];
  unread?: string;
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const mins = (v: number | null) => (v === null ? '—' : `${Math.round(v)} 分钟`);
const issueUrl = (i: { repo: string; number: number }) => `https://github.com/${i.repo}/issues/${i.number}`;

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function more(n: number, shown: number): string[] {
  return n > shown ? [`……另 ${n - shown} 条`] : [];
}

/** 昨天上线了什么，外加每个上线的 PR 从开单到上线几分钟（给关键指标用）。 */
async function shippedSection(
  deps: DailyBriefDeps,
  from: Date,
  to: Date,
): Promise<{ section: BriefSection; leadMinutes: number[] | null }> {
  const heading = '一、昨天上线了什么';
  const history = await deps.history();
  if (history === null) {
    const why = '这台没有发布目录（不是法国），读不到发布历史';
    return { section: { heading, lines: [`没查成：${why}`], unread: why }, leadMinutes: null };
  }
  const switches = liveSwitches(history);
  const start = liveAt(switches, from);
  const end = liveAt(switches, to);
  if (!end) {
    const why = '发布历史里没有切过版本';
    return { section: { heading, lines: [`没查成：${why}`], unread: why }, leadMinutes: null };
  }
  const inWindow = switches.filter((s) => s.at >= from && s.at < to);
  const base = start ?? inWindow[0] ?? end;
  const head = `在用版本 ${end.sha.slice(0, 7)}（${stamp(end.at)} 切过去）`;
  if (base.sha === end.sha) {
    return {
      section: {
        heading,
        lines: [
          `没有新上线的。${head}${inWindow.length > 0 ? `，昨天切了 ${inWindow.length} 次又回到它` : ''}`,
        ],
      },
      leadMinutes: [],
    };
  }
  const repo = await deps.selfRepo();
  const net = await deps.compare(repo, base.sha, end.sha);
  if (net.status !== 'ahead') {
    return {
      section: {
        heading,
        lines: [
          `${head}；比前天末在用的 ${base.sha.slice(0, 7)} 不是更新（GitHub 说 ${net.status}），像是退回了旧版本，要看发版页`,
        ],
      },
      leadMinutes: [],
    };
  }
  // 每个提交第一次上线的时刻：昨天第一个包含它的版本切过去的时刻
  const firstLive = new Map<string, Date>();
  for (const s of inWindow) {
    if (s.sha === base.sha) continue;
    const c = s.sha === end.sha ? net : await deps.compare(repo, base.sha, s.sha);
    if (c.status !== 'ahead') continue;
    for (const commit of c.recent) if (!firstLive.has(commit.sha)) firstLive.set(commit.sha, s.at);
  }
  const commits = net.recent;
  // PR↔单的关联读不到：这一节照样发（提交数、compare 链接），写明没查成，不拿空冒充「没有单」
  let pulls: BriefPull[] = [];
  let unread: string | undefined;
  try {
    pulls = await deps.pulls(
      repo.id,
      commits.map((c) => c.sha),
    );
  } catch (err) {
    unread = `读 PR 和单的关联：${errMessage(err)}`;
  }
  const bySha = new Map(pulls.map((p) => [p.mergeSha, p]));
  const leadMinutes: number[] = [];
  for (const c of commits) {
    const p = bySha.get(c.sha);
    const live = firstLive.get(c.sha) ?? end.at;
    if (p?.issueOpenedAt) leadMinutes.push((live.getTime() - p.issueOpenedAt.getTime()) / 60_000);
  }
  const compare = `https://github.com/${repo.owner}/${repo.name}/compare/${base.sha.slice(0, 12)}...${end.sha.slice(0, 12)}`;
  const lines = [
    `${head}，比前天末在用的 ${base.sha.slice(0, 7)} 多 ${net.aheadBy} 个提交${net.aheadBy > commits.length ? `（只看最近 ${commits.length} 个）` : ''}：`,
  ];
  if (unread !== undefined) {
    lines.push(`没查成：${unread}，没法按单归并；提交清单看 compare：${compare}`);
    return { section: { heading, lines, unread }, leadMinutes: null };
  }
  lines.push(...(await shippedByIssue(commits, bySha, repo, compare, (n) => deps.issueTitle(repo, n))));
  return { section: { heading, lines }, leadMinutes };
}

/** 创始人引导、决定相关的单排在前面（标题里带这几个词）。 */
const FOUNDER_RE = /创始人|引导|决定s*d{3,4}|directive/i;

/**
 * 昨天上线的提交按「关掉的单」归并：每单一行（标题、合了几个 PR、单链接），没挂单的 PR 合成一行计数。
 * 行数（含这一段的收尾链接）不超过 SHIPPED_MAX_LINES，超出的单按「创始人引导/决定相关、PR 多、单号大」的顺序留前面，其余折进「另 N 张单」+ compare 链接。
 */
export async function shippedByIssue(
  commits: readonly { sha: string; title: string }[],
  bySha: ReadonlyMap<string, BriefPull>,
  repo: { owner: string; name: string },
  compare: string,
  issueTitle: (number: number) => Promise<string>,
): Promise<string[]> {
  const prs = new Map<number, BriefPull>();
  let noPr = 0;
  for (const c of commits) {
    const p = bySha.get(c.sha);
    if (p) prs.set(p.number, p);
    else noPr++;
  }
  const byIssue = new Map<number, { title: string | null; prs: BriefPull[] }>();
  let noIssue = 0;
  for (const p of prs.values()) {
    // 置顶进度单 #1055 不是需求单：PR 只是提到它，不按它归并
    const issues = p.issues.filter((i) => i.number !== BRIEF_ISSUE);
    if (issues.length === 0) noIssue++;
    for (const i of issues) {
      const e = byIssue.get(i.number) ?? { title: i.title, prs: [] };
      e.title ??= i.title;
      e.prs.push(p);
      byIssue.set(i.number, e);
    }
  }
  const founder = (e: { title: string | null; prs: BriefPull[] }) =>
    FOUNDER_RE.test(`${e.title ?? ''} ${e.prs.map((p) => p.title ?? '').join(' ')}`);
  const ranked = [...byIssue.entries()].sort(
    ([an, a], [bn, b]) => Number(founder(b)) - Number(founder(a)) || b.prs.length - a.prs.length || bn - an,
  );
  const loose: string[] = [];
  if (noIssue > 0) loose.push(`没挂单的 PR ${noIssue} 个`);
  if (noPr > 0) loose.push(`${noPr} 个提交没对上 PR 记录`);
  const looseLine = loose.length > 0 ? [`· ${loose.join('，')}`] : [];
  // 头一行已占 1 行，收尾的一行（全部链接，可带「另 N 张单」）占 1 行
  const room = SHIPPED_MAX_LINES - 2 - looseLine.length;
  const shown = ranked.length > room ? ranked.slice(0, room) : ranked;
  const out: string[] = [];
  for (const [n, e] of shown) {
    let title = e.title;
    if (title === null) {
      try {
        title = await issueTitle(n);
      } catch {
        title = null;
      }
    }
    const label = title === null ? '（标题没查成）' : clip(title, 60);
    out.push(
      `· #${n} ${label}（${e.prs.length} 个 PR）— ${issueUrl({ repo: `${repo.owner}/${repo.name}`, number: n })}`,
    );
  }
  out.push(...looseLine);
  const rest = ranked.length - shown.length;
  out.push(`${rest > 0 ? `另 ${rest} 张单没列；` : ''}全部：${compare}`);
  return out;
}

function noteLine(n: BriefNote, now: Date): string {
  const age = Math.round((now.getTime() - n.createdAt.getTime()) / 3_600_000);
  const where = n.issue ? issueUrl(n.issue) : '驾驶舱「通知」里看';
  return `· ${clip(n.title, 80)}（开了 ${age} 小时）— ${where}`;
}

function decisionsSection(notes: readonly BriefNote[], now: Date): BriefSection {
  const heading = `二、要你拍的（${notes.length} 条）`;
  if (notes.length === 0) return { heading, lines: ['没有，不用你定。'] };
  return {
    heading,
    lines: [
      ...notes.slice(0, LIST_MAX.decisions).map((n) => noteLine(n, now)),
      ...more(notes.length, LIST_MAX.decisions),
    ],
  };
}

function failuresSection(
  alerts: readonly BriefNote[],
  stopped: readonly BriefStoppedTask[],
  now: Date,
): BriefSection {
  const heading = '三、失败了要你看的';
  const lines: string[] = [];
  if (stopped.length === 0) lines.push('昨天没有停下（failed / stalled）还没恢复的单。');
  else {
    lines.push(`昨天停下、到现在还停着的单（${stopped.length} 张）：`);
    for (const t of stopped.slice(0, LIST_MAX.stopped)) {
      lines.push(
        `· ${issueUrl({ repo: t.repo, number: t.number })} ${clip(t.title, 60)}（${t.state}${t.lastProblem ? `：${clip(t.lastProblem, 80)}` : ''}）`,
      );
    }
    lines.push(...more(stopped.length, LIST_MAX.stopped));
  }
  if (alerts.length === 0) lines.push('没有开着的卡住报警。');
  else {
    lines.push(`开着的卡住报警（${alerts.length} 条，最老的在前）：`);
    lines.push(
      ...alerts.slice(0, LIST_MAX.alerts).map((n) => noteLine(n, now)),
      ...more(alerts.length, LIST_MAX.alerts),
    );
  }
  return { heading, lines };
}

function metricsSection(
  leadMinutes: readonly number[] | null,
  stats: readonly ExecutorLineStat[] | string,
): BriefSection {
  const heading = '四、关键指标';
  const lines: string[] = [];
  if (leadMinutes === null) lines.push('开单→上线中位：没查成（上线那一块没读到）');
  else if (leadMinutes.length === 0) lines.push('开单→上线中位：昨天上线的提交里没有对得上单的 PR');
  else
    lines.push(
      `开单→上线中位：${mins(median(leadMinutes))}（昨天上线、对得上单的 ${leadMinutes.length} 个 PR）`,
    );
  if (typeof stats === 'string') {
    lines.push(`一轮做成率、开 PR→合并中位：没查成：${stats}`);
    return { heading, lines, unread: stats };
  }
  const row = (line: 'engine' | 'local') => stats.find((s) => s.days === 7 && s.line === line);
  const words = { engine: '法国引擎', local: '本机' } as const;
  for (const line of ['engine', 'local'] as const) {
    const s = row(line);
    lines.push(
      s && s.nOpened > 0
        ? `${words[line]}（近 7 天开的 PR ${s.nOpened} 个、合了 ${s.nMerged} 个）：一轮做成率 ${pct(s.oneRoundRate)}，开 PR→合并中位 ${mins(s.openToMergeP50Min)}`
        : `${words[line]}：近 7 天没有开 PR`,
    );
  }
  lines.push('（一轮做成率：已合并里开 PR 后一次都没再推过的占比，口径同 pnpm line:stats）');
  return { heading, lines };
}

/** 收齐的简报。 */
export interface CollectedBrief {
  sections: BriefSection[];
}

/** 收齐四块。某一块读不到写进那一块、不抛。 */
export async function collectBrief(deps: DailyBriefDeps, now: Date): Promise<CollectedBrief> {
  const today = beijingDay(now).start;
  const yesterday = new Date(today.getTime() - 24 * 3_600_000);
  const guard = async <T>(what: string, f: () => Promise<T>): Promise<T | string> => {
    try {
      return await f();
    } catch (err) {
      return `${what}：${errMessage(err)}`;
    }
  };
  const shipped = await guard('读发布历史、比较提交', () => shippedSection(deps, yesterday, today));
  const decisions = await guard('读要你拍的', () => deps.decisions());
  const alerts = await guard('读卡住报警', () => deps.alerts());
  const stopped = await guard('读昨天停下的单', () => deps.stopped(yesterday, today));
  const stats = await guard('读交付指标', () => deps.lineStats(now));
  const unread = (heading: string, why: string): BriefSection => ({
    heading,
    lines: [`没查成：${why}`],
    unread: why,
  });
  return {
    sections: [
      typeof shipped === 'string' ? unread('一、昨天上线了什么', shipped) : shipped.section,
      typeof decisions === 'string' ? unread('二、要你拍的', decisions) : decisionsSection(decisions, now),
      typeof alerts === 'string' || typeof stopped === 'string'
        ? unread('三、失败了要你看的', [alerts, stopped].filter((x) => typeof x === 'string').join('；'))
        : failuresSection(alerts, stopped, now),
      metricsSection(typeof shipped === 'string' ? null : shipped.leadMinutes, stats),
    ],
  };
}

/** 飞书那条的正文：每行一句（后端把带链接的行做成可点的）。 */
export function briefPlain(sections: readonly BriefSection[]): string {
  return sections.flatMap((s) => [s.heading, ...s.lines]).join('\n');
}

/** #1055 评论的正文（Markdown）。 */
export function briefMarkdown(title: string, sections: readonly BriefSection[], footer: string): string {
  // 单行之间 Markdown 会并成一段：列表项连着写，别的每行各成一段（前后空一行）
  const block = (lines: readonly string[]) =>
    lines.flatMap((l, i) => {
      if (l.startsWith('· ')) return [`- ${l.slice(2)}`];
      return i > 0 && lines[i - 1]?.startsWith('· ') ? ['', l, ''] : [l, ''];
    });
  const body = sections.flatMap((s) => [`**${s.heading}**`, '', ...block(s.lines), '']);
  return [`### ${title}`, '', ...body, footer].join('\n');
}

/** 跑一轮。manual：手动触发（另一个键、另一个标题，不冒充当天定时那一条）。 */
export async function runDailyBriefJob(
  deps: DailyBriefDeps,
  opts: { manual?: boolean } = {},
): Promise<ScheduleResult> {
  const runId = await deps.runs.start(DAILY_BRIEF_JOB.id, deps.now());
  const now = deps.now();
  const { day } = beijingDay(now);
  const manual = opts.manual === true;
  const title = manual ? manualBriefTitle(day) : briefTitle(day);
  const key = manual ? `${dailyBriefKey(day)}:manual-${now.toISOString()}` : dailyBriefKey(day);
  // 定时器起来时会补最近一格：零点到 08:30 之间起来，补的是昨天 08:30 那一格，这时发出去就占了今天的键，
  // 08:30 那一轮只能原地更新、不再推（2026-10-15 04:38 发版重启就这样提前发了一条）。昨天那条错过了不补，等今天 08:30。
  if (!manual && now.getTime() < beijingDay(now).start.getTime() + DAILY_BRIEF_AT_MINUTES * 60_000) {
    const skipped: ScheduleResult = {
      outcome: 'unscanned',
      why: `还没到今天（${day}）08:30：这一轮是起来时补的昨天那一格，不补发，等今天 08:30 那一轮`,
    };
    await deps.runs.finish(runId, skipped, deps.now());
    deps.log('info', '每日简报：没到 08:30，不补昨天那一格', { runId, day });
    return skipped;
  }
  let result: ScheduleResult;
  let sections: BriefSection[] = [];
  try {
    const collected = await collectBrief(deps, now);
    sections = collected.sections;
    const repo = await deps.selfRepo();
    await deps.publish({ dedupeKey: key, title, body: briefPlain(sections), link: BRIEF_LINK });
    const footer = `<sub>引擎定时任务 ${DAILY_BRIEF_JOB.id} 发（${stamp(now)}，北京时间）；飞书团队群同时推了一条。只为四类事和 AI 判定要你拍的事即时推，其余都在这里。</sub>`;
    await deps.comment({
      repo,
      issueNumber: BRIEF_ISSUE,
      key: manual ? `daily-brief:${day}:manual-${now.toISOString()}` : `daily-brief:${day}`,
      body: briefMarkdown(title, sections, footer),
    });
    const unread = sections.filter((s) => s.unread).map((s) => `${s.heading}：${s.unread}`);
    result =
      unread.length > 0
        ? {
            outcome: 'partial',
            why: clip(`简报发了，有 ${unread.length} 块没查成：${unread.join('；')}`, 1500),
            scanned: sections.length,
          }
        : {
            outcome: 'ok',
            scanned: sections.length,
            found: 0,
            why: `简报 ${day} 发了（${manual ? '手动触发' : '定时'}）`,
          };
  } catch (err) {
    result = { outcome: 'failed', why: clip(`每日简报没发成：${errMessage(err)}`, 1500) };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '每日简报这一轮没发成', { runId, why: result.why });
    throw new DailyBriefFailedError(runId, result.why);
  }
  deps.log('info', '每日简报发了', { runId, day, manual, outcome: result.outcome });
  return result;
}
