// 一条需求的对话（#2062，方案第四节）：电脑是中栏，手机是盖住整屏的聊天画面（盖住底部导航，返回回到列表）。
// 头部一行：标题、状态小标签、下一步轮到谁、参与人头像、「单子 · 第 N 版」、「⋯」（项目、需求号、复制链接、能做的动作）。
// 手机上没有改草稿、选项目、接着这条提：「单子」点开是只读的，从下往上弹出。
// 读到这一条最后一条消息就记已读（列表上的「等我」「有新消息」跟着消掉）。
import { ChevronLeft, FileText, RotateCcw } from 'lucide-react';
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
import { cn } from '../../lib/utils';
import { EmptyState } from '../layout/empty-state';
import { LoadError, LoadingRows } from '../layout/load-state';
import { Notice } from '../layout/notice';
import { StatusBadge } from '../layout/status-badge';
import { Button } from '../ui/button';
import { DropdownMenuLabel } from '../ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { DraftFields } from './draft-panel';
import { Overlap } from './people';
import { ModelChip, NudgeButton } from './request-cards';
import { ClosedBar, Composer } from './request-composer';
import { RequestMenu } from './request-menu';
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

  const shell = (children: ReactNode) =>
    p.phone ? (
      <section
        className="fixed inset-0 z-40 flex min-h-0 min-w-0 flex-col bg-background"
        aria-label="需求对话"
        data-intake-phone-chat
      >
        {children}
      </section>
    ) : (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="需求对话">
        {children}
      </section>
    );

  if (!d) {
    return shell(
      <>
        {p.phone ? (
          <header className="flex items-center gap-1 border-b bg-panel px-1 py-1">
            <Button
              variant="ghost"
              className="size-11 shrink-0 px-0"
              onClick={p.onBack}
              aria-label="回到需求列表"
            >
              <ChevronLeft />
            </Button>
            <h2 className="text-heading">需求 {p.seq}</h2>
          </header>
        ) : null}
        <div className="mx-auto w-full max-w-chat p-4">
          {shown ? (
            isNotFound(shown) ? (
              <EmptyState title={`没有需求 ${p.seq}`} hint="可能已经被彻底删除，或者链接写错了。" />
            ) : (
              <LoadError error={shown} what={`需求 ${p.seq}`} onRetry={() => void q.refetch()} />
            )
          ) : (
            <LoadingRows rows={4} />
          )}
        </div>
      </>,
    );
  }
  return shell(<ChatBody {...p} d={d} />);
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
      header={
        <>
          <DropdownMenuLabel>需求 {r.seq}</DropdownMenuLabel>
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            项目 <span className="font-mono">{r.repo.slug}</span>
          </DropdownMenuLabel>
        </>
      }
      onDone={(a) => {
        if (a === 'delete') p.onGone();
      }}
    />
  );

  return (
    <>
      {p.phone ? (
        <header className="flex items-center gap-1 border-b bg-panel px-1 py-1" data-intake-head>
          <Button
            variant="ghost"
            className="size-11 shrink-0 px-0"
            onClick={p.onBack}
            aria-label="回到需求列表"
          >
            <ChevronLeft />
          </Button>
          <h2 className="min-w-0 flex-1 truncate text-heading" title={r.title}>
            {r.title}
          </h2>
          <span title={v.label} className="shrink-0">
            <StatusBadge tone={v.tone} label={v.short} />
          </span>
          <Button
            variant="ghost"
            className="size-11 shrink-0 px-0"
            onClick={() => setSheet(true)}
            aria-label="看单子"
          >
            <FileText />
          </Button>
          {menu}
        </header>
      ) : (
        <header className="flex items-center gap-2 border-b px-4 py-2" data-intake-head>
          <h2 className="min-w-0 truncate text-heading" title={`需求 ${r.seq} ${r.title}`}>
            {r.title}
          </h2>
          <span title={v.label} className="shrink-0" data-head-status={r.status}>
            <StatusBadge tone={v.tone} label={v.short} />
          </span>
          <span className="min-w-0 truncate text-meta text-muted-foreground" data-next-up>
            {nextUp(d, p.meId)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <Overlap people={people} meId={p.meId} />
            <Button
              size="sm"
              variant="outline"
              aria-pressed={p.panelOpen}
              onClick={() => p.onPanel(!p.panelOpen)}
              className={cn(p.panelOpen && 'bg-selected')}
              data-panel-toggle
            >
              <FileText />
              单子 · 第 {r.draftVersion} 版
            </Button>
            {menu}
          </span>
        </header>
      )}
      <MessageStream
        d={d}
        meId={p.meId}
        phone={p.phone}
        onOpenPanel={openPanel}
        onPick={(text) => onSend(text, [])}
      />
      {r.deletedAt ? (
        <div className="border-t px-4 py-2.5" data-deleted-bar>
          <Notice
            tone="stall"
            title="这条需求已经删了"
            action={
              d.actions.restore.allowed ? (
                <Button
                  size="sm"
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
                  <RotateCcw />
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
              <NudgeButton d={d} phone={p.phone} />
            </>
          }
        />
      ) : (
        <div className="border-t bg-muted px-4 py-2 text-body text-muted-foreground">
          {d.actions.send.why ?? '现在不能发消息'}
        </div>
      )}
      {p.phone ? (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="bottom" className="h-5/6 gap-0 p-0">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle className="text-heading">单子 · 第 {r.draftVersion} 版（只读）</SheetTitle>
              <SheetDescription className="text-meta">要改单子请回电脑上操作。</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
              <DraftFields d={d} editable={false} />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
