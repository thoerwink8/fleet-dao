// 渠道详情里的「探测记录」（#1638）：这个渠道每条路由的每一次探测，新的在上。
// 改这里之前必须知道：
// - 一行 = 一次探测（探针历史里的一格）。点格子和点这一行开的是同一个详情，展开哪一行由页面（focus 的那一格）定。
// - 数据是近 60 格加每条路由自己的最近一次（lib/probe-history-view.ts 的 probeLogRows），不另加接口；
//   所以这里写「最近 60 次」，不写「全部」。
// - 疑似换模型 = 身份题说出了旧答案：橙色，和不通的红分开。每行带种类（连通 / 身份题）和触发者（定时、派前、人点、断链、切号）；
//   身份题那行展开有题、新答案、旧答案、实答、自报身份。老记录（算术题时代）照原样显示，标「旧版降智题」。
// - 读不到写「没读成」和原因，不画空列表；读成了但没有才写「还没有探测记录」。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Model, ProbeHistoryCell, Route } from '../api/types';
import { formatDateTime } from '../lib/format';
import {
  formatProbeMs,
  isLegacyQuizCell,
  PROBE_KIND_BG,
  PROBE_KIND_WORD,
  type ProbeKind,
  probeCellSource,
  probeKind,
  probeLogRows,
  quotaResetText,
  splitProbeRows,
} from '../lib/probe-history-view';
import { cn } from '../lib/utils';
import type { ChannelHistory } from './channel-status';
import { EmptyState } from './layout/empty-state';
import { KeyValue, type KeyValueItem } from './layout/key-value';
import { Notice } from './layout/notice';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';

/** 探测记录默认铺几条、每次「再看」加几条（#1837：一次铺 60 条，渠道状态页整页 13000px）。 */
export const PROBE_LOG_FIRST = 10;
export const PROBE_LOG_STEP = 20;

const LEGEND: readonly (readonly [ProbeKind, string])[] = [
  ['passed', '探通了'],
  ['quota', '探通了，但上游说额度用完了'],
  ['failed', '没探通'],
  ['doubt', '身份题说出了旧答案'],
  ['not_probed', '这轮没真探'],
];

