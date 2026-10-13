// 设置页「仓库」里的「导入仓库」：登录人自己 GitHub 上能看到的仓，加进或移出驾驶舱，一键给两个 App 授权。
// 跳转地址只接受 https://github.com，和后端同一条，不跟请求里带来的网址走。
import { ORG_APP_APPROVAL_NOTE } from '@fleet-dao/shared';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  errorText,
  useAuthorizeGithubRepo,
  useConnectGithub,
  useGithubRepos,
  useImportRepo,
  useRemoveRepo,
} from '../api/client';
import type { GithubRepoRow } from '../api/types';
import { List, RowFrame } from './layout/list';
import { LoadError } from './layout/load-state';
import { Notice } from './layout/notice';
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

type AppState = GithubRepoRow['apps']['agent'];

function goGithub(url: string | undefined): void {
  if (!url) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    toast.error('授权地址不在 GitHub');
    return;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    toast.error('授权地址不在 GitHub');
    return;
  }
  window.location.assign(parsed.toString());
}

function appWord(state: AppState): string {
  if (state === 'installed') return '已装';
  if (state === 'missing') return '没装';
  return '认不出';
}

function appTone(state: AppState): 'done' | 'stall' | 'wait' {
  if (state === 'installed') return 'done';
  if (state === 'missing') return 'stall';
  return 'wait';
}

function sameRepo(row: GithubRepoRow, variables: { owner: string; name: string } | undefined): boolean {
  return (
    variables !== undefined &&
    variables.owner.toLowerCase() === row.owner.toLowerCase() &&
    variables.name.toLowerCase() === row.name.toLowerCase()
  );
}

