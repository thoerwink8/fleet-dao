// 一条需求的「⋯」菜单（#2062）：列表每行和对话头部共用。菜单项只出现详情 actions 里能做的（request-view.ts 的 menuFor），
// 删不了时不出现「删除」，悬停「放下」「归档」写为什么不能删。删除先弹确认框（30 天后彻底删除，之前能在「最近删除」里恢复）；
// 放下、改名要写一句，也在框里写。列表行没有详情：菜单打开时才去读这一条（读不到写原因，不出一个空菜单）。
import { Copy, LoaderCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRequestAction, useRequestDetail } from '../../api/client';
import type { RequestActionBody, RequestActions } from '../../api/types';
import { ConfirmDialog } from '../layout/confirm-dialog';
import { Input, Textarea } from '../layout/input';
import { RowMenu, RowMenuItem, RowMenuLabel, RowMenuSeparator } from '../layout/row-menu';
import { Stack } from '../layout/stack';
import { Text } from '../layout/text';
import { deleteNote, type MenuAction, menuFor } from './request-view';

/** 删除确认框的话（方案第三节；测试和点验都按这一句找）。 */
export const DELETE_CONFIRM_TEXT = '30 天后彻底删除，之前可以在『最近删除』里恢复。';

const DONE_WORDS: Partial<Record<MenuAction, string>> = {
  pin: '已置顶',
  unpin: '已取消置顶',
  withdraw: '已撤回到讨论中',
  reopen: '已重开，回到讨论中',
  archive: '已归档',
  unarchive: '已取消归档',
  restore: '已恢复，回到原来的地方',
  delete: '已删除：30 天内可以在「最近删除」里恢复',
  drop: '已放下，进了已归档',
  rename: '已改名',
};

type Dialog = 'delete' | 'drop' | 'rename' | null;

export function RequestMenu({
  seq,
  title,
  actions,
  loading = false,
  error,
  open,
  onOpenChange,
  variant,
  header,
  onDone,
}: {
  seq: number;
  title: string;
  actions: RequestActions | undefined;
  loading?: boolean;
  /** 读详情没成的原因：写在菜单里，不出一个空菜单。 */
  error?: string | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** row：列表行尾，平时极淡、悬停这一行才变实；head：对话头部，一直实着。 */
  variant: 'row' | 'head';
  /** 菜单顶上的几行说明（项目、需求号）。 */
  header?: ReactNode;
  onDone?: (action: MenuAction) => void;
}) {
  const act = useRequestAction();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [name, setName] = useState(title);

  const run = async (body: RequestActionBody, action: MenuAction) => {
    try {
      await act.mutateAsync({ seq, body });
      toast.success(`需求 ${seq} ${DONE_WORDS[action] ?? '好了'}`);
      onDone?.(action);
    } catch (err) {
      toast.error(`需求 ${seq} 没成：${errorText(err)}`);
      throw err;
    }
  };

  const pick = (action: MenuAction) => {
    if (action === 'delete' || action === 'drop' || action === 'rename') {
      setReason('');
      setName(title);
      setDialog(action);
      return;
    }
    void run({ action } as RequestActionBody, action).catch(() => undefined);
  };

  const copyLink = () => {
    const url = `${location.origin}/intake?r=${seq}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.success('链接已复制'),
      () => toast.error(`没复制成，手动复制：${url}`),
    );
  };

  const items = actions ? menuFor(actions) : [];
  const note = actions ? deleteNote(actions) : undefined;
  const close = (o: boolean) => {
    if (!o) setDialog(null);
  };

  return (
    <>
      <RowMenu
        label={`更多操作：需求 ${seq}`}
        title="更多操作"
        reveal={variant === 'row'}
        data-request-menu={String(seq)}
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange ? { onOpenChange } : {})}
      >
        {header}
        {header ? <RowMenuSeparator /> : null}
        {loading && !actions ? (
          <RowMenuLabel>
            <LoaderCircle aria-hidden />
            在读这条能做什么……
          </RowMenuLabel>
        ) : null}
        {error && !actions ? <RowMenuLabel hint={`没读到这条能做什么：${error}`}>读失败</RowMenuLabel> : null}
        {items.map((it) => (
          <RowMenuItem
            key={it.action}
            data-menu-action={it.action}
            {...(it.danger ? { variant: 'destructive' as const } : {})}
            {...(it.title ? { title: it.title } : {})}
            onSelect={() => pick(it.action)}
          >
            {it.label}
          </RowMenuItem>
        ))}
        {note ? <RowMenuLabel hint={<span data-delete-note>{note}</span>}>删不了</RowMenuLabel> : null}
        {items.length > 0 || note ? <RowMenuSeparator /> : null}
        <RowMenuItem onSelect={copyLink}>
          <Copy />
          复制链接
        </RowMenuItem>
      </RowMenu>

      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={close}
        title={`删除「${title}」？`}
        description={DELETE_CONFIRM_TEXT}
        danger
        confirmText="删除"
        cancelText="先不删"
        onConfirm={() => run({ action: 'delete' }, 'delete')}
      />

      <ConfirmDialog
        open={dialog === 'drop'}
        onOpenChange={close}
        title={`放下「${title}」`}
        description="放下就是结案·不做，进「已归档」，内容不再改。写一句为什么，会留在这条需求里。"
        confirmText="放下"
        cancelText="先不放"
        confirmDisabled={!reason.trim()}
        onConfirm={() => run({ action: 'drop', reason: reason.trim() }, 'drop')}
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="为什么放下……"
          aria-label="放下的理由"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'rename'}
        onOpenChange={close}
        title="改名"
        description="改的是草稿的标题，草稿版本加 1。"
        confirmText="改名"
        cancelText="取消"
        confirmDisabled={!name.trim() || name.trim() === title}
        onConfirm={() => run({ action: 'rename', title: name.trim() }, 'rename')}
      >
        <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="新标题" />
      </ConfirmDialog>
    </>
  );
}

/** 菜单顶上两行：需求号、项目。 */
export function RequestMenuHeader({ seq, repo }: { seq: number; repo: string }) {
  return (
    <Stack gap="sm">
      <RowMenuLabel>需求 {seq}</RowMenuLabel>
      <RowMenuLabel>
        <Text size="meta" tone="muted">
          项目{' '}
          <Text size="meta" tone="muted" mono>
            {repo}
          </Text>
        </Text>
      </RowMenuLabel>
    </Stack>
  );
}

/** 列表行尾的菜单：打开时才读这一条的详情（actions 只在详情里）。 */
export function RowRequestMenu({
  seq,
  title,
  open,
  onOpenChange,
  onDone,
}: {
  seq: number;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: (action: MenuAction) => void;
}) {
  const detail = useRequestDetail(open ? seq : null);
  return (
    <RequestMenu
      seq={seq}
      title={title}
      actions={detail.data?.actions}
      loading={detail.isPending && open}
      error={detail.error ? errorText(detail.error) : undefined}
      open={open}
      onOpenChange={onOpenChange}
      variant="row"
      {...(onDone ? { onDone } : {})}
    />
  );
}
