// 按编号打开的详情记住上一次的失败（#1220 单子详情，#1221 扫到远程环境）。
// 没读到过数据的查询一被重读（实时推送、点重试），React Query 会把 error 清空、退回 pending。
// 页面不记住上一次的，就在「没读成」和加载骨架之间来回跳，推送勤就一直在转。读成了才清掉。
import { useEffect, useState } from 'react';

export function useShownError(id: string | undefined, query: { error: unknown; data: unknown }): unknown {
  const [held, setHeld] = useState<{ id: string | undefined; error: unknown } | null>(null);
  useEffect(() => {
    if (query.error) setHeld({ id, error: query.error });
    else if (query.data) setHeld(null);
  }, [id, query.error, query.data]);
  if (query.error) return query.error;
  if (query.data || held?.id !== id) return undefined;
  return held?.error;
}
