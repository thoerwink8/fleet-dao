// 任务页的三段（对题 / 动手 / 验收）那几块：合计四格、按段每段再按模型的表、每一笔的明细（#216）。
// 数都是后端算好的（usage.bySegment、segmentRuns，算法在 shared 的 usage.ts、segment-runs.ts），这里只管怎么说：
// 读到的照数写；读到一部分照数写、写明几次没读到；全没读到写「没读到」，不写 0；每一笔没读到的原因原样列出来。
import type { SegmentKind, UsageTotals } from '@fleet-dao/shared';
import { ChevronDown } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import type { Repo, TaskDetail } from '../api/types';
import { formatClock, formatCount, formatDateTime, formatDuration, formatUsd, span } from '../lib/format';
import {
  liveMs,
  noTierText,
  runNth,
  SEGMENT_ORDER,
  SEGMENT_UNMETERED,
  type SegmentRunView,
  type SegmentTotals,
  segmentHint,
  segmentLabel,
  segmentOutcomeLabel,
  segmentOutcomeTone,
  tierLabel,
  tierText,
  UNKNOWN_SEGMENT,
  unreadItemLabel,
} from '../lib/segments';
import { isTaskFinished } from '../lib/status';
import { costParts, EQUIVALENT_RULE, type Reading, reading } from '../lib/usage';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';
import { Code } from './layout/code';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
import { RepoLink } from './repo-link';
import { Button } from './ui/button';

