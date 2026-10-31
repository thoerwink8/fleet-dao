import {
  Bot,
  CircleStop,
  Flag,
  Gauge,
  GitPullRequestArrow,
  MessageSquare,
  Play,
  Send,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { type Category, categoryOf, num, str, strList, TYPE_LABEL } from '../lib/describe';
import { formatClock, formatDuration, shortId } from '../lib/format';
import type { FeedEvent } from '../lib/types';
import { Chip, type Tone } from './chip';

const ICON: Record<string, ReactNode> = {
  'session.turn.started': <MessageSquare />,
  'session.turn.settled': <Flag />,
  'worker.spawn.requested': <Send />,
  'worker.stop.requested': <CircleStop />,
  'worker.spawned': <Play />,
  'worker.settled': <Square />,
  'worker.progress.reported': <Gauge />,
  'worker.result.submitted': <GitPullRequestArrow />,
  'handback.recorded': <ShieldCheck />,
};

const RAIL: Record<Category, string> = {
  turn: 'bg-neutral-soft text-ink-2',
  dispatch: 'bg-brand-soft text-brand-strong',
  worker: 'bg-neutral-soft text-ink-2',
  handback: 'bg-brand-soft text-brand-strong',
  other: 'bg-neutral-soft text-muted',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-3 sm:grid-cols-[72px_minmax(0,1fr)]">
      <dt className="text-2xs text-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-sm text-ink-2">{children}</dd>
    </div>
  );
}

