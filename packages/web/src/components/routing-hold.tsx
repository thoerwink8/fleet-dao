// 路由页上的整池暂停入口（#1333，设置 engine.poolHolds）：挂在对应账号池旁边。
// 认得出的暂停在这里设、撤；整份认不出、某一项认不出、还靠旧提醒顶着的，只标明并链到设置页，不在这里撤一半。
// 校验沿用设置页：新建要过 draftProblem（原因、谁拍的、撤回条件、复查日期），撤回要写原因。

import { SETTING_SCHEMAS } from '@fleet-dao/shared';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
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
import { RowMenuItem } from './layout/row-menu';
import { StatusBadge } from './layout/status-badge';
import { useRoutingEdit } from './routing-edit';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

const FIELDS: { key: keyof HoldDraft; label: string; type?: string }[] = [
  { key: 'reason', label: '为什么停' },
  { key: 'decidedBy', label: '谁拍的' },
  { key: 'revokeWhen', label: '什么条件下撤' },
  { key: 'reviewBy', label: '最迟复查日期', type: 'date' },
];

/**
 * 这一行路由所属的账号池：设暂停、撤回，或标明已经暂停（路由页样板 #1914 起拆成三块，调用方各摆各的）：
 * badge 放在行的小字里（暂停了才有）；menu 是行尾「⋯」菜单里的一项；panel 是点了之后在行下面展开的表单。
 * 整池暂停没读到（还在读、读失败）三块都是空的：失败另有横幅。
 */
export function usePoolHoldControl(
  poolId: string,
  routeId: string,
): { badge: ReactNode; menu: ReactNode; panel: ReactNode } {
  const { disabledWhy } = useRoutingEdit();
  const holds = usePoolHolds();
  const update = useUpdateSetting();
  const navigate = useNavigate();
  const [open, setOpen] = useState<'pause' | 'revoke' | null>(null);
  const [draft, setDraft] = useState<HoldDraft>({ ...EMPTY_DRAFT, poolId });
  const [revokeReason, setRevokeReason] = useState('');
  const v = holds.data;
  if (!v || holds.error) return { badge: null, menu: null, panel: null };

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

  const badge = paused ? <StatusBadge tone="stall" variant="dot" label="整池暂停" /> : null;
  const itemWhy = disabledWhy ?? (update.isPending ? '正在保存，稍等' : undefined);

  let menu: ReactNode = null;
  if (paused && opaque) {
    menu = <RowMenuItem onSelect={() => void navigate('/settings')}>去设置页撤回整池暂停</RowMenuItem>;
  } else if (paused && recognized) {
    menu = (
      <RowMenuItem disabled={off || update.isPending} title={itemWhy} onSelect={() => setOpen('revoke')}>
        {`撤回账号池 ${poolId} 的整池暂停`}
      </RowMenuItem>
    );
  } else if (!paused) {
    menu = (
      <RowMenuItem
        disabled={off || update.isPending}
        title={itemWhy}
        onSelect={() => {
          setDraft({ ...EMPTY_DRAFT, poolId });
          setOpen('pause');
        }}
      >
        {`暂停账号池 ${poolId}`}
      </RowMenuItem>
    );
  }

  const panel = (
    <>
      {open === 'pause' ? (
        <div className="mt-1 mb-2 grid gap-2 rounded-lg bg-muted p-3">
          <p className="text-meta font-medium">{`暂停账号池 ${poolId}`}</p>
          {FIELDS.map((field) => (
            <div key={field.key} className="grid gap-1">
              <Label htmlFor={`${routeId}-hold-${field.key}`} className="text-meta text-muted-foreground">
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
            {problem ? <span className="mr-auto text-meta text-muted-foreground">{problem}</span> : null}
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
        <div className="mt-1 mb-2 grid gap-2 rounded-lg bg-muted p-3">
          <div className="grid gap-1">
            <Label htmlFor={`${routeId}-hold-revoke`} className="text-meta text-muted-foreground">
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
  return { badge, menu, panel };
}
