// 法国页（#618 的总览 + #820 的对照 + #1086 的总开关，#1217 合成一页）：本机 WSL 撤了以后只剩法国一台，
// 侧栏只留「法国」。一页里有本台六项事实、引擎总开关、定时任务、发版。多一台机器时六项按台并排（对照表的写法）。
// 旧地址 /env 由 routes/env.tsx 转到这里。
//
// 「发版一键」只到预检：命令后端写死 pnpm release:onekey preflight，不收参数、不开任意 CLI 口子；预检是只读的——暂停、发版它都不做。
// 真发版：点「在用版本」那一行里的「发布到法国」（#1232、#1255，components/release-card.tsx 的 ReleaseEntry；后端只写请求文件，法国上 root 的单元接活），或走 pnpm release:onekey start。
// 发版单位是主线提交（决定 0032）：那一行写明落后几个提交、要发的主线头提交号和标题；下面的「发版」卡只读。
//
// 数据从哪来（不新开接口）：
// - /api/env（本台六项事实）、/api/jobs（定时任务）、发版状态和预检、/api/nodes（远程环境列表和快照，多台时并排）。
// - 在法国真机的驾驶舱上打开，本台就是法国；在本地开发 / 演示 mock 上打开，本台是这台后端自己的数。
// - 每一项都按后端给的 ok / reason 两态如实画：读不到就写「没查成 + 原因」，不拿 0 或假 ok 冒充（仓的底线）。
//
// 版式：只有一台时六格排成卡片（不画对照列）；两台及以上每个环境一列、六项各占一行用 subgrid 对齐。
// 下面左边定时任务表（出问题的排前面）、右边发版。六格怎么画在 components/env-facts.tsx。

