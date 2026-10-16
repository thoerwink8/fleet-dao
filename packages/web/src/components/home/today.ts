// 主页三块（决定 0093）的数据怎么挑、怎么写成一行：要你拍的、在跑的、上线了的。全是现成接口拼的，不新造后端：
// - 要你拍的：GET /notifications?status=open 里 decision 级（四类人闸）加看门狗报进来的卡住报警（去重键 watchdog: 开头）；
//   拍过了、但这条要留着的（选了「先停着」这类 keepsOpen）不再摆出来——已经拍过，不是还要拍。
//   看门狗的卡不给人点「处理」：报警自己修、自己撤。这一行只写谁在修（handling.who：引擎、指挥官会话，或后端写的「PR #号」）
//   和开了多久、修了多久；阶段是没人在修就写「还没人接」。整页谁在修没算成时不编成没人接。
// - 在跑的：GET /home 的 running（法国引擎的单）加 GET /nodes/sessions（本机会话，主会话一行，子代理并进它那一行）。
// - 上线了的：GET /france/released-commits（法国切上去的主线提交，新的在前）加 GET /home 的 done（最近合并的 PR）。
//   一个提交是一版；它的标题就是合进主线那个 PR 的标题（末尾「(#号)」），同一版还带了哪些 PR 按合并时刻落在上一版和这一版之间算。
//   最近合并的 PR 只有 10 个：算不出来的照实写「没列全」，不拿空列表冒充「只带了这一个」。
import { NO_OPTIONS_TEXT } from '@fleet-dao/shared';
import type { LocalSessions, LocalSessionView, Notification, ReleasedCommits } from '../../api/types';
import { formatDuration } from '../../lib/format';
import type { LayoutTone } from '../layout/tone';
import {
  isLocalTask,
  leaseTextOf,
  localWhoOf,
  SEGMENT_LABEL,
  statusTextOf,
  toneOf,
  waitLineOf,
} from './running-card';
import type { HomeDone, HomeRunning } from './types';

// —— 要你拍的 ——

/** 看门狗报的卡（定时任务没跑成、连着跑不全、主线 N 小时没合 PR、额度读数旧了）：去重键的前缀。 */
export const WATCHDOG_KEY_PREFIX = 'watchdog:';

export type AskKind = 'gate' | 'watchdog';

export interface AskItem {
  kind: AskKind;
  n: Notification;
}

/**
 * 这条该不该摆进「要你拍的」：没处理、没拍过的人闸（拍了但系统没做成的也算，要再拍一次，#2353），或看门狗进来的卡。
 */
export function askKindOf(n: Notification): AskKind | null {
  if (n.resolvedAt) return null;
  if (n.level === 'decision') return n.answer && n.answer.execution?.ok !== false ? null : 'gate';
  if (n.level === 'alert' && n.dedupeKey?.startsWith(WATCHDOG_KEY_PREFIX)) return 'watchdog';
  return null;
}

/** 人闸在前、看门狗在后，各自新的在前。 */
export function askItems(items: readonly Notification[]): AskItem[] {
  const out: AskItem[] = [];
  for (const n of items) {
    const kind = askKindOf(n);
    if (kind) out.push({ kind, n });
  }
  const rank = (k: AskKind) => (k === 'gate' ? 0 : 1);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind) || b.n.createdAt.localeCompare(a.n.createdAt));
}

/** 一条要你拍的写成一行的几段：要定什么、推荐哪个、为什么。没选项的照实写「没有选项，请直接回复」。 */
export function askLine(n: Notification): { question: string; pick: string | null; why: string | null } {
  const question = firstLine(n.body) || n.title;
  const rec = n.options?.find((o) => o.recommended);
  if (!n.options?.length) return { question, pick: null, why: null };
  return { question, pick: rec?.label ?? null, why: rec?.recommended ?? null };
}

export { NO_OPTIONS_TEXT };

/** 看门狗这一行：有人在修、还没人接，或谁在修没查成。 */
export type WatchdogRepairState = 'fixing' | 'waiting' | 'unknown';

