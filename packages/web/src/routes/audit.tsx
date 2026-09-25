import { Bot, Cog, ScrollText, Search, Terminal, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useAllBoards, useAudit, useMe } from '../api/client';
import type { AuditEntry, Me } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { actionLabel, actorKindLabel, actorName, targetLabel, taskIndex, viaLabel } from '../lib/audit';
import { formatAgo, formatDateTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('操作记录') }];
}

const FILTERS: { id: 'all' | AuditEntry['actor']['kind']; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'user', label: '人' },
  { id: 'ai', label: brand.terms.marshal },
  { id: 'engine', label: '引擎' },
  { id: 'agent', label: '会话' },
];

function ActorIcon({ actor, me }: { actor: AuditEntry['actor']; me: Me | undefined }) {
  const icon =
    actor.kind === 'ai' ? (
      <Bot className="size-3.5" aria-hidden />
    ) : actor.kind === 'engine' ? (
      <Cog className="size-3.5" aria-hidden />
    ) : actor.kind === 'agent' ? (
      <Terminal className="size-3.5" aria-hidden />
    ) : null;
  if (icon) {
    return (
      <span
        className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
        title={actorKindLabel[actor.kind]}
      >
        {icon}
      </span>
    );
  }
  return (
    <span
      className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background"
      title={actorKindLabel[actor.kind]}
    >
      {actorName(actor, me).slice(0, 1)}
    </span>
  );
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export default function Audit() {
  const [params, setParams] = useSearchParams();
  const target = params.get('target') ?? undefined;
  const audit = useAudit(target);
  const { boards } = useAllBoards();
  const { data: me } = useMe();
  const now = useNow();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [q, setQ] = useState('');
  const tasks = taskIndex(boards.flatMap((b) => b.tasks));
  const all = audit.data?.pages.flatMap((p) => p.items) ?? [];
  const list = all
    .filter((a) => filter === 'all' || a.actor.kind === filter)
    .filter(
      (a) =>
        !q ||
        `${actorName(a.actor, me)} ${actorName(a.actor)} ${actionLabel(a.action)} ${a.action} ${targetLabel(a.target, tasks)} ${a.reason ?? ''} ${a.error ?? ''}`
          .toLowerCase()
          .includes(q.toLowerCase()),
    );

  const setTarget = (t: string | null) => {
    const p = new URLSearchParams(params);
    if (t) p.set('target', t);
    else p.delete('target');
    setParams(p, { replace: true });
  };

  return (
    <Page
      title="操作记录"
      description={`谁在什么时候做了什么：人的操作、${brand.terms.marshal}的调整、引擎的动作，只追加、不改、不删。先记后做，没做成的另记一条。`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          className="flex max-w-full overflow-x-auto rounded-lg bg-muted p-1"
          role="tablist"
          aria-label="按谁做的"
        >
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'h-7 shrink-0 rounded-md px-3 text-[13px] text-muted-foreground transition-colors',
                filter === f.id ? 'bg-card font-medium text-foreground shadow-sm' : 'hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {target ? (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-card pr-1 pl-3 text-[13px]">
            只看 {targetLabel(target, tasks)}
            <button
              type="button"
              onClick={() => setTarget(null)}
              className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="不再只看这个对象"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ) : null}
        <div className="relative ml-auto w-full sm:w-64">
          <Search
            className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜人、动作、对象、理由"
            className="h-8 pl-8"
            aria-label="搜索操作记录"
          />
        </div>
      </div>
      {audit.error ? (
        <div className="mb-3">
          <LoadError what="操作记录" error={audit.error} />
        </div>
      ) : null}
      <Panel bodyClassName="p-0">
        {audit.isLoading ? (
          <div className="p-4">
            <LoadingRows rows={6} />
          </div>
        ) : !audit.data ? (
          <p className="px-4 py-10 text-center text-sm text-ink-fail">
            没读到操作记录，这里空着不代表没人操作过
          </p>
        ) : list.length === 0 ? (
          <Empty
            icon={ScrollText}
            title="没有符合条件的记录"
            hint={all.length ? '换个过滤条件，或往前翻更早的。' : undefined}
          />
        ) : (
          <ol className="divide-y">
            {list.map((a) => (
              <li key={a.id} className={cn('flex items-start gap-3 px-4 py-3', !a.ok && 'bg-st-fail/[0.05]')}>
                <ActorIcon actor={a.actor} me={me} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                    <span className="font-medium" title={a.actor.id}>
                      {actorName(a.actor, me)}
                    </span>
                    <span className={cn(!a.ok && 'text-ink-fail')} title={a.action}>
                      {actionLabel(a.action)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setTarget(a.target)}
                      className="min-w-0 truncate text-left text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      title="只看这个对象的记录"
                    >
                      {targetLabel(a.target, tasks)}
                    </button>
                    {!a.ok ? (
                      <Badge variant="outline" className="h-5 border-st-fail/50 text-[10px] text-ink-fail">
                        没做成
                      </Badge>
                    ) : null}
                  </div>
                  {a.reason ? (
                    <p className="mt-0.5 text-[13px] text-muted-foreground">理由：{a.reason}</p>
                  ) : null}
                  {a.error ? <p className="mt-0.5 text-[13px] text-ink-fail">{a.error}</p> : null}
                  {a.before !== undefined || a.after !== undefined ? (
                    <details className="mt-1 text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none hover:text-foreground">
                        看改了什么
                      </summary>
                      <div className="mt-1.5 grid gap-2 md:grid-cols-2">
                        {a.before !== undefined ? (
                          <div>
                            <div className="mb-1">之前</div>
                            <pre className="num overflow-x-auto rounded-md bg-muted/70 p-2 text-[11px] scrollbar-thin">
                              {json(a.before)}
                            </pre>
                          </div>
                        ) : null}
                        {a.after !== undefined ? (
                          <div>
                            <div className="mb-1">之后</div>
                            <pre className="num overflow-x-auto rounded-md bg-muted/70 p-2 text-[11px] scrollbar-thin">
                              {json(a.after)}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="num text-xs text-muted-foreground" title={formatDateTime(a.at)}>
                    {formatAgo(a.at, now)}
                  </span>
                  <span className="rounded bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
                    经{viaLabel[a.via]}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
        {audit.hasNextPage ? (
          <div className="border-t p-2 text-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void audit.fetchNextPage()}
              disabled={audit.isFetchingNextPage}
            >
              {audit.isFetchingNextPage ? '正在读更早的…' : '看更早的记录'}
            </Button>
          </div>
        ) : null}
      </Panel>
    </Page>
  );
}
