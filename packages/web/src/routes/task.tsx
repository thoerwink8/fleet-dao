// 任务页（/tasks/:taskId）：一张单走了哪几段、每段每个模型花了多久、多少 token 和钱（#216）；动手、验收各用哪个模型，
// 能在这里指定或回到自动（components/task-model-pins.tsx）。执行体没报花费的按目录单价估、标「估算」。
// 主页「在跑的」卡片、「要你拍的」都链到这里。读 runs 表的三段流水（segmentRuns、usage.bySegment）。
// 读不到的写「没读到」和原因，不写 0。
//
// 层级照 Arco Pro 详情页（#3509，样稿 canvas/Task.dc.html）：页头标题和操作；一张卡写这张单现在怎么样（状态、一句结论、
// 仓#单号、PR）；一张卡是这一回合走到哪（五步）；一张卡是页签：最新汇报 / 用量与模型 / 改动文件 / 过程。
// 页只拼 components/layout 的件，不写样式类。每一笔的会话盖在右边的抽屉里（?run=）。
import { ListChecks, SearchX } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useTaskDetail } from '../api/client';
import type { TaskDetail } from '../api/types';
import { FlowModeTag } from '../components/flow-mode-tag';
import { Breadcrumb } from '../components/layout/breadcrumb';
import { Button } from '../components/layout/button';
import { Descriptions, type DescriptionsItem } from '../components/layout/descriptions';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { StatusBadge } from '../components/layout/status-badge';
import { TabPanel } from '../components/layout/tab-panel';
import { Text } from '../components/layout/text';
import type { LayoutTone } from '../components/layout/tone';
import { RepoLink } from '../components/repo-link';
import { RoundProgressStrip } from '../components/round-progress';
import { ActionButtons } from '../components/task-actions';
import { TaskModelPins } from '../components/task-model-pins';
import { type TaskPanel, TaskPanelView, usePanelKeys, useTaskPanel } from '../components/task-panel';
import { processSummaryOf, TaskProcess } from '../components/task-process';
import { TaskChangedFiles, TaskPrs, TaskSummary } from '../components/task-summary';
import { canPinModels, USAGE_PARAM, UsageTab } from '../components/usage-fold';
import { formatAgo, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { viewOf } from '../lib/query-view';
import { liveMs, segmentLabel, UNKNOWN_SEGMENT } from '../lib/segments';
import { useShownError } from '../lib/shown-error';
import { taskStateLabel, taskTone } from '../lib/status';
import { backToList, FROM_PARAM } from '../lib/task-list';
import type { StatusKey } from '../theme/status-dict';

export function meta() {
  return [{ title: brand.title('任务') }];
}

/** 页头 ⓘ：各块是什么、怎么读（原来摊在每一块的块头，一块两三行）。 */
const DETAIL = (
  <Stack gap="sm">
    <Text as="p">
      一张单走了哪几段、每段每个模型花了多久、多少 token 和钱；读不到的写明没读到，不当成 0。
    </Text>
    <Text as="p" size="meta" tone="secondary">
      顶上一卡是这张单现在怎么样：状态、一句结论、仓和单号（点开去 GitHub）、开单时间、关联的 PR
      和它们的状态。
    </Text>
    <Text as="p" size="meta" tone="secondary">
      下面一卡是这一回合走到哪：动手 → 自测 → 推分支 · CI → 验收 →
      合并，每格下面一行写用了多久、第几笔在跑或还没到；蓝的在做、红的没成；返工的回合带上一回合怎么收场。没有回合记录的老单不画。
    </Text>
    <Text as="p" size="meta" tone="secondary">
      最新汇报：最新一笔的结论（后面写第几笔、模型、多久前）、命令完成和失败的数。改动文件：每个 PR
      改了哪些文件、每个文件的增删；文件和行数来自推分支时按 PR 头记的
      numstat，不是把每次编辑加起来；读不到的写没读到和原因，不当成 0。
    </Text>
    <Text as="p" size="meta" tone="secondary">
      过程：回合 → 笔 → 步骤 →
      调用。前面收场的回合收成一行，点开看；每一笔写第几笔、为什么起、是新会话还是接上一笔的会话、结局和用时，笔之间一行是引擎在会话外连着做的事
      （自测 → 推分支 → 开 PR → 等 CI → 验收 → 合并）；返工的回合顶上写为什么返工。按 \ 切到这个页签。
    </Text>
    <Text as="p" size="meta" tone="secondary">
      用量与模型：几个数、三段（对题 → 动手 → 验收，每段再按模型分，没读到的格子留 —，不是 0）、每一笔（没记
      task_id、按单号对上的标「按单号兜底」；
      没读到的写明为什么）、用哪个模型（给动手、验收指定模型，下一次选路起照它，在跑的这一轮不打断；动手这一轮想当场换，点「现在就换」；
      指定的派不出时引擎停下等你，不悄悄换别的）。选中的页签记在网址里，能发给别人。
    </Text>
    <Text as="p" size="meta" tone="secondary">
      点「看会话」右边盖上来这一笔的会话，网址带着这一笔（?run=），K / J
      换上一笔、下一笔；「弹出到新窗口」单开一个不带侧栏的窗口看长会话。
    </Text>
  </Stack>
);

/** 从任务列表点进来的（链接带 ?from=/tasks?…）回列表并带回筛选；别处进来的照旧回主页。 */
function Crumbs({ d }: { d: TaskDetail | undefined }) {
  const [params] = useSearchParams();
  const list = backToList(params.get(FROM_PARAM));
  return (
    <Breadcrumb
      items={[
        {
          label: list ? '任务列表' : '主页',
          href: list ?? '/',
          ariaLabel: list ? '回任务列表' : '回主页',
        },
        { label: d ? `#${d.task.issueNumber}` : '任务' },
      ]}
    />
  );
}

/**
 * 暂停、继续、叫停、重做（#820 片 3 已接到这一页，#856 第 1 处核对后仍用这一份 ActionButtons）。
 * 点了发 POST /api/tasks/:taskId/actions。做完、失败的不画。已叫停的只画「重做」；停滞时「重做」收进「更多」。
 */
function TaskActionBar({ d }: { d: TaskDetail }) {
  return (
    <ActionButtons
      moreRedo
      target={{
        taskId: d.task.id,
        issueNumber: d.task.issueNumber,
        title: d.task.title,
        state: d.task.state,
        paused: d.task.paused,
        ...(d.task.stalled === undefined ? {} : { parkedWhy: d.task.stalled.why }),
      }}
    />
  );
}

/** 最新的 PR：段流水里最后一个带 PR 的，没有再看子任务。 */
function latestPr(d: TaskDetail): number | undefined {
  return (
    [...d.segmentRuns]
      .map((r) => r.prNumber)
      .filter((n): n is number => n !== undefined)
      .at(-1) ??
    d.subtasks
      .map((s) => s.prNumber)
      .filter((n): n is number => n !== undefined)
      .at(-1)
  );
}

/**
 * 结论那一句：这张单现在怎么样（状态标签已经写了的不再重复）。只写短话，放不下截断，整句在悬停里。
 * 只读详情里已有的段流水，不另要后端字段。
 */
export function taskConclusion(
  d: TaskDetail,
  now: number,
): { tone: LayoutTone; label: string; text: string } {
  const paused = d.task.paused;
  const tone: LayoutTone = paused === undefined ? taskTone(d.task) : 'stall';
  const label = paused === undefined ? taskStateLabel[d.task.state] : '已暂停';
  const runs = d.segmentRuns;
  const segOf = (s: (typeof runs)[number] | undefined) =>
    s?.segment ? segmentLabel[s.segment] : UNKNOWN_SEGMENT;
  const running = [...runs].filter((r) => r.running).at(-1);
  const last = runs.at(-1);
  if (paused !== undefined) return { tone, label, text: paused };
  if (running) {
    const live = liveMs(running, now);
    const parts = [running.modelName, live === undefined ? '' : `已跑 ${formatDuration(live)}`].filter(
      Boolean,
    );
    return { tone, label, text: `${segOf(running)}中：${parts.join('，')}` };
  }
  const segments = new Set(runs.map((r) => r.segment)).size;
  switch (d.task.state) {
    case 'done':
      return {
        tone,
        label,
        text: runs.length ? `做完了，${segments} 段共跑了 ${runs.length} 笔` : '做完了',
      };
    case 'failed':
      return {
        tone,
        label,
        text: last?.failureReason
          ? `${segOf(last)}没成：${last.failureReason}`
          : last
            ? `停在${segOf(last)}`
            : '没跑起来',
      };
    case 'stopped':
      return { tone, label, text: last ? `被叫停，停在${segOf(last)}` : '被叫停，还没跑过' };
    case 'stalled':
      return { tone, label, text: last ? `${segOf(last)}之后没动静` : '一直没动静' };
    case 'queued':
      return { tone, label, text: '还没开跑，等空位' };
    default:
      return { tone, label, text: last ? `等下一段开跑，上一段是${segOf(last)}` : '还没开跑' };
  }
}

/**
 * 首屏结论卡（照 Arco Pro 详情页；#1751 起首屏先给状态、已跑多久、PR 号）：
 * 第一行状态加一句结论（放不下截断，整句在悬停里）；下面是键值：仓和单号（去 GitHub）加开单多久、PR 和它们的状态。
 */
function TaskHero({ d, now }: { d: TaskDetail; now: number }) {
  const c = taskConclusion(d, now);
  const pr = latestPr(d);
  const status: StatusKey = d.task.paused === undefined ? `task:${d.task.state}` : 'task:paused';
  const prs = d.overview?.prs ?? [];
  const items: DescriptionsItem[] = [
    {
      label: '仓和单号',
      value: (
        <Stack direction="horizontal" gap="md" align="baseline" wrap>
          <RepoLink repo={d.repo} kind="issues" n={d.task.issueNumber}>
            {d.repo.owner}/{d.repo.name}#{d.task.issueNumber}
          </RepoLink>
          <Text tone="muted">开单 {formatAgo(d.task.createdAt, now)}</Text>
        </Stack>
      ),
    },
    ...(prs.length > 0
      ? [{ label: 'PR', value: <TaskPrs d={d} /> }]
      : pr === undefined
        ? []
        : [
            {
              label: 'PR',
              value: (
                <RepoLink repo={d.repo} kind="pull" n={pr}>
                  PR #{pr}
                </RepoLink>
              ),
            },
          ]),
  ];
  return (
    <Section aria-label="这张单现在怎么样" data-now-banner>
      <Stack gap="lg">
        <div data-hero-line title={c.text}>
          <Stack direction="horizontal" gap="md" align="center">
            <StatusBadge status={status} />
            <FlowModeTag mode={d.task.flowMode} fallback={d.task.flowFallback} />
            <span data-hero-text>
              {d.task.paused === undefined ? (
                <Text tone="secondary" truncate>
                  {c.text}
                </Text>
              ) : (
                <span data-paused-note>
                  <Text tone="secondary" truncate>
                    {c.text}
                  </Text>
                </span>
              )}
            </span>
          </Stack>
        </div>
        <Descriptions columns={1} items={items} />
      </Stack>
    </Section>
  );
}

type TabId = 'report' | 'usage' | 'files' | 'process';

const TAB_PARAM = 'tab';
const TAB_PREFIX = 'task-tab';
const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'report', label: '最新汇报' },
  { id: 'usage', label: '用量与模型' },
  { id: 'files', label: '改动文件' },
  { id: 'process', label: '过程' },
];

