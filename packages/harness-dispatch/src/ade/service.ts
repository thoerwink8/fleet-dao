// 本机 ADE 会话（#3914）：工作区、单、会话都在 fleet2 库里。一轮一个进程，经 ProcessHost 起。
// 人的话开跑；子会话结束只给父会话投一条 report，不自动把父会话再开起来。
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { appendToSession } from '@fleet-dao/harness-api';
import { type Forge, opKey } from '@fleet-dao/harness-contract';
import { makeRedactor, type ProcessHost, readLines } from '@fleet-dao/harness-runner';
import {
  type AdeQueueItem,
  type AdeSessionRow,
  adeQueue,
  type Db,
  deleteAdeWorkspace,
  enqueueOp,
  getAdeSession,
  getAdeTask,
  getAdeWorkspace,
  getOp,
  insertAdeSession,
  insertAdeTask,
  insertAdeWorkspace,
  listAdeSessions,
  listAdeTasks,
  listAdeWorkspaces,
  listRunningAdeSessions,
  updateAdeSession,
} from '@fleet-dao/harness-store';
import { buildWorkerEnv, type TranscriptParser, TranscriptWriter } from '@fleet-dao/harness-workers';
import { localOutboxDeps, processOutbox } from '../publish.ts';
import { addWorktree, existingDir, inspectRepo, worktreeDiff } from './git.ts';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:=,[\]-]{0,80}$/;
const AGENTS = ['claude', 'codex', 'pi'] as const;
type AgentId = (typeof AGENTS)[number];

export class AdeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdeError';
    this.status = status;
  }
}

export function adeCommand(agent: string, model: string, agentSessionId: string, resume: boolean): string[] {
  if (!MODEL.test(model)) throw new AdeError(`模型名不合法：${model}`, 400);
  if (agent === 'claude') {
    return [
      'reclaude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--model',
      model,
      ...(resume ? ['--resume', agentSessionId] : ['--session-id', agentSessionId]),
    ];
  }
  if (agent === 'codex') return ['codex', 'exec', '--skip-git-repo-check', '-m', model];
  if (agent === 'pi') return ['pi', '-p', model];
  throw new AdeError(`不认识的 agent：${agent}`, 400);
}

export interface AdeAgentInfo {
  id: string;
  resume: boolean;
  models: string[];
}

export interface AdeOptions {
  db: Db;
  dataDir: string;
  host: ProcessHost;
  env?: NodeJS.ProcessEnv;
  commandFor?: typeof adeCommand;
  flushMs?: number;
  agents?: () => Promise<AdeAgentInfo[]>;
}

interface Live {
  runId: string;
  stopped: boolean;
  lastText: string;
  stop: () => void;
}

function textParser(runId: string): TranscriptParser {
  return {
    parse(line) {
      const t = line.trim();
      if (!t) return [];
      return [
        { type: 'transcript.assistant', payload: { runId, text: t, truncated: false, chars: [...t].length } },
      ];
    },
  };
}

function remember(line: string, prev: string): string {
  const t = line.trim();
  if (!t) return prev;
  try {
    const m = JSON.parse(t) as {
      type?: string;
      result?: unknown;
      message?: { content?: { type?: string; text?: string }[] };
    };
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      const texts = m.message.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text ?? '');
      if (texts.length) return texts.join('\n');
    }
    if (m.type === 'result' && typeof m.result === 'string' && m.result) return m.result;
  } catch {
    return t;
  }
  return prev;
}

async function onPath(cmd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = env.PATH ?? env.Path ?? '';
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        await access(join(dir, cmd + ext));
        return true;
      } catch {
        /* 下一个目录 */
      }
    }
  }
  return false;
}

