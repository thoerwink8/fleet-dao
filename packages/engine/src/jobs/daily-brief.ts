// 每日简报（决定 0096：放法国引擎定时任务；创始人规矩：只为四类事和 AI 判定要他的事即时打扰他，其余每天早上看一条）。
// 每天 08:30（北京时间）一轮：昨天上线了什么（版本 + 一句话）、要你拍的（带链接）、失败了要你看的、关键指标（开单→上线中位、一轮做成率）、
// 流程健康（#2762：近 7 天每轮怎么收场的、按档一轮做成率和平均轮数、重活 PR 新增行 p90、冷验收拒绝占比，和再往前 7 天比），
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
  type CommanderStalledSummary,
  commanderSummaryLine,
  DAILY_BRIEF_AT_MINUTES,
  DAILY_BRIEF_JOB_ID,
  dailyBriefKey,
  type ExecutorLineStat,
  type FlowGroupStat,
  type FlowModeHealth,
  type PipelineHealth,
  type ReleaseKills,
  type RoundOutcome,
  type ScheduleResult,
  type SelfShareRow,
} from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { clip, stamp } from './reconcile-common.ts';
import {
  computeSelfShare,
  SELF_SHARE_LINES,
  SELF_SHARE_TIER_WORDS,
  type SelfShareReading,
  type SelfShareReadings,
  selfShareLineText,
  selfShareRule,
  selfShareValueText,
} from './self-share.ts';

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
  /** 截至 to 的 7 天流程健康（@fleet-dao/db 的 pipelineHealth，#2762）。读不到照抛。 */
  pipelineHealth(to: Date): Promise<PipelineHealth>;
  /** 截至 to 的 7 天里发版叫停的动手会话（@fleet-dao/db 的 releaseKilledSessions，#2797）。读不到照抛；没接上的不写这一行。 */
  releaseKills?(to: Date): Promise<ReleaseKills>;
  /** 截至 to 两种流程（全程 / 三段）的对照（@fleet-dao/db 的 flowModeHealth，决定 0105，#2827）。读不到照抛；没接上的不写这一栏。 */
  flowModeHealth?(to: Date): Promise<FlowModeHealth>;
  /**
   * 名额档位要的另外三项现值（主线 CI 红分钟、机器开的自身缺陷单、非掏钱非删数据原因的拍板卡），截至 to 的 7 天。
   * 每一项各自读、各自带原因（读不到 value 是 null），不整体抛。一轮做成率和冷验收拒绝占比取自 pipelineHealth。
   * 没接上的不写「名额」一节、不写设置。
   */
  selfShareReadings?(
    to: Date,
  ): Promise<Pick<SelfShareReadings, 'ciRedMinutes' | 'selfDefects' | 'offReasonDecisions'>>;
  /** 上一次存下的名额档位（设置 engine.selfShare）；没有是 null。读不到照抛。 */
  selfSharePrevious?(): Promise<SelfShareRow | null>;
  /** 把名额档位和每项现值写进设置 engine.selfShare。写不进照抛。 */
  selfShareSave?(row: SelfShareRow): Promise<void>;
  /** 当前仍停着的任务，以及指挥官已经看过多少。读不到照抛。 */
  commanderSummary(): Promise<CommanderStalledSummary>;
  /** 账本（#3741 片 2b，report.daily）：幂等，同一个 key 只留一行。写不进照抛，调用方只警告、不挡飞书和 #1055；没接上的不写。 */
  ledger?(input: { repo: string; idempotencyKey: string; text: string }): Promise<void>;
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
  commander: CommanderStalledSummary | string,
  now: Date,
): BriefSection {
  const heading = '三、失败了要你看的';
  const lines: string[] = [];
  if (typeof commander === 'string') lines.push(`停下任务统计：没查成：${commander}`);
  else lines.push(commanderSummaryLine(commander));
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

/** 一轮结束类的白话（流程健康一节）。 */
const OUTCOME_WORDS: Record<RoundOutcome, string> = {
  merged: '做成',
  verify_rejected: '冷验收拒',
  ci_red: 'CI 红',
  leftover: '交活有剩',
  no_commit: '没提交',
  push_conflict: '推分支冲突',
  merge_conflict: '等合并冲突',
  timeout: '超时',
  stopped: '叫停',
  other: '别的',
};
const TIER_WORDS: Record<string, string> = { fast: '快活', medium: '中活', heavyweight: '重活' };

/** 占比和 7 天前比：涨跌按百分点说；哪边没有就写明。 */
function shareVs(now: number | null, before: number | null | undefined): string {
  if (now === null) return '—';
  if (before === undefined) return pct(now);
  if (before === null) return `${pct(now)}（7 天前没有）`;
  const d = Math.round((now - before) * 100);
  return `${pct(now)}（7 天前 ${pct(before)}，${d === 0 ? '持平' : d > 0 ? `涨 ${d} 点` : `跌 ${-d} 点`}）`;
}

/** 数和 7 天前比。 */
function numVs(now: number | null, before: number | null | undefined, unit = ''): string {
  if (now === null) return '—';
  if (before === undefined) return `${now}${unit}`;
  if (before === null) return `${now}${unit}（7 天前没有）`;
  const d = Math.round((now - before) * 100) / 100;
  return `${now}${unit}（7 天前 ${before}${unit}，${d === 0 ? '持平' : d > 0 ? `涨 ${d}` : `跌 ${-d}`}）`;
}

/** 冷验收按验收族分的通过率（#3604）：每族「过 / 有结论」，没有结论的族不列；一条结论都没有写「没有」，不写 0%。 */
export function verifyFamilyLine(h: Pick<PipelineHealth, 'verifyByFamily'>): string {
  if (h.verifyByFamily.length === 0) return '冷验收通过率（按验收族）：这周没有带结论的验收';
  const parts = h.verifyByFamily.map(
    (f) => `${f.family} ${f.passed}/${f.decided}（${Math.round((f.passed / f.decided) * 100)}%）`,
  );
  return `冷验收通过率（按验收族，过/有结论）：${parts.join('，')}`;
}

/**
 * 五、流程健康（#2762）：近 7 天每轮怎么收场的（task_rounds），和再往前 7 天比。
 * 这周读不到整节写「没查成」；上周读不到只写这周、注明对比没查成。窗口里一轮都没有写「没有」，不写 0%。
 */
export function healthSection(
  now: PipelineHealth | string,
  before: PipelineHealth | string,
  kills?: { now: ReleaseKills | string; before: ReleaseKills | string },
  flow?: FlowModeHealth | string,
): BriefSection {
  const heading = '五、流程健康（近 7 天，和再往前 7 天比）';
  const killLine = kills ? releaseKillsLine(kills.now, kills.before) : null;
  const flowLines = flow === undefined ? [] : flowModeLines(flow);
  // 这一行没查成也算这一节没查全（这一轮记 partial）
  const killUnread = typeof kills?.now === 'string' ? kills.now : undefined;
  const flowUnread = typeof flow === 'string' ? flow : undefined;
  const resumeLine = (current: PipelineHealth, previous?: PipelineHealth): string => {
    const beforeRate = previous?.resume.rate;
    const ratio =
      current.resume.rate === null
        ? current.resume.decisions === 0
          ? '这周没有明确判定'
          : '—'
        : shareVs(current.resume.rate, beforeRate);
    return `返工续上会话：${current.resume.resumed}/${current.resume.decisions}，比例 ${ratio}`;
  };
  const withKills = (s: BriefSection): BriefSection => {
    const extra = [...(killLine ? [killLine] : []), ...flowLines];
    if (extra.length === 0) return s;
    const unread = s.unread ?? killUnread ?? flowUnread;
    return { ...s, lines: [...s.lines, ...extra], ...(unread !== undefined ? { unread } : {}) };
  };
  if (typeof now === 'string') return withKills({ heading, lines: [`没查成：${now}`], unread: now });
  const prev = typeof before === 'string' ? undefined : before;
  const lines: string[] = [];
  if (typeof before === 'string') lines.push(`7 天前那一周没查成（${before}），只列这一周`);
  if (now.rounds === 0) {
    lines.push(`近 7 天没有收场的轮${prev ? `（7 天前 ${prev.rounds} 轮）` : ''}。`);
    lines.push(resumeLine(now, prev));
    return withKills({ heading, lines });
  }
  lines.push(`收场 ${numVs(now.rounds, prev ? prev.rounds : undefined, ' 轮')}`);
  const shown = now.outcomes.filter(
    (o) => o.n > 0 || (prev?.outcomes.find((p) => p.outcome === o.outcome)?.n ?? 0) > 0,
  );
  for (const o of shown) {
    const p = prev?.outcomes.find((x) => x.outcome === o.outcome);
    lines.push(
      `· ${OUTCOME_WORDS[o.outcome]} ${o.n} 轮，占 ${shareVs(o.share, prev ? (p?.share ?? null) : undefined)}`,
    );
  }
  lines.push(`冷验收拒绝占比：${shareVs(now.verifyRejectShare, prev ? prev.verifyRejectShare : undefined)}`);
  lines.push(verifyFamilyLine(now));
  lines.push(resumeLine(now, prev));
  for (const t of now.byTier) {
    const p = prev?.byTier.find((x) => x.tier === t.tier);
    const name = TIER_WORDS[t.tier] ?? t.tier;
    lines.push(
      `· ${name}（${t.rounds} 轮）：一轮做成率 ${shareVs(t.oneRoundRate, prev ? (p?.oneRoundRate ?? null) : undefined)}，合并的平均 ${t.avgRounds === null ? '—（这周没有合并的）' : numVs(t.avgRounds, prev ? (p?.avgRounds ?? null) : undefined, ' 轮')}`,
    );
  }
  lines.push(
    `重活 PR 新增行 p90：${now.heavyAddedP90 === null ? '这周没有量到行数的重活合并' : numVs(now.heavyAddedP90, prev ? prev.heavyAddedP90 : undefined, ' 行')}`,
  );
  return withKills({ heading, lines });
}

const groupWord = (m: FlowGroupStat['mode']) => (m === 'full' ? '全程' : '三段');
const tokenWord = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : String(n));

