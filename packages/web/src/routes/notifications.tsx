import { answerResolves, NO_OPTIONS_TEXT } from '@fleet-dao/shared';
import { ArrowUpRight, Bell, Check, ChevronDown, ExternalLink, Send, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  errorText,
  NOTIFICATIONS_PAGE,
  useAnswerNotification,
  useMe,
  useNotifications,
  useResolveNotification,
} from '../api/client';
import type { Me, Notification, NotificationLevel } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { List, ListRow } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { RefreshBar } from '../components/refresh-bar';
import { RepoLink } from '../components/repo-link';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
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

/** 飞书等渠道送没送到：没拿到消息编号就算没送到。 */
function Deliveries({ n }: { n: Notification }) {
  if (!n.deliveries.length)
    return <span className="text-meta text-muted-foreground">只在{brand.product}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {n.deliveries.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同一渠道可以发给好几个对象，契约里没有对象编号。
        <Tooltip key={`${d.channel}-${i}`}>
          <TooltipTrigger asChild>
            <Tag tone={d.delivered ? 'neutral' : 'fail'} className="gap-1">
              {d.delivered ? (
                <Send className="size-2.5" aria-hidden />
              ) : (
                <TriangleAlert className="size-2.5" aria-hidden />
              )}
              {DELIVERY_NAME[d.channel] ?? d.channel}
              {d.delivered ? '已送到' : '没送到'}
            </Tag>
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
      className="inline-flex items-center gap-0.5 text-meta text-muted-foreground underline-offset-2 max-md:min-h-10 [&[href]]:hover:text-foreground [&[href]]:hover:underline"
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
      <StatusBadge tone={STAGE_TONE[h.stage]} label={h.stageText} />
      {h.who ? <span className="text-meta text-foreground">{h.who}</span> : null}
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
        <span className="text-meta text-muted-foreground">
          {h.silence.comment} · 到 {formatDateTime(h.silence.endsAt)}
        </span>
      ) : null}
      <span className="num text-meta text-muted-foreground" title={formatDateTime(h.since)}>
        {since}
      </span>
      {h.problems.map((p) => (
        <span key={p} className="text-meta text-ink-fail">
          {p}
        </span>
      ))}
    </div>
  );
}

/** 正文默认只显两行，点一下展开、再点收起（长报警一张卡占满首屏，#1904）。 */
function ClampedBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={open}
      title={open ? '点一下收起' : '点一下看全文'}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        'mt-0.5 w-full text-left text-body whitespace-pre-wrap text-muted-foreground outline-none focus-visible:ring-focus focus-visible:ring-ring',
        !open && 'line-clamp-2',
      )}
    >
      {text}
    </button>
  );
}

/** 回答一条「要你拍」：点一个选项，或自己写一段。 */
export type AnswerInput = { optionId: string } | { text: string };

/**
 * 「要你拍」的选项和自己输入的框（#1915）：一项一行，按钮是选项的字（推荐的那项是主按钮），旁边一句说明、推荐的写理由；
 * 手机上按钮整宽、说明在下面。没有选项的老通知照实写「没有选项，请直接回复」，只给输入框，不退回单纯确认。
 */
