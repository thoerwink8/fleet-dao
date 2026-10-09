// 路由页上改用途成员和手工登记（#1380）：加模型、移出、选档位、给没有名册的渠道登记模型串。
// 改这里之前必须知道：
// - 不先改页面上的名单。版本对不上、硬禁令、档位不认，都等接口回了再重拉；失败把原话写在行外的 alert 里，名单不动。
// - Fable 能不能加，页面只在按钮上标「仅创始人可开」（决定 0033）。真拒绝仍是后端的 guard。
// - 名册接口只回「这个渠道手工登记了几个」，不回模型串。这一页把登记接口返回的串留在当次会话里，刷新就只剩个数。
// - 「添加模型」候选按厂家分组，行数超过 50 只画窗口里的行（lib/list-window.ts）。组标题和模型行同高，窗口才算得准。

import { founderOnlyFor, type HostId, routeEffortChoices, type SessionEffort } from '@fleet-dao/shared';
import { type FormEvent, useMemo, useState } from 'react';
import {
  errorText,
  useAddPurposeModel,
  useMe,
  useRegisterChannelModel,
  useRemovePurposeModel,
  useRevokeChannelModel,
  useRouting,
  useSetPurposeModelEffort,
} from '../api/client';
import type { Model, RoutingLayerModel, RoutingLayerPurpose } from '../api/types';
import { EFFORT_HINT } from '../lib/efforts';
import { WINDOW_MIN_ROWS, windowRange } from '../lib/list-window';
import { purposeLabel } from '../lib/routing';
import { supportedPurposeEfforts } from '../lib/routing-browse';
import { cn } from '../lib/utils';
import { TAP, useRoutingEdit } from './routing-edit';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

/** 没有名册命令、靠手工登记的渠道。种子里叫「Claude 订阅」，真渠道编号是 claude-sub。 */
export function isManualChannel(
  channelId: string,
  channelName: string,
  manual: readonly { channelId: string }[] | undefined,
): boolean {
  return (
    channelId === 'claude-sub' ||
    channelName === 'Claude 订阅' ||
    (manual ?? []).some((item) => item.channelId === channelId)
  );
}

/** 弹窗里一行的高度。和目录紧凑行一样，窗口化靠它算位置。 */
const ADD_ROW_HEIGHT = 44;
/** 弹窗候选列表的可视高度。超过 50 行只画窗口里的。 */
const ADD_LIST_HEIGHT = 320;

type AddRow = { kind: 'group'; family: string; label: string } | { kind: 'model'; model: Model };

/** 按厂家分组：组标题在前，组内按显示名。没有厂家的归到「未标明厂家」。 */
function addRows(models: readonly Model[]): AddRow[] {
  const buckets = new Map<string, Model[]>();
  for (const model of models) {
    const key = model.family.trim();
    const list = buckets.get(key);
    if (list) list.push(model);
    else buckets.set(key, [model]);
  }
  const rows: AddRow[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a.localeCompare(b, 'zh'))) {
    const members = buckets.get(key) ?? [];
    members.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh') || a.id.localeCompare(b.id));
    rows.push({ kind: 'group', family: key, label: key === '' ? '未标明厂家' : key });
    for (const model of members) rows.push({ kind: 'model', model });
  }
  return rows;
}

function addRowStyle(index: number) {
  return {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: index * ADD_ROW_HEIGHT,
    height: ADD_ROW_HEIGHT,
  };
}