/** 一项读数怎么写：全读到照写；读到一部分照写、写明几次没读到；全没读到写「没读到」；没有结束了的写 empty。 */
function Read({ r, empty = '—', children }: { r: Reading; empty?: ReactNode; children: ReactNode }) {
  if (r.kind === 'none') return <span className="text-muted-foreground">{empty}</span>;
  if (r.kind === 'missing') {
    // 没读到的格子只留 —；读不到的是什么、为什么，由区块顶上那一条 Notice 和「每一笔」说（#1903）
    return (
      <span className="text-muted-foreground" data-unread title="没读到">
        —
      </span>
    );
  }
  return (
    <>
      <span className="num">{children}</span>
      {r.kind === 'partial' ? (
        <span className="block text-meta text-muted-foreground" data-partial>
          另有 {r.missing} 次没读到
        </span>
      ) : null}
    </>
  );
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** 和 ref 同一天的只写 14:20，不同天的带上日期。 */
function clockOf(iso: string, ref: number): string {
  return sameDay(Date.parse(iso), ref) ? formatClock(iso) : formatDateTime(iso);
}

/** 单子从开单到现在（结束了的算到最后一笔收场）。 */
function wallMs(d: TaskDetail, now: number): number {
  const ends = [...d.segmentRuns.map((r) => r.endedAt), ...d.runs.map((r) => r.endedAt)].filter(
    (e): e is string => e !== undefined,
  );
  const last = ends.sort().at(-1);
  return span(d.task.createdAt, isTaskFinished(d.task) ? last : undefined, now);
}

/**
 * 花费顶格读不到、又估不出有用数字时，收成灰字（#1751）：不占大格。
 * 有估算金额时仍占大格（真有数可看）。
 */
function costCollapseLabel(t: UsageTotals): string | undefined {
  const { metered, subscription, unknown } = t.cost;
  const pick = metered.runs ? metered : subscription.runs ? subscription : unknown;
  const r = reading(pick.usd, pick.missing, pick.runs);
  const e = t.estimate;
  if (r.kind === 'missing' && (e.runs || e.noPrice || e.noTokens)) {
    if (e.runs) return undefined;
    if (e.noPrice) return '花费没有单价';
    return '花费估不了';
  }
  if (r.kind === 'missing') return '花费没读到';
  return undefined;
}

/** 手机一行摘要里的花费：和花费那一格同一套取舍，只留一个短词。 */
function costBrief(t: UsageTotals): string {
  const { metered, subscription, unknown } = t.cost;
  const meteredR = reading(metered.usd, metered.missing, metered.runs);
  const subR = reading(subscription.usd, subscription.missing, subscription.runs);
  const pick = metered.runs ? metered : subscription.runs ? subscription : unknown;
  const r = reading(pick.usd, pick.missing, pick.runs);
  const e = t.estimate;
  if (r.kind === 'missing' && (e.runs || e.noPrice || e.noTokens)) {
    return e.runs ? `估算 ${formatUsd(e.usd)}` : e.noPrice ? '没有单价' : '估不了';
  }
  if (r.kind === 'missing') return '花费没读到';
  if (r.kind === 'none') return '花费 —';
  if (meteredR.kind === 'full' || meteredR.kind === 'partial') return formatUsd(meteredR.value);
  if (subR.kind === 'full' || subR.kind === 'partial') return `折合 ${formatUsd(subR.value)}`;
  return `花费 ${shareText(meteredR)}`;
}

/**
 * 结论块下面的一个数（#1920，照路由页样板）：不再是一张张带框的大卡片，而是一排不带框的数，桌面上用细竖线隔开；
 * 标签一行灰字、数一行（区块标题那一档，比页标题小）、说明一行灰字（放不下截断，整句在悬停里）。
 */
function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'stall' | undefined;
}) {
  return (
    <div
      data-tone={tone}
      data-figure
      className="min-w-0 xl:border-l xl:pl-4 xl:first:border-l-0 xl:first:pl-0"
    >
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className={cn('num mt-1 text-heading', tone && 'text-ink-stall')}>{value}</div>
      {hint ? (
        <div
          className="mt-0.5 truncate text-meta text-muted-foreground"
          title={typeof hint === 'string' ? hint : undefined}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/** 顶上几个数：已用时、干活合计、输入当量、花费。没读到的不占一格，收成一行灰字（#1751）。 */
export function SegmentStats({ d, now }: { d: TaskDetail; now: number }) {
  const phone = usePhone();
  const [expanded, setExpanded] = useState(false);
  const t = d.usage.total;
  const live = d.segmentRuns
    .map((r) => liveMs(r, now))
    .filter((ms): ms is number => ms !== undefined)
    .reduce((n, ms) => n + ms, 0);
  const work = reading(t.runMs, t.missingTime, t.runs);
  const equivalent = reading(t.inputEquivalent, t.missingEquivalent, t.runs);
  const finished = isTaskFinished(d.task);
  const notYet = t.running ? '跑完才有数' : '还没跑过';
  const missingNote = (r: Reading, what: string) =>
    r.kind === 'partial'
      ? `另有 ${r.missing} 次${what}没读到，没算进来`
      : r.kind === 'missing'
        ? `${r.missing} 次都没读到${what}`
        : undefined;

  const cards: ReactNode[] = [
    <Figure
      key="wall"
      label={finished ? '总耗时' : '已用时'}
      value={formatDuration(wallMs(d, now))}
      hint={finished ? '从开单到最后一段收场' : '从开单算到现在'}
    />,
  ];
  const collapsed: string[] = [];

  if (work.kind === 'missing') {
    collapsed.push('干活合计没读到');
  } else {
    cards.push(
      <Figure
        key="work"
        label="干活合计"
        value={
          work.kind === 'none' && !live ? '—' : formatDuration((work.kind === 'none' ? 0 : work.value) + live)
        }
        hint={
          missingNote(work, '耗时') ??
          (live ? `含在跑的 ${t.running} 段，算到现在` : work.kind === 'none' ? notYet : '各段起止加起来')
        }
      />,
    );
  }

  if (equivalent.kind === 'missing') {
    collapsed.push('输入当量没读到');
  } else {
    cards.push(
      <Figure
        key="equivalent"
        label="输入当量"
        value={equivalent.kind === 'none' ? '—' : formatCount(equivalent.value)}
        hint={
          missingNote(equivalent, ' token ') ??
          (equivalent.kind === 'none' ? notYet : `按${EQUIVALENT_RULE}折`)
        }
      />,
    );
  }

  const costCollapsed = costCollapseLabel(t);
  if (costCollapsed) collapsed.push(costCollapsed);
  else cards.push(<CostStat key="cost" t={t} notYet={notYet} />);

  // 有几张大格排几栏；四格手机就是 2×2（#1802，一行一张页面太长），电脑宽屏四列并排；三格手机一列
  const cols =
    cards.length >= 4
      ? 'grid-cols-2 gap-4 xl:grid-cols-4'
      : cards.length === 3
        ? 'grid-cols-1 gap-3 sm:grid-cols-3'
        : 'grid-cols-2 gap-3';

  const wallText = formatDuration(wallMs(d, now));
  const segmentCount = new Set(d.segmentRuns.map((r) => r.segment).filter(Boolean)).size;

  return (
    <div data-segment-stats>
      {phone ? (
        // 手机首屏只放一行摘要（耗时 · 花费 · 段），点开才出四张统计卡（#1820）
        <>
          <Section flush>
            <button
              type="button"
              data-stats-summary
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="flex min-h-10 w-full items-center gap-2 px-4 py-2 text-left text-body"
            >
              <span className="num min-w-0 flex-1 truncate">
                {finished ? '共' : '已用'} {wallText} · {costBrief(t)} · {segmentCount} 段
              </span>
              <ChevronDown
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform',
                  expanded && 'rotate-180',
                )}
                aria-hidden
              />
            </button>
          </Section>
          {expanded ? <div className={cn('mt-3 grid', cols)}>{cards}</div> : null}
        </>
      ) : (
        <div className={cn('grid', cols)}>{cards}</div>
      )}
      {collapsed.length ? (
        <p className="mt-2 text-meta text-muted-foreground" data-stats-unread title={collapsed.join(' · ')}>
          {collapsed.join(' · ')}
        </p>
      ) : null}
      {(t.unreadSegments ?? 0) > 0 ? (
        <p className="mt-2 text-meta text-muted-foreground" data-unread-segments>
          另有 {t.unreadSegments} 段读不到用量
        </p>
      ) : null}
    </div>
  );
}

function shareText(r: Reading): string {
  if (r.kind === 'none') return '—';
  if (r.kind === 'missing') return '没读到';
  return formatUsd(r.value);
}

/**
 * 花费一格：按量、套餐内折合上下两行，各带标签。大字只给按量（真花的钱）；折合用小字，不跟大字并排。
 * 执行体一笔花费都没报（订阅制）时仍写按目录单价的估算；估都估不了的写明为什么，不写 0。
 */
function CostStat({ t, notYet }: { t: UsageTotals; notYet: string }) {
  const { metered, subscription, unknown } = t.cost;
  const meteredR = reading(metered.usd, metered.missing, metered.runs);
  const subR = reading(subscription.usd, subscription.missing, subscription.runs);
  const unknownR = reading(unknown.usd, unknown.missing, unknown.runs);
  const pick = metered.runs ? metered : subscription.runs ? subscription : unknown;
  const r = reading(pick.usd, pick.missing, pick.runs);
  const e = t.estimate;
  const estimateNotes = [
    e.runs ? `另估 ${formatUsd(e.usd)}` : '',
    e.noPrice ? `${e.noPrice} 笔没有单价` : '',
    e.noTokens ? `${e.noTokens} 笔估不了` : '',
  ].filter(Boolean);
  if (r.kind === 'missing' && (e.runs || e.noPrice || e.noTokens)) {
    // 一笔都没报花费：大字写估算（标「估算」），估不了的写原因
    return (
      <Figure
        label="花费"
        value={e.runs ? `估算 ${formatUsd(e.usd)}` : e.noPrice ? '没有单价' : '估不了'}
        tone={e.runs ? undefined : 'stall'}
        hint={['执行体没报花费，按目录单价 × token 估', ...estimateNotes.slice(e.runs ? 1 : 0)].join(' · ')}
      />
    );
  }
  if (r.kind === 'none') return <Figure label="花费" value="—" hint={notYet} />;
  const meteredLarge = meteredR.kind === 'full' || meteredR.kind === 'partial';
  const notes = [
    meteredR.kind === 'partial' ? `按量另有 ${meteredR.missing} 次没读到` : '',
    subR.kind === 'partial' ? `套餐内另有 ${subR.missing} 次没读到` : '',
    unknownR.kind === 'full' || unknownR.kind === 'partial' ? `分不清 ${formatUsd(unknownR.value)}` : '',
    unknownR.kind === 'missing' ? '分不清 · 花费没读到' : '',
    unknownR.kind === 'partial' ? `分不清的另有 ${unknownR.missing} 次没读到` : '',
    ...estimateNotes,
  ].filter(Boolean);
  // 两行：「按量 $x」（真花的钱，数用这一格的字号）；下面一行灰字「套餐内折合 $y」。说明（几次没读到、另估）在第三行，悬停看全
  return (
    <Figure
      label="花费"
      value={
        <span data-cost className="flex flex-col items-start gap-0.5 font-normal">
          <span className="flex items-baseline gap-1.5">
            <span className="text-meta font-normal text-muted-foreground" title="按量计费：真花的钱">
              按量
            </span>
            <span
              data-metered
              data-large={meteredLarge}
              className={cn(
                'num',
                meteredLarge ? 'text-heading' : 'text-body font-medium',
                meteredR.kind === 'missing' && 'text-ink-stall',
              )}
            >
              {shareText(meteredR)}
            </span>
          </span>
          <span
            className="text-meta font-normal text-muted-foreground"
            title="套餐内：按 API 价折合，账单不因它多一笔"
          >
            <span>套餐内折合</span> {shareText(subR)}
          </span>
        </span>
      }
      hint={notes.length ? notes.join(' · ') : undefined}
    />
  );
}

/** 表的列：段（或模型）、次数、派工档、耗时、token、缓存、当量、花费。电脑上一行（耗时列固定宽、不换行），手机上两列、每格带名字；表头和每行共用同一套列宽。 */
const COLUMNS = 'grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-segments md:items-baseline md:gap-y-0';
const ROW = cn('grid', COLUMNS);

function Cell({
  label,
  className,
  nowrap,
  children,
}: {
  label: string;
  className?: string;
  /** 耗时格：字不换行。电脑上 min-w-0，长句子不能把固定的耗时列撑得比别的行宽。 */
  nowrap?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(nowrap ? 'whitespace-nowrap md:min-w-0' : 'min-w-0', className)}>
      <div className="text-meta text-muted-foreground md:hidden">{label}</div>
      <div className={cn('text-body', nowrap ? 'whitespace-nowrap' : 'min-w-0')}>{children}</div>
    </div>
  );
}

/** 花费那一格：按量、套餐内、分不清各一行（说法和 lib/usage 的 costParts 一样），读到一部分的另起一行写几次没读到。 */
function CostCell({ t }: { t: UsageTotals }) {
  const parts = costParts(t);
  if (!parts.length) return <span className="text-muted-foreground">{t.running ? '跑完才有' : '—'}</span>;
  // 一格里全是没读到：只留一个 —，原因放在 title 里（区块顶上的 Notice 已经说了这一项读不到）
  if (parts.every((p) => p.missing)) {
    // 「估不了」「没有单价」是说明为什么算不出来，不是单纯的没读到：照写在 — 下面，原因不丢
    const why = parts.filter((p) => p.missing && /估不了|没有单价/.test(p.missing));
    return (
      <span className="flex flex-col text-muted-foreground">
        <span data-unread title={parts.map((p) => p.missing).join('；')}>
          —
        </span>
        {why.map((p) => (
          <span key={p.key} className="text-meta">
            {p.missing}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      {parts.map((p) => (
        <span key={p.key} title={p.title}>
          {p.missing ? (
            <span className="text-muted-foreground" data-unread title={p.missing}>
              {p.label ? `${p.label} ` : ''}—
            </span>
          ) : (
            <span className="num">
              {p.label} {p.value}
              {p.unit ? <span className="text-meta text-muted-foreground"> {p.unit}</span> : null}
            </span>
          )}
          {p.incomplete ? (
            <span className="block text-meta text-muted-foreground" data-partial>
              另有 {p.incomplete} 次没读到
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** 一组（一段或一段里的一个模型）的那几格：耗时、token、缓存、当量、花费。 */
function Figures({ t, live }: { t: UsageTotals; live: number | undefined }) {
  const work = reading(t.runMs, t.missingTime, t.runs);
  const runningNote = t.running ? (live !== undefined ? `在跑 ${formatDuration(live)}` : '在跑') : undefined;
  return (
    <>
      <Cell label="耗时" nowrap>
        <Read r={work} empty={runningNote ?? '—'}>
          {formatDuration(work.kind === 'none' || work.kind === 'missing' ? 0 : work.value)}
        </Read>
        {runningNote && work.kind !== 'none' ? (
          <div className="text-meta text-ink-run">{runningNote}</div>
        ) : null}
      </Cell>
      <Cell label="token（输入 / 输出）">
        <Read
          r={reading(t.inputTokens + t.outputTokens, t.missingTokens, t.runs)}
          empty={t.running ? '跑完才有' : '—'}
        >
          {formatCount(t.inputTokens)} / {formatCount(t.outputTokens)}
        </Read>
      </Cell>
      <Cell label="缓存（读 / 写）">
        <Read
          r={reading(t.cacheReadTokens + t.cacheWriteTokens, t.missingCache, t.runs)}
          empty={t.running ? '跑完才有' : '—'}
        >
          {formatCount(t.cacheReadTokens)} / {formatCount(t.cacheWriteTokens)}
        </Read>
      </Cell>
      <Cell label="当量">
        <Read
          r={reading(t.inputEquivalent, t.missingEquivalent, t.runs)}
          empty={t.running ? '跑完才有' : '—'}
        >
          {formatCount(t.inputEquivalent)}
        </Read>
      </Cell>
      <Cell label="花费">
        <CostCell t={t} />
      </Cell>
    </>
  );
}

function timesText(t: UsageTotals): string {
  return [
    `${t.runs + t.running} 次`,
    t.running ? `${t.running} 次在跑` : '',
    t.notStarted ? `${t.notStarted} 次没起来` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * 一组（一段或一段里的一个模型）里哪几项整项没读到：区块顶上那条 Notice 用它写「没读到：耗时、token…」。
 * 读到一部分的不算（那一格有数，旁边写另有几次没读到）。
 */
function unreadOf(t: UsageTotals): string[] {
  const out: string[] = [];
  if (reading(t.runMs, t.missingTime, t.runs).kind === 'missing') out.push('耗时');
  if (reading(t.inputTokens + t.outputTokens, t.missingTokens, t.runs).kind === 'missing') out.push('token');
  if (reading(t.cacheReadTokens + t.cacheWriteTokens, t.missingCache, t.runs).kind === 'missing') {
    out.push('缓存');
  }
  if (reading(t.inputEquivalent, t.missingEquivalent, t.runs).kind === 'missing') out.push('当量');
  if (costParts(t).some((p) => p.missing)) out.push('花费');
  return out;
}

/** 手机上一段只占一行的摘要：段、模型、次数、耗时、token、花费；没读到的不写在这里（区块顶上的 Notice 说了），不写 0。 */
function segmentSummary(s: SegmentTotals, live: number | undefined): string {
  const work = reading(s.runMs, s.missingTime, s.runs);
  const tokens = reading(s.inputTokens + s.outputTokens, s.missingTokens, s.runs);
  const cost = costParts(s)
    .filter((p) => !p.missing)
    .map((p) => `${p.label} ${p.value}`);
  return [
    s.segment ? segmentLabel[s.segment] : UNKNOWN_SEGMENT,
    s.byModel.length === 1
      ? s.byModel[0]?.modelName
      : s.byModel.length > 1
        ? `${s.byModel.length} 个模型`
        : '',
    timesText(s),
    work.kind === 'full' || work.kind === 'partial'
      ? formatDuration(work.value + (live ?? 0))
      : live !== undefined && work.kind !== 'missing'
        ? `在跑 ${formatDuration(live)}`
        : '',
    tokens.kind === 'full' || tokens.kind === 'partial'
      ? `${formatCount(s.inputTokens)} / ${formatCount(s.outputTokens)} token`
      : '',
    cost.join('，'),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 一段的那一行，加它下面按模型的几行；只用了一个模型的，模型名写在段名旁边，不再重复一行同样的数。手机上只留一行摘要。 */
function SegmentGroup({ s, live }: { s: SegmentTotals; live: (model?: string) => number | undefined }) {
  const tier = tierText(s.segment, s);
  const only = s.byModel.length === 1 ? s.byModel[0] : undefined;
  const summary = segmentSummary(s, live());
  return (
    <li className="py-3" data-segment={s.segment ?? 'unknown'}>
      <div className={cn('hidden md:grid', COLUMNS)}>
        <div className="col-span-2 min-w-0 md:col-span-1">
          {/* 段名一行：段名加只用了的那个模型，不折；这一段做什么收进段名的悬停（#1920，原来多占一行灰字） */}
          <div className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap">
            <span
              className={cn('shrink-0 font-medium', s.segment === null && 'text-ink-stall')}
              title={s.segment ? segmentHint[s.segment] : '原样写在下面每一笔里'}
              data-segment-hint
            >
              {s.segment ? segmentLabel[s.segment] : UNKNOWN_SEGMENT}
            </span>
            {only ? (
              <span
                className="num min-w-0 truncate text-body text-muted-foreground"
                title={only.model}
                data-model={only.model}
              >
                {only.modelName}
              </span>
            ) : null}
          </div>
          {s.segment && SEGMENT_UNMETERED[s.segment] ? (
            <div className="text-meta text-muted-foreground" data-unmetered={s.segment}>
              {SEGMENT_UNMETERED[s.segment]?.partial}
            </div>
          ) : null}
        </div>
        <Cell label="次数">
          <span className="num">{timesText(s)}</span>
        </Cell>
        <Cell label="派工档">
          <span className={cn((tier.missing || !s.tiers.length) && 'text-muted-foreground')}>
            {tier.text}
          </span>
          {tier.note ? <div className="text-meta text-muted-foreground">{tier.note}</div> : null}
        </Cell>
        <Figures t={s} live={live()} />
      </div>
      <p
        className={cn('text-body break-words md:hidden', s.segment === null && 'text-ink-stall')}
        data-segment-summary
      >
        {summary}
      </p>
      {s.byModel.length > 1 ? (
        <ul className="mt-2 hidden space-y-2 md:block">
          {s.byModel.map((m) => (
            <li key={m.model} className={ROW} data-model={m.model}>
              <div className="col-span-2 min-w-0 border-l-2 pl-2 md:col-span-1">
                <span className="num block truncate text-body" title={m.model}>
                  {m.modelName}
                </span>
              </div>
              <Cell label="次数">
                <span className="num text-muted-foreground">{timesText(m)}</span>
              </Cell>
              <div className="hidden md:block" />
              <Figures t={m} live={live(m.model)} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 按段、每段再按模型：对题、动手、验收固定三行，没跑过的写明没有记录；段名认不出的单列一组排最后。 */
export function SegmentBreakdown({ d, now }: { d: TaskDetail; now: number }) {
  const bySegment = new Map(d.usage.bySegment.map((s) => [s.segment, s]));
  const liveOf = (segment: SegmentKind | null) => (model?: string) => {
    const ms = d.segmentRuns
      .filter((r) => r.segment === segment && (model === undefined || r.model === model))
      .map((r) => liveMs(r, now))
      .filter((v): v is number => v !== undefined);
    return ms.length ? ms.reduce((a, b) => a + b, 0) : undefined;
  };
  const unknown = bySegment.get(null);
  // 同一个区块里重复的「没读到」合成顶上一条（#1903）：格子里只留 —，哪几项、为什么，这里和「每一笔」说
  const unreadItems = SEGMENT_ORDER.map((segment) => bySegment.get(segment))
    .concat(unknown)
    .flatMap((s) => (s ? [s, ...s.byModel] : []))
    .flatMap(unreadOf);
  const unreadList = ['耗时', 'token', '缓存', '当量', '花费'].filter((k) => unreadItems.includes(k));
  return (
    <Section title="三段" description="对题 → 动手 → 验收，每段再按模型分" tight>
      {unreadList.length ? (
        <div className="mt-2" data-unread-notice>
          <Notice tone="stall" title={`没读到：${unreadList.join('、')}`}>
            这几项在表里留成 —，不是 0。原因在下面「每一笔」里逐笔写着。
          </Notice>
        </div>
      ) : null}
      <div
        className={cn(
          'hidden md:grid',
          COLUMNS,
          'border-b py-2 text-meta text-muted-foreground [&>span]:min-w-0',
        )}
        aria-hidden
      >
        <span>段 / 模型</span>
        <span>次数</span>
        <span>派工档</span>
        <span className="whitespace-nowrap">耗时</span>
        <span>token（输入 / 输出）</span>
        <span>缓存（读 / 写）</span>
        <span>当量</span>
        <span>花费</span>
      </div>
      <ul className="divide-y">
        {SEGMENT_ORDER.map((segment) => {
          const s = bySegment.get(segment);
          if (!s) {
            const unmetered = SEGMENT_UNMETERED[segment];
            if (unmetered) {
              return (
                <li
                  key={segment}
                  className="flex flex-wrap items-baseline gap-x-3 py-3"
                  data-segment={segment}
                  data-unmetered={segment}
                >
                  <span className="font-medium text-muted-foreground">{segmentLabel[segment]}</span>
                  <span className="text-body text-muted-foreground">{unmetered.short}</span>
                  <span className="w-full text-meta text-muted-foreground">{unmetered.why}</span>
                </li>
              );
            }
            return (
              <li key={segment} className="flex flex-wrap items-baseline gap-x-3 py-3" data-segment={segment}>
                <span className="font-medium text-muted-foreground">{segmentLabel[segment]}</span>
                <span className="text-body text-muted-foreground">没有这一段的记录</span>
              </li>
            );
          }
          return <SegmentGroup key={segment} s={s} live={liveOf(segment)} />;
        })}
        {unknown ? <SegmentGroup s={unknown} live={liveOf(null)} /> : null}
      </ul>
    </Section>
  );
}

/** 一笔的段：认不出的用提醒色写「段名认不出」。 */
function SegmentTag({ segment }: { segment: SegmentKind | null }) {
  return (
    <Tag tone={segment === null ? 'stall' : 'neutral'}>
      {segment ? segmentLabel[segment] : UNKNOWN_SEGMENT}
    </Tag>
  );
}

/** 一笔的 token、当量、花费：读到的照写，没读到的不写在这里（原因在下面那几行）。 */
function runFigures(run: SegmentRunView): string[] {
  const parts: string[] = [];
  if (run.inputTokens !== undefined) parts.push(`输入 ${formatCount(run.inputTokens)}`);
  if (run.outputTokens !== undefined) parts.push(`输出 ${formatCount(run.outputTokens)}`);
  if (run.cacheReadTokens !== undefined) parts.push(`缓存读 ${formatCount(run.cacheReadTokens)}`);
  if (run.cacheWriteTokens !== undefined) parts.push(`缓存写 ${formatCount(run.cacheWriteTokens)}`);
  if (run.costUsd !== undefined) {
    const prefix =
      run.billing === 'metered' ? '按量 ' : run.billing === 'subscription' ? '套餐内折合 ' : '花费 ';
    parts.push(
      `${prefix}${formatUsd(run.costUsd)}${run.billing === undefined ? '（分不清按量、套餐内）' : ''}`,
    );
  }
  if (run.estimate?.kind === 'estimated') parts.push(`估算 ${formatUsd(run.estimate.usd)}（按目录单价）`);
  if (run.memoryPeakMb !== undefined) parts.push(`内存峰值 ${formatCount(run.memoryPeakMb)} MB`);
  return parts;
}

/** 这一笔没报花费、也估不了：为什么（没有单价、token 没读全）。 */
function estimateGap(run: SegmentRunView): string | undefined {
  if (run.estimate?.kind === 'noPrice') return `${run.estimate.why}，估不了`;
  if (run.estimate?.kind === 'noTokens') return run.estimate.why;
  return undefined;
}

function RunRow({
  run,
  repo,
  now,
  nth,
  onView,
}: {
  run: SegmentRunView;
  repo: Repo;
  now: number;
  /** 点「看会话」：由页面把 ?run=<笔号> 写进网址、开右侧抽屉。 */
  onView: (runId: string) => void;
  /** 这一段的第几次（按起跑先后）。 */
  nth: number;
}) {
  const live = liveMs(run, now);
  const gap = estimateGap(run);
  const figures = runFigures(run);
  return (
    <li className="py-3" data-run={run.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SegmentTag segment={run.segment} />
        <span className="num text-meta text-muted-foreground" data-nth={nth}>
          第 {nth} 次
        </span>
        <Code>{run.modelName}</Code>
        {run.tier ? (
          <span className="text-meta text-muted-foreground">{tierLabel[run.tier]}</span>
        ) : run.segment && run.segment !== 'manual' ? (
          <span className="text-meta text-muted-foreground">{noTierText[run.segment]}</span>
        ) : null}
        {run.running ? (
          <StatusBadge tone="run" label="在跑" />
        ) : run.outcome ? (
          <StatusBadge tone={segmentOutcomeTone[run.outcome]} label={segmentOutcomeLabel[run.outcome]} />
        ) : (
          <StatusBadge tone="stall" label="结局没读到" />
        )}
        {run.matchedBy === 'issueNumber' ? (
          <span title="这一笔没记 task_id，是按单号对上的；单号在几个仓里可能重">
            <Tag>按单号兜底</Tag>
          </span>
        ) : null}
        <span className="num order-3 w-full text-meta text-muted-foreground sm:order-2 sm:ml-auto sm:w-auto">
          {run.startedAt ? clockOf(run.startedAt, now) : '开始没读到'}
          {run.running
            ? ' 起'
            : run.endedAt
              ? ` → ${clockOf(run.endedAt, run.startedAt ? Date.parse(run.startedAt) : now)}`
              : ''}
          {' · '}
          {run.durationMs !== undefined ? (
            formatDuration(run.durationMs)
          ) : live !== undefined ? (
            <span className="text-ink-run">已跑 {formatDuration(live)}</span>
          ) : (
            '—'
          )}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="order-2 ml-auto sm:order-3 sm:ml-0"
          aria-label={`看会话：${run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT}第 ${nth} 次`}
          data-view-transcript={run.id}
          onClick={() => onView(run.id)}
        >
          看会话
        </Button>
      </div>
      {figures.length || run.prNumber !== undefined || run.branch ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-muted-foreground">
          {figures.map((f) => (
            <span key={f} className="num">
              {f}
            </span>
          ))}
          {run.prNumber !== undefined ? (
            <RepoLink
              repo={repo}
              kind="pull"
              n={run.prNumber}
              className="num underline-offset-2 hover:underline max-md:inline-flex max-md:min-h-10 max-md:items-center"
            >
              PR #{run.prNumber}
            </RepoLink>
          ) : null}
          {run.branch ? <span className="num truncate">{run.branch}</span> : null}
        </div>
      ) : null}
      {run.failureReason ? (
        <p className="mt-1 text-meta text-muted-foreground">为什么没成：{run.failureReason}</p>
      ) : null}
      {run.unread.length || gap ? (
        // 一笔里没读到的几项并成一段话（原来一项一行，一笔占五行）；颜色不再用提醒色，提醒由「三段」顶上那条 Notice 担着
        <p className="mt-1 text-meta text-muted-foreground" data-unread-line>
          没读到：
          {run.unread.map((n, i) => (
            <Fragment key={n.item}>
              {i ? '；' : ''}
              <span data-unread-item={n.item}>
                <span className="font-medium">{unreadItemLabel[n.item]}</span> · {n.reason}
              </span>
            </Fragment>
          ))}
          {gap ? (
            <>
              {run.unread.length ? '；' : ''}
              <span data-estimate-gap>花费 · {gap}</span>
            </>
          ) : null}
        </p>
      ) : null}
    </li>
  );
}

/** 每一笔：按起跑先后，段、模型、派工档、结局、起止和耗时、用量、PR；按单号兜底对上的、没读到的都写明。 */
export function SegmentRunList({
  d,
  now,
  onViewTranscript,
}: {
  d: TaskDetail;
  now: number;
  onViewTranscript: (runId: string) => void;
}) {
  return (
    <Section
      title="每一笔"
      // 长说明（按单号兜底是什么、抽屉网址能分享）在页头 ⓘ 里（#1920）
      description="按起跑先后，点「看会话」在右侧看会话内容"
      tight
    >
      <ol className="divide-y">
        {d.segmentRuns.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            repo={d.repo}
            now={now}
            nth={runNth(d.segmentRuns, run.id) ?? 1}
            onView={onViewTranscript}
          />
        ))}
      </ol>
    </Section>
  );
}
