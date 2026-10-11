import { ArrowUpRight, Bell, Check, ChevronDown, ExternalLink, Send, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  errorText,
  NOTIFICATIONS_PAGE,
  useMe,
  useNotifications,
  useResolveNotification,
} from '../api/client';
import type { Me, Notification, NotificationLevel } from '../api/types';
import { FilterTrack, filterTabClass } from '../components/filter-tabs';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { RepoLink } from '../components/repo-link';
import { StatusChip, StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { formatAgo, formatClock, formatDateTime, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { pendingCount } from '../lib/notice-count';
import { isMine, noticeLevelMeta, type Tone } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('通知中心') }];
}

const LEVELS: { id: 'all' | NotificationLevel; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'decision', label: '要你拍' },
  { id: 'alert', label: '卡住报警' },
  { id: 'daily', label: '日报' },
];

function dayOf(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t = d.getTime();
  if (t >= today.getTime()) return '今天';
  if (t >= today.getTime() - TIME.DAY) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const DELIVERY_NAME: Record<string, string> = { feishu: '飞书' };

/** 处理状态和级别共用 components/filter-tabs 这一套：灰底轨道，选中是白底卡片，手机上每个标签至少 40 高。 */
const segmentClass = filterTabClass;

/** 飞书等渠道送没送到：没拿到消息编号就算没送到。 */
function Deliveries({ n }: { n: Notification }) {
  if (!n.deliveries.length) return <span className="text-caption text-faint">只在{brand.product}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {n.deliveries.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同一渠道可以发给好几个对象，契约里没有对象编号。
        <Tooltip key={`${d.channel}-${i}`}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 text-caption leading-4',
                d.delivered ? 'bg-muted text-muted-foreground' : 'bg-st-fail/10 text-ink-fail',
              )}
            >
              {d.delivered ? (
                <Send className="size-2.5" aria-hidden />
              ) : (
                <TriangleAlert className="size-2.5" aria-hidden />
              )}
              {DELIVERY_NAME[d.channel] ?? d.channel}
              {d.delivered ? '已送到' : '没送到'}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            试了 {d.attempts} 次{d.lastAttemptAt ? ` · 最后一次 ${formatDateTime(d.lastAttemptAt)}` : ''}
            {d.error ? ` · ${d.error}` : ''}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

type Handling = NonNullable<Notification['handling']>;

/** 处理到哪一步的颜色：没人管的偏红，有人在修的在跑，合了发布了的偏绿，静默的灰。 */
const STAGE_TONE: Record<Handling['stage'], Tone> = {
  resolved: 'done',
  silenced: 'stop',
  waiting_founder: 'human',
  unclaimed: 'fail',
  pr_open: 'run',
  merged: 'wait',
  deployed: 'done',
};

/** 跟进单、PR：外链（RepoLink 按品牌拼）。 */
function WorkLink({
  repo,
  kind,
  n,
  label,
}: {
  repo: { owner: string; name: string };
  kind: 'issues' | 'pull';
  n: number;
  label: string;
}) {
  return (
    <RepoLink
      repo={repo}
      kind={kind}
      n={n}
      className="inline-flex items-center gap-0.5 text-caption text-muted-foreground underline-offset-2 max-md:min-h-10 [&[href]]:hover:text-foreground [&[href]]:hover:underline"
      icon={<ExternalLink className="size-2.5" aria-hidden />}
    >
      {label}
    </RepoLink>
  );
}

/**
 * 谁在处理 · 链接 · 多久了（design 15.3「谁在处理」）：后端从认领、PR、发布记录现算的，这里只照着显示；
 * 没查成的（发布判不了之类）照实列出来。
 */
function HandlingRow({ h, now }: { h: Handling; now: number }) {
  const since = formatDuration(now - Date.parse(h.since));
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="alert-handling">
      <StatusChip tone={STAGE_TONE[h.stage]} label={h.stageText} />
      {h.who ? <span className="text-xs text-foreground">{h.who}</span> : null}
      {h.work ? (
        <WorkLink
          repo={h.work.repo}
          kind="issues"
          n={h.work.issueNumber}
          label={`${h.work.repo.owner}/${h.work.repo.name}#${h.work.issueNumber}`}
        />
      ) : null}
      {h.pr ? <WorkLink repo={h.pr.repo} kind="pull" n={h.pr.number} label={`PR #${h.pr.number}`} /> : null}
      {h.silence ? (
        <span className="text-caption text-muted-foreground">
          {h.silence.comment} · 到 {formatDateTime(h.silence.endsAt)}
        </span>
      ) : null}
      <span className="num text-caption text-faint" title={formatDateTime(h.since)}>
        {since}
      </span>
      {h.problems.map((p) => (
        <span key={p} className="text-caption text-ink-fail">
          {p}
        </span>
      ))}
    </div>
  );
}