import { ArrowRight, ChevronDown, Rocket, SearchX, ServerCog } from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import {
  errorText,
  isNotFound,
  useEnv,
  useFrancePreflight,
  useFranceReleaseCard,
  useFranceReleaseState,
  useJobs,
  useNodeSnapshots,
  useNodes,
} from '../api/client';
import type {
  FrancePreflightResponse,
  FranceReleaseState,
  JobView,
  NodeDetail,
  NodeListItem,
} from '../api/types';
import { useMasterView } from '../components/engine-master';
import { EngineMasterControl } from '../components/engine-master-card';
import { FACT_ROWS, factCells, factsSummary } from '../components/env-facts';
import { JobListHead, JobListRow, rowTone } from '../components/job-row';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { ReleaseCardBody, ReleaseEntry } from '../components/release-card';
import { Button } from '../components/ui/button';
import { formatAgo, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { freshnessNow, nodeAgeText, useNodeSelection } from '../lib/node';
import { useShownError } from '../lib/shown-error';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';

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

const RELEASE_TONE: Partial<Record<Tone, string>> = { stall: 'text-ink-stall', fail: 'text-ink-fail' };

/**
 * 发版（#618）：release-train 此刻的状态 + 「发版预检」按钮。
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
  const tone: Tone | undefined =
    release.state === 'running' ? 'stall' : release.state === 'paused' ? 'fail' : undefined;
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Rocket className="size-3.5 opacity-70" aria-hidden />
          release-train 此刻
        </div>
        <div
          className={cn(
            'mt-1 text-title leading-tight font-semibold tracking-tight',
            tone ? RELEASE_TONE[tone] : undefined,
          )}
        >
          {release.state === 'running'
            ? release.status === 'blocked'
              ? '卡住了'
              : release.status === 'failed'
                ? '没成'
                : '在走'
            : release.state === 'paused'
              ? '暂停标记没人收'
              : release.state === 'idle'
                ? '没在走'
                : '没查成'}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {release.state === 'running'
            ? `${release.phase} · ${release.target}${release.marker ? ' · 派活已暂停' : ' · 暂停标记没写'}${release.why ? ` · ${release.why}` : ''}`
            : release.state === 'paused'
              ? '暂停标记在、但一趟的记录不在：之前 abort 没把标记清掉。要发版前先用 pnpm release:onekey abort 收掉它'
              : release.state === 'idle'
                ? '发版前点「发版预检」核一遍（只读，不暂停、不发版）；真发版走 pnpm release:onekey start'
                : release.why}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={preflight.isPending}
        onClick={() => preflight.mutate()}
      >
        {preflight.isPending ? '预检在跑…' : '发版预检'}
      </Button>
      {preflight.isError ? (
        <div className="rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sm text-ink-fail">
          预检请求没发出去：
          {preflight.error instanceof Error ? preflight.error.message : String(preflight.error)}
        </div>
      ) : null}
      {result ? (
        <div className="rounded-lg border p-3">
          {result.state === 'unreadable' ? (
            <p className="text-sm text-ink-stall">没查成：{result.why}</p>
          ) : (
            <>
              <div
                className={cn('text-sm font-medium', result.code === 0 ? 'text-ink-done' : 'text-ink-fail')}
              >
                {result.code === 0 ? '预检过了' : '预检没过（退出码不是 0；看下面输出找哪一项卡住）'}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="num">{result.command}</span>
                {' · '}
                退出码 {result.code ?? '（没给）'}
                {result.signal ? `，信号 ${result.signal}` : ''}
                {' · 跑了 '}
                {Math.round(result.durationMs / 100) / 10} 秒{result.timedOut ? '（60 秒到点了被杀）' : ''}
                {result.truncated ? '（输出超 512KB 已截断）' : ''}
              </p>
              {result.stdout ? (
                <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                  {result.stdout}
                </pre>
              ) : null}
              {result.stderr ? (
                <>
                  <p className="mt-2 text-xs font-medium text-ink-stall">
                    stderr（release-train 的报错 / 没成的行都在这）：
                  </p>
                  <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                    {result.stderr}
                  </pre>
                </>
              ) : null}
              {!result.stdout && !result.stderr ? (
                <p className="mt-2 text-xs text-muted-foreground">这次没产出任何输出。</p>
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
    return <p className="px-4 py-6 text-sm text-muted-foreground">这台环境一个定时任务都没有。</p>;
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
 * 对照表的一列（多台时才画）：环境名、本台还是远程、读于 / 上报于 / 失联多久、选中时描边。
 * 这一列占父网格的 1 + 6 行（subgrid），六格各落一行，和别的列同一项横着对齐。
 */
function EnvColumn({
  id,
  name,
  badge,
  age,
  tone,
  selected,
  note,
  onFold,
  children,
}: {
  id: string;
  name: string;
  badge: string;
  age: string;
  tone: 'ok' | 'stale';
  selected: boolean;
  note?: ReactNode;
  /** 有就在头上画「收起」（手机上点开过的失联环境）。 */
  onFold?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <section
      data-env-column={id}
      data-env-column-state={tone}
      data-env-selected={selected}
      className={cn(
        // 手机一列上下叠，不用 subgrid 对齐；md 起每台一列、六项各落一行（subgrid）
        'grid min-w-0 gap-0 overflow-hidden md:row-span-7 md:grid-rows-subgrid rounded-xl border bg-card shadow-card-edge',
        selected && 'border-brand/60 ring-1 ring-brand/30',
        // 失联 / 没数据：整块置灰，别让旧的「在跑」「N 项红」看起来像现在的状态
        tone === 'stale' && 'bg-muted/40 text-muted-foreground opacity-70 shadow-none',
      )}
    >
      <header className="px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 text-strong font-semibold tracking-tight">
          <ServerCog className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{name}</span>
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
            {badge}
          </span>
        </h2>
        <p
          data-env-age
          className={cn('num mt-1 text-xs', tone === 'stale' ? 'text-ink-stall' : 'text-muted-foreground')}
        >
          {age}
        </p>
        {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
        {onFold ? (
          <button
            type="button"
            aria-expanded
            onClick={onFold}
            className="mt-1 inline-flex min-h-10 items-center gap-1 text-xs text-muted-foreground underline underline-offset-2"
          >
            收起
          </button>
        ) : null}
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
      <Empty
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

/** 失联超过这么久，手机上这台默认折成一行。 */
const LONG_GONE_MS = TIME.DAY;

type ReadBlock = {
  refetch: () => unknown;
  isFetching: boolean;
  dataUpdatedAt: number;
};

/**
 * 多块合成标题栏那一条：点刷新每块都重读；「最后更新」取已经读成过的里面最旧的一块。
 * dataUpdatedAt 为 0 是「这块从没读成」，不是时刻，不拿来比——一块失败不能把整条写成「还没读到过」。
 * 各块自己的「重试」不在这里。发版预检是人点的命令，不跟着重放。
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

/** 总开关关着、引擎进程仍在跑时，贴在开关和「在跑」那一格旁边。 */
function StandbyNote() {
  return (
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
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
  look,
  engineNote,
}: {
  n: NodeListItem;
  snap: { error: unknown; data: NodeDetail | undefined; refetch: () => unknown } | undefined;
  now: number;
  selected: boolean;
  look: 'row';
  engineNote?: ReactNode;
}) {
  const f = freshnessNow(n, now);
  const error = useShownError(n.id, { error: snap?.error, data: snap?.data });
  const age = nodeAgeText(n, now);
  const stale = f !== 'fresh';
  // 手机上失联超过 24 小时的远程环境默认折成一行（#1837）：旧数据占半屏没用，点开才看；选中的那台不折
  const phone = usePhone();
  const [unfolded, setUnfolded] = useState(false);
  const longGone =
    f === 'stale' && n.receivedAt !== undefined && now - Date.parse(n.receivedAt) > LONG_GONE_MS;
  if (phone && longGone && !unfolded && !selected) {
    return (
      <section
        data-env-column={n.id}
        data-env-column-state="stale"
        data-env-collapsed
        className="min-w-0 rounded-xl border bg-muted/40 shadow-none"
      >
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setUnfolded(true)}
          className="flex min-h-10 w-full items-center gap-2 px-4 py-2 text-left text-sm text-muted-foreground"
        >
          <ServerCog className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {snap?.data?.name ?? n.name} · <span className="text-ink-stall">{age}</span>
          </span>
          <span className="shrink-0 text-xs">点开看旧数据</span>
          <ChevronDown className="size-4 shrink-0" aria-hidden />
        </button>
      </section>
    );
  }
  const body =
    f === 'never' || snap === undefined ? (
      <Whole>
        <p data-env-never className="text-sm text-muted-foreground">
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
          look,
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
      age={f === 'fresh' ? `上报于 ${age}` : age}
      tone={stale ? 'stale' : 'ok'}
      selected={selected}
      onFold={phone && longGone && !selected ? () => setUnfolded(false) : undefined}
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

export default function France() {
  const { view: masterView } = useMasterView();
  const env = useEnv();
  const nodes = useNodes();
  const jobs = useJobs();
  const release = useFranceReleaseState();
  const card = useFranceReleaseCard();
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
  // 列表还没回来时先别画：不然会先按「一台」画出卡片，有远程时再跳成对照列。
  const nodesPending = nodes.isPending && nodes.data === undefined;
  // 只有一台（列表读成了、一台远程都没有）不画对照列。读列表失败也不画空的对照列，本台改用卡片，上面写明没读成。
  const comparing = remote.length > 0;
  const look = 'row' as const;
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
    <p className="mt-2 border-t pt-2 text-xs text-ink-stall" data-release-entry-unread>
      发布入口没查成：{errorText(card.error)}
    </p>
  ) : !card.data ? (
    <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">正在读发布入口…</p>
  ) : (
    <ReleaseEntry card={card.data} now={now} />
  );

  const read = pageRead([env, nodes, jobs, release, card, ...snapshots]);

  return (
    <Page
      title="法国"
      description="本台的六项事实、引擎总开关、定时任务、发版。读不到的写「没查成」和原因，不拿 0 顶；每 30 秒自己刷新。多一台机器时按台并排比。"
      actions={
        <RefreshBar
          onRefresh={() => void read.refetch()}
          isFetching={read.isFetching}
          dataUpdatedAt={read.dataUpdatedAt}
          staleAfterMs={FRANCE_STALE_AFTER_MS}
        />
      }
    >
      <EngineMasterControl standbyNote={standby ? <StandbyNote /> : null} />
      {nodes.error ? (
        <div className="mb-3">
          <LoadError what="远程环境列表" error={nodes.error} onRetry={() => void nodes.refetch()} />
        </div>
      ) : null}
      {env.error ? (
        <div className="mb-3">
          <LoadError what="本台" error={env.error} onRetry={() => void env.refetch()} />
        </div>
      ) : null}
      {nodesPending || env.isLoading || !env.data || !facts ? (
        env.error ? null : (
          <LoadingRows rows={2} />
        )
      ) : comparing ? (
        <div
          data-env-columns={1 + remote.length}
          className="grid grid-cols-env-compare gap-x-4 gap-y-3 md:gap-y-0"
          style={{ '--env-cols': 1 + remote.length } as CSSProperties}
        >
          <EnvColumn
            id="local"
            name={env.data.name.name}
            badge="本台"
            age={`${formatAgo(env.data.asOf, now)}读`}
            tone="ok"
            selected={nodeId === null}
            note={
              env.data.name.problem ? (
                <>
                  {env.data.name.problem}
                  {factsSummary(facts) ? <> · {factsSummary(facts)}</> : null}
                </>
              ) : (
                factsSummary(facts)
              )
            }
          >
            {factCells({
              facts,
              now,
              kind: 'env',
              look,
              jobCount: jobList?.length,
              versionExtra,
              engineNote: nodeId === null && standby ? <StandbyNote /> : undefined,
            })}
          </EnvColumn>
          {remote.map((n) => {
            const idx = received.findIndex((r) => r.id === n.id);
            return (
              <RemoteColumn
                key={n.id}
                n={n}
                snap={idx < 0 ? undefined : snapshots[idx]}
                now={now}
                selected={nodeId === n.id}
                look={look}
                engineNote={nodeId === n.id && standby ? <StandbyNote /> : undefined}
              />
            );
          })}
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground" data-machine-name>
            本台「<span>{env.data.name.name}</span>」· {formatAgo(env.data.asOf, now)}读
            {env.data.name.problem ? <> · {env.data.name.problem}</> : null}
            {factsSummary(facts) ? <> · {factsSummary(facts)}</> : null}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            {factCells({
              facts,
              now,
              kind: 'france',
              look: 'tile',
              jobCount: jobList?.length,
              versionExtra,
              engineNote: nodeId === null && standby ? <StandbyNote /> : undefined,
            })}
          </div>
        </>
      )}

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-3">
        <Panel
          className="min-w-0 xl:col-span-2"
          title={
            <span className="flex items-center gap-2">
              定时任务
              {jobList ? (
                <span className="num rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
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
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline underline-offset-2 max-md:min-h-10"
            >
              全部定时任务
              <ArrowRight className="size-3" />
            </Link>
          }
          bodyClassName="p-0"
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
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel
            title="发版"
            description="主线最新、法国在用、差几个、最近做完的一个任务（只读）；每一行读不到就写没查成和原因。要发布，点上面「在用版本」那一行的「发布到法国」。"
          >
            {card.error ? (
              <LoadError what="发版卡" error={card.error} onRetry={() => void card.refetch()} />
            ) : card.isLoading || !card.data ? (
              <LoadingRows rows={4} />
            ) : (
              <ReleaseCardBody card={card.data} now={now} />
            )}
          </Panel>
          <Panel
            title="发版一键"
            description="只到预检（只读）；真发版点上面「在用版本」那一行的「发布到法国」，或走 pnpm release:onekey start。"
          >
            {release.error ? (
              <LoadError what="发版一键" error={release.error} onRetry={() => void release.refetch()} />
            ) : release.isLoading || !release.data ? (
              <LoadingRows rows={2} />
            ) : (
              <ReleaseBody release={release.data} preflight={preflight} />
            )}
          </Panel>
        </div>
      </div>
    </Page>
  );
}