export class AdeService {
  readonly #db: Db;
  readonly #dataDir: string;
  readonly #host: ProcessHost;
  readonly #env: NodeJS.ProcessEnv;
  readonly #commandFor: typeof adeCommand;
  readonly #flushMs: number;
  readonly #agents?: () => Promise<AdeAgentInfo[]>;
  readonly #live = new Map<string, Live>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(o: AdeOptions) {
    this.#db = o.db;
    this.#dataDir = o.dataDir;
    this.#host = o.host;
    this.#env = o.env ?? process.env;
    this.#commandFor = o.commandFor ?? adeCommand;
    this.#flushMs = o.flushMs ?? 200;
    if (o.agents) this.#agents = o.agents;
  }

  async recover(): Promise<number> {
    const running = await listRunningAdeSessions(this.#db);
    let n = 0;
    for (const s of running) {
      const alive = s.runId ? await this.#host.attach(s.runId) : false;
      if (alive === true) continue;
      await appendToSession(this.#db, s.id, 'session.turn.settled', {
        turnId: s.runId ?? 'lost',
        runId: s.runId,
        outcome: 'lost',
        text: '内核重启时这一轮的进程已经不在',
      });
      await updateAdeSession(this.#db, s.id, { status: 'idle', runId: null, hold: true });
      n++;
    }
    return n;
  }

  listWorkspaces() {
    return listAdeWorkspaces(this.#db);
  }

  async addWorkspace(name: string, path: string) {
    const dir = await existingDir(path).catch((e: Error) => {
      throw new AdeError(e.message, 400);
    });
    const repo = await inspectRepo(dir);
    const id = `w${randomBytes(6).toString('hex')}`;
    try {
      await insertAdeWorkspace(this.#db, {
        id,
        name: name.trim() || dir,
        path: dir,
        isGit: repo.isGit,
        forge: repo.forge,
        remote: repo.remote,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ade_workspaces_path_unique') || msg.includes('duplicate')) {
        throw new AdeError('这个文件夹已经是工作区', 409);
      }
      throw err;
    }
    const row = await getAdeWorkspace(this.#db, id);
    if (!row) throw new Error('工作区写进去了却读不到');
    return row;
  }

  async removeWorkspace(id: string): Promise<void> {
    const row = await getAdeWorkspace(this.#db, id);
    if (!row) throw new AdeError('没有这个工作区', 404);
    await deleteAdeWorkspace(this.#db, id);
  }

  async listAgents(): Promise<AdeAgentInfo[]> {
    if (this.#agents) return this.#agents();
    const models = (this.#env.FLEET2_MODELS ?? this.#env.FLEET2_MODEL ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const list = models.length > 0 ? models : ['default'];
    const found: AdeAgentInfo[] = [];
    if (await onPath('reclaude', this.#env)) found.push({ id: 'claude', resume: true, models: list });
    if (await onPath('codex', this.#env)) found.push({ id: 'codex', resume: false, models: list });
    if (await onPath('pi', this.#env)) found.push({ id: 'pi', resume: false, models: list });
    return found;
  }

  listTasks() {
    return listAdeTasks(this.#db);
  }

  listSessions() {
    return listAdeSessions(this.#db);
  }

  async addTask(workspaceId: string, title: string, body: string) {
    const ws = await getAdeWorkspace(this.#db, workspaceId);
    if (!ws) throw new AdeError('没有这个工作区', 404);
    const t = title.trim();
    if (!t) throw new AdeError('标题不能空', 400);
    return insertAdeTask(this.#db, {
      workspaceId,
      title: t,
      body,
      source: { kind: 'manual' },
    });
  }

  async createSession(input: {
    workspaceId: string;
    agent: string;
    model: string;
    worktree: boolean;
    taskId?: number | null;
    parentId?: string | null;
    text?: string;
  }) {
    if (!AGENTS.includes(input.agent as AgentId)) throw new AdeError(`不认识的 agent：${input.agent}`, 400);
    if (!MODEL.test(input.model)) throw new AdeError(`模型名不合法：${input.model}`, 400);
    const ws = await getAdeWorkspace(this.#db, input.workspaceId);
    if (!ws) throw new AdeError('没有这个工作区', 404);
    let taskTitle = '';
    let taskBody = '';
    if (input.taskId != null) {
      const task = await getAdeTask(this.#db, input.taskId);
      if (!task || task.workspaceId !== ws.id) throw new AdeError('没有这张单', 404);
      taskTitle = task.title;
      taskBody = task.body;
    }
    if (input.parentId) {
      const parent = await getAdeSession(this.#db, input.parentId);
      if (!parent) throw new AdeError('没有这个父会话', 404);
    }
    let cwd = ws.path;
    const id = `s${randomBytes(8).toString('hex')}`;
    if (input.worktree) {
      if (!ws.isGit) throw new AdeError('不是 git 仓，不能另开工作树', 400);
      cwd = join(this.#dataDir, 'worktrees', id);
      await addWorktree(ws.path, cwd, `fleet2/${id}`);
    }
    const text = (input.text ?? '').trim() || (taskTitle ? `${taskTitle}\n${taskBody}`.trim() : '');
    const title = (text || taskTitle || '新会话').split('\n')[0]?.slice(0, 80) || '新会话';
    await insertAdeSession(this.#db, {
      id,
      workspaceId: ws.id,
      parentId: input.parentId ?? null,
      taskId: input.taskId ?? null,
      agent: input.agent,
      model: input.model,
      worktree: input.worktree,
      cwd,
      title,
    });
    await appendToSession(this.#db, id, 'session.created', {
      workspaceId: ws.id,
      agent: input.agent,
      model: input.model,
      worktree: input.worktree,
      parentId: input.parentId ?? null,
      taskId: input.taskId ?? null,
      cwd,
    });
    if (text) {
      await this.postMessage(id, {
        text,
        from: { kind: 'user', id: null },
        mode: 'send',
        kind: 'chat',
        expectReply: true,
        hops: 0,
      });
    }
    const row = await getAdeSession(this.#db, id);
    if (!row) throw new Error('会话写进去了却读不到');
    return row;
  }

  async getSession(id: string): Promise<AdeSessionRow> {
    const row = await getAdeSession(this.#db, id);
    if (!row) throw new AdeError('没有这个会话', 404);
    return row;
  }

  async postMessage(
    id: string,
    msg: {
      text: string;
      from: { kind: 'user' | 'session'; id: string | null };
      mode: 'send' | 'queue' | 'jump';
      kind: 'chat' | 'report';
      expectReply: boolean;
      hops: number;
    },
  ): Promise<void> {
    const text = msg.text.trim();
    if (!text) throw new AdeError('话不能空', 400);
    await this.#lock(id, async () => {
      const row = await this.getSession(id);
      const item: AdeQueueItem = {
        text,
        from: msg.from,
        expectReply: msg.expectReply,
        hops: msg.hops,
        kind: msg.kind,
      };
      await appendToSession(this.#db, id, 'session.message', {
        from: msg.from,
        to: id,
        text,
        kind: msg.kind,
        expectReply: msg.expectReply,
        hops: msg.hops,
        mode: row.status === 'running' && msg.mode !== 'jump' ? 'queue' : msg.mode,
      });
      const deliverOnly =
        msg.kind === 'report' || (msg.from.kind === 'session' && (!msg.expectReply || msg.hops >= 1));
      if (deliverOnly) return;
      if (msg.from.kind === 'user') await updateAdeSession(this.#db, id, { hold: false });
      const fresh = await this.getSession(id);
      if (fresh.status === 'running') {
        const q = adeQueue(fresh.queue);
        if (msg.mode === 'jump') q.unshift(item);
        else q.push(item);
        await updateAdeSession(this.#db, id, { queue: q });
        if (msg.mode === 'jump') this.#live.get(id)?.stop();
        return;
      }
      await this.#begin(fresh, item);
    });
  }

  /** 队列里的一条：drop 拿掉；jump 放到最前并停掉当前轮（不置 hold，收场后接着跑它）。 */
  async editQueue(id: string, index: number, op: 'drop' | 'jump'): Promise<void> {
    await this.#lock(id, async () => {
      const row = await this.getSession(id);
      const q = adeQueue(row.queue);
      if (!Number.isInteger(index) || index < 0 || index >= q.length)
        throw new AdeError('队列里没有这一条', 404);
      const [item] = q.splice(index, 1);
      if (!item) throw new AdeError('队列里没有这一条', 404);
      if (op === 'jump' && row.status === 'running') {
        q.unshift(item);
        await updateAdeSession(this.#db, id, { queue: q });
        this.#live.get(id)?.stop();
        return;
      }
      await updateAdeSession(this.#db, id, { queue: q });
      if (op === 'jump') await this.#begin(row, item);
    });
  }

  async stop(id: string): Promise<void> {
    await this.#lock(id, async () => {
      const row = await this.getSession(id);
      if (row.status !== 'running') throw new AdeError('这一轮没在跑', 409);
      await updateAdeSession(this.#db, id, { hold: true });
      const live = this.#live.get(id);
      if (live) live.stopped = true;
      live?.stop();
    });
  }

  changes(id: string) {
    return this.getSession(id).then((s) => worktreeDiff(s.cwd));
  }

  /** 把工作区里的 diff 排进 outbox（forge 跟工作区走），并立刻处理 local。 */
  async deliver(id: string): Promise<{ opKey: string; patchFile?: string }> {
    const row = await this.getSession(id);
    const ws = await getAdeWorkspace(this.#db, row.workspaceId);
    if (!ws) throw new AdeError('工作区没了', 404);
    const diff = await worktreeDiff(row.cwd);
    if (!diff.diff.trim()) throw new AdeError('没有已跟踪的改动', 400);
    const forge = ws.forge as Forge;
    if (forge === 'gitlab') throw new AdeError('gitlab 还没实现', 501);
    const ref = { repo: `local/${ws.id}`, issue: row.taskId ?? 1 };
    const key = opKey('change.push', ref, 0, `${row.id}-${randomBytes(4).toString('hex')}`);
    await enqueueOp(this.#db, {
      opKey: key,
      kind: 'change.push',
      ref,
      fencing: 0,
      payload: { forge, patch: diff.diff, sessionId: row.id },
    });
    if (forge !== 'local') return { opKey: key };
    const deps = localOutboxDeps(this.#db, join(this.#dataDir, 'outbox'), makeRedactor([]));
    deps.batch = 50;
    await processOutbox(deps);
    const op = await getOp(this.#db, key);
    const patchFile =
      op?.result && typeof op.result === 'object' && op.result !== null && 'patchFile' in op.result
        ? String((op.result as { patchFile?: unknown }).patchFile ?? '')
        : '';
    if (!patchFile) throw new AdeError('补丁没有写出去', 500);
    return { opKey: key, patchFile };
  }

  async #lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => gate);
    this.#locks.set(id, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 调用方拿着这会话的锁。 */
  async #begin(row: AdeSessionRow, item: AdeQueueItem): Promise<void> {
    const runId = `ade-${row.id}-${randomBytes(4).toString('hex')}`;
    const resume = row.agentSessionId !== null;
    const agentSessionId = row.agentSessionId ?? randomUUID();
    const tmp = join(this.#dataDir, 'tmp', runId);
    await mkdir(tmp, { recursive: true });
    const prompt =
      row.agent === 'claude' || !resume
        ? item.text
        : `（这个 agent 没有原生续接，上文在会话页里）\n${item.text}`;
    await updateAdeSession(this.#db, row.id, { status: 'running', runId, agentSessionId, hold: false });
    await appendToSession(this.#db, row.id, 'session.turn.started', {
      turnId: runId,
      text: item.text,
      runId,
      agent: row.agent,
      model: row.model,
    });
    const env = buildWorkerEnv({ base: this.#env, tmpDir: tmp });
    const command = this.#commandFor(row.agent, row.model, agentSessionId, resume);
    const proc = this.#host.start({ command, cwd: row.cwd, env, runId });
    const writer = new TranscriptWriter({
      db: this.#db,
      runId,
      redact: makeRedactor([]),
      flushMs: this.#flushMs,
      maxBatch: 1,
      ...(row.agent === 'claude' ? {} : { parser: textParser(runId) }),
    });
    const live: Live = {
      runId,
      stopped: false,
      lastText: '',
      stop: () => {
        live.stopped = true;
        proc.stop('term');
      },
    };
    this.#live.set(row.id, live);
    let once = false;
    const done = (outcome: 'completed' | 'stopped' | 'failed') => {
      if (once) return;
      once = true;
      void this.#lock(row.id, () => this.#finish(row.id, runId, outcome, live.lastText, writer));
    };
    readLines(proc.stdout, (line) => {
      live.lastText = remember(line, live.lastText);
      writer.pushLine(line);
    });
    readLines(proc.stderr, (line) => {
      live.lastText = remember(line, live.lastText);
    });
    proc.onError(() => done('failed'));
    proc.onExit((code) => done(live.stopped ? 'stopped' : code === 0 ? 'completed' : 'failed'));
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  async #finish(
    id: string,
    runId: string,
    outcome: 'completed' | 'stopped' | 'failed' | 'lost',
    lastText: string,
    writer: TranscriptWriter,
  ): Promise<void> {
    this.#live.delete(id);
    await writer.close();
    const row = await this.getSession(id);
    if (row.runId !== runId) return;
    await appendToSession(this.#db, id, 'session.turn.settled', {
      turnId: runId,
      runId,
      outcome,
      text: lastText.slice(-500),
    });
    const queue = adeQueue(row.queue);
    // 用户点停止会先置 hold，队列停在那儿。插队只停掉进程、不置 hold，收场后接着跑队首。
    const next = row.hold ? undefined : queue.shift();
    await updateAdeSession(this.#db, id, { status: 'idle', runId: null, queue });
    if (next) {
      const again = await this.getSession(id);
      await this.#begin(again, next);
      return;
    }
    if (row.parentId && !row.hold && outcome !== 'stopped') {
      const parent = await getAdeSession(this.#db, row.parentId);
      if (!parent) return;
      const text = `子会话 ${id} 结束（${outcome}）\n${lastText.slice(-500)}`;
      await appendToSession(this.#db, parent.id, 'session.message', {
        from: { kind: 'session', id },
        to: parent.id,
        text,
        kind: 'report',
        expectReply: false,
        hops: 0,
      });
    }
  }
}
