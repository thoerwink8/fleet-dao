import { Bot, Cog, ScrollText, Search, Terminal, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useAllBoards, useAudit, useMe, useRouting } from '../api/client';
import type { AuditEntry, Me } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  actionLabel,
  actorKindLabel,
  actorName,
  auditChangeLines,
  routeModelNames,
  targetLabel,
  taskIndex,
  viaLabel,
} from '../lib/audit';
import { formatAgo, formatDateTime, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('操作记录') }];
}

/** 操作记录不自己轮询。过了 5 分钟没再读，刷新条标「数据已过期」。 */
const AUDIT_STALE_AFTER_MS = 5 * TIME.MIN;

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
      className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-caption font-semibold text-background"
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

function OlderRecordsButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} disabled={pending}>
      {pending ? '正在读更早的…' : '看更早的记录'}
    </Button>
  );
}

/** 展开后先看人话差异；原始 JSON 收在里面那层，默认合上。路由编号换成模型名，对不上的留编号。 */
function ChangeDetails({
  before,
  after,
  routeNames,
}: {
  before: unknown;
  after: unknown;
  routeNames: ReadonlyMap<string, string>;
}) {
  const lines = auditChangeLines(before, after, routeNames);
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">看改了什么</summary>
      {lines.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-sub">
          {lines.map((line) => (
            <li key={line.key === '' ? 'value' : line.key} className="break-words">
              {`${line.label}：${line.before} → ${line.after}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-sub">这些字段都没变</p>
      )}
      <details className="mt-1.5">
        <summary className="cursor-pointer select-none hover:text-foreground">看原始数据</summary>
        <div className="mt-1.5 grid gap-2 md:grid-cols-2">
          {before !== undefined ? (
            <div>
              <div className="mb-1">之前</div>
              <pre className="num overflow-x-auto rounded-md bg-muted/70 p-2 text-caption scrollbar-thin">
                {json(before)}
              </pre>
            </div>
          ) : null}
          {after !== undefined ? (
            <div>
              <div className="mb-1">之后</div>
              <pre className="num overflow-x-auto rounded-md bg-muted/70 p-2 text-caption scrollbar-thin">
                {json(after)}
              </pre>
            </div>
          ) : null}
        </div>
      </details>
    </details>
  );
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
  const routing = useRouting();
  const routeNames = routeModelNames(routing.data);
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
  const hasOlder = Boolean(audit.hasNextPage);
  const loadOlder = () => void audit.fetchNextPage();
  // 已加载的都被滤掉才提换条件；没有更早的就不写「往前翻」。
  const emptyHint =
    all.length === 0 ? undefined : hasOlder ? '换个过滤条件，或往前翻更早的。' : '换个过滤条件。';

  return (
    <Page
      title="操作记录"
      description={`谁在什么时候做了什么：人的操作、${brand.terms.marshal}的调整、引擎的动作，只追加、不改、不删。先记后做，没做成的另记一条。`}
      actions={
        <RefreshBar
          onRefresh={() => void audit.refetch()}
          isFetching={audit.isFetching}
          dataUpdatedAt={audit.dataUpdatedAt}
          staleAfterMs={AUDIT_STALE_AFTER_MS}
        />
      }
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
                'h-7 shrink-0 rounded-md px-3 text-sub text-muted-foreground transition-colors',
                filter === f.id ? 'bg-card font-medium text-foreground shadow-sm' : 'hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {target ? (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-card pr-1 pl-3 text-sub">
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
            hint={
              emptyHint || hasOlder ? (
                <>
                  {emptyHint ? <p>{emptyHint}</p> : null}
                  {hasOlder ? (
                    <div className="mt-2 text-foreground">
                      <OlderRecordsButton pending={audit.isFetchingNextPage} onClick={loadOlder} />
                    </div>
                  ) : null}
                </>
              ) : undefined
            }
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
                      <Badge variant="outline" className="h-5 border-st-fail/50 text-caption text-ink-fail">
                        没做成
                      </Badge>
                    ) : null}
                  </div>
                  {a.reason ? (
                    <p className="mt-0.5 text-sub text-muted-foreground">理由：{a.reason}</p>
                  ) : null}
                  {a.error ? <p className="mt-0.5 text-sub text-ink-fail">{a.error}</p> : null}
                  {a.before !== undefined || a.after !== undefined ? (
                    <ChangeDetails before={a.before} after={a.after} routeNames={routeNames} />
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="num text-xs text-muted-foreground" title={formatDateTime(a.at)}>
                    {formatAgo(a.at, now)}
                  </span>
                  <span className="rounded bg-muted px-1.5 text-caption leading-4 text-muted-foreground">
                    经{viaLabel[a.via]}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
        {list.length > 0 && hasOlder ? (
          <div className="border-t p-2 text-center">
            <OlderRecordsButton pending={audit.isFetchingNextPage} onClick={loadOlder} />
          </div>
        ) : null}
      </Panel>
    </Page>
  );
}
