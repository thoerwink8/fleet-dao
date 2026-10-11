import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateRepoCiMode } from '../api/client';
import type { CiMode, RepoDispatch } from '../api/types';
import { Notice } from './layout/notice';
import { StatusDot } from './layout/status-badge';
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

/** 界面上的叫法：后端的 required / skip 不露出来。 */
export const CI_MODE_LABEL: Record<CiMode, string> = {
  required: '强制 CI',
  skip: '不强制 CI',
};

/** 一行一句说清后果。 */
const CI_MODE_EFFECT: Record<CiMode, string> = {
  required: 'CI 全绿、冷验收通过才合并。',
  skip: '不等 CI、不做冷验收；改到标准路径的照旧停下等人，其余由引擎直接合并。',
};

/** fleet-dao 自己的额外提示：它推的是各仓各机器的规矩。 */
const SELF_REPO_WARNING =
  'fleet-dao 推的是各仓各机器的规矩，关掉它的 CI 意味着改规矩的 PR 也不再被 CI 把关；另外主线规则集若仍要求必过检查，GitHub 会拒绝合并，任务会停下报原因，要同时改规则集。';

/**
 * 设置页「仓库」一节里每个项目的「合并方式」：强制 CI（默认）或不强制 CI，随时可切。
 * 切成「不强制 CI」先确认（写清后果），切回「强制 CI」直接切。显示的永远是后端读回来的值，不乐观猜。
 * row 是 undefined（接口还在读、读不成）时不画：不知道现在是哪种，就不让人点。
 */
export function RepoCiModeControl({ repoId, row }: { repoId: string; row: RepoDispatch | undefined }) {
  const update = useUpdateRepoCiMode();
  const [asking, setAsking] = useState(false);

  if (!row) return null;

  const slug = `${row.owner}/${row.name}`;
  const target: CiMode = row.ciMode === 'required' ? 'skip' : 'required';
  const isSelf = row.name === 'fleet-dao';

  const apply = () => {
    update.mutate(
      { repoId, body: { ciMode: target } },
      {
        onSuccess: (r) => {
          setAsking(false);
          toast.success(
            r.changed
              ? `已切到「${CI_MODE_LABEL[r.ciMode]}」：${slug} 的合并方式`
              : `${slug} 本来就是「${CI_MODE_LABEL[r.ciMode]}」`,
          );
        },
        onError: (e) => {
          setAsking(false);
          toast.error(`没能切到「${CI_MODE_LABEL[target]}」`, { description: errorText(e) });
        },
      },
    );
  };

  return (
    <div
      className="flex basis-full flex-wrap items-center gap-x-4 gap-y-1.5"
      data-testid={`ci-mode-${repoId}`}
    >
      <div className="flex min-w-0 flex-1 basis-52 flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-muted-foreground">
        <span>合并方式</span>
        <span className="flex items-center gap-1.5">
          <StatusDot tone={row.ciMode === 'required' ? 'done' : 'stall'} />
          <span
            className="font-medium text-foreground"
            data-testid={`ci-mode-state-${repoId}`}
            data-ci-mode={row.ciMode}
          >
            {CI_MODE_LABEL[row.ciMode]}
          </span>
        </span>
        <span className="min-w-0" data-testid={`ci-mode-effect-${repoId}`}>
          {CI_MODE_EFFECT[row.ciMode]}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={update.isPending}
        onClick={() => (target === 'skip' ? setAsking(true) : apply())}
        aria-label={`把 ${slug} 的合并方式切到${CI_MODE_LABEL[target]}`}
      >
        切到{CI_MODE_LABEL[target]}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把 {slug} 切到「不强制 CI」？</AlertDialogTitle>
            <AlertDialogDescription>
              {CI_MODE_EFFECT.skip}切回「强制 CI」随时可以，两次切换都会记一条操作记录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {isSelf ? (
            <Notice tone="stall" title="这是 fleet-dao 自己">
              <span data-testid="ci-mode-self-warning">{SELF_REPO_WARNING}</span>
            </Notice>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              disabled={update.isPending}
              onClick={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              切到不强制 CI
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
