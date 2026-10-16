// 对话里 B、C 片的几种消息（#2062 第二部分，方案第四节「对话流里的消息」）：
// - 指挥官一问：2～4 个选项按钮 + 「我自己说」（只有最新的那一问、还能发消息时能点）；
// - 方案卡：完整草稿摘要，「确认开单」走现有确定开单，「改」打开对应草稿栏的输入框；
// - 建议改：指挥官想改人改过的栏，服务端没改，出一张卡，人点「采用」才改（电脑上）；
// - 进度卡：开出的单到哪了（「#12 动手中 · 已合并 1/3 个子任务」），点了去 GitHub；
// - 引擎提问：带「回答」，答复写回那条 GitHub 评论；写回失败照实写原因、给重试；
// - 别家意见：每条能标采用或不用（电脑上）；
// - 指挥官正在回话：流式显示写到哪了、「正在读代码……」，能停下。
import { REQUEST_CHAT_PHASE_WORDS, REQUEST_DRAFT_FIELD_WORDS, REQUEST_DRAFT_FIELDS } from '@fleet-dao/shared';
import { ChevronDown, CircleStop, ExternalLink, MessageSquareReply, RotateCcw, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import {
  errorText,
  useAnswerEngineAsk,
  useCommanderStream,
  useMarkReviewItem,
  useNudgeCommander,
  useSetCommanderModel,
  useStopCommander,
  useUpdateRequestDraft,
} from '../../api/client';
import type { RequestCard, RequestDetail, RequestDraftField, RequestMessage } from '../../api/types';
import { cn } from '../../lib/utils';
import { StatusDot } from '../layout/status-badge';
import type { LayoutTone } from '../layout/tone';
import { MarkdownLite } from '../markdown-lite';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Textarea } from '../ui/textarea';
import { useOpenIssueAction } from './open-issue';
import { BotAvatar } from './people';
import { issueStateWord } from './request-view';

type Question = Extract<RequestCard, { type: 'question' }>;
type Proposal = Extract<RequestCard, { type: 'proposal' }>;
type Suggest = Extract<RequestCard, { type: 'suggest' }>;
type Review = Extract<RequestCard, { type: 'review' }>;