export interface WatchdogRepair {
  state: WatchdogRepairState;
  /** 谁在修。还没人接、没查成是 null。 */
  who: string | null;
  /** 这条报警开了多久（从记下的时刻算）。 */
  openFor: string;
  /** 这一轮修了多久（从 handling.since 算）。还没人接、没查成没有。 */
  fixingFor: string | null;
  /** 一行给人看的。 */
  text: string;
  /** 悬停全文。 */
  title: string;
}

/**
 * 看门狗的卡写成一行：谁在修、修了多久、开了多久。
 * who 照后端原文（法国引擎、指挥官会话，或「PR #号」）。阶段是没人在修：写「还没人接」。
 * 有阶段但没有谁：照阶段原文，不编成没人接。这条没有 handling：整页没算成就写原因，否则写「谁在修没查到」。
 */
export function watchdogRepair(n: Notification, now: number, problem?: string): WatchdogRepair {
  const openFor = formatDuration(Math.max(0, now - Date.parse(n.createdAt)));
  const h = n.handling;
  const titleOf = (text: string) => {
    const extra = [h?.line, ...(h?.problems ?? [])].filter((s) => s && s !== text);
    return extra.length > 0 ? `${text}（${extra.join(' · ')}）` : text;
  };
  if (!h) {
    const why = problem ?? '谁在修没查到';
    const text = `${why} · 开了 ${openFor}`;
    return { state: 'unknown', who: null, openFor, fixingFor: null, text, title: text };
  }
  if (h.stage === 'silenced') {
    const text = `${h.who ? `${h.who}已静默` : h.stageText} · 开了 ${openFor}`;
    return { state: 'unknown', who: null, openFor, fixingFor: null, text, title: titleOf(text) };
  }
  if (h.stage === 'unclaimed' || h.stage === 'waiting_founder' || !h.who) {
    if (h.stage === 'unclaimed' || h.stage === 'waiting_founder') {
      const text = `还没人接 · 开了 ${openFor}`;
      return { state: 'waiting', who: null, openFor, fixingFor: null, text, title: titleOf(text) };
    }
    const text = `${h.stageText} · 开了 ${openFor}`;
    return { state: 'unknown', who: null, openFor, fixingFor: null, text, title: titleOf(text) };
  }
  const fixingFor = formatDuration(Math.max(0, now - Date.parse(h.since)));
  const text = `${h.who}在修 · 修了 ${fixingFor} · 开了 ${openFor}`;
  return { state: 'fixing', who: h.who, openFor, fixingFor, text, title: titleOf(text) };
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
}

// —— 在跑的 ——

export interface RunRow {
  key: string;
  /** 事。 */
  what: string;
  /** 谁在做。 */
  who: string;
  /** 进度：在哪一段、这一段多久了。 */
  progress: string;
  /** 卡没卡：一个状态 + 一句话。 */
  tone: LayoutTone;
  stuck: string;
  /** 卡住、等人时的原因（截一行，悬停全文）。 */
  why?: string | undefined;
  /** 站内链接（任务详情）或 GitHub 链接（看远程环境时）。 */
  href?: string | undefined;
  external?: boolean | undefined;
  source: 'engine' | 'local';
  /** 这张引擎单走全程还是三段。没有这个值不标、不猜。本机会话没有。 */
  flowMode?: HomeRunning['flowMode'];
}

const STEP: Record<NonNullable<HomeRunning['segment']>, string> = {
  scoping: '1/3',
  doing: '2/3',
  verifying: '3/3',
  verify_pending: '3/3',
  merge: '合并',
};

/**
 * 一张单写成一行：引擎的写「法国引擎 · 模型」；本机领的（tasks.executor = local，决定 0096）写「本机 · 哪台 · 租约到几点」，
 * 没有三段流水是常态，不写「还没记在哪一段」；租约过了点还没退回的标黄「租约过期」。
 * machineOf 把领单的环境编号换成机器名（本机会话上报里有）。
 */
