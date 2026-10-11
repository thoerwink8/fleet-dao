// 更新日志页：「已发布的提交」（#1255，决定 0032：发版单位是主线提交）。
// 只读：读法国的发布历史（release.sh 的 .history，后端 GET /api/france/released-commits，和发版卡共用同一个读口），
// 每条写提交号、标题、发于何时；读不到写没查成和原因，不拿空列表冒充「没发过」。发布入口不在这一页：在「法国」页「在用版本」那一行。
// 「CHANGELOG.md 对照」区在 #1821 删了：只有一个 v3，对创始人没用。
import { GitCommitHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { useFranceReleasedCommits } from '../api/client';
import type { ReleasedCommits } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { formatAgo, formatDateTime, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('更新日志') }];
}

const EVENT_TEXT = { release: '发布', rollback: '回滚', 'auto-rollback': '自动回滚' } as const;

/** 已发布的提交每 5 分钟重拉一次。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const CHANGELOG_STALE_AFTER_MS = 5 * TIME.MIN;

type Commits = Extract<ReleasedCommits, { state: 'ok' }>['commits'];

/** 一行没查成：黄字写原因。 */
function Unread({ why }: { why: string }) {
  return (
    <p className="text-xs text-ink-stall" data-unreadable>
      没查成：{why}
    </p>
  );
}

function CommitList({ commits, now }: { commits: Commits; now: number }) {
  if (commits.length === 0) {
    return (
      <Empty
        icon={GitCommitHorizontal}
        title="法国的发布历史里还没有发布记录"
        hint="发过一次之后，这里按时间列出每次切上去的主线提交。"
      />
    );
  }
  return (
    <ul className="divide-y" data-released-commits>
      {commits.map((c) => (
        <li
          key={`${c.at}-${c.sha}-${c.event}`}
          // 窄屏：提交号和标题一行，徽标和时间换到第二行；宽屏三样排一行。标题列 min-w-0 flex-1，不被时间和徽标挤塌。
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
        >
          <span className="num shrink-0 rounded bg-muted px-1.5 py-0.5 text-center text-xs">{c.short}</span>
          <div className="min-w-0 flex-1">
            {c.title !== null ? (
              <p className="break-words">{c.title}</p>
            ) : (
              <Unread why={c.titleWhy ?? '标题没读到'} />
            )}
          </div>
          <div className="num w-full text-xs whitespace-nowrap text-muted-foreground sm:w-auto sm:text-right">
            {c.event !== 'release' ? (
              <span className="mr-2 rounded-full border border-st-stall/40 px-1.5 py-0.5 text-ink-stall">
                {EVENT_TEXT[c.event]}
              </span>
            ) : null}
            发于 {formatAgo(c.at, now)}
            <span className="ml-2 text-caption text-faint sm:ml-0 sm:block">{formatDateTime(c.at)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ReleasedCommitsPanel({ query }: { query: ReturnType<typeof useFranceReleasedCommits> }) {
  const now = useNow();
  const data = query.data;
  return (
    <Panel
      title="已发布的提交"
      description={
        <>
          法国发过的主线提交，新的在前，读自法国的发布历史。要发新的，到
          <Link to="/france" className="mx-0.5 underline underline-offset-2">
            法国
          </Link>
          页「在用版本」那一行点「发布到法国」。
        </>
      }
      bodyClassName="p-0"
    >
      {query.error ? (
        <div className="p-4">
          <LoadError what="已发布的提交" error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : !data ? (
        <div className="p-4">
          <LoadingRows rows={3} />
        </div>
      ) : data.state === 'unreadable' ? (
        <div className="p-4" role="alert">
          <Unread why={data.why} />
        </div>
      ) : (
        <CommitList commits={data.commits} now={now} />
      )}
    </Panel>
  );
}

export default function Changelog() {
  const query = useFranceReleasedCommits();
  const { refetch, isFetching, dataUpdatedAt } = query;
  return (
    <Page
      title="更新日志"
      description="法国已发布的提交，新的在前。"
      actions={
        <RefreshBar
          onRefresh={() => void refetch()}
          isFetching={isFetching}
          dataUpdatedAt={dataUpdatedAt}
          staleAfterMs={CHANGELOG_STALE_AFTER_MS}
        />
      }
    >
      <ReleasedCommitsPanel query={query} />
    </Page>
  );
}
