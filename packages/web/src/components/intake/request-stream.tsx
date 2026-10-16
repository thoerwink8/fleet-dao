// 对话里的消息流（#2062，方案第四节）：电脑中栏和手机全屏聊天共用。
// 我说的在右边带气泡；别人在左边、小头像，连续几条只在第一条上面写名字；指挥官在左边、不加气泡；系统的话居中一行小字。
// 拍板卡（待拍板时在最后）：只有拍板人能点「同意做 / 不做 / 再聊聊」，别人看到「等谁拍」。草稿齐了的一张紧凑卡带「提交拍板 / 确定，开单」。
// 结案后最后一行是结案分隔线。B、C 片的消息（指挥官一问的选项、建议改、进度卡、引擎提问的回答、别家意见、换模型分隔线、
// 暂停原因、方案卡、指挥官正在回话）画法在 request-cards.tsx。
import { pausedWhy } from '@fleet-dao/shared';
import { CornerDownRight } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRequestAction } from '../../api/client';
import type { RequestDetail, RequestDraftField, RequestMessage } from '../../api/types';
import { formatClock, formatDateTime } from '../../lib/format';
import { cn } from '../../lib/utils';
import { StatusDot } from '../layout/status-badge';
import { MarkdownLite } from '../markdown-lite';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useOpenIssueAction } from './open-issue';
import { BotAvatar, PersonAvatar } from './people';
import {
  CommanderLive,
  EngineAsk,
  ProposalCard,
  progressCard,
  QuestionCard,
  ReviewCard,
  SuggestCard,
} from './request-cards';

export const FIELD_LABELS: Record<RequestDraftField, string> = {
  title: '标题',
  kind: '类别',
  scene: '场景',
  modules: '已知的模块',
  want: '要什么',
  done: '怎么算做完',
  notDo: '不做什么',
  size: '规模建议',
  needsHuman: '要不要人拍',
};

