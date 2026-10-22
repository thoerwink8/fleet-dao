// 渠道详情里的「探测记录」（#1638，照 Arco 迁 #3533）：这个渠道每条路由的每一次探测，新的在上。
// 改这里之前必须知道：
// - 一行 = 一次探测（探针历史里的一格）。点格子和点这一行开的是同一个详情，展开哪一行由页面（focus 的那一格）定。
// - 数据是近 60 格加每条路由自己的最近一次（lib/probe-history-view.ts 的 probeLogRows），不另加接口；
//   所以这里写「最近 60 次」，不写「全部」。
// - 疑似换模型 = 身份题说出了旧答案：橙色，和不通的红分开。每行带种类（连通 / 身份题）和触发者（定时、派前、人点、断链、切号）；
//   身份题那行展开有题、新答案、旧答案、实答、自报身份。老记录（算术题时代）照原样显示，标「旧版降智题」。
// - 读不到写「没读成」和原因，不画空列表；读成了但没有才写「还没有探测记录」。
// - 一行一个状态（走字典 route:probe:*），行间只有细线，展开区不再套框。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { useEffect, useState } from 'react';
import type { Model, ProbeHistoryCell, Route } from '../api/types';
import { formatDateTime } from '../lib/format';
import {
  formatProbeMs,
  isLegacyQuizCell,
  PROBE_KIND_WORD,
  type ProbeKind,
  probeCellSource,
  probeKind,
  probeLogRows,
  quotaResetText,
  splitProbeRows,
} from '../lib/probe-history-view';
import { type ChannelHistory, probeKindStatus } from './channel-status';
import { Button } from './layout/button';
import { Code } from './layout/code';
import { Descriptions, type DescriptionsItem } from './layout/descriptions';
import { EmptyState } from './layout/empty-state';
import { List, ListRow } from './layout/list';
import { Notice } from './layout/notice';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
import { Text } from './layout/text';

/** 探测记录默认铺几条、每次「再看」加几条（#1837：一次铺 60 条，渠道状态页整页 13000px）。 */
export const PROBE_LOG_FIRST = 10;
export const PROBE_LOG_STEP = 20;

/** 图例：颜色（格子只有灰、橙、红、空心四档）加这一类是什么意思。 */
const LEGEND: readonly (readonly [ProbeKind, string, string])[] = [
  ['passed', '灰', '探通了'],
  ['quota', '橙', '探通了，但上游说额度用完了'],
  ['failed', '红', '没探通'],
  ['doubt', '橙', '身份题说出了旧答案'],
  ['not_probed', '空心', '这轮没真探'],
];

export function ProbeLog({
  history,
  channelId,
  routes,
  models,
  openId,
  routeMissing,
  onToggle,
}: {
  history: ChannelHistory;
  channelId: string;
  routes: readonly Route[];
  models: readonly Model[];
  /** 展开的那一次；没有就都折叠。 */
  openId: number | undefined;
  routeMissing: boolean;
  onToggle: (cellId: number) => void;
}) {
  // 默认只铺最近 10 条，「再看 20 条」每点一次多 20 条；展开的那一行落在后面时，铺到它为止
  const [extra, setExtra] = useState(0);
  if (history.state === 'loading') return null;
  if (history.state === 'unreadable') {
    return (
      <section aria-label="探测记录">
        <div data-probe-log="unreadable">
          <Notice tone="fail">探测记录没读成。{history.why}</Notice>
        </div>
      </section>
    );
  }
  const strip = history.channels.find((item) => item.channelId === channelId);
  const { real, skipped } = splitProbeRows(
    probeLogRows(
      (strip?.cells ?? []).slice(-PROBE_HISTORY_SLOTS),
      history.latestByRoute,
      channelId,
      strip?.skipped ?? [],
    ),
  );
  const rows = real;
  const openIndex = rows.findIndex((cell) => cell.id === openId);
  const shownCount = Math.max(PROBE_LOG_FIRST + extra, openIndex + 1);
  const modelNameOf = (cell: ProbeHistoryCell) =>
    models.find((m) => m.id === routes.find((r) => r.id === cell.routeId)?.modelId)?.displayName;
  return (
    // 标题和「最近 60 次真探、从新到旧、点一行看原文」那句说明在外面的区块头上，这里不再写一遍
    <section aria-label="探测记录">
      <Stack gap="md">
        <List divided={false} data-probe-log="legend" aria-label="图例">
          {LEGEND.map(([kind, color, hint]) => (
            <li key={kind}>
              <Text size="meta" tone="muted">
                {color}　{PROBE_KIND_WORD[kind].label}：{hint}
              </Text>
            </li>
          ))}
        </List>
        {routeMissing ? (
          <Text size="meta" tone="warning">
            这条路由还没有探针历史
          </Text>
        ) : null}
        {rows.length === 0 ? (
          <div role="status" data-probe-log="empty">
            <EmptyState
              size="inline"
              title={
                skipped.length > 0
                  ? `最近没有真探过：只有 ${skipped.length} 条没探的记录，折在下面`
                  : '还没有探测记录'
              }
            />
          </div>
        ) : (
          <>
            <div className="max-h-routing-pane overflow-y-auto">
              <List data-probe-log="list" aria-label="探测记录列表">
                {rows.slice(0, shownCount).map((cell) => (
                  <ProbeLogRow
                    key={cell.id}
                    cell={cell}
                    modelName={modelNameOf(cell)}
                    open={cell.id === openId}
                    onToggle={() => onToggle(cell.id)}
                  />
                ))}
              </List>
            </div>
            {rows.length > shownCount ? (
              <div>
                <Button
                  variant="text"
                  size="xs"
                  data-probe-log="more"
                  onClick={() => setExtra(shownCount - PROBE_LOG_FIRST + PROBE_LOG_STEP)}
                >
                  再看 {Math.min(PROBE_LOG_STEP, rows.length - shownCount)} 条（还有{' '}
                  {rows.length - shownCount} 条没显示）
                </Button>
              </div>
            ) : null}
          </>
        )}
        {skipped.length > 0 ? (
          <SkippedFold skipped={skipped} openId={openId} modelNameOf={modelNameOf} onToggle={onToggle} />
        ) : null}
      </Stack>
    </section>
  );
}

