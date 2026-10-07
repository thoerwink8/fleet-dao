// 一台环境的六项事实（引擎、在跑的会话、池占用、健康、在用版本、最近拉单）怎么画：法国页和环境页共用这一份。
// 原来两页各抄了一遍 TileHead / NotRead / Read / engineWords（#618、#820 片 1），版式一改就要改两处。
//
// 规矩（照搬原来两页，见 specs/820-驾驶舱环境视图与中止恢复/方案.md §5 片 1）：
// - 后端逐项包好「查成了 / 没查成」，这里只把两态如实画：没查成整格写「没查成 + 原因」，不拿空或 0 顶；一项读失败不连累别的项；
// - 等待色（黄系）和「真坏了」的红分开：引擎按配置没开、落后主线、从没跑成是等情况，不画红；没连上、健康红、上次失败才红。
//
// 版式（驾驶舱改版 2026-10-07）：值和一句白话写在同一格里，格子矮（约 70px），六格在 1920 屏一行排完、1366 屏两行排完；
// 原来每格是 28px 大字的高卡片，六格竖着堆满一屏，宽屏只用了上半。

import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  CalendarClock,
  CircleChevronDown,
  CircleDashed,
  Gauge,
  HeartPulse,
  Power,
  Tag,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { EnvEngine, EnvFacts, EnvSchedule, EnvVersion } from '../api/types';
import { stageLabel } from '../lib/catalog';
import { formatAgo, formatDateTime } from '../lib/format';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';

const TONE_CLASS: Record<Tone, string> = {
  done: 'text-ink-done',
  run: 'text-ink-run',
  wait: 'text-ink-wait',
  human: 'text-ink-human',
  stall: 'text-ink-stall',
  fail: 'text-ink-fail',
  stop: 'text-ink-stop',
};

/** 挂在每格上的数据属性：法国页叫 data-france-fact、环境页叫 data-env-fact（测试按它找格子）。 */
export type FactKind = 'env' | 'france';
/** tile = 独立的卡片（法国页一行六张）；row = 环境页一列里的一行（上边线分隔）。 */
export type FactLook = 'tile' | 'row';

type Head = { label: string; hint: string; icon: LucideIcon };

function FactHead({ label, hint, icon: Icon }: Head) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate opacity-80">· {hint}</span>
    </span>
  );
}

function shell(kind: FactKind, state: 'ok' | 'unread', look: FactLook, extra?: string) {
  return {
    [`data-${kind}-fact`]: state,
    className: cn(
      'min-w-0',
      look === 'tile' ? 'rounded-xl border bg-card px-4 py-3' : 'border-t px-4 py-3',
      look === 'tile' && state === 'ok' && 'shadow-card-edge',
      look === 'tile' && state === 'unread' && 'border-dashed',
      extra,
    ),
  };
}

/** 没查成的一格：明说原因，等待色虚线（不是红、不是 0）。 */
function NotRead({ kind, look, reason, ...head }: Head & { kind: FactKind; look: FactLook; reason: string }) {
  return (
    <div {...shell(kind, 'unread', look, 'text-muted-foreground')}>
      <FactHead {...head} />
      <div className={look === 'row' ? 'mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5' : 'mt-1.5'}>
        <div className="flex items-center gap-1.5">
          <CircleDashed className="size-4 shrink-0 text-ink-stall" aria-hidden />
          <span className="text-title leading-tight font-semibold tracking-tight text-ink-stall">没查成</span>
        </div>
        <p className={cn('text-xs', look === 'tile' && 'mt-1')}>{reason}</p>
      </div>
    </div>
  );
}