export function engineRow(
  item: HomeRunning,
  now: number,
  link: { href: string; external: boolean },
  machineOf?: (nodeId: string) => string | undefined,
): RunRow {
  if (isLocalTask(item)) return localTaskRow(item, now, link, machineOf);
  const { tone } = toneOf(item);
  const status = statusTextOf(item);
  const step = item.segment ? STEP[item.segment] : null;
  const stage = item.stageSince ? ` · 这一段 ${formatDuration(now - Date.parse(item.stageSince))}` : '';
  const progress = `${step && step !== '合并' ? `第 ${step} 段 · ` : ''}${status}${stage}`;
  const stuck =
    tone === 'fail'
      ? '卡住了'
      : tone === 'human'
        ? '等你'
        : item.waitingReason === 'paused'
          ? '已暂停'
          : tone === 'run'
            ? '没卡'
            : waitLineOf(item);
  const why =
    item.waitingReason === 'parked'
      ? item.parked
      : item.waitingReason === 'paused'
        ? item.paused
        : tone === 'fail' || tone === 'human'
          ? (item.pendingDecision ?? item.redChecks ?? item.lastEvent?.text)
          : undefined;
  return {
    key: `engine:${item.repo}#${item.issueNumber}`,
    what: `#${item.issueNumber} ${item.title}`,
    who: `法国引擎 · ${item.worker ?? '这一刻没有会话在跑'}`,
    progress,
    tone,
    stuck,
    why,
    href: link.href,
    external: link.external,
    source: 'engine',
    ...(item.flowMode === 'full' || item.flowMode === 'three' ? { flowMode: item.flowMode } : {}),
  };
}

function localTaskRow(
  item: HomeRunning,
  now: number,
  link: { href: string; external: boolean },
  machineOf: ((nodeId: string) => string | undefined) | undefined,
): RunRow {
  const base = toneOf(item);
  const expired = item.leaseUntil !== undefined && Date.parse(item.leaseUntil) < now;
  const tone = expired && base.tone === 'run' ? 'stall' : base.tone;
  const since = item.taskSince
    ? ` · 共 ${formatDuration(Math.max(0, now - Date.parse(item.taskSince)))}`
    : '';
  return {
    key: `engine:${item.repo}#${item.issueNumber}`,
    what: `#${item.issueNumber} ${item.title}`,
    who: `${localWhoOf(item, machineOf)} · ${leaseTextOf(item, now)}`,
    progress: `${statusTextOf(item)}${since}`,
    tone,
    stuck: expired ? '租约过期' : tone === 'run' ? '没卡' : tone === 'human' ? '等你' : waitLineOf(item),
    ...(item.lastEvent && tone === 'fail' ? { why: item.lastEvent.text } : {}),
    href: link.href,
    external: link.external,
    source: 'engine',
    ...(item.flowMode === 'full' || item.flowMode === 'three' ? { flowMode: item.flowMode } : {}),
  };
}

/** 本机会话上报没推上来的环境：不占「在跑的」的行（那是在做的事），列表下面用一行说清。 */
export interface SilentNode {
  id: string;
  machine: string;
  never: boolean;
  why: string;
}

export type LocalRows =
  | { kind: 'rows'; rows: RunRow[]; silent: SilentNode[] }
  /** 法国没配本机的通行证：不收本机会话。 */
  | { kind: 'notWired'; why: string };

const isLive = (s: LocalSessionView) => s.state !== 'stopped';

/**
 * 本机会话写成行：每台在上报的机器，主会话（不是子代理）还没停的一行一件；同一个工作树、分支上在跑的子代理并进那一行。
 * 没上报的机器不占行（silent 里列出，页面用一行说清；不当成本机没在做事）。本机领的单是 tasks 里 executor = local 的单，在引擎那一批里，不在这里。
 */
