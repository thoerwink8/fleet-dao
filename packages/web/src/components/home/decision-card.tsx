// 「要你拍的」一张卡：一个决定、一句背景、一个去答的地方。
// 来源三种——decision 级通知、待批的 approval、还没答的 ask。只显示一条（最重要的），多的进通知中心。

import { ArrowRight, MessageCircleQuestion, ScrollText, Send } from 'lucide-react';
import { Link } from 'react-router';
import { formatAgo } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import type { HomeDecision } from './types';

const KIND_META: Record<HomeDecision['kind'], { icon: typeof Send; label: string }> = {
  notification: { icon: Send, label: '通知' },
  approval: { icon: ScrollText, label: '待批' },
  ask: { icon: MessageCircleQuestion, label: '追问' },
};

export function DecisionCard({ decision, className }: { decision: HomeDecision; className?: string }) {
  const now = useNow();
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
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-human">
              {meta.label}
            </span>
            <span className="num text-[11px] text-muted-foreground">{formatAgo(decision.since, now)}</span>
          </div>
          <p className="mt-1 text-sm font-medium leading-snug">{decision.title}</p>
          {decision.context ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{decision.context}</p>
          ) : null}
        </div>
      </div>
      <Button asChild size="sm" variant="outline" className="shrink-0 self-start sm:self-center">
        <Link to={decision.link}>
          去答
          <ArrowRight aria-hidden />
        </Link>
      </Button>
    </li>
  );
}
