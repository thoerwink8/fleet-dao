// 设置页仓库表里的「让 AI 接活」（#1917 一行一个状态；#3533 照样稿拆成表里的两格）：
// - DispatchState：状态格，一个状态点加字（接活中 / 关着）；什么时候开的、关着谁还能派，放在悬停和读屏里。
// - DispatchAction：操作格里的「开启 / 关闭」按钮，点了先二次确认，再写后端（开关和操作记录同一事务，和命令行 fleet-api dispatch 同一个写入口）。
// row 是 undefined 时（接口还在读、读不成）状态格写「开关没读到」、不画按钮：不知道现在是开是关，就不让人点。
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateRepoDispatch } from '../api/client';
import type { RepoDispatch } from '../api/types';
import { formatDateTime } from '../lib/format';
import { Button } from './layout/button';
import { ConfirmDialog } from './layout/confirm-dialog';
import { StatusBadge } from './layout/status-badge';
import { Text } from './layout/text';

/** 「让 AI 接活」的一句说明：开着写什么时候开的，关着写谁还能派。 */
export function dispatchNote(row: RepoDispatch): string {
  return row.on && row.since
    ? `${formatDateTime(row.since)} 开的`
    : '只有本机 fleet-api dispatch-issue 点名派';
}

/** 状态格。 */
export function DispatchState({
  repoId,
  row,
  masterOff,
}: {
  repoId: string;
  row: RepoDispatch | undefined;
  /** 总开关读到关着：接活中的仓旁边加一句「总开关关着，不会派」（读不到不冒充关着）。 */
  masterOff?: boolean;
}) {
  if (!row)
    return (
      <span data-testid={`dispatch-state-${repoId}`}>
        <Text tone="muted">开关没读到</Text>
      </span>
    );
  const noteText = dispatchNote(row);
  return (
    <span title={noteText} data-testid={`dispatch-state-${repoId}`}>
      <StatusBadge status={row.on ? 'machine:dispatch:on' : 'machine:dispatch:off'} variant="dot" />
      {row.on && masterOff ? (
        <Text size="meta" tone="muted">
          {' '}
          总开关关着，不会派
        </Text>
      ) : null}
    </span>
  );
}

/** 操作格里的「开启 / 关闭」。 */
export function DispatchAction({
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
  if (!row) return null;

  const target = !row.on;
  const verb = target ? '开启' : '关闭';
  // 确认框等它：成功框关、弹成功；失败弹 toast 并抛给框——框留着写原因、能再点（#2009）
  const confirm = async () => {
    try {
      const r = await update.mutateAsync({ repoId, body: { on: target } });
      toast.success(
        r.changed ? `已${verb}：${name} 的「让 AI 接活」` : `${name} 本来就是${r.on ? '开着' : '关着'}的`,
      );
    } catch (e) {
      toast.error(`没能${verb}`, { description: errorText(e) });
      throw e;
    }
  };

  return (
    <span data-testid={`dispatch-${repoId}`}>
      <Button
        size="sm"
        variant="secondary"
        loading={update.isPending}
        onClick={() => setAsking(true)}
        aria-label={`${verb} ${name} 的让 AI 接活`}
        title={dispatchNote(row)}
      >
        {verb}
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`${verb} ${name} 的「让 AI 接活」？`}
        description={
          target
            ? '开启后，引擎每 5 分钟自己按准入和排序挑单（老单要指挥官整理过）；没单可挑会自动叫指挥官整理。并记一条操作记录。'
            : '关闭后，只有本机 fleet-api dispatch-issue 点名派。已经在做的需求不会被叫停。并记一条操作记录。'
        }
        confirmText={verb}
        onConfirm={confirm}
      />
    </span>
  );
}
