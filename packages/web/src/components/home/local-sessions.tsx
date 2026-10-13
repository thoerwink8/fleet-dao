// 主页抽屉的「本机会话」一页（#1991）：创始人电脑上的 AI 会话，四态（在跑、刚停、超过阈值没动、没上报）。
// 写法在 local-sessions-view.ts；这里只管排版。数据每 30 秒拉一次（本机每 2 分钟推）。
import { Laptop } from 'lucide-react';
import { useLocalSessions } from '../../api/client';
import { useNow } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { EmptyState } from '../layout/empty-state';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { StatusBadge } from '../layout/status-badge';
import { localBrief, localView, type NodeBlock } from './local-sessions-view';

/** 抽屉按钮、手机横条上的那一句。 */
export function useLocalBrief() {
  const q = useLocalSessions();
  const now = useNow();
  return localBrief(q.data ? localView(q.data, now) : undefined);
}

function NodeList({ node }: { node: NodeBlock }) {
  return (
    <section
      data-local-node={node.id}
      data-reporting={node.reporting}
      className="grid min-w-0 grid-cols-1 gap-2"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="min-w-0 truncate text-body font-medium">{node.machine}</span>
        <StatusBadge
          tone={node.reporting ? 'done' : 'stall'}
          variant="dot"
          label={node.reporting ? '在上报' : '没上报'}
        />
      </div>
      {node.why ? (
        <Notice tone="stall" title="没上报">
          {node.why.replace(/^没上报：/, '')}
        </Notice>
      ) : null}
      {node.lines.length ? (
        <ul className={cn('divide-y divide-border', !node.reporting && 'opacity-60')}>
          {node.lines.map((l) => (
            <li key={l.key} className="px-3 py-2" data-local-session={l.key} data-tone={l.tone}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="num min-w-0 flex-1 truncate text-body" title={l.title}>
                  {l.title}
                </span>
                <StatusBadge tone={l.tone} variant="dot" label={l.label} />
              </div>
              <div className="flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
                <span className="min-w-0 flex-1 truncate" title={l.meta}>
                  {l.meta}
                </span>
                <span className="shrink-0">{l.when}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : node.reporting ? (
        <p className="px-1 text-meta text-muted-foreground">这台此刻没有会话（2 小时内也没有停下的）。</p>
      ) : null}
      {node.problems.length ? (
        <p className="px-1 text-meta break-words text-muted-foreground">
          本机没读成的：{node.problems.join('；')}
        </p>
      ) : null}
    </section>
  );
}

export function LocalSessionsPanel() {
  const q = useLocalSessions();
  const now = useNow();
  if (q.isLoading) return <LoadingRows rows={3} />;
  if (q.error) return <LoadError what="本机会话" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return null;
  const v = localView(q.data, now);
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4" data-local-sessions>
      <p className="px-1 text-meta text-muted-foreground">
        本机钩子写的心跳，每 2 分钟推到法国；只有仓、分支、工具名这类元信息。不是引擎的单。
      </p>
      {v.kind === 'ok' ? (
        v.nodes.map((n) => <NodeList key={n.id} node={n} />)
      ) : (
        <EmptyState
          icon={Laptop}
          title={v.kind === 'notWired' ? '没接上' : '还没有本机推来过'}
          hint={v.why}
        />
      )}
    </div>
  );
}
