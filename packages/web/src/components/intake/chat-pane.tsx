// 中栏「和指挥官聊」（电脑）：模型和仓、固定的需求卡、消息流、拍板条、输入框。结案后输入框收起。
import { Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { NativeSelect } from '../layout/native-select';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Composer } from './composer';
import { type Human, MODELS, REPOS, type Req } from './data';
import { RequestCard } from './parts';
import { MessageStream, type StreamProps } from './stream';

export interface DecideProps {
  onYes: () => void;
  onNo: (reason: string) => void;
  onAgain: () => void;
}

/** 拍板条：同意做 / 不做（写理由）/ 再聊聊。电脑放对话底部，手机固定在屏幕底。 */
export function DecideBar({ phone, onYes, onNo, onAgain }: DecideProps & { phone?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const h = phone ? 'h-11 flex-1' : 'flex-1';
  return (
    <div className="border-t border-st-human-line bg-st-human-soft px-4 py-3" data-intake-decide>
      <div className="mx-auto max-w-3xl space-y-2">
        <div className={cn('text-meta font-medium text-ink-human', phone && 'hidden')}>
          cxy 拍板：第 7 版草稿，做还是不做？
        </div>
        {asking ? (
          <div className="space-y-2">
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="不做的理由（会留在这条需求里）……"
              aria-label="不做的理由"
              className="min-h-0 bg-background"
            />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                className={h}
                disabled={!reason.trim()}
                onClick={() => onNo(reason.trim())}
              >
                确认不做
              </Button>
              <Button variant="outline" className={h} onClick={() => setAsking(false)}>
                返回
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="brand" className={cn(h, 'basis-1/2 grow')} onClick={onYes}>
              同意做
            </Button>
            <Button variant="outline" className={h} onClick={() => setAsking(true)}>
              不做
            </Button>
            <Button variant="outline" className={h} onClick={onAgain}>
              再聊聊
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function LockBar({ text, onContinue }: { text: string; onContinue?: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-body"
      data-intake-lock
      role="status"
    >
      <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 font-medium">{text}</span>
      {onContinue ? (
        <Button size="sm" variant="outline" onClick={onContinue}>
          <Plus />
          接着这条提
        </Button>
      ) : null}
    </div>
  );
}

export interface ChatProps extends StreamProps {
  req: Req;
  repo: string;
  onRepo: (r: string) => void;
  model: string;
  onModel: (m: string) => void;
  multi: boolean;
  lockText: string | null;
  decide: DecideProps | null;
  waitingNote: string | null;
  onSend: (text: string) => void;
  onAsk: () => void;
  onContinue: () => void;
  viewer: Human;
}

export function ChatPane(p: ChatProps) {
  const locked = p.lockText !== null;
  const hasSpoken = p.msgs.some((m) => m.kind === 'say' && m.who !== 'ai');
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="和指挥官聊">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2">
        <h2 className="sr-only">和指挥官聊</h2>
        <span className="ml-auto flex items-center gap-2 text-meta text-muted-foreground">
          模型
          <NativeSelect
            aria-label="换模型"
            value={p.model}
            disabled={locked}
            onChange={(e) => p.onModel(e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </NativeSelect>
          仓
          <NativeSelect
            aria-label="选仓"
            value={p.repo}
            disabled={locked || hasSpoken}
            onChange={(e) => p.onRepo(e.target.value)}
          >
            {REPOS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </NativeSelect>
        </span>
      </header>
      <RequestCard req={p.req} />
      {p.lockText ? <LockBar text={p.lockText} onContinue={p.onContinue} /> : null}
      <MessageStream {...p} />
      {p.decide ? <DecideBar {...p.decide} /> : null}
      {p.waitingNote ? (
        <div className="border-t bg-muted px-4 py-2 text-body text-muted-foreground" data-intake-waiting>
          {p.waitingNote}
        </div>
      ) : null}
      {locked ? null : (
        <Composer viewer={p.viewer} multi={p.multi} busy={p.busy} onSend={p.onSend} onAsk={p.onAsk} />
      )}
    </section>
  );
}
