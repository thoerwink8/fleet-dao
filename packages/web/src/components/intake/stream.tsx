// 消息流：电脑中栏和手机对话画面共用。人的消息按「我」靠右、别人靠左，各带头像、名字、时间；
// 指挥官另一种样式；结案以后只剩进度时间线和「引擎问你」卡。
import { Check, CornerDownRight, GitPullRequest, LoaderCircle } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';
import { StatusDot } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { inline, MarkdownLite } from '../markdown-lite';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { type DraftField, ENGINE_ASK, type Human, type Msg, type Option, PEOPLE, TIMELINE } from './data';
import { Avatar, personBubble } from './parts';

export type AskState = 'pending' | 'composing' | 'writing' | 'written' | 'failed';

export interface StreamProps {
  msgs: Msg[];
  viewer: Human;
  busy: boolean;
  closed: boolean;
  phone?: boolean;
  askState: AskState;
  askFail: string;
  onPickOption: (msgId: string, o: Option) => void;
  onJump: (f: DraftField) => void;
  onSuggest: (msgId: string, take: boolean) => void;
  onAnswerStart: () => void;
  onAnswerCancel: () => void;
  onAnswerSend: (text: string) => void;
  onRetry: () => void;
}

/** 把 @指挥官、@cxy 这类提到的人标出来。 */
function withMentions(text: string): ReactNode[] {
  return text.split(/(@[^\s，。,.！？]+)/).map((part, i) =>
    part.startsWith('@') ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: 文本切片按先后排
      <span key={i} className="rounded-sm bg-accent px-1 font-semibold">
        {part}
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 文本切片按先后排
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function Say({ m, viewer }: { m: Extract<Msg, { kind: 'say' }>; viewer: Human }) {
  if (m.who === 'ai') {
    return (
      <div className="flex gap-2.5">
        <Avatar who="ai" />
        <div className="min-w-0 max-w-2xl flex-1">
          <div className="mb-1 flex items-baseline gap-2 text-meta text-muted-foreground">
            <span className="font-medium text-foreground">指挥官</span>
            <span className="tabular-nums">{m.at}</span>
          </div>
          <MarkdownLite source={m.text} />
        </div>
      </div>
    );
  }
  const mine = m.who === viewer;
  return (
    <div className={cn('flex gap-2.5', mine && 'flex-row-reverse')}>
      <Avatar who={m.who} />
      <div className={cn('flex min-w-0 max-w-xl flex-col', mine ? 'items-end' : 'items-start')}>
        <div className="mb-1 flex items-baseline gap-2 text-meta text-muted-foreground">
          <span className="font-medium text-foreground">{PEOPLE[m.who].name}</span>
          <span>{PEOPLE[m.who].role}</span>
          <span className="tabular-nums">{m.at}</span>
        </div>
        <div className={cn('rounded-lg px-3 py-2 text-body whitespace-pre-wrap', personBubble[m.who])}>
          {withMentions(m.text)}
        </div>
      </div>
    </div>
  );
}

function Item({ m, p }: { m: Msg; p: StreamProps }) {
  if (m.kind === 'say') return <Say m={m} viewer={p.viewer} />;
  if (m.kind === 'patch') {
    return (
      <div className="pl-10">
        <button
          type="button"
          onClick={() => p.onJump(m.field)}
          disabled={p.closed || p.phone}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-meta text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none"
          title="点一下跳到右边对应的栏"
        >
          <CornerDownRight className="size-3.5" aria-hidden />
          {m.text}
          {p.closed || p.phone ? null : <span className="underline underline-offset-2">看看</span>}
        </button>
      </div>
    );
  }
  if (m.kind === 'suggest') {
    return (
      <div className="pl-10">
        <div className="max-w-xl rounded-lg border border-st-stall-line bg-st-stall-soft px-3 py-2 text-body">
          <div className="text-meta font-medium text-ink-stall">建议改（这一栏有人改过，我没动）</div>
          <p className="mt-1">{inline(m.text)}</p>
          {m.state ? (
            <div className="mt-2 text-meta text-muted-foreground">
              {m.state === 'taken' ? '已采用，草稿已更新' : '不用，保持原样'}
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button size="xs" onClick={() => p.onSuggest(m.id, true)}>
                采用
              </Button>
              <Button size="xs" variant="outline" onClick={() => p.onSuggest(m.id, false)}>
                不用
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (m.kind === 'ask') {
    return (
      <div className="flex gap-2.5">
        <Avatar who="ai" />
        <div className="min-w-0 max-w-2xl flex-1">
          <div className="mb-1 text-meta text-muted-foreground">
            <span className="font-medium text-foreground">指挥官</span> · 一次一个问题
          </div>
          <p className="text-heading">{m.question}</p>
          {m.answered ? (
            <div className="mt-2 inline-flex items-center gap-1.5 text-meta text-muted-foreground">
              <Check className="size-3.5" aria-hidden />
              选了：{m.answered}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {m.options.map((o) => (
                <Button
                  key={o.label}
                  variant="outline"
                  className="max-md:h-11"
                  onClick={() => p.onPickOption(m.id, o)}
                >
                  {o.label}
                </Button>
              ))}
              <Button
                variant="ghost"
                className="max-md:h-11"
                onClick={() => document.getElementById('intake-input')?.focus()}
              >
                我自己说
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (m.kind === 'divider') {
    return (
      <div className="flex items-center gap-3 text-meta text-muted-foreground" data-intake-divider>
        <span className="h-px flex-1 bg-border" />
        {m.text}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-1.5 text-center text-meta text-muted-foreground">
      {m.at ? <span className="tabular-nums">{m.at}</span> : null}
      {m.text}
    </div>
  );
}

function Timeline() {
  return (
    <div className="max-w-xl rounded-lg border px-4 py-3" data-intake-timeline>
      <div className="mb-2 flex items-center gap-2 text-heading">
        <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
        进度
        <Tag mono>#12</Tag>
        <span className="ml-auto text-meta font-normal text-muted-foreground">从 GitHub 读</span>
      </div>
      <ol>
        {TIMELINE.map((s, i) => (
          <li key={s.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'mt-1.5 size-3 shrink-0 rounded-full',
                  s.state === 'done' && 'bg-st-done',
                  s.state === 'now' && 'bg-st-run fd-dot-live',
                  s.state === 'todo' && 'border border-input',
                )}
              />
              {i < TIMELINE.length - 1 ? (
                <span className={cn('w-px grow', s.state === 'done' ? 'bg-st-done-line' : 'bg-border')} />
              ) : null}
            </div>
            <div className="min-w-0 flex-1 pb-3">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={cn('text-body', s.state === 'todo' ? 'text-muted-foreground' : 'font-medium')}
                >
                  {s.label}
                </span>
                <span className="text-meta text-muted-foreground tabular-nums">{s.at}</span>
              </div>
              {s.note ? <div className="text-meta text-muted-foreground">{s.note}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function EngineAsk({ p }: { p: StreamProps }) {
  const state = p.askState;
  const written = state === 'written';
  const open = state === 'composing' || state === 'writing';
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (state === 'composing') ref.current?.focus();
  }, [state]);
  return (
    <div className="max-w-xl" data-intake-engine-ask data-state={state}>
      <div
        className={cn(
          'rounded-lg border px-4 py-3',
          written ? 'bg-muted' : 'border-st-human-line bg-st-human-soft',
        )}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-heading">引擎问你</span>
          <Tag mono>{ENGINE_ASK.comment}</Tag>
          {written ? (
            <span className="inline-flex items-center gap-1 text-meta text-ink-done">
              <Check className="size-3.5" aria-hidden />
              已写回
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-meta text-ink-human">
              <StatusDot tone="human" />
              {state === 'writing' ? '正在写回……' : '待答'}
            </span>
          )}
          <span className="ml-auto text-meta text-muted-foreground tabular-nums">{ENGINE_ASK.at}</span>
        </div>
        <p className="text-body">{inline(ENGINE_ASK.text)}</p>
        {state === 'failed' ? (
          <div
            className="mt-2 rounded-md border border-st-fail-line bg-st-fail-soft px-2 py-1.5 text-meta text-ink-fail"
            role="alert"
          >
            没写回去：{p.askFail}
            <Button size="xs" variant="outline" className="ml-2" onClick={p.onRetry}>
              重试
            </Button>
          </div>
        ) : null}
        {open ? (
          <AnswerBox
            ref={ref}
            busy={state === 'writing'}
            onCancel={p.onAnswerCancel}
            onSend={p.onAnswerSend}
          />
        ) : null}
        {state === 'pending' || state === 'failed' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="brand" className="max-md:h-11" onClick={p.onAnswerStart}>
              回答
            </Button>
            <span className="text-meta text-muted-foreground">
              答复写在 {ENGINE_ASK.comment} 下面，不改需求
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

import { forwardRef, useState } from 'react';

const AnswerBox = forwardRef<
  HTMLTextAreaElement,
  { busy: boolean; onCancel: () => void; onSend: (t: string) => void }
>(function AnswerBox({ busy, onCancel, onSend }, ref) {
  const [t, setT] = useState('');
  return (
    <div className="mt-3 space-y-2">
      <div className="text-meta text-muted-foreground">正在回答：{ENGINE_ASK.comment}</div>
      <Textarea
        ref={ref}
        rows={2}
        value={t}
        onChange={(e) => setT(e.target.value)}
        placeholder="写下对这一问的答复……"
        aria-label="答复引擎"
        className="min-h-0 bg-background"
      />
      <div className="flex gap-2">
        <Button
          variant="brand"
          className="max-md:h-11"
          disabled={!t.trim() || busy}
          onClick={() => onSend(t.trim())}
        >
          写回评论
        </Button>
        <Button variant="ghost" className="max-md:h-11" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
});

export function MessageStream(p: StreamProps) {
  const endRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息或状态变了就滚到底
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [p.msgs.length, p.busy, p.askState]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-intake-stream>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
        {p.msgs.map((m) => (
          <Item key={m.id} m={m} p={p} />
        ))}
        {p.busy ? (
          <div
            className="flex items-center gap-3 pl-10 text-body text-muted-foreground"
            role="status"
            data-intake-reading
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            正在读代码{' '}
            <code className="rounded-sm bg-muted px-1 font-mono text-meta">web/src/pages/Settings.tsx</code>……
          </div>
        ) : null}
        {p.closed ? (
          <>
            <Timeline />
            <EngineAsk p={p} />
          </>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
