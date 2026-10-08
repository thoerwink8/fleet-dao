// 路由页上的整池暂停入口（#1333，设置 engine.poolHolds）：挂在对应账号池旁边。
// 认得出的暂停在这里设、撤；整份认不出、某一项认不出、还靠旧提醒顶着的，只标明并链到设置页，不在这里撤一半。
// 校验沿用设置页：新建要过 draftProblem（原因、谁拍的、撤回条件、复查日期），撤回要写原因。

import { SETTING_SCHEMAS } from '@fleet-dao/shared';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ApiError, errorText, usePoolHolds, useUpdateSetting } from '../api/client';
import {
  draftProblem,
  EMPTY_DRAFT,
  type HoldDraft,
  poolIsHeld,
  withHold,
  withoutHold,
} from '../lib/pool-holds';
import { useRoutingEdit } from './routing-edit';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const FIELDS: { key: keyof HoldDraft; label: string; type?: string }[] = [
  { key: 'reason', label: '为什么停' },
  { key: 'decidedBy', label: '谁拍的' },
  { key: 'revokeWhen', label: '什么条件下撤' },
  { key: 'reviewBy', label: '最迟复查日期', type: 'date' },
];

/** 这一行路由所属的账号池：设暂停、撤回，或标明已经暂停。 */
export function PoolHoldControl({ poolId, routeId }: { poolId: string; routeId: string }) {
  const { disabledWhy } = useRoutingEdit();
  const holds = usePoolHolds();
  const update = useUpdateSetting();
  const [open, setOpen] = useState<'pause' | 'revoke' | null>(null);
  const [draft, setDraft] = useState<HoldDraft>({ ...EMPTY_DRAFT, poolId });
  const [revokeReason, setRevokeReason] = useState('');
  const v = holds.data;
  if (!v || holds.error) return null;

  const off = disabledWhy !== null;
  const recognized = v.holds.some((h) => h.poolId === poolId);
  const opaque =
    v.holdAll ||
    v.problems.some((p) => p.poolId === null || p.poolId === poolId) ||
    v.legacy.some((l) => l.poolId === poolId);
  const paused = poolIsHeld(v, poolId);
  const existing = v.holds.map((h) => h.poolId);
  const problem = draftProblem(draft, existing);

  const save = (value: unknown, why: string, done: string) => {
    const check = SETTING_SCHEMAS['engine.poolHolds'].safeParse(value);
    if (!check.success) {
      toast.error('这个值不行', { description: check.error.issues[0]?.message ?? '不符合约定' });
      return;
    }
    update.mutate(
      { key: 'engine.poolHolds', body: { value: check.data, version: v.version, reason: why } },
      {
        onSuccess: () => {
          toast.success(done);
          setOpen(null);
          setRevokeReason('');
          setDraft({ ...EMPTY_DRAFT, poolId });
        },
        onError: (e) =>
          toast.error(
            e instanceof ApiError && e.code === 'conflict'
              ? '这项设置刚被别人改过，已刷新，请再改一次'
              : '没保存上',
            { description: errorText(e) },
          ),
      },
    );
  };

  const badge = paused ? (
    <Badge variant="outline" className="h-4 px-1 text-micro font-normal">
      整池暂停
    </Badge>
  ) : null;

  let action: ReactNode = null;
  if (paused && opaque) {
    action = (
      <Link to="/settings" className="text-caption text-muted-foreground underline underline-offset-2">
        去设置页撤回
      </Link>
    );
  } else if (paused && recognized) {
    action = (
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={off || update.isPending}
        onClick={() => setOpen(open === 'revoke' ? null : 'revoke')}
      >
        {`撤回账号池 ${poolId} 的整池暂停`}
      </Button>
    );
  } else if (!paused) {
    action = (
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={off || update.isPending}
        onClick={() => {
          setDraft({ ...EMPTY_DRAFT, poolId });
          setOpen(open === 'pause' ? null : 'pause');
        }}
      >
        {`暂停账号池 ${poolId}`}
      </Button>
    );
  }

  return (
    <>
      <span className="inline-flex items-center gap-1">
        {badge}
        {action}
      </span>
      {open === 'pause' ? (
        <div className="order-1 mt-1 grid basis-full gap-2 rounded-lg border bg-muted/30 p-2">
          {FIELDS.map((field) => (
            <div key={field.key} className="grid gap-1">
              <Label htmlFor={`${routeId}-hold-${field.key}`} className="text-caption text-muted-foreground">
                {field.label}
              </Label>
              <Input
                id={`${routeId}-hold-${field.key}`}
                type={field.type ?? 'text'}
                value={draft[field.key]}
                disabled={off || update.isPending}
                onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                className="h-8"
              />
            </div>
          ))}
          <div className="flex items-center justify-end gap-2">
            {problem ? <span className="mr-auto text-caption text-muted-foreground">{problem}</span> : null}
            <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(null)}>
              取消
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={off || update.isPending || problem !== null}
              onClick={() => {
                if (problem) return;
                save(withHold(v.holds, draft), draft.reason.trim(), `已暂停：${poolId}`);
              }}
            >
              确认暂停
            </Button>
          </div>
        </div>
      ) : null}
      {open === 'revoke' ? (
        <div className="order-1 mt-1 grid basis-full gap-2 rounded-lg border bg-muted/30 p-2">
          <div className="grid gap-1">
            <Label htmlFor={`${routeId}-hold-revoke`} className="text-caption text-muted-foreground">
              撤回原因
            </Label>
            <Input
              id={`${routeId}-hold-revoke`}
              value={revokeReason}
              disabled={off || update.isPending}
              onChange={(e) => setRevokeReason(e.target.value)}
              className="h-8"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(null)}>
              取消
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={off || update.isPending || revokeReason.trim() === ''}
              onClick={() => {
                const why = revokeReason.trim();
                if (why === '') return;
                save(withoutHold(v.holds, poolId), why, `已撤回：${poolId}`);
              }}
            >
              确认撤回
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
