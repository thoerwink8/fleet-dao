// 任务详情的「时间与用量」和会话时间线里的用量那几段。数都出自 shared 的 summarizeUsage（任务用后端算好的
// usage，一次会话用 lib/usage 的 runUsage 现算）；还在跑的会话只把排队、干活时长算到现在加上去，用量要等它结束才有。
// 读到的照数写；有没读到的标「不全」、写明几次；全没读到写「没读到」，不写 0（说法在 lib/usage.ts）。
// 尺寸 token：不全标 text-micro（10px）；说明、花费明细、分开看、额度提示 text-caption（11px）；花费行 grid-cols-usage（标签 3.5rem、剩余）。
import type { UsageTotals } from '@fleet-dao/shared';
import { type ReactNode, useState } from 'react';
import type { Run, TaskDetail } from '../api/types';
import { stageLabel } from '../lib/catalog';
import { formatCount, formatDuration, formatUsd, span } from '../lib/format';
import { isTaskFinished, queueMs, workMs } from '../lib/status';
import { EQUIVALENT_RULE, groupParts, type Reading, reading, type UsagePart } from '../lib/usage';
import { cn } from '../lib/utils';
import { Panel } from './page';

/** 「不全」小标：这个合计只加了读到的那几次。 */
function Incomplete() {
  return (
    <span className="rounded border border-st-stall/50 px-1 text-micro leading-4 font-medium text-ink-stall">
      {/* 原 10px，text-micro */}
      不全
    </span>
  );
}

/** 一段用量：「当量 38.5 万」「套餐内 · 花费没读到」「按量 $0.04（不全：1 次没读到）」。 */
function UsagePartView({ p }: { p: UsagePart }) {
  return (
    <span title={p.title}>
      {p.label ? <span>{p.label}</span> : null}
      {p.value ? (
        <span className="num text-foreground">
          {p.label ? ' ' : ''}
          {p.value}
        </span>
      ) : null}
      {p.unit ? <span>{p.unit.startsWith('（') ? p.unit : ` ${p.unit}`}</span> : null}
      {p.missing ? (
        <span className="text-ink-stall">
          {p.label ? ' · ' : ''}
          {p.missing}
        </span>
      ) : null}
      {p.incomplete ? <span className="text-ink-stall">（不全：{p.incomplete} 次没读到）</span> : null}
    </span>
  );
}

export function UsageParts({ parts }: { parts: UsagePart[] }) {
  return (
    <>
      {parts.map((p) => (
        <UsagePartView key={p.key} p={p} />
      ))}
    </>
  );
}

/** 还在跑的会话把时长算到现在加上：结束了的那部分还是 usage 里的，读不到的照样算「不全」。 */
function withLive(r: Reading, liveMs: number, live: number): Reading {
  if (!live) return r;
  switch (r.kind) {
    case 'none':
      return { kind: 'full', value: liveMs };
    case 'full':
      return { kind: 'full', value: r.value + liveMs };
    case 'partial':
      return { kind: 'partial', value: r.value + liveMs, missing: r.missing };
    case 'missing':
      return { kind: 'partial', value: liveMs, missing: r.missing };
  }
}

/**
 * 一项合计。全读到照数写；读到一部分照数写、标「不全」、写明另有几次没读到；全没读到写「没读到」；
 * 一次结束了的会话都没有写 empty（这不是没读到）。
 */
