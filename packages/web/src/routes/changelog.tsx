// 发布记录页（旧名「更新日志」，#3509 照 Arco 改版，样稿 canvas/Changelog.dc.html）：「已发布的提交」（#1255，决定 0032：发版单位是主线提交）。
// 一个区块一张表：提交（标题）、类型（发布灰标签、回滚橙标签）、提交号、发于（相对时间加绝对时间）、行尾「⋯」复制完整提交号。
// 只读：读法国的发布历史（release.sh 的 .history，后端 GET /api/france/released-commits，和发版卡共用同一个读口），
// 读不到写没查成和原因，不拿空列表冒充「没发过」；刷新没成照旧画上一次的并写明已过期；某条标题读不到，那一格写「没读到」、原因在顶上一条提示里写一次。
// 发布入口不在这一页：在「法国」页「在用版本」那一块，卡头和空状态各有一个去那里的入口。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）。
import { errMessage } from '@fleet-dao/shared/util';
import { GitCommitHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { brand } from '#brand';
import { useFranceReleasedCommits } from '../api/client';
import type { ReleasedCommits } from '../api/types';
import { Button } from '../components/layout/button';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadingRows, LoadPartial, LoadStale } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { RowMenu, RowMenuItem } from '../components/layout/row-menu';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Table, type TableColumn } from '../components/layout/table';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { formatAgo, formatDateTime, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('发布记录') }];
}

const EVENT_TEXT = { release: '发布', rollback: '回滚', 'auto-rollback': '自动回滚' } as const;

/** 已发布的提交每 5 分钟重拉一次。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const CHANGELOG_STALE_AFTER_MS = 5 * TIME.MIN;

type Commits = Extract<ReleasedCommits, { state: 'ok' }>['commits'];
type Commit = Commits[number];

/** 把完整的 40 位提交号放进剪贴板（列表上只写前 12 位）。 */
async function copySha(c: Commit) {
  try {
    await navigator.clipboard.writeText(c.sha);
    toast.success('已复制完整提交号');
  } catch (e) {
    toast.error(`没复制成：${errMessage(e)}`);
  }
}

function columns(now: number): TableColumn<Commit>[] {
  return [
    {
      key: 'title',
      title: '提交',
      render: (_, c) =>
        c.title !== null ? (
          <Text truncate title={c.title}>
            {c.title}
          </Text>
        ) : (
          <span data-unreadable>
            <Text tone="muted">没读到</Text>
          </span>
        ),
    },
    {
      key: 'event',
      title: '类型',
      render: (_, c) => (
        <span data-event={c.event}>
          <Tag tone={c.event === 'release' ? 'neutral' : 'warning'}>{EVENT_TEXT[c.event]}</Tag>
        </span>
      ),
    },
    {
      key: 'short',
      title: '提交号',
      render: (_, c) => (
        <Text mono tone="secondary">
          {c.short}
        </Text>
      ),
    },
    {
      key: 'at',
      title: '发于',
      align: 'right',
      render: (_, c) => (
        <span data-released-at title={formatDateTime(c.at)}>
          <Text as="div">发于 {formatAgo(c.at, now)}</Text>
          <Text as="div" size="meta" tone="muted">
            {formatDateTime(c.at)}
          </Text>
        </span>
      ),
    },
    {
      key: 'menu',
      title: <span role="img" aria-label="更多操作" />,
      align: 'right',
      render: (_, c) => (
        <RowMenu label={`更多操作：${c.short}`} title="复制提交号">
          <RowMenuItem onSelect={() => void copySha(c)}>复制完整提交号</RowMenuItem>
        </RowMenu>
      ),
    },
  ];
}

export default function Changelog() {
  const query = useFranceReleasedCommits();
  const { data, error, refetch, isFetching, dataUpdatedAt } = query;
  const now = useNow();
  const retry = () => void refetch();
  const commits = data?.state === 'ok' ? data.commits : null;
  const unreadTitles = commits?.filter((c) => c.title === null) ?? [];
  const whys = [...new Set(unreadTitles.map((c) => c.titleWhy ?? '标题没读到'))];
  return (
    <Page
      title="发布记录"
      breadcrumb={
        <>
          <Button variant="text" size="xs" href="/france">
            法国
          </Button>
          <span aria-hidden>/</span>
        </>
      }
      description="法国已发布的提交，新的在前。"
      detail="每 5 分钟自己重读一次法国的发布历史。悬停「发于」看具体时间；行尾「⋯」复制完整的提交号。读不到写没查成和原因，不当成没发过。要发新的，到法国页点「发布到法国」。"
      refresh={{
        onRefresh: retry,
        isFetching,
        dataUpdatedAt,
        staleAfterMs: CHANGELOG_STALE_AFTER_MS,
      }}
    >
      <Stack>
        {error && !data ? <LoadError what="已发布的提交" error={error} onRetry={retry} /> : null}
        {error && data ? (
          <LoadStale
            what="已发布的提交"
            error={error}
            when={formatAgo(new Date(dataUpdatedAt).toISOString(), now)}
            expired={Date.now() - dataUpdatedAt > CHANGELOG_STALE_AFTER_MS}
            onRetry={retry}
          />
        ) : null}
        {data?.state === 'unreadable' ? (
          <LoadError
            error={new Error(data.why)}
            text={`没查成：${data.why}。这不等于没发过。`}
            onRetry={retry}
          />
        ) : null}
        {unreadTitles.length > 0 ? (
          <LoadPartial>
            有 {unreadTitles.length} 条的标题没查成：{whys.join('；')}（提交号和时间是对的）。
          </LoadPartial>
        ) : null}
        {!data && !error ? (
          <Section title="发布记录">
            <LoadingRows rows={3} />
          </Section>
        ) : null}
        {commits ? (
          <Section
            flush={commits.length > 0}
            title={
              <>
                发布记录
                {commits.length > 0 ? <Tag>最近 {commits.length} 条</Tag> : null}
              </>
            }
            actions={
              commits.length > 0 ? (
                <Button variant="text" size="sm" href="/france">
                  去法国页发布
                </Button>
              ) : undefined
            }
          >
            {commits.length === 0 ? (
              <EmptyState
                icon={GitCommitHorizontal}
                title="法国的发布历史里还没有发布记录"
                hint="发过一次之后，这里按时间列出每次切上去的主线提交。"
                action={
                  <Button variant="outline" size="sm" href="/france">
                    去法国页发布
                  </Button>
                }
              />
            ) : (
              <div data-released-commits>
                <Table
                  caption="发布记录"
                  columns={columns(now)}
                  rows={commits}
                  rowKey={(c) => `${c.at}-${c.sha}-${c.event}`}
                />
              </div>
            )}
          </Section>
        ) : null}
      </Stack>
    </Page>
  );
}
