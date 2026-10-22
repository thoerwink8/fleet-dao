// 路由页上「一个模型下的路由」那一块（#574，#1366 第二部分）：每条路由的活 / 死 / 不知道和三件事的原因、开关。
// 用途页（选中一个模型）、模型目录页（选中一个模型）、渠道页（选中一个渠道，看它在各个模型下的路由）共用。
// 路由页样板（#1914）：一行只留名字、一个状态和开关；渠道、在跑几个、实际第几位写在名字下面一行小字；
// 挪位置收进行尾「⋯」（悬停才露出）；点名字展开三件事的原因。关着的行只降对比度，不整行变灰底。
// 停用账号池在额度页那一行的开关，不在这里设。池已经停着时，这条路由的开关置灰。
// 改这里之前必须知道：
// - 不知道（探针没看过、额度没读成）不画成活，也不画成死：用停滞色，原因照写。
// - 渠道已关时这条路由不画开关，写「渠道已关」；池停着、暂停设置没读成时开关置灰并写原因。

import { type HostId, routeEffortChoices } from '@fleet-dao/shared';
import { Hourglass } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { errorText, usePoolHolds, useRouting, useUpdateModelRoute } from '../api/client';
import type { LivenessFact, RoutingLayerModel, RoutingLayerRoute } from '../api/types';
import { formatAgo, formatIn } from '../lib/format';
import { poolIsHeld } from '../lib/pool-holds';
import { nextProbeLine } from '../lib/probe-pace-view';
import { routeKind } from '../lib/route-kinds';
import { shareBanners } from '../lib/route-share';
import { probeInterrupted, routeStateLabel } from '../lib/route-state';
import { routeHost, routeSlots, routeTitle } from '../lib/routing';
import { supportedPurposeEfforts } from '../lib/routing-browse';
import {
  actualRanks,
  type OrderSummary,
  routeSlotState,
  type SlotState,
  slotWord,
  summarizeOrder,
} from '../lib/routing-order';
import { cn } from '../lib/utils';
import { statusEntry } from '../theme/status-dict';
import { Button } from './layout/button';
import { Code } from './layout/code';
import { Grid } from './layout/grid';
import { RowDetail, RowFrame } from './layout/list';
import { DisclosureIcon, FoldBar, RowButton } from './layout/row-button';
import { RowMenu, RowMenuItem } from './layout/row-menu';
import { Stack } from './layout/stack';
import { LevelDot } from './layout/status-badge';
import { Tag } from './layout/tag';
import { Text } from './layout/text';
import { Toggle } from './layout/toggle';
import { PoolProblemLine, usePoolProblems } from './pool-problem';
import {
  ROW_MENU_TITLE,
  RouteSwitch,
  type RowControls,
  RowMoveItems,
  SortableList,
  useRoutingEdit,
} from './routing-edit';
import { RouteEffortField, useConfiguredRouteEffort } from './routing-efforts';
import { KindChip, useKindEnv } from './routing-kinds';

/**
 * 档位配不了时的长说明（「没有单独的档位参数……不带方括号」等）：行内不铺开，
 * 悬停看全文（#1754）。和 membership 里档位组置灰用的同一句话。
 */
export function effortBlockedTitle(
  modelId: string,
  routes: readonly { hostId: HostId; upstreamModel?: string | undefined }[],
): string | undefined {
  // 和 membership 的 effortBlockedWhy 同一套话：先看有没有共同认的档，没有再取 fixed 原因。
  if (supportedPurposeEfforts(modelId, routes).length > 0) return undefined;
  for (const route of routes) {
    const choices = routeEffortChoices(route.hostId, modelId);
    if (choices.kind === 'fixed') return choices.why;
  }
  if (routes.length === 0) return '一条路由都没有，没有能配的档位';
  return '这几条路由没有共同认的档位';
}

/** 一个模型下的路由先后合起来怎么说（调用方要把它写在区块标题下面时用）。 */
export function useRouteOrder(m: RoutingLayerModel): OrderSummary {
  const env = useKindEnv();
  return summarizeOrder(
    m.routes.map((r) => routeSlotState(r, env.channelEnabled)),
    '路由',
  );
}

