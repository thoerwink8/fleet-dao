// 法国页（#618 的总览 + #820 的对照 + #1086 的总开关，#1217 合成一页；#3509 起照 Arco 改版，样稿 canvas/France.dc.html）：
// 本机 WSL 撤了以后只剩法国一台，侧栏只留「法国」。从上到下五块：
// 0. 运行概况：本台现在最该看的一件事（健康红、引擎没连上、没读到、落后主线……，没有异常就不画）、两个指标（在跑的会话、健康检查）、
//    引擎进程 / 会话 / 池 / 健康 / 最近拉单的描述列表。
// 1. 左：引擎（总开关、派单方式「三段 / 对半分 / 全程」，原来在工作台页头）；右：版本（发版预检、发布到法国、九步进度、恢复按钮）。
// 2. 机器：本台一行，远程环境一行（在线 / 失联 / 没数据），点箭头展开那一台最后一次报的快照（#1888 久没报的也在表里，默认收着）。
// 3. 更多：定时任务、资源、发布记录、操作记录、渠道状态的入口，和点开才摆的命令行工具（#1969）。
//
// 数据从哪来：/api/env（本台六项事实）、/api/jobs、发版状态和预检、/api/france/cli-tools、/api/nodes（远程环境列表和快照）。
// 在法国真机的驾驶舱上打开，本台就是法国；在本地开发 / 演示 mock 上打开，本台是这台后端自己的数。
// 每一项都按后端给的 ok / reason 两态如实画：读不到就写「没读到 + 原因」，不拿 0 或假 ok 冒充（仓的底线）。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）。

import { brand } from '#brand';
import {
  POLL_FAST_MS,
  POLL_SLOW_MS,
  useCliTools,
  useEnv,
  useFranceReleaseCard,
  useFranceReleaseState,
  useJobs,
  useNodeSnapshots,
  useNodes,
} from '../api/client';
import type { EnvFacts, EnvResponse, NodeListItem, ReleaseCard } from '../api/types';
import { EngineCard } from '../components/engine-card';
import { useMasterView } from '../components/engine-master';
import { FactsOverview, factsUnread } from '../components/env-facts';
import { Machines } from '../components/france-machines';
import { More } from '../components/france-more';
import { Grid } from '../components/layout/grid';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { VersionCard } from '../components/release-card';
import { formatAgo, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useNodeSelection } from '../lib/node';

export function meta() {
  return [{ title: brand.title('法国') }];
}

/**
 * 这一页几块自己重拉（本台、版本卡 1 分钟，其余 30 秒）。
 * 超过 5 分钟最旧的一块还没再读成，刷新条才标「数据已过期」（正常间隔里不标）。
 */
const FRANCE_STALE_AFTER_MS = 5 * TIME.MIN;

type ReadBlock = {
  refetch: () => unknown;
  isFetching: boolean;
  dataUpdatedAt: number;
};

/**
 * 多块合成标题栏那一条：点刷新每块都重读；「最后更新」取已经读成过的里面最旧的一块。
 * dataUpdatedAt 为 0 是「这块从没读成」，不是时刻，不拿来比——一块失败不能把整条写成「还没读到过」。
 * 各块自己的「重试」不在这里。发版预检是人点的读取，不跟着重放。
 */
function pageRead(blocks: readonly ReadBlock[]) {
  let oldest = 0;
  let fetching = false;
  for (const block of blocks) {
    if (block.isFetching) fetching = true;
    if (block.dataUpdatedAt > 0 && (oldest === 0 || block.dataUpdatedAt < oldest)) {
      oldest = block.dataUpdatedAt;
    }
  }
  return {
    refetch: () => {
      for (const block of blocks) void block.refetch();
    },
    isFetching: fetching,
    dataUpdatedAt: oldest,
  };
}

/**
 * 本台现在最该看的几件事，按轻重排（健康红、引擎没连上、定时任务失败、引擎没开、没读到、落后主线）；
 * 一件都没有就不画提示条。有红的整条用红，否则橙。
 */
function issuesOf(
  facts: EnvFacts,
  card: ReleaseCard | undefined,
  jobsFailed: number,
): { fail: boolean; text: string }[] {
  const issues: { fail: boolean; text: string }[] = [];
  const failing = facts.health.ok ? facts.health.value.failing : [];
  if (failing.length > 0)
    issues.push({ fail: true, text: `健康 ${failing.length} 项红：${failing.join('、')}` });
  if (facts.engine.ok && facts.engine.value.state === 'down') issues.push({ fail: true, text: '引擎没连上' });
  if (jobsFailed > 0) issues.push({ fail: true, text: `定时任务失败 ${jobsFailed} 个` });
  if (facts.engine.ok && facts.engine.value.state === 'off')
    issues.push({ fail: false, text: '引擎按配置没开' });
  const unread = factsUnread(facts);
  if (unread > 0) issues.push({ fail: false, text: `${unread} 项没读到` });
  const behind =
    card?.gap.state === 'ahead'
      ? card.gap.count
      : facts.version.ok && facts.version.value.behind !== null
        ? facts.version.value.behind
        : 0;
  if (behind > 0) issues.push({ fail: false, text: `落后主线 ${behind} 个提交` });
  return issues;
}

