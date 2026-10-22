// 资源页「仓」一节（#1993；#3509 照 Arco，样稿 canvas/Resources.dc.html）：每个仓一行（工作树几棵、磁盘），点开看每棵树的状态、多久没动、为什么。
// 区块头右边「⋯」里有「清理没用的工作树…」（低频操作收进更多）：点一下先确认，确认后记一条请求，法国引擎几秒内接手，判据和每小时对账同一份——
// 有没提交、没推的改动，或正被任务、会话用着的一律拒删，结果里写明拒了哪棵、为什么。
// 怎么写每一格在 repos.ts；这里只管排版和菜单。
import { FolderGit2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useWorktreeCleanup, useWorktrees } from '../../api/client';
import type { WorktreeCleanupView, WorktreeState } from '../../api/types';
import { formatAgo } from '../../lib/format';
import type { StatusKey } from '../../theme/status-dict';
import type { HomeResources, HomeRunning } from '../home/types';
import { ConfirmDialog } from '../layout/confirm-dialog';
import { Descriptions } from '../layout/descriptions';
import { EmptyState } from '../layout/empty-state';
import { List, ListRow } from '../layout/list';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { RowMenu, RowMenuItem } from '../layout/row-menu';
import { Section } from '../layout/section';
import { Stack } from '../layout/stack';
import { StatusBadge } from '../layout/status-badge';
import { Table, type TableColumn } from '../layout/table';
import { Text } from '../layout/text';
import { DiskText } from './cells';
import { cleanupWord, type RepoDisk, type RepoRow, repoRows, type TreeView, treeStateWord } from './repos';

const TREE_STATUS: Record<WorktreeState, StatusKey> = {
  running: 'machine:tree:running',
  session: 'machine:tree:session',
  leftover: 'machine:tree:leftover',
  kept: 'machine:tree:kept',
  unchecked: 'machine:tree:unchecked',
  deferred: 'machine:tree:deferred',
};

function RepoDiskText({ disk }: { disk: RepoDisk }) {
  if (disk.kind === 'unread') {
    return (
      <Text tone="muted" title={disk.why}>
        没量到
      </Text>
    );
  }
  return (
    <DiskText
      cell={{
        kind: 'ok',
        text: disk.text,
        bytes: disk.bytes,
        gaps: { trees: 0, dirs: 0, stale: 0, databases: false },
        ...(disk.incomplete ? { incomplete: disk.incomplete } : {}),
      }}
    />
  );
}

function TreeLine({ t, now }: { t: TreeView; now: number }) {
  const idle = t.lastSessionAt ? `上次会话 ${formatAgo(t.lastSessionAt, now)}` : '库里没有会话记录';
  return (
    <ListRow
      tall
      data-tree={t.tree}
      data-tree-state={t.state}
      title={
        <Stack direction="horizontal" gap="md" align="baseline">
          <Text mono title={t.tree}>
            {t.tree}
          </Text>
          <Text size="meta" tone="muted">
            {t.what}
          </Text>
        </Stack>
      }
      meta={
        <span data-tree-why>
          <Text size="meta" tone="muted">
            {idle} · {t.why}
            {t.size.kind === 'unread' ? `；大小没量到：${t.size.why}` : ''}
          </Text>
        </span>
      }
      trailing={
        <Stack direction="horizontal" gap="lg" align="center">
          <StatusBadge status={TREE_STATUS[t.state]} />
          {t.size.kind === 'ok' ? (
            <Text>{t.size.text}</Text>
          ) : (
            <Text tone="muted" title={t.size.why}>
              没量到
            </Text>
          )}
        </Stack>
      }
    />
  );
}

function RepoDetail({ row, now }: { row: RepoRow; now: number }) {
  return (
    <div data-repo-detail={row.repo}>
      <Stack>
        <Descriptions
          columns={1}
          items={[
            {
              label: '镜像',
              value: row.mirror.kind === 'ok' ? row.mirror.text : `没量到：${row.mirror.why}`,
            },
            ...(row.disk.kind === 'ok' && row.disk.incomplete
              ? [{ label: '磁盘', value: `${row.disk.text} 是下限（${row.disk.incomplete}）` }]
              : []),
            { label: '会话', value: row.sessions ? `${row.sessions} 个在跑` : '这一刻没有会话在跑' },
          ]}
        />
        {row.trees.length ? (
          <div data-repo-trees>
            <List>
              {row.trees.map((t) => (
                <TreeLine key={t.key} t={t} now={now} />
              ))}
            </List>
          </div>
        ) : (
          <Text tone="muted">
            {row.treesKnown ? '这个仓在法国没有工作树。' : '这一轮工作树没查成，树的列表不可信。'}
          </Text>
        )}
      </Stack>
    </div>
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
        <Text as="p">
          删了：
          <Text mono>{r.removed.join('、')}</Text>
        </Text>
      ) : null}
      {r.refused.length ? (
        <div data-cleanup-refused>
          <Stack gap="sm">
            {r.refused.map((x) => (
              <Text as="p" key={x.tree}>
                <Text mono>{x.tree}</Text>（{treeStateWord(x.state)}）：{x.why}
              </Text>
            ))}
          </Stack>
        </div>
      ) : null}
      {r.unchecked.length ? <Text as="p">没查成：{r.unchecked.join('；')}</Text> : null}
    </Notice>
  );
}

