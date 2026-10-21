// 更新日志页：「已发布的提交」（#1255，决定 0032：发版单位是主线提交）。照路由页样板重做（#1914 的思路）：
// 顶上一块标题块写最近一次切上去的是哪个提交、什么时候；下面一个区块一行一个提交（标题加一个状态、灰字提交号和绝对时间、右边发于何时、行尾「⋯」）。
// 只读：读法国的发布历史（release.sh 的 .history，后端 GET /api/france/released-commits，和发版卡共用同一个读口），
// 读不到写没查成和原因，不拿空列表冒充「没发过」。发布入口不在这一页：在「法国」页「在用版本」那一行。
// 「CHANGELOG.md 对照」区在 #1821 删了：只有一个 v3，对创始人没用。
import { errMessage } from '@fleet-dao/shared/util';
import { GitCommitHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import { useFranceReleasedCommits } from '../api/client';
import type { ReleasedCommits } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { List, ListRow } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { RowMenu, RowMenuItem } from '../components/layout/row-menu';
import { Section, SectionGrid } from '../components/layout/section';
import { StatusBadge } from '../components/layout/status-badge';
import type { LayoutTone } from '../components/layout/tone';
import { formatAgo, formatDateTime, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('更新日志') }];
}

const EVENT_TEXT = { release: '发布', rollback: '回滚', 'auto-rollback': '自动回滚' } as const;

/** 已发布的提交每 5 分钟重拉一次。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const CHANGELOG_STALE_AFTER_MS = 5 * TIME.MIN;

type Commits = Extract<ReleasedCommits, { state: 'ok' }>['commits'];
type Commit = Commits[number];

/** 一行没查成：黄字写原因。 */
function Unread({ why, className }: { why: string; className?: string }) {
  return (
    <p className={className ?? 'text-meta text-ink-stall'} data-unreadable>
      没查成：{why}
    </p>
  );
}

/** 把完整的 40 位提交号放进剪贴板（列表上只写前 12 位）。 */
async function copySha(c: Commit) {
  try {
    await navigator.clipboard.writeText(c.sha);
    toast.success(`已复制提交号 ${c.short}`);
  } catch (e) {
    toast.error(`没复制成：${errMessage(e)}`);
  }
}

function CommitRow({ c, now }: { c: Commit; now: number }) {
  const at = formatDateTime(c.at);
  return (
    <ListRow
      tall
      data-event={c.event}
      summary={
        <>
          {/* 桌面一行不折（#1914）：标题截断、整句在悬停；回滚这类状态、时间、菜单不让位。
              手机上标题是认这个提交的那一样，不截断、放不下就换行；「发于」挪进下面的灰字，给标题让出宽度。 */}
          <div className="min-w-0 flex-1" data-commit-row>
            <div className="flex min-w-0 items-center gap-2 md:whitespace-nowrap" data-row-name-line>
              {c.title !== null ? (
                <p className="min-w-0 break-words text-body md:truncate" title={c.title}>
                  {c.title}
                </p>
              ) : (
                <Unread
                  why={c.titleWhy ?? '标题没读到'}
                  className="min-w-0 break-words text-body text-ink-stall md:truncate"
                />
              )}
              {c.event !== 'release' ? (
                <StatusBadge
                  tone="stall"
                  variant="outline"
                  icon={false}
                  label={EVENT_TEXT[c.event]}
                  className="shrink-0"
                />
              ) : null}
            </div>
            <p className="num truncate text-meta text-muted-foreground" data-row-meta>
              <span className="font-mono">{c.short}</span> · <span className="max-md:hidden">{at}</span>
              <span className="md:hidden" title={at}>
                发于 {formatAgo(c.at, now)}
              </span>
            </p>
          </div>
          <span
            className="num shrink-0 text-meta whitespace-nowrap text-muted-foreground max-md:hidden"
            title={at}
            data-released-at
          >
            发于 {formatAgo(c.at, now)}
          </span>
          <RowMenu label={`更多操作：${c.short}`} title="复制提交号">
            <RowMenuItem onSelect={() => void copySha(c)}>复制完整提交号</RowMenuItem>
          </RowMenu>
        </>
      }
    />
  );
}

function CommitList({ commits, now }: { commits: Commits; now: number }) {
  if (commits.length === 0) {
    return (
      <EmptyState
        icon={GitCommitHorizontal}
        title="法国的发布历史里还没有发布记录"
        hint="发过一次之后，这里按时间列出每次切上去的主线提交。"
      />
    );
  }
  return (
    <List data-released-commits>
      {commits.map((c) => (
        <CommitRow key={`${c.at}-${c.sha}-${c.event}`} c={c} now={now} />
      ))}
    </List>
  );
}