/** 结论标签。疑似换模型没有状态色，用橙色（st-doubt）。 */
export function ProbeKindChip({ kind }: { kind: ProbeKind }) {
  const word = PROBE_KIND_WORD[kind];
  return <StatusBadge tone={word.tone} label={word.label} />;
}

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
      <section aria-label="探测记录" className="mb-4">
        <p role="alert" data-probe-log="unreadable" className="text-body text-ink-fail">
          探测记录没读成。{history.why}
        </p>
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
    // 标题和「最近 60 次真探、从新到旧、点一行看原文」那句说明在外面的区块头上（渠道状态页 #1922），这里不再写一遍
    <section aria-label="探测记录" className="mt-3">
      <ul
        data-probe-log="legend"
        aria-label="图例"
        className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted-foreground"
      >
        {LEGEND.map(([kind, hint]) => (
          <li key={kind} className="inline-flex items-center gap-1">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-sm', PROBE_KIND_BG[kind])} />
            {PROBE_KIND_WORD[kind].label}：{hint}
          </li>
        ))}
      </ul>
      {routeMissing ? <p className="mb-2 text-meta text-ink-stall">这条路由还没有探针历史</p> : null}
      {rows.length === 0 ? (
        <div role="status" data-probe-log="empty" className="border-y">
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
          {/* 一行一次探测，行间只有细线，不再一行一个圆角框（样板 #1914） */}
          <ol
            data-probe-log="list"
            aria-label="探测记录列表"
            className="max-h-routing-pane divide-y divide-border overflow-y-auto border-y"
          >
            {rows.slice(0, shownCount).map((cell) => (
              <ProbeLogRow
                key={cell.id}
                cell={cell}
                modelName={modelNameOf(cell)}
                open={cell.id === openId}
                onToggle={() => onToggle(cell.id)}
              />
            ))}
          </ol>
          {rows.length > shownCount ? (
            <button
              type="button"
              data-probe-log="more"
              onClick={() => setExtra(shownCount - PROBE_LOG_FIRST + PROBE_LOG_STEP)}
              className="mt-1.5 inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-meta text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              再看 {Math.min(PROBE_LOG_STEP, rows.length - shownCount)} 条（还有 {rows.length - shownCount}{' '}
              条没显示）
            </button>
          ) : null}
        </>
      )}
      {skipped.length > 0 ? (
        <SkippedFold skipped={skipped} openId={openId} modelNameOf={modelNameOf} onToggle={onToggle} />
      ) : null}
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
    <div data-probe-log="skipped" className="mt-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="probe-log-skipped"
        onClick={() => setShown(!expanded)}
        className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 max-md:min-h-10 text-meta text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden />
        {skipped.length} 条没真探的记录（没探），{expanded ? '收起' : '点开看'}
      </button>
      {expanded ? (
        <ol
          id="probe-log-skipped"
          aria-label="没真探的记录"
          className="mt-1.5 max-h-routing-pane divide-y divide-border overflow-y-auto border-y"
        >
          {skipped.map((cell) => (
            <ProbeLogRow
              key={cell.id}
              cell={cell}
              modelName={modelNameOf(cell)}
              open={cell.id === openId}
              onToggle={() => onToggle(cell.id)}
            />
          ))}
        </ol>
      ) : null}
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
  const bodyId = `probe-body-${cell.id}`;
  const ref = useRef<HTMLLIElement>(null);
  // 从格子点进来：把这一行带到眼前
  useEffect(() => {
    if (open) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  const hasCheck = cell.checkQuestion !== null;
  const source = probeCellSource(cell);
  const legacy = isLegacyQuizCell(cell);
  return (
    <li
      ref={ref}
      data-probe-row={cell.id}
      data-result={kind}
      // 行间细线、展开或选中的那行铺选中底，不再一行一个描色的圆角框；结论靠行首的状态（点加字）说
      className={cn('min-w-0', open && 'bg-selected')}
    >
      {/* 一行不折：结论、时刻、模型名、路由号（放不下截断）、来源、耗时；手机上来源收进展开 */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        title={`${formatDateTime(cell.probedAt)} ${modelName ?? cell.routeId} ${cell.routeId}${source ? ` ${source}` : ''}`}
        className="flex min-h-10 w-full items-center gap-2 whitespace-nowrap px-2 py-1.5 text-left hover:bg-accent max-md:min-h-11"
      >
        <span className="w-36 shrink-0">
          <StatusBadge tone={PROBE_KIND_WORD[kind].tone} label={PROBE_KIND_WORD[kind].label} variant="dot" />
        </span>
        <span className="num shrink-0 text-meta text-muted-foreground">{formatDateTime(cell.probedAt)}</span>
        <span className="shrink-0 text-body font-medium">{modelName ?? cell.routeId}</span>
        <span className="num min-w-0 flex-1 truncate text-meta text-muted-foreground">{cell.routeId}</span>
        {source || legacy ? (
          <span
            data-field="source"
            className="inline-flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground max-md:hidden"
          >
            {source}
            {legacy ? (
              <span data-field="legacy" title="算术题时代的老记录，照原样显示">
                <Tag>旧版降智题</Tag>
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="num shrink-0 text-meta">{formatProbeMs(cell.durationMs, cell.result)}</span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={bodyId} className="min-w-0 px-2 pb-3 pt-1">
          {source || legacy ? (
            // 行上的来源（种类、触发者）手机上放不下：展开后写在这里
            <p data-field="source-narrow" className="mb-2 text-meta text-muted-foreground md:hidden">
              {source}
              {legacy ? '（旧版降智题）' : null}
            </p>
          ) : null}
          {hasCheck || cell.selfIdentity !== null ? (
            <div data-field="check" className="mb-3">
              <KeyValue layout="grid" cols={2} items={checkItems(cell)} />
            </div>
          ) : null}
          {kind === 'quota' ? (
            <div data-field="quota" className="break-words">
              <Notice tone="stall">
                连通但额度耗尽：{cell.detail ?? '（上游没写具体原因）'}
                <span data-field="resets" className="num block">
                  {quotaResetText(cell.resetsAt)}
                </span>
              </Notice>
            </div>
          ) : kind === 'passed' && cell.detail ? (
            <p data-field="detail" className="break-words text-meta text-muted-foreground">
              {cell.detail}
            </p>
          ) : null}
          {kind === 'failed' ? (
            <div data-field="failure" className="break-words">
              <Notice tone="fail">失败原因：{cell.failureReason ?? '（没写原因）'}</Notice>
            </div>
          ) : null}
          {kind === 'doubt' ? (
            <p
              data-field="failure"
              data-tone="doubt"
              className="break-words rounded-md border border-st-doubt-line bg-st-doubt-soft px-3 py-2 text-body text-ink-doubt"
            >
              疑似换模型：{cell.failureReason ?? '身份题说出了旧答案'}
            </p>
          ) : null}
          {kind === 'not_probed' ? (
            <p data-field="failure" className="break-words text-meta text-muted-foreground">
              {PROBE_KIND_WORD[kind].label}：{cell.failureReason ?? '（没写原因）'}
            </p>
          ) : null}
          <ProbeText
            label="请求原文（REQUEST）"
            field="request"
            text={cell.requestText}
            empty="（没发出去）"
          />
          <ProbeText
            label="响应原文（RESPONSE）"
            field="response"
            text={cell.responseText}
            empty="（没拿到）"
          />
        </div>
      ) : null}
    </li>
  );
}

/** 身份题展开里的键值：题、新答案、旧答案、实答、自报身份。说中旧答案的那几项标疑似换模型的橙色。 */
function checkItems(cell: ProbeHistoryCell): KeyValueItem[] {
  const items: KeyValueItem[] = [];
  const hit = cell.checkPassed === false;
  if (cell.checkQuestion !== null) {
    items.push({ label: '题', value: <span data-field="question">{cell.checkQuestion}</span> });
    items.push({
      label: '新答案',
      value: <span data-field="expected">{cell.checkExpected ?? '（没有）'}</span>,
    });
    if (cell.kind === 'identity') {
      items.push({
        label: '旧答案',
        ...(hit ? { tone: 'doubt' as const } : {}),
        value: (
          <span data-field="old" className={cn(hit && 'font-medium')}>
            {cell.checkOldAnswer ? cell.checkOldAnswer : hit ? '实答命中了旧答案' : '这条记录里没有旧答案'}
          </span>
        ),
      });
    }
    items.push({
      label: '实答',
      ...(hit ? { tone: 'doubt' as const } : {}),
      value: (
        <span data-field="answer" className={cn(hit && 'font-medium')}>
          {cell.checkAnswer ?? '（没答）'}
        </span>
      ),
    });
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
    <div className="mt-2.5 min-w-0">
      <div className="mb-1 text-meta text-muted-foreground">{label}</div>
      <pre
        data-field={field}
        className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted px-2.5 py-2 font-mono text-meta text-muted-foreground"
      >
        {text ?? empty}
      </pre>
    </div>
  );
}