function columns(): TableColumn<RepoRow>[] {
  return [
    {
      key: 'repo',
      title: '仓',
      render: (_, row) => (
        <div data-repo={row.repo}>
          <Text strong title={row.repo}>
            {row.repo}
          </Text>
          {row.treesKnown ? (
            <Text as="div" size="meta" tone={row.held ? 'warning' : 'muted'}>
              {row.held ? `${row.held} 棵有改动或没查成，清理会拒删` : '没有要人看的树'}
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      key: 'trees',
      title: '工作树',
      align: 'right',
      render: (_, row) =>
        row.treesKnown ? <Text>{row.trees.length} 棵</Text> : <Text tone="muted">没读到</Text>,
    },
    {
      key: 'disk',
      title: '磁盘（镜像加树）',
      align: 'right',
      render: (_, row) => <RepoDiskText disk={row.disk} />,
    },
  ];
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
  const [askingCleanup, setAskingCleanup] = useState(false);
  const latest = q.data?.cleanups[0];
  const busy = latest?.status === 'queued' || latest?.status === 'running' || cleanup.isPending;

  const result = q.data ? repoRows(q.data, resources, running) : undefined;
  const description =
    result?.kind === 'ok'
      ? `清单 ${formatAgo(result.takenAt, now)}出的（${result.trigger === 'cleanup' ? '清理那一轮' : '每小时对账'}）`
      : '每个仓在法国占的磁盘、工作树和会话';

  // 清理入口收在「⋯」里（低频）。已经有一次在排队或在做，或清单还没读成：整项置灰（#1993、#2012）。
  const menu = remote ? null : (
    <RowMenu label="仓的更多操作" title="清理没用的工作树" reveal={false}>
      <RowMenuItem
        disabled={busy || !q.data}
        onSelect={() => setAskingCleanup(true)}
        data-cleanup-button
        title={busy ? '已经有一次清理在做，等它做完' : undefined}
      >
        清理没用的工作树…
      </RowMenuItem>
    </RowMenu>
  );

  const failedNote =
    result?.kind === 'failed' ? (
      <Notice tone="stall" title="这一轮工作树没查成">
        {result.why}（下面只列镜像，树的列表不可信）
      </Notice>
    ) : null;
  const notes = latest || failedNote;
  const table =
    result && (result.kind === 'ok' || result.kind === 'failed') && !remote && !q.isLoading && !q.error;

  return (
    <>
      <Stack>
        {!remote && notes ? (
          <Stack gap="sm">
            {latest ? <CleanupNotice c={latest} now={now} /> : null}
            {failedNote}
          </Stack>
        ) : null}
        <Section
          flush={Boolean(table)}
          title="仓"
          data-resources-repos
          actions={
            <>
              <Text size="meta" tone="muted">
                {description}
              </Text>
              {menu}
            </>
          }
        >
          {remote ? (
            <Text tone="muted">工作树清单只在法国这台有，切回本台看。</Text>
          ) : q.isLoading ? (
            <LoadingRows rows={3} />
          ) : q.error ? (
            <LoadError what="工作树清单" error={q.error} onRetry={() => void q.refetch()} />
          ) : !result ? null : result.kind === 'none' ? (
            <EmptyState icon={FolderGit2} title="还没有清单" hint={result.why} />
          ) : result.kind === 'unread' ? (
            <span data-repos-unread>
              <Text tone="muted">没读到：{result.why}</Text>
            </span>
          ) : (
            <Table
              caption="仓"
              columns={columns()}
              rows={result.rows}
              rowKey="repo"
              expandable={{ render: (row) => <RepoDetail row={row} now={now} /> }}
            />
          )}
        </Section>
      </Stack>
      <ConfirmDialog
        open={askingCleanup}
        onOpenChange={setAskingCleanup}
        danger
        title="清理没用的工作树？"
        description="叫法国删掉没在用的工作树。正在用的、有没提交或没推改动的不会删，结果逐棵写在「仓」这一节。"
        confirmText="确认清理"
        onConfirm={async () => {
          try {
            await cleanup.mutateAsync({});
          } catch (err) {
            // 确认框自己把原因写在页脚上面（读屏会读），留着让人再点一次
            throw new Error(`没叫成：${errorText(err)}。清理没有排上，可以再点一次。`);
          }
          toast.success('已叫法国清理没用的工作树');
        }}
      />
    </>
  );
}
