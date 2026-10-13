// 设置页「仓库」一节里的「导入仓库」（#1989）：列出登录人自己 GitHub 上能看到的仓，
// 一行一个仓，标好「个人 / 组织」「App 装了没」「在不在驾驶舱」，每行给「加进 / 移出驾驶舱」「一键授权」。
//
// 版式照 docs/design/驾驶舱界面.md 第三节：页面 → 区块两层；区块里用 List / ListRow，不手写卡片；
// 状态用 StatusBadge（有状态色的），分类用 Tag；行的次要操作收进 RowMenu。
//
// 为什么组织仓和个人仓分开写：GitHub 的规矩——个人仓本人点一下就能装；组织仓要「组织已批准这个 App」，
// 本人点了也只是「请求」。页面上把这条明写出来，不给一个点了没反应的按钮。

import { ExternalLink, FolderGit2, Plus, RefreshCw, Settings2, Unplug } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  errorText,
  useDisconnectGitHub,
  useImportableRepos,
  useImportRepo,
  useRemoveRepo,
} from '../api/client';
import type { ImportableRepo } from '../api/types';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
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

/** 「装 App」在 GitHub 上的直达地址（App 的 slug 拼出来）；装过一次之后才能把某个仓加进安装。 */
function appInstallUrl(slug: 'agent' | 'engine'): string {
  const name = slug === 'agent' ? 'fleet-dao-agent' : 'fleet-dao-engine';
  return `https://github.com/apps/${name}/installations/new`;
}

/**
 * 「导入仓库」整块。未连接时只画一句「连接 GitHub」加一个按钮；
 * 连上之后画仓列表，每行两个动作。
 */
