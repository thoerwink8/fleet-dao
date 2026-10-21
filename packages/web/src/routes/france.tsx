// 法国页（#618 的总览 + #820 的对照 + #1086 的总开关，#1217 合成一页）：本机 WSL 撤了以后只剩法国一台，
// 侧栏只留「法国」。一页里有本台六项事实、引擎总开关、命令行工具（#1969）、定时任务、发版。多一台机器时六项按台并排（对照表的写法）。
//
// 「发版预检」在后端进程里读七项事实（主线头和 CI、法国在用的提交、落后几个、有没有别的发布、接活单元、引擎总开关、在跑的会话），
// 一项一行写通过、卡住、留意；读不到就写原因。不起子进程，不暂停、不发版。
// 真发版：点「在用版本」那一行里的「发布到法国」（#1232、#1255，components/release-card.tsx 的 ReleaseEntry）。后端只写请求文件，法国上 root 的接活单元来做。
// 发版单位是主线提交（决定 0032）：那一行写明落后几个提交、要发的主线头提交号和标题；下面的「发版」卡只读。
//
// 数据从哪来：
// - /api/env（本台六项事实）、/api/jobs（定时任务）、发版状态和预检、/api/france/cli-tools（命令行工具的版本和上次升级）、
//   /api/nodes（远程环境列表和快照，多台时并排）。
// - 在法国真机的驾驶舱上打开，本台就是法国；在本地开发 / 演示 mock 上打开，本台是这台后端自己的数。
// - 每一项都按后端给的 ok / reason 两态如实画：读不到就写「没查成 + 原因」，不拿 0 或假 ok 冒充（仓的底线）。
//
// 版式（路由页样板 #1914 铺开）：最上面是本台的标题块（名字、一句结论带状态、一行灰字细节），下面总开关一行；
// 只有一台时六项是一个区块里的六行（宽屏两栏各三行）；两台及以上每个环境一列、六项各占一行用 subgrid 对齐。
// 六项和定时任务之间是命令行工具：两个会话用户和全局 npm，每行在用版本、官方最新、现算的状态；
// 升过的同一行还有升上去的版本和上次升级时间（#1971）。没有升级按钮。
// 再下面左边定时任务列表（出问题的排前面）、右边发版。每一项一行怎么画在 components/env-facts.tsx。

import { ArrowRight, ChevronDown, Rocket, SearchX, ServerCog, Timer } from 'lucide-react';
import { type CSSProperties, type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import {
  errorText,
  isNotFound,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  useCliTools,
  useEnv,
  useFrancePreflight,
  useFranceReleaseCard,
  useFranceReleaseState,
  useJobs,
  useNodeSnapshots,
  useNodes,
} from '../api/client';
import type {
  CliToolsResponse,
  EnvFacts,
  EnvResponse,
  FrancePreflightResponse,
  FranceReleaseState,
  JobView,
  NodeDetail,
  NodeListItem,
  ReleaseCard,
} from '../api/types';
import { useMasterView } from '../components/engine-master';
import { EngineMasterControl } from '../components/engine-master-card';
import { FACT_ROWS, factCells, factsSummary, factsUnread } from '../components/env-facts';
import { JobListHead, JobListRow, rowTone } from '../components/job-row';
import { EmptyState } from '../components/layout/empty-state';
import { List, ListRow, RowDetail, RowFrame } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { MetaLine } from '../components/layout/meta-line';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { Section, SectionGrid } from '../components/layout/section';
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import type { LayoutTone } from '../components/layout/tone';
import { ReleaseCardBody, ReleaseEntry } from '../components/release-card';
import { Button } from '../components/ui/button';
import { formatAgo, formatDuration, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { freshnessNow, nodeAgeText, useNodeSelection } from '../lib/node';
import { useShownError } from '../lib/shown-error';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('法国') }];
}

/** 出问题的排前面（失败、再没查全 / 过期），其余照后端给的先后：回来看一眼，先看到要管的。 */
function problemsFirst(jobs: readonly JobView[]): JobView[] {
  const rank = (j: JobView) => (rowTone(j) === 'fail' ? 0 : rowTone(j) === 'stall' ? 1 : 2);
  return jobs
    .map((j, i) => ({ j, i }))
    .sort((a, b) => rank(a.j) - rank(b.j) || a.i - b.i)
    .map((x) => x.j);
}

