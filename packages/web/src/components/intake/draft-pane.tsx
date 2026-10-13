// 右栏「单子草稿」：逐栏可改（原话除外）；底部查重、还缺什么、确定开单。开单之后变成只读摘要。
import { ExternalLink, Lock, Plus, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { NativeSelect } from '../layout/native-select';
import { Tag } from '../layout/tag';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import type { Draft, DraftField, DupState } from './data';

export type DupView = DupState | { kind: 'joined'; issue: number } | { kind: 'dismissed' };

export interface DraftProps {
  draft: Draft;
  edited: ReadonlySet<DraftField>;
  flash: DraftField | null;
  opened: boolean;
  partner: boolean;
  dup: DupView | null;
  onChange: (patch: Partial<Draft>, field: DraftField) => void;
  onConfirm: () => void;
  onJoin: () => void;
  onDismiss: () => void;
}

/** 必填四节：场景、原话、已知的模块、怎么算做完（check-brief 同一套口径）。 */
export function missingOf(d: Draft): string[] {
  const out: string[] = [];
  if (!d.scene.trim()) out.push('场景');
  if (d.quotes.length === 0) out.push('原话');
  if (d.modules.length === 0) out.push('已知的模块');
  if (d.done.filter((x) => x.trim()).length === 0) out.push('怎么算做完');
  return out;
}

function Field({
  id,
  label,
  edited,
  flash,
  hint,
  children,
}: {
  id: DraftField;
  label: string;
  edited?: boolean;
  flash?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      id={`draft-${id}`}
      data-flash={flash ? 'on' : undefined}
      className={cn('rounded-md px-2 py-1.5 transition-colors duration-300', flash && 'bg-selected')}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-meta font-medium text-muted-foreground">{label}</span>
        {edited ? <Tag tone="brand">你改过</Tag> : null}
        {hint ? <span className="ml-auto text-meta text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function DraftPane(p: DraftProps) {
  const { draft: d } = p;
  const missing = missingOf(d);
  const ro = p.opened;
  const e = (f: DraftField) => p.edited.has(f);
  const fl = (f: DraftField) => p.flash === f;
  const setDone = (i: number, v: string) =>
    p.onChange({ done: d.done.map((x, j) => (j === i ? v : x)) }, 'done');

  return (
    <aside
      className="flex min-h-0 w-1/3 min-w-96 max-w-2xl shrink-0 flex-col border-l bg-panel"
      aria-label="单子草稿"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <h2 className="text-heading">{ro ? '单子摘要' : '单子草稿'}</h2>
        {ro ? (
          <Tag mono>#12</Tag>
        ) : (
          <span className="text-meta text-muted-foreground tabular-nums" data-intake-version>
            第 {d.version} 版
          </span>
        )}
        <span className="ml-auto text-meta text-muted-foreground">{ro ? '只读' : '每一栏都能直接改'}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3 scrollbar-thin" data-intake-draft>
        <Field id="title" label="标题" edited={e('title')} flash={fl('title')}>
          {ro ? (
            <p className="text-heading">{d.title}</p>
          ) : (
            <Input
              value={d.title}
              onChange={(ev) => p.onChange({ title: ev.target.value }, 'title')}
              aria-label="标题"
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 pb-1">
          <span className="flex items-center gap-2 text-meta text-muted-foreground">
            类别
            <NativeSelect
              disabled={ro}
              value={d.category}
              aria-label="类别"
              onChange={(ev) => p.onChange({ category: ev.target.value as Draft['category'] }, 'title')}
            >
              <option>需求</option>
              <option>缺陷</option>
              <option>杂项</option>
            </NativeSelect>
          </span>
          <span className="flex items-center gap-2 text-meta text-muted-foreground">
            规模建议
            <Tag>{d.size}</Tag>
            <span>约改 2 个模块</span>
          </span>
        </div>
        <Field id="scene" label="场景" edited={e('scene')} flash={fl('scene')}>
          {ro ? (
            <p className="text-body">{d.scene}</p>
          ) : (
            <Textarea
              value={d.scene}
              onChange={(ev) => p.onChange({ scene: ev.target.value }, 'scene')}
              aria-label="场景"
              className="min-h-0"
            />
          )}
        </Field>
        <Field
          id="quote"
          label="原话"
          flash={fl('quote')}
          hint={
            <span className="inline-flex items-center gap-1">
              <Lock className="size-3" aria-hidden />
              原话，系统逐字保留
            </span>
          }
        >
          <ul className="space-y-2 rounded-md bg-muted px-3 py-2" data-intake-quotes>
            {d.quotes.map((q) => (
              <li key={q.at + q.text}>
                <div className="text-meta text-muted-foreground tabular-nums">
                  {q.who} · {q.channel} · {q.at}
                </div>
                <blockquote className="text-body">{q.text}</blockquote>
              </li>
            ))}
          </ul>
        </Field>
        <Field
          id="modules"
          label="已知的模块"
          edited={e('modules')}
          flash={fl('modules')}
          hint="只收聊天里提到过的路径"
        >
          <div className="flex flex-wrap gap-1.5">
            {d.modules.length === 0 ? <span className="text-body text-muted-foreground">还没有</span> : null}
            {d.modules.map((m) => (
              <code key={m} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-meta">
                {m}
              </code>
            ))}
          </div>
        </Field>
        <Field id="want" label="要什么" edited={e('want')} flash={fl('want')}>
          {ro ? (
            <p className="text-body">{d.want}</p>
          ) : (
            <Textarea
              value={d.want}
              onChange={(ev) => p.onChange({ want: ev.target.value }, 'want')}
              aria-label="要什么"
              className="min-h-0"
            />
          )}
        </Field>
        <Field
          id="done"
          label="怎么算做完"
          edited={e('done')}
          flash={fl('done')}
          hint={ro ? undefined : '写成人能点着验的'}
        >
          {d.done.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-body text-muted-foreground">
              还没有。回答左边的问题，指挥官会替你起草。
            </p>
          ) : null}
          <ol className="space-y-1.5">
            {d.done.map((x, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 逐条可改，按位置排
              <li key={i} className="flex items-start gap-2">
                <span className="mt-2 w-4 shrink-0 text-meta text-muted-foreground tabular-nums">
                  {i + 1}.
                </span>
                {ro ? (
                  <span className="text-body">{x}</span>
                ) : (
                  <>
                    <Textarea
                      value={x}
                      aria-label={`怎么算做完第 ${i + 1} 条`}
                      onChange={(ev) => setDone(i, ev.target.value)}
                      className="min-h-0 flex-1"
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="mt-1.5"
                      aria-label={`删掉第 ${i + 1} 条`}
                      onClick={() => p.onChange({ done: d.done.filter((_, j) => j !== i) }, 'done')}
                    >
                      <X />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ol>
          {ro ? null : (
            <Button
              size="xs"
              variant="ghost"
              className="mt-1.5"
              onClick={() => p.onChange({ done: [...d.done, ''] }, 'done')}
            >
              <Plus />
              加一条
            </Button>
          )}
        </Field>
        <Field id="not" label="不做什么" edited={e('not')} flash={fl('not')} hint="选填">
          {ro ? (
            <p className="text-body">{d.not || '（没写）'}</p>
          ) : (
            <Textarea
              value={d.not}
              onChange={(ev) => p.onChange({ not: ev.target.value }, 'not')}
              aria-label="不做什么"
              placeholder="划出边界，引擎就不会多做"
              className="min-h-0"
            />
          )}
        </Field>
      </div>
      {ro ? (
        <footer className="space-y-2 border-t px-4 py-3">
          <p className="text-meta text-muted-foreground">
            开单时确定的是第 {d.version} 版。要补充就在左边接着说，指挥官会判断是补进这张还是另开一张。
          </p>
          <Button asChild variant="outline" className="w-full">
            <a
              href="https://github.com/adfx-studio/daihuo-workbench/issues/12"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink />在 GitHub 打开 #12
            </a>
          </Button>
        </footer>
      ) : (
        <footer className="space-y-2.5 border-t px-4 py-3" data-intake-footer>
          {p.dup?.kind === 'found' ? (
            <div
              className="rounded-lg border border-st-stall-line bg-st-stall-soft px-3 py-2"
              data-intake-dup
            >
              <div className="flex items-start gap-2 text-body">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ink-stall" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <span className="font-medium text-ink-stall">可能重复</span>
                    <Tag mono>#{p.dup.issue}</Tag>
                    <span className="min-w-0 truncate" title={p.dup.title}>
                      {p.dup.title}
                    </span>
                  </div>
                  <div className="text-meta text-muted-foreground">相似的理由：{p.dup.reason}</div>
                  <div className="mt-1.5 flex gap-2">
                    <Button size="xs" variant="outline" onClick={p.onJoin}>
                      补进 #{p.dup.issue}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={p.onDismiss}>
                      不是一回事
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {p.dup?.kind === 'failed' ? (
            <div
              className="flex items-start gap-2 rounded-lg border border-st-doubt-line bg-st-doubt-soft px-3 py-2 text-body"
              data-intake-dup
              role="status"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ink-doubt" aria-hidden />
              <div>
                <span className="font-medium text-ink-doubt">查重没查成：</span>
                {p.dup.reason}
              </div>
            </div>
          ) : null}
          {p.dup?.kind === 'joined' ? (
            <div
              className="rounded-lg border bg-muted px-3 py-2 text-meta text-muted-foreground"
              data-intake-dup
            >
              原话加归纳已补进 #{p.dup.issue}，这段对话到此结束。
            </div>
          ) : null}
          {missing.length > 0 ? (
            <p className="text-meta text-ink-stall" data-intake-missing>
              还缺：{missing.join('、')}
            </p>
          ) : null}
          {p.partner ? (
            <p className="text-meta text-muted-foreground">开出后先等创始人点头（头两周）</p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              variant="brand"
              size="lg"
              className="flex-1"
              disabled={missing.length > 0 || p.dup?.kind === 'joined'}
              onClick={p.onConfirm}
            >
              确定，开单
            </Button>
          </div>
          <p className="text-center text-meta text-muted-foreground tabular-nums">
            {missing.length > 0
              ? `缺项补齐后才能点 · 当前是第 ${d.version} 版草稿`
              : `确定的是第 ${d.version} 版草稿，之后再改要重新确定`}
          </p>
        </footer>
      )}
    </aside>
  );
}
