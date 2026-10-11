// 尺寸 token：暂停明细 grid-cols-auto-fr（标签原来 auto、剩余 1fr）。
import { DEFAULT_POOL_HOLD_OWNER, SETTING_SCHEMAS } from '@fleet-dao/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorText, usePoolHolds, usePools, useUpdateSetting } from '../api/client';
import type { PoolHoldFactView } from '../api/types';
import {
  draftProblem,
  EMPTY_DRAFT,
  entriesOf,
  type HoldDraft,
  holdsNeedAttention,
  reviewWords,
  withHold,
  withOwner,
  withoutHold,
  withReviewBy,
} from '../lib/pool-holds';
import { LoadError, LoadingRows } from './page';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

type RowAction = { poolId: string; kind: 'revoke' | 'renew' | 'owner' };

/**
 * 整池暂停（#746，设置 engine.poolHolds）：人拍的临时停用账号池。每条带原因、谁拍的（原话加日期）、撤回条件、最迟复查日期、负责人；
 * 引擎选路、切号整池避开，探针探通、会话跑通都撤不掉它，只有这里撤；撤回、续期、改负责人要写原因，进操作记录。过了复查日期标红、不自动撤。
 * 负责人没写按「指挥官」。设置认不出的（缺字段、日期不对）引擎按暂停办，这里明说；还靠旧的 pool-hold 提醒顶着的列出来，提示迁成开关。
 */
