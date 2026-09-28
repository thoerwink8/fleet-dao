// 提醒是一件活（design 15.3「谁在处理」；创始人 2026-09-27 夜：「标上谁在处理……更类似于一个派单状态」）：要修的提醒挂在
// 一张跟进单上（有 task_id 的就是那张单，没挂单的由人另开一张、挂到提醒上），谁在处理
// 就是那张单上的认领（#299，seat.ts），不另记；状态从认领、PR 镜像、发布记录读时现算（照 k8s Conditions：只看真实记录，
// 每个阶段带进入的时刻）。这里只判，读库、读文件、开单是外壳的事；这份「谁在处理」只给驾驶舱看，
// `fleet-api alert show` 不再显示（#445，删掉了自动开跟进单、要认领、按分钟再推那一层——原来这里的「提醒派单」）。
// 改这里之前必须知道：
// - 引擎自己的认领不算有人在处理：提醒是引擎自己搞不定才报的（#293「没有别家可验」时 #293 的认领在引擎手里）。单列成
//   engine_stuck，和没人在修一样；转人工要创始人说改派。
// - 读不到、认不出的写进 problems、阶段不猜：发布判不了就停在「合进主线」并写明没查成；整条读不到的由外壳报没查成，
//   不当成「没人在修」（创始人 2026-09-28：删减只删拦人催人的，不许驾驶舱少看到东西——没查成和没人在修必须分得开）。
import type { ALERT_STAGES } from '@fleet-dao/shared';
import { claimOwnerText, type IssueClaim, isActiveClaim } from './seat.ts';

// —— 事实：外壳从库里、文件里读出来交给这里 ——

export type AlertLevel = 'decision' | 'alert' | 'daily';

/** 一条提醒此刻的样子（notifications 那一行）。 */
export interface AlertRef {
  id: string;
  dedupeKey: string;
  level: AlertLevel;
  taskId: string | null;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/**
 * 跟进单：task = 提醒挂的任务对应的那张单；engine、claim = 历史上由提醒派单开的小单、或帅位 `alert claim --issue`
 * 挂的（#445 起两条路都删了，只剩历史数据；记在 alert_work，一条提醒一张，像 k8s ownerReferences 里 controller=true
 * 的那一个）。
 */
export interface WorkIssue {
  repoId: string;
  /** owner/仓名。 */
  repo: string;
  issueNumber: number;
  source: 'task' | 'engine' | 'claim';
  linkedBy: string | null;
  linkedAt: string | null;
}

/** 和这条提醒挂钩的 PR（PR 镜像那一行）：正文「修提醒」栏写了它、正文挂了跟进单（需求栏、关单词），或跟进单的认领登记过它。 */
export interface FixPr {
  repo: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  openedAt: string | null;
  mergedAt: string | null;
  /** 合进默认分支的那个提交（squash 的那一个）。 */
  mergeSha: string | null;
  updatedAt: string;
  via: readonly ('alert' | 'issue' | 'claim')[];
}

/** Alertmanager 式静默：谁建的、为什么、到几点；到期自己失效，提前撤记谁撤的。 */
export interface AlertSilence {
  id: string;
  matchKind: 'key' | 'prefix';
  match: string;
  comment: string;
  createdBy: string;
  createdAt: string;
  endsAt: string;
  expiredAt: string | null;
  expiredBy: string | null;
}

/** 算一条提醒的处理状态要的全部事实。 */
export interface AlertWorkFacts {
  alert: AlertRef;
  work: WorkIssue | null;
  /** 跟进单上的认领（活着的、结束了的都给：结束了的用来算「没人在修」从哪算起）；没有是 null。 */
  claim: IssueClaim | null;
  prs: readonly FixPr[];
  /** 和这条提醒的键对得上的静默（活着的、过期的都行，这里判）。 */
  silences: readonly AlertSilence[];
}

/**
 * 发布记录（法国上）：在用的版本以发布脚本原子切换的 current 链接为准；主线顺序是自动发布每 5 分钟写的
 * git log --first-parent（新的在前）。deployedAt：在用的那版切上去的时刻（最近一次发布就是它、而且成了）；拿不准是 null。
 */
export type DeployFacts =
  | {
      ok: true;
      currentSha: string;
      commits: readonly (readonly [string, string])[];
      /** 状态文件这一轮写的时刻：太旧（自动发布停了）就判不了。 */
      checkedAt: string;
      deployedAt: string | null;
    }
  | { ok: false; why: string };

/** 自动发布的读数这么久没更新就不信它（和后端 deploy_lag 的「自动发布这么久没跑一轮」同一个数）。 */
export const DEPLOY_FACTS_STALE_MS = 20 * 60_000;

// —— 静默 ——

export const SILENCE_MAX_MINUTES = 7 * 24 * 60;
const MAX_KEY = 300;
const MAX_COMMENT = 500;

/** 建静默的参数对不对；不对返回原因。前缀要以冒号结尾、至少 4 个字（一类提醒，不许把全部都静默了）。 */
export function silenceProblem(input: {
  matchKind: 'key' | 'prefix';
  match: string;
  comment: string;
  minutes: number;
}): string | null {
  const { match } = input;
  if (!match || /\s/.test(match) || match.length > MAX_KEY)
    return `静默对哪条提醒写得不对：要不带空白、${MAX_KEY} 字以内（现在是「${match.slice(0, 80)}」）`;
  if (input.matchKind === 'prefix' && (!match.endsWith(':') || match.length < 4))
    return `前缀「${match}」不行：要以冒号结尾、至少 4 个字（一类提醒，例如 watchdog:job:backup:），不许把全部提醒都静默了`;
  const comment = input.comment.trim();
  if (!comment) return '静默要写为什么（--note）：谁拍的、为什么不用处理';
  if ([...comment].length > MAX_COMMENT) return `静默的原因太长（最多 ${MAX_COMMENT} 个字）`;
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > SILENCE_MAX_MINUTES)
    return `静默要带到期、最长 7 天（${SILENCE_MAX_MINUTES} 分钟），现在是 ${input.minutes} 分钟：到期自动恢复升级，忘了撤也不会一直压着`;
  return null;
}

