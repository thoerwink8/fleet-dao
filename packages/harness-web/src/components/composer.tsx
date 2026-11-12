// 本机开会话、发话、排队。控件都来自 src/ui，不再用裸 select。
import { ArrowUp, Plus, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  type AdeAgent,
  type AdeQueueItem,
  type AdeSession,
  type AdeTask,
  type AdeWorkspace,
  adeGet,
  adeQueueAct,
  adeSend,
  queueOf,
} from '../lib/ade';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

const TIERS = [
  { id: 'default', label: '默认' },
  { id: 'low', label: '快' },
  { id: 'high', label: '深' },
] as const;

export function useAdeHome(): {
  workspaces: AdeWorkspace[];
  agents: AdeAgent[];
  error: string;
  reload: () => void;
} {
  const [workspaces, setWorkspaces] = useState<AdeWorkspace[]>([]);
  const [agents, setAgents] = useState<AdeAgent[]>([]);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    let dead = false;
    setError('');
    Promise.all([
      adeGet<{ workspaces: AdeWorkspace[] }>('/workspaces'),
      adeGet<{ agents: AdeAgent[] }>('/agents'),
    ])
      .then(([w, a]) => {
        if (dead) return;
        setWorkspaces(w.workspaces);
        setAgents(a.agents);
      })
      .catch((err: unknown) => {
        if (!dead) setError(err instanceof Error ? err.message : '读不到工作区');
      });
    return () => {
      dead = true;
    };
  }, []);
  useEffect(() => reload(), [reload]);
  return { workspaces, agents, error, reload };
}

function pickedModel(models: string[], model: string, tier: string): string {
  const base = models.includes(model) ? model : (models[0] ?? 'default');
  if (tier === 'default') return base;
  return models.find((m) => m === `${base}:${tier}` || m === `${base}-${tier}`) ?? base;
}

