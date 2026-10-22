// 额度页每个池一行的停用开关，和每个渠道组头上的整渠道暂停 / 放开。背后都是同一份 engine.poolHolds，不另开接口。
// 关的时候只写一句原因，复查日期可不填；整渠道是一次把这个渠道下的池一起写进去（带设置版本号，撞了就提示重来）。
// 引擎探到的封号、登录失效只在这一行标「封号」，不改开关，也不自动撤；整渠道放开同样碰不到它们，也碰不到认不出的项。
// 表里一行一个状态（#3533）：池的暂停状态（没查成 / 封号 / 该复查）由 usePoolFlag 给，表格的状态列用它顶掉窗口自己的状态；
// 开关和状态分开放：PoolSwitch 只有开关，原因写在池名下一行（PoolHoldNote）。
import { acceptPoolHoldsWrite } from '@fleet-dao/shared';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorText, usePoolHolds, useUpdateSetting } from '../api/client';
import {
  type ChannelHoldSummary,
  channelHoldSummary,
  entriesOf,
  legacyRowStatus,
  pauseProblem,
  poolSettingUnread,
  reviewWords,
  withoutHold,
  withoutHolds,
  withPause,
  withPauseMany,
} from '../lib/pool-holds';
import type { StatusKey } from '../theme/status-dict';
import { Button } from './layout/button';
import { Form, FormItem } from './layout/form';
import { Notice } from './layout/notice';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Switch } from './layout/switch';
import { Text } from './layout/text';
import { TextInput } from './layout/text-input';

/** 同一时间只开一张表单：单个池（kind = pool，id 是池编号）或整个渠道（kind = channel，id 是渠道编号）。 */
type OpenForm = { kind: 'pool' | 'channel'; id: string; mode: 'off' | 'on' };

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

/** 现在哪张表单开着（单个池或整渠道）；表格据此决定在哪一行下面摆表单。要在 PoolSwitchProvider 里用。 */
export function usePoolSwitchOpen(): OpenForm | null {
  return useSwitchCtx().open;
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
    <Stack gap="sm">
      {v.holdAll ? (
        <Notice
          tone="stall"
          title="暂停设置没查成"
          action={
            <Button variant="secondary" size="xs" onClick={() => setOpen((x) => !x)}>
              清空这份设置
            </Button>
          }
        >
          整份认不出，引擎对所有池按暂停办；下面的开关先不能动。写上原因后清空，池就都打开。认不出的内容留不下来。
          {open ? (
            <Form aria-label="清空暂停设置">
              <FormItem label="原因" required htmlFor="pool-hold-clear-reason" layout="vertical">
                <TextInput
                  id="pool-hold-clear-reason"
                  aria-label="原因"
                  value={reason}
                  onChange={setReason}
                  placeholder="比如：认不出的那份作废"
                />
              </FormItem>
              <Stack direction="horizontal" gap="sm">
                <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  loading={update.isPending}
                  {...(problem !== null ? { disabledReason: problem } : {})}
                  onClick={clear}
                >
                  确认清空
                </Button>
              </Stack>
            </Form>
          ) : null}
        </Notice>
      ) : null}
      {v.legacyProblem ? (
        <span data-pool-legacy-unreadable>
          <Text size="meta" tone="warning">
            封号这些提醒没读成：{v.legacyProblem}。这一行没标不代表没有。
          </Text>
        </span>
      ) : null}
    </Stack>
  );
}

/** 一个池的暂停状态：给表格状态列用的字典键、给 data-pool-flag 的短字、悬停说明。 */
export interface PoolFlagInfo {
  status: StatusKey;
  label: string;
  title: string;
}

function rowFlag(poolId: string, holds: ReturnType<typeof usePoolHolds>): PoolFlagInfo | null {
  const v = holds.data;
  const error = Boolean(holds.error);
  if (!v && !error) return null;
  if (poolSettingUnread(v, error, poolId)) {
    return { status: 'quota:quota:fetch-failed', label: '没查成', title: '暂停设置没查成，引擎按暂停办' };
  }
  const legacy = v?.legacy.find((l) => l.poolId === poolId);
  if (legacy) {
    const label = legacyRowStatus(legacy.title);
    return {
      status: label === '封号' ? 'route:pool:ban' : 'quota:quota:hold-other',
      label,
      title: legacy.title,
    };
  }
  const hold = v?.holds.find((h) => h.poolId === poolId);
  const words = hold ? reviewWords(hold) : null;
  if (hold && words) {
    return { status: 'quota:quota:hold-review', label: words, title: `${hold.reason}。${words}` };
  }
  return null;
}

