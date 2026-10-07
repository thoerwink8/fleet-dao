// 法国总览（#618）：打开驾驶舱的 /france，一眼看到法国环境现在怎样——引擎在不在、在用哪版、健康红几项、定时任务跑得怎么样、发版走到哪。
// 「发版一键」只到预检：命令后端写死 pnpm release:onekey preflight，不收参数、不开任意 CLI 口子；预检是只读的——暂停、发版它都不做。
// 真发版走 pnpm release:onekey start，不放页面按钮。
//
// 数据从哪来：
// - 这一页全部只读，只调现成的接口：/api/env（六项事实，和环境页同一份）、/api/jobs（定时任务）、发版状态和预检。
// - 在法国真机的驾驶舱上打开，看到的就是法国；在本地开发 / 演示 mock 上打开，看到的是这台后端自己的数（这一页不替用户跨机器读）。
// - 每一项都按后端给的 ok / reason 两态如实画：读不到就写「没查成 + 原因」，不拿 0 或假 ok 冒充（仓的底线）。
//
// 版式（驾驶舱改版 2026-10-07）：六项事实一行排完（1366 屏两行）；下面左边定时任务表（出问题的排前面）、右边发版，
// 1920×1080 一屏看全。原来四张高卡片 + 一整行宽的发版卡 + 表从上往下堆，定时任务要往下翻才看得到。
// 六格怎么画在 components/env-facts.tsx（和环境页共用）。

import { ArrowRight, Rocket } from 'lucide-react';
import { Link } from 'react-router';
import { brand } from '#brand';
import {
  useEnv,
  useFrancePreflight,
  useFranceReleaseCard,
  useFranceReleaseState,
  useJobs,
} from '../api/client';
import type { FrancePreflightResponse, FranceReleaseState, JobView } from '../api/types';
import { factCells } from '../components/env-facts';
import { LoadError, LoadingRows, Page, Panel } from '../components/page';
import { ReleaseCardBody } from '../components/release-card';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { outcomeText } from '../lib/schedule';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('法国') }];
}

/** 定时任务表：失败红、没查全 / 过期黄（判法同 /schedules 页）。 */
function rowTone(j: JobView): 'fail' | 'stall' | null {
  if (j.lastRun?.outcome === 'failed') return 'fail';
  if (j.lastRun?.outcome === 'unscanned' || j.lastRun?.outcome === 'partial' || j.status !== 'fresh')
    return 'stall';
  return null;
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
            ? '在走'
            : release.state === 'paused'
              ? '暂停标记没人收'
              : release.state === 'idle'
                ? '没在走'
                : '没查成'}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {release.state === 'running'
            ? `${release.phase} · ${release.target}${release.marker ? ' · 派活已暂停' : ' · 暂停标记没写'}`
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">任务</TableHead>
          <TableHead className="w-36">周期</TableHead>
          <TableHead>上次结局</TableHead>
          <TableHead className="w-28 pr-4">上次跑成</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {problemsFirst(jobs).map((j) => {
          const tone = rowTone(j);
          const r = j.lastRun;
          return (
            <TableRow
              key={j.id}
              data-outcome={r?.outcome ?? (r ? 'running' : 'never')}
              data-status={j.status}
              className={cn(
                tone === 'fail' && 'bg-st-fail/[0.06] hover:bg-st-fail/[0.09]',
                tone === 'stall' && 'bg-st-stall/[0.07] hover:bg-st-stall/[0.1]',
              )}
            >
              <TableCell className="pl-4">
                <div className="font-medium">{j.name}</div>
                <div className="num text-xs text-muted-foreground">{j.id}</div>
              </TableCell>
              <TableCell className="num text-xs">{j.schedule}</TableCell>
              <TableCell
                className={cn(
                  'text-xs whitespace-normal',
                  r?.outcome === 'failed' && 'font-medium text-ink-fail',
                  (r?.outcome === 'unscanned' || r?.outcome === 'partial') && 'font-medium text-ink-stall',
                  r?.outcome === 'ok' && 'text-muted-foreground',
                )}
              >
                {outcomeText(j)}
                {r ? (
                  <span className="num block text-caption text-faint">{formatAgo(r.startedAt, now)}开始</span>
                ) : null}
              </TableCell>
              <TableCell className="num pr-4 text-xs text-muted-foreground">
                {j.lastSuccessAt ? (
                  formatAgo(j.lastSuccessAt, now)
                ) : (
                  <span className="text-xs text-ink-stall">从没跑成</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export default function France() {
  const env = useEnv();
  const jobs = useJobs();
  const release = useFranceReleaseState();
  const card = useFranceReleaseCard();
  const preflight = useFrancePreflight();
  const now = useNow();
  const facts = env.data?.facts;
  const jobList = jobs.data?.jobs;
  const failed = jobList?.filter((j) => j.lastRun?.outcome === 'failed').length ?? 0;
  const warn = jobList?.filter((j) => rowTone(j) === 'stall').length ?? 0;

  return (
    <Page
      title="法国"
      description="法国这台机器现在怎样：引擎、在用版本、健康、定时任务、发版。读不到的写「没查成」和原因，不拿 0 顶；每 30 秒自己刷新。"
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to="/env">
            各环境并排看
            <ArrowRight />
          </Link>
        </Button>
      }
    >
      {env.error ? (
        <div className="mb-3">
          <LoadError what="法国环境" error={env.error} onRetry={() => void env.refetch()} />
        </div>
      ) : null}
      {env.isLoading || !env.data || !facts ? (
        env.error ? null : (
          <LoadingRows rows={2} />
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          {factCells({ facts, now, kind: 'france', look: 'tile', jobCount: jobList?.length })}
        </div>
      )}

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
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
              className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline underline-offset-2"
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

        <div className="space-y-4">
          <Panel
            title="发版"
            description="主线最新、法国在用、差几个、最近做完的一个任务；每一行读不到就写没查成和原因。"
          >
            {card.error ? (
              <LoadError what="发版卡" error={card.error} onRetry={() => void card.refetch()} />
            ) : card.isLoading || !card.data ? (
              <LoadingRows rows={4} />
            ) : (
              <ReleaseCardBody card={card.data} now={now} />
            )}
          </Panel>
          <Panel title="发版一键" description="只到预检；真发版走 pnpm release:onekey start，不在页面上发。">
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
