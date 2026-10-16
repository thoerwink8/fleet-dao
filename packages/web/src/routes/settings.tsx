import { type QuotaWindowKind, quotaWindowName, SETTING_SCHEMAS } from '@fleet-dao/shared';
import type { LucideIcon } from 'lucide-react';
import { BellRing, Check, FolderGit2, Info, KeyRound, Palette, SlidersHorizontal } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { brand } from '#brand';
import {
  ApiError,
  errorText,
  useApi,
  useAudit,
  useMe,
  usePools,
  useRepoCiPolicy,
  useRepoDispatch,
  useSettings,
  useUpdateSetting,
} from '../api/client';
import type { Me, Setting, SettingKey } from '../api/types';
import { CredentialsSection } from '../components/credentials-section';
import { EngineMasterRelation } from '../components/engine-master';
import { FlowModeSetting } from '../components/flow-mode-setting';
import { EmptyState } from '../components/layout/empty-state';
import { FieldGroup, FieldRow } from '../components/layout/field-row';
import { FilterTabs } from '../components/layout/filter-tabs';
import { KeyValue } from '../components/layout/key-value';
import { List, RowDetail } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { DescriptionHint, Page } from '../components/layout/page';
import { SaveButton } from '../components/layout/save-button';
import { Section } from '../components/layout/section';
import { StatusDot } from '../components/layout/status-badge';
import { PageNav } from '../components/page-nav';
import { PwaStatus } from '../components/pwa-status';
import { RepoCiPolicyControl } from '../components/repo-ci-policy';
import { useRepo } from '../components/repo-context';
import { RepoRow } from '../components/repo-groom';
import { RepoImportSection } from '../components/repo-import';
import { ModeSwitch } from '../components/shell/topbar';
import { useTheme } from '../components/theme-provider';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { actorName, settingLabel } from '../lib/audit';
import { poolTitle, windowLabel } from '../lib/catalog';
import { formatAgo, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import {
  parseReserveInput,
  reserveInputText,
  reserveKindsFor,
  reserveSource,
  UNLIMITED_WORD,
} from '../lib/reserve';
import { isMine, TONES, toneLabel } from '../lib/status';
import { type DensityPref, PALETTES } from '../lib/theme';
import { cn } from '../lib/utils';

const DENSITY_ITEMS: { id: DensityPref; label: string }[] = [
  { id: 'comfortable', label: '标准' },
  { id: 'compact', label: '紧凑' },
];

/** 设置行里的「谁改的」：去 user: 前缀，方便和 /me、操作记录对上。 */
function settingActorId(raw: string): string {
  return raw.startsWith('user:') ? raw.slice('user:'.length) : raw;
}

/**
 * 设置项「谁改的」展示：是自己写「我」；操作记录里能对上人名就用人名；
 * 引擎等认得出的代号翻成人话；否则缩短 uuid，悬停给全文。
 */
function whoChangedLabel(
  updatedBy: string,
  me: Me | undefined,
  names: ReadonlyMap<string, string>,
): { text: string; title?: string } {
  const id = settingActorId(updatedBy);
  if (isMine(id, me) || isMine(updatedBy, me)) return { text: '我' };
  const fromAudit = names.get(id) ?? names.get(updatedBy);
  if (fromAudit) return { text: fromAudit };
  const fromCode = actorName({ kind: 'user', id }, me);
  if (fromCode !== id && fromCode !== '我') return { text: fromCode };
  const engine = actorName({ kind: 'engine', id }, me);
  if (engine !== id) return { text: engine };
  if (id.length > 12) return { text: `${id.slice(0, 8)}…`, title: id };
  if (id !== updatedBy) return { text: id, title: updatedBy };
  return { text: id };
}

/** 从已加载的操作记录里抠用户编号 → 人名，给设置项「谁改的」用。 */
function useActorNames(): Map<string, string> {
  const audit = useAudit();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const page of audit.data?.pages ?? []) {
      for (const e of page.items) {
        if (e.actor.kind !== 'user' || !e.actor.name) continue;
        m.set(e.actor.id, e.actor.name);
        m.set(settingActorId(e.actor.id), e.actor.name);
      }
    }
    return m;
  }, [audit.data]);
}

