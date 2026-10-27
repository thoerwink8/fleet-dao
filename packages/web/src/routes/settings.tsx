// 设置（/settings，#3533 照 Arco 改版，样稿 canvas/Settings.dc.html）：左边页内导航（Anchor），右边各节一张卡。
// 从上到下：仓库（一行一个仓，让 AI 接活 / CI 模式 / 整理待办，导入仓库收在卡头入口）、运行设置、额度留量线、提醒、账密登录、关于。
// 保存都带改之前看到的版本号，别人先改了后端回 409，提示刷新再改；改了都进操作记录。读失败写「没读到」，不画成 0 或「正常」。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）。
import { type QuotaWindowKind, quotaWindowName, SETTING_SCHEMAS } from '@fleet-dao/shared';
import { FolderGit2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { brand } from '#brand';
import {
  ApiError,
  errorText,
  useApi,
  useAudit,
  useCredentials,
  useMe,
  usePools,
  useRepoCiPolicy,
  useRepoDispatch,
  useSettings,
  useUpdateSetting,
} from '../api/client';
import type { Credentials, Me, Repo, Setting, SettingKey } from '../api/types';
import { CredentialsSection } from '../components/credentials-section';
import { useMasterView } from '../components/engine-master';
import { EngineMasterRelation } from '../components/engine-master-relation';
import { Anchor } from '../components/layout/anchor';
import { Button } from '../components/layout/button';
import { Descriptions } from '../components/layout/descriptions';
import { EmptyState } from '../components/layout/empty-state';
import { Form, FormItem } from '../components/layout/form';
import { Grid } from '../components/layout/grid';
import { Input } from '../components/layout/input';
import { TextLink } from '../components/layout/link';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { SaveButton } from '../components/layout/save-button';
import { Section } from '../components/layout/section';
import { FoldSection, useSectionFoldPage } from '../components/layout/section-fold';
import { Stack } from '../components/layout/stack';
import { Switch } from '../components/layout/switch';
import { Table, type TableColumn } from '../components/layout/table';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { PwaStatus } from '../components/pwa-status';
import { CiState, RepoCiPolicyControl } from '../components/repo-ci-policy';
import { useRepo } from '../components/repo-context';
import { DispatchAction, DispatchState, dispatchNote } from '../components/repo-dispatch';
import { GroomAction, GroomDetail, RepoNameCell } from '../components/repo-groom';
import { RepoImportSection } from '../components/repo-import';
import { useTheme } from '../components/theme-provider';
import { actorName, settingLabel } from '../lib/audit';
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
import { isMine } from '../lib/status';

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
    // 操作记录没读到时就没有人名可对，「谁改的」退回缩短的编号（不是把读失败当成「没人改过」）
    for (const page of audit.data ? audit.data.pages : []) {
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

/** 这项设置是谁、什么时候改的；没设过就说用默认。 */
function SettingMeta({ s }: { s: Setting | undefined }) {
  const now = useNow();
  const { data: me } = useMe();
  const names = useActorNames();
  if (!s || s.version === 0)
    return (
      <Text size="meta" tone="muted" block>
        还没设过，用的是默认值
      </Text>
    );
  const who = s.updatedBy ? whoChangedLabel(s.updatedBy, me, names) : null;
  return (
    <Text size="meta" tone="muted" block>
      第 {s.version} 版
      {who ? (
        <>
          {' '}
          · <span title={who.title}>{who.text}</span>
        </>
      ) : null}
      {s.updatedAt ? <> · {formatAgo(s.updatedAt, now)}改的</> : null}
    </Text>
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
  const submit = () => {
    if (draft.trim() === '') return;
    save(k, Number(draft), s);
  };
  const id = `setting-${k}`;
  return (
    <Form onSubmit={submit}>
      <FormItem
        label={settingLabel[k]}
        htmlFor={id}
        help={
          <>
            {hint}
            <SettingMeta s={s} />
          </>
        }
      >
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <Input
            id={id}
            inputMode="numeric"
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
            width="sm"
          />
          <Text tone="secondary">{unit}</Text>
          <SaveButton variant="secondary" canSave={draft !== shown && draft !== ''} pending={pending} />
        </Stack>
      </FormItem>
    </Form>
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
    <Form onSubmit={() => save('notify.quietHours', on ? { start, end } : null, s)}>
      <FormItem
        label={settingLabel['notify.quietHours']}
        help={
          <>
            北京时间。免打扰时段里飞书不响；{brand.product}里照常能看到。
            <SettingMeta s={s} />
          </>
        }
      >
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <Switch checked={on} onCheckedChange={setOn} aria-label="开免打扰时段" />
          <Input
            type="time"
            value={start}
            disabled={!on}
            onChange={(e) => setStart(e.target.value)}
            width="sm"
            aria-label="免打扰开始"
          />
          <Text tone={on ? 'secondary' : 'muted'}>到</Text>
          <Input
            type="time"
            value={end}
            disabled={!on}
            onChange={(e) => setEnd(e.target.value)}
            width="sm"
            aria-label="免打扰结束"
          />
          <SaveButton variant="secondary" canSave={dirty} pending={pending} />
        </Stack>
      </FormItem>
    </Form>
  );
}

/** 引擎暂不用独享（#194 方案 4.8）：创始人自己要大用独享时一键叫停引擎这一路；开关一拨就存，带版本号、进操作记录。 */
function SoloPaused({ s }: { s: Setting | undefined }) {
  const current = SETTING_SCHEMAS['engine.soloPaused'].safeParse(s?.value);
  const on = current.success ? current.data : false;
  const { save, pending } = useSaveSetting();
  return (
    <Form aria-label={settingLabel['engine.soloPaused']}>
      <FormItem
        label={settingLabel['engine.soloPaused']}
        help={
          <>
            {`开着时：${brand.terms.carpool}用不了（额度用满、整辆车被用光）也不自动切到${brand.terms.solo}，Claude 的活等${brand.terms.carpool}恢复或交给别家模型。已经挂着${brand.terms.solo}的不受影响，${brand.terms.carpool}恢复照常切回。拨一下就存。`}
            <SettingMeta s={s} />
          </>
        }
      >
        <Stack direction="horizontal" gap="sm" align="center">
          <Switch
            checked={on}
            disabled={pending}
            onCheckedChange={(next) => save('engine.soloPaused', next, s)}
            aria-label={settingLabel['engine.soloPaused']}
          />
          <Text tone="secondary">{on ? '开着' : '关着'}</Text>
        </Stack>
      </FormItem>
    </Form>
  );
}

/**
 * 指挥官看停下的任务（#3294 第 2 片）：没设过算开；关了就不再把停下的单交指挥官会话看。哪个模型当指挥官在路由页的「指挥官」一栏配，
 * 那一栏清空时指挥官明说「没配模型」并报警。开关一拨就存，带版本号、进操作记录。
 */
function CommanderSwitch({ s }: { s: Setting | undefined }) {
  const current = SETTING_SCHEMAS['engine.commander'].safeParse(s?.value);
  const on = current.success ? current.data : true;
  const { save, pending } = useSaveSetting();
  return (
    <Form aria-label={settingLabel['engine.commander']}>
      <FormItem
        label={settingLabel['engine.commander']}
        help={
          <>
            开着时：任务停下超过 15
            分钟、引擎自己的规则没解开，就交给路由页「指挥官」一栏选出的模型看一眼；它只交裁决（继续、重做、拆单、停掉、留给人），
            引擎按白名单核过才执行，改标准、没权限这类要人拍的只写诊断建议。每张单每次停下最多处理一次，每天有总次数上限。拨一下就存。
            <SettingMeta s={s} />
          </>
        }
      >
        <Stack direction="horizontal" gap="sm" align="center">
          <Switch
            checked={on}
            disabled={pending}
            onCheckedChange={(next) => save('engine.commander', next, s)}
            aria-label={settingLabel['engine.commander']}
          />
          <Text tone="secondary">{on ? '开着' : '关着'}</Text>
        </Stack>
      </FormItem>
    </Form>
  );
}

/**
 * 留量线一列的窗口名。other →「其他窗口」；7d_model 没有组名时不要把字段名漏出来（「7d_model 周额度」），
 * 写成「单模型周额度」；读数带了组名就写在后面。别的窗口沿用 quotaWindowName，名字不变。
 */
function reserveKindLabel(
  kind: QuotaWindowKind,
  windows: readonly { window: QuotaWindowKind; scope?: string | undefined }[],
): string {
  if (kind === 'other') return '其他窗口';
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

const RESERVE_SHORT =
  '每个渠道每个额度窗「最多用到百分之几」，用到这条线引擎就不再往这个渠道派新活（在跑的不动）';

/** 留量线表里的一行：一个渠道（账号池）、存着的线、界面上列哪几种窗口。 */
interface ReserveRow {
  pool: NonNullable<ReturnType<typeof usePools>['data']>['pools'][number];
  mine: Partial<Record<QuotaWindowKind, number | null | undefined>>;
  kinds: QuotaWindowKind[];
}

/** 窗口列的固定顺序（和 lib/reserve 的 reserveKindsFor 同一个顺序）。 */
const KIND_ORDER: QuotaWindowKind[] = ['5h', '7d', '7d_model', 'month_usd', 'period_usd', 'points', 'other'];

/**
 * 各渠道的额度留量线（#194 方案 4.8）：渠道 × 额度窗一张表，每格一个「最多用到百分之几」，到了线引擎就不再往这个渠道派新活、
 * 也不切过去（在跑的不动）。线只存在库里（起始值是发布时装载器从种子文件只补缺装进去的，不写死、驾驶舱可配置），
 * 这里没有任何默认值：格子空着 = 未配置（不限），写「不限」= 明确不限。存值认不出、库里没有这一项明确说出来，不当成不限；整份一起存，
 * 带版本号、进操作记录；顶上写这一项现在是种子装的还是人改过的。这个渠道没有的窗写「无此窗」，和「未配置」分开。
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
  // 渠道列表没读到时不画表（下面单独写读失败 / 在读），所以这里的空列表不会被当成「没有渠道」
  const rows: ReserveRow[] = (pools.data ? pools.data.pools : []).map((p) => {
    const mine = saved[p.id] ?? {};
    return {
      pool: p,
      mine,
      kinds: reserveKindsFor([...new Set(p.windows.map((w) => w.window))], mine),
    };
  });
  const columnKinds = KIND_ORDER.filter((k) => rows.some((r) => r.kinds.includes(k)));
  const allWindows = rows.flatMap((r) => r.pool.windows);
  const initial = (): Record<string, string> =>
    Object.fromEntries(
      rows.flatMap((r) => r.kinds.map((k) => [`${r.pool.id}|${k}`, reserveInputText(r.mine[k])] as const)),
    );
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  // 池数据带实时用量，后台每次重拉都换引用；只跟池与窗口的形状走，否则没保存的草稿会被打回（#1871）。
  const shape = rows.map((r) => `${r.pool.id}:${r.kinds.join(',')}`).join(';');
  // biome-ignore lint/correctness/useExhaustiveDependencies: 服务端版本变了、池与窗口的形状变了才重置，不跟着输入、用量重置。
  useEffect(() => {
    setDraft(initial());
  }, [s?.version, shape]);
  const dirty = Object.entries(initial()).some(([k, v]) => (draft[k] ?? v) !== v);
  const submit = () => {
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

  const columns: TableColumn<ReserveRow>[] = [
    {
      key: 'pool',
      title: '渠道',
      // 拼车和独享两个池同属一个渠道：只写渠道名会出现两行一模一样的「Claude 订阅」，要带上池编号
      render: (_v, r) => <Text strong>{poolTitle(r.pool)}</Text>,
    },
    ...columnKinds.map(
      (k, i): TableColumn<ReserveRow> => ({
        key: k,
        title: reserveKindLabel(k, allWindows),
        render: (_v, r) => {
          if (r.kinds.length === 0)
            return i === 0 ? <Text tone="muted">还没读到额度窗，读到以后在这里配。</Text> : null;
          if (!r.kinds.includes(k)) return <Text tone="muted">无此窗</Text>;
          const dk = `${r.pool.id}|${k}`;
          return (
            <Stack direction="horizontal" gap="sm" align="center">
              <Input
                id={`reserve-${r.pool.id}-${k}`}
                aria-label={`${poolTitle(r.pool)} ${reserveKindLabel(k, r.pool.windows)}`}
                value={draft[dk] ?? ''}
                placeholder="—"
                onChange={(e) => setDraft((d) => ({ ...d, [dk]: e.target.value }))}
                width="xs"
              />
              <Text size="meta" tone="muted">
                %
              </Text>
            </Stack>
          );
        },
      }),
    ),
  ];

  return (
    // 表单包在区块外面：区块标题在表单里（e2e 和读屏都按「表单里有标题」找它）
    <Form onSubmit={submit}>
      <Section
        id="reserve"
        title={settingLabel['engine.quotaReserve']}
        actions={
          <SaveButton variant="secondary" canSave={dirty} pending={pending}>
            保存留量线
          </SaveButton>
        }
      >
        <Stack gap="md">
          <div data-testid="reserve-source">
            <Stack gap="sm">
              <Text size="meta" tone="muted">
                {RESERVE_SHORT}。{brand.terms.carpool}
                用不了时也不切过去，剩下的留给自己用。格子空着 = 未配置（不限）；写「{UNLIMITED_WORD}」=
                明确不限；写 0–100 = 用到这个百分比就停。
              </Text>
              {source.kind === 'missing' ? (
                <Notice tone="fail">
                  库里没有留量线：种子没装进库（发布时装载器没跑成？），引擎对所有渠道一律不派、不切，不当成不限。要现在恢复，在下面填好保存即可。
                </Notice>
              ) : source.kind === 'seed' ? (
                <Text size="meta" tone="muted">
                  {`现在的线来自种子（发布时装载器装的，还没人在${brand.product}改过）`}
                </Text>
              ) : (
                <Text size="meta" tone="muted">
                  {`现在的线是人在${brand.product}改过的${
                    source.by ? `（${whoChangedLabel(source.by, meForReserve, namesForReserve).text}）` : ''
                  }，发布时的种子不会覆盖它`}
                </Text>
              )}
            </Stack>
          </div>
          {problem ? (
            <Notice tone="fail">
              {`存着的留量线认不出（${problem}），引擎对所有渠道一律不派、不切，不当成不限；保存会整份换掉。`}
            </Notice>
          ) : null}
          {pools.error ? <LoadError what="渠道列表" error={pools.error} /> : null}
          {!pools.data && !pools.error ? <LoadingRows rows={2} /> : null}
          {pools.data ? (
            <Table columns={columns} rows={rows} rowKey={(r) => r.pool.id} caption="各渠道额度留量线" />
          ) : null}
          {source.kind === 'missing' ? null : <SettingMeta s={s} />}
        </Stack>
      </Section>
    </Form>
  );
}

const SECTIONS = [
  { id: 'repos', label: '仓库' },
  { id: 'run', label: '运行设置' },
  { id: 'reserve', label: '额度留量线' },
  { id: 'notify', label: '提醒' },
  { id: 'account', label: '账密登录' },
  { id: 'about', label: '关于' },
] as const;

// 默认收起的三节（#3707 批次 3）：仓库、运行设置、额度留量线三节常驻（改了要立刻看到），
// 提醒、账密登录、关于收起，行尾一行摘要。开合记在 ?open=（lib/section-open.ts）。

/** 提醒收起时的一行：免打扰时段开没开、开的是几点到几点。读不到写没读成，不写成「没开」。 */
function notifySummary(s: Setting | undefined): string {
  if (!s) return '设置在读…';
  const parsed = SETTING_SCHEMAS['notify.quietHours'].safeParse(s.value);
  if (!parsed.success) return '免打扰时段的值认不出';
  if (!parsed.data) return '免打扰时段没开';
  return `免打扰 ${parsed.data.start}–${parsed.data.end}`;
}

/** 账密登录收起时的一行：用户名是什么、多久前改过密码；还没设过照实写。 */
function credentialsSummary(c: Credentials | undefined): string {
  if (!c) return '账密状态在读…';
  if (!c.hasPassword) return '还没设过账密，只能用飞书登录';
  return `用户名 ${c.username ?? '（没有用户名）'}${
    c.passwordChangedAt ? ` · 上次改密码 ${formatAgo(c.passwordChangedAt, Date.now())}` : ''
  }`;
}

/** 关于收起时的一行：数据从哪来、减少动效开没开。 */
function aboutSummary(source: 'http' | 'mock', signedIn: boolean, reduced: boolean): string {
  return `${source === 'http' ? '真数据' : '假数据'} · 登录${signedIn ? '是创始人' : '没读到'} · 动效${
    reduced ? '已减少' : '跟随系统'
  }`;
}

/** 设置靠推送更新，没有自己的轮询。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const SETTINGS_STALE_AFTER_MS = 5 * TIME.MIN;

export default function Settings() {
  const theme = useTheme();
  const api = useApi();
  const { data: me } = useMe();
  const now = useNow();
  const { repos, loading: reposLoading, error: reposError } = useRepo();
  const settings = useSettings();
  // 收起时「账密登录」那一行要写用户名和多久前改过：和那一节里同一个读口（缓存共享，不另发请求）
  const credentials = useCredentials();
  // 页内目录点了收着的一节：先展开（写回 ?open=）再滚过去
  const foldPage = useSectionFoldPage();
  const dispatch = useRepoDispatch();
  const ciPolicy = useRepoCiPolicy();
  const { view: masterView } = useMasterView();
  // 读到总开关关着才写「总开关关着，不会派」；读不到不冒充关着
  const masterOff = masterView.kind === 'ok' && !masterView.master.on;
  const repoFailure = repoReadFailure(reposError, dispatch.error);
  const find = (k: SettingKey) => settings.data?.settings.find((s) => s.key === k);
  const [importOpen, setImportOpen] = useState(false);
  const staleSince = settings.dataUpdatedAt;

  const columns: TableColumn<Repo>[] = [
    {
      key: 'name',
      title: '仓库',
      render: (_v, r) => <RepoNameCell repo={{ owner: r.owner, name: r.name }} branch={r.defaultBranch} />,
    },
    {
      key: 'dispatch',
      title: '让 AI 接活',
      render: (_v, r) => (
        <DispatchState
          repoId={r.id}
          row={dispatch.data?.repos.find((d) => d.repoId === r.id)}
          masterOff={masterOff}
        />
      ),
    },
    {
      key: 'ci',
      title: 'CI 模式',
      render: (_v, r) => <CiState repoId={r.id} row={ciPolicy.data?.repos.find((d) => d.repoId === r.id)} />,
    },
    {
      key: 'actions',
      title: '操作',
      render: (_v, r) => (
        <Stack direction="horizontal" gap="sm" align="center">
          <DispatchAction
            repoId={r.id}
            name={`${r.owner}/${r.name}`}
            row={dispatch.data?.repos.find((d) => d.repoId === r.id)}
          />
          <GroomAction repoId={r.id} repo={{ owner: r.owner, name: r.name }} />
        </Stack>
      ),
    },
  ];

  return (
    <Page
      title="设置"
      description="保存带版本号，别人先改了会提示你刷新再改；改了都记进操作记录。"
      actions={
        <Button href="/audit" size="sm">
          操作记录
        </Button>
      }
      // 刷新在页头固定槽位（规范第三节「页头」），页面不自己摆
      refresh={{
        onRefresh: () => void settings.refetch(),
        isFetching: settings.isFetching,
        dataUpdatedAt: settings.dataUpdatedAt,
        staleAfterMs: SETTINGS_STALE_AFTER_MS,
      }}
    >
      <Grid preset="side">
        {/* 点目录跳到收着的一节：先展开再滚过去（#3707 批次 3）。没有上下文（单独渲染这一页）就只滚。 */}
        <Anchor items={SECTIONS} {...(foldPage ? { onPick: (id: string) => foldPage.open(id) } : {})} />
        <Stack>
          {settings.data && settings.error ? (
            <LoadStale
              error={settings.error}
              what="设置"
              when={staleSince ? formatAgo(new Date(staleSince).toISOString(), now) : undefined}
              expired={staleSince ? now - staleSince > SETTINGS_STALE_AFTER_MS : false}
            />
          ) : null}

          <Section
            id="repos"
            title={
              <>
                仓库
                {repos.length > 0 && !reposError ? <Tag>{repos.length}</Tag> : null}
              </>
            }
            actions={
              <Button size="sm" onClick={() => setImportOpen((v) => !v)}>
                导入仓库
              </Button>
            }
          >
            <Stack gap="md">
              {/* 总开关和按项目开关的关系（#1086）：总开关关＝全停，开＝只有接活开着的项目才派 */}
              <EngineMasterRelation />
              {repoFailure ? (
                <Stack gap="sm">
                  <LoadError text={repoFailure} error={reposError ?? dispatch.error} />
                  {reposError && repos.length ? (
                    <Text size="meta" tone="muted">
                      下面是上次读到的，可能不全。
                    </Text>
                  ) : null}
                </Stack>
              ) : null}
              {reposLoading ? <LoadingRows rows={2} /> : null}
              {repos.length > 0 ? (
                <Table
                  columns={columns}
                  rows={repos}
                  rowKey="id"
                  caption="仓库"
                  expandable={{
                    render: (r) => {
                      const name = `${r.owner}/${r.name}`;
                      const row = dispatch.data?.repos.find((d) => d.repoId === r.id);
                      return (
                        <Grid cols={3}>
                          <Stack gap="sm">
                            <Text strong>让 AI 接活</Text>
                            <Text size="meta" tone="muted">
                              开着：引擎每 5
                              分钟自己挑单（老单要指挥官整理过），没单可挑会自动叫指挥官整理。关着：只有本机命令
                              fleet-api dispatch-issue 点名派。
                              {row ? `${dispatchNote(row)}。` : '开关没读到。'}
                            </Text>
                          </Stack>
                          <RepoCiPolicyControl
                            repoId={r.id}
                            name={name}
                            row={ciPolicy.data?.repos.find((d) => d.repoId === r.id)}
                          />
                          <GroomDetail repoId={r.id} repo={{ owner: r.owner, name: r.name }} />
                        </Grid>
                      );
                    },
                  }}
                />
              ) : null}
              {/* 只有真读到了一个空列表才说「还没有仓」；没读成、还在读都不算。 */}
              {repos.length === 0 && !reposLoading && !reposError ? (
                <EmptyState
                  icon={FolderGit2}
                  title="还没有仓库"
                  hint="接进来的仓库默认不让 AI 接活，要另外打开。先「导入仓库」把机器人已经装上的仓接进来。"
                  action={<Button onClick={() => setImportOpen(true)}>导入仓库</Button>}
                />
              ) : null}
            </Stack>
          </Section>

          {importOpen ? <RepoImportSection onClose={() => setImportOpen(false)} /> : null}

          <Section id="run" title="运行设置">
            {/* 读失败后再重拉会先清掉 error、回到 pending。已经读过就不再画骨架。 */}
            {settings.data ? (
              <Stack gap="lg">
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
                  hint="判断题小模型每天最多调用多少次（0 = 不用它），留空 = 没设。"
                  unit="次 / 天"
                  placeholder="没设"
                />
                <SoloPaused s={find('engine.soloPaused')} />
                <CommanderSwitch s={find('engine.commander')} />
              </Stack>
            ) : settings.error ? (
              <LoadError error={settings.error} />
            ) : settings.isFetched ? null : (
              <LoadingRows rows={3} />
            )}
          </Section>

          {settings.data ? (
            <QuotaReserve s={find('engine.quotaReserve')} />
          ) : (
            <Section id="reserve" title={settingLabel['engine.quotaReserve']}>
              {settings.error ? (
                <LoadError error={settings.error} />
              ) : settings.isFetched ? null : (
                <LoadingRows rows={2} />
              )}
            </Section>
          )}

          <FoldSection
            id="notify"
            block="notify"
            title="提醒"
            summary={notifySummary(find('notify.quietHours'))}
          >
            <Stack gap="lg">
              {/* 和运行设置同一条：出错只留报错横幅，读过之后的重拉也不画骨架。 */}
              {settings.data ? (
                <QuietHours s={find('notify.quietHours')} />
              ) : settings.error ? (
                <LoadError error={settings.error} />
              ) : settings.isFetched ? null : (
                <LoadingRows rows={1} />
              )}
              {/* 装成 APP、系统通知、角标（#2050）：都是浏览器现读的，不依赖后端设置 */}
              <PwaStatus />
            </Stack>
          </FoldSection>

          <FoldSection
            id="account"
            block="account"
            title="账密登录"
            summary={credentialsSummary(credentials.data)}
          >
            <CredentialsSection />
          </FoldSection>

          <FoldSection
            id="about"
            block="about"
            title="关于"
            summary={aboutSummary(api.source, Boolean(me), theme.pref.motion === 'reduced')}
          >
            <Stack gap="md">
              {api.source === 'http' ? null : (
                <Notice tone="stall" role="status">
                  假数据（编的，会自己动；页面上的操作只改这份假数据）。
                </Notice>
              )}
              <Form aria-label="外观">
                <FormItem
                  label="减少动效"
                  help="在跑的卡片不再呼吸、进度条不再扫光。只存在这台浏览器里；亮暗跟随系统。"
                >
                  <Switch
                    checked={theme.pref.motion === 'reduced'}
                    onCheckedChange={(on) => theme.setMotion(on ? 'reduced' : 'system')}
                    aria-label="减少动效"
                  />
                </FormItem>
              </Form>
              <Descriptions
                columns={1}
                items={[
                  {
                    label: '数据',
                    value: api.source === 'http' ? `${brand.product}后端` : '假数据',
                  },
                  {
                    label: '登录',
                    value: me ? (
                      `${me.user.displayName}（飞书或账密，只放行创始人）`
                    ) : (
                      <Text tone="muted">没读到</Text>
                    ),
                  },
                ]}
              />
              <Text size="meta" tone="muted">
                操作记录里能看到每项设置是谁、什么时候改的：<TextLink to="/audit">去看操作记录</TextLink>。
              </Text>
            </Stack>
          </FoldSection>
        </Stack>
      </Grid>
    </Page>
  );
}
