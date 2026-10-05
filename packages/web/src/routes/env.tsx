// 环境页「环境」（#820 片 1，只读）：这一台环境现在怎样，一项一个「查成了 / 没查成 + 原因」。
//
// 只读、不跨环境、不开口子：读的全是本后端自己库里的现成读法（/api/env 一处聚合，见 packages/api/src/env-view.ts）。
// 要做成什么（specs/820-驾驶舱环境视图与中止恢复/方案.md §5 片 1）：
// - 「回来看一眼」时，一眼看到：引擎在不在、在用哪版、落后主线没有、手上几个会话在跑、池占几个、健康红几项、最近拉单；
// - 读不到的格子明说「没查成」和原因，不拿空或 0 冒充正常（通用段「底线」）；一项读失败不连累别的项；
// - 「引擎关着（临时调整）」用等待色，不画成红：红了表示「真坏了要当场修」，关着是创始人拍的临时调整。
//
// 改这里之前必须知道：
// - 这一页只在正式驾驶舱里（演示版没有这个模块，导航不给 module、路由表也不放）：它露机器名、在用版本、在跑会话数（R10）。
// - 后端已经逐项包好「查成了 / 没查成」，前端只负责把两态如实画出来，不在这里再判一遍成败。

import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  CalendarClock,
  CircleChevronDown,
  CircleDashed,
  Gauge,
  HeartPulse,
  Power,
  ServerCog,
  Tag,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { brand } from '#brand';
import { useEnv } from '../api/client';
import type { EnvEngine, EnvFacts, EnvSchedule, EnvVersion } from '../api/types';
import { LoadError, LoadingRows, Page } from '../components/page';
import { stageLabel } from '../lib/catalog';
import { formatAgo, formatDateTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('环境') }];
}

/** 等待色（黄系）和「真坏了」的红分开：关着、没跑成、落后主线是「等情况」，不是「坏了」（#820 片 1 做完的标准 2）。 */
const TONE_CLASS: Record<Tone, string> = {
  done: 'text-ink-done',
  run: 'text-ink-run',
  wait: 'text-ink-wait',
  human: 'text-ink-human',
  stall: 'text-ink-stall',
  fail: 'text-ink-fail',
  stop: 'text-ink-stop',
};

/** 一格的成败两态：没查成就整格写「没查成 + 原因」，不当成「没有」、不拿别的格顶上。 */
type Tile = { label: string; hint: string; icon: LucideIcon };

function TileHead({ label, hint, icon: Icon }: Tile) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate opacity-80">· {hint}</span>
    </span>
  );
}

/** 没查成的一格：明说原因，画成虚线灰框（不是红、不是 0）。 */
function NotRead({ label, hint, icon, reason }: Tile & { reason: string }) {
  return (
    <div data-env-fact="unread" className="rounded-xl border border-dashed bg-card p-4 text-muted-foreground">
      <TileHead label={label} hint={hint} icon={icon} />
      <div className="mt-2 flex items-baseline gap-2">
        <CircleDashed className="size-4 shrink-0 self-center text-ink-stall" aria-hidden />
        <span className="text-stat leading-none font-semibold tracking-tight text-ink-stall">没查成</span>
      </div>
      <p className="mt-2 text-xs">{reason}</p>
    </div>
  );
}

