// 任务页的三段（对题 / 动手 / 验收）那几块：合计几个数、按段每段再按模型的表、每一笔的明细（#216）。
// 数都是后端算好的（usage.bySegment、segmentRuns，算法在 shared 的 usage.ts、segment-runs.ts），这里只管怎么说：
// 读到的照数写；读到一部分照数写、写明几次没读到；全没读到写「没读到」，不写 0；每一笔没读到的原因原样列出来。
// 只拼 components/layout 的件，不写样式（#3533）。
import { type SegmentKind, USAGE_BOARD_UNREAD, type UsageTotals } from '@fleet-dao/shared';
import { Fragment, type ReactNode } from 'react';
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
  tierLabel,
  tierText,
  UNKNOWN_SEGMENT,
  unreadItemLabel,
} from '../lib/segments';
import { isTaskFinished } from '../lib/status';
import { runOrder } from '../lib/task-process';
import { budgetUsedText, costParts, EQUIVALENT_RULE, type Reading, reading } from '../lib/usage';
import { usePhone } from '../lib/viewport';
import type { StatusKey } from '../theme/status-dict';
import { Button } from './layout/button';
import { Code } from './layout/code';
import { Notice } from './layout/notice';
import { Stack } from './layout/stack';
import { Stat, StatGrid } from './layout/stat';
import { StatusBadge } from './layout/status-badge';
import { Table, type TableColumn } from './layout/table';
import { Tag } from './layout/tag';
import { Text } from './layout/text';
import { RepoLink } from './repo-link';

