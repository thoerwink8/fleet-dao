import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { cn } from '../lib/cn';
import { summaryOf, TYPE_LABEL } from '../lib/describe';
import { formatRelative, shortId } from '../lib/format';
import { useSessions } from '../lib/hooks';
import { Chip } from './chip';
import { LoginPrompt } from './login-prompt';

/** 每 15 秒让「N 分钟前」自己走字，不依赖数据刷新。 */
function useNow(stepMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

export function SessionList({ className }: { className?: string }) {
  const { sessions, error, failures, unauthorized, hasMore, loadingMore, loadMore } = useSessions();
  const now = useNow();
  if (unauthorized) {
    return (
      <section aria-label="会话列表" className={cn('flex min-h-0 flex-col bg-surface', className)}>
        <LoginPrompt />
      </section>
    );
  }
  return (
    <section aria-label="会话列表" className={cn('flex min-h-0 flex-col bg-surface', className)}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-4 max-md:hidden">
        <span className="text-xs font-medium text-ink-2">会话</span>
        {sessions ? (
          <span className="num text-2xs text-muted">
            {sessions.length}
            {hasMore ? '+' : ''}
          </span>
        ) : null}
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-line bg-warning-soft px-4 py-2 text-2xs text-warning"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            读不到会话列表（{error}）。已有的先留着，{failures > 1 ? '隔得越来越久地' : '稍后'}自动重试。
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions === null ? (
          error ? null : (
            <p className="p-4 text-sm text-muted">正在读会话列表…</p>
          )
        ) : sessions.length === 0 ? (
          <div className="p-4 text-sm text-ink-2">
            <p className="font-medium">还没有会话</p>
            <p className="mt-1 text-2xs text-muted">
              新内核里有指挥官会话产生事件后，这里就会出现。开发环境见包里的 AGENTS.md。
            </p>
          </div>
        ) : (
          <ul>
            {sessions.map((s) => {
              const fresh = now - new Date(s.lastAt).getTime() < 60_000;
              return (
                <li key={s.id}>
                  <NavLink
                    to={`/s/${encodeURIComponent(s.id)}`}
                    className={({ isActive }) =>
                      cn(
                        'block border-b border-line px-4 py-3 transition-colors',
                        isActive ? 'bg-brand-soft' : 'hover:bg-subtle',
                      )
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          fresh ? 'animate-pulse-dot bg-brand' : 'bg-line-strong',
                        )}
                        title={fresh ? '刚有动静' : undefined}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={s.id}>
                        {shortId(s.id, 22)}
                      </span>
                      <span className="num shrink-0 text-2xs text-muted">
                        {formatRelative(s.lastAt, now)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 pl-3.5">
                      <span className="min-w-0 flex-1 truncate text-2xs text-ink-2">
                        <span className="text-muted">{TYPE_LABEL[s.lastType] ?? s.lastType} · </span>
                        {summaryOf(s.lastType, s.lastPayload)}
                      </span>
                      <Chip className="num">{s.eventCount}</Chip>
                    </div>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        )}
        {sessions && sessions.length > 0 && hasMore ? (
          <div className="p-3">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="h-9 w-full rounded-md border border-line text-xs font-medium text-ink-2 hover:bg-subtle disabled:opacity-60"
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
