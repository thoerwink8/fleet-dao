// 本机会话列表：置顶 / 最近 / 按工作区。标题用会话名，预览用最后一句人话。
import { Pin, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { type AdeSession, type AdeWorkspace, adeGet } from '../lib/ade';
import { cn } from '../lib/cn';
import { useSessions } from '../lib/hooks';
import { previewText, sessionTitle } from '../lib/preview';
import { matchingFamilies, type NestedSession, nestSessions } from '../lib/session-tree';
import type { SessionSummary } from '../lib/types';
import { Button } from '../ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { WorkspaceDialog } from './composer';

const PIN_KEY = 'fleet.next.session-pins';

function readPins(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PIN_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface Row {
  id: string;
  parentId: string | null;
  title: string;
  preview: string;
  workspaceId: string;
  workspaceName: string;
  agent: string;
  model: string;
  running: boolean;
  turns: number;
  lastAt: number;
}

type SessionRow = NestedSession<Row>;

function buildRows(ade: AdeSession[], cockpit: SessionSummary[] | null, spaces: AdeWorkspace[]): Row[] {
  const byId = new Map((cockpit ?? []).map((s) => [s.id, s]));
  const names = new Map(spaces.map((w) => [w.id, w.name]));
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const s of ade) {
    seen.add(s.id);
    const c = byId.get(s.id);
    rows.push({
      id: s.id,
      parentId: s.parentId ?? null,
      title: sessionTitle(s.title),
      preview: c ? previewText(c.lastType, c.lastPayload) : '',
      workspaceId: s.workspaceId,
      workspaceName: names.get(s.workspaceId) ?? '工作区',
      agent: s.agent ?? '',
      model: s.model ?? '',
      running: s.status === 'running',
      turns: c?.eventCount ?? 0,
      lastAt: Date.parse(s.updatedAt ?? c?.lastAt ?? '') || 0,
    });
  }
  for (const s of cockpit ?? []) {
    if (seen.has(s.id)) continue;
    rows.push({
      id: s.id,
      parentId: null,
      title: sessionTitle(undefined),
      preview: previewText(s.lastType, s.lastPayload),
      workspaceId: '',
      workspaceName: '内核',
      agent: '',
      model: '',
      running: false,
      turns: s.eventCount,
      lastAt: Date.parse(s.lastAt) || 0,
    });
  }
  return rows;
}

export function LocalSessions({ className }: { className?: string }) {
  const nav = useNavigate();
  const { sessions } = useSessions();
  const [ade, setAde] = useState<AdeSession[]>([]);
  const [spaces, setSpaces] = useState<AdeWorkspace[]>([]);
  const [q, setQ] = useState('');
  const [pins, setPins] = useState<string[]>(readPins);
  const [addOpen, setAddOpen] = useState(false);
  const alive = useRef(true);
  const reload = useCallback(() => {
    adeGet<{ sessions: AdeSession[] }>('/sessions')
      .then((r) => {
        if (alive.current) setAde(r.sessions);
      })
      .catch(() => {});
    adeGet<{ workspaces: AdeWorkspace[] }>('/workspaces')
      .then((r) => {
        if (alive.current) setSpaces(r.workspaces);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    alive.current = true;
    reload();
    const t = setInterval(reload, 5000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [reload]);
  const togglePin = (id: string) => {
    const next = pins.includes(id) ? pins.filter((x) => x !== id) : [id, ...pins];
    setPins(next);
    try {
      localStorage.setItem(PIN_KEY, JSON.stringify(next));
    } catch {
      /* 记不住就只管这一次 */
    }
  };
  const grouped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const flat = buildRows(ade, sessions, spaces);
    const matched = needle
      ? matchingFamilies(flat, (r) =>
          `${r.title} ${r.preview} ${r.workspaceName}`.toLowerCase().includes(needle),
        )
      : flat;
    const rows = nestSessions(matched);
    const pinnedHere = (r: SessionRow): boolean => pins.includes(r.id) || r.children.some(pinnedHere);
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
  }, [ade, sessions, spaces, q, pins]);

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
              {[r.model, r.agent, r.turns ? `${r.turns} 轮` : ''].filter(Boolean).join(' · ')}
            </span>
          </p>
        </NavLink>
        <Button
          variant="ghost"
          size="icon"
          className="mr-1 size-6 self-center"
          aria-label={pins.includes(r.id) ? '取消置顶' : '置顶'}
          onClick={() => togglePin(r.id)}
        >
          <Pin className="size-3" />
        </Button>
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
          <p className="px-3 py-6 text-xs text-muted">还没有会话。右边写第一句。</p>
        ) : null}
      </div>
      <WorkspaceDialog open={addOpen} onOpenChange={setAddOpen} onAdded={reload} />
    </section>
  );
}