/** 把 @某人 标出来。 */
function withMentions(text: string): ReactNode[] {
  return text.split(/(@[^\s，。,.！？]+)/).map((part, i) =>
    part.startsWith('@') ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: 文本切片按先后排
      <span key={i} className="rounded-sm bg-accent px-1 font-medium">
        {part}
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 文本切片按先后排
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** 系统的话里的单子网址（「开出 #12：https://github.com/…/issues/12」）不整串铺开：网址收成一个能点的「#12」，前面已经写了「#12：」就并成一个。 */
const ISSUE_URL = /(#\d+：)?(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+))/g;
export function withIssueLinks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(ISSUE_URL)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a
        key={at}
        href={m[2]}
        target="_blank"
        rel="noreferrer"
        className="text-foreground underline-offset-2 hover:underline"
      >
        #{m[3]}
      </a>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const SPACER = 'w-6 shrink-0';

function sameSpeaker(a: RequestMessage | undefined, b: RequestMessage): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind !== 'human' || a.author?.id === b.author?.id;
}

function patchedFields(m: RequestMessage): RequestDraftField[] {
  if (!m.draftPatch) return [];
  return Object.keys(m.draftPatch).filter((k): k is RequestDraftField => k in FIELD_LABELS);
}

function Message({
  m,
  prev,
  d,
  meId,
  phone,
  liveQuestion,
  liveProposal,
  onOpenPanel,
  onPick,
}: {
  m: RequestMessage;
  prev: RequestMessage | undefined;
  d: RequestDetail;
  meId: string | undefined;
  phone: boolean;
  /** 最新那一问、还能发消息：它的选项能点。 */
  liveQuestion: boolean;
  /** 最新那张方案、还能发消息：「确认开单」和「改」能点。 */
  liveProposal: boolean;
  onOpenPanel: (field?: RequestDraftField) => void;
  onPick: (text: string) => Promise<boolean>;
}) {
  const first = !sameSpeaker(prev, m);
  const at = formatClock(m.createdAt);
  if (m.kind === 'system') {
    if (m.card?.type === 'model_switch') {
      return (
        <div className="flex items-center gap-3 text-meta text-muted-foreground" data-message="model-switch">
          <span className="h-px flex-1 bg-border" />
          <span className="min-w-0 text-center">{m.body}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    }
    if (m.card?.type === 'paused') {
      return (
        <div className="flex justify-center" data-message="paused">
          <span className="rounded-md border border-st-stall-line bg-st-stall-soft px-3 py-1 text-meta text-ink-stall">
            {pausedWhy(m.card.why)}
          </span>
        </div>
      );
    }
    const progress = progressCard(m, d);
    if (progress) return progress;
    return (
      <div
        className="text-center text-meta text-muted-foreground"
        data-message="system"
        title={formatDateTime(m.createdAt)}
      >
        {withIssueLinks(m.body)}
      </div>
    );
  }
  if (m.kind === 'commander') {
    const fields = patchedFields(m);
    return (
      <div className={cn('flex gap-2', !first && '-mt-1.5')} data-message="commander">
        {first ? <BotAvatar who="commander" /> : <span className={SPACER} />}
        <div className="min-w-0 max-w-2xl flex-1">
          {first ? (
            <div className="mb-0.5 text-meta text-muted-foreground">
              指挥官 · <span className="tabular-nums">{at}</span>
            </div>
          ) : null}
          <MarkdownLite source={m.body} />
          {m.card?.type === 'question' ? (
            <QuestionCard card={m.card} live={liveQuestion} onPick={onPick} />
          ) : null}
          {m.card?.type === 'proposal' ? (
            <ProposalCard card={m.card} d={d} live={liveProposal} onEdit={onOpenPanel} />
          ) : null}
          {m.card?.type === 'suggest' ? (
            <SuggestCard card={m.card} d={d} label={FIELD_LABELS[m.card.field]} phone={phone} />
          ) : null}
          {fields.length > 0 ? (
            <button
              type="button"
              onClick={() => onOpenPanel(fields[0])}
              disabled={phone}
              className="mt-1 inline-flex min-h-6 items-center gap-1 rounded-sm bg-muted px-2 text-meta text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground disabled:pointer-events-none"
              title="打开单子，看改了哪里"
              data-draft-patch
            >
              <CornerDownRight className="size-3" aria-hidden />
              改了单子：{fields.map((f) => FIELD_LABELS[f]).join('、')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (m.kind === 'engine_ask' || m.kind === 'review') {
    const engine = m.kind === 'engine_ask';
    return (
      <div className="flex gap-2" data-message={m.kind}>
        <BotAvatar who={engine ? 'engine' : 'commander'} />
        <div className="min-w-0 max-w-xl flex-1">
          <div className="mb-0.5 text-meta text-muted-foreground">
            {engine ? '引擎提问' : '别家挑错'} · <span className="tabular-nums">{at}</span>
            {m.githubCommentRef ? (
              <>
                {' · '}
                <a
                  href={m.githubCommentRef}
                  target="_blank"
                  rel="noreferrer"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                >
                  单子上的那条评论
                </a>
              </>
            ) : null}
          </div>
          <div
            className={cn(
              'rounded-lg border px-3 py-2 text-body',
              engine ? 'border-st-human-line bg-st-human-soft' : 'bg-muted',
            )}
          >
            <p className="whitespace-pre-wrap">{m.body}</p>
            {engine ? <EngineAsk m={m} d={d} meId={meId} /> : null}
            {m.card?.type === 'review' ? <ReviewCard card={m.card} m={m} d={d} phone={phone} /> : null}
          </div>
        </div>
      </div>
    );
  }
  const author = m.author ?? { id: '', name: '（不知道是谁）' };
  if (author.id === meId) {
    return (
      <div
        className={cn('flex justify-end', !first && '-mt-1.5')}
        title={`${author.name} ${formatDateTime(m.createdAt)}`}
        data-message="mine"
      >
        <div className="max-w-xl rounded-lg bg-selected px-3 py-2 text-body whitespace-pre-wrap">
          {withMentions(m.body)}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn('flex gap-2', !first && '-mt-1.5')}
      title={`${author.name} ${formatDateTime(m.createdAt)}`}
      data-message="other"
    >
      {first ? <PersonAvatar person={author} me={false} /> : <span className={SPACER} />}
      <div className="min-w-0 max-w-xl">
        {first ? (
          <div className="mb-0.5 text-meta text-muted-foreground">
            {author.name} · <span className="tabular-nums">{at}</span>
            {m.channel === 'mobile' ? ' · 手机' : ''}
          </div>
        ) : null}
        <div className="w-fit rounded-lg bg-muted px-3 py-2 text-body whitespace-pre-wrap">
          {withMentions(m.body)}
        </div>
      </div>
    </div>
  );
}

/** 草稿到了该交的时候：一张紧凑的卡，主按钮是「提交拍板」或「确定，开单」（看发起人要不要拍板）。 */
function ReadyCard({
  d,
  meId,
  phone,
  onOpenPanel,
}: {
  d: RequestDetail;
  meId: string | undefined;
  phone: boolean;
  onOpenPanel: () => void;
}) {
  const act = useOpenIssueAction();
  const r = d.request;
  const kind = r.needsDecision ? 'submit' : 'confirm';
  const verdict = d.actions[kind];
  const mine = r.initiator.id === meId;
  const label = r.needsDecision ? '提交拍板' : '确定，开单';
  const go = () => act.run(r.seq, kind, r.draftVersion);
  return (
    <div className="ml-8 max-w-xl rounded-lg border bg-background px-3 py-2.5" data-ready-card>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium">{r.draft.title}</span>
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">第 {r.draftVersion} 版</span>
      </div>
      <p className="mt-0.5 text-meta text-muted-foreground">
        {verdict.allowed
          ? r.needsDecision
            ? `草稿齐了：提交后等拍板人拍，拍了「做」才开单`
            : '草稿齐了：确定后结案，交给引擎开单'
          : (verdict.why ?? '还不能交')}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {mine ? (
          <Button
            variant="brand"
            className="max-md:h-11"
            disabled={!verdict.allowed}
            loading={act.isPending}
            onClick={go}
            {...(verdict.allowed ? {} : { title: verdict.why })}
          >
            {label}
          </Button>
        ) : (
          <span className="text-meta text-muted-foreground">
            由发起人 {r.initiator.name} {label}
          </span>
        )}
        <Button variant="ghost" className="max-md:h-11" onClick={onOpenPanel}>
          {phone ? '看单子' : '看全文'}
        </Button>
      </div>
    </div>
  );
}

/** 拍板卡：只有拍板人能点「同意做 / 不做 / 再聊聊」；不做要写理由。卡上带要拍的那一版的场景和怎么算做完，拍之前不用另开单子。 */
function DecideCard({
  d,
  meId,
  phone,
  onOpenPanel,
}: {
  d: RequestDetail;
  meId: string | undefined;
  phone: boolean;
  onOpenPanel: () => void;
}) {
  const act = useRequestAction();
  const open = useOpenIssueAction();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [which, setWhich] = useState<'approve' | 'reject' | 'rediscuss' | null>(null);
  const r = d.request;
  const can = d.actions.approve.allowed;
  const decider = r.decider?.id === meId ? '你' : (r.decider?.name ?? '拍板人');
  const submitted = [...d.messages].reverse().find((m) => m.kind === 'system' && m.body.includes('提交拍板'));
  const go = (body: Parameters<typeof act.mutate>[0]['body'], w: typeof which) => {
    setWhich(w);
    act.mutate(
      { seq: r.seq, body },
      {
        onSuccess: () =>
          toast.success(
            w === 'approve' ? '同意做：已结案' : w === 'reject' ? '不做：已结案、归档' : '退回讨论中',
          ),
        onError: (err) => toast.error(`没成：${errorText(err)}`),
      },
    );
  };
  return (
    <div
      className="ml-8 max-w-xl rounded-lg border border-st-human-line bg-background px-3 py-2.5"
      data-decide-card
    >
      <div className="flex items-center gap-2 text-body">
        <PersonAvatar person={r.initiator} me={r.initiator.id === meId} size="sm" />
        <span className="min-w-0 flex-1 font-medium">
          {r.initiator.name} 提交拍板 · 第 {r.draftVersion} 版
        </span>
        {submitted ? (
          <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
            {formatClock(submitted.createdAt)}
          </span>
        ) : null}
      </div>
      <DraftGist d={d} phone={phone} onOpenPanel={onOpenPanel} />
      {can ? (
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
                loading={act.isPending && which === 'reject'}
                onClick={() => go({ action: 'reject', reason: reason.trim() }, 'reject')}
              >
                确认不做
              </Button>
              <Button variant="outline" className="flex-1 max-md:h-11" onClick={() => setAsking(false)}>
                返回
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex gap-2" data-decide-buttons>
            <Button
              variant="brand"
              className="flex-1 max-md:h-11"
              loading={open.isPending}
              onClick={() => open.run(r.seq, 'approve', r.draftVersion)}
            >
              同意做
            </Button>
            <Button variant="outline" className="flex-1 max-md:h-11" onClick={() => setAsking(true)}>
              不做
            </Button>
            <Button
              variant="outline"
              className="flex-1 max-md:h-11"
              loading={act.isPending && which === 'rediscuss'}
              onClick={() => go({ action: 'rediscuss' }, 'rediscuss')}
            >
              再聊聊
            </Button>
          </div>
        )
      ) : (
        <div
          className="mt-1 flex items-center gap-1.5 text-meta text-muted-foreground"
          title={d.actions.approve.why}
          data-decide-wait
        >
          <StatusDot tone="human" />等 {decider} 拍板
          {d.actions.approve.why ? <span className="sr-only">：{d.actions.approve.why}</span> : null}
        </div>
      )}
    </div>
  );
}

/** 要拍的那一版的要点：标题、场景（两行）、怎么算做完（前三条），再给「看全文」。 */
function DraftGist({ d, phone, onOpenPanel }: { d: RequestDetail; phone: boolean; onOpenPanel: () => void }) {
  const draft = d.request.draft;
  const done = draft.done ?? [];
  return (
    <div className="mt-2 space-y-1.5 border-l-2 border-border pl-2.5 text-meta" data-decide-gist>
      <p className="font-medium text-body">{draft.title}</p>
      {draft.scene ? (
        <p className="line-clamp-2 text-muted-foreground">
          <span className="text-foreground">场景：</span>
          {draft.scene}
        </p>
      ) : null}
      {done.length > 0 ? (
        <div className="text-muted-foreground">
          <span className="text-foreground">怎么算做完：</span>
          <ul className="mt-0.5 space-y-0.5">
            {done.slice(0, 3).map((x) => (
              <li key={x} className="flex gap-1.5">
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate">{x}</span>
              </li>
            ))}
          </ul>
          {done.length > 3 ? <p className="mt-0.5">还有 {done.length - 3} 条，在全文里</p> : null}
        </div>
      ) : null}
      <Button variant="ghost" size="sm" className="-ml-2 max-md:h-11" onClick={onOpenPanel}>
        {phone ? '看单子' : '看全文'}
      </Button>
    </div>
  );
}

function closedLine(d: RequestDetail): string {
  const r = d.request;
  const at = r.closedAt ? formatDateTime(r.closedAt) : '';
  if (r.status === 'idle_closed') {
    return `收口${at ? ` · ${at}` : ''}${r.closeReason ? ` · ${r.closeReason}` : ''}`;
  }
  if (r.status === 'closed_drop') return `已结案 · ${at} · 不做${r.closeReason ? `：${r.closeReason}` : ''}`;
  const refs = r.issueRefs.map((i) => `#${i.number}`).join('、');
  return `已结案 · ${at} · ${r.decider ? `${r.decider.name} ` : ''}同意做${refs ? ` · 开成 ${refs}` : ''}`;
}

export function MessageStream({
  d,
  meId,
  phone,
  onOpenPanel,
  onPick,
}: {
  d: RequestDetail;
  meId: string | undefined;
  phone: boolean;
  onOpenPanel: (field?: RequestDraftField) => void;
  /** 点了指挥官一问的某个选项：当成一句话发出去。 */
  onPick: (text: string) => Promise<boolean>;
}) {
  // 只有最新那一问、它后面还没人说话、这条还能发消息时，选项能点
  const lastQuestion = [...d.messages].reverse().find((m) => m.card?.type === 'question');
  const answered =
    lastQuestion !== undefined && d.messages.some((m) => m.id > lastQuestion.id && m.kind === 'human');
  const liveQuestionId =
    lastQuestion && !answered && d.actions.send.allowed && !d.commander.running ? lastQuestion.id : null;
  const lastProposal = [...d.messages].reverse().find((m) => m.card?.type === 'proposal');
  const liveProposalId = lastProposal && d.actions.send.allowed ? lastProposal.id : null;
  const endRef = useRef<HTMLDivElement>(null);
  const r = d.request;
  // 「以下是新消息」：按第一次打开这一条时读到的位置画，后面记了已读也不跳。
  // 只画在别人（人、指挥官、引擎）说的话上面：系统的一行小字（暂停原因、提交拍板）不值得一条分隔线，刚提的一条也不会被它切开
  const [readAt] = useState(() => ({ seq: r.seq, id: d.lastReadMessageId }));
  const boundary = readAt.seq === r.seq ? readAt.id : d.lastReadMessageId;
  const firstUnread =
    boundary === null
      ? undefined
      : d.messages.find((m) => m.id > boundary && m.kind !== 'system' && m.author?.id !== meId)?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息多了、状态变了就滚到底
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [d.messages.length, r.status, r.seq]);
  const closed = r.status === 'closed_do' || r.status === 'closed_drop' || r.status === 'idle_closed';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-intake-stream>
      <div className="mx-auto flex max-w-chat flex-col gap-3 px-4 py-4">
        {r.continuesSeq !== undefined ? (
          <div className="text-center text-meta text-muted-foreground" data-continues>
            接着 需求 {r.continuesSeq} 提的
          </div>
        ) : null}
        {d.messages.map((m, i) => (
          <Fragment key={m.id}>
            {m.id === firstUnread ? (
              <div className="flex items-center gap-3 text-meta text-ink-human" data-unread-divider>
                <span className="h-px flex-1 bg-st-human-line" />
                以下是新消息
                <span className="h-px flex-1 bg-st-human-line" />
              </div>
            ) : null}
            <Message
              m={m}
              prev={d.messages[i - 1]}
              d={d}
              meId={meId}
              phone={phone}
              liveQuestion={m.id === liveQuestionId}
              liveProposal={m.id === liveProposalId}
              onOpenPanel={onOpenPanel}
              onPick={onPick}
            />
          </Fragment>
        ))}
        <CommanderLive d={d} />
        {r.deletedAt ? null : r.status === 'pending_decision' ? (
          <DecideCard d={d} meId={meId} phone={phone} onOpenPanel={() => onOpenPanel()} />
        ) : r.status === 'discussing' ? (
          <ReadyCard d={d} meId={meId} phone={phone} onOpenPanel={() => onOpenPanel()} />
        ) : null}
        {closed ? (
          <div
            className="flex items-center gap-3 text-meta text-muted-foreground"
            data-closed-line
            {...(r.status === 'idle_closed' ? { 'data-close-reason': r.closeReason ?? '' } : {})}
          >
            <span className="h-px flex-1 bg-border" />
            <span className="min-w-0 text-center">{closedLine(d)}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        {r.continuedBy.length > 0 ? (
          <div className="text-center text-meta text-muted-foreground" data-continued-by>
            接着这条提了：{r.continuedBy.map((s) => `需求 ${s}`).join('、')}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
