import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { toolPhrase } from '../lib/chat-view';
import { dayKey, formatDay } from '../lib/format';
import {
  APPROVAL_CATEGORY_LABEL,
  APPROVAL_RESULT_LABEL,
  APPROVAL_STATUS_LABEL,
  APPROVALS_UNSUPPORTED,
} from '../lib/labels';
import type { ApprovalView, TimelineItem } from '../lib/transcript';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { DroppedRow, EndRow, ToolRow, ToolRunRow } from './transcript-steps';

export function ApprovalsNote({ mode }: { mode: 'per-call' | 'none' | undefined }) {
  if (mode !== 'none') return null;
  return (
    <p
      data-testid="approvals-none"
      className="mb-3 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-2"
    >
      {APPROVALS_UNSUPPORTED}
    </p>
  );
}

export function ApprovalRow({
  card,
  onDecide,
}: {
  card: ApprovalView;
  onDecide?: (approvalId: string, decision: 'allow' | 'deny') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const category = APPROVAL_CATEGORY_LABEL[card.category] ?? card.category;
  const status = APPROVAL_STATUS_LABEL[card.status] ?? card.status;
  const result = card.result ? (APPROVAL_RESULT_LABEL[card.result] ?? card.result) : '';
  const act = (decision: 'allow' | 'deny') => {
    if (!onDecide || busy) return;
    setBusy(true);
    setError('');
    void onDecide(card.approvalId, decision).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '没送出去');
      setBusy(false);
    });
  };
  const who = [card.by, card.decidedAt, result].filter((part) => part);
  return (
    <li
      data-testid="approval-card"
      data-approval-id={card.approvalId}
      data-status={card.status}
      className="rounded-lg border border-line bg-surface px-3 py-3"
    >
      <p className="text-sm text-ink">
        {status}
        <span className="text-ink-2"> · {category}</span>
      </p>
      <p className="mt-1 font-mono text-xs text-ink">{card.tool}</p>
      {card.input ? (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-subtle px-3 py-2 font-mono text-xs text-ink">
          {card.input}
        </pre>
      ) : null}
      {who.length > 0 ? <p className="mt-2 text-2xs text-muted">{who.join(' · ')}</p> : null}
      {card.status === 'pending' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" data-testid="approval-allow" disabled={busy} onClick={() => act('allow')}>
            允许
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-testid="approval-deny"
            disabled={busy}
            onClick={() => act('deny')}
          >
            拒绝
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </li>
  );
}

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

function childSessionId(item: TimelineItem): string {
  if (item.kind !== 'event') return '';
  const from = item.ev.payload.from;
  if (!from || typeof from !== 'object' || Array.isArray(from)) return '';
  const id = (from as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

export function ChatTimeline({
  items,
  onDecide,
}: {
  items: TimelineItem[];
  onDecide?: (approvalId: string, decision: 'allow' | 'deny') => Promise<void>;
}) {
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
            : item.kind === 'approval'
              ? item.card.at
              : item.kind === 'toolrun'
                ? item.steps[0]?.at
                : item.kind === 'say' ||
                    item.kind === 'tool' ||
                    item.kind === 'end' ||
                    item.kind === 'dropped'
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
        if (item.kind === 'event' && item.ev.payload.kind === 'report') {
          const childId = childSessionId(item);
          return (
            <Fragment key={`m-${item.ev.id}`}>
              {dayRow}
              <li data-kind="report" className="rounded-lg border border-line bg-raised px-3 py-2">
                <p className="text-2xs text-muted">子会话回报</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{userText(item)}</p>
                {childId ? (
                  <Link
                    to={`/s/${encodeURIComponent(childId)}`}
                    className="mt-1 inline-block text-2xs text-ink-2 underline"
                  >
                    打开子会话
                  </Link>
                ) : null}
              </li>
            </Fragment>
          );
        }
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
        if (item.kind === 'approval') {
          return (
            <Fragment key={`ap-${item.card.id}`}>
              {dayRow}
              <ApprovalRow card={item.card} {...(onDecide ? { onDecide } : {})} />
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