export function PoolHoldsPanel() {
  const holds = usePoolHolds();
  const pools = usePools();
  const update = useUpdateSetting();
  const [draft, setDraft] = useState<HoldDraft>(EMPTY_DRAFT);
  const [action, setAction] = useState<RowAction | null>(null);
  const [reason, setReason] = useState('');
  const [renewDate, setRenewDate] = useState('');
  const [ownerDraft, setOwnerDraft] = useState('');
  const v = holds.data;

  const poolName = (id: string) => {
    const p = pools.data?.pools.find((x) => x.id === id);
    return p ? `${p.channelName}（${id}）` : id;
  };

  const save = (value: unknown, why: string | undefined, done: string, onDone?: () => void) => {
    if (!v) return;
    const check = SETTING_SCHEMAS['engine.poolHolds'].safeParse(value);
    if (!check.success) {
      toast.error('这个值不行', { description: check.error.issues[0]?.message ?? '不符合约定' });
      return;
    }
    update.mutate(
      {
        key: 'engine.poolHolds',
        body: { value: check.data, version: v.version, ...(why ? { reason: why } : {}) },
      },
      {
        onSuccess: () => {
          toast.success(done);
          onDone?.();
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

  const existing = v?.holds.map((h) => h.poolId) ?? [];
  const blocked = Boolean(v && (v.holdAll || v.problems.length > 0));
  const problem = draftProblem(draft, existing);
  const touched =
    draft.poolId !== '' ||
    draft.reason !== '' ||
    draft.decidedBy !== '' ||
    draft.revokeWhen !== '' ||
    draft.reviewBy !== '' ||
    draft.owner !== DEFAULT_POOL_HOLD_OWNER;
  const set = (k: keyof HoldDraft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const closeAction = () => {
    setAction(null);
    setReason('');
    setRenewDate('');
    setOwnerDraft('');
  };

  const reasonHint = (kind: RowAction['kind']) =>
    kind === 'revoke' ? '为什么现在能撤了' : kind === 'renew' ? '为什么到这个日期还要停' : '为什么换成这个人';

  const submitAction = () => {
    if (!v || !action) return;
    if (reason.trim() === '') {
      toast.error('要写原因', { description: reasonHint(action.kind) });
      return;
    }
    if (action.kind === 'revoke') {
      save(
        withoutHold(v.holds, action.poolId),
        reason.trim(),
        `已撤回：${poolName(action.poolId)}`,
        closeAction,
      );
    } else if (action.kind === 'renew') {
      save(
        withReviewBy(v.holds, action.poolId, renewDate),
        reason.trim(),
        `已续期：${poolName(action.poolId)}`,
        closeAction,
      );
    } else {
      save(
        withOwner(v.holds, action.poolId, ownerDraft),
        reason.trim(),
        `已改负责人：${poolName(action.poolId)}`,
        closeAction,
      );
    }
  };

  const row = (h: PoolHoldFactView) => {
    const words = reviewWords(h);
    const open = action?.poolId === h.poolId;
    return (
      <li key={h.poolId} className="px-4 py-3" data-testid={`hold-${h.poolId}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{poolName(h.poolId)}</span>
          {words ? (
            <span
              className="rounded-full bg-fail/10 px-2 py-0.5 text-xs font-medium text-ink-fail"
              role="alert"
            >
              {words}
            </span>
          ) : null}
          <span className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => {
                setOwnerDraft(h.owner);
                setAction({ poolId: h.poolId, kind: 'owner' });
              }}
            >
              改负责人
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => setAction({ poolId: h.poolId, kind: 'renew' })}
            >
              续期
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => setAction({ poolId: h.poolId, kind: 'revoke' })}
            >
              撤回
            </Button>
          </span>
        </div>
        <dl className="mt-1.5 grid grid-cols-auto-fr gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {/* 原标签列 auto、剩余 1fr，grid-cols-auto-fr */}
          <dt>为什么停</dt>
          <dd className="text-foreground">{h.reason}</dd>
          <dt>负责人</dt>
          <dd className="text-foreground">{h.owner}</dd>
          <dt>谁拍的</dt>
          <dd className="text-foreground">{h.decidedBy}</dd>
          <dt>撤回条件</dt>
          <dd className="text-foreground">{h.revokeWhen}</dd>
          <dt>最迟复查</dt>
          <dd className={words ? 'num font-medium text-ink-fail' : 'num text-foreground'}>
            {h.reviewBy}（北京时间）
          </dd>
        </dl>
        {open && action ? (
          <div className="mt-2 rounded-lg border bg-muted/30 p-3">
            {action.kind === 'renew' ? (
              <div className="mb-2 flex items-center gap-2">
                <Label htmlFor="hold-renew-date" className="text-xs">
                  新的最迟复查日期
                </Label>
                <Input
                  id="hold-renew-date"
                  type="date"
                  value={renewDate}
                  onChange={(e) => setRenewDate(e.target.value)}
                  className="num h-8 w-40"
                />
              </div>
            ) : null}
            {action.kind === 'owner' ? (
              <div className="mb-2 flex items-center gap-2">
                <Label htmlFor="hold-owner-edit" className="text-xs">
                  负责人
                </Label>
                <Input
                  id="hold-owner-edit"
                  value={ownerDraft}
                  onChange={(e) => setOwnerDraft(e.target.value)}
                  className="h-8 w-40"
                />
              </div>
            ) : null}
            <Label htmlFor="hold-action-reason" className="text-xs">
              {action.kind === 'revoke'
                ? '撤回原因（必填，进操作记录）'
                : action.kind === 'renew'
                  ? '续期原因（必填，进操作记录）'
                  : '改负责人的原因（必填，进操作记录）'}
            </Label>
            <Textarea
              id="hold-action-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 min-h-12"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={closeAction}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={
                  update.isPending ||
                  reason.trim() === '' ||
                  (action.kind === 'renew' && renewDate === '') ||
                  (action.kind === 'owner' && ownerDraft.trim() === '')
                }
                onClick={submitAction}
              >
                {action.kind === 'revoke'
                  ? '确认撤回'
                  : action.kind === 'renew'
                    ? '确认续期'
                    : '确认改负责人'}
              </Button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="rounded-xl border bg-card p-4 md:col-span-2" data-testid="pool-holds">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-medium">整池暂停</div>
        {v && holdsNeedAttention(v) ? (
          <span className="rounded-full bg-fail/10 px-2 py-0.5 text-xs font-medium text-ink-fail">
            要人看
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        临时停用一个账号池：选路不派、切号不切过去（在跑的不动）。每条要写清原因、谁拍的、撤回条件、最迟复查日期、负责人（没写按指挥官）。探针探通、会话跑通都撤不掉它，只有人在这里撤（要写原因）；过了复查日期会标红，但不会自动撤。
      </p>
      {holds.error ? <LoadError what="整池暂停" error={holds.error} /> : null}
      {!v && !holds.error ? <LoadingRows rows={1} /> : null}
      {v?.holdAll ? (
        <div
          className="mt-3 rounded-lg border border-fail/40 bg-fail/5 p-3 text-xs text-ink-fail"
          role="alert"
        >
          <p>{v.problems.find((p) => p.poolId === null)?.why ?? '整份设置认不出，所有账号池按暂停办'}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setAction({ poolId: '*', kind: 'revoke' })}
          >
            整份清空
          </Button>
          {action?.poolId === '*' ? (
            <div className="mt-2">
              <Label htmlFor="hold-clear-reason" className="text-xs">
                原因（必填，进操作记录）
              </Label>
              <Textarea
                id="hold-clear-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1 min-h-12"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={closeAction}>
                  取消
                </Button>
                <Button
                  size="sm"
                  disabled={update.isPending || reason.trim() === ''}
                  onClick={() => save({}, reason.trim(), '已清空整池暂停的设置', closeAction)}
                >
                  确认清空
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {v && !v.holdAll && v.problems.length > 0 ? (
        <div
          className="mt-3 rounded-lg border border-fail/40 bg-fail/5 p-3 text-xs text-ink-fail"
          role="alert"
        >
          <p className="font-medium">下面这些暂停认不出，引擎照样按暂停办（不当成能用）：</p>
          <ul className="mt-1 list-disc pl-4">
            {v.problems.map((p) => (
              <li key={p.poolId ?? 'all'}>{p.why}</li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={update.isPending}
            onClick={() => setAction({ poolId: '*bad', kind: 'revoke' })}
          >
            撤掉认不出的这几项
          </Button>
          {action?.poolId === '*bad' ? (
            <div className="mt-2">
              <Label htmlFor="hold-bad-reason" className="text-xs">
                原因（必填，进操作记录；撤掉后这些池就不再暂停）
              </Label>
              <Textarea
                id="hold-bad-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1 min-h-12"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={closeAction}>
                  取消
                </Button>
                <Button
                  size="sm"
                  disabled={update.isPending || reason.trim() === ''}
                  onClick={() => save(entriesOf(v.holds), reason.trim(), '已撤掉认不出的暂停', closeAction)}
                >
                  确认撤掉
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {v ? (
        v.holds.length === 0 && !v.holdAll && v.problems.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">现在没有整池暂停。</p>
        ) : (
          <ul className="mt-3 divide-y rounded-lg border empty:hidden">{v.holds.map(row)}</ul>
        )
      ) : null}
      {v?.legacyProblem ? (
        <p className="mt-3 text-xs text-ink-fail" role="alert">
          {`没读成旧的 pool-hold 提醒：${v.legacyProblem}（不当成没有）`}
        </p>
      ) : null}
      {v && v.legacy.length > 0 ? (
        <div
          className="mt-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs"
          data-testid="pool-holds-legacy"
        >
          <p className="font-medium text-foreground">请迁成开关：下面这些池还靠旧的 pool-hold 提醒顶着暂停</p>
          <p className="mt-0.5 text-muted-foreground">
            引擎照旧按它整池避开（兼容读法，只保留一版）。引擎自己写的（登录失效、封号这类）修好了会自己撤，不用管；如果是人拍的临时停用，要迁成上面的开关，否则探针探通或会话跑通会把它悄悄撤掉。
          </p>
          <ul className="mt-1.5 space-y-1">
            {v.legacy.map((l) => (
              <li key={l.poolId} className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{poolName(l.poolId)}</span>
                <span className="text-muted-foreground">{l.title}</span>
                {l.alsoSwitched ? (
                  <span className="text-muted-foreground">（已经有开关了，这条提醒多余）</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() =>
                      setDraft({
                        ...EMPTY_DRAFT,
                        poolId: l.poolId,
                        reason: l.title.replace(/^账号池 \S+ 整池暂停：/, ''),
                      })
                    }
                  >
                    迁成开关
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        className="mt-4 grid gap-2 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!v || blocked) return;
          const bad = draftProblem(draft, existing);
          if (bad) {
            toast.error('这条暂停还不能存', { description: bad });
            return;
          }
          save(withHold(v.holds, draft), undefined, `已暂停：${poolName(draft.poolId)}`, () =>
            setDraft(EMPTY_DRAFT),
          );
        }}
      >
        <div className="text-sm font-medium">新建一条整池暂停</div>
        {blocked ? (
          <p className="text-xs text-ink-fail">上面有认不出的暂停，先处理掉（撤掉或清空）再新建。</p>
        ) : null}
        <div className="grid gap-2 md:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="hold-pool" className="text-xs">
              哪个账号池
            </Label>
            <select
              id="hold-pool"
              value={draft.poolId}
              onChange={set('poolId')}
              className="h-9 max-md:min-h-10 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">选一个…</option>
              {(pools.data?.pools ?? [])
                .filter((p) => !existing.includes(p.id) || p.id === draft.poolId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {poolName(p.id)}
                  </option>
                ))}
              {draft.poolId && !pools.data?.pools.some((p) => p.id === draft.poolId) ? (
                <option value={draft.poolId}>{draft.poolId}</option>
              ) : null}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="hold-review" className="text-xs">
              最迟复查日期（北京时间）
            </Label>
            <Input
              id="hold-review"
              type="date"
              value={draft.reviewBy}
              onChange={set('reviewBy')}
              className="num h-9"
            />
          </div>
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="hold-owner" className="text-xs">
              负责人
            </Label>
            <Input id="hold-owner" value={draft.owner} onChange={set('owner')} className="h-9" />
          </div>
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="hold-reason" className="text-xs">
              为什么停
            </Label>
            <Input id="hold-reason" value={draft.reason} onChange={set('reason')} className="h-9" />
          </div>
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="hold-by" className="text-xs">
              谁拍的（原话加日期，例如「某某原话」2026-10-05）
            </Label>
            <Input id="hold-by" value={draft.decidedBy} onChange={set('decidedBy')} className="h-9" />
          </div>
          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="hold-when" className="text-xs">
              什么条件下撤
            </Label>
            <Input id="hold-when" value={draft.revokeWhen} onChange={set('revokeWhen')} className="h-9" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {problem && touched ? <span className="text-xs text-muted-foreground">{problem}</span> : null}
          <Button
            type="submit"
            size="sm"
            className="ml-auto"
            disabled={update.isPending || blocked || problem !== null}
          >
            暂停这个池
          </Button>
        </div>
      </form>
    </div>
  );
}