/** 「运行概况」：提示条 + 指标 + 描述列表；本台没读成写没读成和原因（带重试），读成过、刷新失败照旧画上一次的。 */
function Overview({
  env,
  card,
  jobsFailed,
  jobCount,
  now,
}: {
  env: ReturnType<typeof useEnv>;
  card: ReleaseCard | undefined;
  jobsFailed: number;
  jobCount: number | undefined;
  now: number;
}) {
  const data: EnvResponse | undefined = env.data;
  const stale = Boolean(env.error && data);
  const issues = data ? issuesOf(data.facts, card, jobsFailed) : [];
  const read = data
    ? [`${formatAgo(data.asOf, now)}读`, data.name.problem].filter(Boolean).join(' · ')
    : null;
  return (
    <Section
      title="运行概况"
      actions={
        <>
          {stale ? <Tag tone="warning">数据已过期</Tag> : null}
          {read ? (
            <Text size="meta" tone="muted">
              {read}
            </Text>
          ) : null}
        </>
      }
    >
      <Stack>
        {env.error ? (
          data ? (
            <LoadStale
              what="本台"
              error={env.error}
              when={formatAgo(new Date(env.dataUpdatedAt).toISOString(), now)}
              onRetry={() => void env.refetch()}
            />
          ) : (
            <LoadError what="本台的事实" error={env.error} onRetry={() => void env.refetch()} />
          )
        ) : null}
        {data && issues.length > 0 ? (
          <div data-france-verdict>
            <Notice tone={issues.some((x) => x.fail) ? 'fail' : 'stall'}>
              {issues.map((x) => x.text).join('；')}
            </Notice>
          </div>
        ) : null}
        {data ? (
          <FactsOverview facts={data.facts} now={now} jobCount={jobCount} />
        ) : env.error ? null : (
          <LoadingRows rows={3} />
        )}
      </Stack>
    </Section>
  );
}

export default function France() {
  const { view: masterView } = useMasterView();
  const env = useEnv();
  const nodes = useNodes();
  const jobs = useJobs();
  const release = useFranceReleaseState();
  const card = useFranceReleaseCard();
  const cli = useCliTools();
  const { nodeId } = useNodeSelection();
  const now = useNow();
  const facts = env.data?.facts;
  const jobList = jobs.data?.jobs;
  const failed = jobList?.filter((j) => j.lastRun?.outcome === 'failed').length ?? 0;
  const remote = nodes.data?.nodes ?? [];
  // 收到过快照的远程环境各读一份；从没收到过的（never）没有快照可读，那一行只写「从没收到过」
  const received = remote.filter((n) => n.receivedAt !== undefined);
  const snapshots = useNodeSnapshots(received.map((n) => n.id));
  const snapshotOf = (n: NodeListItem) => {
    const i = received.findIndex((r) => r.id === n.id);
    return i < 0 ? undefined : snapshots[i];
  };
  // 总开关是人给的许可，「引擎进程」是进程还活着。两件同时出现才解释，避免关着且进程也停了还说「还在跑」。
  const selectedEngine =
    nodeId === null
      ? facts?.engine
      : snapshots[received.findIndex((n) => n.id === nodeId)]?.data?.env.facts.engine;
  const standby =
    masterView.kind === 'ok' &&
    !masterView.master.on &&
    selectedEngine?.ok === true &&
    selectedEngine.value.state === 'on';

  const read = pageRead([env, nodes, jobs, release, card, cli, ...snapshots]);
  // 列表还没回来时先别画机器表的远程行：不然会先只画本台一行，列表回来再跳出远程行。
  const nodesPending = nodes.isPending && nodes.data === undefined;

  return (
    <Page
      title="法国"
      description="本台运行概况、引擎总开关与派单方式、版本与发版、各台机器。"
      detail={`读不到的写「没读到」和原因，不拿 0 顶。环境、版本卡、命令行工具每 ${POLL_SLOW_MS / 1000} 秒刷新；机器、定时任务、发版进度每 ${POLL_FAST_MS / 1000} 秒刷新。`}
      refresh={{
        onRefresh: () => void read.refetch(),
        isFetching: read.isFetching,
        dataUpdatedAt: read.dataUpdatedAt,
        staleAfterMs: FRANCE_STALE_AFTER_MS,
      }}
    >
      <Stack>
        {nodes.error ? (
          <LoadError what="远程环境列表" error={nodes.error} onRetry={() => void nodes.refetch()} />
        ) : null}
        <Overview env={env} card={card.data} jobsFailed={failed} jobCount={jobList?.length} now={now} />
        <Grid cols={2}>
          <EngineCard
            standbyNote={
              standby ? '总开关关着只是不派活，引擎进程还在跑，所以「引擎进程」仍可能写运行中。' : null
            }
          />
          <VersionCard card={card} release={release} facts={facts} now={now} />
        </Grid>
        <Machines
          localName={env.data?.name.name ?? '本台'}
          localProblem={env.data?.name.problem}
          localFacts={facts}
          nodes={remote}
          nodesLoading={nodesPending}
          snapshotOf={snapshotOf}
          selectedId={nodeId}
          now={now}
        />
        <More jobs={jobs} cli={cli} now={now} />
      </Stack>
    </Page>
  );
}