/**
 * 「--until」写的到期：+30m、+2h、+3d（从现在算），或带时区的时刻（2026-10-01T09:00+08:00）。回分钟数，认不出回原因。
 * now 是库的时钟（外壳读回来的），不拿各机器的钟。
 */
export function silenceMinutes(text: string, now: string): number | string {
  const t = text.trim();
  const rel = /^\+?(\d{1,5})\s*([mhd])$/i.exec(t);
  if (rel?.[1] && rel[2]) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    return n * (unit === 'm' ? 1 : unit === 'h' ? 60 : 24 * 60);
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t))
    return `认不出到期「${text}」：写 +30m、+2h、+3d，或带时区的时刻（例如 2026-10-01T09:00+08:00）`;
  const at = Date.parse(t);
  const base = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(base)) return `认不出到期「${text}」`;
  const minutes = Math.ceil((at - base) / 60_000);
  if (minutes < 1) return `到期「${text}」已经过了`;
  return minutes;
}

export function silenceMatches(s: Pick<AlertSilence, 'matchKind' | 'match'>, dedupeKey: string): boolean {
  return s.matchKind === 'key' ? s.match === dedupeKey : dedupeKey.startsWith(s.match);
}

/** 此刻管用的静默：建了、没到期、没被提前撤、对得上这条提醒的键；几条都对得上取到期最晚的那条。 */
export function activeSilence(
  silences: readonly AlertSilence[],
  dedupeKey: string,
  now: string,
): AlertSilence | null {
  const t = Date.parse(now);
  let best: AlertSilence | null = null;
  for (const s of silences) {
    if (!silenceMatches(s, dedupeKey) || s.expiredAt !== null) continue;
    if (!(Date.parse(s.createdAt) <= t && t < Date.parse(s.endsAt))) continue;
    if (best === null || Date.parse(s.endsAt) > Date.parse(best.endsAt)) best = s;
  }
  return best;
}

// —— 发布：合并提交在不在在用的那版里 ——

export type DeployState =
  | { state: 'deployed'; at: string | null }
  | { state: 'not_yet' }
  | { state: 'unknown'; why: string };

