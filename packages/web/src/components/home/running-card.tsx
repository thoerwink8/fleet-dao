// 「在跑的」一张单的卡片（手机上看板的树形列表里一行一张；颜色、说法的判法桌面看板的卡片也用）：单号、标题、谁在做、本段待了多久、在等谁拍什么、最近一次事件。
//
// 关键规矩（specs/509 第五节）：
// - **verify_pending 不画成失败红**。它是「动手收了、验收还没起」的正常等待，单画一个色（stall 黄系）和「失败」红分开。
//   真失败只有最近一次事件是 trouble（超时 / 失败 / 没起来）：那才用 fail 红。
// - 还在 scoping / doing / verifying 的看作「正常在跑」（run 绿）；等额度、等清空、等合并队列的看作「在等」（wait 灰）；
//   等创始人拍的（founder_decision 或挂着待拍的事）看作「等你」（human）。
// - 「等你拍」的点只用 human 色（全站颜色只表达状态；红留给失败），不另造一种红。

import {
  Bot,
  CircleDashed,
  CircleDot,
  Hourglass,
  MessageCircleQuestion,
  Pause,
  ShieldQuestion,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { formatAgo, formatDuration } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { type Tone, toneBg, toneText } from '../../lib/status';
import { cn } from '../../lib/utils';
import { useRemoteView } from '../node-notice';
import type { HomeRunning } from './types';

export const SEGMENT_LABEL: Record<NonNullable<HomeRunning['segment']>, string> = {
  scoping: '在对题',
  doing: '在动手',
  verifying: '在验收',
  verify_pending: '还没验',
  merge: '在合并队列',
};

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
  nothing: '在跑',
};

/** 这张单等着创始人拍：单子自己卡在追问，或要你拍的那块里挂着它的事。 */
export function needsFounder(item: HomeRunning): boolean {
  return item.waitingReason === 'founder_decision' || item.pendingDecision !== undefined;
}

/**
 * segment + waitingReason + 最近事件 → 颜色和图标。
 * 「还没验」（verify_pending / ci / verify_round / merge_queue）单独画：不是 fail 红，也不是「正常在跑」绿。
 */
export function toneOf(item: HomeRunning): { tone: Tone; icon: typeof CircleDot } {
  // 被人暂停（#820 片 3）：等待色（黄系），不是失败红，也不是等你拍；人让它停的，点「继续」才走
  if (item.waitingReason === 'paused') return { tone: 'stall', icon: Pause };
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
  const notStarted = item.segment === 'scoping' && item.lastEvent === undefined && !needsFounder(item);
  return item.segment === null
    ? SEGMENT_NOT_WIRED
    : notStarted
      ? '还没开始对题'
      : SEGMENT_LABEL[item.segment];
}

export function RunningCard({ item, className }: { item: HomeRunning; className?: string }) {
  const now = useNow();
  const { tone, icon: Icon } = toneOf(item);
  const founder = needsFounder(item);
  const since = (iso: string) => formatDuration(Math.max(0, now - Date.parse(iso)));
  const statusText = statusTextOf(item);
  return (
    <div data-running-card={item.segment} data-needs-founder={founder} className={cn('h-full', className)}>
      <CardLink
        item={item}
        className={cn(
          'pointer-events-auto nopan nodrag flex h-full flex-col justify-between gap-1 rounded-lg border bg-card px-3 py-2 text-left shadow-card-edge transition-colors hover:border-border-strong',
          founder && 'border-st-human/50',
          tone === 'fail' && 'border-st-fail/50',
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded-full',
              toneBg[tone],
              toneText[tone],
            )}
            aria-hidden
          >
            <Icon className="size-3" />
          </span>
          <span className="num text-xs font-semibold text-muted-foreground">#{item.issueNumber}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
          {founder ? (
            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-ink-human">
              <span className="size-2 rounded-full bg-st-human" aria-hidden />
              等你
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-x-2 text-xs text-muted-foreground">
          <Bot className="size-3 shrink-0" aria-hidden />
          <span className={cn('max-w-1/2 shrink-0 truncate', item.worker ? 'text-foreground' : undefined)}>
            {item.worker ?? '没有进程在跑'}
          </span>
          {item.stageSince ? (
            <>
              <span aria-hidden>·</span>
              <span className="num shrink-0">本段 {since(item.stageSince)}</span>
            </>
          ) : null}
          {item.taskSince ? (
            <>
              <span aria-hidden>·</span>
              <span className="num min-w-0 truncate">共 {since(item.taskSince)}</span>
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-x-2 text-xs">
          <span className={cn('shrink-0 font-medium', toneText[tone])}>{statusText}</span>
          {item.waitingReason !== 'nothing' ? (
            <span className="shrink-0 text-muted-foreground">· {WAIT_LABEL[item.waitingReason]}</span>
          ) : null}
          {item.waitingSince ? (
            <span className="num shrink-0 text-muted-foreground">{since(item.waitingSince)}</span>
          ) : null}
        </div>

        {founder && item.pendingDecision ? (
          <div className="truncate text-xs text-ink-human" title={item.pendingDecision}>
            要你拍：{item.pendingDecision}
          </div>
        ) : item.lastEvent ? (
          <div
            className={cn(
              'truncate text-xs',
              item.lastEvent.tone === 'trouble' ? 'text-ink-fail' : 'text-muted-foreground',
            )}
            title={item.lastEvent.text}
          >
            最近：{item.lastEvent.text} · <span className="num">{formatAgo(item.lastEvent.at, now)}</span>
          </div>
        ) : (
          <div className="truncate text-xs text-muted-foreground">最近：还没有三段流水记录</div>
        )}
      </CardLink>
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
