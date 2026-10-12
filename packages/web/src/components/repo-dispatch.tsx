import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateRepoDispatch } from '../api/client';
import type { RepoDispatch } from '../api/types';
import { formatDateTime } from '../lib/format';
import { StatusBadge } from './layout/status-badge';
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

/** 「让 AI 接活」的一句说明：开着写什么时候开的，关着写谁还能派。 */
export function dispatchNote(row: RepoDispatch): string {
  return row.on && row.since
    ? `${formatDateTime(row.since)} 开的`
    : '只有本机 fleet-api dispatch-issue 点名派';
}

/**
 * 设置页仓库行里的「让 AI 接活」：一个状态（接活中 / 关着）加一个开/关按钮（#1917，照路由页样板：一行一个状态）。
 * 什么时候开的、关着谁还能派，放在状态的悬停和读屏里，不在行里铺开。
 * 点了先二次确认，再写后端（开关和操作记录同一事务，和命令行 fleet-api dispatch 同一个写入口）。
 * row 是 undefined 时（接口还在读、读不成）不画按钮：不知道现在是开是关，就不让人点。
 * 外层是 contents：状态和按钮直接落在仓库行（RowFrame）里，和「整理」按钮同一行、同宽。
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

  if (!row)
    return (
      <div className="contents" data-testid={`dispatch-${repoId}`}>
        <span className="shrink-0 text-meta text-muted-foreground">开关没读到</span>
      </div>
    );

  const noteText = dispatchNote(row);
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
    <div className="contents" data-testid={`dispatch-${repoId}`}>
      {/* 手机上状态挪进仓名下面那行小字（行里放不下名字、状态、两个按钮），这里只给读屏 */}
      <span className="shrink-0 max-md:sr-only" title={noteText}>
        <span data-testid={`dispatch-state-${repoId}`}>
          <StatusBadge variant="dot" tone={row.on ? 'done' : 'stop'} label={row.on ? '接活中' : '关着'} />
        </span>
        <span className="sr-only" data-testid={`dispatch-note-${repoId}`}>
          ，{noteText}
        </span>
      </span>
      <Button
        size="sm"
        variant="outline"
        className="min-w-16"
        disabled={update.isPending}
        onClick={() => setAsking(true)}
        aria-label={`${verb} ${name} 的让 AI 接活`}
        title={noteText}
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
    </div>
  );
}