/** 这个池的暂停状态（没查成 / 封号 / 该复查）；没有就是 null。 */
export function usePoolFlag(poolId: string): PoolFlagInfo | null {
  return rowFlag(poolId, usePoolHolds());
}

/** 状态列里画的那一个状态。 */
export function PoolFlagBadge({ flag }: { flag: PoolFlagInfo }) {
  return (
    <span data-pool-flag={flag.label} title={flag.title}>
      <StatusBadge status={flag.status} />
    </span>
  );
}

/** 池名下一行灰字：停用的原因和复查日期。没停用就没有。 */
export function PoolHoldNote({ poolId }: { poolId: string }) {
  const holds = usePoolHolds();
  const hold = holds.data?.holds.find((h) => h.poolId === poolId);
  if (!hold) return null;
  const words = reviewWords(hold);
  const text = `已停用：${hold.reason}${hold.reviewBy ? `　复查 ${hold.reviewBy}` : ''}${words ? `　${words}` : ''}`;
  return (
    <span data-pool-hold-note title={text}>
      <Text size="meta" tone="muted" truncate>
        {text}
      </Text>
    </span>
  );
}

/** 表里「启用」那一格的开关。开关不跟着引擎的封号动。 */
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
    if (open?.kind === 'pool' && open.id === poolId) setOpen(null);
    else setOpen({ kind: 'pool', id: poolId, mode: checked ? 'off' : 'on' });
  };
  return (
    <Switch
      size="sm"
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={`${poolId} 的开关`}
      onCheckedChange={toggle}
    />
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

/** 点开关后在这个池下面展开的原因。确认之前开关不动。 */
export function PoolSwitchForm({ poolId }: { poolId: string }) {
  const holds = usePoolHolds();
  const { open, setOpen, update } = useSwitchCtx();
  const [reason, setReason] = useState('');
  const [reviewBy, setReviewBy] = useState('');
  const v = holds.data;
  if (!v || open?.kind !== 'pool' || open.id !== poolId) return null;
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
    <HoldFields
      idBase={poolId}
      label={`${poolId} 的停用`}
      mode={mode}
      reason={reason}
      reviewBy={reviewBy}
      onReason={setReason}
      onReviewBy={setReviewBy}
      pending={update.isPending}
      problem={problem}
      confirmText={mode === 'off' ? '确认停用' : '确认打开'}
      onCancel={close}
      onConfirm={confirm}
      help={mode === 'off' ? `只停 ${poolId}，其余池不动。` : `只放开 ${poolId}，其余池不动。`}
    >
      {mode === 'off' && kept.length > 0 ? (
        <Text size="meta" tone="warning">
          {`${kept.join('、')} 的暂停认不出，这次会原样留着，不会放开。`}
        </Text>
      ) : null}
      {mode === 'on' && bad.length > 0 ? (
        <Text size="meta" tone="warning">
          {`认不出的有 ${bad.join('、')}。这次只动 ${poolId}，别的认不出的暂停原样留着。引擎现在仍按暂停办。`}
        </Text>
      ) : null}
    </HoldFields>
  );
}

