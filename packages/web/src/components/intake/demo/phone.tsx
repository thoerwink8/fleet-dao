// 手机对话画面（PWA）：进到对话就是全屏聊天，盖住底部导航和顶栏；头部一行：返回、标题、状态小标签、「单子」图标。
// 单子卡、拍板卡都在对话流里；「单子」点开从下往上弹出只读面板。手机上不能改草稿、选仓、换模型、让别家挑错、接着这条提。
import { ChevronLeft, FileText } from 'lucide-react';
import { StatusBadge } from '../../layout/status-badge';
import { Button } from '../../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../ui/sheet';
import { shortStatus } from './chat-pane';
import { ClosedBar, Composer } from './composer';
import { type DraftField, type Req, statusView } from './data';
import { DraftFields } from './draft-pane';
import { MessageStream, type StreamProps } from './stream';

export interface PhoneChatProps extends StreamProps {
  req: Req;
  sheet: boolean;
  onSheet: (open: boolean) => void;
  onBack: () => void;
  muted: boolean;
  onSend: (text: string) => void;
  onAnswerSend: (text: string) => void;
  onAnswerCancel: () => void;
}

const noEdit = new Set<DraftField>();

export function PhoneChat(p: PhoneChatProps) {
  const v = statusView(p.req.status, p.req.gh, p.req.issue);
  const locked = p.status === 'do' || p.status === 'no';
  return (
    <section
      className="fixed inset-0 z-40 flex min-h-0 min-w-0 flex-col bg-background"
      aria-label="需求对话"
      data-intake-phone-chat
    >
      <header className="flex items-center gap-1 border-b bg-panel px-1 py-1" data-intake-head>
        <Button
          variant="ghost"
          className="size-11 shrink-0 px-0"
          onClick={p.onBack}
          aria-label="回到我的需求"
        >
          <ChevronLeft />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-heading">{p.req.title}</h2>
        <span title={v.label} className="shrink-0">
          <StatusBadge tone={v.tone} label={shortStatus(p.status)} />
        </span>
        <Button
          variant="ghost"
          className="size-11 shrink-0 px-0"
          onClick={() => p.onSheet(true)}
          aria-label="看单子"
        >
          <FileText />
        </Button>
      </header>
      <MessageStream {...p} phone />
      {locked ? (
        <ClosedBar
          phone
          answering={p.askState === 'composing' || p.askState === 'writing'}
          busy={p.askState === 'writing'}
          onAnswer={p.onAnswerSend}
          onCancel={p.onAnswerCancel}
          onContinue={() => undefined}
        />
      ) : (
        <Composer
          viewer={p.viewer}
          muted={p.muted}
          busy={p.busy}
          phone
          model={''}
          onModel={() => undefined}
          modelLocked
          onSend={p.onSend}
        />
      )}
      <Sheet open={p.sheet} onOpenChange={p.onSheet}>
        <SheetContent side="bottom" className="h-5/6 gap-0 p-0">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-heading">单子 · 第 {p.draft.version} 版（只读）</SheetTitle>
            <SheetDescription className="text-meta">要改单子请回电脑上操作。</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            <DraftFields draft={p.draft} edited={noEdit} flash={null} ro onChange={() => undefined} />
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
