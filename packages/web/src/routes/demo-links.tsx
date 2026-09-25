// 「演示版」页（只在正式驾驶舱里有）：发演示链接、作废、定默认范围。设计文档第十四节。
// 每条链接带一份可见范围（哪些模块、细节到哪一级、有效期）；后端把范围发布成香港上的静态文件，
// 演示版只读它。口令只在发出来的那一下显示一次，驾驶舱和后端都不留原文（只留它的哈希）。

import { DEMO_MODULES, DEMO_STRICT_DEFAULT } from '@fleet-dao/shared';
import { Check, Copy, EyeOff, Link2, TriangleAlert, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  errorText,
  useCreateDemoLink,
  useDemoLinks,
  useRevokeDemoLink,
  useUpdateDemoDefault,
} from '../api/client';
import type { CreatedDemoLink, DemoLink, DemoScopeView } from '../api/types';
import { LoadError, LoadingRows, Page, Panel } from '../components/page';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { DETAIL_LABEL, MODULE_LABEL } from '../demo/labels';
import type { DemoDetail, DemoModule } from '../demo/scope';
import { DEMO_URL, demoLinkUrl } from '../demo/url';
import { formatAgo, formatDateTime, formatIn } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('演示版') }];
}

const DAYS = [1, 3, 7, 14, 30, 90] as const;
const DETAILS: DemoDetail[] = ['status', 'titles', 'process'];

