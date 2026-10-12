import { ArrowUpRight, Bot, ChevronRight, Cog, Filter, ScrollText, Terminal, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { AUDIT_PAGE_SIZE, useAllBoards, useAudit, useMe, useNotifications, useRouting } from '../api/client';
import type { AuditEntry, Me } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { List, RowDetail, RowFrame } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { NativeSelect } from '../components/layout/native-select';
import { Page } from '../components/layout/page';
import { RowMenu, RowMenuItem } from '../components/layout/row-menu';
import { SearchInput } from '../components/layout/search-input';
import { Section } from '../components/layout/section';
import { StatusBadge } from '../components/layout/status-badge';
import { Toolbar } from '../components/layout/toolbar';
import { Button } from '../components/ui/button';
import {
  actionLabel,
  actorKindLabel,
  actorName,
  auditChangeLines,
  notificationIndex,
  routeModelNames,
  targetLabel,
  taskHintsFromAudit,
  taskIndex,
  viaLabel,
} from '../lib/audit';
import { describeAction, targetHref } from '../lib/audit-actions';
import { formatAgo, formatDateTime, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('操作记录') }];
}

// 操作记录靠推送重拉，没有自己的轮询。安静超过 5 分钟还没再读成，才标「数据已过期」。
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
      className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-meta font-semibold text-background"
      title={actorKindLabel[actor.kind]}
    >
      {actorName(actor, me).slice(0, 1)}
    </span>
  );
}

/** 事件名：有中文对照显示成一句话（悬停看原名）；没有就显示默认译名「其他操作」，原键放在后面做等宽次要灰小字。动作比人名、对象重一档。 */
function ActionText({ action, ok, className }: { action: string; ok: boolean; className?: string }) {
  const { text, translated } = describeAction(action);
  return (
    <span className={cn('font-medium', !ok && 'text-ink-fail', className)} title={action}>
      {text}
      {translated ? null : (
        <span className="ml-1.5 font-mono text-meta font-normal text-muted-foreground">{action}</span>
      )}
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
      {pending ? '正在读更早的…' : `再看 ${AUDIT_PAGE_SIZE} 条`}
    </Button>
  );
}

/**
 * 行下面展开的明细（#1940：从行里的「看改了什么」折叠挪到行下面的 RowDetail，和名字对齐）：
 * 先写全出错原因和理由（行里小字放不下会截断，手机上没有悬停，这里看全文）；有改动再看人话差异，
 * 原始 JSON 收在里面那层，默认合上。路由编号换成模型名，对不上的留编号。
 */
