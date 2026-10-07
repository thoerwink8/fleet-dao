// 仓根的 CHANGELOG 在驾驶舱里的一份对照：仓里有什么版本、这一版要发什么，看这里就够了。
// 数据来源是仓根的 CHANGELOG.md 在打包时被内联进来的字符串（lib/changelog.ts 用 vite 的 ?raw 取），
// 格式解析共用 packages/shared/src/changelog.ts——和发布那条线是同一个实现，格式变了两边一样认不出。
// 演示版不把这一页放进路由表、导航也不给它 module：CHANGELOG 里有仓名，不能进演示版产物。
// 「发布 v<N>」按钮（#593、#725）：版本号听后端（/api/release/version）。已发布的号是 CHANGELOG 的 ## [vN]；
// 开着的里程碑里 N 最小的那张若已有这个标记，后端判成已发布，这一版取下一个号。读不到、定不了就照实说，不显示 v1、不显示 0。
// 按钮自己不发起：「对外发布」是人闸第一类，发起要人按、指令在人的机器上走（publish:pr 开发布 PR，合并之后
// .github/workflows/release.yml 收尾），不让浏览器代点。点下去先再核一次版本号，和按钮上写的对不上就拒绝、说清。
import type { UseQueryResult } from '@tanstack/react-query';
import { CalendarClock, Rocket, ScrollText } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { brand } from '#brand';
import { errorText, useReleaseVersion } from '../api/client';
import type { ReleaseVersion } from '../api/types';
import { MarkdownLite } from '../components/markdown-lite';
import { Empty, LoadError, Page, Panel } from '../components/page';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { readChangelog, releasedBody } from '../lib/changelog';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('更新日志') }];
}

type Milestone = { number: number; title: string };

/** 这一刻的版本号。连驾驶舱后端都没连上和后端说读不到一样算读不到；上一次读成的不拿来顶。 */
type Release =
  | { kind: 'checking' }
  | { kind: 'unreadable'; why: string }
  | { kind: 'blocked'; why: string }
  | { kind: 'ok'; version: string; milestone: Milestone; others: Milestone[] };

function releaseOf(query: UseQueryResult<ReleaseVersion>): Release {
  if (query.isError) return { kind: 'unreadable', why: errorText(query.error) };
  const d = query.data;
  if (!d) return { kind: 'checking' };
  if (d.state === 'ok') return { kind: 'ok', version: d.version, milestone: d.milestone, others: d.others };
  return { kind: d.state, why: d.why };
}

const quoted = (ms: Milestone[]) => ms.map((m) => `「${m.title}」`).join('、');