/** release-train 此刻的一个状态：在走（卡住、没成）/ 暂停标记没人收 / 没在走 / 没查成。 */
function releaseState(release: FranceReleaseState): { tone: Tone; label: string } {
  switch (release.state) {
    case 'running':
      return release.status === 'blocked'
        ? { tone: 'stall', label: '卡住了' }
        : release.status === 'failed'
          ? { tone: 'fail', label: '没成' }
          : { tone: 'run', label: '在走' };
    case 'paused':
      return { tone: 'fail', label: '暂停标记没人收' };
    case 'idle':
      return { tone: 'stop', label: '没在走' };
    default:
      return { tone: 'stall', label: '没查成' };
  }
}

/**
 * 发版一键（#618）：release-train 此刻的状态 + 「发版预检」按钮，一行；下面一句灰字说明，点了预检才有结果块。
 * 状态三态：running = 在走；paused = 暂停标记留下来了但一趟不在（孤儿）；idle = 没在走。读不到一律 unreadable，写明原因。
 */
function ReleaseBody({
  release,
  preflight,
}: {
  release: FranceReleaseState;
  preflight: ReturnType<typeof useFrancePreflight>;
}) {
  const result: FrancePreflightResponse | undefined = preflight.data;
  const state = releaseState(release);
  // 同一帧里的第二下：isPending 还没画上去，只靠 disabled 挡不住，这里先记一笔。
  const preflightSent = useRef(false);
  return (
    <div className="space-y-3">
      <div>
        <div className="flex min-h-8 min-w-0 items-center gap-2 whitespace-nowrap">
          <Rocket className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 text-body font-medium">release-train</span>
          <StatusBadge tone={state.tone} label={state.label} variant="dot" className="text-body" />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto max-md:min-h-10"
            loading={preflight.isPending}
            loadingText="预检在跑…"
            disabled={preflight.isPending}
            onClick={() => {
              if (preflightSent.current || preflight.isPending) return;
              preflightSent.current = true;
              return preflight.mutate(undefined, {
                onSettled: () => {
                  preflightSent.current = false;
                },
              });
            }}
          >
            发版预检
          </Button>
        </div>
        <p className="mt-1 text-meta text-muted-foreground">
          {release.state === 'running'
            ? `${release.phase} · ${release.target}${release.marker ? ' · 派活已暂停' : ' · 暂停标记没写'}${release.why ? ` · ${release.why}` : ''}`
            : release.state === 'paused'
              ? '暂停标记在、但一趟的记录不在。这不是正在发的一趟。真发版点上面「在用版本」里的「发布到法国」'
              : release.state === 'idle'
                ? '发版前点「发版预检」看能不能发（只读，不暂停、不发版）。真发版点上面「在用版本」里的「发布到法国」'
                : release.why}
        </p>
      </div>
      {preflight.isError ? (
        <Notice tone="fail">
          预检请求没发出去：
          {preflight.error instanceof Error ? preflight.error.message : String(preflight.error)}
        </Notice>
      ) : null}
      {result ? (
        <div className="border-t pt-3">
          {result.state === 'unreadable' ? (
            <p className="text-body text-ink-stall">没查成：{result.why}</p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusBadge
                  tone={result.code === 0 ? 'done' : 'fail'}
                  label={result.code === 0 ? '能发' : '不能发'}
                />
                {result.code === 0 ? (
                  result.stdout.includes('：留意') ? (
                    <span className="text-meta text-muted-foreground">能发。有几项要留意，看下面</span>
                  ) : null
                ) : (
                  <span className="text-meta text-muted-foreground">不能发，看下面哪一项卡住或读不到</span>
                )}
              </p>
              <p className="mt-1.5 text-meta text-muted-foreground">
                <span className="num">{result.command}</span>
                {' · '}
                退出码 {result.code ?? '（没给）'}
                {result.signal ? `，信号 ${result.signal}` : ''}
                {' · 用了 '}
                {Math.round(result.durationMs / 100) / 10} 秒{result.timedOut ? '（读超时被停）' : ''}
                {result.truncated ? '（输出超长已截断）' : ''}
              </p>
              {result.stdout ? (
                <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-meta whitespace-pre-wrap">
                  {result.stdout}
                </pre>
              ) : null}
              {result.stderr ? (
                <>
                  <p className="mt-2 text-meta font-medium text-ink-stall">报错：</p>
                  <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-muted p-3 text-meta whitespace-pre-wrap">
                    {result.stderr}
                  </pre>
                </>
              ) : null}
              {!result.stdout && !result.stderr ? (
                <p className="mt-2 text-meta text-muted-foreground">这次没产出任何输出。</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function JobsTable({ jobs, now }: { jobs: readonly JobView[]; now: number }) {
  if (jobs.length === 0) {
    return <EmptyState icon={Timer} title="这台环境一个定时任务都没有。" />;
  }
  return (
    <>
      <JobListHead />
      <ul className="divide-y" data-job-list>
        {problemsFirst(jobs).map((j) => (
          <JobListRow key={j.id} j={j} now={now} />
        ))}
      </ul>
    </>
  );
}

/**
 * 对照表的一列（多台时才画）：列头一行名字和「本台 / 远程」，一行灰字写读于 / 上报于 / 失联多久和一句说明；选中时列头底色加下划线。
 * 这一列占父网格的 1 + 6 行（subgrid），六项各落一行，和别的列同一项横着对齐。
 */
function EnvColumn({
  id,
  name,
  badge,
  age,
  tone,
  selected,
  note,
  children,
}: {
  id: string;
  name: string;
  badge: string;
  age: string;
  tone: 'ok' | 'stale';
  selected: boolean;
  note?: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <section
      data-env-column={id}
      data-env-column-state={tone}
      data-env-selected={selected}
      aria-current={selected ? true : undefined}
      className={cn(
        // 不是卡片：整排环境在同一个区块里，列之间一条分隔线。
        // 手机一列上下叠，不用 subgrid 对齐；md 起每台一列、六项各落一行（subgrid）
        // grid-cols-1（minmax(0,1fr)）：列头和行里不折的长句不把这一列撑宽（手机上远程列曾被撑出屏幕）
        'grid min-w-0 grid-cols-1 gap-0 border-t first:border-t-0 md:row-span-7 md:grid-rows-subgrid md:border-t-0 md:border-l md:first:border-l-0',
        // 失联 / 没数据：整块降对比度，别让旧的「在跑」「N 项红」看起来像现在的状态
        tone === 'stale' && 'text-muted-foreground opacity-70',
      )}
    >
      <header
        data-env-header
        data-selected={selected}
        // 选中（正在看的那台）：列头选中底色；不再画 2px 的黑下划线
        className={cn('px-4 py-3', selected && 'bg-selected')}
      >
        <h3 className="flex min-w-0 items-center gap-2 whitespace-nowrap text-heading">
          <ServerCog className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{name}</span>
          <Tag>{badge}</Tag>
        </h3>
        <p className="mt-1 flex min-w-0 gap-1.5 text-meta whitespace-nowrap">
          <span
            data-env-age
            className={cn('num shrink-0', tone === 'stale' ? 'text-ink-stall' : 'text-muted-foreground')}
          >
            {age}
          </span>
          {note ? (
            <span className="min-w-0 truncate text-muted-foreground" title={note}>
              · {note}
            </span>
          ) : null}
        </p>
      </header>
      {children}
    </section>
  );
}

/** 一列里占满六行的那一块（没收到快照、读失败、在读）。 */
function Whole({ children }: { children: ReactNode }) {
  const style = { '--fact-rows': FACT_ROWS } as CSSProperties;
  return (
    <div className="row-span-env-facts border-t p-4" style={style}>
      {children}
    </div>
  );
}

/** 这一列的快照 404：没有这个环境，给回主页的路，不给「重试」（#1221）。 */
function MissingSnapshot({ nodeId }: { nodeId: string }) {
  return (
    <div role="alert">
      <EmptyState
        icon={SearchX}
        title="没有这个环境"
        hint={
          <>
            <span className="block">
              库里没有编号为「<span className="num">{nodeId}</span>
              」的环境：可能链接里的编号写错了，或这个环境已经不在了。
            </span>
            <Button asChild size="sm" variant="outline" className="mt-3">
              <Link to="/">回主页</Link>
            </Button>
          </>
        }
      />
    </div>
  );
}

/**
 * 这一页几块自己重拉（本台、发版卡 1 分钟，其余 30 秒）。
 * 超过 5 分钟最旧的一块还没再读成，刷新条才标「数据已过期」（正常间隔里不标）。
 */
const FRANCE_STALE_AFTER_MS = 5 * TIME.MIN;

/**
 * 远程环境超过这么久没报，就不再占对照列，收成六项下面的一行（#1888，取代手机上才折的 #1837）。
 * 24 小时：一天没报的环境，旧的「在跑」「N 项红」不再有对比价值；正在看的那台（选中）不收。
 */
const STALE_NODE_FOLD_MS = 24 * TIME.HOUR;

const isLongGone = (n: NodeListItem, now: number): boolean =>
  freshnessNow(n, now) === 'stale' &&
  n.receivedAt !== undefined &&
  now - Date.parse(n.receivedAt) > STALE_NODE_FOLD_MS;

/**
 * 六项下面收起的几行：每台超过阈值没报的远程环境一行（名字、多久没报），行尾「点开看快照」，
 * 点开才画最后一次的快照（照对照列的画法，标明是旧数据）。不报对不跑引擎的环境是常态，所以点是灰的、不用红。
 */
function StaleNodes({
  nodes,
  snapshotOf,
  now,
}: {
  nodes: readonly NodeListItem[];
  snapshotOf: (
    n: NodeListItem,
  ) => { error: unknown; data: NodeDetail | undefined; refetch: () => unknown } | undefined;
  now: number;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div data-env-gone-list className="divide-y border-t">
      {nodes.map((n) => {
        const isOpen = open.has(n.id);
        const gap = formatDuration(now - Date.parse(n.receivedAt ?? ''));
        const line = `${n.name}：${gap}没报（不跑引擎时正常）`;
        return (
          <div key={n.id} data-env-gone={n.id}>
            <RowFrame>
              <StatusDot tone="stop" />
              <p className="min-w-0 flex-1 truncate text-body" title={line}>
                <span className="font-medium">{n.name}</span>
                <span className="text-muted-foreground">：{gap}没报（不跑引擎时正常）</span>
                <span className="sr-only">，点开看最后一次的快照</span>
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={isOpen}
                onClick={() => toggle(n.id)}
                className="shrink-0 text-muted-foreground max-md:min-h-10"
              >
                {isOpen ? '收起' : '点开看快照'}
                <ChevronDown
                  className={cn('size-4 transition-transform duration-200', isOpen && 'rotate-180')}
                  aria-hidden
                />
              </Button>
            </RowFrame>
            {isOpen ? (
              <RowDetail className="pb-3">
                <div className="overflow-hidden rounded-lg border">
                  <div
                    data-env-columns={1}
                    className="grid grid-cols-env-compare gap-0"
                    style={{ '--env-cols': 1 } as CSSProperties}
                  >
                    <RemoteColumn n={n} snap={snapshotOf(n)} now={now} selected={false} />
                  </div>
                </div>
              </RowDetail>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

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

/** 总开关关着、引擎进程仍在跑时，贴在开关和「在跑」那一项底下。 */
function StandbyNote() {
  return (
    <p className="mt-2 text-meta leading-relaxed text-muted-foreground">
      总开关关着只是不派活，引擎进程还在跑，所以这一格仍可能写「在跑」。
    </p>
  );
}

/** 远程环境的一列。快照按编号读，404 不重试；推送重读不清掉上一次的失败（#1221）。 */
function RemoteColumn({
  n,
  snap,
  now,
  selected,
  engineNote,
}: {
  n: NodeListItem;
  snap: { error: unknown; data: NodeDetail | undefined; refetch: () => unknown } | undefined;
  now: number;
  selected: boolean;
  engineNote?: ReactNode;
}) {
  const f = freshnessNow(n, now);
  const error = useShownError(n.id, { error: snap?.error, data: snap?.data });
  const age = nodeAgeText(n, now);
  const stale = f !== 'fresh';
  // 超过 24 小时没报的：年龄标成「x 天前的旧数据」，别让人当成现在的样子（收成一行的逻辑在 France 里，#1888）
  const longGone = isLongGone(n, now);
  const body =
    f === 'never' || snap === undefined ? (
      <Whole>
        <p data-env-never className="text-body text-muted-foreground">
          配了通行证，但从没收到过{n.name}
          的快照：先去那台上把推送接上（docs/ops.md「接上法国看板」）。
        </p>
      </Whole>
    ) : error && isNotFound(error) ? (
      <Whole>
        <MissingSnapshot nodeId={n.id} />
      </Whole>
    ) : error ? (
      <Whole>
        <LoadError what={`${n.name}的快照`} error={error} onRetry={() => void snap.refetch()} />
      </Whole>
    ) : snap.data ? (
      <div className="contents">
        {factCells({
          facts: snap.data.env.facts,
          now,
          kind: 'env',
          look: 'row',
          engineNote,
          muted: stale,
        })}
      </div>
    ) : (
      <Whole>
        <LoadingRows rows={4} />
      </Whole>
    );
  return (
    <EnvColumn
      id={n.id}
      name={snap?.data?.name ?? n.name}
      badge="远程"
      age={
        f === 'fresh'
          ? `上报于 ${age}`
          : longGone && n.receivedAt !== undefined
            ? `${formatDuration(now - Date.parse(n.receivedAt))}前的旧数据`
            : age
      }
      tone={stale ? 'stale' : 'ok'}
      selected={selected}
      note={
        f === 'stale'
          ? '失联，以下是旧数据。下面是它最后一次报的样子，不是现在的；要看现在的请去那台上看。'
          : f === 'never'
            ? '失联，以下是旧数据'
            : f === 'fresh'
              ? '只读快照：写操作（暂停派活、叫停）要去那台上做。'
              : undefined
      }
    >
      {body}
    </EnvColumn>
  );
}

/**
 * 标题块的结论：本台现在最该看的那一件（健康红、引擎没连上、没查成、落后主线、定时任务失败，按轻重排），
 * 一件都没有就是「引擎在跑，六项都正常」。其余几件进灰字行。
 */
function verdictOf(
  facts: EnvFacts,
  card: ReleaseCard | undefined,
  jobsFailed: number,
): { tone: Tone; badge: string; text: string; rest: string[] } {
  const issues: { tone: Tone; text: string }[] = [];
  const failing = facts.health.ok ? facts.health.value.failing : [];
  if (failing.length > 0) issues.push({ tone: 'fail', text: `健康 ${failing.length} 项红` });
  if (facts.engine.ok && facts.engine.value.state === 'down')
    issues.push({ tone: 'fail', text: '引擎没连上' });
  if (jobsFailed > 0) issues.push({ tone: 'fail', text: `定时任务失败 ${jobsFailed} 个` });
  if (facts.engine.ok && facts.engine.value.state === 'off')
    issues.push({ tone: 'stall', text: '引擎按配置没开' });
  const unread = factsUnread(facts);
  if (unread > 0) issues.push({ tone: 'stall', text: `${unread} 项没查成` });
  const behind =
    card?.gap.state === 'ahead'
      ? card.gap.count
      : facts.version.ok && facts.version.value.behind !== null
        ? facts.version.value.behind
        : 0;
  if (behind > 0) issues.push({ tone: 'wait', text: `落后主线 ${behind} 个提交` });
  const [first, ...rest] = issues;
  if (!first) return { tone: 'done', badge: '正常', text: '引擎在跑，六项都正常', rest: [] };
  const badge = first.tone === 'fail' ? '要处理' : first.tone === 'stall' ? '要留意' : '可以发版';
  return { tone: first.tone, badge, text: first.text, rest: rest.map((x) => x.text) };
}

/**
 * 本台的标题块（照路由页的用途标题块）：名字一行（subtitle）；结论短话带状态一行；读于何时、名字的问题、其余几件一行灰字。
 * 三行都不折：放不下截断，整句在悬停里。名字不是标题元素（页标题是「法国」，各列的列头才是）。
 */
function FranceHero({
  env,
  card,
  jobsFailed,
  now,
}: {
  env: EnvResponse;
  card: ReleaseCard | undefined;
  jobsFailed: number;
  now: number;
}) {
  const v = verdictOf(env.facts, card, jobsFailed);
  const notes = [`${formatAgo(env.asOf, now)}读`, env.name.problem, ...v.rest]
    .filter((x): x is string => Boolean(x))
    .join(' · ');
  return (
    <header data-france-hero className="flex min-w-0 flex-col pt-1">
      <div className="mb-3 flex min-w-0 items-baseline gap-2 whitespace-nowrap">
        <p className="truncate text-title" data-machine-name>
          {env.name.name}
        </p>
        <span className="shrink-0 text-meta text-muted-foreground">本台</span>
      </div>
      <p
        data-hero-line
        title={v.text}
        className="flex min-w-0 items-center gap-2.5 whitespace-nowrap text-heading font-normal"
      >
        <span data-hero-text className="min-w-0 truncate">
          {v.text}
        </span>
        <span className="shrink-0">
          <StatusBadge tone={v.tone} label={v.badge} />
        </span>
      </p>
      <p data-hero-notes title={notes} className="mt-1.5 truncate text-meta text-muted-foreground">
        {notes}
      </p>
    </header>
  );
}

type CliOk = Extract<CliToolsResponse, { state: 'ok' }>;
type CliGroup = CliOk['groups'][number];
type CliRow = CliGroup['rows'][number];

function upgradeBadge(
  outcome: NonNullable<CliRow['upgrade']>['outcome'],
): { tone: LayoutTone; label: string } | null {
  switch (outcome) {
    case 'ok':
      return { tone: 'done', label: '已升级' };
    case 'current':
      return { tone: 'done', label: '已是这一版' };
    case 'skipped':
      return { tone: 'stop', label: '这轮不升' };
    case 'failed':
      return { tone: 'fail', label: '没成' };
    case 'rolled-back':
      return { tone: 'fail', label: '已退回' };
    case 'refused':
      return { tone: 'stall', label: '没换' };
    default:
      return null;
  }
}

function cliTone(kind: CliRow['status']['kind']): LayoutTone {
  switch (kind) {
    case 'current':
      return 'done';
    case 'behind':
    case 'behind-uncounted':
      return 'stall';
    case 'unread':
      return 'fail';
    case 'unreadable':
      return 'doubt';
  }
}

function cliBit(prefix: string, cell: CliRow['installed']): string {
  return cell.state === 'ok' ? `${prefix} ${cell.version}` : `${prefix} ${cell.why}`;
}

/** 六项下面的一块：两个用户和全局 npm 分开列。升过的同一行带升上去的版本和上次升级时间。没有升级按钮。 */
function CliToolsBlock({ query, now }: { query: ReturnType<typeof useCliTools>; now: number }) {
  const title = '命令行工具';
  const description = '两个会话用户各一份，再加上全局 npm。升完能看到新版本和上次升级时间。没有升级按钮。';
  if (query.error) {
    return (
      <Section title={title} description={description} data-cli-tools>
        <LoadError what="命令行工具" error={query.error} onRetry={() => void query.refetch()} />
      </Section>
    );
  }
  if (query.isLoading || !query.data) {
    return (
      <Section title={title} description={description} data-cli-tools>
        <LoadingRows rows={4} />
      </Section>
    );
  }
  if (query.data.state === 'unreadable') {
    return (
      <Section title={title} description={description} tone="doubt" data-cli-tools>
        <Notice tone="stall" title="没查成">
          {query.data.why}
        </Notice>
      </Section>
    );
  }
  return (
    <Section flush title={title} description={description} data-cli-tools>
      {query.data.upgradeNote ? (
        <div className="border-b p-4">
          <Notice tone="stall" title="升级结果没查成">
            {query.data.upgradeNote}
          </Notice>
        </div>
      ) : null}
      {query.data.groups.map((group) => (
        <div
          key={`${group.scope}:${group.owner}`}
          data-cli-group={group.scope === 'npm' ? 'npm' : group.owner}
        >
          <p className="truncate border-b px-4 py-2 text-meta text-muted-foreground">{group.title}</p>
          <List>
            {group.rows.map((row) => {
              const reason = 'reason' in row.status ? row.status.reason : null;
              const installedWhy = row.installed.state === 'ok' ? null : row.installed.why;
              const latestWhy = row.latest.state === 'ok' ? null : row.latest.why;
              const extra = reason && reason !== installedWhy && reason !== latestWhy ? reason : null;
              const badge = upgradeBadge(row.upgrade?.outcome ?? null);
              const upgradedVersion =
                row.upgrade?.version && (row.upgrade.outcome === 'ok' || row.upgrade.outcome === 'current')
                  ? row.upgrade.version
                  : null;
              return (
                <ListRow
                  key={row.tool}
                  tall
                  rail={row.status.kind === 'current' ? undefined : cliTone(row.status.kind)}
                  title={row.name}
                  data-cli-tool={row.tool}
                  meta={
                    <MetaLine
                      items={[
                        cliBit('在用', row.installed),
                        cliBit('官方最新', row.latest),
                        row.checkedAt ? `检查于 ${formatAgo(row.checkedAt, now)}` : '还没检查',
                        upgradedVersion,
                        row.upgrade?.upgradedAt ? `上次升级 ${formatAgo(row.upgrade.upgradedAt, now)}` : null,
                        extra,
                      ]}
                    />
                  }
                  trailing={
                    <span className="flex shrink-0 items-center gap-1.5">
                      {badge ? <StatusBadge tone={badge.tone} label={badge.label} /> : null}
                      <StatusBadge tone={cliTone(row.status.kind)} label={row.status.label} />
                    </span>
                  }
                />
              );
            })}
          </List>
        </div>
      ))}
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
  const preflight = useFrancePreflight();
  const { nodeId } = useNodeSelection();
  const now = useNow();
  const facts = env.data?.facts;
  const jobList = jobs.data?.jobs;
  const failed = jobList?.filter((j) => j.lastRun?.outcome === 'failed').length ?? 0;
  const warn = jobList?.filter((j) => rowTone(j) === 'stall').length ?? 0;
  const remote = nodes.data?.nodes ?? [];
  // 收到过快照的远程环境各读一份；从没收到过的（never）没有快照可读，那一列只写「从没收到过」
  const received = remote.filter((n) => n.receivedAt !== undefined);
  const snapshots = useNodeSnapshots(received.map((n) => n.id));
  // 列表还没回来时先别画：不然会先按「一台」画出六行，有远程时再跳成对照列。
  const nodesPending = nodes.isPending && nodes.data === undefined;
  // 超过 24 小时没报的（没选中的）收成六项下面的一行，不进对照列（#1888）
  const folded = remote.filter((n) => nodeId !== n.id && isLongGone(n, now));
  const shown = remote.filter((n) => !folded.includes(n));
  // 只剩本台（列表读成了、一台远程都没有，或远程都收成了一行）不画对照列。读列表失败也不画空的对照列，本台照单台画，上面写明没读成。
  const comparing = shown.length > 0;
  const snapshotOf = (n: NodeListItem) => {
    const i = received.findIndex((r) => r.id === n.id);
    return i < 0 ? undefined : snapshots[i];
  };
  const goneRows = folded.length > 0 ? <StaleNodes nodes={folded} snapshotOf={snapshotOf} now={now} /> : null;
  // 「在用版本」那一行的发布入口（#1255）：只给本台那一列；发版卡读不到写没查成和原因，不画一个点不了的假按钮。
  const selectedEngine =
    nodeId === null
      ? facts?.engine
      : snapshots[received.findIndex((n) => n.id === nodeId)]?.data?.env.facts.engine;
  // 总开关是人给的许可，那一格的「在跑」是进程还活着。两件同时出现才解释，避免关着且进程也停了还说「还在跑」。
  const standby =
    masterView.kind === 'ok' &&
    !masterView.master.on &&
    selectedEngine?.ok === true &&
    selectedEngine.value.state === 'on';

  const versionExtra = card.error ? (
    <p className="text-meta text-ink-stall" data-release-entry-unread>
      发布入口没查成：{errorText(card.error)}
    </p>
  ) : !card.data ? (
    <p className="text-meta text-muted-foreground">正在读发布入口…</p>
  ) : (
    <ReleaseEntry card={card.data} now={now} />
  );

  const read = pageRead([env, nodes, jobs, release, card, cli, ...snapshots]);
  const ready = !(nodesPending || env.isLoading || !env.data || !facts);

  const localCells = (kind: 'env' | 'france', look: 'row' | 'tile') =>
    facts
      ? factCells({
          facts,
          now,
          kind,
          look,
          jobCount: jobList?.length,
          versionExtra,
          engineNote: nodeId === null && standby ? <StandbyNote /> : undefined,
        })
      : [];

  let factsBlock: ReactNode = null;
  if (!ready) {
    factsBlock = env.error ? null : <LoadingRows rows={2} />;
  } else if (comparing && env.data) {
    factsBlock = (
      <Section flush title="本台和远程环境" description="每个环境一列，六项各占一行，横着对比。">
        <div
          data-env-columns={1 + shown.length}
          className="grid grid-cols-env-compare gap-0"
          style={{ '--env-cols': 1 + shown.length } as CSSProperties}
        >
          <EnvColumn
            id="local"
            name={env.data.name.name}
            badge="本台"
            age={`${formatAgo(env.data.asOf, now)}读`}
            tone="ok"
            selected={nodeId === null}
            note={[env.data.name.problem, facts ? factsSummary(facts) : null].filter(Boolean).join(' · ')}
          >
            {localCells('env', 'row')}
          </EnvColumn>
          {shown.map((n) => (
            <RemoteColumn
              key={n.id}
              n={n}
              snap={snapshotOf(n)}
              now={now}
              selected={nodeId === n.id}
              engineNote={nodeId === n.id && standby ? <StandbyNote /> : undefined}
            />
          ))}
        </div>
        {goneRows}
      </Section>
    );
  } else {
    // 只有本台：一个区块里六行，宽屏两栏各三行（引擎、会话、池 | 健康、版本、拉单）
    const cells = localCells('france', 'tile');
    factsBlock = (
      <Section flush>
        <div className="grid lg:grid-cols-2">
          <div className="min-w-0 divide-y">{cells.slice(0, 3)}</div>
          <div className="min-w-0 divide-y max-lg:border-t lg:border-l">{cells.slice(3)}</div>
        </div>
        {goneRows}
      </Section>
    );
  }

  return (
    <Page
      title="法国"
      description="本台的六项事实、引擎总开关、命令行工具、定时任务和发版。"
      detail={`读不到的写「没查成」和原因，不拿 0 顶。环境、发版卡、命令行工具每 ${POLL_SLOW_MS / 1000} 秒刷新；机器、定时任务、发版进度每 ${POLL_FAST_MS / 1000} 秒刷新。多一台机器时按台并排比。`}
      refresh={{
        onRefresh: () => void read.refetch(),
        isFetching: read.isFetching,
        dataUpdatedAt: read.dataUpdatedAt,
        staleAfterMs: FRANCE_STALE_AFTER_MS,
      }}
    >
      <SectionGrid cols={1}>
        {ready && env.data ? (
          <FranceHero env={env.data} card={card.data} jobsFailed={failed} now={now} />
        ) : null}
        {nodes.error || env.error ? (
          <div className="space-y-3">
            {nodes.error ? (
              <LoadError what="远程环境列表" error={nodes.error} onRetry={() => void nodes.refetch()} />
            ) : null}
            {env.error ? (
              <LoadError what="本台" error={env.error} onRetry={() => void env.refetch()} />
            ) : null}
          </div>
        ) : null}
        <div className="space-y-4">
          <EngineMasterControl standbyNote={standby ? <StandbyNote /> : null} />
          {factsBlock}
          <CliToolsBlock query={cli} now={now} />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-3">
          <Section
            className="min-w-0 xl:col-span-2"
            title={
              <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
                定时任务
                {jobList ? (
                  <span className="num truncate text-meta font-normal text-muted-foreground">
                    共 {jobList.length} 项
                    {failed ? <span className="text-ink-fail"> · 失败 {failed}</span> : null}
                    {warn ? <span className="text-ink-stall"> · 没查全或过期 {warn}</span> : null}
                  </span>
                ) : null}
              </span>
            }
            description="出问题的排在前面：失败红，没查全 / 过期黄。"
            actions={
              <Link
                to="/schedules"
                className="inline-flex items-center gap-0.5 text-meta text-muted-foreground hover:text-foreground max-md:min-h-10"
              >
                全部定时任务
                <ArrowRight className="size-3" aria-hidden />
              </Link>
            }
            flush
          >
            {jobs.error ? (
              <div className="p-4">
                <LoadError what="定时任务" error={jobs.error} onRetry={() => void jobs.refetch()} />
              </div>
            ) : jobs.isLoading || !jobs.data ? (
              <div className="p-4">
                <LoadingRows rows={4} />
              </div>
            ) : (
              <JobsTable jobs={jobs.data.jobs} now={now} />
            )}
          </Section>

          <div className="min-w-0 space-y-4">
            <Section title="发版" description="主线和法国差几个、最近做完的一个任务（只读）。">
              {card.error ? (
                <LoadError what="发版卡" error={card.error} onRetry={() => void card.refetch()} />
              ) : card.isLoading || !card.data ? (
                <LoadingRows rows={4} />
              ) : (
                <ReleaseCardBody card={card.data} now={now} />
              )}
            </Section>
            <Section
              title="发版一键"
              description="发版预检只读，不暂停、不发版。真发版点「在用版本」那一行的「发布到法国」。"
            >
              {release.error ? (
                <LoadError what="发版一键" error={release.error} onRetry={() => void release.refetch()} />
              ) : release.isLoading || !release.data ? (
                <LoadingRows rows={2} />
              ) : (
                <ReleaseBody release={release.data} preflight={preflight} />
              )}
            </Section>
          </div>
        </div>
      </SectionGrid>
    </Page>
  );
}
