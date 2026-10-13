// 中栏（电脑）：对话是主角。头部压成一行；消息流居中一列（最大约 760px）；输入框像 ChatGPT；结案后收成细栏。
import { Copy, Ellipsis, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';
import { StatusBadge } from '../../layout/status-badge';
import { Button } from '../../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { ClosedBar, Composer } from './composer';
import { type Req, type Status, statusView } from './data';
import { Overlap } from './parts';
import { MessageStream, type StreamProps } from './stream';

/** 头部的小状态标签用短写；完整说法在列表和悬停里。 */
export function shortStatus(s: Status): string {
  return s === 'discussing' ? '讨论中' : s === 'pending' ? '待拍板' : '已结案';
}

export interface ChatProps extends StreamProps {
  req: Req;
  repo: string;
  model: string;
  onModel: (m: string) => void;
  muted: boolean;
  panelOpen: boolean;
  onPanel: () => void;
  onSend: (text: string) => void;
  onContinue: () => void;
  onAnswerSend: (text: string) => void;
  onAnswerCancel: () => void;
}

export function ChatPane(p: ChatProps) {
  const v = statusView(p.req.status, p.req.gh, p.req.issue);
  const locked = p.status === 'do' || p.status === 'no';
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="需求对话">
      <header className="flex items-center gap-2 border-b px-4 py-2" data-intake-head>
        <h2 className="min-w-0 truncate text-heading">{p.req.title}</h2>
        <span title={v.label} className="shrink-0">
          <StatusBadge tone={v.tone} label={shortStatus(p.status)} />
        </span>
        {p.req.waiting ? (
          <span className="min-w-0 truncate text-meta text-muted-foreground">{p.req.waiting}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Overlap people={p.req.participants} />
          <Button
            size="sm"
            variant="outline"
            aria-pressed={p.panelOpen}
            onClick={p.onPanel}
            className={cn(p.panelOpen && 'bg-selected')}
          >
            <FileText />
            单子 · 第 {p.draft.version} 版
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="更多">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>需求 {p.req.no}</DropdownMenuLabel>
              <DropdownMenuLabel className="font-normal text-muted-foreground">
                仓 {p.repo}（开聊后锁定）
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => toast.success('链接已复制')}>
                <Copy />
                复制链接
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </header>
      <MessageStream {...p} />
      {locked ? (
        <ClosedBar
          answering={p.askState === 'composing' || p.askState === 'writing'}
          busy={p.askState === 'writing'}
          onAnswer={p.onAnswerSend}
          onCancel={p.onAnswerCancel}
          onContinue={p.onContinue}
        />
      ) : (
        <Composer
          viewer={p.viewer}
          muted={p.muted}
          busy={p.busy}
          model={p.model}
          onModel={p.onModel}
          modelLocked={false}
          onSend={p.onSend}
        />
      )}
    </section>
  );
}
