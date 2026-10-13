// 额度页每个池一行的停用开关。背后仍是 engine.poolHolds。关的时候只写一句原因，复查日期可不填。
// 引擎探到的封号、登录失效只在这一行标「封号」，不改开关，也不自动撤。
import { acceptPoolHoldsWrite } from '@fleet-dao/shared';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorText, usePoolHolds, useUpdateSetting } from '../api/client';
import {
  entriesOf,
  legacyRowStatus,
  pauseProblem,
  poolSettingUnread,
  reviewWords,
  withoutHold,
  withPause,
} from '../lib/pool-holds';
import { Notice } from './layout/notice';
import { StatusBadge } from './layout/status-badge';
import type { LayoutTone } from './layout/tone';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';

type OpenForm = { poolId: string; mode: 'off' | 'on' };

interface SwitchCtx {
  open: OpenForm | null;
  setOpen: (next: OpenForm | null) => void;
  update: ReturnType<typeof useUpdateSetting>;
}

const Ctx = createContext<SwitchCtx | null>(null);

/** 整张额度表共用一份「正在改哪一行」，避免两行表单一起开。 */
export function PoolSwitchProvider({ children }: { children: ReactNode }) {
  const update = useUpdateSetting();
  const [open, setOpen] = useState<OpenForm | null>(null);
  return <Ctx.Provider value={{ open, setOpen, update }}>{children}</Ctx.Provider>;
}

function useSwitchCtx(): SwitchCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('停用开关要包在 PoolSwitchProvider 里');
  return v;
}

