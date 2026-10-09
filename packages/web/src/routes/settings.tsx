import { type QuotaWindowKind, quotaWindowName, SETTING_SCHEMAS } from '@fleet-dao/shared';
import type { LucideIcon } from 'lucide-react';
import { BellRing, FolderGit2, Info, KeyRound, Palette, SlidersHorizontal } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { brand } from '#brand';
import {
  ApiError,
  errorText,
  useApi,
  useMe,
  usePools,
  useRepoDispatch,
  useSettings,
  useUpdateSetting,
} from '../api/client';
import type { Setting, SettingKey } from '../api/types';
import { CredentialsSection } from '../components/credentials-section';
import { EngineMasterRelation } from '../components/engine-master';
import { LoadError, LoadingRows, Page } from '../components/page';
import { PoolHoldsPanel } from '../components/pool-holds';
import { RefreshBar } from '../components/refresh-bar';
import { useRepo } from '../components/repo-context';
import { RepoDispatchControl } from '../components/repo-dispatch';
import { RepoGroomControl } from '../components/repo-groom';
import { PaletteSwatch } from '../components/shell/palette-swatch';
import { ModeSwitch } from '../components/shell/topbar';
import { StatusDot } from '../components/status';
import { useTheme } from '../components/theme-provider';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { settingLabel } from '../lib/audit';
import { poolTitle } from '../lib/catalog';
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
import { PALETTES } from '../lib/theme';

export function meta() {
  return [{ title: brand.title('设置') }];
}

function Section({
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
    <section
      id={id}
      className="scroll-mt-6 grid gap-4 border-b py-8 first:pt-0 last:border-b-0 lg:grid-cols-settings"
    >
      <div>
        <h2 className="flex items-center gap-2 text-strong font-semibold">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div>
        <div className="text-sm">{label}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** 这项设置是谁、什么时候改的；没设过就说用默认。 */
function SettingMeta({ s }: { s: Setting | undefined }) {
  const now = useNow();
  const { data: me } = useMe();
  if (!s || s.version === 0)
    return <p className="mt-1.5 text-xs text-muted-foreground">还没设过，用的是默认值</p>;
  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      第 <span className="num">{s.version}</span> 版
      {s.updatedBy ? ` · ${isMine(s.updatedBy, me) ? '我' : s.updatedBy}` : ''}
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
    <form onSubmit={submit} className="rounded-xl border bg-card p-4">
      <Label htmlFor={id} className="text-sm font-medium">
        {settingLabel[k]}
      </Label>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      <div className="mt-3 flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
          className="num h-8 w-32"
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
        <Button
          type="submit"
          size="sm"
          className="ml-auto"
          disabled={pending || draft === shown || draft === ''}
        >
          保存
        </Button>
      </div>
      <SettingMeta s={s} />
    </form>
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save('notify.quietHours', on ? { start, end } : null, s);
      }}
      className="rounded-xl border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{settingLabel['notify.quietHours']}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            北京时间。免打扰时段里飞书不响；{brand.product}里照常能看到。
          </p>
        </div>
        <Switch checked={on} onCheckedChange={setOn} aria-label="开免打扰时段" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
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
        <Button type="submit" size="sm" className="ml-auto" disabled={pending || !dirty}>
          保存
        </Button>
      </div>
      <SettingMeta s={s} />
    </form>
  );
}

/** 引擎暂不用独享（#194 方案 4.8）：创始人自己要大用独享时一键叫停引擎这一路；开关一拨就存，带版本号、进操作记录。 */
function SoloPaused({ s }: { s: Setting | undefined }) {
  const current = SETTING_SCHEMAS['engine.soloPaused'].safeParse(s?.value);
  const on = current.success ? current.data : false;
  const { save, pending } = useSaveSetting();
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{settingLabel['engine.soloPaused']}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {`开着时：${brand.terms.carpool}用不了（额度用满、整辆车被用光）也不自动切到${brand.terms.solo}，Claude 的活等${brand.terms.carpool}恢复或交给别家模型。已经挂着${brand.terms.solo}的不受影响，${brand.terms.carpool}恢复照常切回。`}
          </p>
        </div>
        <Switch
          checked={on}
          disabled={pending}
          onCheckedChange={(next) => save('engine.soloPaused', next, s)}
          aria-label={settingLabel['engine.soloPaused']}
        />
      </div>
      <SettingMeta s={s} />
    </div>
  );
}

/**
 * 留量线一行的窗口名。7d_model 没有组名时不要把字段名漏出来（「7d_model 周额度」），写成「单模型周额度」；
 * 这个池的读数带了组名就写在后面。别的窗口沿用 quotaWindowName，名字不变。
 */
