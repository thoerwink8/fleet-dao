// 一台环境的六项事实（引擎、在跑的会话、池占用、健康、在用版本、最近拉单）怎么画：法国页的本台和对照列共用这一份。
//
// 规矩（照搬原来两页，见 specs/820-驾驶舱环境视图与中止恢复/方案.md §5 片 1）：
// - 后端逐项包好「查成了 / 没查成」，这里只把两态如实画：没查成写「没查成 + 原因」，不拿空或 0 顶；一项读失败不连累别的项；
// - 等待色（黄系）和「真坏了」的红分开：引擎按配置没开、落后主线、从没跑成是等情况，不画红；没连上、健康红、上次失败才红。
//
// 版式（路由页样板 #1914 铺开）：一项一行——名字和一个状态在第一行（状态在右），一句白话的灰字在第二行，
// 挂在这一项底下的东西（发布入口、总开关说明、版本问题）接在灰字下面、和名字对齐。层级靠字重和灰度，不再用 22px 的彩色大字。
// 每项的小标题（「落后主线几个提交」）在名字的悬停和读屏里。手机上本台六项（tile）各收成一行，点开才看灰字和挂件（#1820）。

import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  CalendarClock,
  ChevronDown,
  CircleChevronDown,
  Gauge,
  HeartPulse,
  Power,
  Tag,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { EnvEngine, EnvFacts, EnvSchedule, EnvVersion } from '../api/types';
import { stageLabel } from '../lib/catalog';
import { formatAgo, formatDateTime } from '../lib/format';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';
import { RowFrame } from './layout/list';
import { StatusBadge, StatusDot } from './layout/status-badge';

/** 挂在每格上的数据属性：本台单独画时叫 data-france-fact、对照列里叫 data-env-fact（测试按它找格子）。 */
export type FactKind = 'env' | 'france';
/** tile = 本台单独画（法国页只有一台时，一个区块里的一行；手机上折成一行）；row = 对照列里的一行（上边线分隔，手机也不折）。 */
export type FactLook = 'tile' | 'row';

type Head = { label: string; hint: string; icon: LucideIcon };

/** 名字：小标题收进悬停和读屏，不另占一行。 */
function FactLabel({ label, hint }: Head) {
  return (
    <span className="min-w-0 truncate text-body font-medium" title={hint}>
      {label}
      <span className="sr-only">（{hint}）</span>
    </span>
  );
}

/**
 * 一行右边的那个状态：有状态色的走 StatusBadge（点加字）；没有状态色的（会话个数、几块池）写成普通的字；
 * 失联列（muted）一律灰色小字、不带状态色，别让旧的「在跑」「N 项红」看起来像现在的状态。
 */
function FactValue({
  value,
  tone,
  muted,
  mono,
  title,
}: {
  value: string | number;
  tone?: Tone | undefined;
  muted?: boolean | undefined;
  mono?: boolean | undefined;
  title?: string | undefined;
}) {
  if (muted) {
    return (
      <span data-fact-value title={title} className="num shrink-0 text-body text-muted-foreground">
        {value}
      </span>
    );
  }
  if (tone) {
    return (
      <span data-fact-value title={title} className="shrink-0">
        <StatusBadge
          tone={tone}
          label={String(value)}
          variant="dot"
          className={cn('num text-body', mono && 'font-mono')}
        />
      </span>
    );
  }
  return (
    <span data-fact-value title={title} className="num shrink-0 text-body font-medium">
      {value}
    </span>
  );
}

/** 一项的外框：数据属性挂在这里（测试按 data-env-fact / data-france-fact 找格子）。对照列里的行带上边线，本台的由外面的列表分隔。 */
function FactShell({
  kind,
  state,
  look,
  children,
  ...rest
}: {
  kind: FactKind;
  state: 'ok' | 'unread';
  look: FactLook;
  children: ReactNode;
  'data-fact-folded'?: 'open' | 'closed';
}) {
  const attr = { [`data-${kind}-fact`]: state };
  return (
    <div {...attr} {...rest} className={cn('min-w-0', look === 'row' && 'border-t')}>
      {children}
    </div>
  );
}

/** 一行（桌面、对照列）：名字 + 状态一行，灰字一行，挂件接在下面、和名字对齐。 */
function FactRow({
  head,
  value,
  sub,
  children,
}: {
  head: Head;
  value: ReactNode;
  sub?: string | undefined;
  children?: ReactNode;
}) {
  const Icon = head.icon;
  return (
    <RowFrame tall className="items-start">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5 min-w-0 items-center justify-between gap-3 whitespace-nowrap">
          <FactLabel {...head} />
          {value}
        </div>
        {sub ? (
          // 桌面一行截断、整句在悬停里；手机没有悬停，照常折行
          <p className="text-meta text-muted-foreground md:truncate" title={sub}>
            {sub}
          </p>
        ) : null}
        {children ? <div className="mt-1.5 mb-1">{children}</div> : null}
      </div>
    </RowFrame>
  );
}

