// 本机会话列表：置顶 / 最近 / 按工作区。标题用会话名，预览用最后一句人话。
// 置顶、归档、改名写在会话行上。轮数读会话行的 turns，不数事件条数。
import { MoreHorizontal, Pin, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { type AdeSession, type AdeWorkspace, adeGet, patchSession, sessionListPath } from '../lib/ade';
import { cn } from '../lib/cn';
import { useSessions } from '../lib/hooks';
import { roundLabel } from '../lib/rounds';
import { buildRows, type SessionListRow } from '../lib/session-rows';
import { type NestedSession, nestSessions } from '../lib/session-tree';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { WorkspaceDialog } from './composer';

const NO_IDS: string[] = [];

type SessionRow = NestedSession<SessionListRow>;

export function LocalSessions({ className }: { className?: string }) {
  const nav = useNavigate();
  const { sessions } = useSessions();
  const [ade, setAde] = useState<AdeSession[]>([]);
  const [spaces, setSpaces] = useState<AdeWorkspace[]>([]);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null);
  const [hiddenAde, setHiddenAde] = useState<{ key: string; ids: string[] } | null>(null);
  const alive = useRef(true);
  const req = useRef(0);
  const askedKey = (sessions ?? [])
    .map((s) => s.id)
    .slice(0, 200)
    .join(',');
  const reload = useCallback(() => {
    const mine = ++req.current;
    const known = askedKey ? askedKey.split(',') : [];
    adeGet<{ sessions: AdeSession[]; knownIds?: string[] }>(sessionListPath({ q, archived, known }))
      .then((r) => {
        if (!alive.current || mine !== req.current) return;
        setAde(r.sessions);
        if (askedKey === '') setHiddenAde({ key: '', ids: NO_IDS });
        else if (r.knownIds) setHiddenAde({ key: askedKey, ids: r.knownIds });
      })
      .catch(() => {});
    adeGet<{ workspaces: AdeWorkspace[] }>('/workspaces')
      .then((r) => {
        if (alive.current && mine === req.current) setSpaces(r.workspaces);
      })
      .catch(() => {});
  }, [q, archived, askedKey]);
  useEffect(() => {
    alive.current = true;
    reload();
    const t = setInterval(reload, 5000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload]);
  const save = (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => {
    void patchSession(id, patch).then(reload);
  };
  const classified = askedKey === '' || hiddenAde?.key === askedKey;
  const knownIds = hiddenAde?.key === askedKey ? hiddenAde.ids : NO_IDS;
  const knownAdeIds = useMemo(() => new Set(knownIds), [knownIds]);
  const includeKernel = !archived && q.trim() === '' && classified;
  const grouped = useMemo(() => {
    const flat = buildRows(ade, sessions, spaces, includeKernel, knownAdeIds);
    const rows = nestSessions(flat);
    const pinnedHere = (r: SessionRow): boolean => r.pinned || r.children.some(pinnedHere);
    const pinned = rows.filter(pinnedHere);
    const rest = rows.filter((r) => !pinnedHere(r)).sort((a, b) => b.lastAt - a.lastAt);
    const recent = rest.slice(0, 8);
    const recentIds = new Set(recent.map((r) => r.id));
    const buckets = new Map<string, { name: string; rows: SessionRow[] }>();
    for (const r of rest) {
      if (recentIds.has(r.id)) continue;
      const b = buckets.get(r.workspaceId) ?? { name: r.workspaceName, rows: [] };
      b.rows.push(r);
      buckets.set(r.workspaceId, b);
    }
    return { pinned, recent, workspaces: [...buckets.entries()] };
  }, [ade, sessions, spaces, includeKernel, knownAdeIds]);

  const section = (label: string, rows: SessionRow[]) =>
    rows.length === 0 ? null : (
      <div key={label}>
        <p className="px-3 pt-3 pb-1 text-2xs text-muted">{label}</p>
        <ul className="min-w-0">{rows.map((r) => rowView(r))}</ul>
      </div>
    );
  const rowView = (r: SessionRow) => (
    <li
      key={r.id}
      data-session-id={r.id}
      data-running={r.running}
      data-parent-id={r.parentId ?? ''}
      className="flex min-w-0 flex-col overflow-hidden"
    >
      <div className="flex min-w-0">
        <NavLink
          to={`/s/${encodeURIComponent(r.id)}`}
          title={r.id}
          className={({ isActive }) =>
            cn(
              'block min-w-0 flex-1 px-3 py-2',
              r.parentId ? 'pl-6' : '',
              isActive ? 'bg-selected' : 'hover:bg-inset',
            )
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn('size-1.5 shrink-0 rounded-full', r.running ? 'bg-running' : 'bg-idle')} />
            {r.parentId ? <span className="shrink-0 text-2xs text-muted">子</span> : null}
            <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
          </div>
          {r.preview ? <p className="mt-0.5 truncate pl-3.5 text-2xs text-muted">{r.preview}</p> : null}
          <p className="mt-0.5 flex items-center gap-1 truncate pl-3.5 text-2xs text-muted">
            <span className="min-w-0 flex-1 truncate">
              {[r.model, r.agent, r.turns === null ? '' : roundLabel(r.turns)].filter(Boolean).join(' · ')}
            </span>
          </p>
        </NavLink>
        {r.turns === null ? null : (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" className="mr-1 size-6 self-center" aria-label="整理会话">
                {r.pinned ? <Pin className="size-3" /> : <MoreHorizontal className="size-3" />}
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => setRename({ id: r.id, title: r.title })}>改名</MenuItem>
              <MenuItem onSelect={() => save(r.id, { pinned: !r.pinned })}>
                {r.pinned ? '取消置顶' : '置顶'}
              </MenuItem>
              <MenuItem onSelect={() => save(r.id, { archived: !archived })}>
                {archived ? '取消归档' : '归档'}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      {r.children.length > 0 ? (
        <ul className="ml-3 min-w-0 border-l border-line">{r.children.map((child) => rowView(child))}</ul>
      ) : null}
    </li>
  );

  return (
    <section aria-label="会话列表" className={cn('flex min-h-0 min-w-0 flex-col bg-sidebar', className)}>
      <div className="flex items-center gap-1 border-b border-line p-2">
        <Search className="ml-1 size-3.5 text-muted" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索会话"
          aria-label="搜索会话"
          className="h-8 flex-1 border-0 bg-transparent focus-visible:ring-0"
        />
        <Button variant="ghost" size="sm" aria-pressed={archived} onClick={() => setArchived((v) => !v)}>
          {archived ? '返回' : '已归档'}
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="新建">
              <Plus />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => nav('/?new=1')}>新会话</MenuItem>
            <MenuItem onSelect={() => setAddOpen(true)}>添加工作区</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {section('置顶', grouped.pinned)}
        {section('最近', grouped.recent)}
        {grouped.workspaces.map(([id, b]) => section(b.name || id || '内核', b.rows))}
        {grouped.pinned.length + grouped.recent.length + grouped.workspaces.length === 0 ? (
          <p className="px-3 py-6 text-xs text-muted">
            {archived
              ? '没有已归档的会话。'
              : q.trim()
                ? '没有标题对得上的会话。'
                : '还没有会话。右边写第一句。'}
          </p>
        ) : null}
      </div>
      <WorkspaceDialog open={addOpen} onOpenChange={setAddOpen} onAdded={reload} />
      <Dialog
        open={rename !== null}
        onOpenChange={(open) => {
          if (!open) setRename(null);
        }}
      >
        <DialogContent title="改名">
          <Input
            aria-label="会话标题"
            value={rename?.title ?? ''}
            onChange={(e) => setRename((cur) => (cur ? { ...cur, title: e.target.value } : cur))}
          />
          <div className="mt-3 flex justify-end">
            <Button
              onClick={() => {
                if (!rename) return;
                const id = rename.id;
                const title = rename.title;
                setRename(null);
                save(id, { title });
              }}
            >
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
