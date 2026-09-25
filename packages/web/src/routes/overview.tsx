import {
  Activity,
  ArrowRight,
  CheckCheck,
  GaugeCircle,
  Hand,
  Hourglass,
  Network,
  TriangleAlert,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useAllBoards, useAudit, useMe, usePools } from '../api/client';
import type { Board, BoardTask, NowItem, PoolView, QuotaWindowView } from '../api/types';
import { BoardsError, Empty, LoadError, LoadingRows, Page, Panel, Stat } from '../components/page';
import { QuotaBar } from '../components/quota';
import { useRepo } from '../components/repo-context';
import { StatusChip, StatusDot } from '../components/status';
import { ActionButtons, targetOf } from '../components/task-actions';
import { Button } from '../components/ui/button';
import { actionLabel, actorName, targetLabel, taskIndex } from '../lib/audit';
import { isUpstreamFull, isUseItOrLoseIt, poolTitle, utilOf, windowTitle } from '../lib/catalog';
import { formatAgo, formatDuration, formatIn, formatPercent } from '../lib/format';
import { useNow } from '../lib/hooks';
import {
  describeTask,
  letterOf,
  needsAttention,
  TONES,
  type Tone,
  taskStateLabel,
  taskTone,
  toneBg,
  toneLabel,
} from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: '总览 · fleet-dao 驾驶舱' }];
}

function nowLabel(boards: Board[], n: NowItem): string {
  const t = boards.flatMap((b) => b.tasks).find((x) => x.id === n.taskId);
  if (!t) return '';
  const s = n.subtaskId ? t.subtasks.find((x) => x.id === n.subtaskId) : undefined;
  return `#${t.issueNumber}${s ? ` ${letterOf(s.index)}` : ''}`;
}