/**
 * 手机上本台六项一行一项（#1820）：名字 · 状态点 · 一句话，点开才看完整的灰字和挂件。
 * 两列各六格在 390 宽占了法国页大半的长度；一行一项六行就看完，要细节再点开。
 */
function FoldedFact({
  kind,
  state,
  head,
  tone,
  summary,
  sub,
  children,
}: {
  kind: FactKind;
  state: 'ok' | 'unread';
  head: Head;
  tone: Tone;
  summary: ReactNode;
  sub?: string | undefined;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = head.icon;
  return (
    <FactShell kind={kind} state={state} look="tile" data-fact-folded={open ? 'open' : 'closed'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-body whitespace-nowrap"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <FactLabel {...head} />
        <StatusDot tone={tone} className="ml-1" />
        <span className="num min-w-0 flex-1 truncate" data-fact-summary>
          {summary}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="px-4 pb-3 pl-10">
          {sub ? <p className="text-meta text-muted-foreground">{sub}</p> : null}
          {children ? <div className="mt-1.5">{children}</div> : null}
        </div>
      ) : null}
    </FactShell>
  );
}

/** 没查成的一项：状态写「没查成」（等待色，不是红、不是 0），灰字写原因。失联列 muted 时「没查成」也是灰字。 */
function NotRead({
  kind,
  look,
  reason,
  muted,
  children,
  ...head
}: Head & {
  kind: FactKind;
  look: FactLook;
  reason: string;
  muted?: boolean | undefined;
  children?: ReactNode;
}) {
  const phone = usePhone();
  if (phone && look === 'tile') {
    return (
      <FoldedFact
        kind={kind}
        state="unread"
        head={head}
        tone="stall"
        summary={`没查成 · ${reason}`}
        sub={reason}
      >
        {children}
      </FoldedFact>
    );
  }
  return (
    <FactShell kind={kind} state="unread" look={look}>
      <FactRow head={head} value={<FactValue value="没查成" tone="stall" muted={muted} />} sub={reason}>
        {children}
      </FactRow>
    </FactShell>
  );
}

