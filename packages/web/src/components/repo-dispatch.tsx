import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateRepoDispatch } from '../api/client';
import type { RepoDispatch } from '../api/types';
import { formatDateTime } from '../lib/format';
import { StatusDot } from './status';
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

  const noteText =
    row.on && row.since ? `${formatDateTime(row.since)} 开的` : '只有本机 fleet-api dispatch-issue 点名派';
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
    <div className="flex items-center gap-x-2 self-center" data-testid={`dispatch-${repoId}`}>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot tone={row.on ? 'done' : 'stop'} />
        <span className="font-medium text-foreground" data-testid={`dispatch-state-${repoId}`}>
          {row.on ? '接活中' : '关着'}
        </span>
        {/* 说明收进悬停；宽屏才在行里写出来，窄屏不占行。 */}
        <span className="hidden 2xl:inline" data-testid={`dispatch-note-${repoId}`} title={noteText}>
          {noteText}
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
                  ? '开启后，引擎每 5 分钟自己按准入和排序挑单（老单要指挥官整理过）；没单可挑会自动叫指挥官整理。并记一条操作记录。'
                  : '关闭后，只有本机 fleet-api dispatch-issue 点名派。已经在做的需求不会被叫停。并记一条操作记录。'}
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
