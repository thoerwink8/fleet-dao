import { Bell, Check, ExternalLink, Send, TriangleAlert } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import { errorText, useMe, useNotifications, useResolveNotification } from '../api/client';
import type { Notification, NotificationLevel } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RepoLink } from '../components/repo-link';
import { StatusChip, StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { formatAgo, formatClock, formatDateTime, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
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
                'inline-flex items-center gap-1 rounded px-1.5 text-micro leading-4',
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

/** 跟进单、PR：正式驾驶舱是外链，演示版只是文字（RepoLink 按品牌定）。 */
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
      className="inline-flex items-center gap-0.5 text-caption text-muted-foreground underline-offset-2 [&[href]]:hover:text-foreground [&[href]]:hover:underline"
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

export default function Notifications() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : 'open';
  const level = (LEVELS.find((l) => l.id === params.get('level'))?.id ?? 'all') as 'all' | NotificationLevel;
  const { data, error, isLoading } = useNotifications(status);
  const { data: me } = useMe();
  const resolve = useResolveNotification();
  const navigate = useNavigate();
  const now = useNow();

  const all = data?.items ?? [];
  const list = all.filter((n) => level === 'all' || n.level === level);

  const set = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null) p.delete(key);
    else p.set(key, value);
    setParams(p, { replace: true });
  };

  const groups = new Map<string, Notification[]>();
  for (const n of list) {
    const k = dayOf(n.createdAt, now);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }

  const done = (n: Notification) =>
    resolve.mutate(n.id, {
      onSuccess: () => toast.success('处理了', { description: n.title }),
      onError: (e) => toast.error('没处理成', { description: errorText(e) }),
    });

  return (
    <Page
      title="通知中心"
      description="只有三类：要你拍的、卡住报警、日报。飞书上也推同样的三类；进度不主动推。"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-muted p-1" role="tablist" aria-label="处理状态">
          {(['open', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              onClick={() => set('status', s === 'open' ? null : 'all')}
              className={cn(
                'h-7 rounded-md px-3 text-sub text-muted-foreground transition-colors',
                status === s ? 'bg-card font-medium text-foreground shadow-sm' : 'hover:text-foreground',
              )}
            >
              {s === 'open' ? '待处理' : '全部（含已处理）'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {LEVELS.map((l) => {
            const n = all.filter((x) => l.id === 'all' || x.level === l.id).length;
            return (
              <button
                key={l.id}
                type="button"
                aria-pressed={level === l.id}
                onClick={() => set('level', l.id === 'all' ? null : l.id)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sub transition-colors',
                  level === l.id
                    ? 'border-foreground bg-foreground text-background'
                    : 'bg-card text-muted-foreground',
                )}
              >
                {l.id !== 'all' ? <StatusDot tone={noticeLevelMeta[l.id].tone} className="size-1.5" /> : null}
                {l.label}
                <span className="num text-caption opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      {error ? <LoadError what="提醒" error={error} /> : null}
      {data?.handlingProblem ? (
        <p className="mb-3 text-xs text-ink-fail" role="status">
          {data.handlingProblem}（提醒照常列出，只是看不出谁在处理）
        </p>
      ) : null}
      {isLoading ? (
        <LoadingRows rows={5} />
      ) : !data ? null : list.length === 0 ? (
        <Panel>
          <Empty
            icon={Bell}
            title={status === 'open' ? '没有待处理的提醒' : '这里没有提醒'}
            hint="要你拍板或有东西卡住时，这里和飞书会同时提醒。"
          />
        </Panel>
      ) : (
        <div className="space-y-5">
          {[...groups.entries()].map(([day, items]) => (
            <section key={day}>
              <h2 className="mb-2 text-xs font-medium text-muted-foreground">{day}</h2>
              <ul className="overflow-hidden rounded-xl border bg-card">
                {items.map((n) => {
                  const resolved = Boolean(n.resolvedAt);
                  return (
                    <li
                      key={n.id}
                      className={cn(
                        'flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 md:flex-row md:items-center',
                        !resolved && n.level !== 'daily' && 'bg-accent/40',
                      )}
                    >
                      <div className="flex min-w-0 flex-1 gap-3">
                        <StatusDot
                          tone={noticeLevelMeta[n.level].tone}
                          className={cn('mt-1.5', resolved && 'opacity-40')}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('text-sm', !resolved && 'font-semibold')}>{n.title}</span>
                            <span className="rounded bg-muted px-1.5 text-micro text-muted-foreground">
                              {noticeLevelMeta[n.level].label}
                            </span>
                          </div>
                          <p className="mt-0.5 text-sub whitespace-pre-wrap text-muted-foreground">
                            {n.body}
                          </p>
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
                      <div className="flex shrink-0 flex-wrap gap-1.5 pl-5 md:pl-0">
                        {n.link ? (
                          <Button size="sm" variant="ghost" onClick={() => navigate(n.link ?? '/')}>
                            打开
                          </Button>
                        ) : null}
                        {!resolved ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={resolve.isPending && resolve.variables === n.id}
                            onClick={() => done(n)}
                          >
                            <Check />
                            处理了
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {data?.nextCursor ? (
            <p className="text-center text-xs text-muted-foreground">只显示最近 {all.length} 条。</p>
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
