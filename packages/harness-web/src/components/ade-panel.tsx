// 本机装法才挂：工作区、新会话、会话里发话和停、任务页直接建单（#3914）。
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { type AdeAgent, type AdeSession, type AdeTask, type AdeWorkspace, adeGet, adeSend } from '../lib/ade';

const field = 'h-8 min-w-0 rounded-md border border-line bg-surface px-2 text-xs text-ink';
const btn =
  'inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md bg-brand px-3 text-xs font-medium text-white';
const ghost =
  'inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-line bg-surface px-2.5 text-xs text-ink-2';

function useAdeHome(): {
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

export function AdePanel() {
  const nav = useNavigate();
  const { workspaces, agents, error, reload } = useAdeHome();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [wsId, setWsId] = useState('');
  const [agent, setAgent] = useState('claude');
  const [model, setModel] = useState('default');
  const [worktree, setWorktree] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const ws = workspaces.find((w) => w.id === wsId) ?? workspaces[0];
  const agentInfo = agents.find((a) => a.id === agent);
  const models = agentInfo?.models?.length ? agentInfo.models : ['default'];

  const add = async () => {
    setBusy(true);
    setMsg('');
    try {
      await adeSend('/workspaces', 'POST', { name, path });
      setPath('');
      reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没加上');
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    if (!ws) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await adeSend<{ session: AdeSession }>('/sessions', 'POST', {
        workspaceId: ws.id,
        agent,
        model: models.includes(model) ? model : models[0],
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
    <section data-testid="ade-panel" className="shrink-0 space-y-2 border-b border-line bg-surface p-3">
      <p className="text-2xs font-medium text-ink">工作区</p>
      <div className="flex gap-1.5">
        <input
          data-testid="ade-workspace-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="本机文件夹路径"
          className={`${field} flex-1`}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名字"
          className={`${field} w-20`}
        />
        <button
          type="button"
          data-testid="ade-add-workspace"
          className={btn}
          disabled={busy}
          onClick={() => void add()}
        >
          添加
        </button>
      </div>
      <label className="flex items-center gap-2 text-2xs text-muted">
        用
        <select
          data-testid="ade-workspace"
          value={ws?.id ?? ''}
          onChange={(e) => setWsId(e.target.value)}
          className={field}
        >
          {workspaces.length === 0 ? <option value="">还没有工作区</option> : null}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <select aria-label="agent" value={agent} onChange={(e) => setAgent(e.target.value)} className={field}>
          {(agents.length ? agents : [{ id: 'claude', resume: true, models: ['default'] }]).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
              {a.resume ? '' : ' · 无原生续接'}
            </option>
          ))}
        </select>
        <select
          aria-label="模型"
          value={models.includes(model) ? model : (models[0] ?? '')}
          onChange={(e) => setModel(e.target.value)}
          className={field}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-2xs text-muted">
          <input
            type="checkbox"
            checked={worktree && !!ws?.isGit}
            disabled={!ws?.isGit}
            onChange={(e) => setWorktree(e.target.checked)}
          />
          另开工作树
        </label>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="第一句话，可以空着"
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
      />
      <button
        type="button"
        data-testid="ade-new-session"
        className={btn}
        disabled={busy || !ws}
        onClick={() => void open()}
      >
        新会话
      </button>
      {error || msg ? (
        <p role="alert" className="text-2xs text-danger">
          {msg || error}
        </p>
      ) : null}
    </section>
  );
}

export function AdeComposer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (mode: 'send' | 'queue' | 'jump') => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setMsg('');
    try {
      await adeSend(`/sessions/${encodeURIComponent(sessionId)}/messages`, 'POST', { text: body, mode });
      setText('');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没发出去');
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setMsg('');
    try {
      await adeSend(`/sessions/${encodeURIComponent(sessionId)}/stop`, 'POST', {});
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没停下');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="ade-composer"
      className="shrink-0 border-t border-line bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send('send');
      }}
    >
      <textarea
        data-testid="ade-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="发一句"
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="submit" data-testid="ade-send" className={btn} disabled={busy}>
          发送
        </button>
        <button
          type="button"
          data-testid="ade-queue"
          className={ghost}
          disabled={busy}
          onClick={() => void send('queue')}
        >
          排队
        </button>
        <button
          type="button"
          data-testid="ade-jump"
          className={ghost}
          disabled={busy}
          onClick={() => void send('jump')}
        >
          插队
        </button>
        <button
          type="button"
          data-testid="ade-stop"
          className={ghost}
          disabled={busy}
          onClick={() => void stop()}
        >
          停止
        </button>
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
    <section data-testid="ade-tasks" className="shrink-0 space-y-2 border-b border-line bg-surface px-4 py-3">
      <p className="text-xs font-medium">本机的单</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          aria-label="工作区"
          value={ws?.id ?? ''}
          onChange={(e) => setWsId(e.target.value)}
          className={field}
        >
          {workspaces.length === 0 ? <option value="">先去会话页加工作区</option> : null}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <input
          data-testid="ade-task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题"
          className={`${field} w-48`}
        />
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="说明"
          className={`${field} min-w-40 flex-1`}
        />
        <button
          type="button"
          data-testid="ade-task-create"
          className={btn}
          disabled={!ws}
          onClick={() => void create()}
        >
          新建单
        </button>
      </div>
      <ul className="max-h-36 space-y-1 overflow-y-auto">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-2 text-xs">
            <span className="num text-muted">#{task.id}</span>
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            <button
              type="button"
              data-testid={`ade-task-session-${task.id}`}
              className={ghost}
              onClick={() => void open(task)}
            >
              开会话
            </button>
          </li>
        ))}
      </ul>
      {error || msg ? (
        <p role="alert" className="text-2xs text-danger">
          {msg || error}
        </p>
      ) : null}
    </section>
  );
}
