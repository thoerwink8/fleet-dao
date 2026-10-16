// 设置页「仓库」一节里的「导入仓库」：列出两个机器人已经装上的仓，
// 一行一个仓，标好「个人 / 组织」「App 装了没」「在不在驾驶舱」，每行给「加进 / 移出驾驶舱」。
// 装 App、连本人 GitHub 不在这里：新项目走本机 pnpm project add。
//
// 版式照 docs/design/驾驶舱界面.md 第三节：页面 → 区块两层；区块里用 List / ListRow，不手写卡片；
// 状态用 StatusBadge（有状态色的），分类用 Tag。

import { APPS_NOT_INSTALLED_HINT, githubInstallLinks } from '@fleet-dao/shared';
import { ExternalLink, FolderGit2, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useImportableRepos, useImportRepo, useRemoveRepo } from '../api/client';
import type { ImportableRepo } from '../api/types';
import { EmptyState } from './layout/empty-state';
import { List, ListRow } from './layout/list';
import { LoadError, LoadingRows } from './layout/load-state';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';

/** 「导入仓库」整块。列表是两个机器人的安装令牌能看见的仓。 */
export function RepoImportSection() {
  const query = useImportableRepos();

  if (query.isLoading) return <LoadingRows rows={1} />;
  if (query.error) {
    return (
      <Section variant="plain">
        <LoadError what="GitHub 上的仓" error={query.error} />
      </Section>
    );
  }
  const data = query.data;
  if (!data) return null;

  const repos = data.repos;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-muted-foreground">
          两个机器人已经装上的仓，共 <span className="num">{repos.length}</span> 个。新项目在本机跑{' '}
          <span className="num">pnpm project add</span>。
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          <RefreshCw className={query.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />
          重新读取
        </Button>
      </div>

      {data.reason ? (
        <Notice tone="stall" title="列表没读全">
          {data.reason}
        </Notice>
      ) : null}

      {repos.length === 0 ? (
        <EmptyState
          size="inline"
          icon={FolderGit2}
          title="没有读到仓"
          hint={
            data.reason
              ? '新项目在本机跑 pnpm project add。'
              : '两个机器人还没装到任何仓。新项目在本机跑 pnpm project add。'
          }
        />
      ) : (
        <>
          <RepoGroup
            title="个人仓"
            hint="你自己的仓，已经装上机器人的才列在这里。"
            rows={repos.filter((r) => r.ownerType === 'User')}
          />
          <RepoGroup
            title="组织的仓"
            hint="组织的仓，两个机器人装上了才列在这里。"
            rows={repos.filter((r) => r.ownerType === 'Organization')}
          />
        </>
      )}
    </div>
  );
}

function RepoGroup({ title, hint, rows }: { title: string; hint: string; rows: ImportableRepo[] }) {
  if (rows.length === 0) return null;
  return (
    <Section title={`${title}（${rows.length}）`} description={hint} variant="plain" flush>
      <List>
        {rows.map((repo) => (
          <ImportRow key={repo.githubId} repo={repo} />
        ))}
      </List>
    </Section>
  );
}

