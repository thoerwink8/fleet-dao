import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { cn } from '../lib/cn';
import { readDoneCollapsed, writeDoneCollapsed } from '../lib/collapse';
import { summaryOf } from '../lib/describe';
import { formatRelative, shortId } from '../lib/format';
import { useSessions } from '../lib/hooks';
import { typeLabel } from '../lib/labels';
import { deriveWorkerState, groupByState, STATE_LABEL, type WorkerState } from '../lib/session-state';
import type { SessionSummary } from '../lib/types';
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

const DOT: Record<WorkerState, string> = {
  stuck: 'bg-danger',
  running: 'animate-pulse-dot bg-brand',
  waiting: 'bg-line-strong',
  done: 'bg-line-strong',
};

function SessionRow({ s, state, now }: { s: SessionSummary; state: WorkerState; now: number }) {
  return (
    <li data-session-id={s.id} data-state={state}>
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
          <span className={cn('size-1.5 shrink-0 rounded-full', DOT[state])} title={STATE_LABEL[state]} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium" title={s.id}>
            {shortId(s.id, 22)}
          </span>
          <span className="num shrink-0 text-2xs text-muted">{formatRelative(s.lastAt, now)}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 pl-3.5">
          <span className="min-w-0 flex-1 truncate text-2xs text-ink-2">
            <span className="text-muted" title={s.lastType}>
              {typeLabel(s.lastType).text} ·{' '}
            </span>
            {summaryOf(s.lastType, s.lastPayload)}
          </span>
          <Chip className="num">{s.eventCount}</Chip>
        </div>
      </NavLink>
    </li>
  );
}

export function SessionList({ className }: { className?: string }) {
  const { sessions, stuckCount, error, failures, unauthorized, hasMore, loadingMore, loadMore } =
    useSessions();
  const now = useNow();
  // 「做完」组默认折叠；点开的状态记在 localStorage（读写都包了 try/catch）
  const [doneCollapsed, setDoneCollapsed] = useState(() => readDoneCollapsed());
  const toggleDone = () => {
    writeDoneCollapsed(!doneCollapsed);
    setDoneCollapsed(!doneCollapsed);
  };
  // 状态从近期事件推：同一份事件和同一个 now 推出同一个状态，组内按最后事件号倒序
  const groups = useMemo(
    () => (sessions ? groupByState(sessions, (s) => deriveWorkerState(s.tail ?? [], now)) : []),
    [sessions, now],
  );
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
        <span className="flex items-center gap-2">
          {stuckCount !== null && stuckCount > 0 ? (
            <Chip tone="danger" className="num" title="卡住或失败的会话数（服务端按全部会话数的）">
              卡住 {stuckCount}
            </Chip>
          ) : null}
          {sessions ? (
            <span className="num text-2xs text-muted">
              {sessions.length}
              {hasMore ? '+' : ''}
            </span>
          ) : null}
        </span>
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
          groups.map((g) => {
            const foldable = g.state === 'done';
            const folded = foldable && doneCollapsed;
            const headCls = cn(
              'sticky top-0 z-10 flex h-8 w-full items-center gap-2 border-b border-line px-4 text-2xs font-medium',
              g.state === 'stuck' ? 'bg-danger-soft text-danger' : 'bg-subtle text-muted',
            );
            const head = (
              <>
                {foldable ? (
                  folded ? (
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                  )
                ) : null}
                {STATE_LABEL[g.state]}
                <span className="num" data-testid={`group-count-${g.state}`}>
                  {g.items.length}
                </span>
              </>
            );
            return (
              <section key={g.state} aria-label={STATE_LABEL[g.state]} data-group={g.state}>
                <h3>
                  {foldable ? (
                    <button
                      type="button"
                      aria-expanded={!folded}
                      data-testid="toggle-done"
                      onClick={toggleDone}
                      className={cn(headCls, 'cursor-pointer text-left hover:text-ink')}
                    >
                      {head}
                    </button>
                  ) : (
                    <span className={headCls}>{head}</span>
                  )}
                </h3>
                {folded ? null : (
                  <ul>
                    {g.items.map((s) => (
                      <SessionRow key={s.id} s={s} state={g.state} now={now} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })
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
