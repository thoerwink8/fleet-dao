// 单子面板（#2062，方案第四节；#3533 起是对话旁边的「单子」页签，样稿 Intake.dc.html 的 tabDraft）。
// 每一栏都能改（原话除外：原话是人说过的话，系统逐字拼，谁也不能改）；改一栏就带着看到的草稿版本号提交，
// 别人先改了后端回 409「已经改到第 N 版」，写在那一栏下面、重拉最新的。待拍板时草稿锁着，结案后只读。
// 手机上同一份字段只读，放在从下往上弹出的面板里（手机不改草稿）。查重、「让别家挑错」是 B、C 片的，这里不放。
import { REQUEST_KINDS } from '@fleet-dao/shared';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRequestReview, useUpdateRequestDraft } from '../../api/client';
import type { RequestDetail, RequestDraft, RequestDraftField } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { Button } from '../layout/button';
import { Input, Textarea } from '../layout/input';
import { Inset } from '../layout/inset';
import { NativeSelect } from '../layout/native-select';
import { Stack } from '../layout/stack';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { useOpenIssueAction } from './open-issue';
import { FIELD_LABELS } from './request-stream';

const ORDER: readonly RequestDraftField[] = [
  'title',
  'kind',
  'size',
  'scene',
  'modules',
  'want',
  'done',
  'notDo',
  'needsHuman',
];
const SHORT: ReadonlySet<RequestDraftField> = new Set(['title', 'kind', 'size', 'needsHuman']);
const HINT: Partial<Record<RequestDraftField, string>> = {
  modules: '一行一个路径',
  done: '一行一条，写成人能点着验的',
  notDo: '选填',
  needsHuman: '碰发布、花钱、删数据、改标准才写',
};

function textOf(d: RequestDraft, f: RequestDraftField): string {
  const v = d[f];
  if (Array.isArray(v)) return v.join('\n');
  return v ?? '';
}

function patchOf(f: RequestDraftField, text: string): Partial<RequestDraft> {
  if (f === 'done') {
    return {
      done: text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    };
  }
  return { [f]: f === 'title' ? text.trim() : text };
}