/**
 * 合并提交在不在法国在用的那版里：主线列表是 git log --first-parent（新的在前），PR 的合并提交在主线第一父链上，所以
 * 「它在列表里的位置不比在用的新」就是在用那版的祖先。在用的不在列表里、合并提交不在列表里（又不比列表里最老的还老）、
 * 读数太旧、读不了：unknown，写明为什么，不猜。deploy 是 null：这台机器上查不了（只在法国上有发布记录）。
 */
export function deployStateOf(
  mergeSha: string | null,
  mergedAt: string | null,
  deploy: DeployFacts | null,
  now: string,
): DeployState {
  if (deploy === null) return { state: 'unknown', why: '这里查不了发布（发布记录只在法国上）' };
  if (!deploy.ok) return { state: 'unknown', why: deploy.why };
  const age = Date.parse(now) - Date.parse(deploy.checkedAt);
  if (!Number.isFinite(age))
    return { state: 'unknown', why: `自动发布读数的时刻认不出（${deploy.checkedAt}）` };
  if (age > DEPLOY_FACTS_STALE_MS)
    return {
      state: 'unknown',
      why: `自动发布的读数 ${spokenMinutes(Math.round(age / 60_000))}没更新了（自动发布停了？看健康页的 deploy_lag）`,
    };
  if (!mergeSha) return { state: 'unknown', why: 'PR 镜像里没有合并提交号' };
  const index = (sha: string) => deploy.commits.findIndex(([s]) => s === sha);
  const current = index(deploy.currentSha);
  if (current < 0)
    return { state: 'unknown', why: `在用的版本 ${deploy.currentSha.slice(0, 12)} 不在主线最近的提交里` };
  const merged = index(mergeSha);
  if (merged >= 0)
    return merged >= current ? { state: 'deployed', at: deploy.deployedAt } : { state: 'not_yet' };
  const oldest = deploy.commits.at(-1);
  if (oldest && mergedAt && Date.parse(mergedAt) < Date.parse(oldest[1]))
    return { state: 'deployed', at: deploy.deployedAt };
  return {
    state: 'unknown',
    why: `合并提交 ${mergeSha.slice(0, 12)} 不在主线最近的提交里（没合进默认分支？）`,
  };
}

// —— 处理状态 ——

/** 阶段的名字就是驾驶舱接口里的那一份（@fleet-dao/shared 的 ALERT_STAGES）。 */
export type AlertStage = (typeof ALERT_STAGES)[number];

// 「没人在修」「有人在修」不是「没人认领」「认领了」（#445，创始人 2026-09-28：删减只删拦人催人的，不许驾驶舱少看到
// 东西——认领本身没删，issue_claims、帅位这一套照旧；只是提醒这一层不再拿「认领没认领」当第一位的说法，
// 改成直接说「谁在修、修到哪」，没人在修就照实说没人在修，不是报错也不是没人认领这种听着像在催人的说法）。
const STAGE_WORDS: Readonly<Record<AlertStage, string>> = {
  resolved: '已撤',
  silenced: '已静默',
  waiting_founder: '等创始人拍',
  unclaimed: '没人在修',
  engine_stuck: '引擎拿着、它自己卡住了',
  claimed: '有人在修',
  pr_open: 'PR 开着',
  merged: '合进主线、等发布',
  deployed: '法国已发布、等条件撤',
};

export function alertStageText(stage: AlertStage): string {
  return STAGE_WORDS[stage];
}

/** 有人在处理的几个阶段（升级看「停得太久」，不看「没人在修」）。 */
export const HANDLED_STAGES: readonly AlertStage[] = ['claimed', 'pr_open', 'merged', 'deployed'];
/** 没人在处理的几个阶段（升级看「没人在修」）。 */
export const UNHANDLED_STAGES: readonly AlertStage[] = ['waiting_founder', 'unclaimed', 'engine_stuck'];

