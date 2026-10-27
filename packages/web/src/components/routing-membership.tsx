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
import { Button } from './layout/button';
import { ConfirmDialog } from './layout/confirm-dialog';
import { Dialog } from './layout/dialog';
import { List, RowDetail, RowFrame } from './layout/list';
import { Notice } from './layout/notice';
import {
  RowMenu,
  RowMenuItem,
  RowMenuLabel,
  RowMenuRadioGroup,
  RowMenuRadioItem,
  RowMenuSeparator,
} from './layout/row-menu';
import { SearchInput } from './layout/search-input';
import { Stack } from './layout/stack';
import { Text } from './layout/text';
import { TextInput } from './layout/text-input';
import { RowItem, WindowBox, WindowList } from './layout/windowed';
import { ROW_MENU_TITLE, RowMoveItems, type RowMoves, useRoutingEdit } from './routing-edit';

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
  // 尺寸一律写 px（#3697），设计值就是像素，不跟根字号缩
  const rowHeight = ADD_ROW_HEIGHT;
  const listHeight = ADD_LIST_HEIGHT;
  const total = rows.length * rowHeight;
  const range = windowRange({
    count: rows.length,
    rowHeight,
    height: listHeight,
    scrollTop,
  });
  return (
    <WindowBox
      windowed={rows.length > WINDOW_MIN_ROWS}
      height={Math.min(listHeight, total)}
      onScrollTop={setScrollTop}
    >
      <WindowList ariaLabel="可添加的模型" total={total}>
        {rows.slice(range.start, range.end).map((row, k) => {
          const index = range.start + k;
          if (row.kind === 'group') {
            return (
              <RowItem
                key={`group:${row.family}`}
                attrs={{ 'data-add-group': row.family }}
                top={index * rowHeight}
                height={rowHeight}
                posinset={index + 1}
                setsize={rows.length}
              >
                <RowFrame className="h-full">
                  <Text size="meta" tone="muted" strong>
                    {row.label}
                  </Text>
                </RowFrame>
              </RowItem>
            );
          }
          const m = row.model;
          const only = founderOnlyFor({ id: m.id, family: m.family, displayName: m.displayName });
          const blocked = only !== undefined && !founder;
          const why = disabledWhy ?? (blocked ? '仅创始人可开' : null);
          return (
            <RowItem
              key={m.id}
              attrs={{ 'data-add-model': m.id }}
              top={index * rowHeight}
              height={rowHeight}
              posinset={index + 1}
              setsize={rows.length}
            >
              <RowFrame className="h-full">
                <span className="min-w-0 flex-1">
                  <Stack direction="horizontal" gap="sm" align="baseline">
                    <Text strong truncate>
                      {m.displayName}
                    </Text>
                    <Text size="meta" tone="muted">
                      {m.family}
                    </Text>
                  </Stack>
                </span>
                <Stack direction="horizontal" gap="sm" align="center" justify="end">
                  {only ? (
                    <Text size="meta" tone="muted">
                      仅创始人可开
                    </Text>
                  ) : null}
                  <Button
                    size="xs"
                    {...(why !== null || pending ? { disabledReason: why ?? '正在添加，稍等' } : {})}
                    aria-label={`把 ${m.displayName} 加进用途`}
                    onClick={() => onPick(m.id)}
                  >
                    添加
                  </Button>
                </Stack>
              </RowFrame>
            </RowItem>
          );
        })}
      </WindowList>
    </WindowBox>
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
  // 目录没读到时 available 是空的只用来占位；下面先判 routing.data，没读到写「目录还在读」，不写「没有可加的模型」
  const catalog = routing.data?.models;
  const available = useMemo(() => (catalog ? catalog.filter((m) => !taken.has(m.id)) : []), [catalog, taken]);
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
        size="sm"
        title="从目录里挑一个，排到这个用途的末尾"
        {...(edit.disabledWhy !== null ? { disabledReason: edit.disabledWhy } : {})}
        onClick={() => {
          setQuery('');
          setOpen(true);
        }}
      >
        添加模型
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`往${purposeLabel(purpose.purpose)}里加模型`}
        description="只列目录里还没排进这个用途的。选定就加到末尾。"
      >
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜名字、编号"
          aria-label="搜索要添加的模型"
          className="md:max-w-none"
        />
        {routing.error ? (
          <Text tone="danger">{errorText(routing.error)}</Text>
        ) : !routing.data ? (
          <Text tone="muted">目录还在读</Text>
        ) : available.length === 0 ? (
          <Text tone="muted">没有可加的模型</Text>
        ) : rows.length === 0 ? (
          <Text tone="muted">没有能加的模型：换个搜索词，或目录里的都已经在这个用途里</Text>
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

/** 行上小字里写的档位（「档位 高」）；不另配不写。 */
export function effortWord(effort: SessionEffort | null | undefined): string | null {
  return effort ? EFFORT_WORD[effort] : null;
}

/**
 * 用途里这一行的行尾「⋯」菜单（路由页样板 #1914）：档位（单选，只列这个模型的路由都认的）、上移、下移、置顶、置底、移出。
 * 行里只留名字、状态和开关；这些都是偶尔才动的，收进菜单，各宽度同一个样子。
 */
export function PurposeModelMenu({
  purpose,
  model,
  onError,
  moves,
}: {
  purpose: RoutingLayerPurpose;
  model: RoutingLayerModel;
  onError: (message: string | null) => void;
  moves: RowMoves;
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
  const effortLocked = locked !== null || setEffort.isPending || blocked;
  const label = purposeLabel(purpose.purpose);
  return (
    <>
      <RowMenu label={`更多操作：${moves.label}`} title={ROW_MENU_TITLE}>
        {/* 档位：这个用途下另配的档。配不了的整组置灰，说明写在组头下面（以前铺在行里，#1754 收进悬停） */}
        <RowMenuLabel hint={locked ?? blockedWhy ?? undefined}>
          <span data-effort-label>{model.displayName} 的档位</span>
        </RowMenuLabel>
        <RowMenuRadioGroup
          aria-label={`${model.displayName} 的档位`}
          value={blocked ? '' : value}
          onValueChange={(next) => void saveEffort(next)}
        >
          <RowMenuRadioItem value="" disabled={effortLocked} title="不另配就按每条路由自己的档起会话">
            不另配
          </RowMenuRadioItem>
          {blocked
            ? null
            : options.map((effort) => (
                <RowMenuRadioItem
                  key={effort}
                  value={effort}
                  disabled={effortLocked}
                  title={EFFORT_HINT[effort]}
                >
                  {EFFORT_WORD[effort]}
                </RowMenuRadioItem>
              ))}
        </RowMenuRadioGroup>
        <RowMenuSeparator />
        <RowMoveItems moves={moves} />
        <RowMenuSeparator />
        <RowMenuItem
          variant="destructive"
          disabled={locked !== null}
          title={locked ?? `把 ${model.displayName} 移出${label}`}
          onSelect={() => setConfirm(true)}
        >
          移出{label}
        </RowMenuItem>
      </RowMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => !open && !remove.isPending && setConfirm(false)}
        title={`移出${purposeLabel(purpose.purpose)}？`}
        description={`把「${model.displayName}」移出这个用途。别的用途里的它不动。这个用途可以一个模型都不剩。`}
        confirmText="移出"
        onConfirm={runRemove}
      />
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
  const [dropKey, setDropKey] = useState<string | null>(null);
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
      throw err;
    }
  };

  return (
    <RowDetail indent={false}>
      <Stack gap="sm">
        <Text size="meta" tone="muted">
          这个渠道没有名册，模型串要手工登记。刷新后这里只留个数。
        </Text>
        {error ? <Notice tone="fail">{error}</Notice> : null}
        <form aria-label="手工登记模型串" onSubmit={(e) => void onRegister(e)}>
          <Stack direction="horizontal" gap="sm" align="center" wrap>
            <TextInput
              aria-label="模型串"
              value={key}
              disabled={locked !== null || register.isPending}
              onChange={setKey}
              placeholder="例如 claude-sonnet-x"
            />
            <Button
              type="submit"
              size="sm"
              loading={register.isPending}
              {...(locked !== null
                ? { disabledReason: locked }
                : key.trim() === ''
                  ? { disabledReason: '先填模型串' }
                  : {})}
            >
              登记
            </Button>
            {noted ? <Text>已登记 {noted}</Text> : null}
          </Stack>
        </form>
        {keys.length > 0 ? (
          <List divided={false} aria-label="已登记的模型串">
            {keys.map((item) => (
              <li key={item}>
                <Stack direction="horizontal" gap="sm" align="center" justify="between">
                  <Text truncate>{item}</Text>
                  <Button
                    size="xs"
                    variant="text"
                    loading={revoke.isPending}
                    {...(locked !== null ? { disabledReason: locked } : {})}
                    aria-label={`撤掉 ${item}`}
                    onClick={() => setDropKey(item)}
                  >
                    撤掉
                  </Button>
                </Stack>
              </li>
            ))}
          </List>
        ) : null}
      </Stack>
      <ConfirmDialog
        open={dropKey !== null}
        onOpenChange={(open) => !open && setDropKey(null)}
        title="撤掉这个模型串？"
        description={`从这张手工登记的名单里拿掉${dropKey ? `「${dropKey}」` : ''}。路由目录里的模型不动。`}
        confirmText="撤掉"
        onConfirm={async () => {
          if (!dropKey) return;
          await drop(dropKey);
        }}
      />
    </RowDetail>
  );
}