export function meta() {
  return [{ title: brand.title('设置') }];
}

/** 一节：标题下一句说明，下面是这一节的字段。页内导航按 id 跳到这里（吸顶条下面留出位置）。 */
function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Section
      id={id}
      variant="plain"
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {title}
        </span>
      }
      // 说明一行不折（#1917，照路由页样板）：放不下截断，整句在悬停里
      description={
        <span data-section-note className="block truncate whitespace-nowrap" title={description}>
          {description}
        </span>
      }
      className="scroll-mt-14 border-b py-6 first:pt-0 last:border-b-0 lg:scroll-mt-6"
    >
      {children}
    </Section>
  );
}

/** 这项设置是谁、什么时候改的；没设过就说用默认。 */
function SettingMeta({ s }: { s: Setting | undefined }) {
  const now = useNow();
  const { data: me } = useMe();
  const names = useActorNames();
  if (!s || s.version === 0)
    return <p className="mt-0.5 text-meta text-muted-foreground">还没设过，用的是默认值</p>;
  const who = s.updatedBy ? whoChangedLabel(s.updatedBy, me, names) : null;
  return (
    <p className="mt-0.5 text-meta text-muted-foreground">
      第 <span className="num">{s.version}</span> 版
      {who ? (
        <>
          {' '}
          · <span title={who.title}>{who.text}</span>
        </>
      ) : null}
      {s.updatedAt ? (
        <>
          {' '}
          · <span className="num">{formatAgo(s.updatedAt, now)}</span>改的
        </>
      ) : null}
    </p>
  );
}

/** zod 的校验说明是英文，常见的几种翻成白话；约定里自带中文说明的（如「格式是 HH:MM」）原样用。 */
function issueText(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return '不符合约定';
  if (issue.code === 'too_big') return `最多 ${String(issue.maximum)}`;
  if (issue.code === 'too_small') return `最少 ${String(issue.minimum)}`;
  if (issue.code === 'invalid_type') return '格式不对';
  return issue.message;
}

