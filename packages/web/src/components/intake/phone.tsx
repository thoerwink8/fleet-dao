// 手机对话画面（PWA，单列）：顶上需求卡（带「看单子」）、消息流、输入框；待拍板时底部固定三个按钮。
// 手机上不能改草稿、选仓、换模型、让别家挑错、接着这条提：草稿只读，从下往上弹出。
import { ChevronLeft, FileText } from 'lucide-react';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { DecideBar, LockBar } from './chat-pane';
import { Composer } from './composer';
import type { Draft, DraftField, Human, Req } from './data';
import { DraftFields } from './draft-pane';
import { RequestCard } from './parts';
import { MessageStream, type StreamProps } from './stream';

export interface PhoneChatProps extends StreamProps {
  req: Req;
  viewer: Human;
  draft: Draft;
  sheet: boolean;
  onSheet: (open: boolean) => void;
  onBack: () => void;
  multi: boolean;
  lockText: string | null;
  decide: React.ComponentProps<typeof DecideBar> | null;
  waitingNote: string | null;
  onSend: (text: string) => void;
  onAsk: () => void;
}

const noEdit = new Set<DraftField>();

export function PhoneChat(p: PhoneChatProps) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="需求对话">
      <RequestCard
        req={p.req}
        compact
        lead={
          <Button
            variant="ghost"
            className="size-11 shrink-0 px-0"
            onClick={p.onBack}
            aria-label="回到我的需求"
          >
            <ChevronLeft />
          </Button>
        }
        action={
          <Button variant="outline" className="h-11 shrink-0 gap-1.5" onClick={() => p.onSheet(true)}>
            <FileText />
            看单子
          </Button>
        }
      />
      {p.lockText ? <LockBar text={p.lockText} /> : null}
      <MessageStream {...p} phone />
      {p.decide ? <DecideBar {...p.decide} phone /> : null}
      {p.waitingNote ? (
        <div className="border-t bg-muted px-4 py-2 text-body text-muted-foreground">{p.waitingNote}</div>
      ) : null}
      {p.lockText ? null : (
        <Composer viewer={p.viewer} multi={p.multi} busy={p.busy} phone onSend={p.onSend} onAsk={p.onAsk} />
      )}
      <Sheet open={p.sheet} onOpenChange={p.onSheet}>
        <SheetContent side="bottom" className="h-5/6 gap-0 p-0">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-heading">单子草稿 · 第 {p.draft.version} 版（只读）</SheetTitle>
            <SheetDescription className="text-meta">要改草稿请回电脑上操作。</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            <DraftFields draft={p.draft} edited={noEdit} flash={null} ro onChange={() => undefined} />
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