/** 指挥官一问：选项按钮；点一个就把它当成这句话发出去。 */
export function QuestionCard({
  card,
  live,
  onPick,
}: {
  card: Question;
  /** 最新那一问、还能发消息：选项能点。 */
  live: boolean;
  onPick: (text: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const pick = async (o: string) => {
    setBusy(o);
    await onPick(o);
    setBusy(null);
  };
  return (
    <div className="mt-1.5" data-question-card>
      <p className="text-body font-medium">{card.question}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {card.options.map((o) =>
          live ? (
            <Button
              key={o}
              size="sm"
              variant="outline"
              className="max-md:h-11"
              loading={busy === o}
              disabled={busy !== null && busy !== o}
              onClick={() => void pick(o)}
              data-option
            >
              {o}
            </Button>
          ) : (
            <span key={o} className="rounded-md border px-2 py-0.5 text-meta text-muted-foreground">
              {o}
            </span>
          ),
        )}
        {live ? (
          <Button
            size="sm"
            variant="ghost"
            className="max-md:h-11"
            onClick={() => document.getElementById('intake-input')?.focus()}
            data-option-own
          >
            我自己说
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function draftValue(d: RequestDetail, field: RequestDraftField): string {
  const v = d.request.draft[field];
  if (Array.isArray(v)) return v.length > 0 ? v.join('\n') : '';
  return typeof v === 'string' ? v : '';
}

/** 方案卡：完整草稿摘要。「确认开单」走现有 confirm（开单幂等键仍是需求号 + 草稿版本号）。「改」打开那一栏的输入框。 */
export function ProposalCard({
  card,
  d,
  live,
  onEdit,
}: {
  card: Proposal;
  d: RequestDetail;
  /** 最新那一张、这条还能发消息：按钮能点。 */
  live: boolean;
  onEdit: (field: RequestDraftField) => void;
}) {
  const act = useOpenIssueAction();
  const r = d.request;
  const verdict = d.actions.confirm;
  const stale = card.draftVersion !== r.draftVersion;
  const go = () => act.run(r.seq, 'confirm', r.draftVersion);
  return (
    <div className="mt-1.5 rounded-lg border px-3 py-2" data-proposal-card={card.draftVersion}>
      <div className="text-meta text-muted-foreground">
        方案 · 草稿第 {card.draftVersion} 版
        {stale ? `（现在是第 ${r.draftVersion} 版，确认开的是这一版）` : ''}
      </div>
      <p className="mt-1 text-body whitespace-pre-wrap">{card.summary}</p>
      <ul className="mt-2 space-y-1">
        {REQUEST_DRAFT_FIELDS.map((f) => {
          const value = draftValue(d, f);
          return (
            <li key={f} className="flex items-start gap-2 text-body" data-proposal-field={f}>
              <span className="shrink-0 text-meta text-muted-foreground">{REQUEST_DRAFT_FIELD_WORDS[f]}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground">
                {value || '（还没写）'}
              </span>
              {live ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0 max-md:h-11"
                  onClick={() => onEdit(f)}
                  aria-label={`改${REQUEST_DRAFT_FIELD_WORDS[f]}`}
                  data-proposal-edit={f}
                >
                  改
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {live ? (
        <div className="mt-2">
          <Button
            size="sm"
            variant="brand"
            className="max-md:h-11"
            disabled={!verdict.allowed}
            loading={act.isPending}
            title={verdict.allowed ? `确定开单，开的是第 ${r.draftVersion} 版` : verdict.why}
            onClick={go}
            data-proposal-confirm
          >
            确认开单
          </Button>
          {!verdict.allowed && verdict.why ? (
            <p className="mt-1 text-meta text-ink-stall">{verdict.why}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function valueText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => `· ${String(x)}`).join('\n');
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 建议改：人改过的栏，指挥官只能建议；电脑上能「采用」（带看到的版本，别人先改了 409 写原因）。 */
export function SuggestCard({
  card,
  d,
  label,
  phone,
}: {
  card: Suggest;
  d: RequestDetail;
  label: string;
  phone: boolean;
}) {
  const update = useUpdateRequestDraft();
  const r = d.request;
  const can = !phone && d.actions.editDraft.allowed;
  const current = r.draft[card.field];
  const same = JSON.stringify(current) === JSON.stringify(card.value);
  const adopt = () =>
    update.mutate(
      { seq: r.seq, body: { baseVersion: r.draftVersion, patch: { [card.field]: card.value } } },
      {
        onSuccess: () => toast.success(`「${label}」改成指挥官建议的了`),
        onError: (err) => toast.error(`没改成：${errorText(err)}`),
      },
    );
  return (
    <div className="mt-1.5 rounded-lg border border-dashed px-3 py-2" data-suggest-card>
      <div className="text-meta text-muted-foreground">
        建议改「{label}」<span className="ml-1">（这一栏人改过，指挥官不直接动）</span>
      </div>
      <p className="mt-0.5 text-body whitespace-pre-wrap">{valueText(card.value)}</p>
      {same ? (
        <p className="mt-1 text-meta text-ink-done">已经是这样了</p>
      ) : can ? (
        <Button size="sm" variant="outline" className="mt-1.5" loading={update.isPending} onClick={adopt}>
          采用
        </Button>
      ) : null}
    </div>
  );
}

const ISSUE_TONE = {
  open: 'run',
  merged: 'done',
  deployed: 'done',
  closed: 'stop',
} as const satisfies Record<string, LayoutTone>;

/** 进度卡（不是组件，没有钩子，直接调）：系统消息「#12 动手中 · ……」，配上单子在 GitHub 的链接和状态点。认不出是哪张单就返回 null（照普通系统消息画）。 */
export function progressCard(m: RequestMessage, d: RequestDetail): ReactNode {
  const hit = /^#(\d{1,9}) ([\s\S]+)$/.exec(m.body);
  const ref = hit ? d.request.issueRefs.find((i) => i.number === Number(hit[1])) : undefined;
  if (!hit || !ref) return null;
  const url = `https://github.com/${ref.repo}/issues/${ref.number}`;
  return (
    <div className="flex justify-center" data-message="progress">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-meta text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground"
        title={`在 GitHub 上看 ${ref.repo}#${ref.number}（现在${issueStateWord(ref.state)}）`}
      >
        <StatusDot tone={ISSUE_TONE[ref.state]} />
        <span className="font-mono">#{ref.number}</span>
        <span className="min-w-0 truncate">{hit[2]}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden />
      </a>
    </div>
  );
}

const ANSWER_WORDS = { pending: '待答', written: '已写回单子', failed: '写回失败' } as const;

/** 引擎提问：发起人、拍板人能回答；答复写回那条 GitHub 评论。写回失败写原因，点「重试」再写一次（不用重打）。 */
export function EngineAsk({ m, d, meId }: { m: RequestMessage; d: RequestDetail; meId: string | undefined }) {
  const answer = useAnswerEngineAsk();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const r = d.request;
  const mayAnswer = meId !== undefined && (r.initiator.id === meId || r.decider?.id === meId);
  const state = m.answerState ?? 'pending';
  const send = (t: string) =>
    answer.mutate(
      { seq: r.seq, messageId: m.id, text: t },
      {
        onSuccess: () => {
          setOpen(false);
          setText('');
          toast.success('答复写回单子了');
        },
        onError: (err) => toast.error(`没写回去：${errorText(err)}`),
      },
    );
  return (
    <div className="mt-1.5 space-y-1.5" data-engine-ask={state}>
      {m.answer ? (
        <div className="rounded-md bg-background px-3 py-2 text-body">
          <div className="mb-0.5 text-meta text-muted-foreground">
            {m.answer.by ? `${m.answer.by.name} 答` : '答复'} ·{' '}
            <span
              className={cn(state === 'failed' ? 'text-ink-fail' : state === 'written' && 'text-ink-done')}
            >
              {ANSWER_WORDS[state]}
            </span>
          </div>
          <p className="whitespace-pre-wrap">{m.answer.text}</p>
          {state === 'failed' ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 text-meta text-ink-fail" role="alert">
                {m.answer.error ?? '后端没写原因'}
              </span>
              {mayAnswer ? (
                <Button
                  size="sm"
                  variant="outline"
                  loading={answer.isPending}
                  onClick={() => send(m.answer?.text ?? '')}
                >
                  <RotateCcw />
                  重试
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : open ? (
        <div className="space-y-1.5">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="写给引擎的答复，会写回单子上那条评论下面……"
            aria-label="回答引擎的提问"
            className="min-h-0 bg-background"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="brand"
              disabled={!text.trim()}
              loading={answer.isPending}
              onClick={() => send(text.trim())}
            >
              写回单子
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : mayAnswer ? (
        <Button size="sm" variant="outline" className="max-md:h-11" onClick={() => setOpen(true)} data-answer>
          <MessageSquareReply />
          回答
        </Button>
      ) : (
        <p className="text-meta text-muted-foreground">等发起人回答</p>
      )}
    </div>
  );
}

/** 别家意见：一条一行，电脑上能标采用或不用；标过的写在行尾。 */
export function ReviewCard({
  card,
  m,
  d,
  phone,
}: {
  card: Review;
  m: RequestMessage;
  d: RequestDetail;
  phone: boolean;
}) {
  const mark = useMarkReviewItem();
  const r = d.request;
  const closed = r.status === 'closed_do' || r.status === 'closed_drop';
  const can = !phone && !closed;
  const busy = (index: number, verdict: 'adopt' | 'reject') =>
    mark.isPending && mark.variables?.index === index && mark.variables.verdict === verdict;
  const go = (index: number, verdict: 'adopt' | 'reject') =>
    mark.mutate(
      { seq: r.seq, messageId: m.id, index, verdict },
      { onError: (err) => toast.error(`没标上：${errorText(err)}`) },
    );
  return (
    <ol className="mt-1.5 space-y-1" data-review-card>
      {card.items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 意见按条号存，标的时候也按条号
        <li key={i} className="flex items-start gap-2 text-body" data-review-item={it.verdict ?? 'none'}>
          <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{i + 1}.</span>
          <span
            className={cn('min-w-0 flex-1', it.verdict === 'reject' && 'text-muted-foreground line-through')}
          >
            {it.text}
          </span>
          {can ? (
            <span className="flex shrink-0 gap-1">
              <Button
                size="xs"
                variant={it.verdict === 'adopt' ? 'brand' : 'outline'}
                aria-pressed={it.verdict === 'adopt'}
                disabled={mark.isPending}
                loading={busy(i, 'adopt')}
                onClick={() => go(i, 'adopt')}
              >
                采用
              </Button>
              <Button
                size="xs"
                variant={it.verdict === 'reject' ? 'secondary' : 'ghost'}
                aria-pressed={it.verdict === 'reject'}
                disabled={mark.isPending}
                loading={busy(i, 'reject')}
                onClick={() => go(i, 'reject')}
              >
                不用
              </Button>
            </span>
          ) : it.verdict ? (
            <span className="shrink-0 text-meta text-muted-foreground">
              {it.verdict === 'adopt' ? '采用' : '不用'}
            </span>
          ) : null}
        </li>
      ))}
      <li className="text-meta text-muted-foreground">
        {card.model} 挑的是第 {card.draftVersion} 版
        {card.draftVersion !== r.draftVersion ? `（现在是第 ${r.draftVersion} 版）` : ''}
      </li>
    </ol>
  );
}

/**
 * 输入框左下角的模型芯片（电脑上）：默认用「提需求」用途排第一的模型，可以只给这一条换；换了对话里出一条分隔线。
 * 能换的只有用途里配了的（Fable 只有创始人配进去才出现）。用途没配、没读成写原因，不画空菜单。
 */
export function ModelChip({ d }: { d: RequestDetail }) {
  const set = useSetCommanderModel();
  const c = d.commander;
  const r = d.request;
  const closed = r.status === 'closed_do' || r.status === 'closed_drop';
  const current = c.model ?? c.defaultModel;
  const locked = closed || c.running || Boolean(r.deletedAt);
  const why = closed ? '已结案，不能换模型' : c.running ? '指挥官正在回话，回完再换' : '换这一条的指挥官模型';
  const pick = (id: string) => {
    const next = id === DEFAULT_KEY ? null : id;
    if (next === (c.model?.id ?? null)) return;
    set.mutate({ seq: r.seq, modelId: next }, { onError: (err) => toast.error(`没换成：${errorText(err)}`) });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={locked}
          title={why}
          className="inline-flex h-6 max-w-48 items-center gap-1 rounded-md px-2 text-meta text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
          data-model-chip
        >
          <span className="truncate">{current?.name ?? '没配模型'}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {c.modelsUnavailable || c.models.length === 0 ? (
          <DropdownMenuLabel className="font-normal text-ink-stall">
            {c.modelsUnavailable ?? '「提需求」用途里一个模型都没配：到「路由」页给它配一个'}
          </DropdownMenuLabel>
        ) : (
          <DropdownMenuRadioGroup value={c.model?.id ?? DEFAULT_KEY} onValueChange={pick}>
            <DropdownMenuRadioItem value={DEFAULT_KEY}>
              用默认{c.defaultModel ? `（${c.defaultModel.name}）` : ''}
            </DropdownMenuRadioItem>
            {c.models.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                {m.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DEFAULT_KEY = '__default__';

/** 「让指挥官接着问」：两个人都说过话以后指挥官不 @ 不说话，点这个让它接着问。超了限额、引擎关着时写原因。 */
export function NudgeButton({ d, phone }: { d: RequestDetail; phone: boolean }) {
  const nudge = useNudgeCommander();
  const c = d.commander;
  if (d.request.participants.length === 0) return null;
  const full = c.turns >= c.maxTurns;
  return (
    <Button
      size="xs"
      variant="ghost"
      className={cn(phone && 'h-11')}
      disabled={c.running || full}
      loading={nudge.isPending}
      title={full ? `这条已经聊满 ${c.maxTurns} 轮` : '两个人都说过话以后，指挥官只在被 @ 或点这里时说话'}
      onClick={() =>
        nudge.mutate(d.request.seq, { onError: (err) => toast.error(`没叫动：${errorText(err)}`) })
      }
      data-nudge
    >
      <Sparkles />
      让指挥官接着问
    </Button>
  );
}

/** 指挥官正在回话：流式写到哪了、「正在读代码……」；能停下。流断了照实写，详情会自己重拉。 */
export function CommanderLive({ d }: { d: RequestDetail }) {
  const r = d.request;
  const c = d.commander;
  const { live, broken } = useCommanderStream(r.seq, c.running);
  const stop = useStopCommander();
  if (!c.running) {
    return broken ? (
      <p className="text-center text-meta text-ink-stall" data-commander-broken>
        指挥官回话的流断了：{broken}（刷新后能看到回完的话）
      </p>
    ) : null;
  }
  const review = (live?.job ?? c.job) === 'review';
  const phase = live?.phase ?? c.phase;
  const words =
    live?.phaseText ??
    (phase
      ? REQUEST_CHAT_PHASE_WORDS[phase]
      : c.state === 'queued'
        ? '排着队，等引擎接手……'
        : '指挥官在想……');
  return (
    <div className="flex gap-2" data-commander-live={phase ?? c.state}>
      <BotAvatar who="commander" />
      <div className="min-w-0 max-w-2xl flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-meta text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone="run" className="animate-pulse" />
            {review ? '别家在挑错……' : words}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            loading={stop.isPending}
            onClick={() => stop.mutate(r.seq, { onError: (err) => toast.error(`没停下：${errorText(err)}`) })}
            data-commander-stop
          >
            <CircleStop />
            停下
          </Button>
        </div>
        {live?.text ? <MarkdownLite source={live.text} /> : null}
      </div>
    </div>
  );
}
