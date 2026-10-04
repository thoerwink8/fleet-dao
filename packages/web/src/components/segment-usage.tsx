// 任务页的三段（对题 / 动手 / 验收）那几块：合计四格、按段每段再按模型的表、每一笔的明细（#216）。
// 数都是后端算好的（usage.bySegment、segmentRuns，算法在 shared 的 usage.ts、segment-runs.ts），这里只管怎么说：
// 读到的照数写；读到一部分照数写、写明几次没读到；全没读到写「没读到」，不写 0；每一笔没读到的原因原样列出来。
import type { SegmentKind, UsageTotals } from '@fleet-dao/shared';
import type { ReactNode } from 'react';
import type { Repo, TaskDetail } from '../api/types';
import { formatClock, formatCount, formatDateTime, formatDuration, formatUsd, span } from '../lib/format';
import {
  liveMs,
  noTierText,
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
import { Panel, Stat } from './page';
import { RepoLink } from './repo-link';
import { StatusChip } from './status';

/** 一项读数怎么写：全读到照写；读到一部分照写、写明几次没读到；全没读到写「没读到」；没有结束了的写 empty。 */
function Read({ r, empty = '—', children }: { r: Reading; empty?: ReactNode; children: ReactNode }) {
  if (r.kind === 'none') return <span className="text-muted-foreground">{empty}</span>;
  if (r.kind === 'missing') {
    return (
      <span className="font-medium text-ink-stall" data-unread>
        没读到
      </span>
    );
  }
  return (
    <>
      <span className="num">{children}</span>
      {r.kind === 'partial' ? (
        <span className="block text-caption text-ink-stall" data-partial>
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

/** 顶上四格：已用时、干活合计、输入当量、花费。和下面的表同一份合计（老流程的会话也算在里面）。 */
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
  // 值是「1 小时 26 分」「折合 $2.28」这种长串，按 28px 大字排：手机上一列一格、四格并排要到 xl 才放得下不折行
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        label={finished ? '总耗时' : '已用时'}
        value={formatDuration(wallMs(d, now))}
        hint={finished ? '从开单到最后一段收场' : '从开单算到现在'}
      />
      <Stat
        label="干活合计"
        value={
          work.kind === 'missing'
            ? '没读到'
            : work.kind === 'none' && !live
              ? '—'
              : formatDuration((work.kind === 'none' ? 0 : work.value) + live)
        }
        accent={work.kind === 'missing' ? 'text-ink-stall' : undefined}
        hint={
          missingNote(work, '耗时') ??
          (live ? `含在跑的 ${t.running} 段，算到现在` : work.kind === 'none' ? notYet : '各段起止加起来')
        }
      />
      <Stat
        label="输入当量"
        value={
          equivalent.kind === 'missing'
            ? '没读到'
            : equivalent.kind === 'none'
              ? '—'
              : formatCount(equivalent.value)
        }
        accent={equivalent.kind === 'missing' ? 'text-ink-stall' : undefined}
        hint={
          missingNote(equivalent, ' token ') ??
          (equivalent.kind === 'none' ? notYet : `按${EQUIVALENT_RULE}折`)
        }
      />
      <CostStat t={t} notYet={notYet} />
    </div>
  );
}

/** 花费一格：按量是真花的钱，放大写；没有按量的写套餐内折合；读不到的写明。 */
function CostStat({ t, notYet }: { t: UsageTotals; notYet: string }) {
  const { metered, subscription, unknown } = t.cost;
  const pick = metered.runs ? metered : subscription.runs ? subscription : unknown;
  const r = reading(pick.usd, pick.missing, pick.runs);
  const kind =
    pick === metered
      ? '按量（真花的钱）'
      : pick === subscription
        ? '套餐内，按 API 价折合'
        : '分不清按量、套餐内';
  const rest = [
    pick !== subscription && subscription.runs ? `套餐内折合 ${formatUsd(subscription.usd)}` : '',
    pick !== unknown && unknown.runs ? `分不清的 ${formatUsd(unknown.usd)}` : '',
  ].filter(Boolean);
  return (
    <Stat
      label="花费"
      value={
        r.kind === 'missing'
          ? '没读到'
          : r.kind === 'none'
            ? '—'
            : `${pick === subscription ? '折合 ' : ''}${formatUsd(r.value)}`
      }
      accent={r.kind === 'missing' ? 'text-ink-stall' : undefined}
      hint={
        r.kind === 'none'
          ? notYet
          : [kind, r.kind === 'partial' ? `另有 ${r.missing} 次没读到` : '', ...rest]
              .filter(Boolean)
              .join(' · ')
      }
    />
  );
}

/** 表的列：段（或模型）、次数、派工档、耗时、token、缓存、当量、花费。电脑上一行，手机上两列、每格带名字；表头和每行共用。 */
const COLUMNS = 'grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-12 md:items-baseline md:gap-y-0';
const ROW = cn('grid', COLUMNS);

function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-caption text-muted-foreground md:hidden">{label}</div>
      <div className="min-w-0 text-sub">{children}</div>
    </div>
  );
}

/** 花费那一格：按量、套餐内、分不清各一行（说法和 lib/usage 的 costParts 一样），读到一部分的另起一行写几次没读到。 */
function CostCell({ t }: { t: UsageTotals }) {
  const parts = costParts(t);
  if (!parts.length) return <span className="text-muted-foreground">{t.running ? '跑完才有' : '—'}</span>;
  return (
    <span className="flex flex-col">
      {parts.map((p) => (
        <span key={p.key} title={p.title}>
          {p.missing ? (
            <span className="text-ink-stall" data-unread>
              {p.label ? `${p.label} · ` : ''}
              {p.missing}
            </span>
          ) : (
            <span className="num">
              {p.label} {p.value}
              {p.unit ? <span className="text-caption text-muted-foreground"> {p.unit}</span> : null}
            </span>
          )}
          {p.incomplete ? (
            <span className="block text-caption text-ink-stall" data-partial>
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
      <Cell label="耗时" className="md:col-span-1">
        <Read r={work} empty={runningNote ?? '—'}>
          {formatDuration(work.kind === 'none' || work.kind === 'missing' ? 0 : work.value)}
        </Read>
        {runningNote && work.kind !== 'none' ? (
          <div className="text-caption text-ink-run">{runningNote}</div>
        ) : null}
      </Cell>
      <Cell label="token（输入 / 输出）" className="md:col-span-2">
        <Read
          r={reading(t.inputTokens + t.outputTokens, t.missingTokens, t.runs)}
          empty={t.running ? '跑完才有' : '—'}
        >
          {formatCount(t.inputTokens)} / {formatCount(t.outputTokens)}
        </Read>
      </Cell>
      <Cell label="缓存（读 / 写）" className="md:col-span-2">
        <Read
          r={reading(t.cacheReadTokens + t.cacheWriteTokens, t.missingCache, t.runs)}
          empty={t.running ? '跑完才有' : '—'}
        >
          {formatCount(t.cacheReadTokens)} / {formatCount(t.cacheWriteTokens)}
        </Read>
      </Cell>
      <Cell label="当量" className="md:col-span-1">
        <Read
          r={reading(t.inputEquivalent, t.missingEquivalent, t.runs)}
          empty={t.running ? '跑完才有' : '—'}
        >
          {formatCount(t.inputEquivalent)}
        </Read>
      </Cell>
      <Cell label="花费" className="md:col-span-2">
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

/** 一段的那一行，加它下面按模型的几行；只用了一个模型的，模型名写在段名旁边，不再重复一行同样的数。 */
function SegmentGroup({ s, live }: { s: SegmentTotals; live: (model?: string) => number | undefined }) {
  const tier = tierText(s.segment, s);
  const only = s.byModel.length === 1 ? s.byModel[0] : undefined;
  return (
    <li className="py-3" data-segment={s.segment ?? 'unknown'}>
      <div className={ROW}>
        <div className="col-span-2 min-w-0 md:col-span-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className={cn('font-medium', s.segment === null && 'text-ink-stall')}>
              {s.segment ? segmentLabel[s.segment] : UNKNOWN_SEGMENT}
            </span>
            {only ? (
              <span
                className="num min-w-0 truncate text-sub text-muted-foreground"
                title={only.model}
                data-model={only.model}
              >
                {only.modelName}
              </span>
            ) : null}
          </div>
          <div className="text-caption text-muted-foreground">
            {s.segment ? segmentHint[s.segment] : '原样写在下面每一笔里'}
          </div>
          {s.segment && SEGMENT_UNMETERED[s.segment] ? (
            <div className="text-caption text-muted-foreground" data-unmetered={s.segment}>
              {SEGMENT_UNMETERED[s.segment]?.partial}
            </div>
          ) : null}
        </div>
        <Cell label="次数" className="md:col-span-1">
          <span className="num">{timesText(s)}</span>
        </Cell>
        <Cell label="派工档" className="md:col-span-1">
          <span
            className={cn(
              tier.missing ? 'font-medium text-ink-stall' : !s.tiers.length && 'text-muted-foreground',
            )}
          >
            {tier.text}
          </span>
          {tier.note ? <div className="text-caption text-ink-stall">{tier.note}</div> : null}
        </Cell>
        <Figures t={s} live={live()} />
      </div>
      {s.byModel.length > 1 ? (
        <ul className="mt-2 space-y-2">
          {s.byModel.map((m) => (
            <li key={m.model} className={ROW} data-model={m.model}>
              <div className="col-span-2 min-w-0 border-l-2 pl-2 md:col-span-2">
                <span className="num block truncate text-sub" title={m.model}>
                  {m.modelName}
                </span>
              </div>
              <Cell label="次数" className="md:col-span-1">
                <span className="num text-muted-foreground">{timesText(m)}</span>
              </Cell>
              <div className="hidden md:col-span-1 md:block" />
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
  return (
    <Panel
      title="三段"
      description="对题 → 动手 → 验收，每段再按模型分。写「没读到」的格子，原因在下面「每一笔」里逐笔写着；不当成 0。"
      bodyClassName="px-4 py-1"
    >
      <div
        className={cn('hidden md:grid', COLUMNS, 'border-b py-2 text-caption text-muted-foreground')}
        aria-hidden
      >
        <span className="md:col-span-2">段 / 模型</span>
        <span className="md:col-span-1">次数</span>
        <span className="md:col-span-1">派工档</span>
        <span className="md:col-span-1">耗时</span>
        <span className="md:col-span-2">token（输入 / 输出）</span>
        <span className="md:col-span-2">缓存（读 / 写）</span>
        <span className="md:col-span-1">当量</span>
        <span className="md:col-span-2">花费</span>
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
                  <span className="text-sub text-muted-foreground">{unmetered.short}</span>
                  <span className="w-full text-caption text-muted-foreground">{unmetered.why}</span>
                </li>
              );
            }
            return (
              <li key={segment} className="flex flex-wrap items-baseline gap-x-3 py-3" data-segment={segment}>
                <span className="font-medium text-muted-foreground">{segmentLabel[segment]}</span>
                <span className="text-sub text-muted-foreground">没有这一段的记录</span>
              </li>
            );
          }
          return <SegmentGroup key={segment} s={s} live={liveOf(segment)} />;
        })}
        {unknown ? <SegmentGroup s={unknown} live={liveOf(null)} /> : null}
      </ul>
    </Panel>
  );
}

/** 一笔的段：认不出的用提醒色写「段名认不出」。 */
function SegmentTag({ segment }: { segment: SegmentKind | null }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded border px-1.5 text-caption font-medium',
        segment === null && 'border-st-stall/55 text-ink-stall',
      )}
    >
      {segment ? segmentLabel[segment] : UNKNOWN_SEGMENT}
    </span>
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
  if (run.memoryPeakMb !== undefined) parts.push(`内存峰值 ${formatCount(run.memoryPeakMb)} MB`);
  return parts;
}

function RunRow({ run, repo, now }: { run: SegmentRunView; repo: Repo; now: number }) {
  const live = liveMs(run, now);
  const timeUnread = run.unread.some((n) => n.item === 'time');
  const figures = runFigures(run);
  return (
    <li className="py-3" data-run={run.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SegmentTag segment={run.segment} />
        <span className="num text-sub font-medium">{run.modelName}</span>
        {run.tier ? (
          <span className="text-caption text-muted-foreground">{tierLabel[run.tier]}</span>
        ) : run.segment && run.segment !== 'manual' ? (
          <span className="text-caption text-muted-foreground">{noTierText[run.segment]}</span>
        ) : null}
        {run.running ? (
          <StatusChip tone="run" label="在跑" />
        ) : run.outcome ? (
          <StatusChip tone={segmentOutcomeTone[run.outcome]} label={segmentOutcomeLabel[run.outcome]} />
        ) : (
          <StatusChip tone="stall" label="结局没读到" />
        )}
        {run.matchedBy === 'issueNumber' ? (
          <span
            className="inline-flex h-5 items-center rounded border border-dashed px-1.5 text-caption text-muted-foreground"
            title="这一笔没记 task_id，是按单号对上的；单号在几个仓里可能重"
          >
            按单号兜底
          </span>
        ) : null}
        <span className="num w-full text-caption text-muted-foreground sm:ml-auto sm:w-auto">
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
          ) : timeUnread ? (
            <span className="text-ink-stall">耗时没读到</span>
          ) : (
            '—'
          )}
        </span>
      </div>
      {figures.length || run.prNumber !== undefined || run.branch ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-muted-foreground">
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
              className="num underline-offset-2 hover:underline"
            >
              PR #{run.prNumber}
            </RepoLink>
          ) : null}
          {run.branch ? <span className="num truncate">{run.branch}</span> : null}
        </div>
      ) : null}
      {run.failureReason ? (
        <p className="mt-1 text-caption text-muted-foreground">为什么没成：{run.failureReason}</p>
      ) : null}
      {run.unread.length ? (
        <ul className="mt-1 space-y-0.5" aria-label="没读到的">
          {run.unread.map((n) => (
            <li key={n.item} className="text-caption text-ink-stall" data-unread-item={n.item}>
              <span className="font-medium">{unreadItemLabel[n.item]}</span> · {n.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 每一笔：按起跑先后，段、模型、派工档、结局、起止和耗时、用量、PR；按单号兜底对上的、没读到的都写明。 */
export function SegmentRunList({ d, now }: { d: TaskDetail; now: number }) {
  return (
    <Panel
      title="每一笔"
      description="三段每跑一次一笔，按起跑先后。没记 task_id、按单号对上的标「按单号兜底」；没读到的写明为什么。"
      bodyClassName="px-4 py-1"
    >
      <ol className="divide-y">
        {d.segmentRuns.map((run) => (
          <RunRow key={run.id} run={run} repo={d.repo} now={now} />
        ))}
      </ol>
    </Panel>
  );
}
