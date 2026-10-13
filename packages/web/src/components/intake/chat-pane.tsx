// 中栏「和指挥官聊」：选仓、消息流、输入框。开单之后消息流里接着长进度时间线和「引擎问你」卡。
import { ArrowUp, Check, CornerDownRight, GitPullRequest, LoaderCircle, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { NativeSelect } from '../layout/native-select';
import { StatusDot } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { inline, MarkdownLite } from '../markdown-lite';
import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';
import { Textarea } from '../ui/textarea';
import { type DraftField, ENGINE_ASK, type Msg, type Option, REPOS, TIMELINE } from './data';

export type AskState = 'pending' | 'composing' | 'writing' | 'written' | 'failed';

export interface ChatProps {
  repo: string;
  onRepo: (r: string) => void;
  repoLocked: boolean;
  msgs: Msg[];
  busy: boolean;
  opened: boolean;
  askState: AskState;
  askFail: string;
  onSend: (text: string) => void;
  onPickOption: (msgId: string, o: Option) => void;
  onJump: (f: DraftField) => void;
  onSuggest: (msgId: string, take: boolean) => void;
  onAnswerStart: () => void;
  onAnswerCancel: () => void;
  onRetry: () => void;
}

function Avatar() {
  return (
    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand text-meta font-semibold text-brand-foreground">
      指
    </span>
  );
}

function Bubble({
  m,
  onJump,
  onPick,
  onSuggest,
}: {
  m: Msg;
  onJump: ChatProps['onJump'];
  onPick: ChatProps['onPickOption'];
  onSuggest: ChatProps['onSuggest'];
}) {
  if (m.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-xl rounded-lg bg-selected px-3 py-2 text-body whitespace-pre-wrap">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.kind === 'ai') {
    return (
      <div className="flex gap-3">
        <Avatar />
        <div className="max-w-2xl min-w-0 flex-1">
          <div className="mb-1 text-meta text-muted-foreground">指挥官</div>
          <MarkdownLite source={m.text} />
        </div>
      </div>
    );
  }
  if (m.kind === 'patch') {
    return (
      <div className="pl-10">
        <button
          type="button"
          onClick={() => onJump(m.field)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
          title="点一下跳到右边对应的栏"
        >
          <CornerDownRight className="size-3.5" aria-hidden />
          {m.text}
          <span className="text-ink-run">看看</span>
        </button>
      </div>
    );
  }
  if (m.kind === 'suggest') {
    return (
      <div className="pl-10">
        <div className="max-w-xl rounded-lg border border-st-stall-line bg-st-stall-soft px-3 py-2 text-body">
          <div className="text-meta font-medium text-ink-stall">建议改（这一栏你改过，我没动）</div>
          <p className="mt-1">{inline(m.text)}</p>
          {m.state ? (
            <div className="mt-2 text-meta text-muted-foreground">
              {m.state === 'taken' ? '已采用，草稿已更新' : '不用，保持你写的'}
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button size="xs" onClick={() => onSuggest(m.id, true)}>
                采用
              </Button>
              <Button size="xs" variant="outline" onClick={() => onSuggest(m.id, false)}>
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
      <div className="flex gap-3">
        <Avatar />
        <div className="max-w-2xl min-w-0 flex-1">
          <div className="mb-1 text-meta text-muted-foreground">指挥官 · 一次一个问题</div>
          <p className="text-heading">{m.question}</p>
          {m.answered ? (
            <div className="mt-2 inline-flex items-center gap-1.5 text-meta text-muted-foreground">
              <Check className="size-3.5" aria-hidden />
              你选了：{m.answered}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {m.options.map((o) => (
                <Button key={o.label} variant="outline" onClick={() => onPick(m.id, o)}>
                  {o.label}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => document.getElementById('intake-input')?.focus()}>
                我自己说
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-meta text-muted-foreground" data-intake-divider>
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5">
        <Check className="size-3.5 text-ink-done" aria-hidden />
        {m.text}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Timeline() {
  return (
    <div className="ml-10 max-w-xl rounded-lg border px-4 py-3" data-intake-timeline>
      <div className="mb-2 flex items-center gap-2 text-heading">
        <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
        进度
        <Tag mono>#12</Tag>
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

function EngineAsk({
  state,
  fail,
  onStart,
  onRetry,
}: {
  state: AskState;
  fail: string;
  onStart: () => void;
  onRetry: () => void;
}) {
  const written = state === 'written';
  return (
    <div className="ml-10 max-w-xl" data-intake-engine-ask data-state={state}>
      <div
        className={cn(
          'rounded-lg border px-4 py-3',
          written ? 'bg-card' : 'border-st-human-line bg-st-human-soft',
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
            没写回去：{fail}
            <Button size="xs" variant="outline" className="ml-2" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : null}
        {state === 'pending' || state === 'failed' || state === 'composing' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="brand" onClick={onStart} disabled={state === 'composing'}>
              回答
            </Button>
            <span className="text-meta text-muted-foreground">
              答复写在 {ENGINE_ASK.comment} 下面，不进草稿
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPane(p: ChatProps) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息或状态变了就滚到底
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [p.msgs.length, p.busy, p.askState]);
  useEffect(() => {
    if (p.askState === 'composing') document.getElementById('intake-input')?.focus();
  }, [p.askState]);

  const answering = p.askState === 'composing';
  const send = () => {
    const t = text.trim();
    if (!t || p.busy) return;
    p.onSend(t);
    setText('');
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const placeholder = answering
    ? '写下你对这一问的答复……'
    : p.opened && p.askState === 'pending'
      ? '回答引擎的问题：先点上面卡片的「回答」；直接说话会交给指挥官判断'
      : '说说你想要什么，大白话就行……';
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="和指挥官聊">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h2 className="text-heading">和指挥官聊</h2>
        <span className="ml-auto flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
          仓
          <NativeSelect
            className="min-w-0"
            aria-label="选仓"
            value={p.repo}
            disabled={p.repoLocked}
            onChange={(e) => p.onRepo(e.target.value)}
          >
            {REPOS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </NativeSelect>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-intake-stream>
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
          {p.msgs.map((m) => (
            <Bubble key={m.id} m={m} onJump={p.onJump} onPick={p.onPickOption} onSuggest={p.onSuggest} />
          ))}
          {p.busy ? (
            <div
              className="flex items-center gap-3 pl-10 text-body text-muted-foreground"
              role="status"
              data-intake-reading
            >
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              正在读代码{' '}
              <code className="rounded-sm bg-muted px-1 font-mono text-meta">web/src/pages/Settings.tsx</code>
              ……
            </div>
          ) : null}
          {p.opened ? (
            <>
              <Timeline />
              <EngineAsk state={p.askState} fail={p.askFail} onStart={p.onAnswerStart} onRetry={p.onRetry} />
            </>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      <footer className="border-t bg-panel px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {answering ? (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-st-human-line bg-st-human-soft px-3 py-1.5 text-meta">
              <CornerDownRight className="size-3.5 shrink-0 text-ink-human" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                正在回答：引擎问的「{ENGINE_ASK.text.replace(/`/g, '').slice(0, 26)}……」{ENGINE_ASK.comment}
              </span>
              <button
                type="button"
                onClick={p.onAnswerCancel}
                className="inline-flex items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden />
                取消
              </button>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <Textarea
              id="intake-input"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={key}
              placeholder={placeholder}
              className="max-h-40 min-h-0 flex-1 resize-none bg-background"
              aria-label="消息"
            />
            <Button
              variant={answering ? 'brand' : 'default'}
              onClick={send}
              disabled={!text.trim() || p.busy}
            >
              <ArrowUp aria-hidden />
              {answering ? '写回评论' : '发送'}
            </Button>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-meta text-muted-foreground">
            <Kbd>Enter</Kbd>发送
            <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>换行
          </div>
        </div>
      </footer>
    </section>
  );
}