/** 查成了的一格：值 + 一句白话；tone 只给真正要提醒的那几种。 */
function Read({
  kind,
  look,
  value,
  sub,
  tone,
  children,
  ...head
}: Head & {
  kind: FactKind;
  look: FactLook;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone | undefined;
  children?: ReactNode;
}) {
  return (
    <div {...shell(kind, 'ok', look)}>
      <FactHead {...head} />
      {/* 一列一行（环境页）时值和白话并在一行，行矮一半；独立卡片（法国页）时上下两行 */}
      <div className={look === 'row' ? 'mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5' : 'mt-1.5'}>
        <div
          className={cn(
            'num text-title leading-tight font-semibold tracking-tight',
            look === 'tile' && 'truncate',
            tone ? TONE_CLASS[tone] : undefined,
          )}
        >
          {value}
        </div>
        {sub ? (
          <div className={cn('text-xs text-muted-foreground', look === 'tile' && 'mt-1')}>{sub}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** 引擎：on / off（按配置没开）/ down（真没连上）/ unknown（没查成）四态各说各的。 */
export function engineWords(e: EnvEngine): { value: string; sub: string; tone: Tone | undefined } {
  switch (e.state) {
    case 'on':
      return { value: '在跑', sub: e.detail ?? '探到了在拉活的工人', tone: 'done' };
    case 'off':
      return { value: '按配置没开', sub: e.detail ?? '按 release.env 的 FLEET_SERVICES 没开', tone: 'stall' };
    case 'down':
      return { value: '没连上', sub: e.detail ?? '开着却探不到在线的工人', tone: 'fail' };
    case 'unknown':
      return { value: '没查成', sub: e.detail ?? '这台后端没有接引擎探针', tone: 'wait' };
  }
}

function versionTone(v: EnvVersion): Tone {
  if (v.current === null || v.problems.length > 0) return 'stall';
  if (v.behind === null || v.behind > 0) return 'wait';
  return 'done';
}

function scheduleTone(v: EnvSchedule): Tone {
  if (v.status === 'never') return 'wait';
  if (v.outcome === 'failed') return 'fail';
  if (v.status !== 'fresh' || v.outcome === 'unscanned' || v.outcome === 'partial') return 'stall';
  return 'done';
}

const HEADS = {
  engine: { label: '引擎', hint: '在拉活的工人有没有', icon: Power },
  sessions: { label: '在跑的会话', hint: '几个、各在哪一段', icon: Activity },
  pools: { label: '池占用', hint: '几块池、在跑合计', icon: Gauge },
  health: { label: '健康', hint: '几项红、哪几项', icon: HeartPulse },
  version: { label: '在用版本', hint: '落后主线没有', icon: Tag },
  schedule: { label: '最近拉单', hint: '引擎上一轮拉单成没成', icon: CalendarClock },
} satisfies Record<string, Head>;

/**
 * 六格，按固定先后（引擎、会话、池、健康、版本、拉单）一格一个元素返回；外层决定怎么排（法国页一行六格、环境页一列六行用 subgrid 对齐）。
 * jobCount：最近拉单「从没跑成」时顺带写一共几个定时任务（法国页有这份数）。
 */
export function factCells({
  facts,
  now,
  kind,
  look,
  jobCount,
}: {
  facts: EnvFacts;
  now: number;
  kind: FactKind;
  look: FactLook;
  jobCount?: number | undefined;
}): ReactNode[] {
  const base = { kind, look };
  const cells: ReactNode[] = [];

  if (facts.engine.ok) {
    const w = engineWords(facts.engine.value);
    cells.push(<Read key="engine" {...base} {...HEADS.engine} value={w.value} sub={w.sub} tone={w.tone} />);
  } else cells.push(<NotRead key="engine" {...base} {...HEADS.engine} reason={facts.engine.reason} />);

  if (facts.sessions.ok) {
    const s = facts.sessions.value;
    cells.push(
      <Read
        key="sessions"
        {...base}
        {...HEADS.sessions}
        value={s.total}
        sub={
          s.total === 0
            ? '手上没有在跑的会话'
            : Object.entries(s.byStage)
                .map(([k, n]) => `${stageLabel[k as keyof typeof stageLabel] ?? k} ${n}`)
                .join(' · ')
        }
      />,
    );
  } else cells.push(<NotRead key="sessions" {...base} {...HEADS.sessions} reason={facts.sessions.reason} />);

  if (facts.pools.ok) {
    const p = facts.pools.value;
    cells.push(
      <Read
        key="pools"
        {...base}
        {...HEADS.pools}
        value={`${p.count} 块`}
        sub={`在跑 ${p.running} · 没读成 ${p.unread} · 过期 ${p.stale}`}
        tone={p.unread > 0 || p.stale > 0 ? 'stall' : undefined}
      />,
    );
  } else cells.push(<NotRead key="pools" {...base} {...HEADS.pools} reason={facts.pools.reason} />);

  if (facts.health.ok) {
    const h = facts.health.value;
    cells.push(
      <Read
        key="health"
        {...base}
        {...HEADS.health}
        value={h.failing.length === 0 ? '没红的' : `${h.failing.length} 项红`}
        sub={
          h.failing.length === 0
            ? `${h.total} 项都通；未接 ${h.notWired.length} 项`
            : `红：${h.failing.join('、')}`
        }
        tone={h.failing.length > 0 ? 'fail' : undefined}
      />,
    );
  } else cells.push(<NotRead key="health" {...base} {...HEADS.health} reason={facts.health.reason} />);

  if (facts.version.ok) {
    const v = facts.version.value;
    cells.push(
      <Read
        key="version"
        {...base}
        {...HEADS.version}
        value={v.current === null ? '没查成' : v.current.slice(0, 12)}
        sub={v.detail}
        tone={versionTone(v)}
      >
        {v.behind !== null && v.behind > 0 && !v.detail?.includes('落后主线') ? (
          <p className="mt-1 text-xs text-ink-stall">落后主线 {v.behind} 个提交</p>
        ) : null}
        {v.problems.length ? (
          <ul className="mt-1 space-y-0.5 text-xs text-ink-stall">
            {v.problems.map((p) => (
              <li key={p} className="flex gap-1.5">
                <CircleChevronDown className="mt-0.5 size-3 shrink-0" aria-hidden />
                <span className="min-w-0">{p}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Read>,
    );
  } else cells.push(<NotRead key="version" {...base} {...HEADS.version} reason={facts.version.reason} />);

  if (facts.schedule.ok) {
    const v = facts.schedule.value;
    cells.push(
      <Read
        key="schedule"
        {...base}
        {...HEADS.schedule}
        value={
          v.status === 'never'
            ? '从没跑成'
            : v.lastSuccessAt
              ? formatAgo(v.lastSuccessAt, now)
              : '没查到上次跑成的时间'
        }
        tone={scheduleTone(v)}
        sub={
          v.status === 'never'
            ? jobCount !== undefined
              ? `这个环境还没有拉单记录（共 ${jobCount} 个定时任务，拉到才算）`
              : '这个环境还没有拉单记录'
            : v.why
              ? v.why
              : v.outcome === undefined
                ? '上次这一轮还没有结局'
                : `上次结局：${v.outcome}${v.scanned === undefined ? '' : `，扫了 ${v.scanned} 个`}`
        }
      >
        {v.lastSuccessAt ? (
          <div className="num mt-0.5 text-caption text-faint">
            最近一次跑成：{formatDateTime(v.lastSuccessAt)}
          </div>
        ) : null}
      </Read>,
    );
  } else cells.push(<NotRead key="schedule" {...base} {...HEADS.schedule} reason={facts.schedule.reason} />);

  return cells;
}

/** 六项里几项没查成、健康几项红：列头上的一行小结。 */
export function factsSummary(facts: EnvFacts): ReactNode {
  const failing = facts.health.ok ? facts.health.value.failing.length : undefined;
  const unread = [
    facts.engine,
    ...(facts.master ? [facts.master] : []),
    facts.version,
    facts.sessions,
    facts.pools,
    facts.health,
    facts.schedule,
  ].filter((f) => !f.ok).length;
  if (!unread && !failing) return null;
  return (
    <>
      {unread > 0 ? <span className="text-ink-stall">{unread} 项没查成</span> : null}
      {unread > 0 && failing ? ' · ' : null}
      {failing ? <span className="text-ink-fail">健康 {failing} 项红</span> : null}
    </>
  );
}

/** 六格的行数：环境页按它给每一列划 subgrid 行。 */
export const FACT_ROWS = 6;
