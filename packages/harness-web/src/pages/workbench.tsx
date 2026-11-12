import { ChevronLeft, FolderGit2, Plus } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { AdeNewSessionComposer } from '../components/ade-composer';
import { Chip } from '../components/chip';
import { SessionList } from '../components/session-list';
import { SessionStream } from '../components/session-stream';
import { PageBar } from '../components/shell';
import { useAdeState } from '../lib/ade';
import { cn } from '../lib/cn';

/**
 * 会话工作台（全功能 ADE：新建会话、切换/添加工作区、实时事件流与会话控制）。
 * 电脑：左列会话列表、右边选中会话的事件流（未选时直接展示「发起新会话 / 工作区管理」发射台）；
 * 手机（768 以下）：`/` 显示列表与顶部「+ 新建会话」入口，`/s/<号>` 显示事件流。
 */
export function Workbench() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, selectWorkspace } = useAdeState();
  const sessionId = id ? decodeURIComponent(id) : undefined;
  const activeWs = state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0];

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
        extra={
          <div className="flex items-center gap-2">
            <label className="hidden items-center gap-1.5 text-2xs text-muted sm:inline-flex">
              <FolderGit2 className="size-3.5 text-brand" />
              <select
                aria-label="全局工作区切换"
                value={activeWs?.id ?? ''}
                onChange={(e) => void selectWorkspace(e.target.value)}
                className="h-7 max-w-[200px] truncate rounded-md border border-line bg-subtle px-2 text-2xs font-medium text-ink"
              >
                {state.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            {sessionId ? (
              <button
                type="button"
                onClick={() => void navigate('/')}
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-brand px-2.5 text-2xs font-medium text-white hover:bg-brand-hover"
              >
                <Plus className="size-3.5" />
                新建会话
              </button>
            ) : (
              <Chip tone="brand" mono className="hidden md:inline-flex">
                {activeWs?.path ?? 'D:/frank/fleet-dao'}
              </Chip>
            )}
          </div>
        }
      />
      <div className="grid min-h-0 flex-1 md:flex-none md:h-[calc(100dvh-var(--bar-h))] md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
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
          {sessionId ? <SessionStream key={sessionId} sessionId={sessionId} /> : <AdeNewSessionComposer />}
        </div>
      </div>
    </div>
  );
}