/** 单个池和整个渠道共用的一张表单：原因必填，复查日期只在暂停时问、可不填；children 放这次动作的提示。 */
function HoldFields({
  idBase,
  label,
  mode,
  reason,
  reviewBy,
  onReason,
  onReviewBy,
  pending,
  problem,
  confirmText,
  onCancel,
  onConfirm,
  help,
  children,
}: {
  idBase: string;
  label: string;
  mode: 'off' | 'on';
  reason: string;
  reviewBy: string;
  onReason: (v: string) => void;
  onReviewBy: (v: string) => void;
  pending: boolean;
  /** 现在不能确认的原因；null = 能确认。 */
  problem: string | null;
  confirmText: string;
  onCancel: () => void;
  onConfirm: () => void;
  help?: ReactNode;
  children?: ReactNode;
}) {
  const reasonLabel = mode === 'off' ? '原因' : '为什么现在能开';
  const reviewLabel = '复查日期（可不填）';
  return (
    <Form aria-label={label}>
      {children}
      <FormItem label={reasonLabel} required htmlFor={`pool-hold-reason-${idBase}`} help={help}>
        <TextInput
          id={`pool-hold-reason-${idBase}`}
          aria-label={reasonLabel}
          value={reason}
          placeholder={mode === 'off' ? '比如：被封号' : '比如：号已解开'}
          onChange={onReason}
        />
      </FormItem>
      {mode === 'off' ? (
        <FormItem
          label={reviewLabel}
          htmlFor={`pool-hold-review-${idBase}`}
          help="确认前开关和暂停状态都不会动。"
        >
          <TextInput
            id={`pool-hold-review-${idBase}`}
            aria-label={reviewLabel}
            value={reviewBy}
            placeholder="YYYY-MM-DD，不填就不提醒"
            onChange={onReviewBy}
          />
        </FormItem>
      ) : null}
      <Stack direction="horizontal" gap="sm">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="outline"
          size="sm"
          loading={pending}
          {...(problem !== null ? { disabledReason: problem } : {})}
          onClick={onConfirm}
        >
          {confirmText}
        </Button>
      </Stack>
    </Form>
  );
}

const channelBlockedTitle = (loading: boolean, error: boolean): string =>
  loading && !error ? '正在读暂停设置' : '暂停设置没查成，引擎按暂停办，整渠道的暂停和放开先不能动';

/**
 * 渠道组头上的整渠道暂停 / 放开（同一份 engine.poolHolds，一次写这个渠道下所有池）。
 * 全开：只有「全部暂停」；全停：只有「全部放开」；混合：「暂停其余」「放开已停」两个都有，各只动自己那一半。
 * 暂停设置没读成、整份认不出时按钮在、但点不了（和池开关同一个道理：不拿看不懂的整份去算该写什么）。
 */
export function ChannelHoldControls({
  channelId,
  poolIds,
}: {
  channelId: string;
  poolIds: readonly string[];
}) {
  const holds = usePoolHolds();
  const { open, setOpen, update } = useSwitchCtx();
  const v = holds.data;
  const error = Boolean(holds.error);
  const blocked = !v || error || Boolean(v.holdAll);
  const s = v && !blocked ? channelHoldSummary(v, poolIds) : null;
  const toggle = (mode: 'off' | 'on') => () => {
    if (open?.kind === 'channel' && open.id === channelId && open.mode === mode) setOpen(null);
    else setOpen({ kind: 'channel', id: channelId, mode });
  };
  const pauseWord = s && s.free.length === s.poolIds.length ? '全部暂停' : '暂停其余';
  const resumeWord = s && s.held.length === s.poolIds.length ? '全部放开' : '放开已停';
  const showPause = !s || s.free.length > 0;
  const showResume = !s || s.held.length > 0;
  const blockedTitle = channelBlockedTitle(!v, error);
  const stopped = blocked ? blockedTitle : update.isPending ? '正在保存，等一下' : undefined;
  return (
    <span data-channel-controls={channelId}>
      <Stack direction="horizontal" gap="sm" align="center">
        {s && s.state !== 'on' ? (
          <span
            data-channel-hold-state={s.state}
            title={`${s.held.length + s.opaque.length}/${s.poolIds.length} 个池停着`}
          >
            <Text size="meta" tone="muted">
              {s.state === 'paused'
                ? '全部已停'
                : `已停 ${s.held.length + s.opaque.length}/${s.poolIds.length}`}
            </Text>
          </span>
        ) : null}
        {showPause ? (
          <Button
            variant="text"
            size="xs"
            {...(stopped !== undefined
              ? { disabledReason: stopped }
              : { title: `给这个渠道下还开着的 ${s?.free.length} 个池写暂停` })}
            data-testid={`channel-pause-${channelId}`}
            onClick={toggle('off')}
          >
            {pauseWord}
          </Button>
        ) : null}
        {showResume ? (
          <Button
            variant="text"
            size="xs"
            {...(stopped !== undefined
              ? { disabledReason: stopped }
              : { title: `撤掉这个渠道下 ${s?.held.length} 个池的暂停` })}
            data-testid={`channel-resume-${channelId}`}
            onClick={toggle('on')}
          >
            {resumeWord}
          </Button>
        ) : null}
      </Stack>
    </span>
  );
}

