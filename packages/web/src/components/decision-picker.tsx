// 「要你拍」的选项区（#1915；#2353 起直接摆在卡上）：通知中心的「要你拍」和看门狗提醒里要本人拍的修复动作（#3034）共用这一份。
import { ChevronRight, Send } from 'lucide-react';
import type { DecisionOption } from '../api/types';
import { Tag } from './layout/tag';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** 回答一条「要你拍」：点一个选项，或自己写一段。 */
export type AnswerInput = { optionId: string } | { text: string };

/**
 * 选一个或写一句，系统照着做。
 * 一个选项一行，整行就是按钮，点一下就是拍板；行里是选项的字（推荐的那项带「推荐」标，上次选过的带「上次选的」）
 * 和一句真实效果、推荐的写理由。md 起字和说明同一行、说明左对齐成一列；手机上整行占满、字在上说明在下，可点区至少 44 高。
 * 几项装在一个细框里、项间一根细线（系统设置的单选组），不一个个画框。下面是「自己写一句」的框加「提交」，
 * 框下一行灰字写自己写的去向（effect）。没有选项的只给输入框。
 */
export function DecisionPicker({
  id,
  options,
  lastOptionId,
  pending,
  text,
  onText,
  onAnswer,
  effect,
}: {
  id: string;
  options: readonly DecisionOption[];
  /** 上次选的那项（带「上次选的」）。 */
  lastOptionId?: string | undefined;
  pending: boolean;
  /** 自己写的草稿放在行上：答了没做成、再答时还在。 */
  text: string;
  onText: (text: string) => void;
  onAnswer: (input: AnswerInput) => void;
  /** 自己写的一句去哪：框下那行灰字。 */
  effect: string;
}) {
  const trimmed = text.trim();
  return (
    <div id={id} className="mt-3 space-y-2.5 md:max-w-3xl" data-testid="decision-picker">
      {options.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border" aria-label="选一个">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                aria-label={o.label}
                aria-describedby={`${id}-${o.id}`}
                disabled={pending}
                onClick={() => onAnswer({ optionId: o.id })}
                data-option={o.id}
                className="group flex min-h-10 w-full flex-col gap-0.5 px-3 py-2 text-left outline-none first:rounded-t-md last:rounded-b-md hover:bg-st-human-soft focus-visible:ring-focus focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 md:flex-row md:items-baseline md:gap-4"
              >
                <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-body font-medium md:w-56">
                  {o.label}
                  {o.recommended ? <Tag tone="brand">推荐</Tag> : null}
                  {lastOptionId === o.id ? <Tag tone="stop">上次选的</Tag> : null}
                </span>
                <span id={`${id}-${o.id}`} className="min-w-0 flex-1 text-meta text-muted-foreground">
                  {o.detail}
                  {o.recommended ? <span className="text-foreground">。{o.recommended}</span> : null}
                </span>
                <ChevronRight
                  className="hidden size-4 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 md:block"
                  aria-hidden
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) onAnswer({ text: trimmed });
          }}
        >
          <Input
            aria-label="自己写一句"
            placeholder={options.length > 0 ? '都不合适？自己写一句' : '写你的决定'}
            value={text}
            maxLength={2000}
            disabled={pending}
            onChange={(e) => onText(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending || !trimmed}>
            <Send aria-hidden />
            提交
          </Button>
        </form>
        <p className="mt-1.5 text-meta text-muted-foreground" data-testid="custom-effect">
          {effect}
        </p>
      </div>
    </div>
  );
}
