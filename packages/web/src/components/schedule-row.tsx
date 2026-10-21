// 定时任务页的行和标题块（照路由页样板，#1914）：法国页的定时任务区块仍用 job-row 的多列行。
// 一行两层：名字加一个状态（点加字）；下面一行灰字写上次结果和周期。右边是上次跑成的相对时间。点开看明细（JobDetails）。
import { POLL_FAST_MS } from '../api/client';
import type { JobView } from '../api/types';
import { formatAgo, formatDateTime } from '../lib/format';
import { jobStatusLabel, outcomeText } from '../lib/schedule';
import { cn } from '../lib/utils';
import { JobDetails, rowTone } from './job-row';
import { ListRow } from './layout/list';
import { StatusBadge } from './layout/status-badge';
import type { LayoutTone } from './layout/tone';

/** 一行只放一个状态：失败、没查全、过期、从没跑成、在跑、按期。过期另外叠在前两种后面（「没查全，已过期」），不另贴标签。 */
export function jobBadge(j: JobView): { tone: LayoutTone; label: string } {
  const r = j.lastRun;
  const overdue = j.status === 'overdue' ? '，已过期' : '';
  if (r?.outcome === 'failed') return { tone: 'fail', label: `失败${overdue}` };
  if (r?.outcome === 'unscanned' || r?.outcome === 'partial')
    return { tone: 'stall', label: `没查全${overdue}` };
  if (j.status === 'overdue') return { tone: 'stall', label: '过期' };
  if (j.status === 'never') return { tone: 'stall', label: '从没跑成' };
  if (r && !r.endedAt) return { tone: 'run', label: '在跑' };
  return { tone: 'done', label: '按期' };
}

/** 异常行排最前（失败、再是没查全 / 过期），其余保持后端给的先后。 */
export function problemsFirst(jobs: readonly JobView[]): JobView[] {
  const rank = (j: JobView) => {
    const tone = rowTone(j);
    return tone === 'fail' ? 0 : tone === 'stall' ? 1 : 2;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b));
}

export function ScheduleRow({ j, now }: { j: JobView; now: number }) {
  const tone = rowTone(j);
  const r = j.lastRun;
  const badge = jobBadge(j);
  const outcome = outcomeText(j);
  const meta = `${outcome} · ${j.schedule}`;
  return (
    <ListRow
      expandable
      tall
      data-outcome={r?.outcome ?? (r ? 'running' : 'never')}
      data-status={j.status}
      rail={tone ?? undefined}
      summary={
        <>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2 whitespace-nowrap" data-row-name-line>
              <span className="min-w-0 truncate text-body font-medium" title={j.id}>
                {j.name}
              </span>
              <StatusBadge tone={badge.tone} label={badge.label} variant="dot" className="shrink-0" />
            </span>
            {/* 有问题的行把原因写全（可以折），正常的行一行截断、整句在悬停里（#1902）。 */}
            <span
              data-row-meta
              data-job-outcome={tone ? 'full' : 'truncate'}
              title={meta}
              className={cn('block text-meta text-muted-foreground', tone ? 'break-words' : 'truncate')}
            >
              <span
                className={cn(
                  tone === 'fail' && 'text-ink-fail',
                  tone === 'stall' && r?.outcome && r.outcome !== 'ok' && 'text-ink-stall',
                )}
              >
                {outcome}
              </span>
              <span className="num"> · {j.schedule}</span>
            </span>
          </span>
          <span
            className={cn(
              'num shrink-0 text-right text-meta whitespace-nowrap text-muted-foreground',
              j.status !== 'fresh' && 'font-medium text-ink-stall',
            )}
            title={j.lastSuccessAt ? `上次跑成：${formatDateTime(j.lastSuccessAt)}` : undefined}
            data-last-success-ago
          >
            {j.lastSuccessAt ? formatAgo(j.lastSuccessAt, now) : jobStatusLabel.never}
          </span>
        </>
      }
    >
      <JobDetails j={j} now={now} />
    </ListRow>
  );
}

/**
 * 页顶的标题块（照路由页的用途标题块）：几个定时任务一行（subtitle）；最要紧的一句结论加状态一行；
 * 各类异常的计数（或最近跑成的一个）一行灰字。三行都不折：放不下截断，整句在悬停里。
 */
export function SchedulesHero({ jobs, now }: { jobs: readonly JobView[]; now: number }) {
  const failed = jobs.filter((j) => j.lastRun?.outcome === 'failed');
  const unscanned = jobs.filter(
    (j) => j.lastRun?.outcome === 'unscanned' || j.lastRun?.outcome === 'partial',
  );
  const notFresh = jobs.filter((j) => j.status !== 'fresh');
  const stalled = jobs.filter((j) => rowTone(j) === 'stall');
  let verdict: { tone: LayoutTone; badge: string; text: string };
  const firstFail = failed[0];
  const firstStall = stalled[0];
  if (firstFail) {
    verdict = {
      tone: 'fail',
      badge: '要处理',
      text: `${firstFail.name}上次失败：${firstFail.lastRun?.why ?? '原因没记下'}`,
    };
  } else if (firstStall) {
    const o = firstStall.lastRun?.outcome;
    const what =
      o === 'unscanned' || o === 'partial'
        ? `这次没查全：${firstStall.lastRun?.why ?? '原因没记下'}`
        : firstStall.status === 'never'
          ? '从没跑成过'
          : '超过期望间隔没跑成';
    verdict = { tone: 'stall', badge: '要留意', text: `${firstStall.name}${what}` };
  } else {
    verdict = { tone: 'done', badge: '都正常', text: '全部按期跑成' };
  }
  const counts = [
    failed.length > 0 ? `上次失败 ${failed.length}` : null,
    unscanned.length > 0 ? `没查全 ${unscanned.length}` : null,
    notFresh.length > 0 ? `过期 ${notFresh.length}` : null,
  ].filter((x): x is string => x !== null);
  const latest = [...jobs]
    .filter((j) => j.lastSuccessAt)
    .sort((a, b) => Date.parse(b.lastSuccessAt ?? '') - Date.parse(a.lastSuccessAt ?? ''))[0];
  const notes =
    counts.length > 0
      ? counts.join(' · ')
      : latest?.lastSuccessAt
        ? `最近跑成：${latest.name} ${formatAgo(latest.lastSuccessAt, now)}`
        : '';
  return (
    <header data-job-summary data-schedules-hero className="flex min-w-0 flex-col pt-1">
      <div className="mb-3 flex min-w-0 items-baseline gap-2 whitespace-nowrap">
        <p className="truncate text-title">
          <span className="num">{jobs.length}</span> 个定时任务
        </p>
        <span className="min-w-0 truncate text-meta text-muted-foreground">
          每 {POLL_FAST_MS / 1000} 秒自己刷新
        </span>
      </div>
      <p
        data-hero-line
        title={verdict.text}
        className="flex min-w-0 items-center gap-2.5 whitespace-nowrap text-heading font-normal"
      >
        <span data-hero-text className="min-w-0 truncate">
          {verdict.text}
        </span>
        <span className="shrink-0">
          <StatusBadge tone={verdict.tone} label={verdict.badge} />
        </span>
      </p>
      {notes ? (
        <p data-hero-notes title={notes} className="num mt-1.5 truncate text-meta text-muted-foreground">
          {notes}
        </p>
      ) : null}
    </header>
  );
}