/** 查成了的一格：大号等宽值 + 一句白话；`tone` 只给真正要提醒的那几种。 */
function Read({
  label,
  hint,
  icon: Icon,
  value,
  sub,
  tone,
  children,
}: Tile & {
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone | undefined;
  children?: ReactNode;
}) {
  return (
    <div data-env-fact="ok" className="rounded-xl border bg-card p-4 shadow-card-edge">
      <TileHead label={label} hint={hint} icon={Icon} />
      <div
        className={cn(
          'num mt-2 text-stat leading-none font-semibold tracking-tight',
          tone ? TONE_CLASS[tone] : undefined,
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-2 text-xs text-muted-foreground">{sub}</div> : null}
      {children}
    </div>
  );
}

/** 引擎那一格：on / off（临时调整）/ down（真没连上）/ unknown（没查成）四态各说各的。 */
function engineWords(e: EnvEngine): { value: string; sub: string; tone: Tone | undefined } {
  switch (e.state) {
    case 'on':
      return { value: '在跑', sub: e.detail ?? '探到了在拉活的工人', tone: 'done' };
    case 'off':
      return {
        value: '关着（临时调整）',
        sub: e.detail ?? '按 release.env 的 FLEET_SERVICES 没开',
        tone: 'stall',
      };
    case 'down':
      return { value: '没连上', sub: e.detail ?? '开着却探不到在线的工人', tone: 'fail' };
    case 'unknown':
      return { value: '没查成', sub: e.detail ?? '这台后端没有接引擎探针', tone: 'wait' };
  }
}

function EngineTile({ v }: { v: EnvEngine }) {
  const w = engineWords(v);
  return (
    <Read label="引擎" hint="在拉活的工人有没有" icon={Power} value={w.value} sub={w.sub} tone={w.tone} />
  );
}

/** 版本那一格：在用哪版、落后主线多少、判出来的问题；只在法国的正式机器上有，别处是「没查成」。 */
function VersionTile({ v }: { v: EnvVersion }) {
  const behind = v.behind;
  const tone: Tone | undefined =
    v.current === null || v.problems.length > 0
      ? 'stall'
      : behind === null
        ? 'wait'
        : behind > 0
          ? 'wait'
          : 'done';
  return (
    <Read
      label="在用版本"
      hint="落后主线没有"
      icon={Tag}
      value={v.current === null ? '没查成' : v.current.slice(0, 12)}
      sub={v.detail}
      tone={tone}
    >
      {v.problems.length ? (
        <ul className="mt-2 space-y-1 text-xs text-ink-stall">
          {v.problems.map((p) => (
            <li key={p} className="flex gap-1.5">
              <CircleChevronDown className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="min-w-0">{p}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Read>
  );
}

function ScheduleTile({ v, now }: { v: EnvSchedule; now: number }) {
  const tone: Tone | undefined =
    v.status === 'never'
      ? 'wait'
      : v.outcome === 'failed'
        ? 'fail'
        : v.status !== 'fresh' || v.outcome === 'unscanned' || v.outcome === 'partial'
          ? 'stall'
          : 'done';
  const value =
    v.status === 'never'
      ? '从没跑成'
      : v.lastSuccessAt
        ? formatAgo(v.lastSuccessAt, now)
        : '没查到上次跑成的时间';
  return (
    <Read
      label="最近拉单"
      hint="引擎上一轮拉单成没成"
      icon={CalendarClock}
      value={value}
      tone={tone}
      sub={
        v.status === 'never'
          ? '这个环境还没有拉单记录'
          : v.why
            ? v.why
            : v.outcome === undefined
              ? '上次这一轮还没有结局'
              : `上次结局：${v.outcome}${v.scanned === undefined ? '' : `，扫了 ${v.scanned} 个`}`
      }
    >
      {v.lastSuccessAt ? (
        <div className="mt-1 text-caption text-faint">最近一次跑成：{formatDateTime(v.lastSuccessAt)}</div>
      ) : null}
    </Read>
  );
}

function EnvBody({ facts, now }: { facts: EnvFacts; now: number }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-2">
        {facts.engine.ok ? (
          <EngineTile v={facts.engine.value} />
        ) : (
          <NotRead label="引擎" hint="在拉活的工人有没有" icon={Power} reason={facts.engine.reason} />
        )}
        {facts.sessions.ok ? (
          <Read
            label="在跑的会话"
            hint="几个、各在哪一段"
            icon={Activity}
            value={facts.sessions.value.total}
            sub={
              facts.sessions.value.total === 0
                ? '手上没有在跑的会话'
                : Object.entries(facts.sessions.value.byStage)
                    .map(([k, n]) => `${stageLabel[k as keyof typeof stageLabel] ?? k} ${n}`)
                    .join(' · ')
            }
          />
        ) : (
          <NotRead
            label="在跑的会话"
            hint="几个、各在哪一段"
            icon={Activity}
            reason={facts.sessions.reason}
          />
        )}
        {facts.pools.ok ? (
          <Read
            label="池占用"
            hint="几块池、在跑合计"
            icon={Gauge}
            value={`${facts.pools.value.count} 块`}
            sub={`在跑 ${facts.pools.value.running} · 没读成 ${facts.pools.value.unread} · 过期 ${facts.pools.value.stale}`}
            tone={facts.pools.value.unread > 0 || facts.pools.value.stale > 0 ? 'stall' : undefined}
          />
        ) : (
          <NotRead label="池占用" hint="几块池、在跑合计" icon={Gauge} reason={facts.pools.reason} />
        )}
        {facts.health.ok ? (
          <Read
            label="健康"
            hint="几项红、哪几项"
            icon={HeartPulse}
            value={
              facts.health.value.failing.length === 0 ? '没红的' : `${facts.health.value.failing.length} 项红`
            }
            sub={
              facts.health.value.failing.length === 0
                ? `${facts.health.value.total} 项都通；未接 ${facts.health.value.notWired.length} 项`
                : `红：${facts.health.value.failing.join('、')}`
            }
            tone={facts.health.value.failing.length > 0 ? 'fail' : undefined}
          />
        ) : (
          <NotRead label="健康" hint="几项红、哪几项" icon={HeartPulse} reason={facts.health.reason} />
        )}
      </div>
      <div className="grid content-start gap-3">
        {facts.version.ok ? (
          <VersionTile v={facts.version.value} />
        ) : (
          <NotRead label="在用版本" hint="落后主线没有" icon={Tag} reason={facts.version.reason} />
        )}
        {facts.schedule.ok ? (
          <ScheduleTile v={facts.schedule.value} now={now} />
        ) : (
          <NotRead
            label="最近拉单"
            hint="引擎上一轮拉单成没成"
            icon={CalendarClock}
            reason={facts.schedule.reason}
          />
        )}
      </div>
    </div>
  );
}

export default function Env() {
  const { data, error, isLoading } = useEnv();
  const now = useNow();

  if (error) {
    return (
      <Page title="环境">
        <LoadError error={error} />
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page title="环境">
        <LoadingRows rows={4} />
      </Page>
    );
  }

  const { name, asOf, facts } = data;
  const failing = facts.health.ok ? facts.health.value.failing.length : undefined;
  const unread = [
    facts.engine,
    facts.version,
    facts.sessions,
    facts.pools,
    facts.health,
    facts.schedule,
  ].filter((f) => !f.ok).length;

  return (
    <Page
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ServerCog className="size-6 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{name.name}</span>
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
            本环境
          </span>
        </span>
      }
      description={
        name.problem
          ? `${name.problem}。这一页只看这一台环境（不跨环境）：引擎在不在、在用哪版、手上几个会话、池占几个、健康红几项、最近拉单。`
          : '这一台环境现在怎样，一页看全：引擎在不在、在用哪版、落后主线没有、手上几个会话在跑、池占几个、健康红几项、最近一轮拉单。每个数读不到就写「没查成」和原因，不拿空顶。'
      }
      actions={
        <span className="num text-xs text-muted-foreground">
          {formatAgo(asOf, now)}读
          {unread > 0 ? <span className="ml-2 text-ink-stall">· {unread} 项没查成</span> : null}
          {failing ? <span className="ml-2 text-ink-fail">· 健康 {failing} 项红</span> : null}
        </span>
      }
    >
      <EnvBody facts={facts} now={now} />
      <p className="mt-4 text-xs text-muted-foreground">
        这一页只读、不跨环境：读的全是本后端自己库里的现成读法。写操作（暂停派活、叫停）在片 2、片 3
        里做，这一页不给。
      </p>
    </Page>
  );
}
