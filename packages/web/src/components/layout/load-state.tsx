// 读数据的两种过渡态：骨架行和出错重试。
import { errMessage } from '@fleet-dao/shared/util';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorDetail, errorRaw } from '../route-error';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { Notice } from './notice';

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 占位骨架没有身份，下标就是它的身份。
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/**
 * 查询出错时的一行说明：不编造，写明没查成、哪一块没查成，并带一个「重试」按钮。渲染就是 Notice（tone=fail）。
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
  const qc = useQueryClient();
  const retry = onRetry ?? (() => void qc.refetchQueries({ predicate: (q) => q.state.status === 'error' }));
  return (
    <Notice
      tone="fail"
      action={
        <Button type="button" size="xs" variant="outline" onClick={retry}>
          重试
        </Button>
      }
    >
      <ErrorDetail
        summary={text ?? `${what ? `${what}没读成` : '没查成'}：${errMessage(error)}`}
        raw={errorRaw(error)}
      />
    </Notice>
  );
}