function groupByDay(items: Notification[], now: number): Map<string, Notification[]> {
  const groups = new Map<string, Notification[]>();
  for (const n of items) {
    const k = dayOf(n.createdAt, now);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return groups;
}

function NotificationRow({
  n,
  now,
  me,
  resolvePending,
  resolveId,
  onOpen,
  onDone,
}: {
  n: Notification;
  now: number;
  me: Me | undefined;
  resolvePending: boolean;
  resolveId: string | undefined;
  onOpen: (link: string) => void;
  onDone: (n: Notification) => void;
}) {
  const resolved = Boolean(n.resolvedAt);
  return (
    <li
      className={cn(
        // 手机上「打开 / 处理了」是右侧的图标按钮，和标题同一行（#1820）；md 起是文字按钮、垂直居中
        'flex items-start gap-3 border-b px-4 py-3 last:border-b-0 md:items-center',
        !resolved && n.level !== 'daily' && 'bg-accent/40',
      )}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <StatusDot tone={noticeLevelMeta[n.level].tone} className={cn('mt-1.5', resolved && 'opacity-40')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-sm', !resolved && 'font-semibold')}>{n.title}</span>
            <span className="rounded bg-muted px-1.5 text-caption text-muted-foreground">
              {noticeLevelMeta[n.level].label}
            </span>
          </div>
          <p className="mt-0.5 text-sub whitespace-pre-wrap text-muted-foreground">{n.body}</p>
          {!resolved && n.handling ? <HandlingRow h={n.handling} now={now} /> : null}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="num text-caption text-faint" title={formatClock(n.createdAt)}>
              {formatAgo(n.createdAt, now)}
            </span>
            <Deliveries n={n} />
            {resolved && n.resolvedAt ? (
              <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
                <Check className="size-3" aria-hidden />
                {n.resolvedBy ? (isMine(n.resolvedBy, me) ? '我' : n.resolvedBy) : ''}处理于{' '}
                <span className="num">{formatAgo(n.resolvedAt, now)}</span>
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 max-md:-mt-2" data-notice-actions>
        {n.link ? (
          <Button
            size="sm"
            variant="ghost"
            className="max-md:w-10 max-md:px-0"
            onClick={() => onOpen(n.link ?? '/')}
          >
            <ArrowUpRight className="md:hidden" aria-hidden />
            <span className="max-md:sr-only">打开</span>
          </Button>
        ) : null}
        {!resolved ? (
          <Button
            size="sm"
            variant="outline"
            className="max-md:w-10 max-md:px-0"
            disabled={resolvePending && resolveId === n.id}
            onClick={() => onDone(n)}
          >
            <Check />
            <span className="max-md:sr-only">处理了</span>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** 按天分组的通知列表。 */
function DayGroups({
  items,
  now,
  me,
  resolvePending,
  resolveId,
  onOpen,
  onDone,
}: {
  items: Notification[];
  now: number;
  me: Me | undefined;
  resolvePending: boolean;
  resolveId: string | undefined;
  onOpen: (link: string) => void;
  onDone: (n: Notification) => void;
}) {
  const groups = groupByDay(items, now);
  return (
    <>
      {[...groups.entries()].map(([day, dayItems]) => (
        <section key={day}>
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">{day}</h2>
          <ul className="overflow-hidden rounded-xl border bg-card">
            {dayItems.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                now={now}
                me={me}
                resolvePending={resolvePending}
                resolveId={resolveId}
                onOpen={onOpen}
                onDone={onDone}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** 通知靠推送更新，没有定时重拉。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const NOTIFICATIONS_STALE_AFTER_MS = 5 * TIME.MIN;

export default function Notifications() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : 'open';
  const level = (LEVELS.find((l) => l.id === params.get('level'))?.id ?? 'all') as 'all' | NotificationLevel;
  const [limit, setLimit] = useState(NOTIFICATIONS_PAGE);
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useNotifications(status, limit);
  const { data: me } = useMe();
  const resolve = useResolveNotification();
  const navigate = useNavigate();
  const now = useNow();
  // 「全部」视图里日报默认收成一行；切回「全部」时重新折叠，避免上次展开还挂着。
  const [dailyOpen, setDailyOpen] = useState(false);
  useEffect(() => {
    if (level === 'all') setDailyOpen(false);
  }, [level]);

  const all = data?.items ?? [];
  const totalCount = data ? data.counts.decision + data.counts.alert + data.counts.daily : 0;
  const shownTotal = level === 'all' ? totalCount : (data?.counts[level] ?? 0);
  const list = all.filter((n) => level === 'all' || n.level === level);
  // 只在「全部」级别视图折叠日报；「日报」标签页直接铺开。待处理/连已处理只影响接口过滤，不改折叠。
  const foldDaily = level === 'all';
  const actionItems = foldDaily ? list.filter((n) => n.level !== 'daily') : list;
  const dailyItems = foldDaily ? list.filter((n) => n.level === 'daily') : [];

  const set = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null) p.delete(key);
    else p.set(key, value);
    setParams(p, { replace: true });
  };

  const done = (n: Notification) =>
    resolve.mutate(n.id, {
      onSuccess: () => toast.success('处理了', { description: n.title }),
      onError: (e) => toast.error('没处理成', { description: errorText(e) }),
    });

  const open = (link: string) => navigate(link);
  const listEmpty = foldDaily ? actionItems.length === 0 && dailyItems.length === 0 : list.length === 0;

  return (
    <Page
      title="通知中心"
      description="只有三类：要你拍的、卡住的、日报。飞书上推同样的三类，进度不主动推。"
      actions={
        <RefreshBar
          onRefresh={() => void refetch()}
          isFetching={isFetching}
          dataUpdatedAt={dataUpdatedAt}
          staleAfterMs={NOTIFICATIONS_STALE_AFTER_MS}
        />
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterTrack role="tablist" aria-label="处理状态">
          {(['open', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              onClick={() => set('status', s === 'open' ? null : 'all')}
              className={segmentClass(status === s)}
            >
              {s === 'open' ? '待处理' : '连已处理的一起看'}
            </button>
          ))}
        </FilterTrack>
        <FilterTrack>
          {LEVELS.map((l) => {
            // 数字是接口给的真实总数，不是这一页取回的条数（只取了前 N 条时也不会封顶）。
            // 没读到就写「—」，不拿 0 冒充「没有提醒」。真的没有（读成功且总数 0）才写 0。
            const n = data ? (l.id === 'all' ? totalCount : data.counts[l.id]) : null;
            const shown = n ?? '—';
            return (
              <button
                key={l.id}
                type="button"
                aria-pressed={level === l.id}
                onClick={() => set('level', l.id === 'all' ? null : l.id)}
                className={segmentClass(level === l.id)}
              >
                {l.id !== 'all' ? <StatusDot tone={noticeLevelMeta[l.id].tone} className="size-1.5" /> : null}
                {l.label}
                <span className="num text-caption opacity-70">{shown}</span>
              </button>
            );
          })}
        </FilterTrack>
      </div>
      {data && status === 'open' ? (
        <p className="mb-3 text-xs text-muted-foreground" data-testid="pending-rule">
          待处理 <span className="num">{pendingCount(data.counts)}</span> 条。
          要你拍的和卡住的，处理了就从这里消失。
          {data.counts.daily > 0 ? (
            <>
              {' '}
              日报 <span className="num">{data.counts.daily}</span> 条看一眼就行。
            </>
          ) : null}
        </p>
      ) : null}
      {error ? <LoadError what="提醒" error={error} /> : null}
      {data?.handlingProblem ? (
        <p className="mb-3 text-xs text-ink-fail" role="status">
          {data.handlingProblem}（提醒照常列出，只是看不出谁在处理）
        </p>
      ) : null}
      {isLoading ? (
        <LoadingRows rows={5} />
      ) : !data ? null : listEmpty ? (
        <Panel>
          <Empty
            icon={Bell}
            title={status === 'open' ? '没有待处理的提醒' : '这里没有提醒'}
            hint="要你拍板或有东西卡住时，这里和飞书会同时提醒。"
          />
        </Panel>
      ) : (
        <div className="space-y-5">
          <DayGroups
            items={actionItems}
            now={now}
            me={me}
            resolvePending={resolve.isPending}
            resolveId={resolve.variables}
            onOpen={open}
            onDone={done}
          />
          {foldDaily && dailyItems.length > 0 ? (
            <section>
              <button
                type="button"
                data-testid="daily-fold"
                aria-expanded={dailyOpen}
                onClick={() => setDailyOpen((v) => !v)}
                className="mb-2 flex w-full items-center gap-1.5 rounded-lg border bg-card px-4 py-3 text-left text-sm text-foreground hover:bg-accent/40"
              >
                <ChevronDown
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform',
                    dailyOpen && 'rotate-180',
                  )}
                  aria-hidden
                />
                <StatusDot tone={noticeLevelMeta.daily.tone} className="size-1.5" />
                <span>
                  日报 <span className="num">{dailyItems.length}</span> 条
                </span>
              </button>
              {dailyOpen ? (
                <DayGroups
                  items={dailyItems}
                  now={now}
                  me={me}
                  resolvePending={resolve.isPending}
                  resolveId={resolve.variables}
                  onOpen={open}
                  onDone={done}
                />
              ) : null}
            </section>
          ) : null}
          {data?.nextCursor ? (
            <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
              <p>
                只取回了最近 <span className="num">{all.length}</span> 条，共{' '}
                <span className="num">{totalCount}</span> 条
                {level === 'all' ? '' : `（${LEVELS.find((l) => l.id === level)?.label}共 ${shownTotal} 条）`}
                。
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={isFetching}
                onClick={() => setLimit((v) => v + NOTIFICATIONS_PAGE)}
              >
                再多看 {NOTIFICATIONS_PAGE} 条
              </Button>
            </div>
          ) : null}
          <p className="text-center text-xs text-muted-foreground">
            飞书的免打扰时段在{' '}
            <Link to="/settings#notify" className="underline underline-offset-2">
              设置
            </Link>{' '}
            里改。
          </p>
        </div>
      )}
    </Page>
  );
}