export function RepoImportSection() {
  const query = useImportableRepos();
  const disconnect = useDisconnectGitHub();
  const [askingDisconnect, setAskingDisconnect] = useState(false);
  // 钩子要在所有提前 return 之前调用（React 的规矩）：放最上面。
  const now = useNow();

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

  // 没连 GitHub：只画连接那一步。后端没接上 GitHub 时（reason 有值）把原因写出来，不给一个点了没反应的按钮。
  if (!data.auth.connected) {
    return (
      <Section variant="plain">
        <div className="space-y-3">
          <p className="text-body text-muted-foreground">
            连上 GitHub 之后，这里会列出你自己能看到的所有仓，勾选就能接进驾驶舱派单。
            <br />
            授权只多一个「读仓列表、改 App 安装」的权限，随时能在 GitHub 上撤。
          </p>
          {data.reason ? (
            <Notice tone="stall" title="这台后端的 GitHub 没接上">
              {data.reason}
            </Notice>
          ) : null}
          <Button
            disabled={Boolean(data.reason)}
            onClick={() => {
              // 走后端 OAuth 跳转（不是 fetch）：整页跳到 GitHub 授权页，回来落在设置页。
              window.location.href = '/api/github/connect';
            }}
          >
            <FolderGit2 className="mr-1.5 size-4" aria-hidden />
            连接 GitHub
          </Button>
        </div>
      </Section>
    );
  }

  const repos = data.repos;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-muted-foreground">
          以 <span className="num font-medium text-foreground">{data.auth.login}</span> 的身份读了{' '}
          <span className="num">{repos.length}</span> 个仓
          {data.auth.connectedAt ? (
            <>
              {' · '}
              <span className="num">{formatAgo(data.auth.connectedAt, now)}连的</span>
            </>
          ) : null}
          {data.auth.scopes ? <span title={data.auth.scopes}>（权限：{data.auth.scopes}）</span> : null}
        </p>
        <div className="flex items-center gap-2">
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
          <Button
            size="sm"
            variant="outline"
            loading={disconnect.isPending}
            disabled={disconnect.isPending}
            onClick={() => setAskingDisconnect(true)}
          >
            <Unplug className="size-3.5" aria-hidden />
            断开
          </Button>
        </div>
      </div>

      {data.auth.unreadable ? (
        <Notice tone="stall" title="存着的授权读不出来">
          {data.auth.unreadableWhy ?? '换过会话密钥或数据被动过，断开后重新连接即可。'}
        </Notice>
      ) : null}
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
          hint={data.reason ?? '你 GitHub 上还没有仓，或者这个令牌读不到。'}
        />
      ) : (
        <>
          {/* 个人仓 / 组织仓分开：组织仓要组织先批准 App，点一下只是「请求」。 */}
          <RepoGroup
            title="个人仓"
            hint="你自己的仓，点「加进驾驶舱」或「一键授权」当场生效。"
            rows={repos.filter((r) => r.ownerType === 'User')}
          />
          <RepoGroup
            title="组织的仓"
            hint="要组织先批准这个 App；你在这个组织里没有 admin 的，点了只是给组织发一个请求。"
            rows={repos.filter((r) => r.ownerType === 'Organization')}
          />
        </>
      )}

      <AlertDialog open={askingDisconnect} onOpenChange={setAskingDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>断开 GitHub 授权？</AlertDialogTitle>
            <AlertDialogDescription>
              断开后，驾驶舱不再用这个身份读你的仓。仓本身和 GitHub 上的东西都不动。要再导入，重新连接即可。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              onConfirm={async () => {
                try {
                  await disconnect.mutateAsync();
                  toast.success('已断开 GitHub 授权');
                } catch (err) {
                  toast.error('没能断开', { description: errorText(err) });
                  throw err;
                }
              }}
            >
              断开
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

  return (
    <>
      <ListRow
        tall
        summary={
          <>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <span className="flex min-w-0 items-center gap-1">
                <span className="num truncate text-body font-medium" title={repo.fullName}>
                  {repo.fullName}
                </span>
                {repo.private ? <Tag>私有</Tag> : null}
                {repo.archived ? <Tag>已归档</Tag> : null}
              </span>
              <span data-row-meta className="truncate text-meta text-muted-foreground">
                {repo.ownerType === 'Organization' ? '组织 · 要组织先批准这个 App' : '个人'}
                {repo.installBlockedWhy ? ` · ${repo.installBlockedWhy}` : ''}
              </span>
            </div>

            {/* 状态：App 装了没、在不在驾驶舱。 */}
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
            {repo.inCockpit ? <StatusBadge tone="done" label="已在驾驶舱" /> : null}

            {/* 动作：没装全给「一键授权」（整页跳 GitHub），没在驾驶舱给「加进驾驶舱」，在驾驶舱给「移出」。 */}
            <div className="flex shrink-0 items-center gap-1.5">
              {!repo.fullyInstalled && repo.canInstall ? (
                <Button size="sm" variant="outline" asChild>
                  <a href={`/api/github/authorize?githubId=${repo.githubId}`}>一键授权</a>
                </Button>
              ) : null}
              {!repo.fullyInstalled && !repo.canInstall && !repo.installBlockedWhy ? (
                // 能装但没装全、又不是「没权限」这一类：多半是 App 还没装到本人的账号上，给直达链接。
                <a
                  className="inline-flex items-center gap-0.5 text-meta text-brand hover:underline"
                  href={appInstallUrl(repo.agentInstalled ? 'engine' : 'agent')}
                  target="_blank"
                  rel="noreferrer"
                >
                  去 GitHub 装 App <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}

              {repo.inCockpit ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setAskingRemove(true)}>
                  移出驾驶舱
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={importRepo.isPending}
                  disabled={busy || repo.empty || repo.archived}
                  title={repo.empty ? '空仓：没有代码，接进来也没有活可派' : undefined}
                  onClick={() =>
                    importRepo.mutate(
                      { githubId: repo.githubId },
                      {
                        onSuccess: (r) =>
                          r.created
                            ? toast.success(`已把 ${repo.fullName} 接进驾驶舱（「让 AI 接活」默认关着）`)
                            : toast.info(`${repo.fullName} 本来就在驾驶舱里`),
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
          </>
        }
      />

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
              // 等结果：移出了框才关（原来成功了框也不关，#2009）；后端说没移出（还挂着没结束的需求）或请求失败，
              // 弹 toast 并留在框里写原因
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

/** 设置页「仓库」一节的页头按钮：跳到 GitHub 的连接入口（没连时给个醒目入口）。 */
export function GitHubConnectButton() {
  return (
    <Button size="sm" variant="outline" onClick={() => (window.location.href = '/api/github/connect')}>
      <Settings2 className="size-3.5" aria-hidden />
      连接 GitHub
    </Button>
  );
}