/** 没真探的记录（没探）折起来：点开才看；从格子或「看最近一次」点进来的恰好是其中一条时自动展开。 */
function SkippedFold({
  skipped,
  openId,
  modelNameOf,
  onToggle,
}: {
  skipped: readonly ProbeHistoryCell[];
  openId: number | undefined;
  modelNameOf: (cell: ProbeHistoryCell) => string | undefined;
  onToggle: (cellId: number) => void;
}) {
  const wanted = openId !== undefined && skipped.some((c) => c.id === openId);
  const [shown, setShown] = useState(false);
  const expanded = shown || wanted;
  return (
    <div data-probe-log="skipped">
      <Stack gap="sm">
        <div>
          <Button
            variant="text"
            size="xs"
            aria-expanded={expanded}
            aria-controls="probe-log-skipped"
            onClick={() => setShown(!expanded)}
          >
            {skipped.length} 条没真探的记录（没探），{expanded ? '收起' : '点开看'}
          </Button>
        </div>
        {expanded ? (
          <div id="probe-log-skipped" className="max-h-routing-pane overflow-y-auto">
            <List aria-label="没真探的记录">
              {skipped.map((cell) => (
                <ProbeLogRow
                  key={cell.id}
                  cell={cell}
                  modelName={modelNameOf(cell)}
                  open={cell.id === openId}
                  onToggle={() => onToggle(cell.id)}
                />
              ))}
            </List>
          </div>
        ) : null}
      </Stack>
    </div>
  );
}

