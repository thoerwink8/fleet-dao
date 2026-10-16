// 单子面板（#2062，方案第四节）：电脑上从右边滑出约 420px（w-84 = 21rem，桌面根字号 20px），开关记在本机。
// 每一栏都能改（原话除外：原话是人说过的话，系统逐字拼，谁也不能改）；改一栏就带着看到的草稿版本号提交，
// 别人先改了后端回 409「已经改到第 N 版」，写在那一栏下面、重拉最新的。待拍板时草稿锁着，结案后只读。
// 手机上同一份字段只读，放在从下往上弹出的面板里（手机不改草稿）。查重、「让别家挑错」是 B、C 片的，这里不放。
import { REQUEST_KINDS } from '@fleet-dao/shared';
import { Lock, PanelRightClose, Pencil, Plus, ScanSearch } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRequestReview, useUpdateRequestDraft } from '../../api/client';
import type { RequestDetail, RequestDraft, RequestDraftField } from '../../api/types';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/utils';
import { NativeSelect } from '../layout/native-select';
import { Tag } from '../layout/tag';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
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
    <div className="space-y-1.5">
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
          className="min-h-0"
          autoFocus
        />
      )}
      {error ? (
        <p className="text-meta text-ink-fail" role="alert" data-field-error>
          没存上：{error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="brand"
          loading={save.isPending}
          disabled={field === 'title' && !text.trim()}
          onClick={submit}
        >
          存（第 {r.draftVersion + 1} 版）
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
          取消
        </Button>
      </div>
    </div>
  ) : field === 'done' && r.draft.done?.length ? (
    <ol className="space-y-1">
      {r.draft.done.map((x, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 按位置排的几条
        <li key={i} className="flex gap-2 text-body">
          <span className="w-4 shrink-0 text-meta text-muted-foreground tabular-nums">{i + 1}.</span>
          <span className="min-w-0">{x}</span>
        </li>
      ))}
    </ol>
  ) : field === 'modules' && value ? (
    <div className="flex flex-wrap gap-1.5">
      {value
        .split('\n')
        .filter(Boolean)
        .map((m) => (
          <code key={m} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-meta">
            {m}
          </code>
        ))}
    </div>
  ) : value ? (
    <p className={cn('whitespace-pre-wrap', field === 'title' ? 'text-heading' : 'text-body')}>{value}</p>
  ) : (
    <p className="text-body text-muted-foreground">（还没写）</p>
  );
  return (
    <div className="group/field rounded-md px-2 py-1.5" id={`draft-${field}`} data-draft-field={field}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-meta font-medium text-muted-foreground">{FIELD_LABELS[field]}</span>
        {edited ? <Tag tone="brand">人改过</Tag> : null}
        {HINT[field] && editing ? (
          <span className="text-meta text-muted-foreground">{HINT[field]}</span>
        ) : null}
        {editable && !editing ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="ml-auto pointer-fine:opacity-40 pointer-fine:group-hover/field:opacity-100"
            onClick={start}
            aria-label={`改${FIELD_LABELS[field]}`}
            title={`改${FIELD_LABELS[field]}`}
          >
            <Pencil />
          </Button>
        ) : null}
      </div>
      {body}
    </div>
  );
}

/** 原话：人说过的话，逐条按时间排；只读。 */
function Quotes({ d }: { d: RequestDetail }) {
  const quotes = d.messages.filter((m) => m.kind === 'human');
  return (
    <div className="rounded-md px-2 py-1.5" id="draft-quotes" data-draft-quotes>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-meta font-medium text-muted-foreground">原话</span>
        <span className="ml-auto inline-flex items-center gap-1 text-meta text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          系统逐字保留，不能改
        </span>
      </div>
      <ul className="space-y-2 rounded-md bg-muted px-3 py-2">
        {quotes.map((q) => (
          <li key={q.id}>
            <div className="text-meta text-muted-foreground tabular-nums">
              {q.author?.name ?? '（不知道是谁）'} · {q.channel === 'mobile' ? '手机' : '网页'} ·{' '}
              {formatDateTime(q.createdAt)}
            </div>
            <blockquote className="text-body whitespace-pre-wrap">{q.body}</blockquote>
          </li>
        ))}
      </ul>
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
    <div className="space-y-1">
      {ORDER.map((f) => (
        <Fragment key={f}>
          <FieldBlock d={d} field={f} editable={editable} edit={edit ?? null} />
          {f === 'scene' ? <Quotes d={d} /> : null}
        </Fragment>
      ))}
    </div>
  );
}

