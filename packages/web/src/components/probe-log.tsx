// 渠道详情里的「探测记录」（#1638）：这个渠道每条路由的每一次探测，新的在上。
// 改这里之前必须知道：
// - 一行 = 一次探测（探针历史里的一格）。点格子和点这一行开的是同一个详情，展开哪一行由页面（focus 的那一格）定。
// - 数据是近 60 格加每条路由自己的最近一次（lib/probe-history-view.ts 的 probeLogRows），不另加接口；
//   所以这里写「最近 60 次」，不写「全部」。
// - 疑似降智 = 探通了但降智题答错：橙色，和不通的红分开。有题就写题、标准答案、实答，有自报身份就写身份。
// - 读不到写「没读成」和原因，不画空列表；读成了但没有才写「还没有探测记录」。

import { PROBE_HISTORY_SLOTS } from '@fleet-dao/shared';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Model, ProbeHistoryCell, Route } from '../api/types';
import { formatDateTime } from '../lib/format';
import {
  formatProbeMs,
  PROBE_KIND_BG,
  PROBE_KIND_WORD,
  type ProbeKind,
  probeKind,
  probeLogRows,
} from '../lib/probe-history-view';
import { cn } from '../lib/utils';
import type { ChannelHistory } from './channel-status';
import { StatusChip } from './status';

const LEGEND: readonly (readonly [ProbeKind, string])[] = [
  ['passed', '探通了'],
  ['failed', '没探通'],
  ['doubt', '探通了但降智题答错'],
  ['not_probed', '这轮没真探'],
  ['on_demand', '不主动探，要派给它时才探'],
];

/** 结论标签。疑似降智没有状态色，用橙色（st-doubt）。 */
export function ProbeKindChip({ kind }: { kind: ProbeKind }) {
  const word = PROBE_KIND_WORD[kind];
  if (word.tone !== 'doubt') return <StatusChip tone={word.tone} label={word.label} />;
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-st-doubt/15 px-1.5 text-caption font-medium leading-none whitespace-nowrap text-ink-doubt">
      <TriangleAlert className="size-3" aria-hidden />
      {word.label}
    </span>
  );
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
  if (history.state === 'loading') return null;
  if (history.state === 'unreadable') {
    return (
      <section aria-label="探测记录" className="mb-4">
        <p role="alert" data-probe-log="unreadable" className="text-sub text-ink-fail">
          探测记录没读成。{history.why}
        </p>
      </section>
    );
  }
  const strip = history.channels.find((item) => item.channelId === channelId);
  const rows = probeLogRows(
    (strip?.cells ?? []).slice(-PROBE_HISTORY_SLOTS),
    history.latestByRoute,
    channelId,
  );
  return (
    <section aria-label="探测记录" className="mb-4">
      <h3 className="text-sub font-semibold">探测记录</h3>
      <p className="mb-2 text-caption text-muted-foreground">
        最近 60 次，从新到旧；每条路由自己的最近一次也在里面。点一行看请求和响应原文。
      </p>
      <ul
        data-probe-log="legend"
        aria-label="图例"
        className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-micro text-faint"
      >
        {LEGEND.map(([kind, hint]) => (
          <li key={kind} className="inline-flex items-center gap-1">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-2', PROBE_KIND_BG[kind])} />
            {PROBE_KIND_WORD[kind].label}：{hint}
          </li>
        ))}
      </ul>
      {routeMissing ? <p className="mb-2 text-caption text-ink-stall">这条路由还没有探针历史</p> : null}
      {rows.length === 0 ? (
        <p
          role="status"
          data-probe-log="empty"
          className="rounded-lg border border-dashed px-3 py-6 text-center text-sub text-muted-foreground"
        >
          还没有探测记录
        </p>
      ) : (
        <ol
          data-probe-log="list"
          aria-label="探测记录列表"
          className="max-h-routing-pane space-y-1.5 overflow-y-auto pr-1"
        >
          {rows.map((cell) => (
            <ProbeLogRow
              key={cell.id}
              cell={cell}
              modelName={
                models.find((m) => m.id === routes.find((r) => r.id === cell.routeId)?.modelId)?.displayName
              }
              open={cell.id === openId}
              onToggle={() => onToggle(cell.id)}
            />
          ))}
        </ol>
      )}
    </section>
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
  return (
    <li
      ref={ref}
      data-probe-row={cell.id}
      data-result={kind}
      className={cn(
        'min-w-0 rounded-lg border',
        kind === 'failed' && 'border-st-fail/40',
        kind === 'doubt' && 'border-st-doubt/50',
        open && 'ring-2 ring-ring/40',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex min-h-10 w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-left"
      >
        <ProbeKindChip kind={kind} />
        <span className="num text-caption text-muted-foreground">{formatDateTime(cell.probedAt)}</span>
        <span className="text-sm font-semibold">{modelName ?? cell.routeId}</span>
        <span className="num min-w-0 flex-1 basis-24 truncate text-caption text-muted-foreground">
          {cell.routeId}
        </span>
        <span className="num shrink-0 text-caption">{formatProbeMs(cell.durationMs, cell.result)}</span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {hasCheck || cell.selfIdentity !== null ? (
        <dl data-field="check" className="grid grid-cols-auto-fr gap-x-2 gap-y-0.5 px-3 pb-2 text-caption">
          {hasCheck ? (
            <>
              <dt className="text-muted-foreground">题</dt>
              <dd className="min-w-0 break-words">{cell.checkQuestion}</dd>
              <dt className="text-muted-foreground">标准答案</dt>
              <dd data-field="expected" className="min-w-0 break-words">
                {cell.checkExpected ?? '（没有）'}
              </dd>
              <dt className="text-muted-foreground">实答</dt>
              <dd
                data-field="answer"
                className={cn(
                  'min-w-0 break-words',
                  cell.checkPassed === false && 'font-medium text-ink-doubt',
                )}
              >
                {cell.checkAnswer ?? '（没答）'}
              </dd>
            </>
          ) : null}
          {cell.selfIdentity !== null ? (
            <>
              <dt className="text-muted-foreground">自报身份</dt>
              <dd data-field="identity" className="min-w-0 break-words">
                {cell.selfIdentity}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {open ? (
        <div id={bodyId} className="min-w-0 border-t px-3 pb-3 pt-2.5">
          {kind === 'failed' ? (
            <p
              role="alert"
              data-field="failure"
              className="break-words rounded-md border border-st-fail/40 bg-st-fail/10 px-2.5 py-2 text-sub text-ink-fail"
            >
              失败原因：{cell.failureReason ?? '（没写原因）'}
            </p>
          ) : null}
          {kind === 'doubt' ? (
            <p
              data-field="failure"
              className="break-words rounded-md border border-st-doubt/50 bg-st-doubt/10 px-2.5 py-2 text-sub text-ink-doubt"
            >
              疑似降智：{cell.failureReason ?? '降智题答错了'}
            </p>
          ) : null}
          {kind === 'not_probed' || kind === 'on_demand' ? (
            <p data-field="failure" className="break-words text-caption text-muted-foreground">
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
      <div className="mb-1 text-caption text-muted-foreground">{label}</div>
      <pre
        data-field={field}
        className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-micro text-muted-foreground"
      >
        {text ?? empty}
      </pre>
    </div>
  );
}