function RecordDetails({
  id,
  a,
  routeNames,
}: {
  id: string;
  a: AuditEntry;
  routeNames: ReadonlyMap<string, string>;
}) {
  const { before, after } = a;
  const hasChange = before !== undefined || after !== undefined;
  const lines = hasChange ? auditChangeLines(before, after, routeNames) : [];
  return (
    <RowDetail id={id} data-audit-detail className="space-y-1.5 pb-3 text-meta text-muted-foreground">
      {a.error ? <p className="text-body break-words text-ink-fail">{a.error}</p> : null}
      {a.reason ? <p className="text-body break-words">理由：{a.reason}</p> : null}
      {!hasChange ? null : lines.length > 0 ? (
        <ul className="space-y-0.5 text-body text-foreground">
          {lines.map((line) => (
            <li key={line.key === '' ? 'value' : line.key} className="break-words">
              {`${line.label}：${line.before} → ${line.after}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body">这些字段都没变</p>
      )}
      {hasChange ? (
        <details>
          <summary className="cursor-pointer select-none hover:text-foreground max-md:flex max-md:min-h-10 max-md:items-center">
            看原始数据
          </summary>
          <div className="mt-1.5 grid gap-2 md:grid-cols-2">
            {before !== undefined ? (
              <div>
                <div className="mb-1">之前</div>
                <pre className="num overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-meta scrollbar-thin">
                  {json(before)}
                </pre>
              </div>
            ) : null}
            {after !== undefined ? (
              <div>
                <div className="mb-1">之后</div>
                <pre className="num overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-meta scrollbar-thin">
                  {json(after)}
                </pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </RowDetail>
  );
}

/**
 * 一条记录（#1940，照路由页样板）：行首执行者图标；第一行「谁 + 做了什么」加一个状态（只有没做成才有）；
 * 第二行灰字写对象、出错原因、理由，一行不折、整句在悬停里；行尾时间（悬停：具体时间 · 经哪里）、
 * 有改动的展开箭头、常驻淡色「⋯」（只看这个对象、打开对应页面）。展开的改动在行下面，和名字对齐。
 */
function AuditRow({
  a,
  me,
  now,
  target,
  routeNames,
  onTarget,
}: {
  a: AuditEntry;
  me: Me | undefined;
  now: number;
  /** 对象显示名（单号、提醒标题、路由名……）。 */
  target: string;
  routeNames: ReadonlyMap<string, string>;
  onTarget: (target: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const hasChange = a.before !== undefined || a.after !== undefined;
  // 有改动，或有出错、理由（小字行里会被截断）就能展开
  const hasDetail = hasChange || Boolean(a.error) || Boolean(a.reason);
  const detailLabel = hasChange ? '看改了什么' : '看全文';
  const href = describeAction(a.action).translated ? targetHref(a.target) : null;
  const who = actorName(a.actor, me);
  const metaFull = [target, a.error, a.reason ? `理由：${a.reason}` : null].filter(Boolean).join(' · ');
  return (
    <li data-audit-row className="group/row relative">
      {a.ok ? null : (
        <span aria-hidden data-row-rail className="absolute inset-y-0 left-0 w-rail bg-st-fail" />
      )}
      <RowFrame tall>
        <span className="flex w-9 shrink-0 items-center">
          <ActorIcon actor={a.actor} me={me} />
        </span>
        <span className="min-w-0 flex-1">
          <span data-row-name-line className="flex min-w-0 items-center gap-2 text-body whitespace-nowrap">
            {/* 人名短（我、老周、AI 调度员），不让位；动作放不下截断，原名在悬停里 */}
            <span data-audit-who className="shrink-0" title={a.actor.id}>
              {who}
            </span>
            <ActionText action={a.action} ok={a.ok} className="min-w-0 truncate" />
            {!a.ok ? (
              <StatusBadge tone="fail" variant="outline" icon={false} label="没做成" className="shrink-0" />
            ) : null}
          </span>
          <span
            data-row-meta
            title={metaFull}
            className="flex min-w-0 items-center gap-1.5 overflow-hidden text-meta whitespace-nowrap text-muted-foreground"
          >
            {/* 手机上时间不另占一列（会把名字挤成两三个字），写在小字行开头 */}
            <span className="num shrink-0 md:hidden" title={`${formatDateTime(a.at)} · 经${viaLabel[a.via]}`}>
              {formatAgo(a.at, now)} ·
            </span>
            {/* 对象、出错、理由连成一句从左往右截断（各自截断会每段只剩两个字）；全文在展开里 */}
            <span className="min-w-0 truncate">
              <span data-audit-what>{target}</span>
              {a.error ? (
                <span className="text-ink-fail">
                  {' · '}
                  <span>{a.error}</span>
                </span>
              ) : null}
              {a.reason ? (
                <>
                  {' · '}
                  <span>理由：{a.reason}</span>
                </>
              ) : null}
            </span>
          </span>
        </span>
        <span
          className="num shrink-0 text-meta whitespace-nowrap text-muted-foreground max-md:hidden"
          title={`${formatDateTime(a.at)} · 经${viaLabel[a.via]}`}
        >
          {formatAgo(a.at, now)}
        </span>
        <span className="flex shrink-0 items-center">
          {hasDetail ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-expanded={open}
              aria-controls={detailId}
              aria-label={detailLabel}
              title={open ? '收起' : detailLabel}
              onClick={() => setOpen((v) => !v)}
              className="text-muted-foreground"
            >
              <ChevronRight
                className={cn('transition-transform duration-200', open && 'rotate-90')}
                aria-hidden
              />
            </Button>
          ) : (
            // 没有改动的行留同样宽的空，时间一列对齐
            <span aria-hidden className="size-8 max-md:size-10" />
          )}
          <RowMenu
            label={`更多操作：${who} ${describeAction(a.action).text}`}
            title="只看这个对象、打开对应页面"
          >
            <RowMenuItem onSelect={() => onTarget(a.target)} title="只看这个对象的记录">
              <Filter aria-hidden />
              只看这个对象的记录
            </RowMenuItem>
            {href ? (
              <RowMenuItem asChild>
                <Link to={href}>
                  <ArrowUpRight aria-hidden />
                  打开
                </Link>
              </RowMenuItem>
            ) : null}
          </RowMenu>
        </span>
      </RowFrame>
      {hasDetail && open ? <RecordDetails id={detailId} a={a} routeNames={routeNames} /> : null}
    </li>
  );
}

export default function Audit() {
  const [params, setParams] = useSearchParams();
  const target = params.get('target') ?? undefined;
  const audit = useAudit(target);
  const { boards } = useAllBoards();
  const { data: me } = useMe();
  const notices = useNotifications('all');
  const now = useNow();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  // 「经哪里」：每行不再重复标「经引擎」，要看某条渠道进来的记录在这里筛（悬停时间能看到每行的来路）。
  const [via, setVia] = useState<'all' | AuditEntry['via']>('all');
  const [q, setQ] = useState('');
  const routing = useRouting();
  const routeNames = routeModelNames(routing.data);
  const all = audit.data?.pages.flatMap((p) => p.items) ?? [];
  // 看板索引还没到时，先用记录里自带的单号占位；看板到了盖上标题。提醒标题另从通知列表对。
  const tasks = useMemo(() => {
    const merged = taskHintsFromAudit(all);
    for (const [id, ref] of taskIndex(boards.flatMap((b) => b.tasks))) merged.set(id, ref);
    return merged;
  }, [all, boards]);
  const notifications = useMemo(() => notificationIndex(notices.data?.items ?? []), [notices.data?.items]);
  const query = q.trim();
  const list = all
    .filter((a) => filter === 'all' || a.actor.kind === filter)
    .filter((a) => via === 'all' || a.via === via)
    .filter(
      (a) =>
        !query ||
        `${actorName(a.actor, me)} ${actorName(a.actor)} ${actionLabel(a.action)} ${a.action} ${targetLabel(a.target, tasks, notifications)} ${a.reason ?? ''} ${a.error ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );

  const setTarget = (t: string | null) => {
    const p = new URLSearchParams(params);
    if (t) p.set('target', t);
    else p.delete('target');
    setParams(p, { replace: true });
  };
  const hasOlder = Boolean(audit.hasNextPage);
  const loadOlder = () => void audit.fetchNextPage();
  const searching = query.length > 0;
  // 搜索无结果且还有更早的：说清只搜了已加载的，点了继续往前翻。过滤空了才提换条件。
  const emptyHint =
    all.length === 0
      ? undefined
      : searching
        ? undefined
        : hasOlder
          ? '换个过滤条件，或往前翻更早的。'
          : '换个过滤条件。';

  return (
    <Page
      title="操作记录"
      description={`谁在什么时候做了什么：人、${brand.terms.marshal}、引擎的动作都记在这里，只追加、不改。`}
      // 刷新走页头的固定槽位（#1940）。共用秒表一拍最多慢 1 秒：刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
      refresh={{
        onRefresh: () => void audit.refetch(),
        isFetching: audit.isFetching,
        dataUpdatedAt: audit.dataUpdatedAt > now ? now : audit.dataUpdatedAt,
        staleAfterMs: AUDIT_STALE_AFTER_MS,
      }}
    >
      <Toolbar
        start={
          <>
            <FilterTabs aria-label="按谁做的" items={FILTERS} value={filter} onChange={setFilter} />
            {target ? (
              // 只看某个对象：一个描边按钮写着对象名，点一下取消（不再手写全圆胶囊，#1940）
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setTarget(null)}
                aria-label="不再只看这个对象"
                title="不再只看这个对象"
                data-audit-target
                className="max-w-full min-w-0"
              >
                <span className="min-w-0 truncate">只看 {targetLabel(target, tasks, notifications)}</span>
                <X aria-hidden />
              </Button>
            ) : null}
          </>
        }
        end={
          <>
            <NativeSelect
              aria-label="按来路筛选"
              value={via}
              onChange={(e) => setVia(e.target.value as typeof via)}
            >
              <option value="all">全部来路</option>
              {(Object.keys(viaLabel) as AuditEntry['via'][]).map((v) => (
                <option key={v} value={v}>
                  经{viaLabel[v]}
                </option>
              ))}
            </NativeSelect>
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="搜人、动作、对象、理由"
              aria-label="搜索操作记录"
              // 手机上和来路下拉同一行：下拉按字宽，搜索框吃满剩下的（改前两个各占一整行）
              className="min-w-0 flex-1 md:w-64 md:flex-none"
            />
          </>
        }
      />
      {audit.error ? (
        <div className="mb-3">
          <LoadError what="操作记录" error={audit.error} />
        </div>
      ) : null}
      <Section flush>
        {audit.isLoading ? (
          <div className="p-4">
            <LoadingRows rows={6} />
          </div>
        ) : !audit.data ? (
          <p className="px-4 py-10 text-center text-body text-ink-fail">
            没读到操作记录，这里空着不代表没人操作过
          </p>
        ) : list.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="没有符合条件的记录"
            hint={
              searching && hasOlder ? (
                <button
                  type="button"
                  onClick={loadOlder}
                  disabled={audit.isFetchingNextPage}
                  className="text-foreground underline-offset-2 hover:underline disabled:opacity-60"
                >
                  {audit.isFetchingNextPage
                    ? '正在读更早的…'
                    : `只搜了已加载的 ${all.length} 条，点这里再往前翻`}
                </button>
              ) : emptyHint || hasOlder ? (
                <>
                  {emptyHint ? <p>{emptyHint}</p> : null}
                  {hasOlder ? (
                    <div className="mt-2 text-foreground">
                      <OlderRecordsButton pending={audit.isFetchingNextPage} onClick={loadOlder} />
                    </div>
                  ) : null}
                </>
              ) : searching ? (
                <p>换个过滤条件。</p>
              ) : undefined
            }
          />
        ) : (
          <List>
            {list.map((a) => (
              <AuditRow
                key={a.id}
                a={a}
                me={me}
                now={now}
                target={targetLabel(a.target, tasks, notifications)}
                routeNames={routeNames}
                onTarget={setTarget}
              />
            ))}
          </List>
        )}
        {list.length > 0 && hasOlder ? (
          <div className="border-t p-2 text-center">
            <OlderRecordsButton pending={audit.isFetchingNextPage} onClick={loadOlder} />
          </div>
        ) : null}
      </Section>
    </Page>
  );
}