/** 一组一行：单数、合并数、成功率（Wilson 95% 区间）、时长中位和 p90、每合并单输入当量。没有的写「—」，不写 0。 */
function flowGroupLine(g: FlowGroupStat): string {
  const rate =
    g.successRate === null || g.wilson === null
      ? '—'
      : `${pct(g.successRate)}（Wilson 95% 区间 ${pct(g.wilson.low)}–${pct(g.wilson.high)}）`;
  // #2859：按输入当量给（输入 1、缓存写 1.25、缓存读 0.1、输出 5），原始四样相加另列
  const perMerged =
    g.equivalentPerMerged === null
      ? '—'
      : `输入当量 ${tokenWord(g.equivalentPerMerged)}（原始四样相加 ${g.rawTokensPerMerged === null ? '—' : tokenWord(g.rawTokensPerMerged)}）`;
  const unread = g.runsTokenUnread > 0 ? `，另有 ${g.runsTokenUnread} 段 token 没读全` : '';
  return `· ${groupWord(g.mode)}：${g.tasks} 单，合并 ${g.merged}；成功率 ${rate}；时长中位 ${mins(g.durationMedianMin)}、p90 ${mins(g.durationP90Min)}；每合并单 ${perMerged}${unread}`;
}

/**
 * 「两种流程对照」几行（决定 0105，#2827）：每组一行；两组都满 30 单才出结论，不够只写「还不够判（全程 N / 三段 M）」。
 * 成功率这里按合并算，合并后 7 天有没有被修、被回退库里读不到，由人核。读不到写「没查成」。
 */