function ImportRow({ repo }: { repo: ImportableRepo }) {
  const importRepo = useImportRepo();
  const removeRepo = useRemoveRepo();
  const [askingRemove, setAskingRemove] = useState(false);
  const busy = importRepo.isPending || removeRepo.isPending;
  const blocked = repo.empty || repo.archived;

  return (
    <>
      <ListRow
        tall
        summary={
          // 窄屏（390）放不下「仓名 + 两个按钮」：仓名占满一行，按钮折到下一行靠右，谁都不出屏、不被挤成零宽（#2211）
          <div className="flex min-w-0 flex-1 items-center gap-2 max-md:flex-wrap max-md:py-1">
            <div className="flex min-w-0 flex-1 flex-col justify-center max-md:basis-full">
              <span className="flex min-w-0 items-center gap-1">
                <span className="num truncate text-body font-medium" title={repo.fullName}>
                  {repo.fullName}
                </span>
                {repo.private ? <Tag>私有</Tag> : null}
                {repo.archived ? <Tag>已归档</Tag> : null}
              </span>
              <span data-row-meta className="truncate text-meta text-muted-foreground">
                {repo.ownerType === 'Organization' ? '组织' : '个人'}
                {repo.inCockpit ? <span className="md:hidden">{' · 已在驾驶舱'}</span> : null}
                {repo.empty ? ' · 空仓：没有代码，接进来也没有活可派' : ''}
                {repo.archived ? ' · 已归档：不再改动' : ''}
              </span>
            </div>

            <span
              className="shrink-0 max-md:sr-only"
              title={repo.fullyInstalled ? '两个 App 都装了' : 'App 没装全'}
            >
              <StatusBadge
                variant="dot"
                tone={repo.fullyInstalled ? 'done' : 'wait'}
                label={repo.fullyInstalled ? 'App 已装' : 'App 没装全'}
              />
            </span>
            {repo.inCockpit ? (
              <span className="shrink-0 max-md:sr-only">
                <StatusBadge tone="done" label="已在驾驶舱" />
              </span>
            ) : null}
            {repo.inCockpit && !repo.fullyInstalled ? (
              <span className="shrink-0 max-md:sr-only">
                <StatusBadge tone="stall" label="未接入" />
              </span>
            ) : null}

            <div className="flex shrink-0 items-center gap-1.5 max-md:ml-auto">
              {repo.inCockpit ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setAskingRemove(true)}>
                  移出驾驶舱
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={importRepo.isPending}
                  disabled={busy || blocked}
                  title={repo.empty ? '空仓：没有代码，接进来也没有活可派' : undefined}
                  onClick={() =>
                    importRepo.mutate(
                      { githubId: repo.githubId },
                      {
                        onSuccess: (r) => {
                          if (r.appsInstalled === true) {
                            if (r.created) {
                              toast.success(`已把 ${repo.fullName} 接进驾驶舱（「让 AI 接活」默认关着）`);
                            } else toast.info(`${repo.fullName} 本来就在驾驶舱里`);
                          } else {
                            toast.warning(
                              r.appsInstalled === false
                                ? `${repo.fullName} 已接进驾驶舱，但未接入：${APPS_NOT_INSTALLED_HINT}`
                                : `${repo.fullName} 已接进驾驶舱，但没能核对机器人装没装`,
                              { description: r.installCheckWhy ?? '链接在这一行下面。' },
                            );
                          }
                        },
                        onError: (e) => toast.error('没能接进驾驶舱', { description: errorText(e) }),
                      },
                    )
                  }
                >
                  <Plus className="size-3.5" aria-hidden />
                  加进驾驶舱
                </Button>
              )}
            </div>
          </div>
        }
      />

      {repo.inCockpit && !repo.fullyInstalled ? <NotInstalledNotice repo={repo} /> : null}

      <AlertDialog open={askingRemove} onOpenChange={setAskingRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把 {repo.fullName} 移出驾驶舱？</AlertDialogTitle>
            <AlertDialogDescription>
              只从驾驶舱拿掉这个仓（repos 那一行），仓本身和 GitHub 上的东西都不动。
              还挂着没结束的需求时移不掉，会提示你先处理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              onConfirm={async () => {
                if (!repo.reposId) throw new Error('这个仓在驾驶舱里没有编号，移不了');
                let r: Awaited<ReturnType<typeof removeRepo.mutateAsync>>;
                try {
                  r = await removeRepo.mutateAsync(repo.reposId);
                } catch (err) {
                  toast.error('没能移出', { description: errorText(err) });
                  throw err;
                }
                if (!r.removed) {
                  toast.warning('没移出', { description: r.reason });
                  throw new Error(r.reason ?? '后端没说原因');
                }
                toast.success(`已把 ${repo.fullName} 移出驾驶舱`);
              }}
            >
              移出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** 已导入但机器人没装全：明说先去 GitHub 装，给直达链接。装全了用本机 pnpm project add。 */
function NotInstalledNotice({ repo }: { repo: ImportableRepo }) {
  const missing = [
    ...(repo.agentInstalled ? [] : (['agent'] as const)),
    ...(repo.engineInstalled ? [] : (['engine'] as const)),
  ];
  const links = githubInstallLinks({ owner: repo.owner, ownerType: repo.ownerType, missing });
  const who =
    missing.length === 2
      ? '「干活的」「引擎」两个机器人'
      : missing[0] === 'agent'
        ? '「干活的」机器人'
        : '「引擎」机器人';
  return (
    <Notice tone="stall" role="status" title={APPS_NOT_INSTALLED_HINT} className="mt-1">
      <p>
        {repo.fullName} 已在驾驶舱，但{who}还没装到这个仓，AI
        派不了活、合不了并。装好后点「重新读取」，或在本机跑 pnpm project add。
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {links.map((l) => (
          <li key={l.url}>
            <a
              className="inline-flex items-center gap-0.5 text-meta font-medium underline underline-offset-2"
              href={l.url}
              target="_blank"
              rel="noreferrer"
            >
              {l.label} <ExternalLink className="size-3" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
