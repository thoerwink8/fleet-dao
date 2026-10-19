// 顶部持续状态条：额度、中转、引擎开关。
//
// 关键规矩（specs/509 第五节）：有问题**持续显示、不伪装成失败**——快清零、有路由探不通、引擎被关
// 这些都写在条上一目了然，但用 wait / stall 提示色（黄系），不用 fail 红。红了表示「真坏了，要当场修」，
// 这三件都不是「坏了」——额度本来就会被吃掉、探针本来就会报某些路由不通、引擎是按配置关的。
// 把它们画成红就是在伪装失败。反过来，引擎开着却探不到在线的工人（down）是真坏了，红；没查成（unknown）不写成正常。
//
// 写法（#1899）：每格是一个 StatusBadge，tone 色加一个短状态字（正常 / 紧 / 有不通 / 已停用 / 没连上 / 没查成），
// 不再靠灰色胶囊加颜色传意思。≥1440 且顶栏里真放得下时三格摊在顶栏；放不下或更窄（含手机）收成一个「状态」按钮，按钮上写汇总，点开是三格全文。

import { useLayoutEffect, useRef, useState } from 'react';
import { useMediaQuery } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { usePhone } from '../../lib/viewport';
import { StatusBadge } from '../layout/status-badge';
import type { LayoutTone } from '../layout/tone';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { HomeHealth } from './types';

type Kind = 'ok' | 'warn' | 'muted' | 'bad';

/** 每格的状态色：正常 done、提示 wait（黄系）、真坏了 fail、没查成 stop。 */
const KIND_TONE: Record<Kind, LayoutTone> = { ok: 'done', warn: 'wait', bad: 'fail', muted: 'stop' };

/** 汇总时哪个更要紧：真坏了 > 提示 > 没查成 > 正常。 */
const KIND_RANK: Record<Kind, number> = { ok: 0, muted: 1, warn: 2, bad: 3 };

/** ≥1440：三格摊在顶栏里放得下；更窄收进「状态」菜单。 */
const WIDE_QUERY = '(min-width: 1440px)';

export interface HealthItem {
  key: 'quota' | 'routes' | 'engine';
  name: string;
  /** 短状态字，紧挨着名字写。 */
  word: string;
  detail: string;
  kind: Kind;
}

function kindOfQuota(state: HomeHealth['quota']['state']): Kind {
  if (state === 'tight') return 'warn';
  if (state === 'ok') return 'ok';
  return 'muted';
}

function kindOfRoutes(state: HomeHealth['routes']['state']): Kind {
  if (state === 'degraded') return 'warn';
  if (state === 'ok') return 'ok';
  return 'muted';
}

function kindOfEngine(state: HomeHealth['engine']['state']): Kind {
  switch (state) {
    case 'on':
      return 'ok';
    case 'off':
      return 'warn'; // 按配置没开，不是坏了
    case 'down':
      return 'bad'; // 开着却没连上：真坏了，红
    case 'unknown':
      return 'muted'; // 没查成，不冒充正常
  }
}

/** 引擎进程那一格的短状态字和一句话：四种状态各说各的，名字都带「进程」，和顶栏的总开关分开，不共用「正常」。 */
function engineWords(engine: HomeHealth['engine']): { word: string; detail: string } {
  switch (engine.state) {
    case 'on':
      return { word: '正常', detail: '正常' };
    case 'off':
      return { word: '已停用', detail: engine.detail ?? '按配置没开' };
    case 'down':
      return { word: '没连上', detail: engine.detail ?? '探不到在线的工人' };
    case 'unknown':
      return { word: '没查成', detail: `没查成${engine.detail ? `：${engine.detail}` : ''}` };
  }
}

/** 三格的名字、短状态字、详情句和状态。 */
export function healthItems(health: HomeHealth): HealthItem[] {
  const quotaKind = kindOfQuota(health.quota.state);
  const routesKind = kindOfRoutes(health.routes.state);
  const engine = engineWords(health.engine);
  return [
    {
      key: 'quota',
      name: '额度',
      word: quotaKind === 'ok' ? '正常' : quotaKind === 'warn' ? '紧' : '没查成',
      detail: health.quota.detail,
      kind: quotaKind,
    },
    {
      key: 'routes',
      name: '中转',
      word: routesKind === 'ok' ? '正常' : routesKind === 'warn' ? '有不通' : '没查成',
      detail: health.routes.detail,
      kind: routesKind,
    },
    { key: 'engine', name: '引擎进程', ...engine, kind: kindOfEngine(health.engine.state) },
  ];
}

