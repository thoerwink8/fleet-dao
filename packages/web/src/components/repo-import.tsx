// 设置页「仓库」下面的「导入仓库」卡：列出两个机器人已经装上的仓，一行一个仓，一行一个状态
// （已在驾驶舱 / 未接入 / App 没装全 / 未加入），每行给「加进 / 移出驾驶舱」。
// 装 App、连本人 GitHub 不在这里：新项目走本机 pnpm project add。
// 样稿 Settings.dc.html：卡头「重新读取」「收起」；不分个人 / 组织两组，个人 / 组织写在仓名下面的小字里；
// 列表行里的按钮是次按钮（不放主按钮）。

import { APPS_NOT_INSTALLED_HINT, githubInstallLinks } from '@fleet-dao/shared';
import { FolderGit2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useImportableRepos, useImportRepo, useRemoveRepo } from '../api/client';
import type { ImportableRepo } from '../api/types';
import type { StatusKey } from '../theme/status-dict';
import { Button } from './layout/button';
import { ConfirmDialog } from './layout/confirm-dialog';
import { EmptyState } from './layout/empty-state';
import { LoadError, LoadingRows } from './layout/load-state';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Table, type TableColumn } from './layout/table';
import { Tag } from './layout/tag';
import { Text } from './layout/text';

/** 一行一个状态：已在驾驶舱但机器人没装全 → 未接入；已在 → 已在驾驶舱；没加入时看 App 装全没有。 */
function stateOf(repo: ImportableRepo): StatusKey {
  if (repo.inCockpit) return repo.fullyInstalled ? 'machine:repo:in-cockpit' : 'machine:repo:not-wired';
  return repo.fullyInstalled ? 'machine:repo:not-imported' : 'machine:repo:app-partial';
}

/** 「导入仓库」整块。列表是两个机器人的安装令牌能看见的仓。 */
export function RepoImportSection({ onClose }: { onClose?: () => void }) {
  const query = useImportableRepos();
  const data = query.data;
  const repos = data?.repos ?? [];
  const unwired = repos.filter((r) => r.inCockpit && !r.fullyInstalled);

  const columns: TableColumn<ImportableRepo>[] = [
    {
      key: 'fullName',
      title: '仓库',
      render: (_v, repo) => (
        <Stack gap="sm">
          <Stack direction="horizontal" gap="sm" align="center">
            <Text strong truncate title={repo.fullName}>
              {repo.fullName}
            </Text>
            {repo.private ? <Tag>私有</Tag> : null}
            {repo.archived ? <Tag>已归档</Tag> : null}
          </Stack>
          <Text size="meta" tone="muted">
            {repo.ownerType === 'Organization' ? '组织' : '个人'}
            {repo.empty ? ' · 空仓：没有代码，接进来也没有活可派' : ''}
            {repo.archived ? ' · 已归档：不再改动' : ''}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'state',
      title: '状态',
      render: (_v, repo) => <StatusBadge status={stateOf(repo)} variant="dot" />,
    },
    {
      key: 'actions',
      title: '操作',
      render: (_v, repo) => <ImportActions repo={repo} />,
    },
  ];

  return (
    <Section
      title="导入仓库"
      actions={
        <>
          <Button size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
            重新读取
          </Button>
          {onClose ? (
            <Button size="sm" variant="text" onClick={onClose}>
              收起
            </Button>
          ) : null}
        </>
      }
    >
      {query.isLoading ? (
        <LoadingRows rows={2} />
      ) : query.error ? (
        <LoadError what="GitHub 上的仓" error={query.error} />
      ) : !data ? null : (
        <Stack gap="md">
          {data.reason ? (
            <Notice tone="stall" title="列表没读全">
              {data.reason}
            </Notice>
          ) : null}
          <Text size="meta" tone="muted">
            只列两个机器人已经装上的仓，共 {repos.length} 个。接进来的仓「让 AI
            接活」默认关着，要另外打开。新项目在本机跑{' '}
            <Text size="meta" mono>
              pnpm project add
            </Text>
            。
          </Text>
          {unwired.length > 0 ? (
            <Notice tone="stall" role="status" title={APPS_NOT_INSTALLED_HINT}>
              {unwired.map((r) => r.fullName).join('、')} 已在驾驶舱，但机器人还没装到这些仓，AI
              派不了活、合不了并。装好后点「重新读取」，或在本机跑 pnpm project add。
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
            <Table columns={columns} rows={repos} rowKey={(r) => String(r.githubId)} caption="可导入的仓库" />
          )}
        </Stack>
      )}
    </Section>
  );
}

function ImportActions({ repo }: { repo: ImportableRepo }) {
  const importRepo = useImportRepo();
  const removeRepo = useRemoveRepo();
  const [askingRemove, setAskingRemove] = useState(false);
  const blocked = repo.empty || repo.archived;
  const missing = [
    ...(repo.agentInstalled ? [] : (['agent'] as const)),
    ...(repo.engineInstalled ? [] : (['engine'] as const)),
  ];
  const links =
    repo.inCockpit && !repo.fullyInstalled
      ? githubInstallLinks({ owner: repo.owner, ownerType: repo.ownerType, missing })
      : [];

  return (
    <Stack direction="horizontal" gap="sm" align="center" wrap>
      {repo.inCockpit ? (
        <Button size="sm" loading={removeRepo.isPending} onClick={() => setAskingRemove(true)}>
          移出驾驶舱
        </Button>
      ) : (
        <Button
          size="sm"
          loading={importRepo.isPending}
          disabledReason={
            blocked ? (repo.empty ? '空仓：没有代码，接进来也没有活可派' : '已归档：不再改动') : undefined
          }
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
          加进驾驶舱
        </Button>
      )}
      {links.map((l) => (
        <Button key={l.url} size="sm" variant="text" href={l.url} external>
          {l.label}
        </Button>
      ))}
      <ConfirmDialog
        open={askingRemove}
        onOpenChange={setAskingRemove}
        danger
        title={`把 ${repo.fullName} 移出驾驶舱？`}
        description="只从驾驶舱拿掉这个仓（repos 那一行），仓本身和 GitHub 上的东西都不动。还挂着没结束的需求时移不掉，会提示你先处理。"
        confirmText="移出"
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
      />
    </Stack>
  );
}