function ScopeEditor({
  modules,
  detail,
  onModules,
  onDetail,
  idPrefix,
}: {
  modules: DemoModule[];
  detail: DemoDetail;
  onModules(m: DemoModule[]): void;
  onDetail(d: DemoDetail): void;
  idPrefix: string;
}) {
  const toggle = (m: DemoModule) =>
    onModules(
      modules.includes(m)
        ? modules.filter((x) => x !== m)
        : DEMO_MODULES.filter((x) => x === m || modules.includes(x)),
    );
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-xs text-muted-foreground">能看哪些模块</legend>
        <div className="flex flex-wrap gap-1.5">
          {DEMO_MODULES.map((m) => {
            const on = modules.includes(m);
            return (
              <label
                key={m}
                className={cn(
                  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                  on
                    ? 'border-foreground/40 bg-accent font-medium'
                    : 'text-muted-foreground hover:bg-accent/60',
                )}
              >
                <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(m)} />
                {on ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <EyeOff className="size-3.5" aria-hidden />
                )}
                {MODULE_LABEL[m].label}
                {MODULE_LABEL[m].hint ? (
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {MODULE_LABEL[m].hint}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-xs text-muted-foreground">细节看到哪一级</legend>
        <div className="grid gap-1.5 sm:grid-cols-3">
          {DETAILS.map((d) => (
            <label
              key={d}
              className={cn(
                'cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                detail === d ? 'border-foreground/40 bg-accent' : 'hover:bg-accent/60',
              )}
            >
              <input
                type="radio"
                name={`${idPrefix}-detail`}
                className="sr-only"
                checked={detail === d}
                onChange={() => onDetail(d)}
              />
              <span className={cn('block text-sm', detail === d && 'font-medium')}>
                {DETAIL_LABEL[d].label}
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{DETAIL_LABEL[d].hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function scopeText(s: { modules: readonly DemoModule[]; detail: DemoDetail }): string {
  const mods = s.modules.map((m) => MODULE_LABEL[m].label).join('、') || '一个模块都不开';
  return `${mods} · ${DETAIL_LABEL[s.detail].label}`;
}

/** 刚发出来的链接：口令只显示这一次。 */
function Created({ created, onClose }: { created: CreatedDemoLink; onClose(): void }) {
  const full = demoLinkUrl(created.token);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('复制好了');
    } catch (e) {
      toast.error('没复制上，手动选中复制', { description: errorText(e) });
    }
  };
  return (
    <div role="status" className="mb-4 rounded-xl border border-st-done/40 bg-st-done/[0.07] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Link2 className="size-4 text-ink-done" aria-hidden />
            链接发好了
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            口令只显示这一次：关掉就再也看不到了（后端只留它的哈希）。要再发一条就重新发。
          </p>
        </div>
        <Button size="icon" variant="ghost" className="size-7" onClick={onClose} aria-label="关掉">
          <X />
        </Button>
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          readOnly
          aria-label="演示链接"
          value={full}
          className="num h-8 text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button size="sm" onClick={() => void copy(full)}>
          <Copy />
          复制链接
        </Button>
      </div>
    </div>
  );
}

function LinkRow({ link, now }: { link: DemoLink; now: number }) {
  const revoke = useRevokeDemoLink();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  const doRevoke = () =>
    revoke.mutate(link.id, {
      onSuccess: () =>
        toast.success(link.expired ? '删掉了这条过期链接' : '作废了：拿着这条链接的人马上就只能看默认范围'),
      onError: (e) => toast.error('没作废成', { description: errorText(e) }),
    });
  return (
    <li className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{link.note ?? '（没写备注）'}</span>
          {link.expired ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground">
              已过期
            </Badge>
          ) : (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-ink-done">
              有效 · {formatIn(link.expiresAt, now)}到期
            </Badge>
          )}
          <span className="num text-[11px] text-faint" title={link.id}>
            {link.id.slice(0, 8)}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{scopeText(link)}</div>
        <div className="mt-0.5 text-[11px] text-faint">
          {/* 页面的钟每隔一会儿才走一下，刚发的那条会比它新：按「刚刚」算，不写成「1 秒后」 */}
          {formatAgo(link.createdAt, Math.max(now, Date.parse(link.createdAt)))}发 · 到期{' '}
          {formatDateTime(link.expiresAt)}
        </div>
      </div>
      {confirming ? (
        <div className="flex gap-1.5">
          <Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={doRevoke}>
            确定{link.expired ? '删掉' : '作废'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            取消
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          {link.expired ? '删掉' : '作废'}
        </Button>
      )}
    </li>
  );
}

function DefaultScope({ scope, published }: { scope: DemoScopeView; published: boolean }) {
  const save = useUpdateDemoDefault();
  const [modules, setModules] = useState<DemoModule[]>(scope.modules);
  const [detail, setDetail] = useState<DemoDetail>(scope.detail);
  const key = `${scope.modules.join(',')}|${scope.detail}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在后端的默认范围变了时跟上。
  useEffect(() => {
    setModules(scope.modules);
    setDetail(scope.detail);
  }, [key]);
  const dirty = modules.join(',') !== scope.modules.join(',') || detail !== scope.detail;
  return (
    <Panel
      title="默认范围"
      description="不带链接打开演示版的人按这一份看。默认从严。"
      actions={
        <Button
          size="sm"
          disabled={save.isPending || (published && !dirty)}
          onClick={() =>
            save.mutate(
              { modules, detail },
              {
                onSuccess: () => toast.success('默认范围发布了：不带链接的游客马上按它看'),
                onError: (e) => toast.error('没发布成', { description: errorText(e) }),
              },
            )
          }
        >
          发布默认范围
        </Button>
      }
    >
      <p className={cn('mb-4 text-xs', published ? 'text-muted-foreground' : 'text-ink-stall')}>
        {published
          ? `现在发布的是：${scopeText(scope)}`
          : `还没发布过：游客按内置的最严范围看（${scopeText(DEMO_STRICT_DEFAULT)}）。`}
      </p>
      <ScopeEditor
        idPrefix="default"
        modules={modules}
        detail={detail}
        onModules={setModules}
        onDetail={setDetail}
      />
    </Panel>
  );
}

export default function DemoLinks() {
  const q = useDemoLinks();
  const create = useCreateDemoLink();
  const now = useNow();
  const [modules, setModules] = useState<DemoModule[]>(['board', 'task']);
  const [detail, setDetail] = useState<DemoDetail>('titles');
  const [days, setDays] = useState<number>(7);
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<CreatedDemoLink | null>(null);
  const data = q.data;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { modules, detail, expiresInDays: days, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (res) => {
          setCreated(res);
          setNote('');
        },
        onError: (err) => toast.error('没发成', { description: errorText(err) }),
      },
    );
  };

  const links = data?.links ?? [];
  const live = links.filter((l) => !l.expired);
  const expired = links.filter((l) => l.expired);

  return (
    <Page
      title="演示版"
      description="发给别人看的演示链接：全是假数据、不用登录，页面上的操作只在对方浏览器里演示。每条链接带一份可见范围，随时作废。"
    >
      {q.error ? <LoadError what="演示链接" error={q.error} /> : null}
      {!data && !q.error ? <LoadingRows rows={4} /> : null}
      {data && !data.configured ? (
        <div
          role="alert"
          className="mb-4 flex gap-2 rounded-xl border border-st-stall/40 bg-st-stall/[0.07] p-4 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ink-stall" aria-hidden />
          <div>
            后端没配演示版的发布目录（FLEET_DEMO_DIR），现在发不了链接、也改不了默认范围。
            <span className="text-muted-foreground">
              {' '}
              演示版照常能看：不带链接的游客按内置的最严范围（{scopeText(DEMO_STRICT_DEFAULT)}）。
            </span>
          </div>
        </div>
      ) : null}
      {data ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="min-w-0 space-y-4">
            {created ? <Created created={created} onClose={() => setCreated(null)} /> : null}
            <Panel title="发一条新链接" description="发给谁、能看什么、看多久。">
              <form onSubmit={submit} className="space-y-4">
                <ScopeEditor
                  idPrefix="new"
                  modules={modules}
                  detail={detail}
                  onModules={setModules}
                  onDetail={setDetail}
                />
                <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                  <div>
                    <Label htmlFor="demo-days" className="mb-1.5 text-xs text-muted-foreground">
                      有效期
                    </Label>
                    <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                      <SelectTrigger id="demo-days" size="sm" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DAYS.map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            {d} 天
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="demo-note" className="mb-1.5 text-xs text-muted-foreground">
                      备注（发给谁、为什么；只在这里看得到）
                    </Label>
                    <Input
                      id="demo-note"
                      value={note}
                      maxLength={60}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="例如：给投资人看"
                      className="h-8"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={!data.configured || !modules.length || create.isPending}>
                    <Link2 />
                    发链接
                  </Button>
                  {!modules.length ? (
                    <span className="text-xs text-ink-stall">至少开一个模块</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{scopeText({ modules, detail })}</span>
                  )}
                </div>
              </form>
            </Panel>

            <Panel
              title="已发的链接"
              description="作废 = 撤掉那份范围文件：拿着链接的人刷新后只能看默认范围。"
              bodyClassName="p-0"
            >
              {links.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">还没发过演示链接</p>
              ) : (
                <ul className="divide-y">
                  {[...live, ...expired].map((l) => (
                    <LinkRow key={l.id} link={l} now={now} />
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          <div className="space-y-4">
            <DefaultScope scope={data.defaultScope} published={data.defaultPublished} />
            <p className="px-1 text-xs text-muted-foreground">
              演示版地址：
              <a
                href={DEMO_URL}
                target="_blank"
                rel="noreferrer"
                className="num underline underline-offset-2"
              >
                {new URL(DEMO_URL, location.origin).href}
              </a>
              <span className="block text-faint">（发布时由 release.env 的 FLEET_DEMO_PATH 定）</span>
            </p>
          </div>
        </div>
      ) : null}
    </Page>
  );
}
