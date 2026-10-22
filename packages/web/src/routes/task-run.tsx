// 弹出到新窗口的那一笔会话（#3277、#3533 照 Arco 重排，样稿 canvas/TaskRun.dc.html）：不带外壳。
// 顶栏回到任务页；左卡按回合列整张单的笔，点一笔换一笔（窄屏收起）；右卡放那一笔的会话（标题、一行概况、会话内容）。
// 只拼 components/layout 的件，不写样式类。
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useTaskDetail } from '../api/client';
import { Button } from '../components/layout/button';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { PickGroup, PickList } from '../components/layout/pick-list';
import { Popout } from '../components/layout/popout';
import { Section } from '../components/layout/section';
import { Text } from '../components/layout/text';
import { RunMeta, RunTranscript, runStatus, runTitle } from '../components/run-transcript';
import { orderedRuns, runPopoutPath } from '../components/task-panel';
import { formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { viewOf } from '../lib/query-view';
import { liveMs, type SegmentRunView } from '../lib/segments';
import { useShownError } from '../lib/shown-error';

/** 任务详情靠推送更新、兜底轮询；超过这么久还没再读成，提示条改说「数据已过期」。 */
const DETAIL_STALE_AFTER_MS = 5 * TIME.MIN;

interface RoundGroup {
  key: string;
  label: string;
  runs: { run: SegmentRunView; nth: number }[];
}

/** 按回合分组，组内和组间都按起跑先后；不挂回合的（定范围这类开工前的段）单独一组。 */
export function groupByRound(runs: readonly SegmentRunView[]): RoundGroup[] {
  const groups = new Map<string, RoundGroup>();
  orderedRuns(runs).forEach((run, i) => {
    const key = run.roundSeq === undefined ? 'none' : String(run.roundSeq);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: run.roundSeq === undefined ? '不在回合里' : `第 ${run.roundSeq} 回合`, runs: [] };
      groups.set(key, g);
    }
    g.runs.push({ run, nth: i + 1 });
  });
  return [...groups.values()];
}

/** 左卡：按回合分组的笔，当前这一笔标着；每一笔是链接，可以新窗口打开。 */
function RunList({
  taskId,
  groups,
  current,
  now,
}: {
  taskId: string;
  groups: RoundGroup[];
  current: string;
  now: number;
}) {
  return (
    <nav aria-label="这张单的笔" data-popout-runs>
      {groups.map((g) => (
        <PickGroup key={g.key} label={g.label}>
          <PickList
            aria-label={g.label}
            value={current}
            items={g.runs.map(({ run, nth }) => {
              const ms = run.durationMs ?? liveMs(run, now);
              return {
                key: run.id,
                title: runTitle(run, nth),
                meta: [run.modelName, ms !== undefined ? formatDuration(ms) : '耗时没读到']
                  .filter(Boolean)
                  .join(' · '),
                status: runStatus(run),
                href: runPopoutPath(taskId, run.id),
                replace: true,
              };
            })}
          />
        </PickGroup>
      ))}
    </nav>
  );
}

export default function TaskRunPage() {
  const { taskId = '', runId = '' } = useParams();
  const detail = useTaskDetail(taskId);
  // 推送重读会把从没读成过的查询退回骨架：显示记住的那次失败（和任务页一样，lib/shown-error.ts）
  const error = useShownError(taskId, detail);
  // 读成过、这次刷新没成：照旧画上一次的，顶上写「刷新没成」（不当 error）
  const view = viewOf(detail);
  const stale = view.status === 'data' ? view.stale : undefined;
  const now = useNow();
  const d = detail.data;
  const groups = d ? groupByRound(d.segmentRuns) : [];
  const found = groups.flatMap((g) => g.runs).find((r) => r.run.id === runId);
  const taskPath = `/tasks/${encodeURIComponent(taskId)}`;

  useEffect(() => {
    const what = found ? runTitle(found.run, found.nth) : '会话';
    document.title = d ? `${what} · #${d.task.issueNumber} · ${brand.product}` : `${what} · ${brand.product}`;
  }, [d, found]);

  if (error && !d) {
    return (
      <Popout backHref={taskPath}>
        {isNotFound(error) ? (
          <Section flush>
            <EmptyState
              title="没有这张单"
              hint={`任务 ${taskId} 不在库里，可能编号写错了。`}
              action={
                <Button href="/tasks" variant="secondary">
                  去任务列表
                </Button>
              }
            />
          </Section>
        ) : (
          <LoadError what="这张单" error={error} onRetry={() => void detail.refetch()} />
        )}
      </Popout>
    );
  }
  if (!d) {
    return (
      <Popout backHref={taskPath}>
        <Section>
          <LoadingRows rows={6} />
        </Section>
      </Popout>
    );
  }

  return (
    <Popout
      backHref={taskPath}
      taskLabel={
        <>
          <Text mono tone="muted">
            #{d.task.issueNumber}
          </Text>{' '}
          {d.task.title}
        </>
      }
      sideTitle="这张单的笔"
      sideCount={groups.reduce((n, g) => n + g.runs.length, 0)}
      side={<RunList taskId={taskId} groups={groups} current={runId} now={now} />}
      {...(found
        ? {
            title: runTitle(found.run, found.nth),
            meta: <RunMeta run={found.run} now={now} />,
          }
        : {})}
      notice={
        stale ? <LoadStale what="这张单" stale={stale} staleAfterMs={DETAIL_STALE_AFTER_MS} /> : undefined
      }
    >
      {found ? (
        <RunTranscript taskId={taskId} run={found.run} />
      ) : (
        <EmptyState
          title="没有这一笔"
          hint="这张单里找不到这一笔，可能是地址写错了。左边列着这张单的全部笔。"
        />
      )}
    </Popout>
  );
}
