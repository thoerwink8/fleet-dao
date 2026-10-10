// 更新日志页：上面是「已发布的提交」（#1255，决定 0032：发版单位是主线提交），下面是仓根 CHANGELOG.md 在驾驶舱里的一份对照。
// 「已发布的提交」只读：读法国的发布历史（release.sh 的 .history，后端 GET /api/france/released-commits，和发版卡共用同一个读口），
// 每条写提交号、标题、发于何时；读不到写没查成和原因，不拿空列表冒充「没发过」。发布入口不在这一页：在「法国」页「在用版本」那一行。
// CHANGELOG 对照的数据来源是仓根 CHANGELOG.md 在打包时被内联进来的字符串（lib/changelog.ts 用 vite 的 ?raw 取），
// 格式解析共用 packages/shared/src/changelog.ts——和发布那条线是同一个实现，格式变了两边一样认不出。
import { CalendarClock, GitCommitHorizontal, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { useFranceReleasedCommits } from '../api/client';
import type { ReleasedCommits } from '../api/types';
import { MarkdownLite } from '../components/markdown-lite';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { readChangelog, releasedBody } from '../lib/changelog';
import { formatAgo, formatDateTime, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

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
          // 三列轨道换成 grid-cols-changelog。
          className="grid grid-cols-changelog items-baseline gap-x-3 px-4 py-2.5 text-sm"
        >
          <span className="num rounded bg-muted px-1.5 py-0.5 text-center text-xs">{c.short}</span>
          <div className="min-w-0">
            {c.title !== null ? (
              <p className="break-words">{c.title}</p>
            ) : (
              <Unread why={c.titleWhy ?? '标题没读到'} />
            )}
          </div>
          <div className="num text-right text-xs whitespace-nowrap text-muted-foreground">
            {c.event !== 'release' ? (
              <span className="mr-2 rounded-full border border-st-stall/40 px-1.5 py-0.5 text-ink-stall">
                {EVENT_TEXT[c.event]}
              </span>
            ) : null}
            发于 {formatAgo(c.at, now)}
            <span className="block text-caption text-faint">{formatDateTime(c.at)}</span>
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
  // 对照区看哪一段：null = 还没收进版本的那段（默认）；否则是 CHANGELOG 里的某一版
  const [picked, setPicked] = useState<string | null>(null);
  const query = useFranceReleasedCommits();
  const { refetch, isFetching, dataUpdatedAt } = query;
  const refresh = (
    <RefreshBar
      onRefresh={() => void refetch()}
      isFetching={isFetching}
      dataUpdatedAt={dataUpdatedAt}
      staleAfterMs={CHANGELOG_STALE_AFTER_MS}
    />
  );
  let data: ReturnType<typeof readChangelog>;
  try {
    data = readChangelog();
  } catch (error) {
    return (
      <Page
        title="更新日志"
        description="法国已发布的提交，和仓根 CHANGELOG.md 的一份对照。"
        actions={refresh}
      >
        <ReleasedCommitsPanel query={query} />
        <div className="mt-4">
          <LoadError error={error} what="CHANGELOG" />
        </div>
      </Page>
    );
  }
  const { section, released, hasContent } = data;

  return (
    <Page
      title="更新日志"
      description="上面是法国已发布的提交（发版单位是主线提交）；下面是仓根 CHANGELOG.md 的一份对照，按版本写的记录是旧做法留下的。"
      actions={refresh}
    >
      <ReleasedCommitsPanel query={query} />

      {/* 版式（驾驶舱改版 2026-10-07）：左边正文（Markdown 渲染成小标题和列表），右边目录（还没收进版本的 + CHANGELOG 里的每一版，点一版看正文）。 */}
      <h2 className="mt-8 mb-3 text-sm font-semibold">CHANGELOG.md 对照</h2>
      <div className="grid items-start gap-4 xl:grid-cols-4">
        <div className="min-w-0 xl:col-span-3">
          {picked === null ? (
            <Panel title="还没收进版本的更新">
              {hasContent ? (
                <MarkdownLite source={section} />
              ) : (
                <Empty
                  icon={CalendarClock}
                  title="还什么都没写"
                  hint="CHANGELOG.md 的 Unreleased 段现在是空的。"
                />
              )}
            </Panel>
          ) : (
            <RecordedPanel version={picked} date={released.find((r) => r.version === picked)?.date} />
          )}
        </div>

        <nav aria-label="CHANGELOG 目录" className="rounded-xl border bg-card p-2 shadow-card-edge">
          <button
            type="button"
            onClick={() => setPicked(null)}
            aria-current={picked === null ? 'true' : undefined}
            className={cn(
              'flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent',
              picked === null && 'bg-accent font-medium',
            )}
          >
            <span>还没收进版本</span>
          </button>
          <h3 className="mt-2 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">按版本写的记录</h3>
          {released.length === 0 ? (
            <Empty icon={ScrollText} title="一条都没有" hint="CHANGELOG.md 里没有按版本写的记录。" />
          ) : (
            released.map((r) => (
              <button
                key={`${r.version}-${r.date}`}
                type="button"
                onClick={() => setPicked(r.version)}
                aria-current={picked === r.version ? 'true' : undefined}
                className={cn(
                  'flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent',
                  picked === r.version && 'bg-accent',
                )}
              >
                <span className="num text-sm font-medium">{r.version}</span>
                <span className="num text-xs text-muted-foreground">{r.date}</span>
              </button>
            ))
          )}
        </nav>
      </div>
    </Page>
  );
}

/** CHANGELOG 里的某一版：正文从 CHANGELOG 里切出来；切不出就照实说没读成。 */
function RecordedPanel({ version, date }: { version: string; date: string | undefined }) {
  let body: string;
  try {
    body = releasedBody(version);
  } catch (error) {
    return <LoadError error={error} what={`${version} 的更新日志`} />;
  }
  return (
    <Panel title={version} description={date ? `${date} 记` : undefined}>
      {body ? (
        <MarkdownLite source={body} />
      ) : (
        <p className="text-sm text-muted-foreground">这一版没写正文。</p>
      )}
    </Panel>
  );
}