function Raw({ value, label = '原始内容' }: { value: unknown; label?: string }) {
  return (
    <details className="group text-2xs text-muted">
      <summary className="cursor-pointer select-none py-1 hover:text-ink">{label}</summary>
      <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-subtle p-3 font-mono text-2xs leading-5 text-ink-2">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function verdictTone(v: string | undefined): Tone {
  if (!v) return 'neutral';
  if (/fail|reject|bad|dead|错|拒/i.test(v)) return 'danger';
  if (/unknown|uncertain|partial|不确定/i.test(v)) return 'warning';
  return 'neutral';
}

function body(ev: FeedEvent): { title: ReactNode; chips?: ReactNode; detail?: ReactNode } {
  const p = ev.payload;
  switch (ev.type) {
    case 'worker.spawn.requested': {
      const rest: [string, string | undefined][] = [
        ['必做', str(p.must_do)],
        ['禁止', str(p.must_not)],
        ['背景', str(p.context)],
      ];
      return {
        title: str(p.task) ?? '派工请求',
        detail: (
          <dl className="mt-2 flex flex-col gap-1.5">
            <Field label="期望">{str(p.expected) ?? '—'}</Field>
            <Field label="停止条件">{str(p.stop_when) ?? '—'}</Field>
            <details className="mt-0.5">
              <summary className="cursor-pointer select-none text-2xs text-muted hover:text-ink">
                完整派工单（必做、禁止、背景）
              </summary>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {rest.map(([k, v]) => (
                  <Field key={k} label={k}>
                    {v ?? '—'}
                  </Field>
                ))}
              </div>
            </details>
          </dl>
        ),
      };
    }
    case 'worker.stop.requested':
      return {
        title: '请求叫停这个任务',
        chips: <Chip tone="warning">叫停</Chip>,
        detail: str(p.reason) ? <p className="mt-1 text-sm text-ink-2">{str(p.reason)}</p> : undefined,
      };
    case 'worker.spawned':
      return {
        title: str(p.model) ?? '工人启动',
        chips: p.shadow === true ? <Chip>影子</Chip> : undefined,
        detail: (
          <dl className="mt-1.5 flex flex-col gap-1.5">
            {str(p.deadline) ? <Field label="截止">{formatClock(str(p.deadline) as string)}</Field> : null}
            {str(p.sessionMode) ? <Field label="会话">{str(p.sessionMode)}</Field> : null}
          </dl>
        ),
      };
    case 'worker.settled': {
      const code = num(p.exitCode);
      const abnormal = (code !== undefined && code !== 0) || p.killed != null || str(p.spawnError);
      const tail = str(p.stderrTail);
      return {
        title: abnormal ? '异常结束' : '正常退出',
        chips: (
          <>
            <Chip tone={code === 0 ? 'neutral' : 'danger'} mono>
              退出码 {code ?? '—'}
            </Chip>
            {p.killed != null ? <Chip tone="warning">被杀</Chip> : null}
          </>
        ),
        detail: (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <dl className="flex flex-col gap-1.5">
              {num(p.wallMs) !== undefined ? (
                <Field label="用时">{formatDuration(num(p.wallMs) as number)}</Field>
              ) : null}
              {str(p.lastStep) ? <Field label="最后一步">{str(p.lastStep)}</Field> : null}
              {str(p.spawnError) ? <Field label="起不来">{str(p.spawnError)}</Field> : null}
            </dl>
            {tail ? <Raw value={tail} label="错误输出末尾" /> : null}
          </div>
        ),
      };
    }
    case 'worker.progress.reported': {
      const pct = num(p.percent);
      return {
        title: str(p.summary) ?? '进度',
        detail:
          pct !== undefined ? (
            <div className="mt-2 flex items-center gap-2">
              <div
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1.5 w-40 max-w-full overflow-hidden rounded-full bg-neutral-soft"
              >
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </div>
              <span className="num text-2xs text-muted">{Math.round(pct)}%</span>
            </div>
          ) : undefined,
      };
    }
    case 'worker.result.submitted': {
      const status = str(p.status);
      const tone: Tone = status === 'failed' ? 'danger' : status === 'blocked' ? 'warning' : 'neutral';
      const label =
        status === 'done'
          ? '已完成'
          : status === 'failed'
            ? '失败'
            : status === 'blocked'
              ? '被卡住'
              : (status ?? '—');
      return {
        title: str(p.summary) ?? '交结果',
        chips: <Chip tone={tone}>{label}</Chip>,
        detail: str(p.evidence) ? <Raw value={str(p.evidence)} label="证据" /> : undefined,
      };
    }
    case 'handback.recorded': {
      const verdict = str(p.verdict);
      const outcome = str(p.outcome);
      const reasons = strList(p.reasons);
      const attempt = num(p.attempt);
      return {
        title: p.final === true ? '终局交回' : '中间交回，还会重试',
        chips: (
          <>
            {outcome ? <Chip tone={verdictTone(outcome)}>{outcome}</Chip> : null}
            {verdict ? <Chip tone={verdictTone(verdict)}>核验 {verdict}</Chip> : null}
            {attempt !== undefined ? <Chip>第 {attempt} 次</Chip> : null}
          </>
        ),
        detail: (
          <>
            {reasons.length > 0 ? (
              <ul className="mt-1.5 list-disc pl-5 text-sm text-ink-2 marker:text-line-strong">
                {reasons.map((r) => (
                  <li key={r} className="break-words">
                    {r}
                  </li>
                ))}
              </ul>
            ) : null}
            <Raw value={p} />
          </>
        ),
      };
    }
    case 'session.turn.started':
    case 'session.turn.settled': {
      const text = str(p.text) ?? str(p.summary);
      return { title: text ?? (ev.type === 'session.turn.started' ? '会话轮次开始' : '会话轮次结束') };
    }
    default:
      return { title: TYPE_LABEL[ev.type] ?? ev.type, detail: <Raw value={p} /> };
  }
}

/** 一条事件：左边一根时间线（图标圆点），右边一张白卡片。id 写在 data-event-id 上，e2e 靠它数「不漏不重」。 */
export function EventCard({ ev, taskLabel }: { ev: FeedEvent; taskLabel?: string | undefined }) {
  const cat = categoryOf(ev.type);
  const { title, chips, detail } = body(ev);
  return (
    <li data-event-id={ev.id} data-event-type={ev.type} className="relative flex animate-fade-in gap-3 pb-3">
      <span className="absolute top-7 bottom-0 left-3 w-px bg-line" aria-hidden />
      <span
        className={cn(
          'z-10 grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5',
          RAIL[cat],
        )}
      >
        {ICON[ev.type] ?? <Bot />}
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-xs">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-2xs font-medium text-muted">{TYPE_LABEL[ev.type] ?? ev.type}</span>
          {taskLabel ? (
            <Chip mono title={`任务 ${taskLabel}`}>
              {shortId(taskLabel)}
            </Chip>
          ) : null}
          {chips}
          <span className="num ml-auto text-2xs text-muted" title={ev.createdAt}>
            #{ev.id} · {formatClock(ev.createdAt)}
          </span>
        </div>
        <div className="mt-1 whitespace-pre-wrap break-words text-sm font-medium text-ink">{title}</div>
        {detail}
      </div>
    </li>
  );
}
