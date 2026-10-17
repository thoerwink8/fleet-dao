// 「在跑的」一张单的卡片（手机上看板的树形列表里一行一张；颜色、说法的判法桌面看板的卡片也用）：单号、标题、谁在做、本段待了多久、在等谁拍什么、最近一次事件。
//
// 关键规矩（specs/509 第五节）：
// - **verify_pending 不画成失败红**。它是「动手收了、验收还没起」的正常等待，单画一个色（stall 黄系）和「失败」红分开。
//   真失败只有最近一次事件是 trouble（超时 / 失败 / 没起来）：那才用 fail 红。
// - 还在 scoping / doing / verifying 的看作「正常在跑」（run 绿）；等额度、等清空、等合并队列的看作「在等」（wait 灰）；
//   等创始人拍的（founder_decision 或挂着待拍的事）看作「等你」（human）。
// - 「等你拍」的点只用 human 色（全站颜色只表达状态；红留给失败），不另造一种红。

import { CHECKS_RED_PREFIX } from '@fleet-dao/shared';
import {
  Bot,
  CircleDashed,
  CircleDot,
  Hand,
  Hourglass,
  MessageCircleQuestion,
  Pause,
  ShieldQuestion,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { formatAgo, formatClock, formatDuration } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import type { Tone } from '../../lib/status';
import { cn } from '../../lib/utils';
import { FlowModeTag } from '../flow-mode-tag';
import { Section } from '../layout/section';
import { StatusBadge } from '../layout/status-badge';
import { inkClass } from '../layout/tone';
import { useRemoteView } from '../node-notice';
import type { HomeRunning } from './types';

export const SEGMENT_LABEL: Record<NonNullable<HomeRunning['segment']>, string> = {
  scoping: '在对题',
  doing: '在动手',
  verifying: '在验收',
  verify_pending: '还没验',
  merge: '在合并队列',
};

/** 本机领的单（决定 0096：tasks.executor = local，带租约）。老后端、老快照没有 executor，当引擎。 */
export function isLocalTask(item: Pick<HomeRunning, 'executor'>): boolean {
  return item.executor === 'local';
}

/**
 * 本机领的单「谁在做」：本机 · 领它的是哪台。machineOf 把环境编号换成机器名（本机会话上报里有，没有就写环境编号）；
 * 通行证没记领取人的写「没记是哪台」，不猜。
 */
export function localWhoOf(
  item: Pick<HomeRunning, 'claimedBy'>,
  machineOf?: (nodeId: string) => string | undefined,
): string {
  const id = item.claimedBy;
  return `本机 · ${id === undefined ? '没记是哪台' : (machineOf?.(id) ?? id)}`;
}

/** 本机领的单租约到几点；过了点还没续也没退回的写「租约已过期」（法国下一轮拉单会收回），没给到期时刻照实说。 */
export function leaseTextOf(item: Pick<HomeRunning, 'leaseUntil'>, now: number): string {
  if (item.leaseUntil === undefined) return '租约到期时刻没给';
  const clock = formatClock(item.leaseUntil);
  return Date.parse(item.leaseUntil) < now ? `租约已过期（${clock}）` : `租约到 ${clock}`;
}

/** 卡片、详情上「谁在做」那一格：本机领的写本机，引擎的写模型名，这一刻没有进程在跑的照实说。 */
export function workerTextOf(item: HomeRunning, machineOf?: (nodeId: string) => string | undefined): string {
  if (isLocalTask(item)) return localWhoOf(item, machineOf);
  return item.worker ?? '没有进程在跑';
}

/** segment 推不出（老单、runs 里没有流水）时卡上怎么写：不猜、不画成「卡住了」。 */
const SEGMENT_NOT_WIRED = '在跑（还没记在哪一段）';

export const WAIT_LABEL: Record<HomeRunning['waitingReason'], string> = {
  queue: '排队',
  memory: '内存满，等空位',
  quota_reset: '等额度清零',
  ci: '等 CI 走完',
  verify_round: '等第二意见',
  founder_decision: '等你拍',
  merge_queue: '等合并队列',
  paused: '已暂停',
  parked: '等人看',
  nothing: '在跑',
};

/** 在等什么这一句。等合并且必过检查红了时不写「等合并队列」。 */
export function waitLineOf(item: HomeRunning): string {
  if (item.waitingReason === 'merge_queue' && item.redChecks) return `${CHECKS_RED_PREFIX}${item.redChecks}`;
  return WAIT_LABEL[item.waitingReason];
}

/**
 * 引擎停下等人、而且停下不是因为最近一笔做坏了（轮数用尽、开 PR 撞占用……）：画成等你、写「为什么停」。
 * 最近一笔是超时 / 失败的停下照旧算「出问题」（红、写那条失败、进「只看卡住的」，#902 D2）：失败本身就是停下的原因。
 */
export function parkedForHuman(item: HomeRunning): boolean {
  return item.waitingReason === 'parked' && item.lastEvent?.tone !== 'trouble';
}

/**
 * 这张单等着创始人拍：单子自己卡在追问，或要你拍的那块里挂着它的事，或引擎停下等人（轮数用尽、同因连挂……，
 * 要人点「继续」「放弃」「重做」；#1967、#1971 停了 8 小时，卡上写的是「在合并队列」「还没验」，没人看出来）。
 */
export function needsFounder(item: HomeRunning): boolean {
  return (
    item.waitingReason === 'founder_decision' || parkedForHuman(item) || item.pendingDecision !== undefined
  );
}

/**
 * segment + waitingReason + 最近事件 → 颜色和图标。
 * 「还没验」（verify_pending / ci / verify_round / merge_queue）单独画：不是 fail 红，也不是「正常在跑」绿。
 */
export function toneOf(item: HomeRunning): { tone: Tone; icon: typeof CircleDot } {
  // 被人暂停（#820 片 3）：等待色（黄系），不是失败红，也不是等你拍；人让它停的，点「继续」才走
  if (item.waitingReason === 'paused') return { tone: 'stall', icon: Pause };
  // 引擎停下等人（最近一笔没做坏）：等你色（要人点继续 / 放弃）；最近一笔是超时 / 失败的落到下面的 fail 红
  if (parkedForHuman(item)) return { tone: 'human', icon: Hand };
  // 等合并时必过检查红了（#1983）：失败红，不是排队的灰
  if (item.segment === 'merge' && item.redChecks) return { tone: 'fail', icon: TriangleAlert };
  if (item.lastEvent?.tone === 'trouble') return { tone: 'fail', icon: TriangleAlert };
  if (needsFounder(item)) return { tone: 'human', icon: MessageCircleQuestion };
  switch (item.segment) {
    case 'verify_pending':
      return { tone: 'stall', icon: ShieldQuestion };
    case 'merge':
      return { tone: 'wait', icon: Hourglass };
    case 'scoping':
    case 'doing':
    case 'verifying':
    case null:
      if (item.waitingReason === 'nothing' || item.waitingReason === 'ci') {
        return { tone: 'run', icon: CircleDot };
      }
      return { tone: 'wait', icon: CircleDashed };
  }
}

/** 卡片上那句「在哪一段」：排在对题、但一笔流水都还没有的，是排着队还没开始，不写「在对题」。 */
export function statusTextOf(item: HomeRunning): string {
  if (item.waitingReason === 'paused') return '已暂停';
  if (item.waitingReason === 'parked') return '停下等人';
  // 本机领的单没有三段流水（本机自己做，不走法国的 runs）：写本机在做，不写「还没记在哪一段」
  if (isLocalTask(item) && item.segment === null) return '本机在做';
  if (item.segment === 'merge' && item.redChecks) return `${CHECKS_RED_PREFIX}${item.redChecks}`;
  const notStarted = item.segment === 'scoping' && item.lastEvent === undefined && !needsFounder(item);
  return item.segment === null
    ? SEGMENT_NOT_WIRED
    : notStarted
      ? '还没开始对题'
      : SEGMENT_LABEL[item.segment];
}

export function RunningCard({ item, className }: { item: HomeRunning; className?: string }) {
  const now = useNow();
  const { tone } = toneOf(item);
  const founder = needsFounder(item);
  const since = (iso: string) => formatDuration(Math.max(0, now - Date.parse(iso)));
  const statusText = statusTextOf(item);
  // 出问题和等你拍的卡，左边一道状态色竖线
  const rail = tone === 'fail' ? 'fail' : founder ? 'human' : undefined;
  return (
    <div data-running-card={item.segment} data-needs-founder={founder} className={cn('h-full', className)}>
      <Section flush {...(rail ? { tone: rail } : {})} className="h-full [&>div]:h-full">
        <CardLink
          item={item}
          className="pointer-events-auto nopan nodrag flex h-full flex-col justify-between gap-1 px-3 py-2 text-left transition-colors hover:bg-accent"
        >
          <div className="flex items-center gap-2">
            <span className="num text-meta font-semibold text-muted-foreground">#{item.issueNumber}</span>
            <span className="min-w-0 flex-1 truncate text-body font-medium">{item.title}</span>
            <FlowModeTag mode={item.flowMode} fallback={item.flowFallback} />
            <StatusBadge tone={tone} label={statusText} />
            {founder ? <StatusBadge tone="human" label="等你" variant="dot" /> : null}
          </div>

          <div className="flex items-center gap-x-2 text-meta text-muted-foreground">
            <Bot className="size-3 shrink-0" aria-hidden />
            <span
              className={cn(
                'max-w-1/2 shrink-0 truncate',
                item.worker || isLocalTask(item) ? 'text-foreground' : undefined,
              )}
            >
              {workerTextOf(item)}
            </span>
            {isLocalTask(item) ? (
              <>
                <span aria-hidden>·</span>
                <span className="num shrink-0 whitespace-nowrap" data-lease>
                  {leaseTextOf(item, now)}
                </span>
              </>
            ) : null}
            {item.stageSince ? (
              <>
                <span aria-hidden>·</span>
                <span className="num shrink-0 whitespace-nowrap">本段 {since(item.stageSince)}</span>
              </>
            ) : null}
            {item.taskSince ? (
              <>
                <span aria-hidden>·</span>
                <span className="num min-w-0 truncate">共 {since(item.taskSince)}</span>
              </>
            ) : null}
          </div>

          {item.waitingReason !== 'nothing' ? (
            <div className="flex items-center gap-x-2 text-meta">
              <span className={cn('shrink-0 font-medium', inkClass[tone])}>{waitLineOf(item)}</span>
              {item.waitingSince ? (
                <span className="num shrink-0 whitespace-nowrap text-muted-foreground">
                  已 {since(item.waitingSince)}
                </span>
              ) : null}
            </div>
          ) : null}

          {parkedForHuman(item) && item.parked ? (
            <div className="truncate text-meta text-ink-human" title={item.parked} data-parked-why>
              为什么停：{item.parked}
            </div>
          ) : founder && item.pendingDecision ? (
            <div className="truncate text-meta text-ink-human" title={item.pendingDecision}>
              要你拍：{item.pendingDecision}
            </div>
          ) : item.lastEvent ? (
            <div
              className={cn(
                'truncate text-meta',
                item.lastEvent.tone === 'trouble' ? 'text-ink-fail' : 'text-muted-foreground',
              )}
              title={item.lastEvent.text}
            >
              最近：{item.lastEvent.text} · <span className="num">{formatAgo(item.lastEvent.at, now)}</span>
            </div>
          ) : (
            <div className="truncate text-meta text-muted-foreground">最近：还没有三段流水记录</div>
          )}
        </CardLink>
      </Section>
    </div>
  );
}

/**
 * 整张卡片是个链接：看本台时进站内的单子详情；看别的环境的快照时站内详情读的是本台的库、对不上，
 * 改成指向 GitHub 上那张单（新窗口打开），拼不出链接就不当链接。
 */
export function CardLink({
  item,
  className,
  children,
  label,
}: {
  item: HomeRunning;
  className: string;
  children: ReactNode;
  /** 链接只有图标、没有字时给读屏和悬停提示的话；不给就用单子标题。 */
  label?: string;
}) {
  const remote = useRemoteView();
  const title = label ?? item.title;
  if (!remote) {
    return (
      <Link to={item.link} title={title} aria-label={label} className={className}>
        {children}
      </Link>
    );
  }
  const cut = item.repo.indexOf('/');
  const href = brand.repoLink(
    { owner: item.repo.slice(0, cut), name: item.repo.slice(cut + 1) },
    'issues',
    item.issueNumber,
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={title} aria-label={label} className={className}>
      {children}
    </a>
  ) : (
    <div title={title} className={className}>
      {children}
    </div>
  );
}