/** 现在选中的页签：地址里的 ?tab=；旧链接 ?usage=open 等于「用量与模型」；都没有是「最新汇报」。 */
function useTab(): [TabId, (next: TabId) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(TAB_PARAM);
  const tab: TabId =
    TABS.find((t) => t.id === raw)?.id ?? (params.get(USAGE_PARAM) === 'open' ? 'usage' : 'report');
  const select = (next: TabId) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete(USAGE_PARAM);
        if (next === 'report') n.delete(TAB_PARAM);
        else n.set(TAB_PARAM, next);
        return n;
      },
      { replace: true },
    );
  return [tab, select];
}

/**
 * 结论卡下面：这一回合走到哪、四个页签；每一笔的会话在右侧抽屉里（#3277，components/task-panel.tsx）。
 */
function Body({
  d,
  now,
  panel,
  tab,
  selectTab,
}: {
  d: TaskDetail;
  now: number;
  panel: TaskPanel;
  tab: TabId;
  selectTab: (next: TabId) => void;
}) {
  if (!d.segmentRuns.length) {
    return (
      <Stack>
        <TaskHero d={d} now={now} />
        <Section>
          <EmptyState
            icon={ListChecks}
            title="这张单还没跑过"
            hint="三段（对题、动手、验收）跑起来以后，每一笔都记在这里。"
          />
        </Section>
        {canPinModels(d) ? (
          <Section>
            <TaskModelPins d={d} now={now} />
          </Section>
        ) : null}
      </Stack>
    );
  }
  return (
    <Stack>
      <TaskHero d={d} now={now} />
      <RoundProgressStrip d={d} now={now} />
      <Section aria-label="任务内容">
        <Stack gap="lg">
          <FilterTabs
            aria-label="任务内容"
            idPrefix={TAB_PREFIX}
            items={TABS.map((t) => ({ id: t.id, label: t.label }))}
            value={tab}
            onChange={selectTab}
          />
          <TabPanel idPrefix={TAB_PREFIX} id={tab}>
            {tab === 'report' ? (
              <TaskSummary d={d} now={now} onShowProcess={() => selectTab('process')} />
            ) : tab === 'usage' ? (
              <UsageTab d={d} now={now} onViewTranscript={panel.openRun} />
            ) : tab === 'files' ? (
              <TaskChangedFiles d={d} />
            ) : (
              <Stack gap="md">
                <Text size="meta" tone="muted">
                  {processSummaryOf(d, now)}
                </Text>
                <TaskProcess d={d} now={now} onViewTranscript={panel.openRun} inPanel />
              </Stack>
            )}
          </TabPanel>
        </Stack>
      </Section>
    </Stack>
  );
}