const joinIds = (ids: readonly string[]): string => ids.join('、');

/** 整渠道暂停 / 放开展开的原因表单：渠道组头下面。预览写明会动哪几个池、哪几个原样不动；确认前什么都不写。 */
export function ChannelHoldForm({
  channelId,
  channelName,
  poolIds,
}: {
  channelId: string;
  channelName: string;
  poolIds: readonly string[];
}) {
  const holds = usePoolHolds();
  const { open, setOpen, update } = useSwitchCtx();
  const [reason, setReason] = useState('');
  const [reviewBy, setReviewBy] = useState('');
  const v = holds.data;
  if (!v || open?.kind !== 'channel' || open.id !== channelId) return null;
  const mode = open.mode;
  const s = channelHoldSummary(v, poolIds);
  const targets = mode === 'off' ? s.free : s.held;
  const problem = v.holdAll
    ? '暂停设置整份认不出，先清空这份设置'
    : targets.length === 0
      ? mode === 'off'
        ? '这个渠道已经没有可暂停的池'
        : '这个渠道已经没有可放开的池'
      : mode === 'off'
        ? pauseProblem(reason, reviewBy)
        : reason.trim() === ''
          ? '先写一句原因'
          : null;
  const before = { ...v.opaque, ...entriesOf(v.holds) };
  const close = () => {
    setOpen(null);
    setReason('');
    setReviewBy('');
  };
  const confirm = () => {
    if (problem) return;
    const done = `${mode === 'off' ? '已暂停' : '已放开'} ${channelName}：${targets.length} 个池`;
    saveHold(
      update,
      v.version,
      mode === 'off'
        ? withPauseMany(v.holds, targets, { reason, reviewBy }, v.opaque)
        : withoutHolds(v.holds, targets, v.opaque),
      before,
      reason.trim(),
      done,
      close,
    );
  };
  return (
    <div data-channel-form={channelId}>
      <HoldFields
        idBase={`channel-${channelId}`}
        label={`${channelName} 的整渠道${mode === 'off' ? '暂停' : '放开'}`}
        mode={mode}
        reason={reason}
        reviewBy={reviewBy}
        onReason={setReason}
        onReviewBy={setReviewBy}
        pending={update.isPending}
        problem={problem}
        confirmText={mode === 'off' ? '确认暂停整渠道' : '确认放开整渠道'}
        onCancel={close}
        onConfirm={confirm}
      >
        <ChannelPreview mode={mode} s={s} />
      </HoldFields>
    </div>
  );
}

function ChannelPreview({ mode, s }: { mode: 'off' | 'on'; s: ChannelHoldSummary }) {
  const targets = mode === 'off' ? s.free : s.held;
  return (
    <div data-channel-preview>
      <Stack gap="sm">
        <Text size="meta" tone="secondary" as="p">
          {targets.length === 0
            ? mode === 'off'
              ? '这个渠道下没有还开着的池。'
              : '这个渠道下没有认得出的暂停可放开。'
            : `${mode === 'off' ? '将暂停' : '将放开'} ${targets.length} 个池：${joinIds(targets)}。`}
        </Text>
        {mode === 'off' && s.held.length > 0 ? (
          <Text
            size="meta"
            tone="secondary"
            as="p"
          >{`已经停着的 ${joinIds(s.held)} 原样不动（原因、复查日期保留）。`}</Text>
        ) : null}
        {s.opaque.length > 0 ? (
          <Text size="meta" tone="warning" as="p">
            {`${joinIds(s.opaque)} 的暂停认不出，原样留着，不会放开；引擎仍按暂停办。`}
          </Text>
        ) : null}
        {mode === 'on' && s.legacy.length > 0 ? (
          <Text
            size="meta"
            tone="warning"
            as="p"
          >{`${joinIds(s.legacy)} 还挂着引擎探到的封号等提醒，不会因此解除。`}</Text>
        ) : null}
        <Text size="meta" tone="secondary" as="p">
          别的渠道的池不动。
        </Text>
      </Stack>
    </div>
  );
}
