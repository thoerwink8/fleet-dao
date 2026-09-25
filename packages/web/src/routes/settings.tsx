import { SETTING_SCHEMAS } from '@fleet-dao/shared';
import type { LucideIcon } from 'lucide-react';
import { BellRing, FolderGit2, Info, Palette, SlidersHorizontal } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ApiError, errorText, useApi, useMe, useSettings, useUpdateSetting } from '../api/client';
import type { Setting, SettingKey } from '../api/types';
import { LoadError, LoadingRows, Page } from '../components/page';
import { useRepo } from '../components/repo-context';
import { PaletteSwatch } from '../components/shell/palette-swatch';
import { ModeSwitch } from '../components/shell/topbar';
import { StatusDot } from '../components/status';
import { useTheme } from '../components/theme-provider';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { settingLabel } from '../lib/audit';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { isMine, TONES, toneLabel } from '../lib/status';
import { PALETTES } from '../lib/theme';

export function meta() {
  return [{ title: '设置 · fleet-dao 驾驶舱' }];
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
      className="scroll-mt-6 grid gap-4 border-b py-8 first:pt-0 last:border-b-0 lg:grid-cols-[240px_1fr]"
    >
      <div>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
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
            北京时间。免打扰时段里飞书不响；驾驶舱里照常能看到。
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

export default function Settings() {
  const theme = useTheme();
  const api = useApi();
  const { data: me } = useMe();
  const { repos, loading: reposLoading, error: reposError } = useRepo();
  const settings = useSettings();
  const find = (k: SettingKey) => settings.data?.settings.find((s) => s.key === k);

  return (
    <Page title="设置" description="外观只存在这台浏览器里；运行设置存在后端，改了写进操作记录。">
      <Section
        id="look"
        icon={Palette}
        title="外观"
        description="多套主题色，每套都有深浅两版；切换即时生效，下次打开还是它。"
      >
        <div className="mb-5 max-w-sm">
          <ModeSwitch />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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

      <Section
        id="run"
        icon={SlidersHorizontal}
        title="运行设置"
        description="存在后端。保存时带上你看到的版本号：别人先改了会提示你刷新再改，不会悄悄盖掉。"
      >
        {settings.error ? <LoadError error={settings.error} /> : null}
        {!settings.data ? (
          <LoadingRows rows={2} />
        ) : (
          <div className="grid max-w-3xl gap-3 md:grid-cols-2">
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
          </div>
        )}
      </Section>

      <Section
        id="notify"
        icon={BellRing}
        title="提醒"
        description="飞书和驾驶舱只推三类：要你拍、卡住报警、日报。进度不主动推，问了才给。"
      >
        {!settings.data ? (
          <LoadingRows rows={1} />
        ) : (
          <div className="max-w-md">
            <QuietHours s={find('notify.quietHours')} />
          </div>
        )}
      </Section>

      <Section
        id="repos"
        icon={FolderGit2}
        title="仓库"
        description="接进来的仓。一个仓接进来要满足：测试能跑、有一页 AGENTS.md。"
      >
        {reposError ? (
          <div className="mb-3 max-w-xl">
            <LoadError what="仓列表" error={reposError} />
            {repos.length ? (
              <p className="mt-1 text-xs text-muted-foreground">下面是上次读到的，可能不全。</p>
            ) : null}
          </div>
        ) : null}
        {reposLoading ? <LoadingRows rows={1} /> : null}
        <ul className="max-w-xl divide-y rounded-xl border bg-card empty:hidden">
          {repos.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
              <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="num truncate text-sm font-medium">
                  {r.owner}/{r.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  主线 <span className="num">{r.defaultBranch}</span>
                </div>
              </div>
            </li>
          ))}
          {/* 只有真读到了一个空列表才说「还没有仓」；没读成、还在读都不算。 */}
          {repos.length === 0 && !reposLoading && !reposError ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">还没有仓</li>
          ) : null}
        </ul>
      </Section>

      <Section id="about" icon={Info} title="关于" description="驾驶舱 v1 的前端。">
        <dl className="grid max-w-md grid-cols-[96px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">数据</dt>
          <dd>
            {api.source === 'mock'
              ? '假数据（按设计文档编的，会自己动）'
              : '驾驶舱后端（/api），推送走 /api/events'}
          </dd>
          <dt className="text-muted-foreground">登录</dt>
          <dd>{me ? `${me.user.displayName}（飞书账号，只放行创始人）` : '—'}</dd>
          <dt className="text-muted-foreground">接口约定</dt>
          <dd className="num text-xs leading-5">packages/shared/src/web-api.ts</dd>
        </dl>
      </Section>
    </Page>
  );
}