function AddCandidateList({
  rows,
  founder,
  pending,
  disabledWhy,
  onPick,
}: {
  rows: readonly AddRow[];
  founder: boolean;
  pending: boolean;
  disabledWhy: string | null;
  onPick: (modelId: string) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const total = rows.length * ADD_ROW_HEIGHT;
  const range = windowRange({
    count: rows.length,
    rowHeight: ADD_ROW_HEIGHT,
    height: ADD_LIST_HEIGHT,
    scrollTop,
  });
  return (
    <div
      data-windowed={rows.length > WINDOW_MIN_ROWS ? 'true' : undefined}
      style={{ height: Math.min(ADD_LIST_HEIGHT, total) }}
      className="overflow-y-auto overscroll-contain"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <ul aria-label="可添加的模型" className="relative" style={{ height: total }}>
        {rows.slice(range.start, range.end).map((row, k) => {
          const index = range.start + k;
          if (row.kind === 'group') {
            return (
              <li
                key={`group:${row.family}`}
                data-add-group={row.family}
                aria-posinset={index + 1}
                aria-setsize={rows.length}
                style={addRowStyle(index)}
                className="border-b"
              >
                <div className="flex h-full items-center px-2 text-caption font-semibold text-muted-foreground">
                  {row.label}
                </div>
              </li>
            );
          }
          const m = row.model;
          const only = founderOnlyFor({ id: m.id, family: m.family, displayName: m.displayName });
          const blocked = only !== undefined && !founder;
          const why = disabledWhy ?? (blocked ? '仅创始人可开' : null);
          return (
            <li
              key={m.id}
              data-add-model={m.id}
              aria-posinset={index + 1}
              aria-setsize={rows.length}
              style={addRowStyle(index)}
              className="flex items-center gap-2 border-b px-1"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{m.displayName}</span>
                <span className="ml-2 text-caption text-muted-foreground">{m.family}</span>
              </span>
              {only ? <span className="shrink-0 text-micro text-muted-foreground">仅创始人可开</span> : null}
              <Button
                type="button"
                size="xs"
                disabled={why !== null || pending}
                title={why ?? undefined}
                aria-label={`把 ${m.displayName} 加进用途`}
                onClick={() => onPick(m.id)}
              >
                添加
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AddPurposeModel({
  purpose,
  onError,
}: {
  purpose: RoutingLayerPurpose;
  onError: (message: string | null) => void;
}) {
  const edit = useRoutingEdit();
  const me = useMe();
  const routing = useRouting();
  const add = useAddPurposeModel();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const founder = me.data?.user.role === 'founder';
  const taken = useMemo(() => new Set(purpose.models.map((m) => m.modelId)), [purpose.models]);
  const available = useMemo(
    () => (routing.data?.models ?? []).filter((m) => !taken.has(m.id)),
    [routing.data?.models, taken],
  );
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return available;
    return available.filter((m) => `${m.displayName} ${m.id} ${m.family}`.toLowerCase().includes(q));
  }, [available, query]);
  const rows = useMemo(() => addRows(candidates), [candidates]);

  const pick = async (modelId: string) => {
    try {
      await add.mutateAsync({ purpose: purpose.purpose, body: { modelId, version: purpose.version } });
      onError(null);
      setOpen(false);
      setQuery('');
    } catch (e) {
      onError(errorText(e));
      setOpen(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={edit.disabledWhy !== null}
        title={edit.disabledWhy ?? '从目录里挑一个，排到这个用途的末尾'}
        onClick={() => {
          setQuery('');
          setOpen(true);
        }}
      >
        添加模型
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader className="text-left">
            <DialogTitle>往{purposeLabel(purpose.purpose)}里加模型</DialogTitle>
            <DialogDescription>只列目录里还没排进这个用途的。选定就加到末尾。</DialogDescription>
          </DialogHeader>
          <label className="block">
            <span className="sr-only">搜索要添加的模型</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜名字、编号"
              aria-label="搜索要添加的模型"
              className="h-9 w-full rounded-lg border bg-background px-2.5 text-sub outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </label>
          {routing.error ? (
            <p className="text-sub text-ink-fail">{errorText(routing.error)}</p>
          ) : !routing.data ? (
            <p className="text-sub text-muted-foreground">目录还在读</p>
          ) : available.length === 0 ? (
            <p className="text-sub text-muted-foreground">没有可加的模型</p>
          ) : rows.length === 0 ? (
            <p className="text-sub text-muted-foreground">
              没有能加的模型：换个搜索词，或目录里的都已经在这个用途里
            </p>
          ) : (
            <AddCandidateList
              key={query}
              rows={rows}
              founder={founder}
              pending={add.isPending}
              disabledWhy={edit.disabledWhy}
              onPick={(id) => void pick(id)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const EFFORT_WORD: Record<SessionEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

/** 一档都认不了时，写明为什么。下拉置灰，只留「不另配」。 */
function effortBlockedWhy(modelId: string, routes: readonly { hostId: HostId }[]): string | null {
  if (supportedPurposeEfforts(modelId, routes).length > 0) return null;
  for (const route of routes) {
    const choices = routeEffortChoices(route.hostId, modelId);
    if (choices.kind === 'fixed') return choices.why;
  }
  if (routes.length === 0) return '一条路由都没有，没有能配的档位';
  return '这几条路由没有共同认的档位';
}

/** 用途里这一行的档位和「移出」。档位只列这个模型的路由都认的。 */
export function PurposeModelControls({
  purpose,
  model,
  onError,
}: {
  purpose: RoutingLayerPurpose;
  model: RoutingLayerModel;
  onError: (message: string | null) => void;
}) {
  const edit = useRoutingEdit();
  const setEffort = useSetPurposeModelEffort();
  const remove = useRemovePurposeModel();
  const [confirm, setConfirm] = useState(false);
  // 暂选挂在改之前的档位上：接口回了新档位，或失败清掉，下拉就回到服务端的值。
  const [draft, setDraft] = useState<{ base: string; value: string } | null>(null);
  const routeHosts = model.routes.map((r) => ({ hostId: r.hostId }));
  const supported = supportedPurposeEfforts(model.modelId, routeHosts);
  const blockedWhy = effortBlockedWhy(model.modelId, routeHosts);
  const current = model.effort ?? null;
  const server = current ?? '';
  const options = current !== null && !supported.includes(current) ? [current, ...supported] : supported;
  const pending = draft !== null && draft.base === server ? draft.value : null;
  const value = pending ?? server;

  const saveEffort = async (next: string) => {
    const effort: SessionEffort | null = next === '' ? null : (next as SessionEffort);
    if (effort === current || edit.disabledWhy) return;
    setDraft({ base: server, value: next });
    try {
      await setEffort.mutateAsync({
        purpose: purpose.purpose,
        modelId: model.modelId,
        body: { effort, version: purpose.version },
      });
      onError(null);
    } catch (e) {
      setDraft(null);
      onError(errorText(e));
    }
  };

  const runRemove = async () => {
    try {
      await remove.mutateAsync({
        purpose: purpose.purpose,
        modelId: model.modelId,
        body: { version: purpose.version },
      });
      onError(null);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setConfirm(false);
    }
  };

  const locked = edit.disabledWhy;
  const blocked = blockedWhy !== null;
  return (
    <>
      <select
        aria-label={`${model.displayName} 的档位`}
        value={blocked ? '' : value}
        disabled={locked !== null || setEffort.isPending || blocked}
        title={locked ?? blockedWhy ?? '这个用途下另配的档位。不另配就按每条路由自己的档起会话'}
        onChange={(e) => void saveEffort(e.target.value)}
        className={cn(
          'h-6 max-w-28 shrink-0 rounded border bg-background px-1 text-caption disabled:cursor-not-allowed disabled:opacity-60',
          TAP,
        )}
      >
        <option value="">不另配</option>
        {blocked
          ? null
          : options.map((effort) => (
              <option key={effort} value={effort} title={EFFORT_HINT[effort]}>
                {EFFORT_WORD[effort]}
              </option>
            ))}
      </select>
      {blockedWhy ? (
        <span
          data-row-note
          title={blockedWhy}
          className="order-last basis-full shrink-0 whitespace-normal break-words text-micro leading-snug text-muted-foreground md:w-full"
        >
          {blockedWhy}
        </span>
      ) : null}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className={TAP}
        disabled={locked !== null}
        title={locked ?? `把 ${model.displayName} 移出${purposeLabel(purpose.purpose)}`}
        aria-label={`把 ${model.displayName} 移出用途`}
        onClick={() => setConfirm(true)}
      >
        移出
      </Button>
      <AlertDialog open={confirm} onOpenChange={(open) => !open && !remove.isPending && setConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移出{purposeLabel(purpose.purpose)}？</AlertDialogTitle>
            <AlertDialogDescription>
              把「{model.displayName}」移出这个用途。别的用途里的它不动。这个用途可以一个模型都不剩。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>先不</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                void runRemove();
              }}
            >
              移出
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** 没有名册的渠道：登记一个模型串。撤掉只在已登记列表里，每条自己一个。 */
export function ManualModelForm({ channelId }: { channelId: string }) {
  const edit = useRoutingEdit();
  const register = useRegisterChannelModel();
  const revoke = useRevokeChannelModel();
  const [key, setKey] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const [noted, setNoted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = edit.disabledWhy;

  const onRegister = async (e: FormEvent) => {
    e.preventDefault();
    const modelKey = key.trim();
    if (!modelKey || locked) return;
    try {
      const res = await register.mutateAsync({ channelId, body: { modelKey } });
      setKeys((prev) => (prev.includes(res.modelKey) ? prev : [...prev, res.modelKey]));
      setKey('');
      setNoted(res.modelKey);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const drop = async (modelKey: string) => {
    if (locked) return;
    try {
      await revoke.mutateAsync({ channelId, body: { modelKey } });
      setKeys((prev) => prev.filter((item) => item !== modelKey));
      setNoted((prev) => (prev === modelKey ? null : prev));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-2 border-b px-3 py-3">
      <p className="text-caption text-muted-foreground">
        这个渠道没有名册，模型串要手工登记。刷新后这里只留个数。
      </p>
      {error ? (
        <p role="alert" className="rounded-md border border-ink-fail px-2 py-1.5 text-sub text-ink-fail">
          {error}
        </p>
      ) : null}
      <form
        aria-label="手工登记模型串"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => void onRegister(e)}
      >
        <input
          aria-label="模型串"
          value={key}
          disabled={locked !== null || register.isPending}
          onChange={(e) => setKey(e.target.value)}
          placeholder="例如 claude-sonnet-x"
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sub outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <Button type="submit" size="sm" disabled={locked !== null || register.isPending || key.trim() === ''}>
          登记
        </Button>
        {noted ? <p className="text-sub text-ink-done">已登记 {noted}</p> : null}
      </form>
      {keys.length > 0 ? (
        <ul aria-label="已登记的模型串" className="space-y-1">
          {keys.map((item) => (
            <li key={item} className="flex items-center gap-2 text-sub">
              <span className="min-w-0 flex-1 truncate">{item}</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className={TAP}
                disabled={locked !== null || revoke.isPending}
                aria-label={`撤掉 ${item}`}
                onClick={() => void drop(item)}
              >
                撤掉
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
