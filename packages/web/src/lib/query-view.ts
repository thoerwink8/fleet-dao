// 一次读取在页面眼里的样子（#3509 方案第三节第 4 条）：从没读成才是 error；读成过、这次刷新没成是 stale（照旧画旧数据）。
// React Query 在「有旧数据、刷新失败」时 error 也有值但 data 还在；页面只看 error 就会把整页换成红条、丢掉旧数据。
// 所有读页都走这里把 query 折成三种：loading / error / data（带可选的 stale）。

/** 刷新没成、下面还是上一次的数据：错在哪、上一次读成是什么时候、怎么重读。 */
export interface StaleInfo {
  error: unknown;
  /** 上一次读成的时刻（毫秒），React Query 的 dataUpdatedAt。 */
  dataUpdatedAt: number;
  retry: () => void;
}

export type QueryView<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown; retry: () => void }
  | { status: 'data'; data: T; stale?: StaleInfo };

interface QueryLike<T> {
  error: unknown;
  data: T | undefined;
  dataUpdatedAt: number;
  refetch: () => unknown;
}

/**
 * query → 页面要画的样子之一：
 * - 有数据：画数据；这时还带着 error，就是 stale（读成过、刷新没成），不是 error。
 * - 没数据有 error：error（从没读成）。
 * - 没数据没 error：loading。
 */
export function viewOf<T>(query: QueryLike<T>): QueryView<T> {
  const retry = () => void query.refetch();
  if (query.data !== undefined) {
    return query.error
      ? {
          status: 'data',
          data: query.data,
          stale: { error: query.error, dataUpdatedAt: query.dataUpdatedAt, retry },
        }
      : { status: 'data', data: query.data };
  }
  if (query.error) return { status: 'error', error: query.error, retry };
  return { status: 'loading' };
}
