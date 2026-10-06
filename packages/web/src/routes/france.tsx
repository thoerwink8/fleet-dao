// 法国总览（#618）：打开驾驶舱的 /france，一眼看到法国环境现在怎样——引擎在不在、在用哪版、健康红几项、定时任务跑得怎么样。
// 现已带「发版一键」卡：release-train 此刻的状态 + 「发版预检」按钮（只到预检，命令后端写死 pnpm release:onekey preflight，
// 不收参数、不开任意 CLI 口子；预检是只读的——暂停、发版它都不做）。真发版走 pnpm release:onekey start，不放页面按钮。
//
// 数据从哪来：
// - 这一页全部只读，只调现成的两个接口：/api/env（引擎、版本、健康、最近拉单等 7 项事实）和 /api/jobs（定时任务）。
// - 在法国真机的驾驶舱上打开，看到的就是法国；在本地开发 / 演示 mock 上打开，看到的还是这台后端自己的数（驾驶舱就是同一台机器的后端，
//   所谓「看法国」= 到法国那台机器的 hangdao.dpdns.org 上打开驾驶舱）。这一页不替用户跨机器读。
// - 每一项都按后端给的 ok / reason 两态如实画：读不到就写「没查成 + 原因」，不拿 0 或假 ok 冒充（仓的底线）；
//   假后端没接的（在 mock 里 version 就是「没有发布目录读不到在用版本」）照实显示那一句，也不遮。
//
// 改这里之前先看：
// - routes/env.tsx（#820 片 1 的环境页）：同一批 EnvFact 的画法、tile 的成败两态、等待色 ≠ 真坏了的红。
// - routes/schedules.tsx：定时任务表的「失败红、没查全 / 过期黄」判法，这一页的「要看的几项」照它。

import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  CalendarClock,
  CircleChevronDown,
  CircleDashed,
  HeartPulse,
  Power,
  Rocket,
  Tag,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { useEnv, useFrancePreflight, useFranceReleaseState, useJobs } from '../api/client';
import type {
  EnvEngine,
  EnvHealth,
  EnvSchedule,
  EnvVersion,
  FrancePreflightResponse,
  FranceReleaseState,
  JobView,
} from '../api/types';
import { LoadError, LoadingRows, Page, Panel } from '../components/page';
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

const DESCRIPTION =
  '在法国这台机器上打开这一页，看到的就是法国现在怎样：引擎在不在、在用哪版、落后主线没有、健康红几项、定时任务跑得怎么样。读不到的就写「没查成 + 原因」，不拿 0 顶。每 30 秒自动刷新。';

/** 等待色（黄系）和「真坏了」的红分开（和 env.tsx 同一判法）：关着、没跑成、落后主线是等情况，不是坏了。 */
const TONE_CLASS: Record<Tone, string> = {
  done: 'text-ink-done',
  run: 'text-ink-run',
  wait: 'text-ink-wait',
  human: 'text-ink-human',
  stall: 'text-ink-stall',
  fail: 'text-ink-fail',
  stop: 'text-ink-stop',
};

type Tile = { label: string; hint: string; icon: LucideIcon };

function TileHead({ label, hint, icon: Icon }: Tile) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate opacity-80">· {hint}</span>
    </span>
  );
}

/** 没查成的那一格：明说原因，画成虚线灰框（不是红、不是 0）。 */
function NotRead({ label, hint, icon, reason }: Tile & { reason: string }) {
  return (
    <div
      data-france-fact="unread"
      className="rounded-xl border border-dashed bg-card p-4 text-muted-foreground"
    >
      <TileHead label={label} hint={hint} icon={icon} />
      <div className="mt-2 flex items-baseline gap-2">
        <CircleDashed className="size-4 shrink-0 self-center text-ink-stall" aria-hidden />
        <span className="text-stat leading-none font-semibold tracking-tight text-ink-stall">没查成</span>
      </div>
      <p className="mt-2 text-xs">{reason}</p>
    </div>
  );
}

