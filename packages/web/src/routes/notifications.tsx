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
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
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

/**
 * 飞书等渠道送没送到：没拿到消息编号就算没送到。送到了是一截灰字（平常事，不占色块）；
 * 没送到才是红标签。试了几次、最后一次、错误原因都在悬停里（路由页样板 #1914：一行只一个显眼的东西）。
 */
function Deliveries({ n }: { n: Notification }) {
  if (!n.deliveries.length) return <span className="shrink-0">只在{brand.product}</span>;
  return (
    <>
      {n.deliveries.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同一渠道可以发给好几个对象，契约里没有对象编号。
        <Tooltip key={`${d.channel}-${i}`}>
          <TooltipTrigger asChild>
            {d.delivered ? (
              <span data-delivery="ok" className="inline-flex shrink-0 items-center gap-1">
                <Send className="size-3" aria-hidden />
                {DELIVERY_NAME[d.channel] ?? d.channel}已送到
              </span>
            ) : (
              <Tag tone="fail" className="gap-1">
                <TriangleAlert className="size-3" aria-hidden />
                {DELIVERY_NAME[d.channel] ?? d.channel}没送到
              </Tag>
            )}
          </TooltipTrigger>
          <TooltipContent>
            试了 {d.attempts} 次{d.lastAttemptAt ? ` · 最后一次 ${formatDateTime(d.lastAttemptAt)}` : ''}
            {d.error ? ` · ${d.error}` : ''}
          </TooltipContent>
        </Tooltip>
      ))}
    </>
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
      // 一行不折（#1939）：不靠 min-h 撑高这一行，手机上可点范围用伪元素往上下各撑 16（同路由页渠道卡头的链接）
      className="relative inline-flex shrink-0 items-center gap-0.5 underline-offset-2 after:absolute after:inset-x-0 after:-inset-y-4 [&[href]]:hover:text-foreground [&[href]]:hover:underline"
      icon={<ExternalLink className="size-3" aria-hidden />}
    >
      {label}
    </RepoLink>
  );
}

/**
 * 谁在处理 · 链接 · 多久了（design 15.3「谁在处理」）：后端从认领、PR、发布记录现算的，这里只照着显示；
 * 没查成的（发布判不了之类）照实列出来。
 * 一行不折（#1939，路由页样板「行的小字只占一行」）：状态、多久、链接不让位；谁、静默说明、没查成的话放不下就截断，整句（后端给的 line）在悬停里。
 */
