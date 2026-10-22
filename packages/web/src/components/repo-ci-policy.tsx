import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateRepoCiPolicy } from '../api/client';
import type { RepoCiPolicy } from '../api/types';
import { formatDateTime } from '../lib/format';
import { Button } from './layout/button';
import { ConfirmDialog } from './layout/confirm-dialog';
import { Stack } from './layout/stack';
import { Text } from './layout/text';

const FLEET_DAO_WARNING =
  'fleet-dao 推的是各仓各机器的规矩。关掉强制 CI 之后，引擎不再等检查、也不做冷验收，开完 PR 就直接合并。';

function modeText(mode: 'force' | 'off'): string {
  return mode === 'force' ? '强制 CI' : '不强制 CI';
}

/** 斜杠后面的仓名。fleet-dao 才警告；fleet-dao-canary 不算。 */
function repoNameOf(full: string): string {
  const i = full.lastIndexOf('/');
  return i === -1 ? full : full.slice(i + 1);
}

/** 表里的「CI 模式」格：强制是正常的灰阶字，不强制是橙字（颜色只给异常）；读不到写「没读到」。 */
export function CiState({ repoId, row }: { repoId: string; row: RepoCiPolicy | undefined }) {
  return (
    <span data-testid={`ci-policy-state-${repoId}`}>
      {row ? (
        <Text tone={row.mode === 'force' ? 'default' : 'warning'}>{modeText(row.mode)}</Text>
      ) : (
        <Text tone="muted">没读到</Text>
      )}
    </span>
  );
}

/**
 * 仓库展开区里的 CI 模式：说明、切换按钮、最近几次谁切的。
 * 点了先二次确认。fleet-dao 改成不强制时写明它推的是各仓各机器的规矩。
 * row 是 undefined 时（还在读、读不成）不画按钮，写「CI 模式没读到」。
 */
export function RepoCiPolicyControl({
  repoId,
  name,
  row,
}: {
  repoId: string;
  name: string;
  row: RepoCiPolicy | undefined;
}) {
  const update = useUpdateRepoCiPolicy();
  const [asking, setAsking] = useState(false);

  if (!row)
    return (
      <span data-testid={`ci-policy-${repoId}`}>
        <Text tone="muted">CI 模式没读到</Text>
      </span>
    );

  const target = row.mode === 'force' ? 'off' : 'force';
  const verb = target === 'off' ? '改成不强制' : '改成强制';
  const fleetDao = repoNameOf(name) === 'fleet-dao' && target === 'off';
  // 确认框等它：成功框关、弹成功；失败弹 toast 并抛给框——框留着写原因、能再点（#2009）
  const confirm = async () => {
    try {
      const r = await update.mutateAsync({ repoId, body: { mode: target } });
      toast.success(r.changed ? `已把 ${name} ${verb} CI` : `${name} 本来就是${modeText(r.mode)}`);
    } catch (e) {
      toast.error(`没能${verb}`, { description: errorText(e) });
      throw e;
    }
  };

  return (
    <div data-testid={`ci-policy-${repoId}`}>
      <Stack gap="sm">
        <Text strong>CI 模式</Text>
        <Text size="meta" tone="muted">
          强制：CI 全绿、冷验收通过之后才合并。不强制：开完 PR 直接合并，不等 CI、不做冷验收。现在是
          {modeText(row.mode)}。
        </Text>
        <Stack direction="horizontal" gap="sm" align="center">
          <Button
            size="sm"
            loading={update.isPending}
            onClick={() => setAsking(true)}
            aria-label={`${verb} ${name} 的 CI`}
          >
            {verb}
          </Button>
        </Stack>
        {row.recent.length > 0 ? (
          <ul aria-label="最近的切换">
            {row.recent.map((s) => (
              <li key={`${s.at}-${s.from}-${s.to}`}>
                <Text size="meta" tone="muted">
                  {formatDateTime(s.at)} {s.actor}：{modeText(s.from)} → {modeText(s.to)}
                </Text>
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`把 ${name} ${verb} CI？`}
        description={`${
          target === 'off'
            ? '开完 PR 引擎直接合并，不等 CI、不做冷验收。改标准的路径仍要人点头。'
            : '恢复现在的流程：CI 全绿、冷验收通过之后才合并。'
        }${fleetDao ? ` ${FLEET_DAO_WARNING}` : ''}`}
        confirmText={verb}
        onConfirm={confirm}
      />
    </div>
  );
}
