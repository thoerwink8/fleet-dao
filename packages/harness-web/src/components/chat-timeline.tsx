import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toolPhrase } from '../lib/chat-view';
import { dayKey, formatDay } from '../lib/format';
import type { TimelineItem } from '../lib/transcript';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { DroppedRow, EndRow, ToolRow, ToolRunRow } from './transcript-steps';

function MarkdownText({ text }: { text: string }) {
  const chunks = text.split('```');
  return (
    <div className="space-y-2 text-sm leading-6 break-words text-ink">
      {chunks.map((chunk, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 一段正文按围栏切开，顺序就是身份
          <pre key={`f${i}`} className="overflow-x-auto rounded-md bg-subtle px-3 py-2 font-mono text-xs">
            {chunk.replace(/^[^\n]*\n/, '')}
          </pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 一段正文按围栏切开，顺序就是身份
          <p key={`t${i}`} className="whitespace-pre-wrap">
            {chunk}
          </p>
        ),
      )}
    </div>
  );
}

function userText(item: TimelineItem): string {
  if (item.kind !== 'event') return '';
  const text = item.ev.payload.text;
  return typeof text === 'string' ? text : '';
}

export function ChatTimeline({ items }: { items: TimelineItem[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  let lastDay = '';
  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-muted">还没有对话。下面发一句就开始。</p>;
  }
  return (
    <ol className="mx-auto flex max-w-3xl flex-col gap-3" data-testid="chat">
      {items.map((item) => {
        const at =
          item.kind === 'event'
            ? item.ev.createdAt
            : item.kind === 'toolrun'
              ? item.steps[0]?.at
              : item.kind === 'say' || item.kind === 'tool' || item.kind === 'end' || item.kind === 'dropped'
                ? item.step.at
                : undefined;
        const day = at ? dayKey(at) : '';
        const showDay = day !== '' && day !== lastDay;
        if (day) lastDay = day;
        const dayRow =
          showDay && at ? (
            <li key={`d-${day}`} className="flex items-center gap-3 text-2xs text-muted">
              <span className="h-px flex-1 bg-line" />
              {formatDay(at)}
              <span className="h-px flex-1 bg-line" />
            </li>
          ) : null;
        if (item.kind === 'event') {
          return (
            <Fragment key={`m-${item.ev.id}`}>
              {dayRow}
              <li className="flex justify-end">
                <div className="max-w-[80%] rounded-lg bg-bubble px-3 py-2 text-sm whitespace-pre-wrap text-fg-1">
                  {userText(item)}
                </div>
              </li>
            </Fragment>
          );
        }
        if (item.kind === 'say') {
          return (
            <Fragment key={`s-${item.step.id}`}>
              {dayRow}
              <li data-step-id={item.step.id} data-step-kind="say">
                <MarkdownText text={item.step.text} />
              </li>
            </Fragment>
          );
        }
        if (item.kind === 'end') {
          return (
            <Fragment key={`e-${item.step.id}`}>
              {dayRow}
              <EndRow step={item.step} />
            </Fragment>
          );
        }
        if (item.kind === 'dropped') {
          return (
            <Fragment key={`x-${item.step.id}`}>
              {dayRow}
              <DroppedRow step={item.step} />
            </Fragment>
          );
        }
        const steps = item.kind === 'tool' ? [item.step] : item.kind === 'toolrun' ? item.steps : [];
        const key = item.kind === 'tool' ? item.step.id : item.kind === 'toolrun' ? item.key : 0;
        const isOpen = open.has(key);
        const phrase =
          item.kind === 'toolrun' &&
          item.summary &&
          steps.some((s) => s.name === 'Edit' || s.name === 'Write')
            ? item.summary
            : toolPhrase(steps);
        return (
          <Fragment key={`t-${key}`}>
            {dayRow}
            <li>
              <Collapsible
                open={isOpen}
                onOpenChange={(v) =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
              >
                <CollapsibleTrigger className="flex h-7 items-center gap-1 text-xs text-muted hover:text-ink">
                  <ChevronRight className={isOpen ? 'size-3.5 rotate-90' : 'size-3.5'} />
                  {phrase}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {item.kind === 'toolrun' ? (
                    <ToolRunRow
                      steps={item.steps}
                      summary={item.summary}
                      failed={item.failed}
                      open
                      onToggle={() => {}}
                    />
                  ) : item.kind === 'tool' ? (
                    <ToolRow step={item.step} />
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