function saveHold(
  update: SwitchCtx['update'],
  version: number,
  value: unknown,
  before: unknown,
  why: string,
  done: string,
  onDone: () => void,
) {
  // before 是这一页看到的原值（含认不出的项）。新写的必须过格式；认不出的原样没改才收。
  const check = acceptPoolHoldsWrite(before, value);
  if (!check.ok) {
    toast.error('这个值不行', { description: check.message });
    return;
  }
  update.mutate(
    { key: 'engine.poolHolds', body: { value: check.value, version, reason: why } },
    {
      onSuccess: () => {
        toast.success(done);
        onDone();
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
}

/** 整份认不出时，额度页上的一条清空（要写原因）。某一项认不出不走这里。 */
export function PoolHoldBanner() {
  const holds = usePoolHolds();
  const update = useUpdateSetting();
  const v = holds.data;
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  if (!v?.holdAll && !v?.legacyProblem) return null;
  const problem = reason.trim() === '' ? '先写一句原因' : null;
  const clear = () => {
    if (!v || problem) return;
    saveHold(update, v.version, {}, null, reason.trim(), '已清空整池暂停的设置', () => {
      setOpen(false);
      setReason('');
    });
  };
  return (
    <div className="mb-3 space-y-2">
      {v.holdAll ? (
        <Notice
          tone="fail"
          title="暂停设置没查成"
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen((x) => !x)}>
              清空这份设置
            </Button>
          }
        >
          整份认不出，引擎对所有池按暂停办。写上原因后清空，池就都打开。认不出的内容留不下来。
          {open ? (
            <div className="mt-2 flex flex-col gap-2">
              <Label htmlFor="pool-hold-clear-reason">原因</Label>
              <Input
                id="pool-hold-clear-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="比如：认不出的那份作废"
              />
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  loading={update.isPending}
                  disabled={update.isPending || problem !== null}
                  onClick={clear}
                >
                  确认清空
                </Button>
              </div>
            </div>
          ) : null}
        </Notice>
      ) : null}
      {v.legacyProblem ? (
        <p data-pool-legacy-unreadable className="text-meta text-ink-stall">
          封号这些提醒没读成：{v.legacyProblem}。这一行没标不代表没有。
        </p>
      ) : null}
    </div>
  );
}

function rowFlag(
  poolId: string,
  holds: ReturnType<typeof usePoolHolds>,
): { label: string; tone: LayoutTone; title: string } | null {
  const v = holds.data;
  const error = Boolean(holds.error);
  if (!v && !error) return null;
  if (poolSettingUnread(v, error, poolId)) {
    return { label: '没查成', tone: 'stall', title: '暂停设置没查成，引擎按暂停办' };
  }
  const legacy = v?.legacy.find((l) => l.poolId === poolId);
  if (legacy) {
    const label = legacyRowStatus(legacy.title);
    return {
      label,
      tone: label === '封号' ? 'fail' : 'stall',
      title: legacy.title,
    };
  }
  const hold = v?.holds.find((h) => h.poolId === poolId);
  const words = hold ? reviewWords(hold) : null;
  if (hold && words) return { label: words, tone: 'fail', title: `${hold.reason}。${words}` };
  return null;
}

/** 池名旁边：一个状态（没查成 / 封号 / 到期）和开关。开关不跟着引擎的封号动。 */
export function PoolSwitch({ poolId }: { poolId: string }) {
  const holds = usePoolHolds();
  const { open, setOpen, update } = useSwitchCtx();
  const v = holds.data;
  const recognized = v?.holds.find((h) => h.poolId === poolId);
  const unread = poolSettingUnread(v, Boolean(holds.error), poolId);
  const checked = !v ? !holds.error : !unread && !recognized;
  const disabled = !v || Boolean(holds.error) || Boolean(v.holdAll) || update.isPending;
  const flag = rowFlag(poolId, holds);
  const ban = flag?.label === '封号';
  const title = switchTitle({
    loading: !v && !holds.error,
    error: Boolean(holds.error),
    holdAll: Boolean(v?.holdAll),
    ban,
    reason: recognized?.reason,
    overdue: recognized ? reviewWords(recognized) : null,
    problem: Boolean(v?.problems.some((p) => p.poolId === poolId)),
    on: checked,
  });
  const toggle = () => {
    if (disabled) return;
    if (open?.poolId === poolId) setOpen(null);
    else setOpen({ poolId, mode: checked ? 'off' : 'on' });
  };
  return (
    <>
      {flag ? (
        <span data-pool-flag={flag.label} title={flag.title} className="shrink-0">
          <StatusBadge tone={flag.tone} label={flag.label} variant="dot" />
        </span>
      ) : null}
      {recognized && !flag ? (
        <span className="min-w-0 truncate text-meta text-muted-foreground" title={recognized.reason}>
          {recognized.reason}
        </span>
      ) : null}
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        title={title}
        aria-label={`${poolId} 的开关`}
        data-testid={`pool-switch-${poolId}`}
        onCheckedChange={toggle}
      />
    </>
  );
}

function switchTitle(s: {
  loading: boolean;
  error: boolean;
  holdAll: boolean;
  ban: boolean;
  reason: string | undefined;
  overdue: string | null;
  problem: boolean;
  on: boolean;
}): string {
  if (s.loading) return '正在读暂停设置';
  if (s.error || s.holdAll) return '暂停设置没查成，引擎按暂停办';
  const parts: string[] = [];
  if (s.ban) parts.push(s.on ? '引擎探到封号，开关仍由你开着' : '引擎探到封号');
  if (s.reason) parts.push(`已停：${s.reason}`);
  if (s.overdue) parts.push(s.overdue);
  if (s.problem) parts.push('这个池的暂停认不出，引擎按暂停办');
  if (s.on && !s.ban) parts.push('这个池在用。关掉要写一句原因');
  return parts.join('。');
}

/** 点开关后在同一行下面展开的原因。确认之前开关不动。 */
export function PoolSwitchForm({ poolId }: { poolId: string }) {
  const holds = usePoolHolds();
  const { open, setOpen, update } = useSwitchCtx();
  const [reason, setReason] = useState('');
  const [reviewBy, setReviewBy] = useState('');
  const v = holds.data;
  if (!v || open?.poolId !== poolId) return null;
  const mode = open.mode;
  const offProblem = pauseProblem(reason, reviewBy);
  const onProblem = reason.trim() === '' ? '先写一句原因' : null;
  const problem = mode === 'off' ? offProblem : onProblem;
  const bad = v.problems.map((p) => p.poolId ?? '整份');
  const kept = v.problems.flatMap((p) => (p.poolId && p.poolId !== poolId ? [p.poolId] : []));
  const before = { ...v.opaque, ...entriesOf(v.holds) };
  const close = () => {
    setOpen(null);
    setReason('');
    setReviewBy('');
  };
  const confirm = () => {
    if (problem) return;
    if (mode === 'off') {
      saveHold(
        update,
        v.version,
        withPause(v.holds, poolId, { reason, reviewBy }, v.opaque),
        before,
        reason.trim(),
        `已停用：${poolId}`,
        close,
      );
      return;
    }
    saveHold(
      update,
      v.version,
      withoutHold(v.holds, poolId, v.opaque),
      before,
      reason.trim(),
      `已打开：${poolId}`,
      close,
    );
  };
  return (
    <td className="quota-hold-form">
      <fieldset
        className="mt-2 flex min-w-0 max-w-lg flex-col gap-2 rounded-lg border-0 bg-muted p-3"
        aria-label={`${poolId} 的停用`}
      >
        {mode === 'off' && kept.length > 0 ? (
          <p className="text-meta text-ink-stall">
            {`${kept.join('、')} 的暂停认不出，这次会原样留着，不会放开。`}
          </p>
        ) : null}
        {mode === 'on' && bad.length > 0 ? (
          <p className="text-meta text-ink-stall">
            {`认不出的有 ${bad.join('、')}。这次只动 ${poolId}，别的认不出的暂停原样留着。引擎现在仍按暂停办。`}
          </p>
        ) : null}
        <Label htmlFor={`pool-hold-reason-${poolId}`}>{mode === 'off' ? '原因' : '为什么现在能开'}</Label>
        <Input
          id={`pool-hold-reason-${poolId}`}
          value={reason}
          placeholder={mode === 'off' ? '比如：被封号' : '比如：号已解开'}
          onChange={(e) => setReason(e.target.value)}
        />
        {mode === 'off' ? (
          <>
            <Label htmlFor={`pool-hold-review-${poolId}`}>复查日期（可不填）</Label>
            <Input
              id={`pool-hold-review-${poolId}`}
              value={reviewBy}
              placeholder="YYYY-MM-DD，不填就不提醒"
              onChange={(e) => setReviewBy(e.target.value)}
            />
          </>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={close}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            loading={update.isPending}
            disabled={update.isPending || problem !== null}
            onClick={confirm}
          >
            {mode === 'off' ? '确认停用' : '确认打开'}
          </Button>
        </div>
      </fieldset>
    </td>
  );
}
