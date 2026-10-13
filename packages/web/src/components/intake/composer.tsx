// 输入框：多行、Enter 发送、Shift+Enter 换行；能 @指挥官 / @对方；两个人都说过话以后多一个「让指挥官接着问」。
import { ArrowUp, AtSign, Sparkles } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { Textarea } from '../ui/textarea';
import type { Human } from './data';

export function Composer({
  viewer,
  multi,
  busy,
  phone,
  onSend,
  onAsk,
}: {
  viewer: Human;
  /** 两个人都说过话：指挥官只在被 @ 或被点名时说话。 */
  multi: boolean;
  busy: boolean;
  phone?: boolean;
  onSend: (text: string) => void;
  onAsk: () => void;
}) {
  const [text, setText] = useState('');
  const other: Human = viewer === 'cxy' ? 'fxc188' : 'cxy';
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
  const add = (who: string) => {
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${who} `);
    document.getElementById('intake-input')?.focus();
  };
  const chip = cn('gap-1', phone ? 'h-11 px-3' : '');
  return (
    <div className={cn('border-t bg-panel px-4 py-3', phone && 'px-3 py-2')} data-intake-composer>
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button
            size={phone ? 'default' : 'xs'}
            variant="outline"
            className={chip}
            onClick={() => add('指挥官')}
          >
            <AtSign />
            指挥官
          </Button>
          <Button
            size={phone ? 'default' : 'xs'}
            variant="outline"
            className={cn(chip, phone && 'max-[400px]:hidden')}
            onClick={() => add(other)}
          >
            <AtSign />
            {other}
          </Button>
          {multi ? (
            <Button size={phone ? 'default' : 'xs'} variant="ghost" className={chip} onClick={onAsk}>
              <Sparkles />
              让指挥官接着问
            </Button>
          ) : null}
          {multi && !phone ? (
            <span className="ml-auto text-meta text-muted-foreground">
              两个人都说过话了，指挥官只在被 @ 或点这里时才开口
            </span>
          ) : null}
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            id="intake-input"
            rows={phone ? 1 : 2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={key}
            placeholder={multi ? '说话，要指挥官接话就 @指挥官……' : '说说你想要什么，大白话就行……'}
            className="max-h-40 min-h-11 flex-1 resize-none bg-background"
            aria-label="消息"
          />
          <Button
            variant="brand"
            className={phone ? 'h-11 min-w-11 px-3' : undefined}
            onClick={send}
            disabled={!text.trim() || busy}
            aria-label="发送"
          >
            <ArrowUp aria-hidden />
            {phone ? null : '发送'}
          </Button>
        </div>
        {phone ? null : (
          <div className="mt-1.5 flex items-center gap-1.5 text-meta text-muted-foreground">
            <Kbd>Enter</Kbd>发送
            <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>换行
          </div>
        )}
      </div>
    </div>
  );
}