function DecisionPicker({
  n,
  pending,
  onAnswer,
}: {
  n: Notification;
  pending: boolean;
  onAnswer: (n: Notification, input: AnswerInput) => void;
}) {
  const [text, setText] = useState('');
  const options = n.options ?? [];
  const trimmed = text.trim();
  return (
    <div className="mt-2 space-y-2" data-testid="decision-picker">
      {options.length > 0 ? (
        <ul className="space-y-3 md:space-y-1.5" aria-label="选一个">
          {options.map((o) => (
            <li key={o.id} className="flex flex-col gap-1 md:flex-row md:items-center md:gap-3">
              <Button
                size="sm"
                variant={o.recommended ? 'brand' : 'outline'}
                disabled={pending}
                onClick={() => onAnswer(n, { optionId: o.id })}
                className="max-md:w-full md:min-w-24"
              >
                {o.label}
              </Button>
              <span className="min-w-0 text-meta text-muted-foreground">
                {o.recommended ? (
                  <Tag tone="brand" className="mr-1.5">
                    推荐
                  </Tag>
                ) : null}
                {o.detail}
                {o.recommended ? `。${o.recommended}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-muted-foreground" data-testid="no-options">
          {NO_OPTIONS_TEXT}
        </p>
      )}
      <form
        className="flex gap-2 max-md:flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onAnswer(n, { text: trimmed });
        }}
      >
        <Input
          aria-label="自己输入"
          placeholder={options.length > 0 ? '都不合适？自己写' : '写你的决定'}
          value={text}
          maxLength={2000}
          disabled={pending}
          onChange={(e) => setText(e.target.value)}
          className="md:max-w-md"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || !trimmed}>
          <Send aria-hidden />
          提交
        </Button>
      </form>
      <p className="text-meta text-muted-foreground" data-testid="custom-effect">
        {answerResolves(options, undefined)
          ? '自己写的：记下交给指挥官，这条转已处理'
          : '自己写的：记下交给指挥官，这条先留着'}
      </p>
    </div>
  );
}

/** 拍过的：选了什么、谁、什么时候。 */
function DecisionAnswerLine({ n, me, now }: { n: Notification; me: Me | undefined; now: number }) {
  const a = n.answer;
  if (!a) return null;
  return (
    <p className="mt-1 text-body text-foreground" data-testid="decision-answer">
      {isMine(a.by, me) ? '我' : a.by}
      {a.optionId === undefined ? '自己写了：' : '选了：'}
      <span className="font-medium">{a.text}</span>
      <span className="num ml-2 text-meta text-muted-foreground" title={formatDateTime(a.at)}>
        {formatAgo(a.at, now)}
      </span>
    </p>
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

interface RowActions {
  resolvePending: boolean;
  resolveId: string | undefined;
  /** 正在回答的那一条（#1915）；没有在答的是 undefined。 */
  answeringId: string | undefined;
  onOpen: (link: string) => void;
  onDone: (n: Notification) => void;
  onAnswer: (n: Notification, input: AnswerInput) => void;
}

function NotificationRow({
  n,
  now,
  me,
  resolvePending,
  resolveId,
  answeringId,
  onOpen,
  onDone,
  onAnswer,
}: { n: Notification; now: number; me: Me | undefined } & RowActions) {
  const resolved = Boolean(n.resolvedAt);
  return (
    <ListRow
      data-notice-row
      data-resolved={resolved || undefined}
      summary={
        <>
          {/* 手机上内容在上、「打开 / 处理了」带字排在下面一行（#1904，原来的无字图标看不出是什么）；md 起操作在右侧、垂直居中 */}
          <div className="flex w-full min-w-0 flex-col gap-2 md:flex-row md:items-center md:gap-3">
            <div className="flex min-w-0 flex-1 gap-3">
              <StatusDot
                tone={noticeLevelMeta[n.level].tone}
                className={cn('mt-1.5', resolved && 'opacity-40')}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('text-body', !resolved && 'font-semibold')}>{n.title}</span>
                  <Tag tone={noticeLevelMeta[n.level].tone}>{noticeLevelMeta[n.level].label}</Tag>
                </div>
                <ClampedBody text={n.body} />
                {!resolved && n.level === 'decision' ? (
                  <DecisionPicker n={n} pending={answeringId === n.id} onAnswer={onAnswer} />
                ) : null}
                <DecisionAnswerLine n={n} me={me} now={now} />
                {!resolved && n.handling ? <HandlingRow h={n.handling} now={now} /> : null}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="num text-meta text-muted-foreground" title={formatClock(n.createdAt)}>
                    {formatAgo(n.createdAt, now)}
                  </span>
                  <Deliveries n={n} />
                  {resolved && n.resolvedAt ? (
                    <span className="inline-flex items-center gap-1 text-meta text-muted-foreground">
                      <Check className="size-3" aria-hidden />
                      {n.resolvedBy ? (isMine(n.resolvedBy, me) ? '我' : n.resolvedBy) : ''}处理于{' '}
                      <span className="num">{formatAgo(n.resolvedAt, now)}</span>
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 max-md:pl-5" data-notice-actions>
              {!resolved ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolvePending && resolveId === n.id}
                  onClick={() => onDone(n)}
                >
                  <Check />
                  处理了
                </Button>
              ) : null}
              {n.link ? (
                <Button size="sm" variant="ghost" onClick={() => onOpen(n.link ?? '/')}>
                  <ArrowUpRight aria-hidden />
                  打开
                </Button>
              ) : null}
            </div>
          </div>
        </>
      }
    />
  );
}

/** 按天分组的通知列表。 */
function DayGroups({
  items,
  now,
  me,
  ...actions
}: { items: Notification[]; now: number; me: Me | undefined } & RowActions) {
  const groups = groupByDay(items, now);
  return (
    <>
      {[...groups.entries()].map(([day, dayItems]) => (
        <section key={day}>
          <h2 className="mb-2 text-meta font-medium text-muted-foreground">{day}</h2>
          <Section flush>
            <List>
              {dayItems.map((n) => (
                <NotificationRow key={n.id} n={n} now={now} me={me} {...actions} />
              ))}
            </List>
          </Section>
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
  const answerMutation = useAnswerNotification();
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

  const answer = (n: Notification, input: AnswerInput) =>
    answerMutation.mutate(
      { id: n.id, body: input },
      {
        onSuccess: (r) => {
          // 答案存下了；交没交给指挥官（进度单 #1055）照实说，没交出去不弹成「都好了」
          if (r.handoff.progress.ok) {
            toast.success(`记下了：${r.answer.text}`, { description: '已交给指挥官（进度单 #1055）' });
          } else {
            toast.warning(`记下了：${r.answer.text}`, {
              description: `没交给指挥官：${r.handoff.progress.why}`,
            });
          }
        },
        onError: (e) => toast.error('没记下', { description: errorText(e) }),
      },
    );

  const open = (link: string) => navigate(link);
  const actions: RowActions = {
    resolvePending: resolve.isPending,
    resolveId: resolve.variables,
    answeringId: answerMutation.isPending ? answerMutation.variables?.id : undefined,
    onOpen: open,
    onDone: done,
    onAnswer: answer,
  };
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
        <FilterTabs
          aria-label="处理状态"
          items={[
            { id: 'open', label: '待处理' },
            { id: 'all', label: '连已处理的一起看' },
          ]}
          value={status}
          onChange={(s) => set('status', s === 'open' ? null : 'all')}
        />
        <FilterTabs
          mode="toggle"
          variant="secondary"
          aria-label="按级别"
          items={LEVELS.map((l) => ({
            id: l.id,
            label: l.label,
            // 数字是接口给的真实总数，不是这一页取回的条数（只取了前 N 条时也不会封顶）。
            // 没读到就写「—」（count 传 null），不拿 0 冒充「没有提醒」。真的没有（读成功且总数 0）才写 0。
            count: data ? (l.id === 'all' ? totalCount : data.counts[l.id]) : null,
            ...(l.id !== 'all' ? { tone: noticeLevelMeta[l.id].tone } : {}),
          }))}
          value={level}
          onChange={(id) => set('level', id === 'all' ? null : id)}
        />
      </div>
      {data && status === 'open' ? (
        <p className="mb-3 text-meta text-muted-foreground" data-testid="pending-rule">
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
        <p className="mb-3 text-meta text-ink-fail" role="status">
          {data.handlingProblem}（提醒照常列出，只是看不出谁在处理）
        </p>
      ) : null}
      {isLoading ? (
        <LoadingRows rows={5} />
      ) : !data ? null : listEmpty ? (
        <Section>
          <EmptyState
            icon={Bell}
            title={status === 'open' ? '没有待处理的提醒' : '这里没有提醒'}
            hint="要你拍板或有东西卡住时，这里和飞书会同时提醒。"
          />
        </Section>
      ) : (
        <div className="space-y-5">
          <DayGroups items={actionItems} now={now} me={me} {...actions} />
          {foldDaily && dailyItems.length > 0 ? (
            <section>
              <Section flush className="mb-2">
                <button
                  type="button"
                  data-testid="daily-fold"
                  aria-expanded={dailyOpen}
                  onClick={() => setDailyOpen((v) => !v)}
                  className="flex min-h-10 w-full items-center gap-1.5 px-4 py-2.5 text-left text-body text-foreground outline-none hover:bg-accent focus-visible:ring-focus focus-visible:ring-ring max-md:min-h-11"
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
              </Section>
              {dailyOpen ? <DayGroups items={dailyItems} now={now} me={me} {...actions} /> : null}
            </section>
          ) : null}
          {data?.nextCursor ? (
            <div className="flex flex-col items-center gap-2 text-meta text-muted-foreground">
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
          <p className="text-center text-meta text-muted-foreground">
            飞书的免打扰时段在{' '}
            <Link
              to="/settings#notify"
              className="underline underline-offset-2 max-md:inline-flex max-md:min-h-10 max-md:min-w-10 max-md:items-center max-md:justify-center"
            >
              设置
            </Link>{' '}
            里改。
          </p>
        </div>
      )}
    </Page>
  );
}