/**
 * 模型已关时：路由列表默认折叠，头上保留配置顺序号和「已关 N 条路由」；点开展开（#1754）。
 * 开着的模型不走这层，直接画 ModelRoutes。
 */
export function CollapsibleOffModelRoutes({
  model,
  position,
  now,
  firstLiveRoute,
  summary = true,
}: {
  model: RoutingLayerModel;
  /** 配置里的先后（从 1 起），折叠头上照写，不改号。 */
  position: number;
  now: number;
  firstLiveRoute?: string | undefined;
  summary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const n = model.routes.length;
  return (
    <>
      <FoldBar open={open} onToggle={() => setOpen((v) => !v)} controls={`off-routes-${model.modelId}`}>
        <span data-position className="num shrink-0">
          {position}
        </span>
        <span>
          已关 <span className="num">{n}</span> 条路由
        </span>
      </FoldBar>
      <div id={`off-routes-${model.modelId}`} hidden={!open}>
        {open ? (
          <ModelRoutes
            model={model}
            now={now}
            firstLiveRoute={firstLiveRoute}
            summary={summary}
            showAllByDefault
          />
        ) : null}
      </div>
    </>
  );
}

/** 一个模型下的路由，可拖动改先后（先后不分用途，管这个模型在所有用途里）。默认只列开着的。 */
export function ModelRoutes({
  model: m,
  now,
  firstLiveRoute,
  summary = true,
  showAllByDefault = false,
}: {
  model: RoutingLayerModel;
  now: number;
  firstLiveRoute?: string | undefined;
  /** 列表上面写一行「引擎按序试……」；调用方已经写在区块标题下面就传 false。 */
  summary?: boolean;
  /** 已关模型展开后把关着的也列出来，方便当场看。用途页上开着的模型默认不传。 */
  showAllByDefault?: boolean;
}) {
  const edit = useRoutingEdit();
  const updateShare = useUpdateModelRoute();
  const env = useKindEnv();
  const [showAll, setShowAll] = useState(showAllByDefault);
  const version = m.shareVersion ?? 0;
  const onShare = async (
    routeId: string,
    body: { shareBand: number | null; shareWeight: number; expectedVersion: number },
  ): Promise<number | null> => {
    try {
      const res = await updateShare.mutateAsync({
        modelId: m.modelId,
        routeId,
        body: { op: 'share', ...body, reason: '同一档' },
      });
      return res.version ?? body.expectedVersion + 1;
    } catch (err) {
      toast.error(errorText(err));
      return null;
    }
  };
  if (m.routes.length === 0) {
    return (
      <RowFrame>
        <Text tone="danger">这个模型下一条路由都没有：排了它也派不到它</Text>
      </RowFrame>
    );
  }
  // 引擎自动跳过关着的、顺延给下一个：实际顺位只数开着的（lib/routing-order.ts）。筛选不改这个数。
  const states = m.routes.map((r) => routeSlotState(r, env.channelEnabled));
  const ranks = actualRanks(states);
  const slotOf = new Map(
    m.routes.map((r, i) => [r.routeId, { state: states[i] ?? 'on', rank: ranks[i] ?? null }]),
  );
  const indexOf = new Map(m.routes.map((r, i) => [r.routeId, i]));
  const hidden = m.routes.filter((r) => !r.enabled).length;
  const visible = showAll ? m.routes : m.routes.filter((r) => r.enabled);
  // 只画了一部分时不能调先后：保存的顺序会把没画出来的丢掉。
  const filtered = visible.length !== m.routes.length;
  const hideWhy = filtered ? '只显示了开着的路由：点「显示全部」再调先后' : null;
  return (
    <>
      {summary ? (
        <RowDetail indent={false}>
          <Text size="meta" as="p">
            <OrderSummaryLine summary={summarizeOrder(states, '路由')} noun="路由" />
          </Text>
        </RowDetail>
      ) : null}
      {shareBanners(
        m.routes.flatMap((r) =>
          r.shareBand === undefined
            ? []
            : [
                {
                  band: r.shareBand,
                  label: routeTitle(r),
                  weight: r.shareWeight ?? 1,
                  recent: r.recentDispatches ?? 0,
                },
              ],
        ),
      ).map((text) => (
        <RowDetail key={text} indent={false} data-route-share>
          <Text size="meta" tone="muted" as="p">
            {text}
          </Text>
        </RowDetail>
      ))}
      {hidden > 0 ? (
        <RowDetail indent={false}>
          <Stack direction="horizontal" gap="sm" align="center">
            <Toggle pressed={showAll} onPressedChange={setShowAll}>
              显示全部
            </Toggle>
            {showAll ? null : (
              <Text size="meta" tone="muted">
                还有 <span className="num">{hidden}</span> 条关着的
              </Text>
            )}
          </Stack>
        </RowDetail>
      ) : null}
      <SortableList
        ariaLabel={`${m.displayName} 的路由`}
        items={visible}
        itemId={(r) => r.routeId}
        itemLabel={(r) => `${routeTitle(r)}（${m.displayName} 下的先后）`}
        disabled={edit.disabledWhy !== null || filtered}
        busy={edit.busy}
        disabledWhy={edit.disabledWhy ?? hideWhy}
        rowProps={(r) => ({ 'data-route': r.routeId })}
        onSave={(order, expected, movedId) =>
          edit.reorderRoutes({ modelId: m.modelId, movedId, order, expected })
        }
      >
        {(r, _i, controls) => (
          <RouteItem
            route={r}
            index={indexOf.get(r.routeId) ?? 0}
            modelId={m.modelId}
            modelName={m.displayName}
            rowControls={controls}
            now={now}
            firstLive={r.routeId === firstLiveRoute}
            {...(slotOf.has(r.routeId) ? { slot: slotOf.get(r.routeId) } : {})}
            peers={m.routes}
            shareVersion={version}
            shareBusy={updateShare.isPending}
            onShare={onShare}
          />
        )}
      </SortableList>
    </>
  );
}

/**
 * 这一层引擎实际会派几个、跳过几个；一个都派不了明说「无可用」，不画成没事。
 * 一句短话放在区块标题下面；为什么跳过、排头是配置里第几个，悬停看全文。
 */
export function OrderSummaryLine({ summary, noun }: { summary: OrderSummary; noun: '模型' | '路由' }) {
  const why = noun === '模型' ? '关着、已下架或没有可用路由' : '关着、疑似换模型或没有可用路由';
  const skipped = summary.ok && summary.skipped > 0 ? `，跳过 ${summary.skipped} 个` : '';
  const text = summary.ok ? `引擎按序试开着的 ${summary.active} 个${noun}${skipped}` : summary.why;
  // 手机上卡头一行放不下长句（#1914 第 5 轮：不许折行），换成短的；整句在悬停里
  const short = summary.ok ? `按序试 ${summary.active} 个${skipped}` : summary.why;
  const full = summary.ok
    ? `引擎按这个先后试：开着的 ${summary.active} 个${noun}，${
        summary.skipped > 0 ? `跳过 ${summary.skipped} 个（${why}），` : ''
      }排头的是配置里第 ${summary.firstPosition} 个`
    : summary.why;
  return (
    <span role="status" title={full} data-order-summary={summary.ok ? 'ok' : 'none'}>
      <Text size="meta" tone={summary.ok ? 'muted' : 'danger'} strong={!summary.ok}>
        <span className="max-md:hidden">{text}</span>
        <span className="md:hidden">{short}</span>
      </Text>
    </span>
  );
}

export function RouteItem({
  route: r,
  index,
  modelId,
  modelName,
  modelLabel,
  rowControls,
  now,
  firstLive: isFirst,
  slot,
  peers,
  shareVersion,
  shareBusy,
  onShare,
}: {
  route: RoutingLayerRoute;
  /** 在模型下的第几条（从 0 起）；不给就不写序号（渠道页里的路由不分先后）。 */
  index?: number;
  modelId: string;
  modelName: string;
  /** 渠道页里写明这条路由属于哪个模型。 */
  modelLabel?: string;
  /** 拖动柄和「⋯」菜单里的挪动项；不给就没有（渠道页里不调先后）。 */
  rowControls?: RowControls;
  now: number;
  firstLive?: boolean;
  /** 在顺序里的实际顺位和是否被跳过（lib/routing-order.ts）；不给就不写（渠道页里的路由不分先后）。 */
  slot?: { state: SlotState; rank: number | null } | undefined;
  /** 这个模型下的全部路由，用来「和上一条同一档」。渠道页不传，菜单里就没有这一档。 */
  peers?: RoutingLayerRoute[];
  shareVersion?: number;
  shareBusy?: boolean;
  onShare?: (
    routeId: string,
    body: { shareBand: number | null; shareWeight: number; expectedVersion: number },
  ) => Promise<number | null>;
}) {
  const [open, setOpen] = useState(false);
  const stale = r.probedAt !== undefined && probeInterrupted(r, now);
  const nextLine = nextProbeLine(r, now);
  // 退避中、已到点没探、检测中断才在行上写下次探测；正常的不占地方（展开能看）
  const backoff = nextLine && (nextLine.tone !== 'normal' || (r.probeFailStreak ?? 0) > 0) ? nextLine : null;
  const slots = routeSlots(r);
  const edit = useRoutingEdit();
  const routing = useRouting();
  const holds = usePoolHolds();
  const name = routeTitle(r);
  // 状态词和颜色：后端的「死」拆开，只有故障画红（lib/route-state.ts）
  const kind = routeKind(r, modelId, useKindEnv());
  // 目录没读到不猜渠道关没关：只有读到了且 enabled 为 false 才换成「渠道已关」。
  const channelOff = routing.data
    ? routing.data.channels.find((c) => c.id === r.channelId)?.enabled === false
    : false;
  const poolProblem = usePoolProblems().problems.get(r.poolId);
  const poolLocked = Boolean(holds.data && poolIsHeld(holds.data, r.poolId));
  const lockWhy = holds.error
    ? '整池暂停没读成，先不能开这条路由'
    : poolLocked
      ? '这个账号池整池暂停，不能单独开'
      : null;
  const skipped = slot !== undefined && slot.state !== 'on';
  const dim = skipped || (slot === undefined && !r.enabled);
  const factsId = `facts-${r.routeId}`;
  // 配过档位才在小字里写一句（没配就是默认，不占地方）
  const effort = useConfiguredRouteEffort(modelId, r.routeId);
  const metaTitle = [
    modelLabel ?? null,
    `${routeHost(r)} · ${slots.text}${slots.full ? '（满了，等空位，不算故障）' : ''}`,
    slot ? slotWord(slot.state, slot.rank, '路由') : null,
    effort ? `档位上限 ${effort}` : null,
    isFirst ? '顺位第一条活的' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const shareVersionNow = shareVersion ?? 0;
  const prev = index !== undefined ? peers?.[index - 1] : undefined;
  const shareOff = shareBusy || edit.busy;
  const joinPrevious = async () => {
    if (!onShare || !prev || index === undefined) return;
    const mine = r.shareWeight ?? 1;
    if (prev.shareBand !== undefined) {
      await onShare(r.routeId, {
        shareBand: prev.shareBand,
        shareWeight: mine,
        expectedVersion: shareVersionNow,
      });
      return;
    }
    const bands = (peers ?? []).flatMap((x) => (x.shareBand === undefined ? [] : [x.shareBand]));
    const band = bands.length === 0 ? 0 : Math.max(...bands) + 1;
    const next = await onShare(prev.routeId, {
      shareBand: band,
      shareWeight: prev.shareWeight ?? 1,
      expectedVersion: shareVersionNow,
    });
    if (next === null) return;
    await onShare(r.routeId, { shareBand: band, shareWeight: mine, expectedVersion: next });
  };
  return (
    <>
      <RowFrame tall className="items-start">
        {rowControls?.grip}
        <RowButton
          layout="top"
          expanded={open}
          controls={factsId}
          title="接得上、额度够、禁令与开关三件事的原因"
          dim={dim}
          onClick={() => setOpen((v) => !v)}
        >
          <DisclosureIcon open={open} />
          {/* 序号占定宽（渠道块里不分先后也留着）：下面展开的明细按这个宽缩进，和名字对齐（RowDetail） */}
          <span className="num w-4 shrink-0">
            <Text tone="muted">{index === undefined ? null : index + 1}</Text>
          </span>
          <span className="min-w-0 flex-1">
            {/* 名字后面紧跟这条路由的状态（一行一个状态）；右边只留开关和「⋯」，手机上也放得下 */}
            {/* 小字一行不折（#1914 第 5 轮）：放不下截断，整句在悬停里。名字是认路的那一样，不截断，真放不下宁可换行 */}
            <span data-route-name-line>
              <Stack direction="horizontal" gap="sm" align="center" wrap>
                <span className="break-words">
                  <Text strong>{name}</Text>
                </span>
                {/* 手机上名字后面只留状态点（词在读屏和悬停里）：点加词会把状态挤到第二行（#1916，390 宽量到） */}
                <span className="max-md:hidden">
                  <KindChip kind={kind} variant="dot" />
                </span>
                <span className="inline-flex items-center md:hidden" title={routeStateLabel[kind]}>
                  <LevelDot level={statusEntry(`route:${kind}`).level} />
                  {/* 一段字（不拆成「：」和词两段）：同一个词在行里只算一次 */}
                  <span className="sr-only">{`（${routeStateLabel[kind]}）`}</span>
                </span>
              </Stack>
            </span>
            <span data-route-meta title={metaTitle} className="block truncate whitespace-nowrap">
              {/* 「顺位第一条活的」放小字最前面：窄屏截断时截掉的是后面的在跑几个、第几位，不是它（#1916，原来放末尾，手机上被截掉） */}
              {isFirst ? <Tag>顺位第一条活的</Tag> : null}
              {isFirst ? ' ' : null}
              <Text size="meta" tone="muted">
                {/* 渠道页里写明这条路由属于哪个模型：放小字最前面，名字那行只写「渠道 · 池」，窄屏不挤（#1916） */}
                {modelLabel ? (
                  <>
                    <span data-route-model>
                      <Text size="meta">{modelLabel}</Text>
                    </span>
                    {' · '}
                  </>
                ) : null}
                {routeHost(r)} · <span className="num">{slots.text}</span>
                {slots.full ? (
                  // 池满了是等空位、不算故障：一个小图标，话在悬停和读屏里，窄屏小字不折两行
                  <span data-pool-full title="满了，等空位，不算故障">
                    {' '}
                    <Text tone="warning">
                      <Hourglass className="inline size-3" aria-hidden />
                    </Text>
                    <span className="sr-only">（满了，等空位，不算故障）</span>
                  </span>
                ) : null}
                {slot ? (
                  <>
                    {' · '}
                    <span data-slot-state={slot.state} className={cn(slot.state === 'on' && 'num')}>
                      {slotWord(slot.state, slot.rank, '路由')}
                    </span>
                  </>
                ) : null}
                {effort ? (
                  <span data-route-effort-word title="这条路配的思考档位上限；点开这条路由能改">
                    {' · '}档位上限 <span className="num">{effort}</span>
                  </span>
                ) : null}
                {/* 整池暂停不另贴小标签：名字后面的状态已经写「池暂停」（#1914 第 4 轮，原来写两遍） */}
              </Text>
            </span>
          </span>
        </RowButton>
        <span className="shrink-0">
          <Stack direction="horizontal" gap="sm" align="center">
            {channelOff ? (
              <Text size="meta" tone="muted" title="渠道关了，这里不能单独开">
                渠道已关
              </Text>
            ) : (
              <RouteSwitch
                label={name}
                enabled={r.enabled}
                lockedWhy={lockWhy}
                onToggle={() =>
                  edit.toggleRoute({
                    modelId,
                    modelName,
                    routeId: r.routeId,
                    routeName: name,
                    enabled: r.enabled,
                  })
                }
              />
            )}
            {rowControls ? (
              <RowMenu label={`更多操作：${rowControls.moves.label}`} title={ROW_MENU_TITLE}>
                <RowMoveItems moves={rowControls.moves} />
                {onShare && prev ? (
                  <RowMenuItem disabled={shareOff} onSelect={() => void joinPrevious()}>
                    和上一条同一档
                  </RowMenuItem>
                ) : null}
                {onShare && r.shareBand !== undefined ? (
                  <RowMenuItem
                    disabled={shareOff}
                    onSelect={() =>
                      void onShare(r.routeId, {
                        shareBand: null,
                        shareWeight: 1,
                        expectedVersion: shareVersionNow,
                      })
                    }
                  >
                    单独成档
                  </RowMenuItem>
                ) : null}
                {onShare && r.shareBand !== undefined
                  ? [1, 2, 3, 4].map((w) => (
                      <RowMenuItem
                        key={w}
                        disabled={shareOff || r.shareWeight === w}
                        onSelect={() =>
                          void onShare(r.routeId, {
                            shareBand: r.shareBand ?? 0,
                            shareWeight: w,
                            expectedVersion: shareVersionNow,
                          })
                        }
                      >
                        权重 {w}
                      </RowMenuItem>
                    ))
                  : null}
              </RowMenu>
            ) : null}
          </Stack>
        </span>
      </RowFrame>
      {backoff || poolProblem ? (
        <RowDetail>
          <Stack gap="sm">
            {backoff ? (
              <div data-probe-backoff>
                <Text
                  size="meta"
                  tone={backoff.tone === 'fail' ? 'danger' : 'warning'}
                  strong={backoff.tone === 'fail'}
                  as="p"
                >
                  {backoff.text}
                </Text>
              </div>
            ) : null}
            {poolProblem ? <PoolProblemLine problem={poolProblem} now={now} /> : null}
          </Stack>
        </RowDetail>
      ) : null}
      <RowDetail id={factsId} hidden={!open}>
        <Stack gap="md">
          <Text size="meta" tone="muted" as="p">
            路由编号 <Code>{r.routeId}</Code>
          </Text>
          <Grid cols={3}>
            <Fact label="接得上" fact={r.connect} red={kind === 'fault' || kind === 'interrupted'}>
              {r.probedAt ? (
                stale ? (
                  <Text size="meta" tone="danger">
                    检测中断：{formatAgo(r.probedAt, now)}的结论，晚于下次探测时刻 20 分钟还没探，探针可能停了
                  </Text>
                ) : (
                  <>{formatAgo(r.probedAt, now)}探的</>
                )
              ) : null}{' '}
              <Button variant="text" size="xs" href={`/routing/status?p=${encodeURIComponent(r.channelId)}`}>
                原文、立即探测
              </Button>
            </Fact>
            <Fact label="额度够" fact={r.quota}>
              {r.exhausted.length > 0
                ? r.exhausted.map((w) => (
                    <span key={w.label} className="block">
                      {w.label}：{w.resetsAt ? `${formatIn(w.resetsAt, now)}清零` : '清零时刻没读到'}
                    </span>
                  ))
                : null}
            </Fact>
            <Fact label="禁令与开关" fact={r.ban} />
          </Grid>
          {/* 思考档位按「模型 × 路由」配，就在这条路由上改（#1914 第 5 轮）。展开了才读、才画 */}
          {open ? (
            <RouteEffortField modelId={modelId} modelName={modelName} routeId={r.routeId} routeName={name} />
          ) : null}
        </Stack>
      </RowDetail>
    </>
  );
}

/** 三件事各自的结论词：没过的不叫「死」，只有「接得上」没过、而且整条路由是故障时才画红，额度、禁令没过是暂时挡着。 */
const FACT_WORD = { live: '通过', dead: '没过', unknown: '不知道' } as const;

function Fact({
  label,
  fact,
  red = false,
  children,
}: {
  label: string;
  fact: LivenessFact;
  /** 没过的这件事可以画红（只有故障那条路由的「接得上」）。 */
  red?: boolean;
  children?: ReactNode;
}) {
  const level = fact.verdict === 'live' ? 'success' : fact.verdict === 'dead' && red ? 'error' : 'warning';
  return (
    <Stack gap="sm">
      <Text size="meta" tone="muted">
        {label}
      </Text>
      <Stack direction="horizontal" gap="sm" align="center">
        <LevelDot level={level} />
        {/* 过了的一件用灰字，没过的（死、不知道）才上色：一眼先看到卡在哪 */}
        <span className="min-w-0 break-words">
          <Text tone={level === 'success' ? 'muted' : level === 'error' ? 'danger' : 'warning'}>
            <span className="sr-only">{FACT_WORD[fact.verdict]}：</span>
            {fact.reason}
          </Text>
        </span>
      </Stack>
      {children ? (
        <Text size="meta" tone="muted" as="div">
          {children}
        </Text>
      ) : null}
    </Stack>
  );
}
