import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ChangesPanel } from '../components/changes-panel';
import { EmptyComposer } from '../components/composer';
import { SessionList } from '../components/session-list';
import { SessionStream } from '../components/session-stream';
import { PageBar } from '../components/shell';
import { TerminalPanel } from '../components/terminal-panel';
import { cn } from '../lib/cn';
import { IS_LOCAL } from '../lib/profile';
import { useMediaQuery } from '../lib/work-hooks';

/**
 * 会话工作台。电脑：左列会话、右边对话；手机两个画面。
 * 本机没选中会话时，右边是居中的新会话输入。香港那份仍是只读事件流。
 */
export function Workbench() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const sessionId = id ? decodeURIComponent(id) : undefined;
  const narrow = useMediaQuery('(max-width: 767px)');
  const composing = IS_LOCAL && !sessionId && (!narrow || params.get('new') === '1');
  const [changes, setChanges] = useState(false);
  const [terminal, setTerminal] = useState(false);
  return (
    <div className="flex h-[calc(100dvh-var(--bar-h))] max-h-[calc(100dvh-var(--bar-h))] min-h-0 min-w-0 flex-col overflow-hidden md:h-dvh md:max-h-dvh">
      <PageBar
        title={sessionId ? <span className="truncate text-sm">{IS_LOCAL ? '对话' : sessionId}</span> : '会话'}
        leading={
          sessionId || composing ? (
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
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden md:grid-cols-[280px_minmax(0,1fr)]">
        <div
          className={cn(
            'h-full min-h-0 min-w-0 flex-col overflow-hidden border-line md:flex md:border-r',
            sessionId || composing ? 'hidden' : 'flex',
          )}
        >
          <SessionList className="min-h-0 flex-1" />
        </div>
        <div
          className={cn(
            'relative h-full min-h-0 min-w-0 flex-col overflow-hidden md:flex',
            sessionId || composing ? 'flex' : 'hidden',
          )}
        >
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {sessionId ? (
              <SessionStream
                key={sessionId}
                sessionId={sessionId}
                {...(IS_LOCAL
                  ? {
                      onToggleChanges: () => setChanges((v) => !v),
                      onToggleTerminal: () => setTerminal((v) => !v),
                    }
                  : {})}
              />
            ) : composing ? (
              <EmptyComposer />
            ) : (
              <div className="grid flex-1 place-items-center p-6 text-center">
                <p className="text-sm font-medium text-ink-2">选一个会话看它的事件流</p>
                <p className="mt-1 text-2xs text-muted">
                  只读：这里看得到派工、工人起止、交回核验，新事件实时出现。
                </p>
              </div>
            )}
            {IS_LOCAL && sessionId && terminal ? (
              <TerminalPanel sessionId={sessionId} onClose={() => setTerminal(false)} />
            ) : null}
          </div>
          {IS_LOCAL && sessionId && changes ? (
            <ChangesPanel sessionId={sessionId} onClose={() => setChanges(false)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
