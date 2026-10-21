// 对话（样子照 canvas/fd3.css 的 .chat .msg .composer）：Chat 把一串消息排开，Message 是一条，Composer 是底下的输入区。
// me 靠右、蓝底；other 靠左、浅灰底；tool 是工具调用，透明底加细框、等宽小字。meta 是气泡上面的灰字（谁、几点）。
// 不收 className 和 style。
import type { KeyboardEvent, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

export type MessageRole = 'me' | 'other' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  /** 气泡上面的灰字：谁说的、几点。 */
  meta?: ReactNode;
  body: ReactNode;
}

export function Message({
  role,
  meta,
  children,
}: {
  role: MessageRole;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-role={role}
      className={cn('flex max-w-180 min-w-0 flex-col gap-1', role === 'me' && 'items-end self-end')}
    >
      {meta ? <span className="text-meta text-ink-3">{meta}</span> : null}
      <div
        className={cn(
          'max-w-full rounded-md px-3 py-2 text-body break-words text-ink',
          role === 'me' && 'bg-brand-1',
          role === 'other' && 'bg-fill-1',
          role === 'tool' && 'border border-line font-mono text-mono whitespace-pre-wrap text-ink-2',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function Chat({ messages, empty }: { messages: readonly ChatMessage[]; empty?: ReactNode }) {
  if (messages.length === 0 && empty) return <div>{empty}</div>;
  return (
    <div role="log" aria-live="polite" className="flex flex-col gap-4">
      {messages.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 对话只增不改，位置就是消息的身份。
        <Message key={i} role={m.role} {...(m.meta ? { meta: m.meta } : {})}>
          {m.body}
        </Message>
      ))}
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  hint = '⌘ / Ctrl + Enter 发送',
  sendText = '发送',
  sending,
  disabled,
  disabledReason,
}: {
  value: string;
  onChange: (value: string) => void;
  /** 点发送或按 ⌘/Ctrl+Enter。空白不会触发。可返回 Promise，等的时候发送键转圈。 */
  onSend: () => unknown;
  placeholder?: string;
  /** 输入区左下角的灰字。 */
  hint?: ReactNode;
  sendText?: string;
  /** 正在发：发送键转圈、不能再点。 */
  sending?: boolean;
  disabled?: boolean;
  /** 不能发的原因，写在灰字位置。 */
  disabledReason?: string;
}) {
  const blank = value.trim() === '';
  const blocked = disabled || sending || blank;
  const send = () => {
    if (!blocked) void onSend();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-card p-3 focus-within:border-brand">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        aria-label={placeholder ?? '输入消息'}
        className="field-sizing-content max-h-40 min-h-14 w-full resize-none bg-transparent text-body text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-meta text-ink-3">
          {disabled && disabledReason ? disabledReason : hint}
        </span>
        <Button
          variant="primary"
          size="sm"
          loading={sending === true}
          disabled={disabled || blank}
          onClick={send}
        >
          {sendText}
        </Button>
      </div>
    </div>
  );
}