/** 查成了的那一格：大号等宽值 + 一句白话；tone 只给真正要提醒的那几种。 */
function Read({
  label,
  hint,
  icon: Icon,
  value,
  sub,
  tone,
  children,
}: Tile & {
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone | undefined;
  children?: ReactNode;
}) {
  return (
    <div data-france-fact="ok" className="rounded-xl border bg-card p-4 shadow-card-edge">
      <TileHead label={label} hint={hint} icon={Icon} />
      <div
        className={cn(
          'num mt-2 text-stat leading-none font-semibold tracking-tight',
          tone ? TONE_CLASS[tone] : undefined,
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-2 text-xs text-muted-foreground">{sub}</div> : null}
      {children}
    </div>
  );
}

/** 引擎：on/off/down/unknown 四态各说各的（写法同 env.tsx 的 engineWords）。 */
function engineWords(e: EnvEngine): {
  value: string;
  sub: string;
  tone: Tone | undefined;
} {
  switch (e.state) {
    case 'on':
      return {
        value: '在跑',
        sub: e.detail ?? '探到了在拉活的工人',
        tone: 'done',
      };
    case 'off':
      return {
        value: '按配置没开',
        sub: e.detail ?? '按 release.env 的 FLEET_SERVICES 没开',
        tone: 'stall',
      };
    case 'down':
      return {
        value: '没连上',
        sub: e.detail ?? '开着却探不到在线的工人',
        tone: 'fail',
      };
    case 'unknown':
      return {
        value: '没查成',
        sub: e.detail ?? '这台后端没有接引擎探针',
        tone: 'wait',
      };
  }
}

function EngineTile({ v }: { v: EnvEngine }) {
  const w = engineWords(v);
  return (
    <Read label="引擎" hint="在拉活的工人有没有" icon={Power} value={w.value} sub={w.sub} tone={w.tone} />
  );
}

/** 在用版本：落后主线多少、判出来的问题。读不出「在用哪版」时这一格后端会给 ok:false，外层走 NotRead。 */
function VersionTile({ v }: { v: EnvVersion }) {
  const behind = v.behind;
  const tone: Tone | undefined =
    v.current === null || v.problems.length > 0
      ? 'stall'
      : behind === null
        ? 'wait'
        : behind > 0
          ? 'wait'
          : 'done';
  return (
    <Read
      label="在用版本"
      hint="落后主线没有"
      icon={Tag}
      value={v.current === null ? '没查成' : v.current.slice(0, 12)}
      sub={v.detail}
      tone={tone}
    >
      {behind !== null && behind > 0 ? (
        <p className="mt-2 text-xs text-ink-stall">
          落后主线 {behind} 个提交（按版本发：要看这一版是不是最新发布标记那一版）
        </p>
      ) : null}
      {v.problems.length ? (
        <ul className="mt-2 space-y-1 text-xs text-ink-stall">
          {v.problems.map((p) => (
            <li key={p} className="flex gap-1.5">
              <CircleChevronDown className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="min-w-0">{p}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Read>
  );
}

function HealthTile({ v }: { v: EnvHealth }) {
  const tone: Tone | undefined = v.failing.length > 0 ? 'fail' : undefined;
  return (
    <Read
      label="健康"
      hint="几项红、哪几项"
      icon={HeartPulse}
      value={v.failing.length === 0 ? '没红的' : `${v.failing.length} 项红`}
      sub={
        v.failing.length === 0
          ? `${v.total} 项都通；未接 ${v.notWired.length} 项`
          : `红：${v.failing.join('、')}`
      }
      tone={tone}
    />
  );
}

function ScheduleSummaryTile({
  v,
  now,
  jobCount,
}: {
  v: EnvSchedule;
  now: number;
  jobCount: number | undefined;
}) {
  const tone: Tone | undefined =
    v.status === 'never'
      ? 'wait'
      : v.outcome === 'failed'
        ? 'fail'
        : v.status !== 'fresh' || v.outcome === 'unscanned' || v.outcome === 'partial'
          ? 'stall'
          : 'done';
  const value =
    v.status === 'never'
      ? '从没跑成'
      : v.lastSuccessAt
        ? formatAgo(v.lastSuccessAt, now)
        : '没查到上次跑成的时间';
  return (
    <Read
      label="最近拉单"
      hint="引擎上一轮拉单成没成"
      icon={CalendarClock}
      value={value}
      tone={tone}
      sub={
        v.status === 'never'
          ? jobCount !== undefined
            ? `这个环境还没有拉单记录（共 ${jobCount} 个定时任务，拉到才算）`
            : '这个环境还没有拉单记录'
          : v.why
            ? v.why
            : v.outcome === undefined
              ? '上次这一轮还没有结局'
              : `上次结局：${v.outcome}${v.scanned === undefined ? '' : `，扫了 ${v.scanned} 个`}`
      }
    />
  );
}

/** 定时任务表：失败红、没查全 / 过期黄（判法同 /schedules 页）。 */
function rowTone(j: JobView): 'fail' | 'stall' | null {
  if (j.lastRun?.outcome === 'failed') return 'fail';
  if (j.lastRun?.outcome === 'unscanned' || j.lastRun?.outcome === 'partial' || j.status !== 'fresh')
    return 'stall';
  return null;
}

/**
 * 发版一键卡（#618）：release-train 此刻的状态 + 「发版预检」按钮。
 * 状态三态：running = 在走；paused = 暂停标记留下来了但一趟不在（孤儿）；idle = 没在走。读不到一律 unreadable，写明原因。
 * 「发版预检」按钮点下让后端起 pnpm release:onekey preflight（命令后端写死、不收参数），结果分块 show 在下面。
 */
function ReleaseCard({
  release,
  preflight,
}: {
  release: FranceReleaseState;
  preflight: ReturnType<typeof useFrancePreflight>;
}) {
  const result: FrancePreflightResponse | undefined = preflight.data;
  const releaseTone: Tone | undefined =
    release.state === 'running' ? 'stall' : release.state === 'paused' ? 'fail' : undefined;
  return (
    <>
      <Read
        label="发版一键"
        hint="release-train 此刻在不在走"
        icon={Rocket}
        value={
          release.state === 'running'
            ? '在走'
            : release.state === 'paused'
              ? '暂停标记没人收'
              : release.state === 'idle'
                ? '没在走'
                : '没查成'
        }
        tone={releaseTone}
        sub={
          release.state === 'running'
            ? `${release.phase} · ${release.target}${release.marker ? ' · 派活已暂停' : ' · 暂停标记没写'}`
            : release.state === 'paused'
              ? '暂停标记在、但一趟的记录不在：之前 abort 没把标记清掉。要发版前先用 pnpm release:onekey abort 收掉它'
              : release.state === 'idle'
                ? '要发版前可以点右边「发版预检」按钮核一遍；要真发版走 pnpm release:onekey start'
                : release.why
        }
      >
        <div className="mt-3">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={preflight.isPending}
            onClick={() => preflight.mutate()}
          >
            {preflight.isPending ? '预检在跑…' : '发版预检'}
          </Button>
        </div>
      </Read>
      {preflight.isError ? (
        <div className="mt-3 rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sm text-ink-fail">
          预检请求没发出去：
          {preflight.error instanceof Error ? preflight.error.message : String(preflight.error)}
        </div>
      ) : null}
      {result ? (
        <div className="mt-3 rounded-lg border bg-card p-4">
          {result.state === 'unreadable' ? (
            <p className="text-sm text-ink-stall">没查成：{result.why}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="num">{result.command}</span>
                {' · '}
                退出码 {result.code ?? '（没给）'}
                {result.signal ? `，信号 ${result.signal}` : ''}
                {' · 跑了 '}
                {Math.round(result.durationMs / 100) / 10} 秒{result.timedOut ? '（60 秒到点了被杀）' : ''}
                {result.truncated ? '（输出超 512KB 已截断）' : ''}
              </p>
              <div
                className={
                  result.code === 0
                    ? 'mt-2 text-sm font-medium text-ink-done'
                    : 'mt-2 text-sm font-medium text-ink-fail'
                }
              >
                {result.code === 0 ? '预检过了' : '预检没过（退出码不是 0；看下面输出找哪一项卡住）'}
              </div>
              {result.stdout ? (
                <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                  {result.stdout}
                </pre>
              ) : null}
              {result.stderr ? (
                <>
                  <p className="mt-3 text-xs font-medium text-ink-stall">
                    stderr（release-train 的报错 / 没成的行都在这）：
                  </p>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                    {result.stderr}
                  </pre>
                </>
              ) : null}
              {!result.stdout && !result.stderr ? (
                <p className="mt-3 text-xs text-muted-foreground">这次没产出任何输出。</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

function JobsTable({ jobs, now }: { jobs: readonly JobView[]; now: number }) {
  if (jobs.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">这台环境一个定时任务都没有（也读不到）。</p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">任务</TableHead>
          <TableHead className="w-40">周期</TableHead>
          <TableHead>上次结局</TableHead>
          <TableHead className="w-32 pr-4">上次跑成</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((j) => {
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
                  'text-xs',
                  r?.outcome === 'failed' && 'font-medium text-ink-fail',
                  (r?.outcome === 'unscanned' || r?.outcome === 'partial') && 'font-medium text-ink-stall',
                  r?.outcome === 'ok' && 'text-muted-foreground',
                )}
              >
                {outcomeText(j)}
                {r ? (
                  <span className="num block text-[11px] text-faint">{formatAgo(r.startedAt, now)}开始</span>
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
  const preflight = useFrancePreflight();
  const now = useNow();
  const facts = env.data?.facts;
  const jobList = jobs.data?.jobs;

  return (
    <Page title="法国" description={DESCRIPTION}>
      {env.error ? (
        <div className="mb-3">
          <LoadError what="法国环境" error={env.error} onRetry={() => void env.refetch()} />
        </div>
      ) : null}
      {env.isLoading || !env.data || !facts ? (
        <LoadingRows rows={4} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {facts.engine.ok ? (
              <EngineTile v={facts.engine.value} />
            ) : (
              <NotRead label="引擎" hint="在拉活的工人有没有" icon={Power} reason={facts.engine.reason} />
            )}
            {facts.version.ok ? (
              <VersionTile v={facts.version.value} />
            ) : (
              <NotRead label="在用版本" hint="落后主线没有" icon={Tag} reason={facts.version.reason} />
            )}
            {facts.health.ok ? (
              <HealthTile v={facts.health.value} />
            ) : (
              <NotRead label="健康" hint="几项红、哪几项" icon={HeartPulse} reason={facts.health.reason} />
            )}
            {facts.schedule.ok ? (
              <ScheduleSummaryTile v={facts.schedule.value} now={now} jobCount={jobList?.length} />
            ) : (
              <NotRead
                label="最近拉单"
                hint="引擎上一轮拉单成没成"
                icon={CalendarClock}
                reason={facts.schedule.reason}
              />
            )}
          </div>

          <div className="mt-6">
            <Panel
              title="发版一键"
              description="release-train 此刻的状态和「发版一键」的入口：点「发版预检」让这台后端自己起 pnpm release:onekey preflight（命令写死、不收参数，只读不改）；真发版走 pnpm release:onekey start，不在页面上发。"
              bodyClassName="p-4"
            >
              {release.isLoading || !release.data ? (
                <LoadingRows rows={2} />
              ) : release.error ? (
                <LoadError what="发版一键" error={release.error} onRetry={() => void release.refetch()} />
              ) : (
                <ReleaseCard release={release.data} preflight={preflight} />
              )}
            </Panel>
          </div>

          <div className="mt-6">
            <Panel
              title={
                <span className="flex items-center gap-2">
                  定时任务
                  {jobs.data ? (
                    <span className="num rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      共 {jobs.data.jobs.length} 项 · 失败{' '}
                      {jobs.data.jobs.filter((j) => j.lastRun?.outcome === 'failed').length}
                    </span>
                  ) : null}
                </span>
              }
              description="法国这台机器上跑的额度读取、巡检、对账、备份等定时任务；失败亮红，没查全 / 过期亮黄。点下方进完整页改、看每一条历史。"
              actions={
                <Link
                  to="/schedules"
                  className="text-xs text-muted-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
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
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            这一页只读、只照实显示后端给的；读不到的就写「没查成 + 原因」，不拿 0
            或空值顶。要看细节（每个定时任务的历史、健康各项明细、远程环境）去
            <Link to="/env" className="mx-1 underline underline-offset-2">
              环境
            </Link>
            和
            <Link to="/schedules" className="mx-1 underline underline-offset-2">
              定时任务
            </Link>
            页。「发版一键」只到预检：预检是只读的，它不会暂停、不会发版；真发版走 pnpm release:onekey start。
          </p>
        </>
      )}
    </Page>
  );
}