function HandlingRow({ h, now }: { h: Handling; now: number }) {
  const since = formatDuration(now - Date.parse(h.since));
  const full = [h.line, ...h.problems].join(' · ');
  return (
    <div
      className="mt-1 flex min-w-0 items-center gap-x-2 overflow-hidden text-meta whitespace-nowrap text-muted-foreground"
      title={full}
      data-testid="alert-handling"
    >
      <StatusBadge tone={STAGE_TONE[h.stage]} label={h.stageText} variant="dot" />
      <span className="num shrink-0" title={formatDateTime(h.since)}>
        {since}
      </span>
      {h.work ? (
        <WorkLink
          repo={h.work.repo}
          kind="issues"
          n={h.work.issueNumber}
          label={`${h.work.repo.owner}/${h.work.repo.name}#${h.work.issueNumber}`}
        />
      ) : null}
      {h.pr ? <WorkLink repo={h.pr.repo} kind="pull" n={h.pr.number} label={`PR #${h.pr.number}`} /> : null}
      {h.who ? (
        <span
          className={cn(
            'min-w-0 truncate text-foreground',
            // 「谁」就是那个 PR（PR #16）时，手机上不再写第二遍，省出位置给链接
            h.pr && h.who === `PR #${h.pr.number}` && 'max-md:hidden',
          )}
        >
          {h.who}
        </span>
      ) : null}
      {h.silence ? (
        <span className="min-w-0 truncate">
          {h.silence.comment} · 到 {formatDateTime(h.silence.endsAt)}
        </span>
      ) : null}
      {h.problems.map((p) => (
        <span key={p} className="min-w-0 truncate text-ink-fail">
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
 * 观感（#1939）：整块左边一道「等人」色细竖线，和正文、谁在处理分开；按钮同宽、说明左对齐成一列；
 * 输入框和「提交」同一行，自己写的去向是框下一行灰字。
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
    <div
      className="mt-3 space-y-3 border-l-2 border-st-human-line pl-3 md:space-y-2 md:pl-4"
      data-testid="decision-picker"
    >
      {options.length > 0 ? (
        <ul className="space-y-3 md:space-y-2" aria-label="选一个">
          {options.map((o) => (
            <li key={o.id} className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
              <Button
                size="sm"
                variant={o.recommended ? 'brand' : 'outline'}
                disabled={pending}
                onClick={() => onAnswer(n, { optionId: o.id })}
                className="max-md:w-full md:min-w-28"
              >
                {o.label}
              </Button>
              <span className="min-w-0 text-meta text-muted-foreground">
                {o.recommended ? (
                  // 推荐的那项按钮已经是实色主按钮：标签用灰底，不再一黑一黑叠在一起（#1939）
                  <Tag className="mr-1.5 align-middle">推荐</Tag>
                ) : null}
                {o.detail}
                {o.recommended ? <span className="text-foreground">。{o.recommended}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-muted-foreground" data-testid="no-options">
          {NO_OPTIONS_TEXT}
        </p>
      )}
      <div>
        <form
          className="flex gap-2 md:max-w-xl"
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
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending || !trimmed}>
            <Send aria-hidden />
            提交
          </Button>
        </form>
        <p className="mt-1.5 text-meta text-muted-foreground" data-testid="custom-effect">
          {answerResolves(options, undefined)
            ? '自己写的：记下交给指挥官，这条转已处理'
            : '自己写的：记下交给指挥官，这条先留着'}
        </p>
      </div>
    </div>
  );
}

/** 拍过的：选了什么、谁、什么时候。一行：对勾、「我选了：发布」、灰字时间（#1939）。 */
function DecisionAnswerLine({ n, me, now }: { n: Notification; me: Me | undefined; now: number }) {
  const a = n.answer;
  if (!a) return null;
  return (
    <p
      className="mt-2 flex min-w-0 items-center gap-1.5 text-body text-foreground"
      data-testid="decision-answer"
      title={`${a.text} · ${formatDateTime(a.at)}`}
    >
      <Check className="size-4 shrink-0 text-ink-done" aria-hidden />
      <span className="min-w-0 truncate">
        {isMine(a.by, me) ? '我' : a.by}
        {a.optionId === undefined ? '自己写了：' : '选了：'}
        <span className="font-medium">{a.text}</span>
      </span>
      <span className="num shrink-0 text-meta text-muted-foreground">{formatAgo(a.at, now)}</span>
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
  const level = noticeLevelMeta[n.level];
  return (
    <ListRow
      data-notice-row
      data-resolved={resolved || undefined}
      summary={
        // 一条通知（#1939，照路由页样板）：第一行标题加一个级别标签；正文两行；谁在处理一行；
        // 要你拍的选项区；最后一行灰字写时间、送没送到、谁处理的。主操作带字（#1904），
        // md 起在右上和标题同一行（不再在高卡片里垂直居中、飘在中间），手机上排在内容下面、两个按钮平分一行。
        <div className="flex w-full min-w-0 flex-col gap-3 py-1 md:flex-row md:items-start md:gap-6">
          <div className="flex min-w-0 flex-1 gap-3">
            <StatusDot tone={level.tone} className={cn('mt-2', resolved && 'opacity-40')} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-row-name-line>
                <span
                  data-row-name
                  className={cn(
                    'min-w-0 text-body break-words',
                    resolved ? 'text-muted-foreground' : 'font-semibold',
                  )}
                >
                  {n.title}
                </span>
                <Tag tone={level.tone}>{level.label}</Tag>
              </div>
              <ClampedBody text={n.body} />
              {!resolved && n.handling ? <HandlingRow h={n.handling} now={now} /> : null}
              {/* 已经拍过的写在选项上面（选了要留着的项时选项还在，可以再拍，#1931） */}
              <DecisionAnswerLine n={n} me={me} now={now} />
              {!resolved && n.level === 'decision' ? (
                <DecisionPicker n={n} pending={answeringId === n.id} onAnswer={onAnswer} />
              ) : null}
              {/* 灰字一行不折：时间、送没送到、谁处理的；放不下截断 */}
              <div
                data-row-meta
                className="mt-1.5 flex min-w-0 items-center gap-x-3 overflow-hidden text-meta whitespace-nowrap text-muted-foreground"
              >
                <span className="num shrink-0" title={formatClock(n.createdAt)}>
                  {formatAgo(n.createdAt, now)}
                </span>
                <Deliveries n={n} />
                {resolved && n.resolvedAt ? (
                  <span
                    className="inline-flex min-w-0 items-center gap-1"
                    title={formatDateTime(n.resolvedAt)}
                  >
                    <Check className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">
                      {n.resolvedBy ? (isMine(n.resolvedBy, me) ? '我' : n.resolvedBy) : ''}处理于{' '}
                      <span className="num">{formatAgo(n.resolvedAt, now)}</span>
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-md:pl-5" data-notice-actions>
            {!resolved ? (
              <Button
                size="sm"
                variant="outline"
                disabled={resolvePending && resolveId === n.id}
                onClick={() => onDone(n)}
                className="max-md:flex-1"
              >
                <Check />
                处理了
              </Button>
            ) : null}
            {n.link ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpen(n.link ?? '/')}
                className="max-md:flex-1"
              >
                <ArrowUpRight aria-hidden />
                打开
              </Button>
            ) : null}
          </div>
        </div>
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
          <h2 className="mb-2 px-1 text-meta font-medium text-muted-foreground">{day}</h2>
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

/**
 * 列表上面的结论块（#1939，照路由页样板的标题块）：一行 subtitle「待处理 N 条」；一行结论短话加一个状态
 * （有要你拍的写「等你拍板」，只剩卡住的写「有卡住」）；一行灰字写规则。三行都不折，放不下截断、整句在悬停里。
 * 数字是接口给的总数（#1745），和铃铛、侧栏角标同数，日报不算进待处理。
 */
function PendingHero({ counts }: { counts: { decision: number; alert: number; daily: number } }) {
  const pending = pendingCount(counts);
  const parts = [
    counts.decision > 0 ? `${counts.decision} 件要你拍` : null,
    counts.alert > 0 ? `${counts.alert} 个卡住` : null,
  ].filter(Boolean);
  const line = parts.join('，');
  const rule = `要你拍的和卡住的，处理了就从这里消失。${counts.daily > 0 ? `日报 ${counts.daily} 条看一眼就行。` : ''}`;
  return (
    <header data-testid="pending-rule" className="mb-6 flex min-w-0 flex-col">
      <h2 className="truncate text-subtitle whitespace-nowrap">
        待处理 <span className="num">{pending}</span> 条
      </h2>
      {pending > 0 ? (
        <p
          data-hero-line
          title={line}
          className="mt-2 flex min-w-0 items-center gap-2.5 whitespace-nowrap text-heading font-normal"
        >
          <span className="min-w-0 truncate">{line}</span>
          <span className="shrink-0">
            {counts.decision > 0 ? (
              <StatusBadge tone="human" label="等你拍板" />
            ) : (
              <StatusBadge tone="stall" label="有卡住" />
            )}
          </span>
        </p>
      ) : null}
      <p data-hero-notes title={rule} className="mt-1.5 truncate text-meta text-muted-foreground">
        {rule}
      </p>
    </header>
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
      refresh={{
        onRefresh: () => void refetch(),
        isFetching,
        dataUpdatedAt,
        staleAfterMs: NOTIFICATIONS_STALE_AFTER_MS,
      }}
    >
      {/* 两组筛选同一行（主：处理状态，次：级别）；窄屏各自一行、自己横滑，不折（路由页样板） */}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
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
      {/* 结论块只在「待处理」里有：接口的计数跟着视图走，「连已处理的」里那几个数不是待处理数 */}
      {data && status === 'open' ? <PendingHero counts={data.counts} /> : null}
      {error ? (
        <div className="mb-4">
          <LoadError what="提醒" error={error} />
        </div>
      ) : null}
      {data?.handlingProblem ? (
        <Notice tone="stall" className="mb-4">
          {data.handlingProblem}（提醒照常列出，只是看不出谁在处理）
        </Notice>
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