export function WorkspaceDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: () => void;
}) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setMsg('');
    try {
      await adeSend('/workspaces', 'POST', { name, path });
      setPath('');
      setName('');
      onAdded?.();
      onOpenChange(false);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没加上');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="添加工作区" description="本机的一个文件夹。加一次就行，不用常驻在列表上。">
        <div className="flex flex-col gap-2">
          <Input
            data-testid="ade-workspace-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="本机文件夹路径"
          />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字" />
          <Button data-testid="ade-add-workspace" disabled={busy} onClick={() => void add()}>
            添加
          </Button>
          {msg ? (
            <p role="alert" className="text-2xs text-danger">
              {msg}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={label}>
          {label} · {current?.label ?? '—'}
        </Button>
      </MenuTrigger>
      <MenuContent>
        {options.map((o) => (
          <MenuItem key={o.id} onSelect={() => onChange(o.id)}>
            {o.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function EmptyComposer() {
  const nav = useNavigate();
  const { workspaces, agents, error, reload } = useAdeHome();
  const [wsId, setWsId] = useState('');
  const [agent, setAgent] = useState('claude');
  const [model, setModel] = useState('default');
  const [tier, setTier] = useState('default');
  const [worktree, setWorktree] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const ws = workspaces.find((w) => w.id === wsId) ?? workspaces[0];
  const agentInfo = agents.find((a) => a.id === agent);
  const models = agentInfo?.models?.length ? agentInfo.models : ['default'];
  const open = async () => {
    if (!ws) {
      setAddOpen(true);
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const res = await adeSend<{ session: AdeSession }>('/sessions', 'POST', {
        workspaceId: ws.id,
        agent,
        model: pickedModel(models, model, tier),
        worktree: worktree && ws.isGit,
        text,
      });
      nav(`/s/${encodeURIComponent(res.session.id)}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没开成');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid flex-1 place-items-center px-4 py-10">
      <div className="w-full max-w-xl">
        <h2 className="mb-4 text-center text-lg font-medium">新会话</h2>
        <div className="rounded-lg border border-edge bg-composer shadow-xs">
          <Textarea
            data-testid="ade-input"
            value={text}
            rows={4}
            className="border-0 focus-visible:ring-0"
            placeholder="要做什么"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void open();
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1.5">
            <Button variant="ghost" size="icon" aria-label="添加工作区" onClick={() => setAddOpen(true)}>
              <Plus />
            </Button>
            <Picker
              label="工作区"
              value={ws?.id ?? ''}
              options={
                workspaces.length
                  ? workspaces.map((w) => ({ id: w.id, label: w.name }))
                  : [{ id: '', label: '还没有' }]
              }
              onChange={setWsId}
            />
            <Picker
              label="agent"
              value={agent}
              options={(agents.length ? agents : [{ id: 'claude', resume: true, models: ['default'] }]).map(
                (a) => ({
                  id: a.id,
                  label: a.resume ? a.id : `${a.id} · 无原生续接`,
                }),
              )}
              onChange={setAgent}
            />
            <Picker
              label="模型"
              value={models.includes(model) ? model : (models[0] ?? '')}
              options={models.map((m) => ({ id: m, label: m }))}
              onChange={setModel}
            />
            <Picker
              label="档位"
              value={tier}
              options={TIERS.map((t) => ({ id: t.id, label: t.label }))}
              onChange={setTier}
            />
            <Button
              variant={worktree ? 'default' : 'ghost'}
              size="sm"
              aria-pressed={worktree}
              disabled={!ws?.isGit}
              onClick={() => setWorktree((v) => !v)}
            >
              另开工作树
            </Button>
            <Button
              data-testid="ade-new-session"
              size="icon"
              className="ml-auto rounded-full"
              disabled={busy}
              aria-label="新会话"
              onClick={() => void open()}
            >
              <ArrowUp />
            </Button>
          </div>
        </div>
        <p className="mt-2 text-center text-2xs text-muted">
          {ws ? `${ws.name}${ws.isGit ? '' : ' · 不是 git 仓'}` : '先加一个工作区'}
          {tier !== 'default' &&
          pickedModel(models, model, tier) === (models.includes(model) ? model : models[0])
            ? ' · 这个模型没有分档，仍用默认'
            : ''}
        </p>
        {error || msg ? (
          <p role="alert" className="mt-2 text-center text-2xs text-danger">
            {msg || error}
          </p>
        ) : null}
      </div>
      <WorkspaceDialog open={addOpen} onOpenChange={setAddOpen} onAdded={reload} />
    </div>
  );
}

function QueueBar({
  drafts,
  queued,
  onGuide,
  onJumpDraft,
  onDropDraft,
  onJumpQueued,
  onDropQueued,
}: {
  drafts: string[];
  queued: AdeQueueItem[];
  onGuide: (text: string, index: number) => void;
  onJumpDraft: (text: string, index: number) => void;
  onDropDraft: (index: number) => void;
  onJumpQueued: (index: number) => void;
  onDropQueued: (index: number) => void;
}) {
  if (drafts.length === 0 && queued.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-col gap-1" data-testid="ade-queue-bar">
      {drafts.map((text, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: 撤回和插队按队列位置，下标就是身份
          key={`d${i}`}
          className="flex flex-wrap items-center gap-1 rounded-md bg-subtle px-2 py-1 text-xs"
        >
          <span className="min-w-0 basis-full truncate md:flex-1 md:basis-auto">{text}</span>
          <Button data-testid="ade-queue" variant="ghost" size="sm" onClick={() => onGuide(text, i)}>
            引导
          </Button>
          <Button data-testid="ade-jump" variant="ghost" size="sm" onClick={() => onJumpDraft(text, i)}>
            插队
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDropDraft(i)}>
            撤回
          </Button>
        </li>
      ))}
      {queued.map((item, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: 撤回和插队按队列位置，下标就是身份
          key={`q${i}`}
          className="flex flex-wrap items-center gap-1 rounded-md bg-subtle px-2 py-1 text-xs"
        >
          <span className="min-w-0 basis-full truncate md:flex-1 md:basis-auto">{item.text}</span>
          <span className="text-2xs text-muted">已排队</span>
          <Button variant="ghost" size="sm" onClick={() => onJumpQueued(i)}>
            插队
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDropQueued(i)}>
            撤回
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function AdeComposer({
  sessionId,
  onToggleChanges,
}: {
  sessionId: string;
  onToggleChanges?: () => void;
}) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<AdeSession | null>(null);
  const [drafts, setDrafts] = useState<string[]>([]);
  const [wsName, setWsName] = useState('');

  const reload = useCallback(() => {
    let dead = false;
    adeGet<{ session: AdeSession }>(`/sessions/${encodeURIComponent(sessionId)}`)
      .then((r) => {
        if (dead) return;
        setSession(r.session);
        if (r.session.workspaceId) {
          adeGet<{ workspaces: AdeWorkspace[] }>('/workspaces')
            .then((w) => {
              if (!dead) setWsName(w.workspaces.find((x) => x.id === r.session.workspaceId)?.name ?? '');
            })
            .catch(() => {});
        }
      })
      .catch((err: unknown) => {
        if (!dead) setMsg(err instanceof Error ? err.message : '读不到会话');
      });
    return () => {
      dead = true;
    };
  }, [sessionId]);
  useEffect(() => {
    const stop = reload();
    const t = setInterval(reload, 3000);
    return () => {
      stop?.();
      clearInterval(t);
    };
  }, [reload]);

  const running = session?.status === 'running';
  const post = async (body: string, mode: 'send' | 'queue' | 'jump') => {
    setBusy(true);
    setMsg('');
    try {
      await adeSend(`/sessions/${encodeURIComponent(sessionId)}/messages`, 'POST', { text: body, mode });
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没发出去');
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const body = text.trim();
    if (!body) return;
    if (running) {
      setDrafts((d) => [...d, body]);
      setText('');
      return;
    }
    setText('');
    void post(body, 'send');
  };
  const stop = async () => {
    setBusy(true);
    setMsg('');
    try {
      await adeSend(`/sessions/${encodeURIComponent(sessionId)}/stop`, 'POST', {});
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没停下');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      data-testid="ade-composer"
      className="shrink-0 border-t border-edge bg-composer px-3 py-2 md:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (running) void stop();
        else submit();
      }}
    >
      <QueueBar
        drafts={drafts}
        queued={queueOf(session ?? undefined)}
        onGuide={(body, i) => {
          setDrafts((d) => d.filter((_, n) => n !== i));
          void post(body, 'queue');
        }}
        onJumpDraft={(body, i) => {
          setDrafts((d) => d.filter((_, n) => n !== i));
          void post(body, 'jump');
        }}
        onDropDraft={(i) => setDrafts((d) => d.filter((_, n) => n !== i))}
        onJumpQueued={(i) => void adeQueueAct(sessionId, i, 'jump').then(reload)}
        onDropQueued={(i) => void adeQueueAct(sessionId, i, 'drop').then(reload)}
      />
      <div className="rounded-lg border border-edge bg-inset">
        <Textarea
          data-testid="ade-input"
          value={text}
          rows={2}
          className="border-0 bg-transparent focus-visible:ring-0"
          placeholder={running ? '运行中。回车先放进排队条' : '发一句'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          {onToggleChanges ? (
            <Button variant="ghost" size="sm" onClick={onToggleChanges}>
              改动
            </Button>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-2xs text-muted">
            {[wsName, session?.model, session?.worktree ? '工作树' : ''].filter(Boolean).join(' · ')}
          </span>
          <Button
            type="submit"
            data-testid={running ? 'ade-stop' : 'ade-send'}
            size="icon"
            className="rounded-full"
            disabled={busy && !running}
            aria-label={running ? '停止' : '发送'}
          >
            {running ? <Square /> : <ArrowUp />}
          </Button>
        </div>
      </div>
      {msg ? (
        <p role="alert" className="mt-1 text-2xs text-danger">
          {msg}
        </p>
      ) : null}
    </form>
  );
}

export function AdeTasks() {
  const nav = useNavigate();
  const { workspaces, agents, error } = useAdeHome();
  const [tasks, setTasks] = useState<AdeTask[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [wsId, setWsId] = useState('');
  const [msg, setMsg] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const ws = workspaces.find((w) => w.id === wsId) ?? workspaces[0];
  const agent = agents[0]?.id ?? 'claude';
  const model = agents[0]?.models[0] ?? 'default';
  const load = useCallback(() => {
    let dead = false;
    adeGet<{ tasks: AdeTask[] }>('/tasks')
      .then((r) => {
        if (!dead) setTasks(r.tasks);
      })
      .catch((err: unknown) => {
        if (!dead) setMsg(err instanceof Error ? err.message : '读不到单');
      });
    return () => {
      dead = true;
    };
  }, []);
  useEffect(() => load(), [load]);
  const create = async () => {
    if (!ws) return;
    setMsg('');
    try {
      await adeSend('/tasks', 'POST', { workspaceId: ws.id, title, body });
      setTitle('');
      setBody('');
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没建成');
    }
  };
  const open = async (task: AdeTask) => {
    setMsg('');
    try {
      const res = await adeSend<{ session: AdeSession }>('/sessions', 'POST', {
        workspaceId: task.workspaceId,
        agent,
        model,
        taskId: task.id,
      });
      nav(`/s/${encodeURIComponent(res.session.id)}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没开成');
    }
  };
  return (
    <section data-testid="ade-tasks" className="shrink-0 border-b border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Picker
          label="工作区"
          value={ws?.id ?? ''}
          options={
            workspaces.length
              ? workspaces.map((w) => ({ id: w.id, label: w.name }))
              : [{ id: '', label: '先去会话页加工作区' }]
          }
          onChange={setWsId}
        />
        <Input
          data-testid="ade-task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题"
          className="w-48"
        />
        <Input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="说明"
          className="min-w-40 flex-1"
        />
        <Button data-testid="ade-task-create" disabled={!ws} onClick={() => void create()}>
          建单
        </Button>
        <Button variant="outline" onClick={() => setAddOpen(true)}>
          加工作区
        </Button>
      </div>
      {tasks.length > 0 ? (
        <ul className="mt-2 flex flex-col">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-2 border-t border-line py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <Button variant="ghost" size="sm" onClick={() => void open(task)}>
                开会话
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error || msg ? (
        <p role="alert" className="mt-1 text-2xs text-danger">
          {msg || error}
        </p>
      ) : null}
      <WorkspaceDialog open={addOpen} onOpenChange={setAddOpen} />
    </section>
  );
}