function ProbeLogRow({
  cell,
  modelName,
  open,
  onToggle,
}: {
  cell: ProbeHistoryCell;
  modelName: string | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = probeKind(cell);
  // 从格子点进来：把这一行带到眼前
  useEffect(() => {
    if (open) document.querySelector(`[data-probe-row="${cell.id}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, cell.id]);
  const hasCheck = cell.checkQuestion !== null;
  const source = probeCellSource(cell);
  const legacy = isLegacyQuizCell(cell);
  return (
    <ListRow
      data-probe-row={cell.id}
      data-result={kind}
      expandable
      open={open}
      onOpenChange={onToggle}
      rowLabel={`${formatDateTime(cell.probedAt)} ${modelName ?? cell.routeId} ${cell.routeId}${source ? ` ${source}` : ''}`}
      // 一行不折：结论、时刻、模型名、路由号（放不下截断）、来源、耗时；手机上来源收进展开
      summary={
        <span className="min-w-0 flex-1">
          <Stack direction="horizontal" gap="md" align="center">
            <StatusBadge status={probeKindStatus(kind)} variant="dot" />
            <Text size="meta" tone="muted">
              {formatDateTime(cell.probedAt)}
            </Text>
            <Text strong>{modelName ?? cell.routeId}</Text>
            <span className="min-w-0 flex-1">
              <Text size="meta" tone="muted" truncate>
                {cell.routeId}
              </Text>
            </span>
            {source || legacy ? (
              <span data-field="source" className="max-md:hidden">
                <Stack direction="horizontal" gap="sm" align="center">
                  {source}
                  {legacy ? (
                    <span data-field="legacy" title="算术题时代的老记录，照原样显示">
                      <Tag>旧版降智题</Tag>
                    </span>
                  ) : null}
                </Stack>
              </span>
            ) : null}
            <Text size="meta">{formatProbeMs(cell.durationMs, cell.result)}</Text>
          </Stack>
        </span>
      }
      details={
        <Stack gap="md">
          {source || legacy ? (
            // 行上的来源（种类、触发者）手机上放不下：展开后写在这里
            <span data-field="source-narrow" className="md:hidden">
              <Text size="meta" tone="muted">
                {source}
                {legacy ? '（旧版降智题）' : null}
              </Text>
            </span>
          ) : null}
          {hasCheck || cell.selfIdentity !== null ? (
            <div data-field="check">
              <Descriptions columns={2} items={checkItems(cell)} />
            </div>
          ) : null}
          {kind === 'quota' ? (
            <div data-field="quota">
              <Notice tone="stall">
                连通但额度耗尽：{cell.detail ?? '（上游没写具体原因）'}
                <div data-field="resets" className="num">
                  {quotaResetText(cell.resetsAt)}
                </div>
              </Notice>
            </div>
          ) : kind === 'passed' && cell.detail ? (
            <div data-field="detail">
              <Text size="meta" tone="muted">
                {cell.detail}
              </Text>
            </div>
          ) : null}
          {kind === 'failed' ? (
            <div data-field="failure">
              <Notice tone="fail">失败原因：{cell.failureReason ?? '（没写原因）'}</Notice>
            </div>
          ) : null}
          {kind === 'doubt' ? (
            <div data-field="failure" data-tone="doubt">
              <Notice tone="stall">疑似换模型：{cell.failureReason ?? '身份题说出了旧答案'}</Notice>
            </div>
          ) : null}
          {kind === 'not_probed' ? (
            <div data-field="failure">
              <Text size="meta" tone="muted">
                {PROBE_KIND_WORD[kind].label}：{cell.failureReason ?? '（没写原因）'}
              </Text>
            </div>
          ) : null}
          <ProbeText label="请求原文" field="request" text={cell.requestText} empty="（没发出去）" />
          <ProbeText label="响应原文" field="response" text={cell.responseText} empty="（没拿到）" />
        </Stack>
      }
    />
  );
}

/** 身份题展开里的键值：题、新答案、旧答案、实答、自报身份。说中旧答案的那几项标疑似换模型的橙色。 */
function checkItems(cell: ProbeHistoryCell): DescriptionsItem[] {
  const items: DescriptionsItem[] = [];
  const hit = cell.checkPassed === false;
  const hot = (field: string, text: string) => (
    <span data-field={field}>
      <Text strong={hit} tone={hit ? 'warning' : 'default'}>
        {text}
      </Text>
    </span>
  );
  if (cell.checkQuestion !== null) {
    items.push({ label: '题', value: <span data-field="question">{cell.checkQuestion}</span> });
    items.push({
      label: '新答案',
      value: <span data-field="expected">{cell.checkExpected ?? '（没有）'}</span>,
    });
    if (cell.kind === 'identity') {
      items.push({
        label: '旧答案',
        value: hot(
          'old',
          cell.checkOldAnswer ? cell.checkOldAnswer : hit ? '实答命中了旧答案' : '这条记录里没有旧答案',
        ),
      });
    }
    items.push({ label: '实答', value: hot('answer', cell.checkAnswer ?? '（没答）') });
  }
  if (cell.selfIdentity !== null) {
    items.push({ label: '自报身份', value: <span data-field="identity">{cell.selfIdentity}</span> });
  }
  return items;
}

function ProbeText({
  label,
  field,
  text,
  empty,
}: {
  label: string;
  field: string;
  text: string | null;
  empty: string;
}) {
  return (
    <Stack gap="sm">
      <Text size="meta" tone="muted">
        {label}
      </Text>
      <div data-field={field}>
        <Code block>{text ?? empty}</Code>
      </div>
    </Stack>
  );
}