/** 一项读数怎么写：全读到照写；读到一部分照写、写明几次没读到；全没读到写 —；没有结束了的写 empty。 */
function Read({ r, empty = '—', children }: { r: Reading; empty?: ReactNode; children: ReactNode }) {
  if (r.kind === 'none') return <Text tone="muted">{empty}</Text>;
  if (r.kind === 'missing') {
    // 没读到的格子只留 —；读不到的是什么、为什么，由区块顶上那一条 Notice 和「每一笔」说（#1903）
    return (
      <span data-unread title="没读到">
        <Text tone="muted">—</Text>
      </span>
    );
  }
  return (
    <Stack gap="sm">
      <Text>{children}</Text>
      {r.kind === 'partial' ? (
        <span data-partial>
          <Text size="meta" tone="muted">
            另有 {r.missing} 次没读到
          </Text>
        </span>
      ) : null}
    </Stack>
  );
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** 和 ref 同一天的只写 14:20，不同天的带上日期。 */
function clockOf(iso: string, ref: number): string {
  return sameDay(Date.parse(iso), ref) ? formatClock(iso) : formatDateTime(iso);
}

/** 单子从开单到现在（结束了的算到最后一笔收场）。 */
export function wallMs(d: TaskDetail, now: number): number {
  const ends = d.segmentRuns.map((r) => r.endedAt).filter((e): e is string => e !== undefined);
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

function shareText(r: Reading): string {
  if (r.kind === 'none') return '—';
  if (r.kind === 'missing') return '没读到';
  return formatUsd(r.value);
}

interface FigureNote {
  /** 是哪个数的说明（写在 data-figure-hint 上）。 */
  of: string;
  text: string;
  /** 悬停看的细账（折法）。 */
  title?: string;
}

/** 顶上几个数：已用时、干活合计、输入当量、花费。没读到的不占一格，收成一行灰字（#1751）；每个数的说明（几次没读到、预算用量）写在下面一行行灰字里。 */
export function SegmentStats({ d, now }: { d: TaskDetail; now: number }) {
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

  const stats: ReactNode[] = [
    <Stat key="wall" label={finished ? '总耗时' : '已用时'} value={formatDuration(wallMs(d, now))} />,
  ];
  const notes: FigureNote[] = [];
  const collapsed: string[] = [];

  if (work.kind === 'missing') {
    collapsed.push('干活合计没读到');
  } else {
    stats.push(
      <Stat
        key="work"
        label="干活合计"
        value={
          work.kind === 'none' && !live ? '—' : formatDuration((work.kind === 'none' ? 0 : work.value) + live)
        }
      />,
    );
    const hint =
      missingNote(work, '耗时') ??
      (live ? `含在跑的 ${t.running} 段，算到现在` : work.kind === 'none' ? notYet : '');
    if (hint) notes.push({ of: '干活合计', text: hint });
  }

  // 输入当量：额度和每单 token 预算都按它比（#2859），预算用量写在小字里；折法放悬停，原始四样在下面的段表里
  if (equivalent.kind === 'missing') {
    collapsed.push('输入当量没读到');
  } else {
    stats.push(
      <Stat
        key="equivalent"
        label="输入当量"
        value={equivalent.kind === 'none' ? '—' : formatCount(equivalent.value)}
      />,
    );
    const hint =
      equivalent.kind === 'none'
        ? notYet
        : [budgetUsedText(equivalent.value), missingNote(equivalent, ' token ')].filter(Boolean).join(' · ');
    if (hint) notes.push({ of: '输入当量', text: hint, title: `按${EQUIVALENT_RULE}折` });
  }

  const costCollapsed = costCollapseLabel(t);
  if (costCollapsed) collapsed.push(costCollapsed);
  else {
    const cost = costStat(t, notYet);
    stats.push(cost.stat);
    notes.push(...cost.notes);
  }

  return (
    <div data-segment-stats>
      <Stack gap="md">
        <StatGrid cols={stats.length === 4 ? 4 : stats.length === 3 ? 3 : 2}>{stats}</StatGrid>
        {notes.map((n) => (
          <span key={n.of} data-figure-hint={n.of} {...(n.title ? { title: n.title } : {})}>
            <Text size="meta" tone="muted">
              {n.of}：{n.text}
            </Text>
          </span>
        ))}
        {collapsed.length ? (
          <span data-stats-unread title={collapsed.join(' · ')}>
            <Text size="meta" tone="muted">
              {collapsed.join(' · ')}
            </Text>
          </span>
        ) : null}
        {(t.unreadSegments ?? 0) > 0 ? (
          <span data-unread-segments>
            <Text size="meta" tone="muted">
              另有 {t.unreadSegments} 段读不到用量
            </Text>
          </span>
        ) : null}
      </Stack>
    </div>
  );
}

/**
 * 花费一格：大字只给按量（真花的钱）；套餐内折合写在下面的灰字里，不跟大字并排。
 * 执行体一笔花费都没报（订阅制）时仍写按目录单价的估算；估都估不了的写明为什么，不写 0。
 */
function costStat(t: UsageTotals, notYet: string): { stat: ReactNode; notes: FigureNote[] } {
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
    const hint = ['执行体没报花费，按目录单价 × token 估', ...estimateNotes.slice(e.runs ? 1 : 0)].join(
      ' · ',
    );
    return {
      stat: (
        <Stat
          key="cost"
          label="花费"
          value={e.runs ? `估算 ${formatUsd(e.usd)}` : e.noPrice ? '没有单价' : '估不了'}
          tone={e.runs ? undefined : 'stall'}
        />
      ),
      notes: [{ of: '花费', text: hint }],
    };
  }
  if (r.kind === 'none')
    return { stat: <Stat key="cost" label="花费" value="—" />, notes: [{ of: '花费', text: notYet }] };
  const notes = [
    meteredR.kind === 'partial' ? `按量另有 ${meteredR.missing} 次没读到` : '',
    subR.kind === 'partial' ? `套餐内另有 ${subR.missing} 次没读到` : '',
    unknownR.kind === 'full' || unknownR.kind === 'partial' ? `分不清 ${formatUsd(unknownR.value)}` : '',
    unknownR.kind === 'missing' ? '分不清 · 花费没读到' : '',
    unknownR.kind === 'partial' ? `分不清的另有 ${unknownR.missing} 次没读到` : '',
    ...estimateNotes,
  ].filter(Boolean);
  const meteredLarge = meteredR.kind === 'full' || meteredR.kind === 'partial';
  return {
    stat: (
      <Stat
        key="cost"
        label="按量花费"
        value={
          <span data-cost data-metered data-large={meteredLarge}>
            {shareText(meteredR)}
          </span>
        }
        tone={meteredR.kind === 'missing' ? 'stall' : undefined}
      />
    ),
    notes: [
      { of: '套餐内折合', text: shareText(subR), title: '套餐内：按 API 价折合，账单不因它多一笔' },
      ...(notes.length ? [{ of: '花费', text: notes.join(' · ') }] : []),
    ],
  };
}

/** 花费那一格：按量、套餐内、分不清各一行（说法和 lib/usage 的 costParts 一样），读到一部分的另起一行写几次没读到。 */
function CostCell({ t }: { t: UsageTotals }) {
  const parts = costParts(t);
  if (!parts.length) return <Text tone="muted">{t.running ? '跑完才有' : '—'}</Text>;
  // 一格里全是没读到：只留一个 —，原因放在 title 里（区块顶上的 Notice 已经说了这一项读不到）
  if (parts.every((p) => p.missing)) {
    // 「估不了」「没有单价」是说明为什么算不出来，不是单纯的没读到：照写在 — 下面，原因不丢
    const why = parts.filter((p) => p.missing && /估不了|没有单价/.test(p.missing));
    return (
      <Stack gap="sm">
        <span data-unread title={parts.map((p) => p.missing).join('；')}>
          <Text tone="muted">—</Text>
        </span>
        {why.map((p) => (
          <Text key={p.key} size="meta" tone="muted">
            {p.missing}
          </Text>
        ))}
      </Stack>
    );
  }
  return (
    <Stack gap="sm">
      {parts.map((p) => (
        <span key={p.key} title={p.title}>
          {p.missing ? (
            <span data-unread title={p.missing}>
              <Text tone="muted">{p.label ? `${p.label} ` : ''}—</Text>
            </span>
          ) : (
            <Text>
              {p.label} {p.value}
              {p.unit ? (
                <Text size="meta" tone="muted">
                  {' '}
                  {p.unit}
                </Text>
              ) : null}
            </Text>
          )}
          {p.incomplete ? (
            <span data-partial>
              <Text size="meta" tone="muted">
                {' '}
                另有 {p.incomplete} 次没读到
              </Text>
            </span>
          ) : null}
        </span>
      ))}
    </Stack>
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

/** 三段表的一行：一段，或一段里的一个模型（只有多个模型时才有）。 */
interface UsageRow {
  key: string;
  kind: 'segment' | 'model' | 'unmetered' | 'norecord';
  segment: SegmentKind | null;
  totals?: UsageTotals;
  seg?: SegmentTotals;
  model?: SegmentTotals['byModel'][number];
  live: number | undefined;
}

/** 按段、每段再按模型：对题、动手、验收固定三行，没跑过的写明没有记录；段名认不出的单列一组排最后。 */
export function SegmentBreakdown({ d, now }: { d: TaskDetail; now: number }) {
  const phone = usePhone();
  const bySegment = new Map(d.usage.bySegment.map((s) => [s.segment, s]));
  const liveOf = (segment: SegmentKind | null, model?: string) => {
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

  const rows: UsageRow[] = [];
  const pushSegment = (segment: SegmentKind | null, s: SegmentTotals) => {
    rows.push({
      key: segment ?? 'unknown',
      kind: 'segment',
      segment,
      seg: s,
      totals: s,
      live: liveOf(segment),
    });
    if (s.byModel.length > 1) {
      for (const m of s.byModel) {
        rows.push({
          key: `${segment ?? 'unknown'}/${m.model}`,
          kind: 'model',
          segment,
          model: m,
          totals: m,
          live: liveOf(segment, m.model),
        });
      }
    }
  };
  for (const segment of SEGMENT_ORDER) {
    const s = bySegment.get(segment);
    if (s) pushSegment(segment, s);
    else
      rows.push({
        key: segment,
        kind: SEGMENT_UNMETERED[segment] ? 'unmetered' : 'norecord',
        segment,
        live: undefined,
      });
  }
  if (unknown) pushSegment(null, unknown);

  const dash = <Text tone="muted">—</Text>;
  const figure = (row: UsageRow, f: (t: UsageTotals, live: number | undefined) => ReactNode) =>
    row.totals ? f(row.totals, row.live) : dash;
  const columns: TableColumn<UsageRow>[] = [
    {
      key: 'name',
      title: '段 / 模型',
      render: (_v, row) => {
        if (row.kind === 'model' && row.model) {
          return (
            <span data-model={row.model.model} title={row.model.model}>
              <Text tone="secondary">{row.model.modelName}</Text>
            </span>
          );
        }
        const segment = row.segment;
        const name = segment ? segmentLabel[segment] : UNKNOWN_SEGMENT;
        if (row.kind === 'unmetered' && segment) {
          const unmetered = SEGMENT_UNMETERED[segment];
          return (
            <span data-unmetered={segment} data-segment-hint title={segmentHint[segment]}>
              <Stack gap="sm">
                <Text tone="muted">{name}</Text>
                <Text size="meta" tone="muted" {...(unmetered ? { title: unmetered.why } : {})}>
                  {unmetered?.short}
                </Text>
              </Stack>
            </span>
          );
        }
        if (row.kind === 'norecord' && segment) {
          return (
            <span title={segmentHint[segment]} data-segment-hint>
              <Stack gap="sm">
                <Text tone="muted">{name}</Text>
                <Text size="meta" tone="muted">
                  没有这一段的记录
                </Text>
              </Stack>
            </span>
          );
        }
        const only = row.seg && row.seg.byModel.length === 1 ? row.seg.byModel[0] : undefined;
        return (
          <Stack gap="sm">
            <Stack direction="horizontal" gap="sm" align="baseline">
              <span data-segment-hint title={segment ? segmentHint[segment] : '原样写在下面每一笔里'}>
                <Text strong tone={segment === null ? 'warning' : 'default'}>
                  {name}
                </Text>
              </span>
              {only ? (
                <span data-model={only.model} title={only.model}>
                  <Text tone="muted">{only.modelName}</Text>
                </span>
              ) : null}
            </Stack>
            {segment && SEGMENT_UNMETERED[segment] ? (
              <span data-unmetered={segment}>
                <Text size="meta" tone="muted">
                  {SEGMENT_UNMETERED[segment]?.partial}
                </Text>
              </span>
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: 'times',
      title: '次数',
      render: (_v, row) =>
        figure(row, (t) => <Text tone={row.kind === 'model' ? 'muted' : 'default'}>{timesText(t)}</Text>),
    },
    {
      key: 'tier',
      title: '派工档',
      render: (_v, row) => {
        if (row.kind !== 'segment' || !row.seg) return row.kind === 'model' ? '' : dash;
        const tier = tierText(row.segment, row.seg);
        return (
          <Stack gap="sm">
            <Text tone={tier.missing || !row.seg.tiers.length ? 'muted' : 'default'}>{tier.text}</Text>
            {tier.note ? (
              <Text size="meta" tone="muted">
                {tier.note}
              </Text>
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: 'work',
      title: '耗时',
      align: 'right',
      render: (_v, row) =>
        figure(row, (t, live) => {
          const work = reading(t.runMs, t.missingTime, t.runs);
          const runningNote = t.running
            ? live !== undefined
              ? `在跑 ${formatDuration(live)}`
              : '在跑'
            : undefined;
          return (
            <Stack gap="sm" align="end">
              <Read r={work} empty={runningNote ?? '—'}>
                {formatDuration(work.kind === 'none' || work.kind === 'missing' ? 0 : work.value)}
              </Read>
              {runningNote && work.kind !== 'none' ? (
                <Text size="meta" tone="muted">
                  {runningNote}
                </Text>
              ) : null}
            </Stack>
          );
        }),
    },
    {
      key: 'tokens',
      title: 'token（输入 / 输出）',
      align: 'right',
      render: (_v, row) =>
        figure(row, (t) => (
          <Read
            r={reading(t.inputTokens + t.outputTokens, t.missingTokens, t.runs)}
            empty={t.running ? '跑完才有' : '—'}
          >
            {formatCount(t.inputTokens)} / {formatCount(t.outputTokens)}
          </Read>
        )),
    },
    {
      key: 'cache',
      title: '缓存（读 / 写）',
      align: 'right',
      render: (_v, row) =>
        figure(row, (t) => (
          <Read
            r={reading(t.cacheReadTokens + t.cacheWriteTokens, t.missingCache, t.runs)}
            empty={t.running ? '跑完才有' : '—'}
          >
            {formatCount(t.cacheReadTokens)} / {formatCount(t.cacheWriteTokens)}
          </Read>
        )),
    },
    {
      key: 'equivalent',
      title: '当量',
      align: 'right',
      render: (_v, row) =>
        figure(row, (t) => (
          <Read
            r={reading(t.inputEquivalent, t.missingEquivalent, t.runs)}
            empty={t.running ? '跑完才有' : '—'}
          >
            {formatCount(t.inputEquivalent)}
          </Read>
        )),
    },
    {
      key: 'cost',
      title: '花费',
      align: 'right',
      render: (_v, row) => figure(row, (t) => <CostCell t={t} />),
    },
  ];
  return (
    <Stack gap="md">
      {unreadList.length ? (
        <div data-unread-notice>
          <Notice tone="stall" title={`没读到：${unreadList.join('、')}`}>
            这几项在表里留成 —，不是 0。原因在下面「每一笔」里逐笔写着。
          </Notice>
        </div>
      ) : null}
      {phone ? (
        // 手机上八列的表太宽：每段只留一行摘要（原来的做法，#1802）
        <Stack gap="md">
          {rows
            .filter((r) => r.kind !== 'model')
            .map((r) => (
              <div key={r.key} data-segment={r.key} data-segment-summary>
                {r.seg ? (
                  <Text tone={r.segment === null ? 'warning' : 'default'}>
                    {segmentSummary(r.seg, r.live)}
                  </Text>
                ) : (
                  <Text tone="muted">
                    {r.segment ? segmentLabel[r.segment] : UNKNOWN_SEGMENT}
                    {' · '}
                    {r.kind === 'unmetered' && r.segment
                      ? SEGMENT_UNMETERED[r.segment]?.short
                      : '没有这一段的记录'}
                  </Text>
                )}
              </div>
            ))}
        </Stack>
      ) : (
        <Table<UsageRow> caption="三段用量" columns={columns} rows={rows} rowKey="key" />
      )}
    </Stack>
  );
}

/** 一笔的 token、当量、花费：读到的照写，没读到的不写在这里（原因在下面那几行）。会话号没拿到的写「读不到」，不留空行。 */
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
  if (parts.length === 0 && !run.running && run.unread.some((n) => n.reason === USAGE_BOARD_UNREAD)) {
    parts.push(USAGE_BOARD_UNREAD);
  }
  return parts;
}

/** 这一笔没报花费、也估不了：为什么（没有单价、token 没读全）。 */
function estimateGap(run: SegmentRunView): string | undefined {
  if (run.estimate?.kind === 'noPrice') return `${run.estimate.why}，估不了`;
  if (run.estimate?.kind === 'noTokens') return run.estimate.why;
  return undefined;
}

/** 一笔的结局：在跑、记了的结局、没读到（不当完成）。 */
function runStatus(run: SegmentRunView): StatusKey {
  if (run.running) return 'task:segment:running';
  if (run.outcome) return `task:segment:${run.outcome}` as StatusKey;
  return 'task:segment:unread';
}

/** 一笔的备注：用量、为什么派它、为什么没续上、为什么没成、没读到的几项并成一段话。 */
function RunNotes({ run }: { run: SegmentRunView }) {
  const gap = estimateGap(run);
  const figures = runFigures(run);
  return (
    <Stack gap="sm">
      {run.matchedBy === 'issueNumber' ? (
        <span title="这一笔没记 task_id，是按单号对上的；单号在几个仓里可能重">
          <Tag>按单号兜底</Tag>
        </span>
      ) : null}
      {figures.length ? (
        <Stack direction="horizontal" gap="md" wrap>
          {figures.map((f) => (
            <Fragment key={f}>
              {f === USAGE_BOARD_UNREAD ? (
                <span data-usage-unread="">
                  <Text size="meta" tone="muted">
                    {f}
                  </Text>
                </span>
              ) : (
                <Text size="meta" tone="muted">
                  {f}
                </Text>
              )}
            </Fragment>
          ))}
        </Stack>
      ) : null}
      {run.segment === 'manual' ? (
        <span data-route-why>
          <Text size="meta" tone="muted">
            为什么派它：{run.routeWhy ?? '没记'}
          </Text>
        </span>
      ) : null}
      {run.resumeReason ? (
        <span data-resume-reason>
          <Text size="meta" tone="muted">
            为什么没续上：{run.resumeReason}
          </Text>
        </span>
      ) : null}
      {run.failureReason ? (
        <Text size="meta" tone="muted">
          为什么没成：{run.failureReason}
        </Text>
      ) : null}
      {run.unread.length || gap ? (
        // 一笔里没读到的几项并成一段话（原来一项一行，一笔占五行）；提醒由「三段」顶上那条 Notice 担着
        <span data-unread-line>
          <Text size="meta" tone="muted">
            没读到：
            {run.unread.map((n, i) => (
              <Fragment key={n.item}>
                {i ? '；' : ''}
                <span data-unread-item={n.item}>
                  <Text size="meta" strong tone="muted">
                    {unreadItemLabel[n.item]}
                  </Text>{' '}
                  · {n.reason}
                </span>
              </Fragment>
            ))}
            {gap ? (
              <>
                {run.unread.length ? '；' : ''}
                <span data-estimate-gap>花费 · {gap}</span>
              </>
            ) : null}
          </Text>
        </span>
      ) : null}
    </Stack>
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
  const order = runOrder(d.segmentRuns);
  const repo: Repo = d.repo;
  const columns: TableColumn<SegmentRunView>[] = [
    {
      key: 'nth',
      title: '笔',
      render: (_v, run) => (
        <span data-nth={runNth(d.segmentRuns, run.id) ?? 1}>
          <Text mono>第 {order.get(run.id) ?? '?'} 笔</Text>
        </span>
      ),
    },
    {
      key: 'segment',
      title: '段',
      render: (_v, run) => (
        <Tag tone={run.segment === null ? 'warning' : 'neutral'}>
          {run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT}
        </Tag>
      ),
    },
    {
      key: 'model',
      title: '模型',
      render: (_v, run) => (
        <Stack gap="sm">
          <Code>{run.modelName}</Code>
          <Text size="meta" tone="muted">
            {run.tier
              ? tierLabel[run.tier]
              : run.segment && run.segment !== 'manual'
                ? noTierText[run.segment]
                : ''}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'outcome',
      title: '结局',
      render: (_v, run) => <StatusBadge status={runStatus(run)} />,
    },
    {
      key: 'time',
      title: '起止 · 耗时',
      render: (_v, run) => {
        const live = liveMs(run, now);
        return (
          <Text size="meta" tone="secondary">
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
              <Text size="meta">已跑 {formatDuration(live)}</Text>
            ) : (
              '—'
            )}
          </Text>
        );
      },
    },
    {
      key: 'pr',
      title: 'PR',
      render: (_v, run) =>
        run.prNumber === undefined && !run.branch ? (
          <Text tone="muted">—</Text>
        ) : (
          <Stack gap="sm">
            {run.prNumber !== undefined ? (
              <RepoLink repo={repo} kind="pull" n={run.prNumber}>
                PR #{run.prNumber}
              </RepoLink>
            ) : null}
            {run.branch ? (
              <Text size="meta" mono tone="muted" title={run.branch}>
                {run.branch}
              </Text>
            ) : null}
          </Stack>
        ),
    },
    { key: 'notes', title: '备注', wrap: true, render: (_v, run) => <RunNotes run={run} /> },
    {
      key: 'view',
      title: '',
      render: (_v, run) => (
        <span data-view-transcript={run.id}>
          <Button
            size="xs"
            variant="text"
            aria-label={`看会话：${run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT}第 ${order.get(run.id) ?? '?'} 笔`}
            onClick={() => onViewTranscript(run.id)}
          >
            看会话
          </Button>
        </span>
      ),
    },
  ];
  return (
    <Table<SegmentRunView>
      caption="每一笔"
      columns={columns}
      rows={d.segmentRuns}
      rowKey="id"
      empty="还没有哪一笔"
    />
  );
}