export interface AlertHandling {
  stage: AlertStage;
  /** 进这个阶段的时刻（k8s Conditions 的 lastTransitionTime），「多久了」从它算。 */
  since: string;
  /** 谁在处理：本机的认领写「机器/工人」；只有 PR 的写「PR #号」；静默写建静默的人；等创始人拍写创始人；没人是 null。 */
  who: string | null;
  work: WorkIssue | null;
  /** 活着的认领（引擎的也给：engine_stuck 要说是谁拿着）；没有是 null。 */
  claim: IssueClaim | null;
  /** 带动这个阶段的那个 PR（开着的、合了的）；没有是 null。 */
  pr: FixPr | null;
  silence: AlertSilence | null;
  /** 合了以后才有：发布了没有。 */
  deploy: DeployState | null;
  /**
   * 「没人在修」这一段从哪算起（再推的键用）：first = 提醒开着以来没人在修过；after-<认领号前 8 位> = 那份认领结束以后。
   * 有人在处理、静默、已撤的是 null。
   */
  episode: string | null;
  /** 停在哪（「停得太久」再推的键用）：<阶段>-<认领号前 8 位 | PR 号 | 合并提交前 12 位>；没人在处理的是 null。 */
  stageRef: string | null;
  /** 给人看的一行：「本机/工人A 在处理 · #342 · PR #350 开着 · 35 分钟」。 */
  line: string;
  /** 没查成的，一条一句（发布判不了之类）。 */
  problems: string[];
}

const issueRef = (w: WorkIssue) => `${w.repo}#${w.issueNumber}`;
const short = (id: string) => id.slice(0, 8);

/** 分钟说成人话：「35 分钟」「2 小时 10 分钟」「3 天 4 小时」。 */
export function spokenMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}

function minutesBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, ms / 60_000) : 0;
}

const later = (a: string, b: string | null | undefined) => (b && Date.parse(b) > Date.parse(a) ? b : a);

/**
 * 一条提醒此刻的处理状态（纯函数：驾驶舱、本机看板都用它；`fleet-api alert show` 只借它读静默、没查成，
 * 不再显示 `line`/`who`，#445）。先后：
 * 已撤 → 静默 → 修复的 PR（开着的先于合了的：还在往下修）→ 本机的认领 → 等创始人拍（decision）→ 引擎自己卡住 → 没人在修。
 */
