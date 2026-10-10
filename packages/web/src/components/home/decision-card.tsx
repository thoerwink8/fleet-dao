// 「要你拍的」一张卡：一个决定、一句背景、一个去答的地方。
// 来源两种——decision 级通知、待批的 approval。追问不在这里：v3 没有 AI 追问这一环，旧会话留下的追问在通知中心只读展示、可关闭（#928）。

import { ArrowRight, ScrollText, Send } from 'lucide-react';
import { Link } from 'react-router';
import { formatAgo } from '../../lib/format';
import { useSlowNow } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { useRemoteView } from '../node-notice';
import { Button } from '../ui/button';
import type { HomeDecision } from './types';

const KIND_META: Record<HomeDecision['kind'], { icon: typeof Send; label: string }> = {
  notification: { icon: Send, label: '通知' },
  approval: { icon: ScrollText, label: '待批' },
};

export function DecisionCard({ decision, className }: { decision: HomeDecision; className?: string }) {
  const now = useSlowNow();
  const remote = useRemoteView();
  const meta = KIND_META[decision.kind];
  const Icon = meta.icon;
  return (
    <li
      data-decision-card={decision.kind}
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-st-human/40 bg-st-human/6 p-4 sm:flex-row sm:items-start',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-st-human/15 text-ink-human">
          <Icon className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-nowrap items-baseline gap-x-2">
            {/* 种类换成 text-caption。 */}
            <span className="shrink-0 whitespace-nowrap text-caption font-medium uppercase tracking-wide text-ink-human">
              {meta.label}
            </span>
            {/* 时间换成 text-caption。 */}
            <span className="num shrink-0 whitespace-nowrap text-caption text-muted-foreground">
              {formatAgo(decision.since, now)}
            </span>
          </div>
          <p className="mt-1 text-sm font-medium leading-snug">{decision.title}</p>
          {decision.context ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{decision.context}</p>
          ) : null}
        </div>
      </div>
      {remote ? (
        // 看的是别的环境的快照：这条决定要在那台上答，这里只读，按钮置灰并说明
        <div className="flex shrink-0 flex-col items-start gap-1 self-start sm:items-end sm:self-center">
          <Button size="sm" variant="outline" disabled data-remote-disabled>
            去答
            <ArrowRight aria-hidden />
          </Button>
          <span className="text-caption text-muted-foreground">要去{remote.name}那台上答</span>
        </div>
      ) : (
        <Button asChild size="sm" variant="outline" className="shrink-0 self-start sm:self-center">
          <Link to={decision.link}>
            去答
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      )}
    </li>
  );
}