const GITHUB_ISSUE_HINT =
  '这看起来是 GitHub 单号。任务页地址要用任务编号（例如 t-12），到主页的在跑列表里点进去';

/** 地址参数一个数字都不夹别的字：人多半把 GitHub 单号填进了任务页。 */
function looksLikeIssueNumber(taskId: string | undefined): boolean {
  return taskId !== undefined && /^[0-9]+$/.test(taskId);
}

/** 没有这张单（后端 404）：写明，给回主页的路；不转圈、不给「重试」（重试也不会有）。纯数字再补一句单号和任务编号的区别。 */
function Missing({ taskId }: { taskId: string | undefined }) {
  return (
    <Section>
      <div role="alert">
        <EmptyState
          icon={SearchX}
          title="没有这张单"
          hint={
            <Stack gap="sm">
              <Text as="p" tone="muted">
                库里没有编号为「<Text mono>{taskId ?? ''}</Text>
                」的单：可能链接里的编号写错了，或这张单已经不在了。
              </Text>
              {looksLikeIssueNumber(taskId) ? (
                <Text as="p" tone="muted">
                  {GITHUB_ISSUE_HINT}
                </Text>
              ) : null}
            </Stack>
          }
          action={
            <Button variant="primary" href="/">
              回主页
            </Button>
          }
        />
      </div>
    </Section>
  );
}