/** 保存一项设置：带上改之前看到的版本号，别人先改了就 409，刷新后再改。 */
function useSaveSetting() {
  const update = useUpdateSetting();
  const save = (key: SettingKey, value: unknown, s: Setting | undefined, onDone?: () => void) => {
    const schema: z.ZodType = SETTING_SCHEMAS[key];
    const check = schema.safeParse(value);
    if (!check.success) {
      toast.error('这个值不行', { description: issueText(check.error.issues[0]) });
      return;
    }
    update.mutate(
      { key, body: { value: check.data, version: s?.version ?? 0 } },
      {
        onSuccess: () => {
          toast.success(`已保存：${settingLabel[key]}`);
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
  return { save, pending: update.isPending };
}

function NumberSetting({
  k,
  s,
  hint,
  unit,
  placeholder,
}: {
  k: 'sessions.maxConcurrent' | 'judge.dailyCallLimit';
  s: Setting | undefined;
  hint: string;
  unit: string;
  placeholder: string;
}) {
  const current = SETTING_SCHEMAS[k].safeParse(s?.value);
  const shown = current.success ? String(current.data) : '';
  const [draft, setDraft] = useState(shown);
  const { save, pending } = useSaveSetting();
  // 服务端的值变了（自己保存成功、别人改了）就跟上。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟版本号走，不跟着输入框重置。
  useEffect(() => setDraft(shown), [s?.version]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() === '') return;
    save(k, Number(draft), s);
  };
  const id = `setting-${k}`;
  return (
    <FieldRow
      onSubmit={submit}
      label={settingLabel[k]}
      htmlFor={id}
      hint={
        <>
          {hint}
          <SettingMeta s={s} />
        </>
      }
    >
      <Input
        id={id}
        inputMode="numeric"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        className="num h-8 w-28"
      />
      <span className="text-body text-muted-foreground">{unit}</span>
      <SaveButton canSave={draft !== shown && draft !== ''} pending={pending} />
    </FieldRow>
  );
}

function QuietHours({ s }: { s: Setting | undefined }) {
  const current = SETTING_SCHEMAS['notify.quietHours'].safeParse(s?.value);
  const value = current.success ? current.data : null;
  const [on, setOn] = useState(Boolean(value));
  const [start, setStart] = useState(value?.start ?? '23:00');
  const [end, setEnd] = useState(value?.end ?? '08:00');
  const { save, pending } = useSaveSetting();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在服务端版本变化时同步。
  useEffect(() => {
    setOn(Boolean(value));
    if (value) {
      setStart(value.start);
      setEnd(value.end);
    }
  }, [s?.version]);
  const dirty = on !== Boolean(value) || (on && (start !== value?.start || end !== value?.end));
  return (
    <FieldRow
      onSubmit={(e) => {
        e.preventDefault();
        save('notify.quietHours', on ? { start, end } : null, s);
      }}
      label={settingLabel['notify.quietHours']}
      hint={
        <>
          北京时间。免打扰时段里飞书不响；{brand.product}里照常能看到。
          <SettingMeta s={s} />
        </>
      }
    >
      <Switch checked={on} onCheckedChange={setOn} aria-label="开免打扰时段" />
      <Input
        type="time"
        value={start}
        disabled={!on}
        onChange={(e) => setStart(e.target.value)}
        className="num h-8 w-28"
        aria-label="免打扰开始"
      />
      <span className="text-muted-foreground">到</span>
      <Input
        type="time"
        value={end}
        disabled={!on}
        onChange={(e) => setEnd(e.target.value)}
        className="num h-8 w-28"
        aria-label="免打扰结束"
      />
      <SaveButton canSave={dirty} pending={pending} />
    </FieldRow>
  );
}

/** 引擎暂不用独享（#194 方案 4.8）：创始人自己要大用独享时一键叫停引擎这一路；开关一拨就存，带版本号、进操作记录。 */
function SoloPaused({ s }: { s: Setting | undefined }) {
  const current = SETTING_SCHEMAS['engine.soloPaused'].safeParse(s?.value);
  const on = current.success ? current.data : false;
  const { save, pending } = useSaveSetting();
  return (
    <FieldRow
      onSubmit={(e) => e.preventDefault()}
      formLabel={settingLabel['engine.soloPaused']}
      label={settingLabel['engine.soloPaused']}
      hint={
        <>
          {`开着时：${brand.terms.carpool}用不了（额度用满、整辆车被用光）也不自动切到${brand.terms.solo}，Claude 的活等${brand.terms.carpool}恢复或交给别家模型。已经挂着${brand.terms.solo}的不受影响，${brand.terms.carpool}恢复照常切回。`}
          <SettingMeta s={s} />
        </>
      }
    >
      <Switch
        checked={on}
        disabled={pending}
        onCheckedChange={(next) => save('engine.soloPaused', next, s)}
        aria-label={settingLabel['engine.soloPaused']}
      />
    </FieldRow>
  );
}

/**
 * 留量线一行的窗口名。other →「其他窗口」；7d_model 没有组名时不要把字段名漏出来（「7d_model 周额度」），
 * 写成「单模型周额度」；这个池的读数带了组名就写在后面。别的窗口沿用 quotaWindowName，名字不变。
 */
function reserveKindLabel(
  kind: QuotaWindowKind,
  windows: readonly { window: QuotaWindowKind; scope?: string | undefined }[],
): string {
  if (kind === 'other') return windowLabel.other;
  if (kind !== '7d_model') return quotaWindowName({ window: kind, label: kind });
  const groups: string[] = [];
  for (const w of windows) {
    if (w.window !== '7d_model') continue;
    const scope = w.scope?.trim();
    if (scope && !groups.includes(scope)) groups.push(scope);
  }
  return groups.length > 0 ? `单模型周额度（${groups.join('、')}）` : '单模型周额度';
}

/** 仓库一节的读失败：仓列表和接活开关都失败时合成一条，只失败一边就只写那一边。 */
function repoReadFailure(reposError: unknown, dispatchError: unknown): string | null {
  if (reposError && dispatchError) {
    const reposMsg = errorText(reposError);
    const dispatchMsg = errorText(dispatchError);
    if (reposMsg === dispatchMsg) return `仓列表和「让 AI 接活」开关没读成：${reposMsg}`;
    return `仓列表没读成：${reposMsg}；「让 AI 接活」开关没读成：${dispatchMsg}`;
  }
  if (reposError) return `仓列表没读成：${errorText(reposError)}`;
  if (dispatchError) return `「让 AI 接活」开关没读成：${errorText(dispatchError)}`;
  return null;
}

const RESERVE_SHORT = '每个渠道每个额度窗「最多用到百分之几」，用到这条线引擎就不再往这个渠道派新活';

/**
 * 各渠道的额度留量线（#194 方案 4.8）：每个渠道（账号池）每个额度窗一个「最多用到百分之几」，到了线引擎就不再往这个渠道派新活、
 * 也不切过去（在跑的不动）。线只存在库里（起始值是发布时装载器从种子文件只补缺装进去的，不写死、驾驶舱可配置），
 * 这里没有任何默认值：留空 = 未配置（不限），写「不限」= 明确不限。存值认不出、库里没有这一项明确说出来，不当成不限；整份一起存，
 * 带版本号、进操作记录；顶上写这一项现在是种子装的还是人改过的。
 */
function QuotaReserve({ s }: { s: Setting | undefined }) {
  const pools = usePools();
  const { data: meForReserve } = useMe();
  const namesForReserve = useActorNames();
  const { save, pending } = useSaveSetting();
  const stored = s && s.version > 0 ? SETTING_SCHEMAS['engine.quotaReserve'].safeParse(s.value) : null;
  const saved = stored?.success ? stored.data : {};
  const problem = stored && !stored.success ? issueText(stored.error.issues[0]) : null;
  const source = reserveSource(s);
  const rows = (pools.data?.pools ?? []).map((p) => {
    const mine = saved[p.id] ?? {};
    return {
      pool: p,
      mine,
      kinds: reserveKindsFor([...new Set(p.windows.map((w) => w.window))], mine),
    };
  });
  const initial = (): Record<string, string> =>
    Object.fromEntries(
      rows.flatMap((r) => r.kinds.map((k) => [`${r.pool.id}|${k}`, reserveInputText(r.mine[k])] as const)),
    );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  // 「未配置」的格子默认是灰色占位「—」，点一下才变输入框；点开了但没填的，离开输入框就缩回占位。
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // 池数据带实时用量，后台每次重拉都换引用；只跟池与窗口的形状走，否则刚点开的格子、没保存的草稿会被打回（#1871）。
  const shape = rows.map((r) => `${r.pool.id}:${r.kinds.join(',')}`).join(';');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 服务端版本变了、池与窗口的形状变了才重置，不跟着输入、用量重置。
  useEffect(() => {
    setDraft(initial());
    setEditing(new Set());
  }, [s?.version, shape]);
  useEffect(() => {
    if (focusKey) document.getElementById(`reserve-${focusKey.replace('|', '-')}`)?.focus();
  }, [focusKey]);
  const stopEditing = (k: string) => {
    setEditing((cur) => {
      const next = new Set(cur);
      next.delete(k);
      return next;
    });
    setFocusKey(null);
  };
  const dirty = Object.entries(initial()).some(([k, v]) => (draft[k] ?? v) !== v);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, Record<string, number | null>> = {};
    for (const [poolId, lines] of Object.entries(saved))
      next[poolId] = { ...lines } as Record<string, number | null>;
    for (const r of rows) {
      const lines: Record<string, number | null> = { ...(next[r.pool.id] ?? {}) };
      for (const k of r.kinds) {
        const parsed = parseReserveInput(draft[`${r.pool.id}|${k}`] ?? '');
        if (!parsed.ok) {
          toast.error('这个值不行', { description: `${poolTitle(r.pool)}：${parsed.why}` });
          return;
        }
        if (parsed.value === undefined) delete lines[k];
        else lines[k] = parsed.value;
      }
      if (Object.keys(lines).length > 0) next[r.pool.id] = lines;
      else delete next[r.pool.id];
    }
    save('engine.quotaReserve', next, s);
  };
  return (
    // 表单包在区块外面：区块标题在表单里（e2e 和读屏都按「表单里有标题」找它）
    <form onSubmit={submit}>
      <Section
        title={settingLabel['engine.quotaReserve']}
        // 卡头说明一行不折；「怎么填」原来是一个折叠，收进 ⓘ（#1917）
        description={
          <span className="block truncate whitespace-nowrap" title={RESERVE_SHORT}>
            {RESERVE_SHORT}
          </span>
        }
        actions={
          <DescriptionHint label="留量线怎么填">
            <p>{RESERVE_SHORT}。</p>
            <p className="mt-2">
              {`${brand.terms.carpool}用不了时也不切过去（在跑的不动），剩下的留给自己用。灰色「—」= 未配置（不限；${brand.terms.carpool}用到被拒为止，一般不设线），点一下才能填；写「${UNLIMITED_WORD}」= 明确不限。`}
            </p>
          </DescriptionHint>
        }
      >
        <p className="mt-1 text-meta" data-testid="reserve-source">
          {source.kind === 'missing' ? (
            <span className="text-ink-fail" role="alert">
              {`库里没有留量线：种子没装进库（发布时装载器没跑成？），引擎对所有渠道一律不派、不切，不当成不限。要现在恢复，在下面填好保存即可。`}
            </span>
          ) : source.kind === 'seed' ? (
            <span className="text-muted-foreground">
              {`现在的线来自种子（发布时装载器装的，还没人在${brand.product}改过）`}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {`现在的线是人在${brand.product}改过的${
                source.by ? `（${whoChangedLabel(source.by, meForReserve, namesForReserve).text}）` : ''
              }，发布时的种子不会覆盖它`}
            </span>
          )}
        </p>
        {problem ? (
          <p className="mt-2 text-meta text-ink-fail" role="alert">
            {`存着的留量线认不出（${problem}），引擎对所有渠道一律不派、不切，不当成不限；保存会整份换掉。`}
          </p>
        ) : null}
        {pools.error ? <LoadError what="渠道列表" error={pools.error} /> : null}
        {!pools.data ? <LoadingRows rows={1} /> : null}
        <div className="mt-2 divide-y">
          {rows.map((r) => (
            <div key={r.pool.id} className="grid gap-x-4 gap-y-1 py-2 md:grid-cols-field md:items-center">
              {/* 拼车和独享两个池同属一个渠道：只写渠道名会出现两行一模一样的「Claude 订阅」，要带上池编号 */}
              <div className="text-body">{poolTitle(r.pool)}</div>
              {r.kinds.length === 0 ? (
                <p className="text-meta text-muted-foreground">还没读到额度窗，读到以后在这里配。</p>
              ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {r.kinds.map((k) => {
                    const dk = `${r.pool.id}|${k}`;
                    const id = `reserve-${r.pool.id}-${k}`;
                    const name = reserveKindLabel(k, r.pool.windows);
                    const open = (draft[dk] ?? '') !== '' || editing.has(dk);
                    return (
                      <div key={k} className="flex items-center gap-1.5">
                        <Label htmlFor={id} className="text-meta text-muted-foreground">
                          {name}
                        </Label>
                        {open ? (
                          <>
                            <Input
                              id={id}
                              value={draft[dk] ?? ''}
                              onChange={(e) => setDraft((d) => ({ ...d, [dk]: e.target.value }))}
                              onBlur={() => {
                                if ((draft[dk] ?? '') === '') stopEditing(dk);
                              }}
                              className="num h-7 w-20 max-md:min-h-10"
                            />
                            <span className="text-meta text-muted-foreground">%</span>
                          </>
                        ) : (
                          <button
                            type="button"
                            id={id}
                            title="未配置（不限），点一下填写"
                            onClick={() => {
                              setEditing((cur) => new Set(cur).add(dk));
                              setFocusKey(dk);
                            }}
                            className="num h-7 w-20 max-md:min-h-10 rounded-md border border-dashed bg-muted text-meta text-muted-foreground outline-none hover:border-border-strong hover:text-muted-foreground focus-visible:ring-focus focus-visible:ring-ring"
                          >
                            —<span className="sr-only">未配置，点击填写</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-end gap-3">
          <div className="min-w-0 flex-1">{source.kind === 'missing' ? null : <SettingMeta s={s} />}</div>
          <SaveButton canSave={dirty} pending={pending} />
        </div>
      </Section>
    </form>
  );
}

const SECTIONS = [
  { id: 'repos', label: '仓库和接活' },
  { id: 'run', label: '运行设置' },
  { id: 'notify', label: '提醒' },
  { id: 'account', label: '账密登录' },
  { id: 'look', label: '外观' },
  { id: 'about', label: '关于' },
] as const;

/** 设置靠推送更新，没有自己的轮询。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const SETTINGS_STALE_AFTER_MS = 5 * TIME.MIN;

export default function Settings() {
  const theme = useTheme();
  const api = useApi();
  const { data: me } = useMe();
  const { repos, loading: reposLoading, error: reposError } = useRepo();
  const settings = useSettings();
  const dispatch = useRepoDispatch();
  const ciPolicy = useRepoCiPolicy();
  const repoFailure = repoReadFailure(reposError, dispatch.error);
  const find = (k: SettingKey) => settings.data?.settings.find((s) => s.key === k);

  return (
    <Page
      title="设置"
      description="仓库开关、运行设置、提醒、登录和外观。"
      detail={
        <div className="space-y-2">
          <p>
            仓库开关、运行设置、提醒存在后端：保存时带上你看到的版本号，别人先改了会提示你刷新再改；改了写进操作记录。
          </p>
          <p>外观（深浅、密度、主题色、减少动效）只存在这台浏览器里。</p>
          <p>
            仓库一行：「开启 / 关闭」管这个仓「让 AI
            接活」，「整理」叫指挥官现在整理待办；点仓名展开整理记录。CI
            模式在这一行下面，随时能在强制和不强制之间切。
          </p>
        </div>
      }
      // 刷新在页头固定槽位（规范第三节「页头」），页面不自己摆
      refresh={{
        onRefresh: () => void settings.refetch(),
        isFetching: settings.isFetching,
        dataUpdatedAt: settings.dataUpdatedAt,
        staleAfterMs: SETTINGS_STALE_AFTER_MS,
      }}
    >
      {/* 版式（#1805）：左侧页内导航（桌面吸在左边，手机吸顶成横向胶囊）+ 右边各节；每节标题下一句说明，字段标签左、控件右。
          顺序按用得多少排——「让 AI 接活」是最常动的开关，放最前；外观放后面。 */}
      <div className="lg:grid lg:grid-cols-settings-shell lg:gap-8">
        <PageNav label="设置分节" items={SECTIONS} />
        <div className="min-w-0">
          <SettingsSection
            id="repos"
            icon={FolderGit2}
            title="仓库"
            description="接进来的仓（测试能跑、有一页 AGENTS.md）。接活、整理在一行；CI 模式在下面。点仓名看整理记录。"
          >
            {/* 总开关和按项目开关的关系（#1086）：总开关关＝全停，开＝只有接活开着的项目才派 */}
            <EngineMasterRelation />
            {repoFailure ? (
              <div className="mb-3">
                <LoadError text={repoFailure} error={reposError ?? dispatch.error} />
                {reposError && repos.length ? (
                  <p className="mt-1 text-meta text-muted-foreground">下面是上次读到的，可能不全。</p>
                ) : null}
              </div>
            ) : null}
            {reposLoading ? <LoadingRows rows={1} /> : null}
            {repos.length > 0 || (!reposLoading && !reposError) ? (
              <Section flush>
                {/* 一行一个仓（#1917，照路由页样板）：仓名加一行小字、一个状态、「开启/关闭」和「整理」同一行同宽 */}
                <List aria-label="仓库">
                  {repos.map((r) => (
                    <li key={r.id}>
                      <RepoRow
                        repoId={r.id}
                        repo={{ owner: r.owner, name: r.name }}
                        branch={r.defaultBranch}
                        dispatch={dispatch.data?.repos.find((d) => d.repoId === r.id)}
                      />
                      <RowDetail indent={false} className="pb-3">
                        <RepoCiPolicyControl
                          repoId={r.id}
                          name={`${r.owner}/${r.name}`}
                          row={ciPolicy.data?.repos.find((d) => d.repoId === r.id)}
                        />
                      </RowDetail>
                    </li>
                  ))}
                </List>
                {/* 只有真读到了一个空列表才说「还没有仓」；没读成、还在读都不算。 */}
                {repos.length === 0 && !reposLoading && !reposError ? (
                  <EmptyState size="inline" icon={FolderGit2} title="还没有仓" />
                ) : null}
              </Section>
            ) : null}

            {/* 两个机器人已经装上的仓：接进或移出驾驶舱。新项目走本机 pnpm project add。 */}
            <div className="mt-4 border-t pt-4">
              <h3 className="text-heading">导入仓库</h3>
              <p className="mt-1 mb-3 text-meta text-muted-foreground">
                这里只列两个机器人已经装上的仓。新项目在本机跑 pnpm project add 做到底；接进来的仓「让 AI
                接活」默认关着，要另外打开。
              </p>
              <RepoImportSection />
            </div>
          </SettingsSection>

          <SettingsSection
            id="run"
            icon={SlidersHorizontal}
            title="运行设置"
            description="存在后端。保存时带上你看到的版本号：别人先改了会提示你刷新再改，不会悄悄盖掉。"
          >
            {/* 读失败后再重拉会先清掉 error、回到 pending。已经读过就不再画骨架。 */}
            {settings.data ? (
              <div className="space-y-3">
                {/* 单栏：项数不多，分两栏会有一边空着（#1910 第 11 条） */}
                <FieldGroup>
                  <NumberSetting
                    k="sessions.maxConcurrent"
                    s={find('sessions.maxConcurrent')}
                    hint="整台机器同时跑的 AI 会话最多几个（1–32）。各账号池自己的并发上限另算。"
                    unit="个会话"
                    placeholder="默认 6"
                  />
                  <NumberSetting
                    k="judge.dailyCallLimit"
                    s={find('judge.dailyCallLimit')}
                    hint="判断题小模型每天最多调用多少次（0 = 不用它）。"
                    unit="次 / 天"
                    placeholder="没设"
                  />
                  <SoloPaused s={find('engine.soloPaused')} />
                  <FlowModeSetting s={find('engine.flowMode')} />
                </FieldGroup>
                <QuotaReserve s={find('engine.quotaReserve')} />
              </div>
            ) : settings.error ? (
              <LoadError error={settings.error} />
            ) : settings.isFetched ? null : (
              <LoadingRows rows={2} />
            )}
          </SettingsSection>

          <SettingsSection
            id="notify"
            icon={BellRing}
            title="提醒"
            description={`飞书和${brand.product}只推三类：要你拍、卡住报警、日报。进度不主动推，问了才给。`}
          >
            {/* 和运行设置同一条：出错只留报错横幅，读过之后的重拉也不画骨架。 */}
            {settings.data ? (
              <FieldGroup>
                <QuietHours s={find('notify.quietHours')} />
              </FieldGroup>
            ) : settings.error ? (
              <LoadError error={settings.error} />
            ) : settings.isFetched ? null : (
              <LoadingRows rows={1} />
            )}
            {/* 装成 APP、系统通知、角标（#2050）：三样都是浏览器现读的，不依赖后端设置 */}
            <div className="mt-3">
              <PwaStatus />
            </div>
          </SettingsSection>

          <SettingsSection
            id="account"
            icon={KeyRound}
            title="账密登录"
            description={`设一个用户名和密码，飞书登录出问题时也进得去${brand.product}。`}
          >
            <CredentialsSection />
          </SettingsSection>

          <SettingsSection
            id="look"
            icon={Palette}
            title="外观"
            description="多套主题色，每套都有深浅两版；切换即时生效，下次打开还是它。"
          >
            <FieldGroup>
              <FieldRow label="深浅">
                <div className="w-full max-w-xs">
                  <ModeSwitch />
                </div>
              </FieldRow>
              <FieldRow label="密度" hint="紧凑把控件、行和区块的留白收小一档，字号不变；手机上不生效。">
                <FilterTabs
                  mode="toggle"
                  aria-label="密度"
                  items={DENSITY_ITEMS}
                  value={theme.pref.density}
                  onChange={theme.setDensity}
                />
              </FieldRow>
              <FieldRow label="主题色">
                {/* 一行小色块 + 名字的单选；每个色块按它自己那套主题上色。 */}
                <div role="radiogroup" aria-label="主题色" className="flex flex-wrap gap-2">
                  {PALETTES.map((p) => {
                    const active = theme.pref.palette === p.id;
                    return (
                      <Button
                        key={p.id}
                        type="button"
                        variant="outline"
                        size="sm"
                        role="radio"
                        aria-checked={active}
                        aria-label={`主题色：${p.name}`}
                        title={p.blurb}
                        onClick={() => theme.setPalette(p.id)}
                        className={cn(
                          'gap-2 px-2 text-meta hover:border-border-strong',
                          active && 'border-foreground bg-muted dark:bg-muted',
                        )}
                      >
                        <span
                          data-palette={p.id}
                          data-mode={theme.resolvedMode}
                          className="flex items-center gap-0.5 rounded-md border bg-background p-1"
                          aria-hidden
                        >
                          <span className="size-2.5 rounded-full bg-brand" />
                          <span className="size-2.5 rounded-full bg-muted-foreground" />
                          <span className="size-2.5 rounded-full bg-st-done" />
                          <span className="size-2.5 rounded-full bg-st-fail" />
                        </span>
                        <span className="font-medium">{p.name}</span>
                        <span className="num text-meta text-muted-foreground">{p.en}</span>
                        {active ? <Check className="size-3.5" aria-hidden /> : null}
                      </Button>
                    );
                  })}
                </div>
              </FieldRow>
              <FieldRow label="状态色" hint="看板上颜色只表达状态。当前主题下的七种状态色。">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {TONES.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1.5 text-meta">
                      <StatusDot tone={t} />
                      {toneLabel[t]}
                    </span>
                  ))}
                </div>
              </FieldRow>
              <FieldRow label="减少动效" hint="在跑的卡片不再呼吸、进度条不再扫光">
                <Switch
                  checked={theme.pref.motion === 'reduced'}
                  onCheckedChange={(on) => theme.setMotion(on ? 'reduced' : 'system')}
                  aria-label="减少动效"
                />
              </FieldRow>
            </FieldGroup>
          </SettingsSection>

          <SettingsSection id="about" icon={Info} title="关于" description={`${brand.product}的前端。`}>
            <KeyValue
              className="max-w-xl"
              items={[
                {
                  label: '数据',
                  value:
                    api.source === 'http'
                      ? `${brand.product}后端（/api），推送走 /api/events`
                      : '假数据（编的，会自己动；页面上的操作只改这份假数据）',
                },
                {
                  label: '登录',
                  value: me ? `${me.user.displayName}（飞书或账密，只放行创始人）` : '—',
                },
                { label: '接口约定', value: 'packages/shared/src/web-api.ts', mono: true },
              ]}
            />
          </SettingsSection>
        </div>
      </div>
    </Page>
  );
}
