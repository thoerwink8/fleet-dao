// 「在跑的」一张卡的骨架：issue 编号、标题、仓、当前这一段、正在等什么、从什么时候起在等。
//
// 关键规矩（specs/509 第五节）：
// - **verify_pending 不画成失败红**。它是「合进去了在等第二意见 / 等 CI 走完」的正常等待，单画一个色
//   （翼蓝——stall 黄系）和「失败」红分开。
// - 还在 scoping / doing / verifying 的看作「正常在跑」（run 绿）；等额度、等清空、等合并队列的看作
//   「在等」（wait 灰）；等创始人拍的（founder_decision）看作「等你」（human 黄）。

import { CircleDashed, CircleDot, Hourglass, MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import { Link } from 'react-router';
import { formatAgo } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { type Tone, toneBg, toneText } from '../../lib/status';
import { cn } from '../../lib/utils';
import type { HomeRunning } from './types';

const SEGMENT_LABEL: Record<NonNullable<HomeRunning['segment']>, string> = {
  scoping: '在写需求 / 拆活',
  doing: '在干活',
  verifying: '在自己验',
  verify_pending: '还没验',
  merge: '在合并队列',
};

/** segment 还没接上（home-api 现在一律 null）时卡上怎么写：不猜、不画成「卡住了」。 */
const SEGMENT_NOT_WIRED = '在跑';

const WAIT_LABEL: Record<HomeRunning['waitingReason'], string> = {
  queue: '排队',
  memory: '内存满，等空位',
  quota_reset: '等额度清零',
  ci: '等 CI 走完',
  verify_round: '等第二意见',
  founder_decision: '等你拍',
  merge_queue: '等合并队列',
  nothing: '在跑',
};

/**
 * segment + waitingReason → 颜色和图标。
 * 「还没验」（verify_pending / ci / verify_round / merge_queue）单独画：不是 fail 红，也不是「正常在跑」绿。
 */
function toneOf(item: HomeRunning): { tone: Tone; icon: typeof CircleDot } {
  if (item.waitingReason === 'founder_decision') return { tone: 'human', icon: MessageCircleQuestion };
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

export function RunningCard({ item, className }: { item: HomeRunning; className?: string }) {
  const now = useNow();
  const { tone, icon: Icon } = toneOf(item);
  const waitText = WAIT_LABEL[item.waitingReason];
  return (
    <li data-running-card={item.segment} className={cn('block', className)}>
      <Link
        to={item.link}
        className="flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:border-border-strong"
      >
        <span
          className={cn(
            'mt-1 grid size-6 shrink-0 place-items-center rounded-full',
            toneBg[tone],
            toneText[tone],
          )}
          aria-hidden
        >
          <Icon className="size-3" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="num text-xs font-semibold text-muted-foreground">#{item.issueNumber}</span>
            <span className="truncate text-sm font-medium">{item.title}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="num">{item.repo}</span>
            <span aria-hidden>·</span>
            <span className={toneText[tone]}>
              {item.segment === null ? SEGMENT_NOT_WIRED : SEGMENT_LABEL[item.segment]}
            </span>
            {item.waitingReason !== 'nothing' ? (
              <>
                <span aria-hidden>·</span>
                <span>{waitText}</span>
              </>
            ) : null}
            {item.waitingSince ? (
              <>
                <span aria-hidden>·</span>
                <span className="num">{formatAgo(item.waitingSince, now)}</span>
              </>
            ) : null}
          </div>
        </div>
      </Link>
    </li>
  );
}