/** 查成了的一项：状态 + 一句白话；tone 只给真正要提醒的那几种。 */
function Read({
  kind,
  look,
  value,
  sub,
  tone,
  muted,
  mono,
  valueTitle,
  children,
  ...head
}: Head & {
  kind: FactKind;
  look: FactLook;
  value: string | number;
  sub?: string | undefined;
  tone?: Tone | undefined;
  muted?: boolean | undefined;
  /** 值是提交号：等宽字。 */
  mono?: boolean | undefined;
  /** 值的悬停：完整时间这类。 */
  valueTitle?: string | undefined;
  children?: ReactNode;
}) {
  const phone = usePhone();
  if (phone && look === 'tile') {
    return (
      <FoldedFact
        kind={kind}
        state="ok"
        head={head}
        tone={tone ?? 'done'}
        sub={sub}
        summary={
          <>
            {value}
            {sub ? <span className="font-sans text-muted-foreground"> · {sub}</span> : null}
          </>
        }
      >
        {children}
      </FoldedFact>
    );
  }
  return (
    <FactShell kind={kind} state="ok" look={look}>
      <FactRow
        head={head}
        value={<FactValue value={value} tone={tone} muted={muted} mono={mono} title={valueTitle} />}
        sub={sub}
      >
        {children}
      </FactRow>
    </FactShell>
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
  sessions: { label: '在跑的会话', hint: '已开工的，几个、各在哪一段', icon: Activity },
  pools: { label: '池占用', hint: '几块池、在跑合计（已开工的）', icon: Gauge },
  health: { label: '健康', hint: '几项红、哪几项', icon: HeartPulse },
  version: { label: '在用版本', hint: '落后主线几个提交', icon: Tag },
  schedule: { label: '最近拉单', hint: '引擎上一轮拉单成没成', icon: CalendarClock },
} satisfies Record<string, Head>;

/**
 * 六项，按固定先后（引擎、会话、池、健康、版本、拉单）一项一个元素返回；外层决定怎么排（本台两栏各三行、对照列一列六行用 subgrid 对齐）。
 * jobCount：最近拉单「从没跑成」时顺带写一共几个定时任务（法国页有这份数）。
 */
export function factCells({
  facts,
  now,
  kind,
  look,
  jobCount,
  versionExtra,
  engineNote,
  muted,
}: {
  facts: EnvFacts;
  now: number;
  kind: FactKind;
  look: FactLook;
  jobCount?: number | undefined;
  /** 挂在「在用版本」那一项底下的东西（#1255：发布入口）。只有本台给；远程列只读，不给。版本读成读不成都挂。 */
  versionExtra?: ReactNode;
  /** 挂在「引擎」那一项底下：总开关关着、进程仍在跑时，说明这两件不是一回事。 */
  engineNote?: ReactNode;
  /** 失联 / 没数据：状态值改成灰色小字，不再用醒目色（法国页远程列）。 */
  muted?: boolean | undefined;
}): ReactNode[] {
  // exactOptionalPropertyTypes：没有 muted 时别塞 undefined
  const base = muted ? { kind, look, muted: true as const } : { kind, look };
  const cells: ReactNode[] = [];

  if (facts.engine.ok) {
    const w = engineWords(facts.engine.value);
    cells.push(
      <Read key="engine" {...base} {...HEADS.engine} value={w.value} sub={w.sub} tone={w.tone}>
        {engineNote}
      </Read>,
    );
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
        sub={`在跑 ${p.running}${p.reserved ? ` · 已选定还没开跑 ${p.reserved}` : ''} · 没读成 ${p.unread} · 过期 ${p.stale}`}
        tone={p.unread > 0 || p.stale > 0 ? 'stall' : undefined}
      />,
    );
  } else cells.push(<NotRead key="pools" {...base} {...HEADS.pools} reason={facts.pools.reason} />);

  if (facts.health.ok) {
    const h = facts.health.value;
    const pending = h.pending?.length ?? 0;
    cells.push(
      <Read
        key="health"
        {...base}
        {...HEADS.health}
        value={h.failing.length === 0 ? '没红的' : `${h.failing.length} 项红`}
        sub={
          h.failing.length === 0
            ? `${h.total} 项都通；未接 ${h.notWired.length} 项${pending > 0 ? `；待定 ${pending} 项` : ''}`
            : `红：${h.failing.join('、')}`
        }
        tone={h.failing.length > 0 ? 'fail' : pending > 0 ? 'wait' : undefined}
      />,
    );
  } else cells.push(<NotRead key="health" {...base} {...HEADS.health} reason={facts.health.reason} />);

  if (facts.version.ok) {
    const v = facts.version.value;
    const behindLine =
      v.behind !== null && v.behind > 0 && !v.detail?.includes('落后主线') ? (
        <p className="text-meta text-ink-stall">落后主线 {v.behind} 个提交</p>
      ) : null;
    const problems = v.problems.length ? (
      <ul className="space-y-0.5 text-meta text-ink-stall">
        {v.problems.map((p) => (
          <li key={p} className="flex gap-1.5">
            <CircleChevronDown className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="min-w-0">{p}</span>
          </li>
        ))}
      </ul>
    ) : null;
    cells.push(
      <Read
        key="version"
        {...base}
        {...HEADS.version}
        value={v.current === null ? '没查成' : v.current.slice(0, 12)}
        mono={v.current !== null}
        sub={v.detail}
        tone={versionTone(v)}
      >
        {behindLine || problems || versionExtra ? (
          <div className="space-y-1.5">
            {behindLine}
            {problems}
            {versionExtra}
          </div>
        ) : null}
      </Read>,
    );
  } else {
    cells.push(
      <NotRead key="version" {...base} {...HEADS.version} reason={facts.version.reason}>
        {versionExtra}
      </NotRead>,
    );
  }

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
        // 最近一次跑成的完整时刻在值的悬停里（原来是这一格底下单独一行）
        valueTitle={v.lastSuccessAt ? `最近一次跑成：${formatDateTime(v.lastSuccessAt)}` : undefined}
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
      />,
    );
  } else cells.push(<NotRead key="schedule" {...base} {...HEADS.schedule} reason={facts.schedule.reason} />);

  return cells;
}

/** 六项里几项没查成、健康几项红：列头、标题块灰字里的一句小结（都没有就是 null）。 */
export function factsSummary(facts: EnvFacts): string | null {
  const failing = facts.health.ok ? facts.health.value.failing.length : 0;
  const unread = factsUnread(facts);
  const parts: string[] = [];
  if (unread > 0) parts.push(`${unread} 项没查成`);
  if (failing > 0) parts.push(`健康 ${failing} 项红`);
  return parts.length ? parts.join(' · ') : null;
}

/** 几项没查成（含总开关那一项）。 */
export function factsUnread(facts: EnvFacts): number {
  return [
    facts.engine,
    ...(facts.master ? [facts.master] : []),
    facts.version,
    facts.sessions,
    facts.pools,
    facts.health,
    facts.schedule,
  ].filter((f) => !f.ok).length;
}

/** 六格的行数：对照列按它给每一列划 subgrid 行。 */
export const FACT_ROWS = 6;
