// 对话（样子照 canvas/fd3.css 的 .chat .msg .composer）：Chat 把一串消息排开，Message 是一条，Composer 是底下的输入区。
// me 靠右、蓝底；other 靠左、浅灰底；tool 是工具调用，透明底加细框、等宽小字。meta 是气泡上面的灰字（谁、几点）。
// 不收 className 和 style。
import type { KeyboardEvent, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { type DataAttrs, pickData } from './data-attrs';

export type MessageRole = 'me' | 'other' | 'tool';

/** 写 `role={ROLE.other}`：Message 的 role 是消息的角色，不是 ARIA role，字面量会被 a11y 检查误报。 */
export const ROLE = { me: 'me', other: 'other', tool: 'tool' } as const satisfies Record<
  MessageRole,
  MessageRole
>;

export interface ChatMessage {
  role: MessageRole;
  /** 气泡上面的灰字：谁说的、几点。 */
  meta?: ReactNode;
  body: ReactNode;
}

export function Message({
  role,
  meta,
  kind,
  children,
  ...data
}: DataAttrs & {
  role: MessageRole;
  meta?: ReactNode;
  /** 这条是什么（会话记录里的 prompt、result）：只写在 data-kind 上，给测试和脚本找，不影响样子。 */
  kind?: string;
  children: ReactNode;
}) {
  return (
    <div
      {...pickData(data)}
      data-role={role}
      {...(kind !== undefined ? { 'data-kind': kind } : {})}
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

export function Chat({
  messages = [],
  empty,
  children,
}: {
  messages?: readonly ChatMessage[];
  empty?: ReactNode;
  /** 排在 messages 后面的内容（自己拼的消息、分隔线、卡片），业务页的对话流从这里放。 */
  children?: ReactNode;
}) {
  if (messages.length === 0 && !children && empty) return <div>{empty}</div>;
  return (
    <div role="log" aria-live="polite" className="flex flex-col gap-4">
      {messages.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 对话只增不改，位置就是消息的身份。
        <Message key={i} role={m.role} {...(m.meta ? { meta: m.meta } : {})}>
          {m.body}
        </Message>
      ))}
      {children}
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
  label,
  inputId,
  enterToSend,
  tools,
  suggestions = [],
  onPickSuggestion,
  ...data
}: DataAttrs & {
  /** 输入框的无障碍名字；不传就取 placeholder。 */
  label?: string;
  inputId?: string;
  /** 按 Enter 就发（Shift+Enter 换行）；默认是 ⌘/Ctrl+Enter 才发。手机上不传：Enter 是换行。 */
  enterToSend?: boolean;
  /** 底栏左边的小按钮（模型、@、让指挥官接着问）。 */
  tools?: ReactNode;
  /** 输入框上方弹出的候选（打 @ 的人名）；选中调 onPickSuggestion。 */
  suggestions?: readonly string[];
  onPickSuggestion?: (item: string) => void;
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
    const plain = enterToSend && !e.shiftKey && !e.nativeEvent.isComposing;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || plain)) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div
      {...pickData(data)}
      className="relative flex flex-col gap-2 rounded-md border border-line bg-card p-3 focus-within:border-brand"
    >
      {suggestions.length > 0 ? (
        <ul className="absolute bottom-full left-0 z-10 mb-1 min-w-40 rounded-sm bg-card p-1 shadow-pop">
          {suggestions.map((c) => (
            <li key={c}>
              <button
                type="button"
                className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-body text-ink hover:bg-fill-1 max-md:min-h-11"
                onClick={() => onPickSuggestion?.(c)}
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        {...(inputId ? { id: inputId } : {})}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        aria-label={label ?? placeholder ?? '输入消息'}
        className="field-sizing-content max-h-40 min-h-14 w-full resize-none bg-transparent text-body text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
      />
      <div className="flex items-center justify-between gap-2">
        {tools ? <div className="flex shrink-0 items-center gap-1">{tools}</div> : null}
        <span className="min-w-0 flex-1 truncate text-meta text-ink-3">
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
