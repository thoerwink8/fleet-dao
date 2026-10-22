// 对话里 B、C 片的几种消息（#2062 第二部分，方案第四节「对话流里的消息」）：
// - 指挥官一问：2～4 个选项按钮 + 「我自己说」（只有最新的那一问、还能发消息时能点）；
// - 方案卡：完整草稿摘要，「确认开单」走现有确定开单，「改」打开对应草稿栏的输入框；
// - 建议改：指挥官想改人改过的栏，服务端没改，出一张卡，人点「采用」才改（电脑上）；
// - 进度卡：开出的单到哪了（「#12 动手中 · 已合并 1/3 个子任务」），点了去 GitHub；
// - 引擎提问：带「回答」，答复写回那条 GitHub 评论；写回失败照实写原因、给重试；
// - 别家意见：每条能标采用或不用（电脑上）；
// - 指挥官正在回话：流式显示写到哪了、「正在读代码……」，能停下。
import { REQUEST_CHAT_PHASE_WORDS, REQUEST_DRAFT_FIELD_WORDS, REQUEST_DRAFT_FIELDS } from '@fleet-dao/shared';
import { Sparkles } from 'lucide-react';
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
import { statusEntry } from '../../theme/status-dict';
import { Button } from '../layout/button';
import { Textarea } from '../layout/input';
import { Inset } from '../layout/inset';
import { TextLink } from '../layout/link';
import { MenuButton } from '../layout/menu-button';
import { RowMenuLabel, RowMenuRadioGroup, RowMenuRadioItem } from '../layout/row-menu';
import { Stack } from '../layout/stack';
import { LevelDot } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { MarkdownLite } from '../markdown-lite';
import { useOpenIssueAction } from './open-issue';
import { issueStateWord, issueStatus } from './request-view';

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
    <div data-question-card="">
      <Stack gap="sm">
        <Text strong>{card.question}</Text>
        <Stack direction="horizontal" gap="sm" wrap>
          {card.options.map((o) =>
            live ? (
              <Button
                key={o}
                size="sm"
                variant="outline"
                loading={busy === o}
                {...(busy !== null && busy !== o ? { disabledReason: '正在发另一个选项' } : {})}
                onClick={() => void pick(o)}
                data-option=""
              >
                {o}
              </Button>
            ) : (
              <Tag key={o}>{o}</Tag>
            ),
          )}
          {live ? (
            <Button
              size="sm"
              variant="text"
              onClick={() => document.getElementById('intake-input')?.focus()}
              data-option-own=""
            >
              我自己说
            </Button>
          ) : null}
        </Stack>
      </Stack>
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
    <Inset data-proposal-card={String(card.draftVersion)}>
      <Text size="meta" tone="muted">
        方案 · 草稿第 {card.draftVersion} 版
        {stale ? `（现在是第 ${r.draftVersion} 版，确认开的是这一版）` : ''}
      </Text>
      <Text pre>{card.summary}</Text>
      <Stack gap="sm">
        {REQUEST_DRAFT_FIELDS.map((f) => {
          const value = draftValue(d, f);
          return (
            <Stack key={f} direction="horizontal" gap="sm" align="start" data-proposal-field={f}>
              <Text size="meta" tone="muted">
                {REQUEST_DRAFT_FIELD_WORDS[f]}
              </Text>
              <Text tone="secondary" pre>
                {value || '（还没写）'}
              </Text>
              {live ? (
                <Button
                  size="xs"
                  variant="text"
                  onClick={() => onEdit(f)}
                  aria-label={`改${REQUEST_DRAFT_FIELD_WORDS[f]}`}
                  data-proposal-edit={f}
                >
                  改
                </Button>
              ) : null}
            </Stack>
          );
        })}
      </Stack>
      {live ? (
        <Stack gap="sm" align="start">
          <Button
            size="sm"
            variant="outline"
            loading={act.isPending}
            {...(verdict.allowed
              ? { title: `确定开单，开的是第 ${r.draftVersion} 版` }
              : { disabledReason: verdict.why ?? '现在还不能确定开单' })}
            onClick={go}
            data-proposal-confirm=""
          >
            确认开单
          </Button>
          {!verdict.allowed && verdict.why ? (
            <Text size="meta" tone="warning">
              {verdict.why}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Inset>
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
    <Inset look="dashed" data-suggest-card="">
      <Text size="meta" tone="muted">
        建议改「{label}」（这一栏人改过，指挥官不直接动）
      </Text>
      <Text pre>{valueText(card.value)}</Text>
      {same ? (
        <Text size="meta" tone="secondary">
          已经是这样了
        </Text>
      ) : can ? (
        <Stack align="start">
          <Button size="sm" variant="outline" loading={update.isPending} onClick={adopt}>
            采用
          </Button>
        </Stack>
      ) : null}
    </Inset>
  );
}

/** 进度卡（不是组件，没有钩子，直接调）：系统消息「#12 动手中 · ……」，配上单子在 GitHub 的链接和状态点。认不出是哪张单就返回 null（照普通系统消息画）。 */
export function progressCard(m: RequestMessage, d: RequestDetail): ReactNode {
  const hit = /^#(\d{1,9}) ([\s\S]+)$/.exec(m.body);
  const ref = hit ? d.request.issueRefs.find((i) => i.number === Number(hit[1])) : undefined;
  if (!hit || !ref) return null;
  const url = `https://github.com/${ref.repo}/issues/${ref.number}`;
  return (
    <Stack direction="horizontal" gap="sm" align="center" justify="center" data-message="progress">
      <LevelDot level={statusEntry(issueStatus(ref.state)).level} />
      <TextLink
        href={url}
        title={`在 GitHub 上看 ${ref.repo}#${ref.number}（现在${issueStateWord(ref.state)}）`}
      >
        #{ref.number} {hit[2]}
      </TextLink>
    </Stack>
  );
}

/** 答复写回单子的进度（待答、已写回、写回失败）。 */
function answerWord(state: 'pending' | 'written' | 'failed'): string {
  if (state === 'written') return '已写回单子';
  if (state === 'failed') return '写回失败';
  return '待答';
}

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
    <div data-engine-ask={state}>
      {m.answer ? (
        <Stack gap="sm">
          <Text size="meta" tone={state === 'failed' ? 'danger' : 'muted'}>
            {m.answer.by ? `${m.answer.by.name} 答` : '答复'} · {answerWord(state)}
          </Text>
          <Text pre>{m.answer.text}</Text>
          {state === 'failed' ? (
            <Stack direction="horizontal" gap="sm" align="center">
              <div role="alert">
                <Text size="meta" tone="danger">
                  {m.answer.error ?? '后端没写原因'}
                </Text>
              </div>
              {mayAnswer ? (
                <Button
                  size="xs"
                  variant="outline"
                  loading={answer.isPending}
                  onClick={() => send(m.answer?.text ?? '')}
                >
                  重试
                </Button>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      ) : open ? (
        <Stack gap="sm">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="写给引擎的答复，会写回单子上那条评论下面……"
            aria-label="回答引擎的提问"
          />
          <Stack direction="horizontal" gap="sm">
            <Button
              size="sm"
              variant="outline"
              loading={answer.isPending}
              {...(text.trim() ? {} : { disabledReason: '先写答复' })}
              onClick={() => send(text.trim())}
            >
              写回单子
            </Button>
            <Button size="sm" variant="text" onClick={() => setOpen(false)}>
              取消
            </Button>
          </Stack>
        </Stack>
      ) : mayAnswer ? (
        <Stack align="start">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-answer="">
            回答
          </Button>
        </Stack>
      ) : (
        <Text size="meta" tone="muted">
          等发起人回答
        </Text>
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
    <div data-review-card="">
      <Stack gap="sm">
        {card.items.map((it, i) => (
          <Stack
            // biome-ignore lint/suspicious/noArrayIndexKey: 意见按条号存，标的时候也按条号
            key={i}
            direction="horizontal"
            gap="sm"
            align="start"
            data-review-item={it.verdict ?? 'none'}
          >
            <Text size="meta" tone="muted">
              {i + 1}.
            </Text>
            <Text tone={it.verdict === 'reject' ? 'muted' : 'default'} pre>
              {it.text}
            </Text>
            {can ? (
              <Stack direction="horizontal" gap="sm">
                <Button
                  size="xs"
                  variant={it.verdict === 'adopt' ? 'secondary' : 'outline'}
                  aria-pressed={it.verdict === 'adopt'}
                  loading={busy(i, 'adopt')}
                  {...(mark.isPending ? { disabledReason: '正在标上一条' } : {})}
                  onClick={() => go(i, 'adopt')}
                >
                  采用
                </Button>
                <Button
                  size="xs"
                  variant={it.verdict === 'reject' ? 'secondary' : 'text'}
                  aria-pressed={it.verdict === 'reject'}
                  loading={busy(i, 'reject')}
                  {...(mark.isPending ? { disabledReason: '正在标上一条' } : {})}
                  onClick={() => go(i, 'reject')}
                >
                  不用
                </Button>
              </Stack>
            ) : it.verdict ? (
              <Text size="meta" tone="muted">
                {it.verdict === 'adopt' ? '采用' : '不用'}
              </Text>
            ) : null}
          </Stack>
        ))}
        <Text size="meta" tone="muted">
          {card.model} 挑的是第 {card.draftVersion} 版
          {card.draftVersion !== r.draftVersion ? `（现在是第 ${r.draftVersion} 版）` : ''}
        </Text>
      </Stack>
    </div>
  );
}

const DEFAULT_KEY = '__default__';

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
    <MenuButton
      label={current?.name ?? '没配模型'}
      {...(locked ? { disabledReason: why } : { title: why })}
      data-model-chip=""
    >
      {c.modelsUnavailable || c.models.length === 0 ? (
        <RowMenuLabel>
          <Text tone="warning">
            {c.modelsUnavailable ?? '「提需求」用途里一个模型都没配：到「路由」页给它配一个'}
          </Text>
        </RowMenuLabel>
      ) : (
        <RowMenuRadioGroup value={c.model?.id ?? DEFAULT_KEY} onValueChange={pick}>
          <RowMenuRadioItem value={DEFAULT_KEY}>
            用默认{c.defaultModel ? `（${c.defaultModel.name}）` : ''}
          </RowMenuRadioItem>
          {c.models.map((m) => (
            <RowMenuRadioItem key={m.id} value={m.id}>
              {m.name}
            </RowMenuRadioItem>
          ))}
        </RowMenuRadioGroup>
      )}
    </MenuButton>
  );
}

/** 「让指挥官接着问」：两个人都说过话以后指挥官不 @ 不说话，点这个让它接着问。超了限额、引擎关着时写原因。 */
export function NudgeButton({ d }: { d: RequestDetail; phone?: boolean }) {
  const nudge = useNudgeCommander();
  const c = d.commander;
  if (d.request.participants.length === 0) return null;
  const full = c.turns >= c.maxTurns;
  const blocked = c.running ? '指挥官正在回话' : full ? `这条已经聊满 ${c.maxTurns} 轮` : undefined;
  return (
    <Button
      size="xs"
      variant="text"
      loading={nudge.isPending}
      {...(blocked
        ? { disabledReason: blocked }
        : { title: '两个人都说过话以后，指挥官只在被 @ 或点这里时说话' })}
      onClick={() =>
        nudge.mutate(d.request.seq, { onError: (err) => toast.error(`没叫动：${errorText(err)}`) })
      }
      data-nudge=""
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
      <Stack align="center" data-commander-broken="">
        <Text size="meta" tone="warning">
          指挥官回话的流断了：{broken}（刷新后能看到回完的话）
        </Text>
      </Stack>
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
    <Stack gap="sm" data-commander-live={phase ?? c.state}>
      <Stack direction="horizontal" gap="sm" align="center">
        <LevelDot level="processing" />
        <Text size="meta" tone="secondary">
          {review ? '别家在挑错……' : words}
        </Text>
        <Button
          size="xs"
          variant="text"
          loading={stop.isPending}
          onClick={() => stop.mutate(r.seq, { onError: (err) => toast.error(`没停下：${errorText(err)}`) })}
          data-commander-stop=""
        >
          停下
        </Button>
      </Stack>
      {live?.text ? <MarkdownLite source={live.text} /> : null}
    </Stack>
  );
}