function FieldBlock({
  d,
  field,
  editable,
  edit,
  onPanelSaved,
}: {
  d: RequestDetail;
  field: RequestDraftField;
  editable: boolean;
  /** 外面点了「改这一栏」：n 变一次就打开这一栏的输入框。 */
  edit?: { field: RequestDraftField; n: number } | null;
  onPanelSaved?: () => void;
}) {
  const r = d.request;
  const save = useUpdateRequestDraft();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const value = textOf(r.draft, field);
  const edited = r.humanEdited.includes(field);
  const seen = useRef(0);
  const start = () => {
    setText(value);
    setError(null);
    setEditing(true);
  };
  useEffect(() => {
    if (!edit || edit.field !== field || !editable || edit.n === seen.current) return;
    seen.current = edit.n;
    setText(textOf(r.draft, field));
    setError(null);
    setEditing(true);
  }, [edit, field, editable, r.draft]);
  const submit = () => {
    setError(null);
    save.mutate(
      { seq: r.seq, body: { baseVersion: r.draftVersion, patch: patchOf(field, text) } },
      {
        onSuccess: (next) => {
          setEditing(false);
          toast.success(`${FIELD_LABELS[field]}改好了：草稿第 ${next.request.draftVersion} 版`);
          onPanelSaved?.();
        },
        onError: (err) => setError(errorText(err)),
      },
    );
  };
  const body: ReactNode = editing ? (
    <Stack gap="sm">
      {field === 'kind' ? (
        // 类别只能是开单认的那三个（写别的开单会失败）：下拉选，原来写了认不出的值也列出来、标明要改
        <NativeSelect value={text} onChange={(e) => setText(e.target.value)} aria-label={FIELD_LABELS[field]}>
          {text && !(REQUEST_KINDS as readonly string[]).includes(text) ? (
            <option value={text}>{text}（认不出，要改）</option>
          ) : null}
          {text ? null : <option value="">选一个（空着按「需求」开）</option>}
          {REQUEST_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </NativeSelect>
      ) : SHORT.has(field) ? (
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={FIELD_LABELS[field]}
          autoFocus
        />
      ) : (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={FIELD_LABELS[field]}
          rows={field === 'done' ? 4 : 3}
          autoFocus
        />
      )}
      {error ? (
        <div role="alert" data-field-error="">
          <Text size="meta" tone="danger">
            没存上：{error}
          </Text>
        </div>
      ) : null}
      <Stack direction="horizontal" gap="sm">
        <Button
          size="sm"
          variant="secondary"
          loading={save.isPending}
          {...(field === 'title' && !text.trim() ? { disabledReason: '标题不能空' } : {})}
          onClick={submit}
        >
          存（第 {r.draftVersion + 1} 版）
        </Button>
        <Button size="sm" variant="text" onClick={() => setEditing(false)}>
          取消
        </Button>
      </Stack>
    </Stack>
  ) : field === 'done' && r.draft.done?.length ? (
    <Stack gap="sm">
      {r.draft.done.map((x, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 按位置排的几条
        <Stack key={i} direction="horizontal" gap="sm" align="start">
          <Text size="meta" tone="muted">
            {i + 1}.
          </Text>
          <Text>{x}</Text>
        </Stack>
      ))}
    </Stack>
  ) : field === 'modules' && value ? (
    <Stack direction="horizontal" gap="sm" wrap>
      {value
        .split('\n')
        .filter(Boolean)
        .map((m) => (
          <Tag key={m} mono>
            {m}
          </Tag>
        ))}
    </Stack>
  ) : value ? (
    <Text size={field === 'title' ? 'heading' : 'body'} pre>
      {value}
    </Text>
  ) : (
    <Text tone="muted">（还没写）</Text>
  );
  return (
    <div id={`draft-${field}`} data-draft-field={field}>
      <Stack gap="sm">
        <Stack direction="horizontal" gap="sm" align="center">
          <Text size="meta" tone="muted" strong>
            {FIELD_LABELS[field]}
          </Text>
          {edited ? <Tag>人改过</Tag> : null}
          {HINT[field] && editing ? (
            <Text size="meta" tone="muted">
              {HINT[field]}
            </Text>
          ) : null}
          {editable && !editing ? (
            <Button
              size="xs"
              variant="text"
              onClick={start}
              aria-label={`改${FIELD_LABELS[field]}`}
              title={`改${FIELD_LABELS[field]}`}
            >
              改
            </Button>
          ) : null}
        </Stack>
        {body}
      </Stack>
    </div>
  );
}

/** 原话：人说过的话，逐条按时间排；只读。 */
function Quotes({ d }: { d: RequestDetail }) {
  const quotes = d.messages.filter((m) => m.kind === 'human');
  return (
    <div id="draft-quotes" data-draft-quotes="">
      <Stack gap="sm">
        <Text size="meta" tone="muted" strong>
          原话（系统逐字保留，不能改）
        </Text>
        {quotes.map((q) => (
          <Inset key={q.id}>
            <Text size="meta" tone="muted">
              {q.author?.name ?? '（不知道是谁）'} · {q.channel === 'mobile' ? '手机' : '网页'} ·{' '}
              {formatDateTime(q.createdAt)}
            </Text>
            <Text pre>{q.body}</Text>
          </Inset>
        ))}
      </Stack>
    </div>
  );
}

export function DraftFields({
  d,
  editable,
  edit,
}: {
  d: RequestDetail;
  editable: boolean;
  edit?: { field: RequestDraftField; n: number } | null;
}) {
  return (
    <Stack gap="lg">
      {ORDER.map((f) => (
        <Fragment key={f}>
          <FieldBlock d={d} field={f} editable={editable} edit={edit ?? null} />
          {f === 'scene' ? <Quotes d={d} /> : null}
        </Fragment>
      ))}
    </Stack>
  );
}

export function DraftPanel({
  d,
  meId,
  edit,
  onContinue,
}: {
  d: RequestDetail;
  meId: string | undefined;
  /** 方案卡点了「改」：打开对应栏的输入框。 */
  edit?: { field: RequestDraftField; n: number } | null;
  onContinue: () => void;
}) {
  const r = d.request;
  const act = useOpenIssueAction();
  const review = useRequestReview();
  const editable = d.actions.editDraft.allowed;
  const closed = r.status === 'closed_do' || r.status === 'closed_drop';
  const kind = r.needsDecision ? 'submit' : 'confirm';
  const verdict = d.actions[kind];
  const mine = r.initiator.id === meId;
  const go = () => act.run(r.seq, kind, r.draftVersion);
  const askReview = () =>
    review.mutate(r.seq, {
      onSuccess: () => toast.success('已请别家挑错：意见回来会出在对话里'),
      onError: (err) => toast.error(`没请成：${errorText(err)}`),
    });
  return (
    <div data-intake-panel="">
      <Stack gap="lg">
        <Stack gap="sm">
          <Text size="meta" tone="muted">
            项目{' '}
            <Text size="meta" tone="muted" mono>
              {r.repo.slug}
            </Text>
            （开聊后不改）· <span data-draft-version="">第 {r.draftVersion} 版</span> ·{' '}
            <span title={editable ? undefined : d.actions.editDraft.why}>
              {editable ? '每一栏都能改' : closed ? '已结案，只读' : '锁着'}
            </span>
          </Text>
        </Stack>
        <div data-intake-draft="">
          <DraftFields d={d} editable={editable} edit={edit ?? null} />
        </div>
        {closed ? (
          <Stack gap="sm" align="start">
            <Text size="meta" tone="muted">
              结案时是第 {r.draftVersion} 版，内容不再改。
            </Text>
            <Button variant="outline" size="sm" onClick={onContinue} data-continue="">
              接着这条提
            </Button>
          </Stack>
        ) : r.status === 'pending_decision' ? (
          <Text size="meta" tone="muted">
            提交拍板的是第 {r.draftVersion} 版。要改，先让拍板人点「再聊聊」，或发起人撤回到讨论中。
          </Text>
        ) : r.deletedAt ? null : (
          <div data-draft-footer="">
            <Stack gap="sm" align="start">
              {!verdict.allowed && verdict.why ? (
                <div data-draft-missing="">
                  <Text size="meta" tone="warning">
                    {verdict.why}
                  </Text>
                </div>
              ) : null}
              {mine ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={act.isPending}
                  {...(verdict.allowed ? {} : { disabledReason: verdict.why ?? '草稿还没齐' })}
                  onClick={go}
                >
                  {r.needsDecision ? '提交拍板' : '确定，开单'}
                </Button>
              ) : (
                <Text size="meta" tone="muted">
                  由发起人 {r.initiator.name} 提交。
                </Text>
              )}
              <Text size="meta" tone="muted">
                {r.needsDecision
                  ? `提交的是第 ${r.draftVersion} 版：拍板人拍了「做」才开单`
                  : `确定的是第 ${r.draftVersion} 版：确定后结案，内容不再改`}
              </Text>
              <Button
                variant="secondary"
                size="sm"
                loading={review.isPending}
                {...(d.commander.running
                  ? { disabledReason: '指挥官正在回话，回完再请别家' }
                  : { title: '请另一家模型挑这一版草稿的错；带「要人拍」的单确定前会自动挑一遍' })}
                onClick={askReview}
                data-ask-review=""
              >
                让别家挑错
              </Button>
            </Stack>
          </div>
        )}
      </Stack>
    </div>
  );
}
