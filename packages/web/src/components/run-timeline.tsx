import type { Routing, Run } from '../api/types';
import { stageLabel } from '../lib/catalog';
import { formatClock, formatCount, formatDuration, formatUsd } from '../lib/format';
import { isRunning, queueMs, type Tone, toneBg, workMs } from '../lib/status';
import { cn } from '../lib/utils';
import { RouteLabel } from './route-label';

function runTone(run: Run): Tone {
  if (!run.endedAt) return run.startedAt ? 'run' : 'wait';
  switch (run.outcome) {
    case 'ok':
      return 'done';
    case 'failed':
      return 'fail';
    case 'stalled':
      return 'stall';
    case 'stopped':
      return 'stop';
    default:
      return 'wait';
  }
}

const outcomeText: Record<string, string> = { ok: '完成', failed: '失败', stopped: '停了', stalled: '停滞' };

/**
 * 会话时间线：一行一个会话，同一条时间轴。斜纹是排队，实色是干活——两段分开计时，
 * 一眼看出时间花在等空位上还是花在干活上。
 */
export function RunTimeline({
  runs,
  routing,
  now,
}: {
  runs: Run[];
  routing: Routing | undefined;
  now: number;
}) {
  if (!runs.length) return <p className="text-sm text-muted-foreground">还没有会话。</p>;
  const sorted = [...runs].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const start = Math.min(...sorted.map((r) => Date.parse(r.queuedAt)));
  const end = Math.max(...sorted.map((r) => (r.endedAt ? Date.parse(r.endedAt) : now)), now - 1000);
  const total = Math.max(1, end - start);
  const pct = (t: number) => `${((t - start) / total) * 100}%`;
  const width = (a: number, b: number) => `${Math.max(0.6, ((b - a) / total) * 100)}%`;
  const live = sorted.some((r) => !r.endedAt);

  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] text-muted-foreground md:pl-[172px]">
        <span className="num">{formatClock(new Date(start).toISOString())}</span>
        <span className="num">{live ? '现在' : formatClock(new Date(end).toISOString())}</span>
      </div>
      <ol className="space-y-2.5">
        {sorted.map((r) => {
          const q0 = Date.parse(r.queuedAt);
          const s0 = r.startedAt ? Date.parse(r.startedAt) : undefined;
          const e0 = r.endedAt ? Date.parse(r.endedAt) : now;
          const tone = runTone(r);
          const running = isRunning(r);
          const tokens = (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
          return (
            <li key={r.id} className="grid gap-x-3 gap-y-1 md:grid-cols-[160px_1fr]">
              <div className="min-w-0 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">{stageLabel[r.stage]}</span>
                  <span
                    className={cn(
                      'rounded px-1 text-[10px]',
                      running ? 'bg-st-run/15 text-st-run' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {running ? '在跑' : r.startedAt ? (outcomeText[r.outcome ?? ''] ?? '结束') : '排队中'}
                  </span>
                </div>
                <RouteLabel
                  routing={routing}
                  routeId={r.routeId}
                  modelName={r.modelName}
                  className="mt-0.5 text-xs"
                />
              </div>
              <div className="min-w-0">
                <div className="relative h-5 rounded-md bg-muted/60">
                  <div
                    className="absolute inset-y-1 rounded-sm bg-[repeating-linear-gradient(135deg,var(--border-strong)_0_3px,transparent_3px_7px)]"
                    style={{ left: pct(q0), width: width(q0, s0 ?? now) }}
                    title={`排队 ${formatDuration(queueMs(r, now))}`}
                  />
                  {s0 !== undefined ? (
                    <div
                      className={cn('absolute inset-y-0.5 rounded-sm', toneBg[tone], running && 'fd-sweep')}
                      style={{ left: pct(s0), width: width(s0, e0) }}
                      title={`干活 ${formatDuration(workMs(r, now))}`}
                    />
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                  <span>
                    排队 <span className="num text-foreground">{formatDuration(queueMs(r, now))}</span>
                  </span>
                  <span>
                    干活{' '}
                    <span className="num text-foreground">
                      {r.startedAt ? formatDuration(workMs(r, now)) : '—'}
                    </span>
                  </span>
                  {tokens ? (
                    <span>
                      <span className="num text-foreground">{formatCount(tokens)}</span> token
                    </span>
                  ) : null}
                  {r.costUsd ? (
                    <span>
                      花了 <span className="num text-foreground">{formatUsd(r.costUsd)}</span>
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">为什么派给它：{r.whyRoute}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
