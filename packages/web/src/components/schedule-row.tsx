// 定时任务页的表（#3509，样稿 canvas/Schedules.dc.html；原来的行和标题块是 #1914 路由页样板的写法）：
// 一行一个任务：展开箭头、任务（名字加一行灰字上次结果）、状态（只一个）、周期、上次跑成的相对时间；点开看完整结果、上次跑成和开始的时间、耗时、过期线。
// 状态一行只放一个，按「失败 > 没查全 > 过期 > 从没跑成 > 在跑 > 按期」取最要紧的；异常只靠状态那一个标签表达，灰字和时间不再另涂色。
// 「有问题」= 失败、没查全，或后端判的新鲜度不是按期；在跑的不算。异常行排最前（失败第一）。
import type { JobView } from '../api/types';
import { formatAgo, formatDateTime, formatDuration } from '../lib/format';
import { everyText, outcomeText } from '../lib/schedule';
import type { StatusKey } from '../theme/status-dict';
import { Descriptions } from './layout/descriptions';
import { StatusBadge } from './layout/status-badge';
import { Table, type TableColumn } from './layout/table';
import { Text } from './layout/text';

/** 上次结果超过这么多字，行里只露开头（整句在悬停里），展开后再写一遍完整的。 */
const SHORT_OUTCOME = 24;

/** 一行该不该提醒：失败，或没查成 / 只查了一部分，或后端判的新鲜度不是按期。 */
export function rowTone(j: JobView): 'fail' | 'stall' | null {
  if (j.lastRun?.outcome === 'failed') return 'fail';
  if (j.lastRun?.outcome === 'unscanned' || j.lastRun?.outcome === 'partial' || j.status !== 'fresh')
    return 'stall';
  return null;
}

/** 一行只放一个状态：失败、没查全、过期、从没跑成、在跑、按期。 */
export function jobStatusKey(j: JobView): StatusKey {
  const r = j.lastRun;
  if (r?.outcome === 'failed') return 'job:failed';
  if (r?.outcome === 'unscanned' || r?.outcome === 'partial') return 'job:partial';
  if (j.status === 'overdue') return 'job:overdue';
  if (j.status === 'never') return 'job:never';
  if (r && !r.endedAt) return 'job:running';
  return 'job:fresh';
}

/** 异常行排最前（失败，再是没查全 / 过期），其余保持后端给的先后。 */
export function problemsFirst(jobs: readonly JobView[]): JobView[] {
  const rank = (j: JobView) => {
    const tone = rowTone(j);
    return tone === 'fail' ? 0 : tone === 'stall' ? 1 : 2;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b));
}

function durationText(j: JobView): string {
  const r = j.lastRun;
  if (r?.endedAt) return formatDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt));
  if (r) return '在跑';
  return '—';
}

/** 过期线：期望多久成功一次；过期或从没跑成时补一句。 */
function staleLine(j: JobView): string {
  const base = `期望${everyText(j.expectEveryMinutes)}成功一次`;
  if (j.status === 'overdue') return `${base}，现在已超过，算过期`;
  if (j.status === 'never') return `${base}，到现在还没跑成过`;
  return base;
}

function JobDetail({ j, now }: { j: JobView; now: number }) {
  const r = j.lastRun;
  const outcome = outcomeText(j);
  return (
    <div data-job-detail>
      <Descriptions
        columns={2}
        items={[
          ...(outcome.length > SHORT_OUTCOME ? [{ label: '完整结果', value: outcome }] : []),
          {
            label: '上次跑成',
            value: j.lastSuccessAt
              ? `${formatDateTime(j.lastSuccessAt)}（${formatAgo(j.lastSuccessAt, now)}）`
              : '从没跑成过',
          },
          { label: '开始于', value: r ? formatDateTime(r.startedAt) : '—' },
          { label: '耗时', value: durationText(j) },
          { label: '过期线', value: staleLine(j) },
          { label: '编号', value: j.id, mono: true },
        ]}
      />
    </div>
  );
}

function columns(now: number): TableColumn<JobView>[] {
  return [
    {
      key: 'name',
      title: '任务',
      render: (_, j) => {
        const outcome = outcomeText(j);
        return (
          <div
            data-job={j.id}
            data-outcome={j.lastRun?.outcome ?? (j.lastRun ? 'running' : 'never')}
            data-status={j.status}
          >
            <Text as="div" strong title={j.id}>
              {j.name}
            </Text>
            <div data-job-outcome title={outcome}>
              <Text as="div" size="meta" tone="muted">
                {outcome.length > SHORT_OUTCOME ? `${outcome.slice(0, SHORT_OUTCOME)}…` : outcome}
              </Text>
            </div>
          </div>
        );
      },
    },
    {
      key: 'status',
      title: '状态',
      render: (_, j) => <StatusBadge status={jobStatusKey(j)} />,
    },
    {
      key: 'schedule',
      title: '周期',
      render: (_, j) => <Text tone="secondary">{j.schedule}</Text>,
    },
    {
      key: 'lastSuccessAt',
      title: '上次跑成',
      align: 'right',
      render: (_, j) => (
        <span
          data-last-success-ago
          title={j.lastSuccessAt ? `上次跑成：${formatDateTime(j.lastSuccessAt)}` : '从没跑成过'}
        >
          <Text tone="secondary">{j.lastSuccessAt ? formatAgo(j.lastSuccessAt, now) : '从没跑成过'}</Text>
        </span>
      ),
    },
  ];
}

export function ScheduleTable({ jobs, now }: { jobs: readonly JobView[]; now: number }) {
  return (
    <div data-job-list>
      <Table
        caption="定时任务"
        columns={columns(now)}
        rows={jobs}
        rowKey="id"
        expandable={{ render: (j) => <JobDetail j={j} now={now} /> }}
      />
    </div>
  );
}
