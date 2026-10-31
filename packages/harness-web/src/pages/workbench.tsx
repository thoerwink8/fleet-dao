import { ChevronLeft, MessagesSquare } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { SessionList } from '../components/session-list';
import { SessionStream } from '../components/session-stream';
import { PageBar } from '../components/shell';
import { cn } from '../lib/cn';

/**
 * 会话工作台（只读）。电脑：左列会话列表、右边选中会话的事件流；手机（768 以下）：两个画面，
 * `/` 只有列表，`/s/<号>` 只有事件流，左上角返回。
 */
export function Workbench() {
  const { id } = useParams();
  const sessionId = id ? decodeURIComponent(id) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar
        title={sessionId ? <span className="font-mono text-sm">{sessionId}</span> : '会话'}
        leading={
          sessionId ? (
            <Link
              to="/"
              aria-label="返回会话列表"
              className="-ml-1 grid size-8 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-neutral-soft md:hidden"
            >
              <ChevronLeft className="size-5" />
            </Link>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 md:h-[calc(100dvh-var(--bar-h))] md:grid-cols-[320px_minmax(0,1fr)]">
        <SessionList
          className={cn(
            'border-line md:border-r',
            sessionId ? 'hidden md:flex' : 'flex',
            'h-[calc(100dvh-var(--bar-h)*2)] md:h-auto',
          )}
        />
        <div
          className={cn(
            'min-h-0 min-w-0 flex-col',
            sessionId ? 'flex h-[calc(100dvh-var(--bar-h)*2)] md:h-auto' : 'hidden md:flex',
          )}
        >
          {sessionId ? (
            <SessionStream key={sessionId} sessionId={sessionId} />
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-center">
              <div>
                <MessagesSquare className="mx-auto size-8 text-line-strong" />
                <p className="mt-3 text-sm font-medium text-ink-2">选一个会话看它的事件流</p>
                <p className="mt-1 text-2xs text-muted">
                  只读：这里看得到派工、工人起止、交回核验，新事件实时出现。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
