// 消息流（电脑中栏和手机全屏聊天共用）。对话是主角：
// 我发的在右边、气泡、没有头像；别人在左边、小头像，连续几条只在第一条上方写名字；
// 指挥官在左边、机器人小图标、不加气泡（纯文本）；单子卡、拍板卡、进度小卡、引擎提问都是消息流里的小卡。
import { Check, ChevronRight, CornerDownRight, LoaderCircle } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { StatusDot } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { inline, MarkdownLite } from '../markdown-lite';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  type Draft,
  type DraftField,
  type DupState,
  ENGINE_ASK,
  type Human,
  type Msg,
  type Option,
  PEOPLE,
  type Status,
  TIMELINE,
} from './data';
import { Avatar, mineBubble } from './parts';

export type AskState = 'pending' | 'composing' | 'writing' | 'written' | 'failed';

export interface StreamProps {
  msgs: Msg[];
  viewer: Human;
  busy: boolean;
  status: Status;
  closed: boolean;
  phone?: boolean;
  draft: Draft;
  dup: DupState | null;
  partner: boolean;
  closedText: string | null;
  askState: AskState;
  askFail: string;
  onPickOption: (msgId: string, o: Option) => void;
  onOpenPanel: (f?: DraftField) => void;
  onSuggest: (msgId: string, take: boolean) => void;
  onSubmit: () => void;
  onYes: () => void;
  onNo: (reason: string) => void;
  onAgain: () => void;
  onAnswerStart: () => void;
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

const SPACER = 'w-6 shrink-0';

function Say({
  m,
  prev,
  viewer,
}: {
  m: Extract<Msg, { kind: 'say' }>;
  prev: Msg | undefined;
  viewer: Human;
}) {
  const first = !(prev && prev.kind === 'say' && prev.who === m.who);
  if (m.who === 'ai') {
    return (
      <div className="flex gap-2">
        {first ? <Avatar who="ai" size="md" /> : <span className={SPACER} />}
        <div className="min-w-0 max-w-2xl flex-1">
          {first ? <div className="mb-0.5 text-meta text-muted-foreground">指挥官</div> : null}
          <MarkdownLite source={m.text} />
        </div>
      </div>
    );
  }
  if (m.who === viewer) {
    return (
      <div
        className={cn('flex justify-end', first ? 'mt-1' : '-mt-2.5')}
        title={`${PEOPLE[m.who].name} ${m.at}`}
      >
        <div className={cn('max-w-xl rounded-lg px-3 py-2 text-body whitespace-pre-wrap', mineBubble)}>
          {withMentions(m.text)}
        </div>
      </div>
    );
  }
  return (
    <div className={cn('flex gap-2', first ? 'mt-1' : '-mt-2.5')} title={`${PEOPLE[m.who].name} ${m.at}`}>
      {first ? <Avatar who={m.who} size="md" /> : <span className={SPACER} />}
      <div className="min-w-0 max-w-xl">
        {first ? (
          <div className="mb-0.5 text-meta text-muted-foreground">
            {PEOPLE[m.who].name} · <span className="tabular-nums">{m.at}</span>
          </div>
        ) : null}
        <div className="w-fit rounded-lg bg-muted px-3 py-2 text-body whitespace-pre-wrap">
          {withMentions(m.text)}
        </div>
      </div>
    </div>
  );
}

function BriefCard({ p }: { p: StreamProps }) {
  const d = p.draft;
  const label = p.partner ? '提交给 cxy 拍板' : '确定，开单';
  const mineToSubmit = p.viewer === (p.partner ? 'fxc188' : 'cxy');
  return (
    <div
      className="ml-8 max-w-xl rounded-lg border bg-background px-3 py-2.5 text-card-foreground"
      data-intake-brief
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-heading">{d.title}</span>
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">第 {d.version} 版</span>
      </div>
      <p className="mt-1 line-clamp-2 text-body text-muted-foreground">{d.want}</p>
      <p className="mt-0.5 text-meta text-muted-foreground">
        怎么算做完 {d.done.length} 条 · 已知的模块 {d.modules.length} 个 · 规模 {d.size}
      </p>
      {p.dup?.kind === 'found' && p.status === 'discussing' ? (
        <p className="mt-1 truncate text-meta text-ink-stall">
          可能重复 #{p.dup.issue} {p.dup.title}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {p.status === 'discussing' ? (
          mineToSubmit ? (
            <Button variant="brand" className="max-md:h-11" onClick={p.onSubmit}>
              {label}
            </Button>
          ) : (
            <span className="text-meta text-muted-foreground">由发起人 {d.quotes[0]?.who} 提交</span>
          )
        ) : (
          <span className="text-meta text-muted-foreground">已提交</span>
        )}
        {p.phone ? null : (
          <Button variant="ghost" className="max-md:h-11" onClick={() => p.onOpenPanel()}>
            看全文
          </Button>
        )}
        {p.phone ? (
          <Button variant="ghost" className="h-11" onClick={() => p.onOpenPanel()}>
            看全文
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SubmitCard({
  m,
  active,
  p,
}: {
  m: Extract<Msg, { kind: 'submit' }>;
  active: boolean;
  p: StreamProps;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const canDecide = active && p.status === 'pending' && p.viewer === 'cxy';
  const outcome = !active
    ? '已退回，重新讨论'
    : p.status === 'do'
      ? 'cxy 已同意做'
      : p.status === 'no'
        ? 'cxy 不做'
        : p.status === 'discussing'
          ? '已退回，重新讨论'
          : '等 cxy 拍板';
  return (
    <div
      className="ml-8 max-w-xl rounded-lg border bg-background px-3 py-2.5"
      data-intake-submit
      data-active={active}
    >
      <div className="flex items-center gap-2 text-body">
        <Avatar who={m.who} size="sm" />
        <span className="min-w-0 flex-1 font-medium">
          {m.who} 提交拍板 · 第 {m.version} 版
        </span>
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{m.at}</span>
      </div>
      {canDecide ? (
        asking ? (
          <div className="mt-2 space-y-2">
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
                className="flex-1 max-md:h-11"
                disabled={!reason.trim()}
                onClick={() => p.onNo(reason.trim())}
              >
                确认不做
              </Button>
              <Button variant="outline" className="flex-1 max-md:h-11" onClick={() => setAsking(false)}>
                返回
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex gap-2" data-intake-decide>
            <Button variant="brand" className="flex-1 max-md:h-11" onClick={p.onYes}>
              同意做
            </Button>
            <Button variant="outline" className="flex-1 max-md:h-11" onClick={() => setAsking(true)}>
              不做
            </Button>
            <Button variant="outline" className="flex-1 max-md:h-11" onClick={p.onAgain}>
              再聊聊
            </Button>
          </div>
        )
      ) : (
        <div className="mt-1 flex items-center gap-1.5 text-meta text-muted-foreground">
          {outcome === '等 cxy 拍板' ? <StatusDot tone="human" /> : null}
          {outcome}
        </div>
      )}
    </div>
  );
}

function Item({
  m,
  prev,
  p,
  lastSubmit,
}: {
  m: Msg;
  prev: Msg | undefined;
  p: StreamProps;
  lastSubmit: string | null;
}) {
  if (m.kind === 'say') return <Say m={m} prev={prev} viewer={p.viewer} />;
  if (m.kind === 'patch') {
    return (
      <div className="-mt-2.5 pl-8">
        <button
          type="button"
          onClick={() => p.onOpenPanel(m.field)}
          disabled={p.closed}
          className="inline-flex min-h-6 items-center gap-1 rounded-sm bg-muted px-2 text-meta text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none"
          title="打开单子，看改了哪里"
        >
          <CornerDownRight className="size-3" aria-hidden />
          {m.text}
        </button>
      </div>
    );
  }
  if (m.kind === 'suggest') {
    return (
      <div className="pl-8">
        <div className="max-w-xl rounded-lg border border-st-stall-line bg-st-stall-soft px-3 py-1.5 text-body">
          <span className="text-meta font-medium text-ink-stall">建议改（这栏你改过，我没动）</span>
          <p>{inline(m.text)}</p>
          {m.state ? (
            <div className="text-meta text-muted-foreground">
              {m.state === 'taken' ? '已采用，单子已更新' : '不用，保持原样'}
            </div>
          ) : (
            <div className="mt-1 flex gap-2">
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
      <div className="flex gap-2">
        <Avatar who="ai" size="md" />
        <div className="min-w-0 max-w-2xl flex-1">
          <div className="mb-0.5 text-meta text-muted-foreground">指挥官 · 一次一个问题</div>
          <p className="text-heading">{m.question}</p>
          {m.answered ? (
            <div className="mt-1.5 inline-flex items-center gap-1.5 text-meta text-muted-foreground">
              <Check className="size-3.5" aria-hidden />
              选了：{m.answered}
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
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
  if (m.kind === 'brief') return <BriefCard p={p} />;
  if (m.kind === 'submit') return <SubmitCard m={m} active={m.id === lastSubmit} p={p} />;
  if (m.kind === 'divider') {
    return (
      <div className="flex items-center gap-3 text-meta text-muted-foreground" data-intake-divider>
        <span className="h-px flex-1 bg-border" />
        {m.text}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return <div className="text-center text-meta text-muted-foreground">{m.text}</div>;
}

/** 进度：一张可折叠小卡，展开才是时间线。 */
function ProgressCard() {
  const [open, setOpen] = useState(false);
  const now = TIMELINE.findIndex((s) => s.state === 'now');
  const cur = TIMELINE[now] ?? TIMELINE[TIMELINE.length - 1];
  return (
    <div className="ml-8 max-w-xl rounded-lg border bg-background" data-intake-timeline data-open={open}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-body max-md:min-h-11"
      >
        <StatusDot tone="run" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">#12 {cur?.label}</span>
          <span className="text-muted-foreground">
            {' '}
            · 第 {now + 1}/{TIMELINE.length} 步
          </span>
        </span>
        <ChevronRight
          className={cn(
            'size-4 text-muted-foreground transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <ol className="border-t px-3 pt-2">
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
              <div className="min-w-0 flex-1 pb-2.5">
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
      ) : null}
    </div>
  );
}

/** 引擎提问：一条来自「引擎」的消息，带「回答」。回答的输入框在底部细栏里。 */
function EngineMsg({ p }: { p: StreamProps }) {
  const s = p.askState;
  const written = s === 'written';
  return (
    <div className="flex gap-2" data-intake-engine-ask data-state={s}>
      <Avatar who="engine" size="md" />
      <div className="min-w-0 max-w-xl flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-meta text-muted-foreground">
          引擎 · <span className="tabular-nums">{ENGINE_ASK.at}</span>
          <Tag mono>{ENGINE_ASK.comment}</Tag>
          {written ? (
            <span className="inline-flex items-center gap-1 text-ink-done">
              <Check className="size-3.5" aria-hidden />
              已写回
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-ink-human">
              <StatusDot tone="human" />
              {s === 'writing' ? '正在写回……' : '待答'}
            </span>
          )}
        </div>
        <div
          className={cn(
            'rounded-lg border px-3 py-2',
            written ? 'bg-muted' : 'border-st-human-line bg-st-human-soft',
          )}
        >
          <p className="text-body">{inline(ENGINE_ASK.text)}</p>
          {s === 'failed' ? (
            <div className="mt-1.5 text-meta text-ink-fail" role="alert">
              没写回去：{p.askFail}
              <Button size="xs" variant="outline" className="ml-2" onClick={p.onRetry}>
                重试
              </Button>
            </div>
          ) : null}
          {s === 'pending' || s === 'failed' ? (
            <div className="mt-2 flex items-center gap-2">
              <Button variant="brand" className="max-md:h-11" onClick={p.onAnswerStart}>
                回答
              </Button>
              <span className="text-meta text-muted-foreground">写进 {ENGINE_ASK.comment}，不改需求</span>
            </div>
          ) : null}
          {s === 'composing' ? (
            <div className="mt-1.5 text-meta text-muted-foreground">在下面的输入栏里写答复</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MessageStream(p: StreamProps) {
  const endRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息或状态变了就滚到底
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [p.msgs.length, p.busy, p.askState, p.status]);
  const lastSubmit = [...p.msgs].reverse().find((m) => m.kind === 'submit')?.id ?? null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-intake-stream>
      <div className="mx-auto flex max-w-chat flex-col gap-3 px-4 py-4">
        {p.msgs.map((m, i) => (
          <Item key={m.id} m={m} prev={p.msgs[i - 1]} p={p} lastSubmit={lastSubmit} />
        ))}
        {p.busy ? (
          <div
            className="flex items-center gap-2 pl-8 text-body text-muted-foreground"
            role="status"
            data-intake-reading
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            正在读代码{' '}
            <code className="rounded-sm bg-muted px-1 font-mono text-meta">web/src/pages/Settings.tsx</code>……
          </div>
        ) : null}
        {p.closedText ? (
          <>
            <div className="flex items-center gap-3 text-meta text-muted-foreground" data-intake-closed>
              <span className="h-px flex-1 bg-border" />
              {p.closedText}
              <span className="h-px flex-1 bg-border" />
            </div>
            {p.status === 'do' ? (
              <>
                <ProgressCard />
                <EngineMsg p={p} />
              </>
            ) : null}
          </>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
