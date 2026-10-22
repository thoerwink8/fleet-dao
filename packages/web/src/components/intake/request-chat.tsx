// 一条需求的对话（#2062，方案第四节）：电脑是右边一张卡（顶上「对话 / 单子」两个页签），手机是盖住整屏的聊天画面（盖住底部导航，返回回到列表）。
// 头部：标题、状态、下一步轮到谁、参与人头像、「⋯」（项目、需求号、复制链接、能做的动作）。
// 手机上没有改草稿、选项目、接着这条提：「单子」点开是只读的，从旁边滑出。
// 读到这一条最后一条消息就记已读（列表上的「等我」「有新消息」跟着消掉）。
import { ChevronLeft } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  errorText,
  isNotFound,
  useMarkRequestRead,
  useRequestAction,
  useRequestDetail,
  useSendRequestMessage,
} from '../../api/client';
import type { RequestDetail, RequestDraftField, RequestPerson } from '../../api/types';
import { formatInDays } from '../../lib/format';
import { useSlowNow } from '../../lib/hooks';
import { useShownError } from '../../lib/shown-error';
import { AvatarStack } from '../layout/avatar';
import { Button } from '../layout/button';
import { Drawer } from '../layout/drawer';
import { EmptyState } from '../layout/empty-state';
import { FilterTabs } from '../layout/filter-tabs';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { Pane } from '../layout/pane';
import { Stack } from '../layout/stack';
import { StatusBadge } from '../layout/status-badge';
import { Text } from '../layout/text';
import { Title } from '../layout/title';
import { DraftFields, DraftPanel } from './draft-panel';
import { ModelChip, NudgeButton } from './request-cards';
import { ClosedBar, Composer } from './request-composer';
import { RequestMenu, RequestMenuHeader } from './request-menu';
import { MessageStream } from './request-stream';
import { nextUp, statusView } from './request-view';