const heroBadge: Record<Commit['event'], { tone: LayoutTone; label: string; verb: string }> = {
  release: { tone: 'done', label: '最新', verb: '发布到法国' },
  rollback: { tone: 'stall', label: '回滚', verb: '回滚到这个提交' },
  'auto-rollback': { tone: 'stall', label: '自动回滚', verb: '自动回滚到这个提交' },
};

/**
 * 页顶的标题块（照路由页的用途标题块）：最近一次切上去的提交标题一行（subtitle，旁边小字提交号）；
 * 多久前发布或回滚加状态一行；绝对时间和这几条里发布、回滚各几次一行灰字。三行都不折：放不下截断，整句在悬停里。
 */
function ChangelogHero({ commits, now }: { commits: Commits; now: number }) {
  const latest = commits[0];
  if (!latest) return null;
  const badge = heroBadge[latest.event];
  const releases = commits.filter((c) => c.event === 'release').length;
  const rollbacks = commits.length - releases;
  const oldest = commits[commits.length - 1];
  const notes = [
    formatDateTime(latest.at),
    `最近 ${commits.length} 次里发布 ${releases}${rollbacks > 0 ? `、回滚 ${rollbacks}` : ''}`,
    oldest && oldest !== latest ? `最早一条 ${formatAgo(oldest.at, now)}` : null,
  ]
    .filter((x): x is string => Boolean(x))
    .join(' · ');
  const name = latest.title ?? `标题没查成：${latest.titleWhy ?? '标题没读到'}`;
  const line = `${formatAgo(latest.at, now)}${badge.verb}`;
  return (
    <header data-changelog-hero className="flex min-w-0 flex-col pt-1">
      <div className="mb-3 flex min-w-0 items-baseline gap-2 whitespace-nowrap">
        <p className="min-w-0 truncate text-title" title={name}>
          {name}
        </p>
        <span className="shrink-0 font-mono text-meta text-muted-foreground max-md:hidden">
          {latest.short}
        </span>
      </div>
      <p
        data-hero-line
        title={line}
        className="flex min-w-0 items-center gap-2.5 whitespace-nowrap text-heading font-normal"
      >
        <span data-hero-text className="num min-w-0 truncate">
          {line}
        </span>
        <span className="shrink-0">
          <StatusBadge tone={badge.tone} label={badge.label} />
        </span>
      </p>
      <p data-hero-notes title={notes} className="num mt-1.5 truncate text-meta text-muted-foreground">
        {notes}
      </p>
    </header>
  );
}

export default function Changelog() {
  const query = useFranceReleasedCommits();
  const { data, error, refetch, isFetching, dataUpdatedAt } = query;
  const now = useNow();
  const retry = () => void refetch();
  const commits = data?.state === 'ok' ? data.commits : null;
  return (
    <Page
      title="更新日志"
      description={
        <>
          法国已发布的提交，新的在前。要发新的，到
          <Link
            to="/france"
            className="mx-0.5 underline underline-offset-2 max-md:inline-flex max-md:min-h-10 max-md:min-w-10 max-md:items-center max-md:justify-center"
          >
            法国
          </Link>
          页点「发布到法国」。
        </>
      }
      detail="每 5 分钟自己重读一次法国的发布历史。悬停「发于」看具体时间；行尾「⋯」复制完整的提交号。读不到写没查成和原因，不当成没发过。"
      refresh={{
        onRefresh: retry,
        isFetching,
        dataUpdatedAt,
        staleAfterMs: CHANGELOG_STALE_AFTER_MS,
      }}
    >
      <SectionGrid cols={1}>
        {commits && commits.length > 0 && !error ? <ChangelogHero commits={commits} now={now} /> : null}
        <Section flush>
          {error ? (
            <div className="p-4">
              <LoadError what="已发布的提交" error={error} onRetry={retry} />
            </div>
          ) : !data ? (
            <div className="p-4">
              <LoadingRows rows={3} />
            </div>
          ) : data.state === 'unreadable' ? (
            <div className="p-4">
              <Notice tone="stall">
                <Unread why={data.why} />
              </Notice>
            </div>
          ) : (
            <CommitList commits={data.commits} now={now} />
          )}
        </Section>
      </SectionGrid>
    </Page>
  );
}