export function DraftPanel({
  d,
  meId,
  edit,
  onClose,
  onContinue,
}: {
  d: RequestDetail;
  meId: string | undefined;
  /** 方案卡点了「改」：打开对应栏的输入框。 */
  edit?: { field: RequestDraftField; n: number } | null;
  onClose: () => void;
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
    <aside
      className="flex h-full min-h-0 w-84 shrink-0 flex-col bg-panel"
      aria-label="单子"
      data-intake-panel
    >
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <h2 className="text-heading">单子</h2>
        <span className="text-meta text-muted-foreground tabular-nums" data-draft-version>
          第 {r.draftVersion} 版
        </span>
        <span
          className="ml-auto min-w-0 truncate text-meta text-muted-foreground"
          title={editable ? undefined : d.actions.editDraft.why}
        >
          {editable ? '每一栏都能改' : closed ? '已结案，只读' : '锁着'}
        </span>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="收起单子" title="收起单子">
          <PanelRightClose />
        </Button>
      </header>
      <div className="border-b px-4 py-1.5 text-meta text-muted-foreground">
        项目 <span className="font-mono">{r.repo.slug}</span>（开聊后不改）
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 scrollbar-thin" data-intake-draft>
        <DraftFields d={d} editable={editable} edit={edit ?? null} />
      </div>
      {closed ? (
        <footer className="space-y-2 border-t px-4 py-3">
          <p className="text-meta text-muted-foreground">结案时是第 {r.draftVersion} 版，内容不再改。</p>
          <Button variant="outline" className="w-full" onClick={onContinue} data-continue>
            <Plus />
            接着这条提
          </Button>
        </footer>
      ) : r.status === 'pending_decision' ? (
        <footer className="border-t px-4 py-3 text-meta text-muted-foreground">
          提交拍板的是第 {r.draftVersion} 版。要改，先让拍板人点「再聊聊」，或发起人撤回到讨论中。
        </footer>
      ) : r.deletedAt ? null : (
        <footer className="space-y-2 border-t px-4 py-3" data-draft-footer>
          {!verdict.allowed && verdict.why ? (
            <p className="text-meta text-ink-stall" data-draft-missing>
              {verdict.why}
            </p>
          ) : null}
          {mine ? (
            <Button
              variant="brand"
              size="lg"
              className="w-full"
              disabled={!verdict.allowed}
              loading={act.isPending}
              onClick={go}
            >
              {r.needsDecision ? '提交拍板' : '确定，开单'}
            </Button>
          ) : (
            <p className="text-meta text-muted-foreground">由发起人 {r.initiator.name} 提交。</p>
          )}
          <p className="text-center text-meta text-muted-foreground tabular-nums">
            {r.needsDecision
              ? `提交的是第 ${r.draftVersion} 版：拍板人拍了「做」才开单`
              : `确定的是第 ${r.draftVersion} 版：确定后结案，内容不再改`}
          </p>
          <Button
            variant="ghost"
            className="w-full"
            loading={review.isPending}
            disabled={d.commander.running}
            onClick={askReview}
            title={
              d.commander.running
                ? '指挥官正在回话，回完再请别家'
                : '请另一家模型挑这一版草稿的错；带「要人拍」的单确定前会自动挑一遍'
            }
            data-ask-review
          >
            <ScanSearch />
            让别家挑错
          </Button>
        </footer>
      )}
    </aside>
  );
}