/** 这条需求里出现过的人（@ 的候选），不含自己。 */
function peopleOf(d: RequestDetail, meId: string | undefined): RequestPerson[] {
  const r = d.request;
  const all = [r.initiator, ...r.participants, ...(r.decider ? [r.decider] : [])];
  const seen = new Set<string>();
  return all.filter((p) => {
    if (p.id === meId || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export interface ChatProps {
  seq: number;
  meId: string | undefined;
  phone: boolean;
  panelOpen: boolean;
  /** 方案卡点了「改」：单子页签里打开对应栏的输入框。 */
  edit?: { field: RequestDraftField; n: number } | null;
  onPanel: (open: boolean, field?: RequestDraftField) => void;
  onBack: () => void;
  onContinue: (seq: number) => void;
  /** 删了以后：离开这一条（回到列表）。 */
  onGone: () => void;
}

export function RequestChat(p: ChatProps) {
  const q = useRequestDetail(p.seq);
  const shown = useShownError(String(p.seq), q);
  const d = q.data;
  useMarkRead(d);

  if (!d) {
    return (
      <Pane
        label="需求对话"
        size={p.phone ? 'screen' : 'fill'}
        column
        {...(p.phone ? { 'data-intake-phone-chat': '' } : {})}
        head={
          <Stack direction="horizontal" gap="sm" align="center">
            {p.phone ? (
              <Button iconOnly size="sm" aria-label="回到需求列表" onClick={p.onBack}>
                <ChevronLeft />
              </Button>
            ) : null}
            <Title>需求 {p.seq}</Title>
          </Stack>
        }
      >
        {shown ? (
          isNotFound(shown) ? (
            <EmptyState title={`没有需求 ${p.seq}`} hint="可能已经被彻底删除，或者链接写错了。" />
          ) : (
            <LoadError error={shown} what={`需求 ${p.seq}`} onRetry={() => void q.refetch()} />
          )
        ) : (
          <LoadingRows rows={4} />
        )}
      </Pane>
    );
  }
  return <ChatBody {...p} d={d} />;
}

function useMarkRead(d: RequestDetail | undefined) {
  const mark = useMarkRequestRead();
  const marked = useRef(new Map<number, number>());
  const seq = d?.request.seq;
  const last = d?.messages.at(-1)?.id;
  const read = d?.lastReadMessageId ?? 0;
  const deleted = Boolean(d?.request.deletedAt);
  const { mutate } = mark;
  useEffect(() => {
    if (seq === undefined || last === undefined || deleted || last <= read) return;
    if ((marked.current.get(seq) ?? 0) >= last) return;
    marked.current.set(seq, last);
    mutate({ seq, messageId: last });
  }, [seq, last, read, deleted, mutate]);
}

function ChatBody(p: ChatProps & { d: RequestDetail }) {
  const { d } = p;
  const r = d.request;
  const v = statusView(r);
  const send = useSendRequestMessage();
  const restore = useRequestAction();
  const [sendError, setSendError] = useState<string | undefined>();
  const [sheet, setSheet] = useState(false);
  const now = useSlowNow();
  const closed = r.status === 'closed_do' || r.status === 'closed_drop';
  const people = [r.initiator, ...r.participants];
  const draftTab = !p.phone && p.panelOpen;

  const onSend = async (text: string, mentions: string[]) => {
    setSendError(undefined);
    try {
      await send.mutateAsync({
        seq: r.seq,
        body: {
          body: text,
          channel: p.phone ? 'mobile' : 'web',
          mentions,
          mentionCommander: text.includes('@指挥官'),
        },
      });
      return true;
    } catch (err) {
      setSendError(errorText(err));
      return false;
    }
  };

  const openPanel = (field?: RequestDraftField) => {
    if (p.phone) {
      setSheet(true);
      if (field) {
        window.setTimeout(
          () =>
            document
              .getElementById(`draft-${field}`)
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
          300,
        );
      }
      return;
    }
    p.onPanel(true, field);
  };

  const menu = (
    <RequestMenu
      seq={r.seq}
      title={r.title}
      actions={d.actions}
      variant="head"
      header={<RequestMenuHeader seq={r.seq} repo={r.repo.slug} />}
      onDone={(a) => {
        if (a === 'delete') p.onGone();
      }}
    />
  );

  const foot: ReactNode = r.deletedAt ? (
    <div data-deleted-bar="">
      <Notice
        tone="stall"
        title="这条需求已经删了"
        action={
          d.actions.restore.allowed ? (
            <Button
              size="xs"
              variant="outline"
              loading={restore.isPending}
              onClick={() =>
                restore.mutate(
                  { seq: r.seq, body: { action: 'restore' } },
                  {
                    onSuccess: () => toast.success(`需求 ${r.seq} 已恢复`),
                    onError: (err) => toast.error(`没恢复成：${errorText(err)}`),
                  },
                )
              }
            >
              恢复
            </Button>
          ) : undefined
        }
      >
        {r.purgeAt ? `${formatInDays(r.purgeAt, now)}彻底删除。` : ''}
        {d.actions.restore.allowed ? '恢复后回到原来的地方。' : (d.actions.restore.why ?? '')}
      </Notice>
    </div>
  ) : closed ? (
    <ClosedBar phone={p.phone} onContinue={() => p.onContinue(r.seq)} />
  ) : d.actions.send.allowed ? (
    <Composer
      people={peopleOf(d, p.meId)}
      phone={p.phone}
      busy={send.isPending}
      error={sendError}
      onSend={onSend}
      {...(r.participants.length > 0 ? { placeholder: '两个人都在聊：@指挥官 它才接话……' } : {})}
      tools={
        <>
          {p.phone ? null : <ModelChip d={d} />}
          <NudgeButton d={d} />
        </>
      }
    />
  ) : (
    <Notice tone="info">{d.actions.send.why ?? '现在不能发消息'}</Notice>
  );

  return (
    <>
      <Pane
        label="需求对话"
        size={p.phone ? 'screen' : 'fill'}
        column
        {...(p.phone ? { 'data-intake-phone-chat': '' } : {})}
        head={
          <Stack gap="md">
            <Stack direction="horizontal" gap="sm" align="center" data-intake-head="">
              {p.phone ? (
                <Button iconOnly size="sm" aria-label="回到需求列表" onClick={p.onBack}>
                  <ChevronLeft />
                </Button>
              ) : null}
              <Title truncate title={`需求 ${r.seq} ${r.title}`}>
                {r.title}
              </Title>
              <StatusBadge status={v.status} title={v.label} />
              {p.phone ? null : (
                <Text size="meta" tone="muted" truncate data-next-up="">
                  {nextUp(d, p.meId)}
                </Text>
              )}
              <Stack direction="horizontal" gap="sm" align="center">
                {p.phone ? null : <AvatarStack people={people} meId={p.meId} />}
                {p.phone ? (
                  <Button size="sm" aria-label="看单子" onClick={() => setSheet(true)}>
                    看单子
                  </Button>
                ) : null}
                {menu}
              </Stack>
            </Stack>
            {p.phone ? null : (
              <FilterTabs
                aria-label="对话和单子"
                mode="tabs"
                value={draftTab ? 'draft' : 'chat'}
                onChange={(id) => p.onPanel(id === 'draft')}
                items={[
                  { id: 'chat', label: '对话' },
                  {
                    id: 'draft',
                    label: '单子',
                    count: `第 ${r.draftVersion} 版`,
                    data: { 'data-panel-toggle': '' },
                  },
                ]}
              />
            )}
          </Stack>
        }
        foot={foot}
      >
        {draftTab ? (
          <div data-intake-panel-wrap="" data-open="true">
            <DraftPanel d={d} meId={p.meId} edit={p.edit ?? null} onContinue={() => p.onContinue(r.seq)} />
          </div>
        ) : (
          <MessageStream
            d={d}
            meId={p.meId}
            phone={p.phone}
            onOpenPanel={openPanel}
            onPick={(text) => onSend(text, [])}
          />
        )}
      </Pane>
      {p.phone ? (
        <Drawer
          open={sheet}
          onOpenChange={setSheet}
          title={`单子 · 第 ${r.draftVersion} 版（只读）`}
          description="要改单子请回电脑上操作。"
          width="lg"
        >
          <DraftFields d={d} editable={false} />
        </Drawer>
      ) : null}
    </>
  );
}