export default function Changelog() {
  const query = useReleaseVersion();
  // 点「发布」那一刻按钮上写的版本号（没定出来是 null），和点完再核的那次对得上才给命令；null = 弹窗关着
  const [asked, setAsked] = useState<{ shown: string | null; checking: boolean } | null>(null);
  // 正文区看哪一段：null = 还没发版（默认）；否则是已发布的那一版
  const [picked, setPicked] = useState<string | null>(null);
  let data: ReturnType<typeof readChangelog>;
  try {
    data = readChangelog();
  } catch (error) {
    return (
      <Page title="更新日志" description="仓根的 CHANGELOG.md 在驾驶舱里的一份对照。">
        <LoadError error={error} what="CHANGELOG" />
      </Page>
    );
  }
  const { section, released, hasContent } = data;
  const release = releaseOf(query);
  const shown = release.kind === 'ok' ? release.version : null;

  async function publish() {
    setAsked({ shown, checking: true });
    await query.refetch();
    setAsked((a) => (a ? { ...a, checking: false } : a));
  }

  return (
    <Page
      title="更新日志"
      description="仓根 CHANGELOG.md 的一份对照：还没发出去的写在「还没发版」里，已经发出去的按版本排在下面。"
      actions={
        <Button size="sm" onClick={() => void publish()}>
          <Rocket aria-hidden />
          {shown ? `发布 ${shown}` : '发布'}
        </Button>
      }
    >
      <AlertDialog
        open={asked !== null}
        onOpenChange={(open) => {
          if (!open) setAsked(null);
        }}
      >
        <AlertDialogContent>
          {asked ? (
            <PublishDialog
              shown={asked.shown}
              release={asked.checking ? { kind: 'checking' } : release}
              hasContent={hasContent}
            />
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      {/* 版式（驾驶舱改版 2026-10-07）：左边正文（Markdown 渲染成小标题和列表，原来是原文塞进 <pre>，「###」「- 」照原样露着），
          右边版本目录（还没发版 + 已发布的每一版，点一版看它发了什么；原来已发布只列版本号和日期，点不开）。 */}
      <div className="grid items-start gap-4 xl:grid-cols-4">
        <div className="min-w-0 xl:col-span-3">
          {picked === null ? (
            <Panel title={panelTitle(release)} description={versionNote(release)}>
              {release.kind === 'unreadable' ? (
                <Alert tone="fail">读不到当前版本：{release.why}</Alert>
              ) : null}
              {release.kind === 'blocked' ? (
                <Alert tone="human">定不了这一版的版本号：{release.why}</Alert>
              ) : null}
              {hasContent ? (
                <MarkdownLite source={section} />
              ) : (
                <Empty
                  icon={CalendarClock}
                  title="还什么都没写"
                  hint="下一次发布前，把要发出去的更新写进 CHANGELOG.md 的 Unreleased 段。"
                />
              )}
            </Panel>
          ) : (
            <ReleasedPanel version={picked} date={released.find((r) => r.version === picked)?.date} />
          )}
        </div>

        <nav aria-label="版本" className="rounded-xl border bg-card p-2 shadow-card-edge">
          <button
            type="button"
            onClick={() => setPicked(null)}
            aria-current={picked === null ? 'true' : undefined}
            className={cn(
              'flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent',
              picked === null && 'bg-accent font-medium',
            )}
          >
            <span>还没发版</span>
            <span className="num text-xs text-muted-foreground">{shown ?? ''}</span>
          </button>
          <h2 className="mt-2 px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">已发布</h2>
          {released.length === 0 ? (
            <Empty icon={ScrollText} title="还没有发过版" hint="仓里还没有任何形式的正式发布。" />
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

/** 已发布的那一版：正文从 CHANGELOG 里切出来；切不出就照实说没读成。 */
function ReleasedPanel({ version, date }: { version: string; date: string | undefined }) {
  let body: string;
  try {
    body = releasedBody(version);
  } catch (error) {
    return <LoadError error={error} what={`${version} 的更新日志`} />;
  }
  return (
    <Panel title={`${version} · 已发布`} description={date ? `${date} 发出` : undefined}>
      {body ? (
        <MarkdownLite source={body} />
      ) : (
        <p className="text-sm text-muted-foreground">这一版没写正文。</p>
      )}
    </Panel>
  );
}

function panelTitle(release: Release): string {
  switch (release.kind) {
    case 'ok':
      return `还没发版 · 这一版是 ${release.version}`;
    case 'checking':
      return '还没发版 · 正在读当前版本…';
    case 'blocked':
      return '还没发版 · 定不了这一版的版本号';
    case 'unreadable':
      return '还没发版 · 读不到当前版本';
  }
}

function versionNote(release: Release): string | undefined {
  if (release.kind !== 'ok') return undefined;
  const from = `版本号取当前版本里程碑「${release.milestone.title}」（GitHub 上开着的 v<N> 里、CHANGELOG 还没有发布标记的 N 最小的那张）。`;
  if (release.others.length === 0) return from;
  return `${from}还开着的别的版本里程碑：${quoted(release.others)}，这次只发 ${release.version}。`;
}

function Alert({ tone, children }: { tone: 'fail' | 'human'; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        'mb-3 rounded-lg border px-3 py-2 text-sm',
        tone === 'fail'
          ? 'border-st-fail/40 bg-st-fail/10 text-ink-fail'
          : 'border-st-human/40 bg-st-human/10 text-ink-human',
      )}
    >
      {children}
    </div>
  );
}

const command = 'mt-1 block rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap';

/** 弹窗里的那一屏：正在核、定不了（拒绝）、和按钮上的对不上（拒绝）、对得上（给命令）。 */
function PublishDialog({
  shown,
  release,
  hasContent,
}: {
  shown: string | null;
  release: Release;
  hasContent: boolean;
}) {
  if (release.kind === 'checking') {
    return (
      <>
        <AlertDialogHeader>
          <AlertDialogTitle>发布</AlertDialogTitle>
          <AlertDialogDescription>正在从 GitHub 核当前版本…</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
        </AlertDialogFooter>
      </>
    );
  }

  if (release.kind !== 'ok') {
    return (
      <>
        <AlertDialogHeader>
          <AlertDialogTitle>现在发不了</AlertDialogTitle>
          <AlertDialogDescription>
            {release.kind === 'unreadable'
              ? `读不到当前版本：${release.why}`
              : `定不了这一版的版本号：${release.why}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">
          {release.kind === 'unreadable'
            ? '版本号没核过就不给命令：照错的号切了发布分支，pnpm publish:pr 会拒，第一步就走错。读得到了再点一次「发布」。'
            : '这时跑 pnpm publish:pr 也会照这句拒掉。先照上面说的理清楚，再点一次「发布」。'}
        </p>
        <AlertDialogFooter>
          <AlertDialogAction>知道了</AlertDialogAction>
        </AlertDialogFooter>
      </>
    );
  }

  const { version, milestone, others } = release;
  if (version !== shown) {
    return (
      <>
        <AlertDialogHeader>
          <AlertDialogTitle>版本对不上</AlertDialogTitle>
          <AlertDialogDescription>
            {shown
              ? `你点的是「发布 ${shown}」，刚从 GitHub 核到的当前版本是 ${version}（「${milestone.title}」）。`
              : `点的时候版本号还没核出来，刚从 GitHub 核到的当前版本是 ${version}（「${milestone.title}」）。`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">
          按钮已经换成「发布 {version}」：确认要发的是 {version}，关掉再点一次。
        </p>
        <AlertDialogFooter>
          <AlertDialogAction>知道了</AlertDialogAction>
        </AlertDialogFooter>
      </>
    );
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>发布 {version}</AlertDialogTitle>
        <AlertDialogDescription>
          发布是「对外发布」人闸（AGENTS.md「什么时候停下来问我」第一类）——浏览器不替你按。版本号取当前版本里程碑「
          {milestone.title}」（刚从 GitHub 核过）。CHANGELOG
          里已经有发布标记的号不算这一版，不按已发布的最大号 +1 猜。
          {others.length > 0 ? `还开着的别的版本里程碑：${quoted(others)}，这次只发 ${version}。` : ''}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          把这一版要发出去的更新写进仓根 CHANGELOG.md 的 Unreleased 段（
          {hasContent
            ? '这一页「还没发版」那块就是现在写的，核一眼写全了没有'
            : '这一页看到的还是空的，pnpm publish:pr 见到空的会拒发'}
          ）。改完不用提交，publish:pr 会一起提交。
        </li>
        <li>
          在本机一个 fleet-dao 检出里，从最新的 main 切发布分支：
          <code className={command}>git switch -c release/{version}</code>
        </li>
        <li>
          发起：
          <code className={command}>pnpm publish:pr</code>
          它把 Unreleased 段收进「## [{version}] - 日期」、提交、推，开一张「发布 {version}」PR（→ main）。
        </li>
      </ol>
      <p className="text-sm text-muted-foreground">
        你合并那张 PR 之后，.github/workflows/release.yml 核对版本里程碑、打 tag、建 GitHub
        Release、关里程碑「
        {milestone.title}」、推飞书。
      </p>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction>知道了</AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
