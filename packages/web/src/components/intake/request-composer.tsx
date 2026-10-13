// 输入区（#2062）：像 ChatGPT 的一块输入框，左下角 @，右下角发送；电脑上 Enter 发送、Shift+Enter 换行。
// 打 @ 弹出候选：指挥官，和这条需求里出现过的人（发起人、说过话的、拍板人）。@ 了谁按人的编号带给后端。
// 发没成：字留在框里，框下面写原因（不丢人打的字）。模型芯片、「让指挥官接着问」由页面经 tools 放进左下角。
// 结案后输入框换成一条细栏「已结案，内容不再改 · 接着这条提」（手机上没有「接着这条提」）。
import { ArrowUp, AtSign, Lock, Plus } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import type { RequestPerson } from '../../api/types';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { Textarea } from '../ui/textarea';

const bare = 'border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:border-0';

/** 发出去的话里 @ 了哪些人（按名字找回编号；指挥官不是人，不带编号）。 */
export function mentionIds(text: string, people: readonly RequestPerson[]): string[] {
  return people.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id);
}

export function Composer({
  people,
  phone,
  busy,
  error,
  placeholder,
  onSend,
  inputId = 'intake-input',
  tools,
}: {
  /** 输入框左下角的东西（模型芯片、「让指挥官接着问」）。 */
  tools?: ReactNode;
  /** @ 的候选人（不含自己）。 */
  people: readonly RequestPerson[];
  phone: boolean;
  busy: boolean;
  error?: string | undefined;
  placeholder?: string;
  /** 发出去：成了返回 true（清空输入框），没成返回 false（字留着）。 */
  onSend: (text: string, mentions: string[]) => Promise<boolean>;
  inputId?: string;
}) {
  const [text, setText] = useState('');
  const pending = /(^|\s)@([^\s]*)$/.exec(text);
  const names = ['指挥官', ...people.map((p) => p.name)];
  const candidates = pending ? names.filter((c) => c.startsWith(pending[2] ?? '')) : [];
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (await onSend(t, mentionIds(t, people))) setText('');
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !phone) {
      e.preventDefault();
      void send();
    }
  };
  const pickMention = (who: string) => {
    setText((t) => `${t.replace(/@[^\s]*$/, '')}@${who} `);
    document.getElementById(inputId)?.focus();
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
            id={inputId}
            rows={phone ? 1 : 2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={key}
            placeholder={placeholder ?? '说说你想要什么，大白话就行……'}
            className={cn(bare, 'max-h-40 min-h-11 resize-none px-3 pt-2.5')}
            aria-label="消息"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            {tools}
            <Button
              size="icon-xs"
              variant="ghost"
              className={phone ? 'size-11' : undefined}
              aria-label="@ 提到某人"
              title="@ 提到某人"
              onClick={() => {
                setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@`);
                document.getElementById(inputId)?.focus();
              }}
            >
              <AtSign />
            </Button>
            {phone ? null : (
              <span className="ml-1 hidden items-center gap-1 text-meta text-muted-foreground 2xl:inline-flex">
                <Kbd>Enter</Kbd>发送 <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>换行
              </span>
            )}
            {/* loading-ok: 发送经 onSend 交给页面，页面的 useSendRequestMessage.isPending 就是这里的 busy */}
            <Button
              variant="brand"
              size={phone ? 'default' : 'icon-sm'}
              className={cn('ml-auto', phone && 'size-11 px-0')}
              onClick={() => void send()}
              disabled={!text.trim()}
              loading={busy}
              aria-label="发送"
            >
              <ArrowUp aria-hidden />
            </Button>
          </div>
        </div>
        {error ? (
          <p className="mt-1.5 text-meta text-ink-fail" role="alert" data-send-error>
            没发出去：{error}（你写的话还在框里）
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** 结案后的细栏。 */
export function ClosedBar({ phone, onContinue }: { phone: boolean; onContinue: () => void }) {
  return (
    <div
      className="flex items-center gap-2 border-t bg-muted px-4 py-2 text-body text-muted-foreground"
      data-intake-lock
    >
      <Lock className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">已结案，内容不再改</span>
      {phone ? null : (
        <Button size="sm" variant="outline" onClick={onContinue} data-continue>
          <Plus />
          接着这条提
        </Button>
      )}
    </div>
  );
}
