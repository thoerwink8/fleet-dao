// 账号池要人动手的毛病（额度读不到、凭据过期，#1748）在路由页、渠道状态页、额度页的同一种说法：
// 一行「额度读不到：原因。要人做：做什么」，挂在池旁边。数据来自没处理的提醒（lib/pool-problems.ts），和铃铛是同一份请求。
// 提醒没读成时不写「没有毛病」：读成了才画，没读成由调用方决定写不写一句「提醒没读成」。

import { TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { useNotifications } from '../api/client';
import { formatAgo } from '../lib/format';
import { type PoolProblem, poolProblemsOf, problemLine } from '../lib/pool-problems';
import { cn } from '../lib/utils';

export function usePoolProblems(): {
  problems: ReadonlyMap<string, PoolProblem>;
  /** 没处理的提醒没读成：这时 problems 是空的，不代表没毛病。 */
  error: unknown;
} {
  const q = useNotifications('open');
  const items = q.data?.items;
  const problems = useMemo(() => poolProblemsOf(items), [items]);
  return { problems, error: q.error };
}

/** 一个池的毛病，一行话，带「几小时前报的」。窄屏自己换行；oneLine 时不折、放不下截断，整句在悬停里（额度页的池行，#1921）。 */
export function PoolProblemLine({
  problem,
  now,
  className,
  oneLine = false,
}: {
  problem: PoolProblem;
  now?: number;
  className?: string;
  oneLine?: boolean;
}) {
  return (
    <p
      data-pool-problem={problem.kind}
      data-pool={problem.poolId}
      data-one-line={oneLine || undefined}
      title={problemLine(problem)}
      className={cn(
        'flex min-w-0 gap-1.5 text-meta text-ink-stall',
        oneLine ? 'items-center whitespace-nowrap' : 'items-start',
        className,
      )}
    >
      <TriangleAlert className={cn('size-3 shrink-0', !oneLine && 'mt-0.5')} aria-hidden />
      <span className={cn('min-w-0', oneLine ? 'truncate' : 'break-words')}>
        <span className="font-medium">{problem.kind === 'unreadable' ? '额度读不到' : '额度读数过期'}</span>：
        {problem.reason}。<span className="font-medium">要人做：</span>
        {problem.action}
        {now === undefined ? null : <span className="num">（{formatAgo(problem.since, now)}报的）</span>}
      </span>
    </p>
  );
}
