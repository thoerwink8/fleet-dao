// 对话里的消息流（#2062，方案第四节）：电脑中栏和手机全屏聊天共用。
// 我说的在右边带蓝底；别人和指挥官在左边灰底，连续几条只在第一条上面写名字；系统的话居中一行小字。
// 拍板卡（待拍板时在最后）：只有拍板人能点「同意做 / 不做 / 再聊聊」，别人看到「等谁拍」。草稿齐了的一张紧凑卡带「提交拍板 / 确定，开单」。
// 结案后最后一行是结案分隔线。B、C 片的消息（指挥官一问的选项、建议改、进度卡、引擎提问的回答、别家意见、换模型分隔线、
// 暂停原因、方案卡、指挥官正在回话）画法在 request-cards.tsx。
import { isIdleCloseReason, pausedWhy } from '@fleet-dao/shared';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRequestAction } from '../../api/client';
import type { RequestDetail, RequestDraftField, RequestMessage } from '../../api/types';
import { formatClock, formatDateTime } from '../../lib/format';
import { Button } from '../layout/button';
import { Chat, Message as ChatMessage } from '../layout/chat';
import { Textarea } from '../layout/input';
import { Inset, RuleLabel } from '../layout/inset';
import { TextLink } from '../layout/link';
import { Stack } from '../layout/stack';
import { LevelDot } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { MarkdownLite } from '../markdown-lite';
import { useOpenIssueAction } from './open-issue';
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
      <Text key={i} strong>
        {part}
      </Text>
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
      <TextLink key={at} href={m[2] as string}>
        #{m[3]}
      </TextLink>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

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
      return <RuleLabel data-message="model-switch">{m.body}</RuleLabel>;
    }
    if (m.card?.type === 'paused') {
      return (
        <Stack align="center" data-message="paused">
          <Tag tone="warning">{pausedWhy(m.card.why)}</Tag>
        </Stack>
      );
    }
    const progress = progressCard(m, d);
    if (progress) return progress;
    return (
      <div data-message="system" title={formatDateTime(m.createdAt)}>
        <Stack align="center">
          <Text size="meta" tone="muted">
            {withIssueLinks(m.body)}
          </Text>
        </Stack>
      </div>
    );
  }
  if (m.kind === 'commander') {
    const fields = patchedFields(m);
    return (
      // biome-ignore lint/a11y/useValidAriaRole: role 是消息的角色（me、other、tool），不是 ARIA role。
      <ChatMessage role="other" data-message="commander" {...(first ? { meta: `指挥官 · ${at}` } : {})}>
        <Stack gap="sm">
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
            <Stack align="start">
              {phone ? (
                <div data-draft-patch="">
                  <Text size="meta" tone="muted">
                    改了单子：{fields.map((f) => FIELD_LABELS[f]).join('、')}
                  </Text>
                </div>
              ) : (
                <Button
                  size="xs"
                  variant="text"
                  title="打开单子，看改了哪里"
                  onClick={() => onOpenPanel(fields[0])}
                  data-draft-patch=""
                >
                  改了单子：{fields.map((f) => FIELD_LABELS[f]).join('、')}
                </Button>
              )}
            </Stack>
          ) : null}
        </Stack>
      </ChatMessage>
    );
  }
  if (m.kind === 'engine_ask' || m.kind === 'review') {
    const engine = m.kind === 'engine_ask';
    return (
      // biome-ignore lint/a11y/useValidAriaRole: role 是消息的角色（me、other、tool），不是 ARIA role。
      <ChatMessage
        role="other"
        data-message={m.kind}
        meta={
          <>
            {engine ? '引擎提问' : '别家挑错'} · {at}
            {m.githubCommentRef ? (
              <>
                {' · '}
                <TextLink href={m.githubCommentRef}>单子上的那条评论</TextLink>
              </>
            ) : null}
          </>
        }
      >
        <Stack gap="sm">
          <Text pre>{m.body}</Text>
          {engine ? <EngineAsk m={m} d={d} meId={meId} /> : null}
          {m.card?.type === 'review' ? <ReviewCard card={m.card} m={m} d={d} phone={phone} /> : null}
        </Stack>
      </ChatMessage>
    );
  }
  const author = m.author ?? { id: '', name: '（不知道是谁）' };
  if (author.id === meId) {
    return (
      // biome-ignore lint/a11y/useValidAriaRole: role 是消息的角色（me、other、tool），不是 ARIA role。
      <ChatMessage role="me" data-message="mine" meta={at}>
        <Text pre>{withMentions(m.body)}</Text>
      </ChatMessage>
    );
  }
  return (
    // biome-ignore lint/a11y/useValidAriaRole: role 是消息的角色（me、other、tool），不是 ARIA role。
    <ChatMessage
      role="other"
      data-message="other"
      {...(first ? { meta: `${author.name} · ${at}${m.channel === 'mobile' ? ' · 手机' : ''}` } : {})}
    >
      <Text pre>{withMentions(m.body)}</Text>
    </ChatMessage>
  );
}