const NO_RUNS: readonly TaskDetail['segmentRuns'][number][] = [];

/** 任务详情靠推送更新，没有自己的轮询。这份快照超过 5 分钟还没再读成，刷新钮旁标「数据已过期」。 */
const TASK_STALE_AFTER_MS = 5 * TIME.MIN;

export default function TaskPage() {
  const { taskId } = useParams();
  const detail = useTaskDetail(taskId);
  // 推送重读会把从没读成过的查询退回骨架：显示记住的那次失败（lib/shown-error.ts）
  const error = useShownError(taskId, detail);
  const now = useNow();
  const view = viewOf(detail);
  const d = view.status === 'data' ? view.data : undefined;
  const panel = useTaskPanel(d?.segmentRuns ?? NO_RUNS);
  const [tab, selectTab] = useTab();
  // 过程在页签里；右边的抽屉只给某一笔的会话（?run=）。`\` 切到「过程」页签。
  const drawer: TaskPanel = { ...panel, shown: panel.run !== undefined, toggle: () => selectTab('process') };
  usePanelKeys(drawer);
  return (
    <Page
      title={
        d ? (
          <>
            <Text tone="muted" mono>
              #{d.task.issueNumber}
            </Text>{' '}
            {d.task.title}
          </>
        ) : (
          '任务'
        )
      }
      detail={d ? DETAIL : undefined}
      refresh={{
        onRefresh: () => void detail.refetch(),
        isFetching: detail.isFetching,
        dataUpdatedAt: detail.dataUpdatedAt,
        staleAfterMs: TASK_STALE_AFTER_MS,
      }}
      breadcrumb={<Crumbs d={d} />}
      actions={d ? <TaskActionBar d={d} /> : undefined}
    >
      {error && isNotFound(error) && !d ? (
        <Missing taskId={taskId} />
      ) : view.status === 'error' || (error && !d) ? (
        <LoadError
          what="这张单"
          error={error ?? (view.status === 'error' ? view.error : undefined)}
          onRetry={() => void detail.refetch()}
        />
      ) : !d ? (
        <LoadingRows rows={6} />
      ) : (
        <Stack>
          {/* 读成过、这次刷新没读成：照旧画上一次读到的，顶上一条橙色提示带重试（不把看得到的清空） */}
          {view.status === 'data' && view.stale ? (
            <LoadStale what="这张单" stale={view.stale} staleAfterMs={TASK_STALE_AFTER_MS} />
          ) : null}
          <Body d={d} now={now} panel={drawer} tab={tab} selectTab={selectTab} />
          <TaskPanelView d={d} now={now} panel={drawer} />
        </Stack>
      )}
    </Page>
  );
}
