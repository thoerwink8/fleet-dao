// 输入区：像 ChatGPT 的一块输入框，左下角是模型小芯片（电脑）和 @ 图标，右下角发送。
// 在输入框里打 @ 弹出候选；指挥官静音时占位字写「@指挥官 让它接话」。结案后收成一条细栏；点「回答」时细栏才变成输入框。
import { ArrowUp, AtSign, ChevronDown, Lock, Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Kbd } from '../ui/kbd';
import { Textarea } from '../ui/textarea';
import { ENGINE_ASK, type Human, MODELS } from './data';

const bare = 'border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:border-0';

export function Composer({
  viewer,
  muted,
  busy,
  phone,
  model,
  onModel,
  modelLocked,
  onSend,
}: {
  viewer: Human;
  /** 两个人都说过话：指挥官静音，被 @ 才开口。 */
  muted: boolean;
  busy: boolean;
  phone?: boolean;
  model: string;
  onModel: (m: string) => void;
  modelLocked: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const other: Human = viewer === 'cxy' ? 'fxc188' : 'cxy';
  const pending = /(^|\s)@([^\s]*)$/.exec(text);
  const candidates = pending ? ['指挥官', other].filter((c) => c.startsWith(pending[2] ?? '')) : [];
  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText('');
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !phone) {
      e.preventDefault();
      send();
    }
  };
  const pickMention = (who: string) => {
    setText((t) => `${t.replace(/@[^\s]*$/, '')}@${who} `);
    document.getElementById('intake-input')?.focus();
  };
  return (
    <div className={cn('px-4 pb-3', phone && 'px-2 pb-2')} data-intake-composer>
      <div className="relative mx-auto max-w-chat">
        {candidates.length > 0 ? (
          <ul className="absolute bottom-full left-0 z-10 mb-1 min-w-40 rounded-lg border bg-popover p-1 shadow-overlay">
            {candidates.map((c) => (
              <li key={c}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body hover:bg-accent max-md:min-h-11"
                  onClick={() => pickMention(c)}
                >
                  <AtSign className="size-3.5 text-muted-foreground" aria-hidden />
                  {c}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="rounded-lg border border-input bg-background shadow-xs focus-within:border-ring">
          <Textarea
            id="intake-input"
            rows={phone ? 1 : 2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={key}
            placeholder={muted ? '@指挥官 让它接话' : '说说你想要什么，大白话就行……'}
            className={cn(bare, 'max-h-40 min-h-11 resize-none px-3 pt-2.5')}
            aria-label="消息"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {phone ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={modelLocked}
                    title={modelLocked ? '已结案，不能换模型' : '换模型'}
                    className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-meta text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
                  >
                    {model}
                    <ChevronDown className="size-3" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup value={model} onValueChange={onModel}>
                    {MODELS.map((m) => (
                      <DropdownMenuRadioItem key={m} value={m}>
                        {m}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              className={phone ? 'size-11' : undefined}
              aria-label="@ 提到某人"
              title="@ 提到某人"
              onClick={() => {
                setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@`);
                document.getElementById('intake-input')?.focus();
              }}
            >
              <AtSign />
            </Button>
            {phone ? null : (
              <span className="ml-1 hidden items-center gap-1 text-meta text-muted-foreground 2xl:inline-flex">
                <Kbd>Enter</Kbd>发送 <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>换行
              </span>
            )}
            <Button
              variant="brand"
              size={phone ? 'default' : 'icon-sm'}
              className={cn('ml-auto', phone && 'size-11 px-0')}
              onClick={send}
              disabled={!text.trim() || busy}
              aria-label="发送"
            >
              <ArrowUp aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 结案后的细栏：平时只写「已结案，内容不再改」；点「回答」才变成输入框，答复写进 GitHub 评论。 */
export function ClosedBar({
  phone,
  answering,
  busy,
  onAnswer,
  onCancel,
  onContinue,
}: {
  phone?: boolean;
  answering: boolean;
  busy: boolean;
  onAnswer: (text: string) => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const [t, setT] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (answering) ref.current?.focus();
  }, [answering]);
  if (answering) {
    return (
      <div className={cn('border-t bg-panel px-4 py-2', phone && 'px-2')} data-intake-answer>
        <div className="mx-auto max-w-chat space-y-1.5">
          <div className="text-meta text-muted-foreground">正在回答引擎 · 写进 {ENGINE_ASK.comment}</div>
          <div className="flex items-end gap-2">
            <Textarea
              ref={ref}
              id="intake-input"
              rows={1}
              value={t}
              onChange={(e) => setT(e.target.value)}
              placeholder="写下对这一问的答复……"
              aria-label="答复引擎"
              className="max-h-32 min-h-11 flex-1 resize-none bg-background"
            />
            <Button
              variant="brand"
              className="max-md:h-11"
              disabled={!t.trim() || busy}
              onClick={() => onAnswer(t.trim())}
            >
              写回评论
            </Button>
            <Button variant="ghost" className="max-md:h-11" disabled={busy} onClick={onCancel}>
              取消
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 border-t bg-muted px-4 py-2 text-body text-muted-foreground"
      data-intake-lock
    >
      <Lock className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">已结案，内容不再改</span>
      {phone ? null : (
        <Button size="sm" variant="outline" onClick={onContinue}>
          <Plus />
          接着这条提
        </Button>
      )}
    </div>
  );
}
