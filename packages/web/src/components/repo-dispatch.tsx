import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateRepoDispatch } from '../api/client';
import type { RepoDispatch } from '../api/types';
import { formatDateTime } from '../lib/format';
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

/**
 * 设置页「仓库」一节里每个项目的「让 AI 接活」：现在开还是关、什么时候开的、开/关按钮。
 * 点了先二次确认，再写后端（开关和操作记录同一事务，和命令行 fleet-api dispatch 同一个写入口）。
 * row 是 undefined 时（接口还在读、读不成）不画按钮：不知道现在是开是关，就不让人点。
 */
export function RepoDispatchControl({
  repoId,
  name,
  row,
}: {
  repoId: string;
  name: string;
  row: RepoDispatch | undefined;
}) {
  const update = useUpdateRepoDispatch();
  const [asking, setAsking] = useState(false);

  if (!row) return <span className="text-xs text-muted-foreground">开关没读到</span>;

  const target = !row.on;
  const verb = target ? '开启' : '关闭';
  const confirm = () => {
    update.mutate(
      { repoId, body: { on: target } },
      {
        onSuccess: (r) => {
          setAsking(false);
          toast.success(
            r.changed ? `已${verb}：${name} 的「让 AI 接活」` : `${name} 本来就是${r.on ? '开着' : '关着'}的`,
          );
        },
        onError: (e) => {
          setAsking(false);
          toast.error(`没能${verb}`, { description: errorText(e) });
        },
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid={`dispatch-${repoId}`}>
      <div className="min-w-0 text-xs text-muted-foreground">
        <span className="font-medium text-foreground" data-testid={`dispatch-state-${repoId}`}>
          {row.on ? '接活中' : '关着'}
        </span>
        <span className="ml-2" data-testid={`dispatch-note-${repoId}`}>
          {row.on && row.since ? `${formatDateTime(row.since)} 开的` : '只收单、不派活'}
        </span>
      </div>
      <>
        <Button
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => setAsking(true)}
          aria-label={`${verb} ${name} 的让 AI 接活`}
        >
          {verb}
        </Button>
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {verb} {name} 的「让 AI 接活」？
              </AlertDialogTitle>
              <AlertDialogDescription>
                {target
                  ? '开启后引擎下一轮拉单就开始往这个项目派活，并记一条操作记录。'
                  : '关闭后引擎只收单、显示，不再拉新单派活；这个开关只管拉单和派活，不会叫停已经在做的需求。并记一条操作记录。'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>先不</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  confirm();
                }}
              >
                {verb}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    </div>
  );
}