/** 草稿到了该交的时候：一张紧凑的卡，按钮是「提交拍板」或「确定，开单」（看发起人要不要拍板）。 */
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
    <Inset data-ready-card="">
      <Stack direction="horizontal" gap="md" justify="between" align="baseline">
        <Text strong truncate>
          {r.draft.title}
        </Text>
        <Text size="meta" tone="muted">
          第 {r.draftVersion} 版
        </Text>
      </Stack>
      <Text size="meta" tone="muted">
        {verdict.allowed
          ? r.needsDecision
            ? `草稿齐了：提交后等拍板人拍，拍了「做」才开单`
            : '草稿齐了：确定后结案，交给引擎开单'
          : (verdict.why ?? '还不能交')}
      </Text>
      <Stack direction="horizontal" gap="sm" align="center" wrap>
        {mine ? (
          <Button
            variant="outline"
            size="sm"
            loading={act.isPending}
            {...(verdict.allowed ? {} : { disabledReason: verdict.why ?? '还不能交' })}
            onClick={go}
          >
            {label}
          </Button>
        ) : (
          <Text size="meta" tone="muted">
            由发起人 {r.initiator.name} {label}
          </Text>
        )}
        <Button variant="text" size="sm" onClick={onOpenPanel}>
          {phone ? '看单子' : '看全文'}
        </Button>
      </Stack>
    </Inset>
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
    <Inset data-decide-card="">
      <Stack direction="horizontal" gap="sm" justify="between" align="baseline">
        <Text strong>
          {r.initiator.name} 提交拍板 · 第 {r.draftVersion} 版
        </Text>
        {submitted ? (
          <Text size="meta" tone="muted">
            {formatClock(submitted.createdAt)}
          </Text>
        ) : null}
      </Stack>
      <DraftGist d={d} phone={phone} onOpenPanel={onOpenPanel} />
      {can ? (
        asking ? (
          <Stack gap="sm">
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="不做的理由（会留在这条需求里）……"
              aria-label="不做的理由"
            />
            <Stack direction="horizontal" gap="sm">
              <Button
                variant="danger"
                size="sm"
                loading={act.isPending && which === 'reject'}
                {...(reason.trim() ? {} : { disabledReason: '先写不做的理由' })}
                onClick={() => go({ action: 'reject', reason: reason.trim() }, 'reject')}
              >
                确认不做
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setAsking(false)}>
                返回
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack direction="horizontal" gap="sm" wrap data-decide-buttons="">
            <Button
              variant="outline"
              size="sm"
              loading={open.isPending}
              onClick={() => open.run(r.seq, 'approve', r.draftVersion)}
            >
              同意做
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
              不做
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={act.isPending && which === 'rediscuss'}
              onClick={() => go({ action: 'rediscuss' }, 'rediscuss')}
            >
              再聊聊
            </Button>
          </Stack>
        )
      ) : (
        <div data-decide-wait="" {...(d.actions.approve.why ? { title: d.actions.approve.why } : {})}>
          <Stack direction="horizontal" gap="sm" align="center">
            <LevelDot level="default" />
            <Text size="meta" tone="muted">
              等 {decider} 拍板
            </Text>
          </Stack>
        </div>
      )}
    </Inset>
  );
}

/** 要拍的那一版的要点：标题、场景、怎么算做完（前三条），再给「看全文」。 */
function DraftGist({ d, phone, onOpenPanel }: { d: RequestDetail; phone: boolean; onOpenPanel: () => void }) {
  const draft = d.request.draft;
  const done = draft.done ?? [];
  return (
    <div data-decide-gist="">
      <Stack gap="sm" align="start">
        <Text strong>{draft.title}</Text>
        {draft.scene ? (
          <Text size="meta" tone="secondary">
            场景：{draft.scene}
          </Text>
        ) : null}
        {done.length > 0 ? (
          <Stack gap="sm">
            <Text size="meta" tone="secondary">
              怎么算做完：
            </Text>
            {done.slice(0, 3).map((x) => (
              <Text key={x} size="meta" tone="secondary" truncate>
                · {x}
              </Text>
            ))}
            {done.length > 3 ? (
              <Text size="meta" tone="muted">
                还有 {done.length - 3} 条，在全文里
              </Text>
            ) : null}
          </Stack>
        ) : null}
        <Button variant="text" size="sm" onClick={onOpenPanel}>
          {phone ? '看单子' : '看全文'}
        </Button>
      </Stack>
    </div>
  );
}

function closedLine(d: RequestDetail): string {
  const r = d.request;
  const at = r.closedAt ? formatDateTime(r.closedAt) : '';
  if (r.status === 'closed_drop' && isIdleCloseReason(r.closeReason)) {
    return `收口${at ? ` · ${at}` : ''} · ${r.closeReason}`;
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
  const closed = r.status === 'closed_do' || r.status === 'closed_drop';
  return (
    <div data-intake-stream="">
      <Chat>
        {r.continuesSeq !== undefined ? (
          <div data-continues="">
            <Stack align="center">
              <Text size="meta" tone="muted">
                接着 需求 {r.continuesSeq} 提的
              </Text>
            </Stack>
          </div>
        ) : null}
        {d.messages.map((m, i) => (
          <Fragment key={m.id}>
            {m.id === firstUnread ? (
              <RuleLabel accent data-unread-divider="">
                以下是新消息
              </RuleLabel>
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
          <RuleLabel
            data-closed-line=""
            {...(isIdleCloseReason(r.closeReason) ? { 'data-close-reason': r.closeReason } : {})}
          >
            {closedLine(d)}
          </RuleLabel>
        ) : null}
        {r.continuedBy.length > 0 ? (
          <div data-continued-by="">
            <Stack align="center">
              <Text size="meta" tone="muted">
                接着这条提了：{r.continuedBy.map((s) => `需求 ${s}`).join('、')}
              </Text>
            </Stack>
          </div>
        ) : null}
        <div ref={endRef} />
      </Chat>
    </div>
  );
}