export default function Overview() {
  const { boards, isLoading, error, failed } = useAllBoards();
  const pools = usePools();
  const audit = useAudit();
  const { data: me } = useMe();
  const { setRepoId } = useRepo();
  const navigate = useNavigate();
  const now = useNow();

  const all: BoardTask[] = boards.flatMap((b) => b.tasks);
  // 有仓没读成时数字是残缺的：显示「—」，不拿少算的数冒充全貌。
  const boardsOk = !isLoading && !error;
  const count = (n: number) => (boardsOk ? n : '—');
  const byTone = (tone: Tone) => all.filter((t) => taskTone(t) === tone).length;
  const attention = all.filter(needsAttention).sort((a, b) => a.priority - b.priority);
  const nowItems = boards.flatMap((b) => b.now);
  const working = nowItems.filter((n) => !n.queued);
  const queued = nowItems.length - working.length;
  const windows: { pool: PoolView; w: QuotaWindowView }[] = (pools.data?.pools ?? []).flatMap((pool) =>
    pool.windows.map((w) => ({ pool, w })),
  );
  const hot = windows.filter(({ w }) => !w.stale && isUseItOrLoseIt(w, now));
  // 上游说已用满的排最前面（没给比例也算最满）；用量没读到、上游这次没报的不参与排序（不拿 0 冒充最空），
  // 单独数一下、写在面板底下。
  const ranked = windows.flatMap((x) => {
    const util = utilOf(x.w);
    const full = isUpstreamFull(x.w);
    return (util === undefined && !full) || x.w.staleSince ? [] : [{ ...x, util, full }];
  });
  const unknownUse = windows.length - ranked.length;
  const fullest = ranked
    .sort((a, b) => Number(b.full) - Number(a.full) || (b.util ?? 1) - (a.util ?? 1))
    .slice(0, 5);
  const tasksById = taskIndex(all);
  const recent = audit.data?.pages[0]?.items.slice(0, 7) ?? [];

  return (
    <Page title="总览" description="全部仓的盘面：在干什么、卡在哪、等你拍什么。">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="在干活"
          value={count(byTone('run'))}
          icon={Activity}
          hint="分诊、写方案、写码、验证、合并"
          to="/tasks"
        />
        <Stat
          label="卡住"
          value={count(byTone('stall') + byTone('fail'))}
          icon={TriangleAlert}
          accent={boardsOk && byTone('stall') + byTone('fail') ? 'text-ink-stall' : undefined}
          hint="停滞或失败"
          to="/?stuck=1"
        />
        <Stat
          label="等你"
          value={count(byTone('human'))}
          icon={Hand}
          accent={boardsOk && byTone('human') ? 'text-ink-human' : undefined}
          hint="回答追问"
          to="/notifications"
        />
        <Stat
          label="排队的会话"
          value={count(queued)}
          icon={Hourglass}
          hint={boardsOk ? `${working.length} 个在干活` : '看板没读全'}
          to="/quota"
        />
        <Stat
          label="额度快清零"
          value={pools.data ? hot.length : '—'}
          icon={GaugeCircle}
          hint={pools.error ? '额度没读成' : '还剩不少，该先用它'}
          to="/quota"
        />
      </div>

      {error ? (
        <div className="mt-4">
          <BoardsError failed={failed} error={error} />
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="等你处理" description="按优先级排：等人的、停滞的、失败的。" bodyClassName="p-0">
            {isLoading ? (
              <div className="p-4">
                <LoadingRows />
              </div>
            ) : attention.length ? (
              <ul className="divide-y">
                {attention.map((t) => (
                  <li key={t.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center">
                    <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="num text-xs font-semibold text-muted-foreground">
                          #{t.issueNumber}
                        </span>
                        <span className="truncate text-sm font-medium">{t.title}</span>
                        <StatusChip tone={taskTone(t)} label={taskStateLabel[t.state]} />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{describeTask(t, now)}</p>
                    </Link>
                    <ActionButtons target={targetOf(t)} />
                  </li>
                ))}
              </ul>
            ) : boardsOk ? (
              <Empty
                icon={CheckCheck}
                title="没有等你处理的事"
                hint="卡住或要你拍板时，这里和飞书都会提醒。"
              />
            ) : (
              <p className="px-4 py-6 text-center text-sm text-ink-fail">
                看板没读全，说不准有没有等你处理的事
              </p>
            )}
          </Panel>

          <Panel title="各仓" bodyClassName="grid gap-3 md:grid-cols-3">
            {failed.map((repo) => (
              <div key={repo.id} className="flex flex-col rounded-lg border border-st-fail/40 p-3">
                <div className="num truncate text-[11px] text-muted-foreground">{repo.owner}/</div>
                <div className="num truncate text-base font-semibold">{repo.name}</div>
                <p className="mt-3 text-xs text-ink-fail">这个仓的看板没读成</p>
              </div>
            ))}
            {boards.map(({ repo, tasks }) => {
              const counts = TONES.map((tone) => ({
                tone,
                n: tasks.filter((t) => taskTone(t) === tone).length,
              })).filter((c) => c.n);
              return (
                <div key={repo.id} className="flex flex-col rounded-lg border p-3">
                  <div className="num truncate text-[11px] text-muted-foreground">{repo.owner}/</div>
                  <div className="num truncate text-base font-semibold">{repo.name}</div>
                  <div
                    className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted"
                    role="img"
                    aria-label={
                      counts.length ? counts.map((c) => `${toneLabel[c.tone]} ${c.n}`).join('，') : '没有需求'
                    }
                  >
                    {counts.map((c) => (
                      <div
                        key={c.tone}
                        className={cn('h-full', toneBg[c.tone])}
                        style={{ width: `${(c.n / Math.max(1, tasks.length)) * 100}%` }}
                        title={`${toneLabel[c.tone]} ${c.n}`}
                      />
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {counts.length ? (
                      counts.map((c) => (
                        <span key={c.tone} className="inline-flex items-center gap-1">
                          <StatusDot tone={c.tone} className="size-1.5" />
                          {toneLabel[c.tone]} <span className="num text-foreground">{c.n}</span>
                        </span>
                      ))
                    ) : (
                      <span>还没有需求</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-3 -ml-2 w-fit"
                    onClick={() => {
                      setRepoId(repo.id);
                      navigate('/');
                    }}
                  >
                    <Network />
                    打开看板
                  </Button>
                </div>
              );
            })}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel
            title="此刻"
            description={
              boardsOk
                ? `${working.length} 个会话在干活${queued ? `，${queued} 个在排队` : ''}`
                : '看板没读全，下面只是读到的那部分'
            }
            bodyClassName="p-0"
          >
            {nowItems.length ? (
              <ul className="divide-y">
                {[...nowItems]
                  .sort((a, b) => Number(a.queued) - Number(b.queued) || a.since.localeCompare(b.since))
                  .map((n) => (
                    <li key={n.runId}>
                      <Link
                        to={`/tasks/${n.taskId}${n.subtaskId ? `?sub=${n.subtaskId}` : ''}`}
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-accent"
                      >
                        <StatusDot tone={n.queued ? 'wait' : 'run'} />
                        <span className="num min-w-0 flex-1 truncate text-xs">{n.modelName}</span>
                        <span className="num shrink-0 text-xs text-muted-foreground">
                          {nowLabel(boards, n)}
                        </span>
                        <span className="num w-24 shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground">
                          {n.queued ? '排 ' : ''}
                          {formatDuration(now - Date.parse(n.since))}
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            ) : boardsOk ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">现在没有会话在跑</p>
            ) : null}
          </Panel>

          <Panel
            title="额度"
            description="用得最满的几个窗"
            actions={
              <Button asChild size="sm" variant="ghost" className="h-7">
                <Link to="/quota">
                  全部
                  <ArrowRight />
                </Link>
              </Button>
            }
          >
            {pools.error ? <LoadError what="额度" error={pools.error} /> : null}
            <ul className="space-y-3">
              {fullest.map(({ pool, w, util, full }, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同一个池同一种窗可能有好几个（按模型组），契约里没有区分它们的字段。
                <li key={`${pool.id}-${w.window}-${i}`}>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      {poolTitle(pool)}
                      <span className="text-muted-foreground"> · {windowTitle(w)}</span>
                    </span>
                    <span
                      className={cn(
                        full ? 'font-medium text-ink-fail' : 'num',
                        w.stale && 'text-muted-foreground line-through',
                      )}
                    >
                      {full ? '已用满' : formatPercent(util ?? 0)}
                    </span>
                  </div>
                  <QuotaBar util={util ?? (full ? 1 : undefined)} className="mt-1" />
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {w.resetsAt ? (
                      <>
                        <span className="num">{formatIn(w.resetsAt, now)}</span>清零 ·{' '}
                      </>
                    ) : null}
                    {w.reading === 'measured' ? '实读' : '估算'}
                    {w.stale ? ' · 读数过期' : ''}
                  </div>
                </li>
              ))}
            </ul>
            {pools.data && !windows.length ? (
              <p className="text-center text-sm text-muted-foreground">还没有额度读数</p>
            ) : null}
            {unknownUse ? (
              <p className="mt-3 text-xs text-ink-stall">
                另有 <span className="num">{unknownUse}</span> 个窗没排进来（用量没读到，或上游这次没报）——
                <Link to="/quota" className="underline underline-offset-2">
                  去额度页看
                </Link>
              </p>
            ) : null}
          </Panel>

          <Panel
            title="最近动态"
            bodyClassName="p-0"
            actions={
              <Button asChild size="sm" variant="ghost" className="h-7">
                <Link to="/audit">
                  全部
                  <ArrowRight />
                </Link>
              </Button>
            }
          >
            {audit.error ? (
              <div className="p-4">
                <LoadError what="操作记录" error={audit.error} />
              </div>
            ) : null}
            <ul className="divide-y">
              {recent.map((a) => (
                <li key={a.id} className="px-4 py-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 font-medium" title={a.actor.id}>
                      {actorName(a.actor, me)}
                    </span>
                    <span className={cn('shrink-0', !a.ok && 'text-ink-fail')}>{actionLabel(a.action)}</span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {targetLabel(a.target, tasksById)}
                    </span>
                    <span className="num ml-auto shrink-0 text-muted-foreground">{formatAgo(a.at, now)}</span>
                  </div>
                  {a.reason || a.error ? (
                    <div
                      className={cn('mt-0.5 truncate', a.error ? 'text-ink-fail' : 'text-muted-foreground')}
                    >
                      {a.error ?? a.reason}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