function Total({
  label,
  r,
  children,
  empty,
  why = '没读到',
  note,
  big,
  className,
}: {
  label: string;
  r: Reading;
  /** 读到的数怎么写（全读到、读到一部分时）。 */
  children: ReactNode;
  empty: string;
  /** 没算进来的那几次是怎么了。 */
  why?: string;
  note?: string | undefined;
  big?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {r.kind === 'partial' ? <Incomplete /> : null}
      </dt>
      <dd className={cn('mt-0.5', big ? 'text-lg font-semibold' : 'font-medium')}>
        {r.kind === 'full' || r.kind === 'partial' ? (
          <span className="num">{children}</span>
        ) : r.kind === 'missing' ? (
          <span className="text-ink-stall">没读到</span>
        ) : (
          <span className="text-sm font-normal text-muted-foreground">{empty}</span>
        )}
        {r.kind === 'partial' ? (
          <p className="mt-0.5 text-caption font-normal text-ink-stall">
            {/* 原 11px，text-caption */}
            另有 {r.missing} 次{why}，没算进来
          </p>
        ) : null}
        {r.kind === 'missing' ? (
          <p className="mt-0.5 text-caption font-normal text-ink-stall">
            {/* 原 11px，text-caption */}
            {r.missing} 次会话都{why}
          </p>
        ) : null}
        {note ? (
          <p className="mt-0.5 text-caption font-normal text-muted-foreground">
            {/* 原 11px，text-caption */}
            {note}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 border-t pt-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** 一种计费方式的花费：读到的照数写，没读到的写明几次。 */
function CostRow({
  label,
  share,
  prefix = '',
  hint,
  empty,
}: {
  label: string;
  share: UsageTotals['cost']['metered'];
  prefix?: string;
  hint: string;
  empty?: string;
}) {
  const r = reading(share.usd, share.missing, share.runs);
  return (
    <div className="grid grid-cols-usage gap-x-2">
      {/* 原标签列 3.5rem，grid-cols-usage */}
      <dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">
        {r.kind === 'none' ? (
          <span className="text-muted-foreground">{empty}</span>
        ) : r.kind === 'missing' ? (
          <span className="font-medium text-ink-stall">没读到</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="num font-medium">
              {prefix}
              {formatUsd(r.value)}
            </span>
            {r.kind === 'partial' ? <Incomplete /> : null}
          </span>
        )}
        {r.kind !== 'none' ? (
          <p className="text-caption text-muted-foreground">
            {/* 原 11px，text-caption */}
            {r.kind === 'partial' ? (
              <span className="text-ink-stall">另有 {r.missing} 次没读到，没算进来 · </span>
            ) : null}
            {r.kind === 'missing' ? (
              <span className="text-ink-stall">{r.missing} 次会话都没读到 · </span>
            ) : null}
            <span className="num">{share.runs}</span> 个会话 · {hint}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

function Costs({ t }: { t: UsageTotals }) {
  if (!t.runs) {
    return <p className="text-sm text-muted-foreground">{t.running ? '会话结束后才有数' : '还没有会话'}</p>;
  }
  const { metered, subscription, unknown } = t.cost;
  return (
    <dl className="space-y-2">
      <CostRow
        label="按量"
        share={metered}
        hint="真花的钱"
        empty={unknown.runs ? '查得到渠道的会话里没有按量的' : '没有走按量的会话'}
      />
      {subscription.runs ? (
        <CostRow label="套餐内" share={subscription} prefix="折合 " hint="按 API 价折合，不另花钱" />
      ) : null}
      {unknown.runs ? (
        <CostRow label="分不清" share={unknown} hint="渠道查不到，分不清按量还是套餐内" />
      ) : null}
    </dl>
  );
}

type GroupBy = 'model' | 'stage';

/** 按模型、按阶段各一行：会话数、干活时长、当量、花费。 */
function Breakdown({ usage }: { usage: TaskDetail['usage'] }) {
  const [by, setBy] = useState<GroupBy>('model');
  const rows =
    by === 'model'
      ? usage.byModel.map((m) => ({ key: m.model, name: m.modelName, mono: true, t: m }))
      : usage.byStage.map((s) => ({ key: s.stage, name: stageLabel[s.stage], mono: false, t: s }));
  if (!usage.byModel.length) return null;
  const choice = (id: GroupBy, text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={by === id}
      onClick={() => setBy(id)}
      className={cn(
        'rounded px-2 py-0.5 transition-colors',
        by === id ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {text}
    </button>
  );
  return (
    <section className="mt-4 border-t pt-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">分开看</h3>
        <div role="tablist" aria-label="按什么分开看" className="flex rounded-md bg-muted p-0.5 text-xs">
          {choice('model', '按模型')}
          {choice('stage', '按阶段')}
        </div>
      </div>
      <ul className="divide-y">
        {rows.map((row) => {
          const parts = groupParts(row.t);
          return (
            <li key={row.key} className="py-2">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className={cn('min-w-0 truncate font-medium', row.mono && 'num')}>{row.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.t.runs ? (
                    <>
                      <span className="num">{row.t.runs}</span> 个会话
                    </>
                  ) : null}
                  {row.t.runs && row.t.running ? ' · ' : ''}
                  {row.t.running ? (
                    <>
                      <span className="num">{row.t.running}</span> 个在跑
                    </>
                  ) : null}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-caption text-muted-foreground">
                {/* 原 11px，text-caption */}
                {parts.length ? <UsageParts parts={parts} /> : <span>在跑，用量等它结束才有</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 任务详情右栏的「时间与用量」。 */
export function UsagePanel({ d, now }: { d: TaskDetail; now: number }) {
  const t = d.usage.total;
  const live: Run[] = d.runs.filter((r) => !r.endedAt);
  const liveQueue = live.reduce((n, r) => n + queueMs(r, now), 0);
  const liveWork = live.reduce((n, r) => n + workMs(r, now), 0);
  // 做完的需求算到最后一个会话结束；契约里没有「做完的时刻」。
  const lastEnd = d.runs.reduce<string | undefined>(
    (m, r) => (r.endedAt && (!m || r.endedAt > m) ? r.endedAt : m),
    undefined,
  );
  const finished = isTaskFinished(d.task);
  const wall = span(d.task.createdAt, finished ? lastEnd : undefined, now);
  const liveNote = live.length ? `含在跑的 ${live.length} 个，算到现在` : undefined;
  const noRuns = t.running ? '会话结束后才有数' : '还没有会话';
  const sessionNote = [t.running ? `${t.running} 个在跑` : '', t.notStarted ? `${t.notStarted} 个没起来` : '']
    .filter(Boolean)
    .join(' · ');
  const tokens = reading(t.inputTokens + t.outputTokens, t.missingTokens, t.runs);
  const cache = reading(t.cacheReadTokens + t.cacheWriteTokens, t.missingCache, t.runs);
  // 三段的 runs 不记排队（noQueue）：排队合计把它们算作没读到，不当成排了 0 秒
  const queue = withLive(reading(t.queueMs, t.missingTime + t.noQueue, t.runs), liveQueue, live.length);
  const work = withLive(reading(t.runMs, t.missingTime, t.runs), liveWork, live.length);
  return (
    <Panel title="时间与用量" description="排队和干活分开算；读不到的写明几次没读到，不当成 0。">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Total label={finished ? '总耗时' : '已用时'} r={{ kind: 'full', value: wall }} empty="">
          {formatDuration(wall)}
        </Total>
        <Total
          label="会话"
          r={{ kind: 'full', value: t.runs + t.running }}
          empty=""
          note={sessionNote || undefined}
        >
          {t.runs + t.running} 个
        </Total>
        <Total
          label="排队合计"
          r={queue}
          empty={noRuns}
          why={t.noQueue ? '时刻认不出或没记排队' : '时刻认不出'}
          note={liveNote}
        >
          {queue.kind === 'full' || queue.kind === 'partial' ? formatDuration(queue.value) : null}
        </Total>
        <Total label="干活合计" r={work} empty={noRuns} why="时刻认不出" note={liveNote}>
          {work.kind === 'full' || work.kind === 'partial' ? formatDuration(work.value) : null}
        </Total>
      </dl>

      <Section title="额度">
        {t.running && t.runs ? (
          <p className="mb-2 text-caption text-muted-foreground">
            {/* 原 11px，text-caption */}
            另有 {t.running} 个会话在跑：用量等它结束才算进来。
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Total
            label="输入当量"
            r={reading(t.inputEquivalent, t.missingEquivalent, t.runs)}
            empty={noRuns}
            note={t.runs ? `额度按它比：各家 token 按${EQUIVALENT_RULE} 折算` : undefined}
            big
            className="col-span-2"
          >
            {formatCount(t.inputEquivalent)}
          </Total>
          <Total label="token" r={tokens} empty={noRuns}>
            <span className="block">输入 {formatCount(t.inputTokens)}</span>
            <span className="block">输出 {formatCount(t.outputTokens)}</span>
          </Total>
          <Total label="缓存" r={cache} empty={noRuns}>
            <span className="block">读 {formatCount(t.cacheReadTokens)}</span>
            <span className="block">写 {formatCount(t.cacheWriteTokens)}</span>
          </Total>
        </dl>
      </Section>

      <Section title="花费">
        <Costs t={t} />
      </Section>

      <Breakdown usage={d.usage} />
    </Panel>
  );
}
