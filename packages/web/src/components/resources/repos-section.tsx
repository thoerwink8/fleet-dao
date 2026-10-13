// 资源页「仓库」一节（#1993）：每个仓一行（工作树几棵、内存、CPU、磁盘），点开看每棵树的状态、多久没动、为什么；
// 右上「清理没用的工作树」：点一下记一条请求，法国引擎几秒内接手，判据和每小时对账同一份——
// 有没提交、没推的改动，或正被任务、会话用着的一律拒删，结果里写明拒了哪棵、为什么。
// 怎么写每一格在 repos.ts；这里只管排版和按钮。
import { FolderGit2, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { errorText, useWorktreeCleanup, useWorktrees } from '../../api/client';
import type { WorktreeCleanupView } from '../../api/types';
import { formatAgo } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { HomeResources, HomeRunning } from '../home/types';
import { EmptyState } from '../layout/empty-state';
import { List, ListRow, RowDetail } from '../layout/list';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { Section } from '../layout/section';
import { StatusBadge } from '../layout/status-badge';
import { Button } from '../ui/button';
import { cleanupWord, type RepoDisk, type RepoRow, repoRows, type TreeView, treeStateWord } from './repos';
import type { Cell } from './view';

function CellText({ cell }: { cell: Cell }) {
  if (cell.kind === 'ok')
    return (
      <span className="num text-foreground" title={cell.title}>
        {cell.text}
      </span>
    );
  const word = { sampling: '采样中', idle: '没在占用', empty: '空 scope', none: '不单算', unread: '没读到' }[
    cell.kind
  ];
  return (
    <span className="text-muted-foreground" title={'why' in cell ? cell.why : undefined}>
      {word}
    </span>
  );
}

function DiskText({ disk }: { disk: RepoDisk }) {
  if (disk.kind === 'unread')
    return (
      <span className="text-muted-foreground" title={disk.why}>
        没量到
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={disk.incomplete}>
      <span className="num text-foreground">{disk.incomplete ? `≥ ${disk.text}` : disk.text}</span>
      {disk.incomplete ? <StatusBadge tone="stall" variant="dot" label="不全" /> : null}
    </span>
  );
}

/** 列：名字 4 份，工作树、CPU、内存、磁盘各 2 份；手机上四格并成一排、每格上面一行小标签。 */
function RepoGrid({
  name,
  trees,
  cpu,
  memory,
  disk,
  head = false,
}: {
  name: ReactNode;
  trees: ReactNode;
  cpu: ReactNode;
  memory: ReactNode;
  disk: ReactNode;
  head?: boolean;
}) {
  const cell = (label: string, value: ReactNode) => (
    <div className="min-w-0 md:col-span-2 md:text-right">
      {head ? null : <div className="text-meta text-muted-foreground md:hidden">{label}</div>}
      <div className={cn(head ? 'text-meta text-muted-foreground' : 'text-body')}>{value}</div>
    </div>
  );
  return (
    <div className="grid w-full min-w-0 grid-cols-1 gap-y-2 md:grid-cols-12 md:items-center md:gap-x-4">
      <div className={cn('min-w-0 md:col-span-4', head && 'text-meta text-muted-foreground')}>{name}</div>
      <div className="grid grid-cols-4 gap-x-3 md:contents">
        {cell('工作树', trees)}
        {cell('CPU', cpu)}
        {cell('内存', memory)}
        {cell('磁盘', disk)}
      </div>
    </div>
  );
}

function TreeLine({ t, now }: { t: TreeView; now: number }) {
  const idle = t.lastSessionAt ? `上次会话 ${formatAgo(t.lastSessionAt, now)}` : '库里没有会话记录';
  return (
    <li className="py-2" data-tree={t.tree} data-tree-state={t.state}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-meta md:text-body" title={t.tree}>
            {t.tree}
          </span>
          <span className="block truncate text-meta text-muted-foreground" title={`${t.what} · ${idle}`}>
            {t.what} · {idle}
          </span>
        </span>
        <StatusBadge tone={t.tone} variant="dot" label={t.label} className="shrink-0" />
        <span className="w-16 shrink-0 text-right text-body">
          {t.size.kind === 'ok' ? (
            <span className="num">{t.size.text}</span>
          ) : (
            <span className="text-muted-foreground" title={t.size.why}>
              没量到
            </span>
          )}
        </span>
      </div>
      {/* 原因写出来（手机上没有悬停）：在用写谁在用，拒删写里面还剩什么 */}
      <p className="mt-0.5 text-meta break-words text-muted-foreground" data-tree-why>
        {t.why}
        {t.size.kind === 'unread' ? `；大小没量到：${t.size.why}` : ''}
      </p>
    </li>
  );
}

function RepoDetail({ row, now }: { row: RepoRow; now: number }) {
  return (
    <RowDetail indent={false} className="pb-4" data-repo-detail={row.repo}>
      <dl className="grid gap-y-1.5 text-body">
        <div className="grid grid-cols-1 gap-x-4 md:grid-cols-12">
          <dt className="text-meta text-muted-foreground md:col-span-2">镜像</dt>
          <dd className="min-w-0 break-words md:col-span-10">
            {row.mirror.kind === 'ok' ? row.mirror.text : `没量到：${row.mirror.why}`}
          </dd>
        </div>
        {row.disk.kind === 'ok' && row.disk.incomplete ? (
          <div className="grid grid-cols-1 gap-x-4 md:grid-cols-12">
            <dt className="text-meta text-muted-foreground md:col-span-2">磁盘</dt>
            <dd className="min-w-0 break-words md:col-span-10">
              {row.disk.text} 是下限（{row.disk.incomplete}）
            </dd>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-x-4 md:grid-cols-12">
          <dt className="text-meta text-muted-foreground md:col-span-2">会话</dt>
          <dd className="min-w-0 break-words md:col-span-10">
            {row.sessions ? `${row.sessions} 个在跑` : '这一刻没有会话在跑'}
          </dd>
        </div>
      </dl>
      {row.trees.length ? (
        <ul className="mt-3 divide-y divide-border" data-repo-trees>
          {row.trees.map((t) => (
            <TreeLine key={t.key} t={t} now={now} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-meta text-muted-foreground">
          {row.treesKnown ? '这个仓在法国没有工作树。' : '这一轮工作树没查成，树的列表不可信。'}
        </p>
      )}
    </RowDetail>
  );
}

/** 最近一次清理的结果：删了哪些、拒了哪些和原因。 */
function CleanupNotice({ c, now }: { c: WorktreeCleanupView; now: number }) {
  const w = cleanupWord(c);
  const when = formatAgo(c.doneAt ?? c.startedAt ?? c.requestedAt, now);
  if (c.status === 'queued' || c.status === 'running') {
    return (
      <Notice tone="info" title={`清理${w.label}（${when}点的）`}>
        法国引擎接手后按每小时对账同一份判据清：没用的删，在用、有改动的拒删。几秒后刷新结果。
      </Notice>
    );
  }
  if (c.status === 'failed' || c.status === 'expired') {
    return (
      <Notice tone="fail" title={`上次清理${w.label}（${when}）`}>
        {c.error ?? '引擎超过 15 分钟没接手，这次作废；引擎起来后再点'}
      </Notice>
    );
  }
  const r = c.result;
  if (!r) return null;
  return (
    <Notice
      tone={r.refused.length ? 'stall' : 'done'}
      title={`上次清理（${when}）：删了 ${r.removed.length} 棵，拒删 ${r.refused.length} 棵`}
    >
      {r.removed.length ? (
        <p className="break-words">
          删了：<span className="font-mono text-meta">{r.removed.join('、')}</span>
        </p>
      ) : null}
      {r.refused.length ? (
        <ul className="mt-1 grid gap-1" data-cleanup-refused>
          {r.refused.map((x) => (
            <li key={x.tree} className="break-words">
              <span className="font-mono text-meta">{x.tree}</span>（{treeStateWord(x.state)}）：{x.why}
            </li>
          ))}
        </ul>
      ) : null}
      {r.unchecked.length ? <p className="mt-1 break-words">没查成：{r.unchecked.join('；')}</p> : null}
    </Notice>
  );
}

export function ReposSection({
  resources,
  running,
  remote,
  now,
}: {
  resources: HomeResources | undefined;
  running: readonly HomeRunning[];
  remote: boolean;
  now: number;
}) {
  const q = useWorktrees();
  const cleanup = useWorktreeCleanup();
  const latest = q.data?.cleanups[0];
  const busy = latest?.status === 'queued' || latest?.status === 'running' || cleanup.isPending;

  const onCleanup = () =>
    cleanup.mutate(
      {},
      {
        onSuccess: () => toast.success('已叫法国清理没用的工作树'),
        onError: (e) => toast.error('没叫成', { description: errorText(e) }),
      },
    );

  // loading 只跟这一次点击（转圈）；「已经有一次在排队/在做」那一段整块置灰走 disabled（#1993）
  const button = remote ? null : (
    <Button
      size="sm"
      variant="outline"
      onClick={onCleanup}
      loading={cleanup.isPending}
      disabled={busy || !q.data}
      data-cleanup-button
    >
      <Trash2 aria-hidden />
      <span className="max-md:hidden">清理没用的工作树</span>
      <span className="md:hidden">清理</span>
    </Button>
  );

  const result = q.data ? repoRows(q.data, resources, running) : undefined;
  const description =
    result?.kind === 'ok'
      ? `清单 ${formatAgo(result.takenAt, now)}出的（${result.trigger === 'cleanup' ? '清理那一轮' : '每小时对账'}）`
      : '每个仓在法国占的磁盘、工作树和会话';

  return (
    <Section title="仓库" description={description} actions={button} flush data-resources-repos>
      {remote ? (
        <div className="p-4 text-body text-muted-foreground">工作树清单只在法国这台有，切回本台看。</div>
      ) : q.isLoading ? (
        <div className="p-4">
          <LoadingRows rows={3} />
        </div>
      ) : q.error ? (
        <div className="p-4">
          <LoadError what="工作树清单" error={q.error} onRetry={() => void q.refetch()} />
        </div>
      ) : !result ? null : result.kind === 'none' ? (
        <div className="p-4">
          <EmptyState icon={FolderGit2} title="还没有清单" hint={result.why} />
        </div>
      ) : result.kind === 'unread' ? (
        <div className="p-4 text-body text-muted-foreground" data-repos-unread>
          没读到：{result.why}
        </div>
      ) : (
        <>
          {cleanup.error || latest || result.kind === 'failed' ? (
            <div className="grid gap-2 px-4 pt-4 lg:px-5">
              {cleanup.error ? (
                <Notice tone="fail" title="没叫成">
                  {errorText(cleanup.error)}
                </Notice>
              ) : null}
              {latest ? <CleanupNotice c={latest} now={now} /> : null}
              {result.kind === 'failed' ? (
                <Notice tone="fail" title="这一轮工作树没查成">
                  {result.why}（下面只列镜像，树的列表不可信）
                </Notice>
              ) : null}
            </div>
          ) : null}
          <List>
            <ListRow
              aria-hidden
              className="max-md:hidden"
              summary={
                <>
                  <span className="block min-w-0 flex-1">
                    <RepoGrid
                      head
                      name="仓"
                      trees="工作树"
                      cpu="CPU"
                      memory="内存"
                      disk="磁盘（镜像 + 树）"
                    />
                  </span>
                  <span className="size-4 shrink-0" />
                </>
              }
            />
            {result.rows.map((row) => (
              <ListRow
                key={row.repo}
                data-repo={row.repo}
                expandable
                summary={
                  <span className="block min-w-0 flex-1 py-1">
                    <RepoGrid
                      name={
                        <span className="block min-w-0">
                          <span className="num block truncate text-body font-medium" title={row.repo}>
                            {row.repo}
                          </span>
                          <span className="block truncate text-meta text-muted-foreground">
                            {!row.treesKnown
                              ? '这一轮树没查成'
                              : row.held
                                ? `${row.held} 棵有改动或没查成，清理会拒删`
                                : '没有要人看的树'}
                          </span>
                        </span>
                      }
                      trees={
                        row.treesKnown ? (
                          <span className="num">{row.trees.length} 棵</span>
                        ) : (
                          <span className="text-muted-foreground">没查成</span>
                        )
                      }
                      cpu={<CellText cell={row.cpu} />}
                      memory={<CellText cell={row.memory} />}
                      disk={<DiskText disk={row.disk} />}
                    />
                  </span>
                }
                details={<RepoDetail row={row} now={now} />}
              />
            ))}
          </List>
        </>
      )}
    </Section>
  );
}