function reserveKindLabel(
  kind: QuotaWindowKind,
  windows: readonly { window: QuotaWindowKind; scope?: string | undefined }[],
): string {
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

/**
 * 各渠道的额度留量线（#194 方案 4.8）：每个渠道（账号池）每个额度窗一个「最多用到百分之几」，到了线引擎就不再往这个渠道派新活、
 * 也不切过去（在跑的不动）。线只存在库里（起始值是发布时装载器从种子文件只补缺装进去的，创始人 2026-10-05：不写死、驾驶舱可配置），
 * 这里没有任何默认值：留空 = 未配置（不限），写「不限」= 明确不限。存值认不出、库里没有这一项明确说出来，不当成不限；整份一起存，
 * 带版本号、进操作记录；顶上写这一项现在是种子装的还是人改过的。
 */
function QuotaReserve({ s }: { s: Setting | undefined }) {
  const pools = usePools();
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: 服务端版本变了、池列表读到了才重置，不跟着输入重置。
  useEffect(() => setDraft(initial()), [s?.version, pools.data]);
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
    <form onSubmit={submit} className="rounded-xl border bg-card p-4 md:col-span-2">
      <div className="text-sm font-medium">{settingLabel['engine.quotaReserve']}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {`每个渠道每个额度窗「最多用到百分之几」。已用到这条线，引擎不再往这个渠道派新活，${brand.terms.carpool}用不了时也不切过去（在跑的不动），剩下的留给自己用。留空 = 未配置（不限；${brand.terms.carpool}用到被拒为止，一般不设线）；写「${UNLIMITED_WORD}」= 明确不限。`}
      </p>
      <p className="mt-1 text-xs" data-testid="reserve-source">
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
            {`现在的线是人在${brand.product}改过的${source.by ? `（${source.by}）` : ''}，发布时的种子不会覆盖它`}
          </span>
        )}
      </p>
      {problem ? (
        <p className="mt-2 text-xs text-ink-fail" role="alert">
          {`存着的留量线认不出（${problem}），引擎对所有渠道一律不派、不切，不当成不限；保存会整份换掉。`}
        </p>
      ) : null}
      {pools.error ? <LoadError what="渠道列表" error={pools.error} /> : null}
      {!pools.data ? <LoadingRows rows={1} /> : null}
      <div className="mt-3 space-y-3">
        {rows.map((r) => (
          <div key={r.pool.id}>
            {/* 拼车和独享两个池同属一个渠道：只写渠道名会出现两行一模一样的「Claude 订阅」，要带上池编号 */}
            <div className="text-sm">{poolTitle(r.pool)}</div>
            {r.kinds.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没读到额度窗，读到以后在这里配。</p>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                {r.kinds.map((k) => {
                  const id = `reserve-${r.pool.id}-${k}`;
                  return (
                    <div key={k} className="flex items-center gap-1.5">
                      <Label htmlFor={id} className="text-xs text-muted-foreground">
                        {reserveKindLabel(k, r.pool.windows)}
                      </Label>
                      <Input
                        id={id}
                        value={draft[`${r.pool.id}|${k}`] ?? ''}
                        placeholder="未配置"
                        onChange={(e) => setDraft((d) => ({ ...d, [`${r.pool.id}|${k}`]: e.target.value }))}
                        className="num h-8 w-24"
                      />
                      <span className="text-xs text-muted-foreground">%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center">
        <Button type="submit" size="sm" className="ml-auto" disabled={pending || !dirty}>
          保存
        </Button>
      </div>
      {source.kind === 'missing' ? null : <SettingMeta s={s} />}
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
  const repoFailure = repoReadFailure(reposError, dispatch.error);
  const find = (k: SettingKey) => settings.data?.settings.find((s) => s.key === k);

  return (
    <Page
      title="设置"
      description="运行设置和仓库开关存在后端，改了写进操作记录；外观只存在这台浏览器里。"
      actions={
        <RefreshBar
          onRefresh={() => void settings.refetch()}
          isFetching={settings.isFetching}
          dataUpdatedAt={settings.dataUpdatedAt}
          staleAfterMs={SETTINGS_STALE_AFTER_MS}
        />
      }
    >
      {/* 版式（驾驶舱改版 2026-10-07）：按用得多少排——「让 AI 接活」是最常动的开关，放最前；外观放后面。顶上一排跳转。 */}
      <nav aria-label="设置分节" className="-mt-2 mb-2 flex flex-wrap gap-1.5">
        {SECTIONS.map((x) => (
          <a
            key={x.id}
            href={`#${x.id}`}
            className="rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
          >
            {x.label}
          </a>
        ))}
      </nav>
      <Section
        id="repos"
        icon={FolderGit2}
        title="仓库"
        description="接进来的仓。一个仓接进来要满足：测试能跑、有一页 AGENTS.md。「让 AI 接活」开着：引擎每 5 分钟自己按准入和排序挑单（老单要指挥官整理过），没单可挑会自动叫指挥官整理。关着：只有本机 fleet-api dispatch-issue 点名派。"
      >
        {/* 总开关和按项目开关的关系（#1086）：总开关关＝全停，开＝只有接活开着的项目才派 */}
        <EngineMasterRelation />
        {repoFailure ? (
          <div className="mb-3 max-w-xl">
            <LoadError text={repoFailure} error={reposError ?? dispatch.error} />
            {reposError && repos.length ? (
              <p className="mt-1 text-xs text-muted-foreground">下面是上次读到的，可能不全。</p>
            ) : null}
          </div>
        ) : null}
        {reposLoading ? <LoadingRows rows={1} /> : null}
        <ul className="max-w-4xl divide-y rounded-xl border bg-card empty:hidden">
          {repos.map((r) => (
            <li key={r.id} className="grid gap-3 px-4 py-3 sm:grid-cols-2 sm:items-start">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1 basis-40">
                  <div className="num truncate text-sm font-medium">
                    {r.owner}/{r.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    主线 <span className="num">{r.defaultBranch}</span>
                  </div>
                </div>
                <RepoDispatchControl
                  repoId={r.id}
                  name={`${r.owner}/${r.name}`}
                  row={dispatch.data?.repos.find((d) => d.repoId === r.id)}
                />
              </div>
              <RepoGroomControl repoId={r.id} repo={{ owner: r.owner, name: r.name }} />
            </li>
          ))}
          {/* 只有真读到了一个空列表才说「还没有仓」；没读成、还在读都不算。 */}
          {repos.length === 0 && !reposLoading && !reposError ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">还没有仓</li>
          ) : null}
        </ul>
      </Section>

      <Section
        id="run"
        icon={SlidersHorizontal}
        title="运行设置"
        description="存在后端。保存时带上你看到的版本号：别人先改了会提示你刷新再改，不会悄悄盖掉。"
      >
        {/* 读失败后再重拉会先清掉 error、回到 pending。已经读过就不再画骨架。 */}
        {settings.data ? (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
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
            <QuotaReserve s={find('engine.quotaReserve')} />
            <PoolHoldsPanel />
          </div>
        ) : settings.error ? (
          <LoadError error={settings.error} />
        ) : settings.isFetched ? null : (
          <LoadingRows rows={2} />
        )}
      </Section>

      <Section
        id="notify"
        icon={BellRing}
        title="提醒"
        description={`飞书和${brand.product}只推三类：要你拍、卡住报警、日报。进度不主动推，问了才给。`}
      >
        {/* 和运行设置同一条：出错只留报错横幅，读过之后的重拉也不画骨架。 */}
        {settings.data ? (
          <div className="grid max-w-3xl gap-3 md:grid-cols-2">
            <QuietHours s={find('notify.quietHours')} />
          </div>
        ) : settings.error ? (
          <LoadError error={settings.error} />
        ) : settings.isFetched ? null : (
          <LoadingRows rows={1} />
        )}
      </Section>

      <Section
        id="account"
        icon={KeyRound}
        title="账密登录"
        description={`设一个用户名和密码，飞书登录出问题时也进得去${brand.product}。`}
      >
        <CredentialsSection />
      </Section>

      <Section
        id="look"
        icon={Palette}
        title="外观"
        description="多套主题色，每套都有深浅两版；切换即时生效，下次打开还是它。"
      >
        <div className="mb-5 max-w-sm">
          <ModeSwitch />
        </div>
        {/* 1024 宽时这一节已经分了左右栏，四列色卡装不下 Graphite / Tokyo Night，先两列，1280 以上再四列。 */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {PALETTES.map((p) => (
            <PaletteSwatch
              key={p.id}
              id={p.id}
              mode={theme.resolvedMode}
              active={theme.pref.palette === p.id}
              onPick={theme.setPalette}
              size="lg"
            />
          ))}
        </div>
        <div className="mt-5 rounded-xl border bg-card p-4">
          <div className="mb-2 text-xs text-muted-foreground">
            看板上颜色只表达状态。当前主题下的七种状态色：
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {TONES.map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5 text-sm">
                <StatusDot tone={t} />
                {toneLabel[t]}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-3 max-w-md">
          <Row label="减少动效" hint="在跑的卡片不再呼吸、进度条不再扫光">
            <Switch
              checked={theme.pref.motion === 'reduced'}
              onCheckedChange={(on) => theme.setMotion(on ? 'reduced' : 'system')}
              aria-label="减少动效"
            />
          </Row>
        </div>
      </Section>

      <Section id="about" icon={Info} title="关于" description={`${brand.product}的前端。`}>
        <dl className="grid max-w-md grid-cols-about gap-y-2 text-sm">
          <dt className="text-muted-foreground">数据</dt>
          <dd>
            {api.source === 'http'
              ? `${brand.product}后端（/api），推送走 /api/events`
              : '假数据（编的，会自己动；页面上的操作只改这份假数据）'}
          </dd>
          <dt className="text-muted-foreground">登录</dt>
          <dd>{me ? `${me.user.displayName}（飞书或账密，只放行创始人）` : '—'}</dd>
          <dt className="text-muted-foreground">接口约定</dt>
          <dd className="num text-xs leading-5">packages/shared/src/web-api.ts</dd>
        </dl>
      </Section>
    </Page>
  );
}