/** 汇总：最要紧的那格定颜色；全正常写「正常」，否则写几项要留意。 */
export function healthSummary(items: readonly HealthItem[]): { tone: LayoutTone; label: string } {
  const worst = items.reduce<Kind>((a, i) => (KIND_RANK[i.kind] > KIND_RANK[a] ? i.kind : a), 'ok');
  const n = items.filter((i) => i.kind !== 'ok').length;
  return { tone: KIND_TONE[worst], label: n === 0 ? '状态 正常' : `状态 ${n} 项要留意` };
}

/** 一格：StatusBadge（色 + 短状态字）。详情句在 ≥1536 接在后面，更窄只在悬停提示里。 */
function Chip({ item, withDetail }: { item: HealthItem; withDetail: boolean }) {
  return (
    <span
      data-health-chip={item.kind}
      data-tone={KIND_TONE[item.kind]}
      title={`${item.name}：${item.detail}`}
      className="inline-flex max-w-full shrink-0 items-center gap-1.5"
    >
      <StatusBadge tone={KIND_TONE[item.kind]} variant="outline" label={`${item.name} ${item.word}`} />
      {withDetail ? (
        // 详情宽度用 max-w-health-detail。全文在 title 上，窄了截断不删字。
        <span
          data-health-detail
          className="hidden min-w-0 max-w-health-detail truncate text-meta text-muted-foreground 2xl:inline"
        >
          {item.detail}
        </span>
      ) : null}
    </span>
  );
}

/** 「状态」菜单：按钮上写汇总，点开是三格全文。手机上按钮不小于 40 高。 */
function StatusMenu({ items, className }: { items: readonly HealthItem[]; className?: string }) {
  const summary = healthSummary(items);
  return (
    // 收起时也留一个 role=status「持续状态」：读屏读得到三格各自的状态字（按钮上只有汇总），france.test 守着它
    <div role="status" aria-label="持续状态" className={cn('flex shrink-0 items-center', className)}>
      <span className="sr-only">{items.map((i) => `${i.name}${i.word}`).join('，')}</span>
      <MenuPopover items={items} summary={summary} />
    </div>
  );
}

function MenuPopover({
  items,
  summary,
}: {
  items: readonly HealthItem[];
  summary: ReturnType<typeof healthSummary>;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`持续状态：${items.map((i) => `${i.name}${i.word}`).join('；')}`}
          data-health-strip
          data-health-menu
          className="flex min-h-10 shrink-0 items-center rounded-md px-1 transition-colors hover:bg-accent md:min-h-8"
        >
          <StatusBadge tone={summary.tone} variant="outline" label={summary.label} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <ul className="space-y-3">
          {items.map((i) => (
            <li
              key={i.key}
              data-health-chip={i.kind}
              data-tone={KIND_TONE[i.kind]}
              className="flex flex-col items-start gap-1"
            >
              <StatusBadge tone={KIND_TONE[i.kind]} variant="outline" label={`${i.name} ${i.word}`} />
              <span data-health-detail className="text-meta text-muted-foreground">
                {i.detail}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 三格摊开放不放得下：量一次摊开要多宽，再盯着外框还剩多宽，放不下就收成「状态」按钮。
 * 只看屏宽不够：顶栏里还有环境切换、总开关、搜索框，三格的说明又长短不一，桌面根字号放大到 125%（#1937）后更容易压到搜索框上。
 * 量不到（测试环境宽度恒为 0、没有 ResizeObserver）当放得下，照屏宽档走。
 */
function useStripRoom(items: readonly HealthItem[], wanted: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [needed, setNeeded] = useState(0);
  const [avail, setAvail] = useState(0);
  const key = items.map((i) => `${i.word}${i.detail}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 三格的字变了要重量，key 就是这些字。
  useLayoutEffect(() => {
    setNeeded(0);
  }, [key]);
  useLayoutEffect(() => {
    if (wanted && needed === 0 && strip.current) setNeeded(strip.current.scrollWidth);
  });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const fits = needed === 0 || avail === 0 || needed <= avail;
  return { box, strip, fits };
}

export function HealthStrip({ health, className }: { health: HomeHealth; className?: string }) {
  const wide = useMediaQuery(WIDE_QUERY);
  const phone = usePhone();
  const items = healthItems(health);
  const wanted = wide && !phone;
  const { box, strip, fits } = useStripRoom(items, wanted);
  return (
    <div ref={box} data-health-strip-box className="flex min-w-0 flex-1 items-center justify-end">
      {wanted && fits ? (
        <div
          ref={strip}
          role="status"
          aria-label="持续状态"
          data-health-strip
          className={cn('flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden', className)}
        >
          {items.map((i) => (
            <Chip key={i.key} item={i} withDetail />
          ))}
        </div>
      ) : (
        <StatusMenu items={items} {...(className ? { className } : {})} />
      )}
    </div>
  );
}
