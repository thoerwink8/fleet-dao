// 本机定时（#3929）。到点由内核走和人手同一个建会话路径。控件来自 src/ui，颜色只用令牌。
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { PageBar } from '../components/shell';
import {
  type AdeAgent,
  type AdeSchedule,
  type AdeWorkspace,
  adeGet,
  agentChoices,
  createSchedule,
  defaultModelFor,
  deleteSchedule,
  modelLabel,
  pauseSchedule,
} from '../lib/ade';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/native-select';
import { Textarea } from '../ui/textarea';

const STATUS: Record<string, { text: string; tone: 'neutral' | 'success' | 'danger' }> = {
  active: { text: '等待', tone: 'neutral' },
  paused: { text: '已暂停', tone: 'neutral' },
  firing: { text: '正在开', tone: 'success' },
  done: { text: '已触发', tone: 'neutral' },
  error: { text: '没开成', tone: 'danger' },
};

function whenText(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

function Field({
  id,
  label,
  children,
  className,
}: {
  id: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ''}`}>
      <label htmlFor={id} className="text-2xs text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

export function SchedulesPage() {
  const [workspaces, setWorkspaces] = useState<AdeWorkspace[]>([]);
  const [agents, setAgents] = useState<AdeAgent[]>([]);
  const [rows, setRows] = useState<AdeSchedule[]>([]);
  const [wsId, setWsId] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [when, setWhen] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let dead = false;
    const load = () => {
      Promise.all([
        adeGet<{ workspaces: AdeWorkspace[] }>('/workspaces'),
        adeGet<{ agents: AdeAgent[] }>('/agents'),
        adeGet<{ schedules: AdeSchedule[] }>('/schedules'),
      ])
        .then(([w, a, s]) => {
          if (dead) return;
          setWorkspaces(w.workspaces);
          setAgents(a.agents);
          setRows(s.schedules);
          setError('');
        })
        .catch((err: unknown) => {
          if (!dead) setError(err instanceof Error ? err.message : '读不到定时');
        });
    };
    loadRef.current = () => {
      if (!dead) load();
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!wsId && workspaces[0]) setWsId(workspaces[0].id);
  }, [workspaces, wsId]);

  useEffect(() => {
    if (agent) return;
    const first = agents.find((a) => a.ready !== false) ?? agents[0];
    if (!first) return;
    setAgent(first.id);
    setModel(defaultModelFor(first));
  }, [agents, agent]);

  const info = agents.find((a) => a.id === agent);
  const models = info?.models.length ? info.models : model ? [model] : [];
  const names = new Map(workspaces.map((w) => [w.id, w.name]));

  const submit = async () => {
    setError('');
    const ms = Date.parse(when);
    if (!wsId) {
      setError('先到会话页加一个工作区');
      return;
    }
    if (!text.trim()) {
      setError('话不能空');
      return;
    }
    if (Number.isNaN(ms)) {
      setError('到点时间不对');
      return;
    }
    setBusy(true);
    try {
      await createSchedule({
        workspaceId: wsId,
        agent,
        model,
        text: text.trim(),
        runAt: new Date(ms).toISOString(),
      });
      setText('');
      setWhen('');
      loadRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : '没建成');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      loadRef.current();
    } catch (err) {
      setError(err instanceof Error ? err.message : '没改成');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageBar title="定时" />
      <div data-testid="schedules-page" className="flex flex-col gap-4 p-3 md:p-6">
        <section aria-label="新建定时" className="rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-medium text-ink">新建</h2>
          <p className="mt-1 text-xs text-muted">到点在这个工作区开一轮会话，用这里的 agent 和模型。</p>
          <form
            data-testid="schedule-form"
            className="mt-3 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field id="schedule-workspace" label="工作区">
              <NativeSelect
                id="schedule-workspace"
                aria-label="工作区"
                value={wsId}
                onChange={(e) => setWsId(e.target.value)}
              >
                {workspaces.length === 0 ? <option value="">先去会话页加工作区</option> : null}
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="schedule-agent" label="agent">
              <NativeSelect
                id="schedule-agent"
                aria-label="agent"
                value={agent}
                onChange={(e) => {
                  const id = e.target.value;
                  const next = agents.find((a) => a.id === id);
                  if (!next || next.ready === false) return;
                  setAgent(id);
                  setModel(defaultModelFor(next));
                }}
              >
                {agentChoices(agents).map((a) => (
                  <option key={a.id} value={a.id} disabled={a.disabled}>
                    {a.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="schedule-model" label="模型">
              <NativeSelect
                id="schedule-model"
                aria-label="模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {modelLabel(m)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field id="schedule-when" label="到点">
              <Input
                id="schedule-when"
                aria-label="到点"
                type="datetime-local"
                step={1}
                value={when}
                required
                onChange={(e) => setWhen(e.target.value)}
                className="scheme-light dark:scheme-dark"
              />
            </Field>
            <Field id="schedule-text" label="到点要说的话" className="sm:col-span-2">
              <Textarea
                id="schedule-text"
                aria-label="到点要说的话"
                rows={2}
                value={text}
                placeholder="到点发给这个工作区的第一句话"
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
            <div className="sm:col-span-2">
              <Button
                data-testid="schedule-submit"
                type="submit"
                disabled={busy || !wsId || !agent || !model}
              >
                建定时
              </Button>
            </div>
          </form>
        </section>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <section aria-label="定时列表" className="overflow-hidden rounded-lg border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-3 text-sm font-medium text-ink">定时</h2>
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">还没有定时。</p>
          ) : (
            <ul data-testid="schedule-list">
              {rows.map((row) => {
                const label = STATUS[row.status] ?? { text: row.status, tone: 'neutral' as const };
                return (
                  <li
                    key={row.id}
                    data-schedule-id={row.id}
                    className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink">{row.prompt.split('\n')[0]}</div>
                      <div className="mt-1 truncate text-2xs text-muted">
                        {whenText(row.runAt)} · {names.get(row.workspaceId) ?? row.workspaceId} · {row.agent}{' '}
                        · {modelLabel(row.model)}
                      </div>
                      {row.lastError ? (
                        <div className="mt-1 text-2xs text-danger">{row.lastError}</div>
                      ) : null}
                    </div>
                    <Badge tone={label.tone}>{label.text}</Badge>
                    {row.sessionId ? (
                      <NavLink
                        to={`/s/${encodeURIComponent(row.sessionId)}`}
                        className="text-xs text-brand hover:underline"
                      >
                        看会话
                      </NavLink>
                    ) : null}
                    {row.status === 'active' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act(() => pauseSchedule(row.id))}
                      >
                        暂停
                      </Button>
                    ) : null}
                    {row.status !== 'firing' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act(() => deleteSchedule(row.id))}
                      >
                        删除
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