export function localRows(data: LocalSessions, now: number): LocalRows {
  if (data.notWired) return { kind: 'notWired', why: data.notWired };
  const rows: RunRow[] = [];
  const silent: SilentNode[] = [];
  for (const node of data.nodes) {
    const machine = node.machine ?? node.id;
    if (node.freshness !== 'fresh') {
      silent.push({
        id: node.id,
        machine,
        never: node.freshness === 'never',
        why:
          node.freshness === 'never'
            ? '配了通行证，但一次都没收到（本机还没装，或推送停了；也可能是早就不用的环境）'
            : '本机该每 2 分钟推一次：可能关机了、断网了，或推送停了',
      });
      continue;
    }
    const mains = node.sessions.filter((s) => !s.subagent && isLive(s));
    for (const s of mains) {
      const helpers = node.sessions.filter(
        (h) =>
          h.subagent &&
          h.state === 'running' &&
          h.repo === s.repo &&
          h.branch === s.branch &&
          h.worktree === s.worktree,
      ).length;
      const what = s.branch ?? s.worktree ?? '分离头';
      rows.push({
        key: `local:${node.id}:${s.id}`,
        what: `${what}${s.repo ? ` · ${s.repo}` : ''}`,
        who: `本机 ${machine} · Claude Code${helpers > 0 ? ` · 带 ${helpers} 个子代理` : ''}`,
        progress: [
          `起了 ${formatDuration(now - Date.parse(s.startedAt))}`,
          s.lastTool ? `最后在调 ${s.lastTool}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        tone: s.state === 'idle' ? 'stall' : 'run',
        stuck: s.state === 'idle' ? `${formatDuration(s.idleMs)}没动` : '没卡',
        source: 'local',
      });
    }
  }
  return { kind: 'rows', rows, silent };
}

/** 卡着的、等你的排前面：失败 > 等你 > 黄 > 灰 > 在跑。 */
const TONE_RANK: Partial<Record<LayoutTone, number>> = { fail: 0, human: 1, stall: 2, wait: 3, run: 4 };
export function sortRunRows(rows: RunRow[]): RunRow[] {
  return [...rows].sort((a, b) => (TONE_RANK[a.tone] ?? 5) - (TONE_RANK[b.tone] ?? 5));
}

export { SEGMENT_LABEL };

// —— 上线了的 ——

type Commit = Extract<ReleasedCommits, { state: 'ok' }>['commits'][number];

export interface ShippedRow {
  key: string;
  /** 一句话：改了什么（合进去那个 PR 的标题，去掉末尾的「(#号)」）；标题没读到是 null。 */
  what: string | null;
  whatWhy: string | null;
  short: string;
  at: string;
  event: Commit['event'];
  /** 这一版的头一个 PR（提交标题末尾的号）；标题里没有号是 null。 */
  pr: { number: number; repo: string | null } | null;
  /** 同一版还带的别的 PR（不含头一个），新的在前。 */
  carried: HomeDone[];
  /** carried 算全了没有：上一版或这一版的头一个 PR 不在最近合并的那几个里，就算不全。 */
  carriedKnown: boolean;
}

const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;

export function prOfTitle(title: string | null): number | null {
  const m = title === null ? null : PR_SUFFIX.exec(title);
  return m ? Number(m[1]) : null;
}

/** 在最近合并的 PR 里找这一版的头一个：号对上、合并不晚于切上去的时刻；几个仓都有这个号时取最晚合的。 */
function headOf(done: readonly HomeDone[], number: number | null, at: string): HomeDone | undefined {
  if (number === null) return undefined;
  return done
    .filter((d) => d.prNumber === number && d.mergedAt <= at)
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
}

/** 最近 limit 次切上去的提交，每次一行，带上它带的 PR。 */
export function shippedRows(commits: readonly Commit[], done: readonly HomeDone[], limit = 5): ShippedRow[] {
  return commits.slice(0, limit).map((c, i) => {
    const number = prOfTitle(c.title);
    const head = headOf(done, number, c.at);
    const prev = commits[i + 1];
    const prevHead = prev ? headOf(done, prOfTitle(prev.title), prev.at) : undefined;
    const sameRepo = (d: HomeDone) => head !== undefined && d.repo === head.repo;
    const known = head !== undefined && prevHead !== undefined && prevHead.repo === head.repo;
    const carried =
      head === undefined
        ? []
        : done
            .filter(
              (d) =>
                sameRepo(d) &&
                d.prNumber !== head.prNumber &&
                d.mergedAt <= head.mergedAt &&
                (prevHead === undefined || d.mergedAt > prevHead.mergedAt),
            )
            .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    return {
      key: `${c.at}-${c.sha}-${c.event}`,
      what: c.title === null ? null : c.title.replace(PR_SUFFIX, '').trim() || c.title,
      whatWhy: c.title === null ? (c.titleWhy ?? '标题没读到') : null,
      short: c.short,
      at: c.at,
      event: c.event,
      pr: number === null ? null : { number, repo: head?.repo ?? null },
      carried,
      carriedKnown: known,
    };
  });
}
