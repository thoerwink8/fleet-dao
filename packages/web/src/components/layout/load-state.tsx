// 读数据的过渡态（#3509 方案第三节第 4 条，样子照 Arco）。一块数据只有五种样子：
// - loading 第一次在读：骨架行（LoadingRows），不画 0、不画空列表。
// - error 从没读成：红提示条「X没读成：原因」+「重试」（LoadError），指标、表格都不画。
// - stale 读成过、这次刷新没成：照旧画上一次的数据，顶上橙提示条「刷新没成，下面是 N 前的」+「重试」（LoadStale）。
// - empty 读成了、真没有：EmptyState（empty-state.tsx），和读失败不混用一句话。
// - partial 读成了一部分：顶上一条橙提示说缺了哪部分（LoadPartial），缺的那格写灰字「没读到」。
import { errMessage } from '@fleet-dao/shared/util';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorDetail, errorRaw } from '../route-error';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { Notice } from './notice';

/** 骨架行：每行和列表行一样高（40），里面一根 16 高的灰条，最后一行短一截。 */
export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 占位骨架没有身份，下标就是它的身份。
        <div key={i} data-skeleton-row className="flex h-row items-center">
          <Skeleton className={i === rows - 1 && rows > 1 ? 'h-4 w-3/5' : 'h-4 w-full'} />
        </div>
      ))}
    </div>
  );
}

/** 「把眼下所有读失败的查询再读一遍」：没给 onRetry 时的默认重试。 */
function useRetryFailed(onRetry: (() => void) | undefined): () => void {
  const qc = useQueryClient();
  return onRetry ?? (() => void qc.refetchQueries({ predicate: (q) => q.state.status === 'error' }));
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    // 照样稿（Settings、Quota 的「重试」）：灰底次按钮，不和页面的主操作抢
    <Button type="button" size="xs" variant="secondary" onClick={onClick}>
      重试
    </Button>
  );
}

/**
 * 查询出错时的一行说明：不编造，写明没查成、哪一块没查成，并带一个「重试」按钮。渲染就是 Notice（tone=fail，红底）。
 * 给了 onRetry 就点它；没给（多数页面）= 把眼下所有读失败的查询再读一遍（哪一块挂了就重读哪一块），不用每个页面各接一个 refetch。
 */
export function LoadError({
  error,
  what,
  onRetry,
  text,
}: {
  error: unknown;
  what?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** 整句说明。给了就不再拼「哪一块没读成」（两条失败合成一条横幅时用）。 */
  text?: string | undefined;
}) {
  const retry = useRetryFailed(onRetry);
  return (
    <Notice tone="fail" action={<RetryButton onClick={retry} />}>
      <ErrorDetail
        summary={text ?? `${what ? `${what}没读成` : '没查成'}：${errMessage(error)}`}
        raw={errorRaw(error)}
      />
    </Notice>
  );
}

/**
 * 刷新没成、下面还是上一次的数据：橙提示条 +「重试」。when 是上一次读成的时间说法（「5 分钟前」）；
 * expired 时（过了这一页的 staleAfterMs）改说「数据已过期」，不把旧数据当新的不说。
 */
export function LoadStale({
  error,
  what,
  when,
  expired,
  onRetry,
}: {
  error: unknown;
  what?: string | undefined;
  /** 上一次读成是什么时候（「5 分钟前」）。 */
  when?: string | undefined;
  expired?: boolean | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const retry = useRetryFailed(onRetry);
  const head = expired ? '数据已过期' : `${what ?? ''}刷新没成`;
  const tail = when ? `下面是${when}读到的` : '下面是上一次读到的';
  return (
    <Notice tone="stall" action={<RetryButton onClick={retry} />}>
      <ErrorDetail summary={`${head}，${tail}：${errMessage(error)}`} raw={errorRaw(error)} />
    </Notice>
  );
}

/** 只读成一部分：橙提示条写清缺了哪部分（「来自需求 N」没查成：原因）。缺的那格由页面写灰字「没读到」。 */
export function LoadPartial({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <Notice tone="stall" role="status" action={action}>
      {children}
    </Notice>
  );
}