export function alertHandling(f: AlertWorkFacts, deploy: DeployFacts | null, now: string): AlertHandling {
  const { alert, work } = f;
  const problems: string[] = [];
  const claim = f.claim && isActiveClaim(f.claim.state) ? f.claim : null;
  const humanClaim = claim && claim.ownerKind !== 'engine' ? claim : null;
  const base = {
    work,
    claim,
    pr: null as FixPr | null,
    silence: null as AlertSilence | null,
    deploy: null as DeployState | null,
    episode: null as string | null,
    stageRef: null as string | null,
    problems,
  };
  const workText = work ? ` · ${issueRef(work)}` : '';
  const ago = (since: string) => spokenMinutes(minutesBetween(since, now));

  if (alert.resolvedAt !== null) {
    return {
      ...base,
      stage: 'resolved',
      since: alert.resolvedAt,
      who: alert.resolvedBy,
      line: `已撤（${alert.resolvedBy ?? '没记是谁'}）`,
    };
  }

  const silence = activeSilence(f.silences, alert.dedupeKey, now);
  if (silence) {
    return {
      ...base,
      silence,
      stage: 'silenced',
      since: silence.createdAt,
      who: silence.createdBy,
      line: `已静默（${silence.createdBy}：${silence.comment}）· 到 ${silence.endsAt}${workText}`,
    };
  }

  const whoOf = (pr: FixPr) => (humanClaim ? claimOwnerText(humanClaim) : `PR #${pr.number}`);
  const openPrs = f.prs.filter((p) => p.state === 'open');
  if (openPrs.length > 0) {
    const pr = [...openPrs].sort(
      (a, b) => Date.parse(a.openedAt ?? a.updatedAt) - Date.parse(b.openedAt ?? b.updatedAt),
    )[0] as FixPr;
    const since = later(pr.openedAt ?? pr.updatedAt, humanClaim?.claimedAt);
    const who = whoOf(pr);
    return {
      ...base,
      pr,
      stage: 'pr_open',
      since,
      who,
      stageRef: `pr_open-${pr.number}`,
      line: `${who} 在处理${workText} · PR #${pr.number} 开着 · ${ago(since)}`,
    };
  }
  const mergedPrs = f.prs.filter((p) => p.state === 'merged');
  if (mergedPrs.length > 0) {
    // 最后合的那个：它发布了，前面的也都发布了
    const pr = [...mergedPrs].sort(
      (a, b) => Date.parse(b.mergedAt ?? b.updatedAt) - Date.parse(a.mergedAt ?? a.updatedAt),
    )[0] as FixPr;
    const mergedAt = pr.mergedAt ?? pr.updatedAt;
    const who = whoOf(pr);
    const d = deployStateOf(pr.mergeSha, pr.mergedAt, deploy, now);
    if (d.state === 'deployed') {
      const since = later(mergedAt, d.at);
      return {
        ...base,
        pr,
        deploy: d,
        stage: 'deployed',
        since,
        who,
        stageRef: `deployed-${(pr.mergeSha ?? String(pr.number)).slice(0, 12)}`,
        line: `${who} 修了${workText} · PR #${pr.number} 法国已发布、等条件撤 · ${ago(since)}`,
      };
    }
    if (d.state === 'unknown') problems.push(`发布判不了：${d.why}`);
    return {
      ...base,
      pr,
      deploy: d,
      stage: 'merged',
      since: mergedAt,
      who,
      stageRef: `merged-${pr.number}`,
      line: `${who} 修了${workText} · PR #${pr.number} 合进主线${d.state === 'unknown' ? '（发布没查成）' : '、等发布'} · ${ago(mergedAt)}`,
    };
  }

  if (humanClaim) {
    const who = claimOwnerText(humanClaim);
    return {
      ...base,
      stage: 'claimed',
      since: humanClaim.claimedAt,
      who,
      stageRef: `claimed-${short(humanClaim.claimId)}`,
      line: `${who} 在处理${workText} · ${humanClaim.note ? `${humanClaim.note} · ` : ''}${ago(humanClaim.claimedAt)}`,
    };
  }

  // 没人在处理：从什么时候算起（上一份认领结束以后是新的一段）
  const ended = f.claim && !isActiveClaim(f.claim.state) ? f.claim : null;
  const endedAfter = ended?.endedAt && Date.parse(ended.endedAt) > Date.parse(alert.createdAt) ? ended : null;
  const since = endedAfter?.endedAt ?? alert.createdAt;
  const episode = endedAfter ? `after-${short(endedAfter.claimId)}` : 'first';
  const endedText = endedAfter
    ? `（上一份认领${endedAfter.state === 'voided' ? '作废了' : endedAfter.state === 'released' ? '放下了' : '做完了'}：${endedAfter.endReason ?? '没写原因'}）`
    : '';

  if (alert.level === 'decision') {
    return {
      ...base,
      stage: 'waiting_founder',
      since,
      who: '创始人',
      episode,
      line: `等创始人拍${workText}${endedText} · ${ago(since)}`,
    };
  }
  if (claim && claim.ownerKind === 'engine') {
    return {
      ...base,
      stage: 'engine_stuck',
      since,
      who: '引擎',
      episode,
      line: `没人接手：引擎拿着${workText}、它自己卡住了${endedText} · ${ago(since)}`,
    };
  }
  return {
    ...base,
    stage: 'unclaimed',
    since,
    who: null,
    episode,
    line: `没人在修${workText}${endedText} · ${ago(since)}`,
  };
}

// —— 每小时对账的 24 小时再推（谁在处理、静默了的不推；条件按 alert-sweep.ts 的 RULES 现算就撤）——

/** 每小时对账的 24 小时再推（engine 的 alert-sweep.ts）用的前缀；这里只认，不写。 */
export const REMIND_KEY_PREFIX = 'remind:';

/** 再推出来的那一种（不再为它自己又推一条）：这里只剩每小时对账自己的 24 小时再推（#445 删掉了会自动开单、要认领、
 * 按分钟再推的「提醒派单」；它推出来的 unclaimed:、stuck: 两种键不会再有新的了）。 */
export function isEscalationKey(key: string): boolean {
  return key.startsWith(REMIND_KEY_PREFIX);
}

/** 北京时间「9 月 27 日 23:16」（再推的正文写绝对时刻，不写「多久以前」：卡片不用每轮改）。 */
export function beijing(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + 8 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