export function RepoImport() {
  const list = useGithubRepos();
  const connect = useConnectGithub();
  const authorize = useAuthorizeGithubRepo();
  const importRepo = useImportRepo();
  const removeRepo = useRemoveRepo();
  const [params, setParams] = useSearchParams();
  const [removing, setRemoving] = useState<GithubRepoRow | null>(null);
  const github = params.get('github');

  useEffect(() => {
    if (!github) return;
    if (github === 'ok') toast.success('两个 App 已装上');
    else if (github === 'connected') toast.success('已连接 GitHub');
    else if (github === 'exchange_failed') toast.error('GitHub 授权没做成');
    else if (github === 'state') toast.error('授权状态对不上，请再点一次');
    else if (github === 'install_failed') toast.error('没装上');
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('github');
        return next;
      },
      { replace: true },
    );
  }, [github, setParams]);

  const data = list.data;
  const personal = data?.repos.filter((row) => row.ownerKind === 'user') ?? [];
  const orgs = data?.repos.filter((row) => row.ownerKind === 'org') ?? [];
  const unknown = data?.repos.find((row) => row.appsUnknown)?.appsUnknown;

  function startConnect(purpose: 'list' | 'install-account') {
    connect.mutate(purpose, {
      onSuccess: (result) => {
        if (result.redirect) goGithub(result.redirect);
        else if (result.connected) toast.success('GitHub 已经连上');
      },
      onError: (err) => toast.error('没连上 GitHub', { description: errorText(err) }),
    });
  }

  function add(row: GithubRepoRow) {
    importRepo.mutate(
      { owner: row.owner, name: row.name },
      {
        onSuccess: (result) => {
          toast.success(
            result.created
              ? `已把 ${result.owner}/${result.name} 加进驾驶舱，没有打开自动派单`
              : `${result.owner}/${result.name} 已经在驾驶舱里`,
          );
        },
        onError: (err) => toast.error('没加进', { description: errorText(err) }),
      },
    );
  }

  function install(row: GithubRepoRow) {
    authorize.mutate(
      { owner: row.owner, name: row.name },
      {
        onSuccess: (result) => {
          if (result.redirect) goGithub(result.redirect);
          else if (result.installed) toast.success(`两个 App 已装到 ${row.owner}/${row.name}`);
        },
        onError: (err) => toast.error('没装上', { description: errorText(err) }),
      },
    );
  }

  function confirmRemove() {
    if (!removing?.repoId) return;
    const label = `${removing.owner}/${removing.name}`;
    removeRepo.mutate(removing.repoId, {
      onSuccess: () => {
        setRemoving(null);
        toast.success(`已把 ${label} 移出驾驶舱`);
      },
      onError: (err) => {
        setRemoving(null);
        toast.error('没移出', { description: errorText(err) });
      },
    });
  }

  return (
    <div data-testid="repo-import" className="mb-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-medium">导入仓库</h3>
        {data?.connected ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={connect.isPending}
            onClick={() => startConnect('install-account')}
          >
            把 App 装到别的账号
          </Button>
        ) : null}
      </div>
      {data?.connected && data.githubLogin ? (
        <p className="mb-2 text-meta text-muted-foreground">
          GitHub 账号 {data.githubLogin}。只列这个账号自己能看到的仓。
        </p>
      ) : null}
      {list.isPending && !data ? (
        <p className="text-meta text-muted-foreground">在读 GitHub 上的仓…</p>
      ) : null}
      {list.error ? <LoadError what="GitHub 上的仓" error={list.error} /> : null}
      {data && !data.connected ? (
        <Notice
          tone="info"
          title="还没连接你的 GitHub"
          action={
            <Button type="button" size="sm" disabled={connect.isPending} onClick={() => startConnect('list')}>
              连接 GitHub
            </Button>
          }
        >
          {data.problem ?? '点「连接 GitHub」，用你自己的账号授权。'}
        </Notice>
      ) : null}
      {data?.connected && unknown ? <p className="mb-2 text-meta text-muted-foreground">{unknown}</p> : null}
      {data?.connected && data.truncated ? (
        <p className="mb-2 text-meta text-muted-foreground">只列出了前几页，后面的这次没列出来。</p>
      ) : null}
      {data?.connected && data.repos.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          这个账号下还没有能列出来的仓。把 App 装到账号上之后，装过的仓才会出现在这里。
        </p>
      ) : null}
      {data?.connected ? (
        <>
          <RepoGroup
            title="个人仓"
            rows={personal}
            onAdd={add}
            onInstall={install}
            onRemove={setRemoving}
            adding={importRepo}
            installing={authorize}
            removingId={removeRepo.isPending ? removeRepo.variables : undefined}
          />
          <RepoGroup
            title="组织仓"
            note={ORG_APP_APPROVAL_NOTE}
            rows={orgs}
            onAdd={add}
            onInstall={install}
            onRemove={setRemoving}
            adding={importRepo}
            installing={authorize}
            removingId={removeRepo.isPending ? removeRepo.variables : undefined}
          />
        </>
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              把 {removing ? `${removing.owner}/${removing.name}` : '这个仓'} 移出驾驶舱？
            </AlertDialogTitle>
            <AlertDialogDescription>
              移出之后不再参与派单。有任务、PR 或提醒跟进的仓移不出去，历史不删。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removeRepo.isPending}
              onClick={(event) => {
                event.preventDefault();
                confirmRemove();
              }}
            >
              {removeRepo.isPending ? '正在移出' : '确认移出'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RepoGroup({
  title,
  note,
  rows,
  onAdd,
  onInstall,
  onRemove,
  adding,
  installing,
  removingId,
}: {
  title: string;
  note?: string;
  rows: GithubRepoRow[];
  onAdd: (row: GithubRepoRow) => void;
  onInstall: (row: GithubRepoRow) => void;
  onRemove: (row: GithubRepoRow) => void;
  adding: { isPending: boolean; variables: { owner: string; name: string } | undefined };
  installing: { isPending: boolean; variables: { owner: string; name: string } | undefined };
  removingId: string | undefined;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3" data-testid={title === '组织仓' ? 'github-org-repos' : 'github-user-repos'}>
      <h4 className="mb-1 text-meta font-medium text-muted-foreground">{title}</h4>
      {note ? <p className="mb-1 text-meta text-muted-foreground">{note}</p> : null}
      <List aria-label={title}>
        {rows.map((row) => (
          <li key={`${row.owner}/${row.name}`}>
            <ImportRow
              row={row}
              onAdd={onAdd}
              onInstall={onInstall}
              onRemove={onRemove}
              adding={adding.isPending && sameRepo(row, adding.variables)}
              installing={installing.isPending && sameRepo(row, installing.variables)}
              removing={removingId === row.repoId}
            />
          </li>
        ))}
      </List>
    </div>
  );
}

function ImportRow({
  row,
  onAdd,
  onInstall,
  onRemove,
  adding,
  installing,
  removing,
}: {
  row: GithubRepoRow;
  onAdd: (row: GithubRepoRow) => void;
  onInstall: (row: GithubRepoRow) => void;
  onRemove: (row: GithubRepoRow) => void;
  adding: boolean;
  installing: boolean;
  removing: boolean;
}) {
  const slug = `${row.owner}/${row.name}`;
  const both = row.apps.agent === 'installed' && row.apps.engine === 'installed';
  return (
    <RowFrame tall className="items-start" data-testid={`github-repo-${row.owner}-${row.name}`}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-body font-medium">{slug}</span>
          <Tag>{row.ownerKind === 'org' ? '组织' : '个人'}</Tag>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge
            variant="dot"
            tone={appTone(row.apps.agent)}
            label={`干活的${appWord(row.apps.agent)}`}
          />
          <StatusBadge
            variant="dot"
            tone={appTone(row.apps.engine)}
            label={`引擎${appWord(row.apps.engine)}`}
          />
          <StatusBadge
            variant="dot"
            tone={row.inCockpit ? 'done' : 'stop'}
            label={row.inCockpit ? '在驾驶舱' : '不在驾驶舱'}
          />
        </div>
        {row.orgNote ? <p className="mt-1 text-meta text-muted-foreground">{row.orgNote}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {row.canAdmin && !row.inCockpit ? (
          <Button type="button" size="sm" disabled={adding} onClick={() => onAdd(row)}>
            {adding ? '正在加进' : '加进驾驶舱'}
          </Button>
        ) : null}
        {row.inCockpit && row.repoId ? (
          <Button type="button" size="sm" variant="outline" disabled={removing} onClick={() => onRemove(row)}>
            移出驾驶舱
          </Button>
        ) : null}
        {row.canAdmin && !both ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={installing}
            onClick={() => onInstall(row)}
          >
            {installing ? '正在授权' : '一键授权'}
          </Button>
        ) : null}
        {row.canAdmin ? null : <span className="text-meta text-muted-foreground">没有管理权限</span>}
      </div>
    </RowFrame>
  );
}
