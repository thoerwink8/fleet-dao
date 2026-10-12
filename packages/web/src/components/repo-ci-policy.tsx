import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateRepoCiPolicy } from '../api/client';
import type { RepoCiPolicy } from '../api/types';
import { formatDateTime } from '../lib/format';
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

/**
 * 设置页「仓库」一节里每个项目的 CI 模式：现在强制还是不强制、最近几次谁切的、切换按钮。
 * 点了先二次确认。fleet-dao 改成不强制时写明它推的是各仓各机器的规矩。
 * row 是 undefined 时（还在读、读不成）不画按钮。
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

  if (!row) return <span className="text-meta text-muted-foreground">CI 模式没读到</span>;

  const target = row.mode === 'force' ? 'off' : 'force';
  const verb = target === 'off' ? '改成不强制' : '改成强制';
  const fleetDao = repoNameOf(name) === 'fleet-dao' && target === 'off';
  const confirm = () => {
    update.mutate(
      { repoId, body: { mode: target } },
      {
        onSuccess: (r) => {
          setAsking(false);
          toast.success(r.changed ? `已把 ${name} ${verb} CI` : `${name} 本来就是${modeText(r.mode)}`);
        },
        onError: (e) => {
          setAsking(false);
          toast.error(`没能${verb}`, { description: errorText(e) });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-1 self-center" data-testid={`ci-policy-${repoId}`}>
      <div className="flex items-center gap-x-2">
        <div className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          <StatusDot tone={row.mode === 'force' ? 'done' : 'doubt'} />
          <span className="font-medium text-foreground" data-testid={`ci-policy-state-${repoId}`}>
            {modeText(row.mode)}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => setAsking(true)}
          aria-label={`${verb} ${name} 的 CI`}
        >
          {verb}
        </Button>
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                把 {name} {verb} CI？
              </AlertDialogTitle>
              <AlertDialogDescription>
                {target === 'off'
                  ? '开完 PR 引擎直接合并，不等 CI、不做冷验收。改标准的路径仍要人点头。'
                  : '恢复现在的流程：CI 全绿、冷验收通过之后才合并。'}
                {fleetDao ? ` ${FLEET_DAO_WARNING}` : ''}
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
      {row.recent.length > 0 ? (
        <ul className="text-meta text-muted-foreground">
          {row.recent.map((s) => (
            <li key={`${s.at}-${s.from}-${s.to}`}>
              {formatDateTime(s.at)} {s.actor}：{modeText(s.from)} → {modeText(s.to)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
