import { answerResolves, NO_OPTIONS_TEXT } from '@fleet-dao/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Send,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  errorText,
  keys,
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
import { decisionResult, decisionToast } from '../lib/decision-result';
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
function Deliveries({ n, compact = false }: { n: Notification; compact?: boolean }) {
  // compact：收起的「要你拍」那一行（#1950），手机上把位置让给推荐理由；送到了、只在驾驶舱这类平常事不写，没送到照旧红标签
  if (!n.deliveries.length)
    return <span className={cn('shrink-0', compact && 'max-md:hidden')}>只在{brand.product}</span>;
  return (
    <>
      {n.deliveries.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同一渠道可以发给好几个对象，契约里没有对象编号。
        <Tooltip key={`${d.channel}-${i}`}>
          <TooltipTrigger asChild>
            {d.delivered ? (
              <span
                data-delivery="ok"
                className={cn('inline-flex shrink-0 items-center gap-1', compact && 'max-md:hidden')}
              >
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
 * 「要你拍」收起时的那一句灰字（#1950）：不展开也知道系统怎么建议。
 * 有推荐项写「推荐：发布。理由」；拍过了不写（「我选了：…」那一行顶上）；没有选项的老通知写「没有选项，请直接回复」（展开、收起都在）。
 * 一行不折：放不下截断，整句在悬停里。
 */
function DecisionHint({ n }: { n: Notification }) {
  const options = n.options ?? [];
  if (options.length === 0) {
    return (
      <p className="mt-1 truncate text-meta text-muted-foreground" data-testid="no-options">
        {NO_OPTIONS_TEXT}
      </p>
    );
  }
  const rec = options.find((o) => o.recommended);
  if (n.answer || !rec) return null;
  const line = `推荐：${rec.label}。${rec.recommended}`;
  return (
    <p className="mt-1 truncate text-meta text-muted-foreground" data-testid="decision-hint" title={line}>
      推荐：<span className="font-medium text-foreground">{rec.label}</span>。{rec.recommended}
    </p>
  );
}

/**
 * 「要你拍」的选项区（#1915；#2353 起直接摆在卡上，不再收进「看选项」、也不再有「处理了」）：选一个或写一句，系统照着做。
 * 一个选项一行，整行就是按钮，点一下就是拍板；行里是选项的字（推荐的那项带「推荐」标，上次选过的带「上次选的」）
 * 和一句真实效果、推荐的写理由。md 起字和说明同一行、说明左对齐成一列；手机上整行占满、字在上说明在下，可点区至少 44 高。
 * 几项装在一个细框里、项间一根细线（系统设置的单选组），不一个个画框。下面是「自己写一句」的框加「提交」，
 * 框下一行灰字写自己写的去向。没有选项的老通知只给输入框（「没有选项，请直接回复」在标题下那一行）。
 */
function DecisionPicker({
  n,
  id,
  pending,
  text,
  onText,
  onAnswer,
}: {
  n: Notification;
  id: string;
  pending: boolean;
  /** 自己写的草稿放在行上：答了没做成、再答时还在。 */
  text: string;
  onText: (text: string) => void;
  onAnswer: (n: Notification, input: AnswerInput) => void;
}) {
  const options = n.options ?? [];
  const trimmed = text.trim();
  const last = n.answer?.optionId;
  return (
    <div id={id} className="mt-3 space-y-2.5 md:max-w-3xl" data-testid="decision-picker">
      {options.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border" aria-label="选一个">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                aria-label={o.label}
                aria-describedby={`${id}-${o.id}`}
                disabled={pending}
                onClick={() => onAnswer(n, { optionId: o.id })}
                data-option={o.id}
                className="group flex min-h-10 w-full flex-col gap-0.5 px-3 py-2 text-left outline-none first:rounded-t-md last:rounded-b-md hover:bg-st-human-soft focus-visible:ring-focus focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 md:flex-row md:items-baseline md:gap-4"
              >
                <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-body font-medium md:w-56">
                  {o.label}
                  {o.recommended ? <Tag tone="brand">推荐</Tag> : null}
                  {last === o.id ? <Tag tone="stop">上次选的</Tag> : null}
                </span>
                <span id={`${id}-${o.id}`} className="min-w-0 flex-1 text-meta text-muted-foreground">
                  {o.detail}
                  {o.recommended ? <span className="text-foreground">。{o.recommended}</span> : null}
                </span>
                <ChevronRight
                  className="hidden size-4 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 md:block"
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) onAnswer(n, { text: trimmed });
          }}
        >
          <Input
            aria-label="自己写一句"
            placeholder={options.length > 0 ? '都不合适？自己写一句' : '写你的决定'}
            value={text}
            maxLength={2000}
            disabled={pending}
            onChange={(e) => onText(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending || !trimmed}>
            <Send aria-hidden />
            提交
          </Button>
        </form>
        <p className="mt-1.5 text-meta text-muted-foreground" data-testid="custom-effect">
          {answerResolves(options, undefined)
            ? '自己写的：交给指挥官去办，交出去了这条转已处理'
            : '自己写的：交给指挥官去办，这条先留着'}
        </p>
      </div>
    </div>
  );
}

const RESULT_TONE = { done: 'done', queued: 'info', failed: 'fail', pending: 'info' } as const;
const RESULT_HEAD = { done: '照做了', queued: '交给引擎了', failed: '没做成', pending: '记下了' } as const;

/**
 * 拍过的：谁选了什么、多久前，系统照着做的结果写在下面（#2353）。做成了绿、交给引擎了蓝、没做成红（卡留着，再选一次）。
 * 已处理的只写一行「我选了：…」加结果的话，不占色块。
 */
function DecisionAnswerLine({
  n,
  me,
  now,
  plain = false,
}: {
  n: Notification;
  me: Me | undefined;
  now: number;
  /** 已处理的卡：一行灰字，不画结果框。 */
  plain?: boolean;
}) {
  const a = n.answer;
  if (!a) return null;
  const res = decisionResult(a);
  const who = `${isMine(a.by, me) ? '我' : a.by}${a.optionId === undefined ? '自己写了：' : '选了：'}`;
  if (plain) {
    return (
      <p
        className="mt-1.5 flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground"
        data-testid="decision-answer"
        data-result={res.kind}
        title={`${a.text} · ${formatDateTime(a.at)} · ${res.text}`}
      >
        <Check className="size-3.5 shrink-0 text-ink-done" aria-hidden />
        <span className="min-w-0 truncate">
          {who}
          <span className="font-medium text-foreground">{a.text}</span>
          {a.execution ? ` · ${res.text}` : ''}
        </span>
      </p>
    );
  }
  return (
    <Notice
      tone={RESULT_TONE[res.kind]}
      role="status"
      className="mt-3 md:max-w-3xl"
      title={
        <span data-testid="decision-answer" data-result={res.kind} className="flex min-w-0 flex-wrap gap-x-2">
          <span>
            {RESULT_HEAD[res.kind]} · {who}
            {a.text}
          </span>
          <span className="num font-normal opacity-80" title={formatDateTime(a.at)}>
            {formatAgo(a.at, now)}
          </span>
        </span>
      }
    >
      <span data-testid="decision-result" className="break-words">
        {res.text}
        {res.kind === 'failed' ? '。这条还开着，下面再选一次或自己写一句。' : ''}
      </span>
    </Notice>
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
  // 待拍的「要你拍」（#2353）：选项、自己写一句直接摆在卡上，选完系统照着做、结果写回卡上；没有「处理了」。
  // 交给引擎在做的（删工作树）先只摆结果，点「改主意」才再摆选项。
  const deciding = !resolved && n.level === 'decision';
  const queued = deciding && n.answer ? decisionResult(n.answer).kind === 'queued' : false;
  const [repick, setRepick] = useState(false);
  const [draft, setDraft] = useState('');
  const pickerId = useId();
  const meta = (
    // 灰字一行不折：时间、送没送到、谁处理的；放不下截断
    <div
      data-row-meta
      className={cn(
        'flex min-w-0 items-center gap-x-3 overflow-hidden text-meta whitespace-nowrap text-muted-foreground',
        deciding ? 'shrink-0' : 'mt-1.5',
      )}
    >
      <span className="num shrink-0" title={formatClock(n.createdAt)}>
        {formatAgo(n.createdAt, now)}
      </span>
      <Deliveries n={n} compact={deciding} />
      {resolved && n.resolvedAt ? (
        <span className="inline-flex min-w-0 items-center gap-1" title={formatDateTime(n.resolvedAt)}>
          <Check className="size-3 shrink-0" aria-hidden />
          <span className="truncate">
            {n.resolvedBy ? (isMine(n.resolvedBy, me) ? '我' : n.resolvedBy) : ''}处理于{' '}
            <span className="num">{formatAgo(n.resolvedAt, now)}</span>
          </span>
        </span>
      ) : null}
    </div>
  );
  return (
    <ListRow
      data-notice-row
      data-resolved={resolved || undefined}
      data-deciding={deciding || undefined}
      summary={
        // 一条通知（#1939，照路由页样板）：第一行标题加一个级别标签；正文两行；谁在处理一行；
        // 最后一行灰字写时间、送没送到、谁处理的。主操作带字（#1904），
        // md 起在右上和标题同一行（不再在高卡片里垂直居中、飘在中间），手机上排在内容下面、按钮平分一行。
        // 待拍的「要你拍」：标题、推荐那一句、正文，下面直接是结果和选项（#2353）。
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
                {deciding ? (
                  <StatusBadge tone={level.tone} label="等你拍板" variant="dot" />
                ) : (
                  <Tag tone={level.tone}>{level.label}</Tag>
                )}
              </div>
              {deciding ? (
                <>
                  {/* 第二行：推荐哪项（或没有选项）加时间、送没送到，一行不折 */}
                  <div className="mt-1 flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap">
                    {/* 拍过了不写推荐（结果框顶上），这一格不占位，免得时间前面空一截 */}
                    {n.answer && (n.options?.length ?? 0) > 0 ? null : (
                      <div className="min-w-0 [&>p]:mt-0">
                        <DecisionHint n={n} />
                      </div>
                    )}
                    {meta}
                  </div>
                  <ClampedBody text={n.body} />
                  {n.handling ? <HandlingRow h={n.handling} now={now} /> : null}
                  <DecisionAnswerLine n={n} me={me} now={now} />
                  {queued && !repick ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      aria-controls={pickerId}
                      aria-expanded={false}
                      onClick={() => setRepick(true)}
                    >
                      改主意
                    </Button>
                  ) : (
                    <DecisionPicker
                      n={n}
                      id={pickerId}
                      pending={answeringId === n.id}
                      text={draft}
                      onText={setDraft}
                      onAnswer={(row, input) => {
                        setRepick(false);
                        onAnswer(row, input);
                      }}
                    />
                  )}
                </>
              ) : (
                <>
                  <ClampedBody text={n.body} />
                  {!resolved && n.handling ? <HandlingRow h={n.handling} now={now} /> : null}
                  <DecisionAnswerLine n={n} me={me} now={now} plain />
                  {meta}
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-md:pl-5" data-notice-actions>
            {/* 要你拍的不给「处理了」：只标已处理解决不了卡上的问题（#2353），选一个或写一句才算拍了 */}
            {!resolved && n.level !== 'decision' ? (
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
  const qc = useQueryClient();
  // 必须在 useNotifications 订阅之前拍下来：订阅发生在渲染里，拍晚了看到的是这一页自己刚发起的那次。
  // 外壳角标和这一页共用 ['notifications', status]。全局 staleTime（5 秒）内进页不重读；
  // 那次读取还在飞时，新观察者只跟上、不另开。后端若在进页前刚断，跟上的是断之前发出的，
  // 回来仍是成功，页面就把旧的当成这次读成了（e2e 08「用着用着后端断了」时红时绿）。
  const [entry] = useState(() => {
    const state = qc.getQueryState(keys.notifications(status));
    return {
      hadData: state?.data !== undefined,
      busy: state?.fetchStatus === 'fetching' || state?.fetchStatus === 'paused',
      invalidated: state?.isInvalidated === true,
      updatedAt: state?.dataUpdatedAt ?? 0,
    };
  });
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useNotifications(status, limit);
  const rereadOnce = useRef(false);
  useEffect(() => {
    if (rereadOnce.current) return;
    const raw = qc.getDefaultOptions().queries?.staleTime;
    const staleMs = typeof raw === 'number' ? raw : 0;
    const fresh =
      entry.hadData &&
      !entry.busy &&
      !entry.invalidated &&
      staleMs > 0 &&
      Date.now() - entry.updatedAt < staleMs;
    // 不新鲜、也没有在飞的读取：进页自己的那次订阅会读，不必再强制一次。
    if (!entry.busy && !fresh) return;
    rereadOnce.current = true;
    // 在飞且还没有数据时，refetch 会跟上那一次而不是另开（cancelRefetch 只在已有数据时才取消）。
    // 先取消，晚到的成功就盖不掉这次失败。这一页卸了也要把补读做完，外壳才不会停在没数据上。
    void (async () => {
      if (entry.busy) await qc.cancelQueries({ queryKey: keys.notifications(status) });
      await refetch();
    })();
  }, [qc, refetch, entry, status]);
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
          // 系统照着做的结果照实说（#2353）：没做成不弹成「都好了」，卡留着、上面写原因
          const t = decisionToast(r);
          toast[t.level](t.title, { description: t.description });
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