export function flowModeLines(flow: FlowModeHealth | string): string[] {
  const head = '两种流程对照（决定 0105，自开跑累计）';
  if (typeof flow === 'string') return [`${head}：没查成（${flow}）`];
  const lines = [
    `${head}（成功率按合并算，合并后 7 天被修、被回退由人核）`,
    flowGroupLine(flow.full),
    flowGroupLine(flow.three),
  ];
  if (!flow.enough || !flow.verdict) {
    lines.push(`还不够判（全程 ${flow.full.tasks} / 三段 ${flow.three.tasks}）`);
    return lines;
  }
  const v = flow.verdict;
  const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} 点`;
  lines.push(
    `成功率差（全程减三段）${pp(v.diff.diff)}，95% 区间 ${pp(v.diff.low)} 到 ${pp(v.diff.high)}：${v.noninferior ? '下界高于 −5 点，非劣效成立' : '下界没过 −5 点，非劣效还没成立'}`,
  );
  lines.push(
    v.costRatio === null
      ? '每合并单输入当量对比：缺合并的单，算不出'
      : `全程每合并单输入当量是三段的 ${v.costRatio.toFixed(2)} 倍${v.costStop ? '，超过 2 倍，触发成本类止损' : ''}`,
  );
  if (v.effectStop) lines.push('触发效果类止损：全程更差的把握超过 95%');
  return lines;
}

/**
 * 「发版叫停的动手会话」一行（#2797）：近 7 天一共几段（和再往前 7 天比）、一共跑了几小时、按天的数。
 * 这周读不到写「没查成」；上周读不到只写这周、注明对比没查成。
 */
export function releaseKillsLine(now: ReleaseKills | string, before: ReleaseKills | string): string {
  const head = '发版叫停的动手会话';
  if (typeof now === 'string') return `${head}：没查成（${now}）`;
  const vs = typeof before === 'string' ? `（7 天前没查成：${before}）` : '';
  const total = typeof before === 'string' ? `${now.total} 段` : numVs(now.total, before.total, ' 段');
  const days = now.byDay.map((d) => `${d.day} ${d.n}`).join('，');
  return `${head}：${total}${vs}，被叫停的段一共跑了 ${now.hours} 小时；按天：${days}`;
}

/**
 * 六、名额（错误预算分档）：档位、规矩、每项现值和线、和上次比有没有换档。读不到的项写原因、按没过算（那一节记没查成）。
 */
export function selfShareSection(row: SelfShareRow, previous: SelfShareRow | null | string): BriefSection {
  const heading = '六、名额（按错误预算分，滚动 7 天）';
  const tier = SELF_SHARE_TIER_WORDS[row.tier];
  const change =
    typeof previous === 'string'
      ? `（上次的档位没读成：${previous}）`
      : previous === null
        ? '（第一次算）'
        : previous.tier === row.tier
          ? `（和 ${previous.day} 一样）`
          : `（${previous.day} 是${SELF_SHARE_TIER_WORDS[previous.tier]}，换档了）`;
  const lines = [
    `档位：${tier}${change}；5 项全过已连续 ${row.streak} 天（要连续 3 天才算健康）`,
    selfShareRule(row.tier),
  ];
  const unread: string[] = [];
  for (const i of row.items) {
    const name = SELF_SHARE_LINES[i.key].label;
    if (i.unread !== undefined) {
      lines.push(`· ${name}：没查成：${i.unread}（按没过算）`);
      unread.push(`${name}：${i.unread}`);
    } else {
      lines.push(
        `· ${name} ${selfShareValueText(i)}（要 ${selfShareLineText(i.key)}）：${i.passed ? '过' : '没过'}`,
      );
    }
  }
  return { heading, lines, ...(unread.length > 0 ? { unread: unread.join('；') } : {}) };
}

/** 收齐的简报。 */
export interface CollectedBrief {
  sections: BriefSection[];
  /** 今天算出的名额档位（deps 接了才有）；runDailyBriefJob 写进设置。 */
  selfShare?: SelfShareRow;
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
  const commander = await guard('读停下任务的指挥官处理统计', () => deps.commanderSummary());
  const stats = await guard('读交付指标', () => deps.lineStats(now));
  const health = await guard('读流程健康', () => deps.pipelineHealth(today));
  const healthBefore = await guard('读 7 天前的流程健康', () =>
    deps.pipelineHealth(new Date(today.getTime() - 7 * 24 * 3_600_000)),
  );
  const releaseKills = deps.releaseKills;
  const kills = releaseKills
    ? {
        now: await guard('读发版叫停的动手会话', () => releaseKills(today)),
        before: await guard('读 7 天前发版叫停的动手会话', () =>
          releaseKills(new Date(today.getTime() - 7 * 24 * 3_600_000)),
        ),
      }
    : undefined;
  const flowModeHealth = deps.flowModeHealth;
  const flow = flowModeHealth ? await guard('读两种流程对照', () => flowModeHealth(today)) : undefined;
  const unread = (heading: string, why: string): BriefSection => ({
    heading,
    lines: [`没查成：${why}`],
    unread: why,
  });
  // 名额：一轮做成率和冷验收拒绝占比取自上面读到的这周流程健康（rounds 为 0 占比是 null＝读不到＝没过），其余三项现读
  const selfShareReadings = deps.selfShareReadings;
  let selfShare: SelfShareRow | undefined;
  let shareSection: BriefSection | undefined;
  if (selfShareReadings) {
    const extra = await guard('读名额的另外三项', () => selfShareReadings(today));
    const previous = await guard('读上次的名额档位', async () => (await deps.selfSharePrevious?.()) ?? null);
    const fromHealth = (pick: (h: PipelineHealth) => number | null, what: string): SelfShareReading => {
      if (typeof health === 'string') return { value: null, unread: health };
      const v = pick(health);
      return v === null ? { value: null, unread: `${what}：这周没有收场的轮` } : { value: v };
    };
    const lost = (why: string): SelfShareReading => ({ value: null, unread: why });
    const readings: SelfShareReadings = {
      oneRoundRate: fromHealth(
        (h) => h.outcomes.find((o) => o.outcome === 'merged')?.share ?? null,
        '一轮做成率',
      ),
      verifyReject: fromHealth((h) => h.verifyRejectShare, '冷验收拒绝占比'),
      ciRedMinutes: typeof extra === 'string' ? lost(extra) : extra.ciRedMinutes,
      selfDefects: typeof extra === 'string' ? lost(extra) : extra.selfDefects,
      offReasonDecisions: typeof extra === 'string' ? lost(extra) : extra.offReasonDecisions,
    };
    selfShare = computeSelfShare({
      readings,
      day: beijingDay(now).day,
      previous: typeof previous === 'string' || previous === null ? [] : previous.history,
      at: now,
    });
    shareSection = selfShareSection(selfShare, previous);
  }
  return {
    ...(selfShare ? { selfShare } : {}),
    sections: [
      typeof shipped === 'string' ? unread('一、昨天上线了什么', shipped) : shipped.section,
      typeof decisions === 'string' ? unread('二、要你拍的', decisions) : decisionsSection(decisions, now),
      typeof alerts === 'string' || typeof stopped === 'string' || typeof commander === 'string'
        ? unread(
            '三、失败了要你看的',
            [alerts, stopped, commander].filter((x) => typeof x === 'string').join('；'),
          )
        : failuresSection(alerts, stopped, commander, now),
      metricsSection(typeof shipped === 'string' ? null : shipped.leadMinutes, stats),
      healthSection(health, healthBefore, kills, flow),
      ...(shareSection ? [shareSection] : []),
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
    if (collected.selfShare && deps.selfShareSave) {
      // 写不进不拦简报：拉单读到的还是上一次的档位（过 72 小时就当读不到），这一节记没查成、这一轮记 partial
      try {
        await deps.selfShareSave(collected.selfShare);
      } catch (err) {
        const why = `档位没写进设置 engine.selfShare：${errMessage(err)}`;
        sections = sections.map((s) =>
          s.heading.startsWith('六、名额')
            ? { ...s, lines: [...s.lines, `没查成：${why}`], unread: s.unread ? `${s.unread}；${why}` : why }
            : s,
        );
        deps.log('error', '每日简报：名额档位没写进设置', { runId, why });
      }
    }
    const repo = await deps.selfRepo();
    const footer = `<sub>引擎定时任务 ${DAILY_BRIEF_JOB.id} 发（${stamp(now)}，北京时间）；飞书团队群同时推了一条。只为四类事和 AI 判定要你拍的事即时推，其余都在这里。</sub>`;
    // 双写（#3741 片 2b）：先写账本 report.daily（键 = #1055 评论的键：日期，手动触发带时刻），写不成只警告，下面飞书和 #1055 照旧
    if (deps.ledger) {
      try {
        await deps.ledger({
          repo: `${repo.owner}/${repo.name}`,
          idempotencyKey: manual ? `daily-brief:${day}:manual-${now.toISOString()}` : `daily-brief:${day}`,
          text: clip(briefMarkdown(title, sections, footer), 20_000),
        });
      } catch (err) {
        deps.log('warn', '每日简报没写进账本（飞书和 #1055 照发）', { runId, why: errMessage(err) });
      }
    }
    await deps.publish({ dedupeKey: key, title, body: briefPlain(sections), link: BRIEF_LINK });
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
