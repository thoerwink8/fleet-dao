// 本机 ADE 会话（#3914）：工作区、单、会话都在 fleet2 库里。一轮一个进程，经 ProcessHost 起。
// 人的话开跑；子会话结束只给父会话投一条 report，不自动把父会话再开起来。
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountExhaustedReason } from '@fleet-dao/adapters/judge';
import {
  appendToSession,
  createHarnessApi,
  type HarnessApi,
  issueToken,
  OPEN_CHILD_SESSION,
  revokeSessionTokens,
} from '@fleet-dao/harness-api';
import { type Forge, opKey } from '@fleet-dao/harness-contract';
import { makeRedactor, type ProcessHost, readLines, remoteHostd } from '@fleet-dao/harness-runner';
import {
  type AdeQueueItem,
  type AdeScheduleRow,
  type AdeSessionRow,
  adeQueue,
  claimAdeSchedule,
  type Db,
  deleteAdeSchedule,
  deleteAdeWorkspace,
  enqueueOp,
  failAdeSchedule,
  finishAdeSchedule,
  getAdeSchedule,
  getAdeSession,
  getAdeTask,
  getAdeWorkspace,
  getOp,
  insertAdeSchedule,
  insertAdeSession,
  insertAdeTask,
  insertAdeWorkspace,
  listAdeSchedules,
  listAdeSessions,
  listAdeTasks,
  listAdeWorkspaces,
  listDueAdeSchedules,
  listRunningAdeSessions,
  pauseAdeSchedule,
  releaseFiringSchedules,
  updateAdeSession,
} from '@fleet-dao/harness-store';
import {
  buildWorkerEnv,
  GROK_UNATTENDED_ENV,
  GrokTranscriptParser,
  grokConfigToml,
  MCP_SERVER_NAME,
  type McpEndpoint,
  type TranscriptParser,
  TranscriptWriter,
  writeMcpConfig,
} from '@fleet-dao/harness-workers';
import { localOutboxDeps, processOutbox } from '../publish.ts';
import {
  type AccountsFile,
  type AccountsView,
  addAccount,
  addRelay,
  loadAccounts,
  mergeAccountEnv,
  modelList,
  planSpawn,
  removeAccount,
  removeRelay,
  saveAccounts,
  toView,
  withActive,
  withRelayModels,
  withSelection,
} from './accounts.ts';
import { type AdeAgentInfo, discoverAgents, findAgentBin } from './agents.ts';
import { addWorktree, existingDir, inspectRepo, worktreeDiff } from './git.ts';
import { GitPanelError, gitAct, gitSnapshot } from './git-panel.ts';
import {
  removeGitlabHost as forgetGitlabHost,
  type GitlabHostRow,
  gitlabHostRows,
  loadGitlabHosts,
  normalizeGitlabHost,
  addGitlabHost as rememberGitlabHost,
  saveGitlabToken as writeGitlabToken,
} from './gitlab-hosts.ts';
import { readLocalQuota, unreadQuota } from './quota-view.ts';
import {
  defaultSshDir,
  loadSshHosts,
  parseSshHost,
  type SshHost,
  saveSshHosts,
  writeSshConfig,
} from './ssh-hosts.ts';

export type { AdeAgentInfo } from './agents.ts';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:=,[\]-]{0,80}$/;
const AGENTS = ['claude', 'codex', 'pi', 'grok'] as const;
type AgentId = (typeof AGENTS)[number];

export interface AdeCommandExtra {
  promptFile?: string;
  cwd?: string;
}

export class AdeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdeError';
    this.status = status;
  }
}

export function adeCommand(
  agent: string,
  model: string,
  agentSessionId: string,
  resume: boolean,
  extra: AdeCommandExtra = {},
): string[] {
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
  if (agent === 'grok') {
    // grok 有 --permission-mode acceptEdits（改文件不问）。--always-approve 就是 bypassPermissions，本机不用。
    // 续跑用 -r 点名同一个会话号；-c/--continue 只接「最近一个」，这里不用。
    if (!extra.promptFile || !extra.cwd) throw new AdeError('grok 要先写好提示词文件和工作目录', 500);
    return [
      'grok',
      '--prompt-file',
      extra.promptFile,
      '--output-format',
      'streaming-json',
      '--permission-mode',
      'acceptEdits',
      '--no-plan',
      '-m',
      model,
      '--cwd',
      extra.cwd,
      resume ? '-r' : '-s',
      agentSessionId,
    ];
  }
  // codex、pi 没有接到它们自己的续跑旗标，接口仍标 resume: false。
  if (agent === 'codex') return ['codex', 'exec', '--skip-git-repo-check', '-m', model];
  if (agent === 'pi') return ['pi', '-p', model];
  throw new AdeError(`不认识的 agent：${agent}`, 400);
}

export interface AdeOptions {
  db: Db;
  dataDir: string;
  host: ProcessHost;
  env?: NodeJS.ProcessEnv;
  commandFor?: typeof adeCommand;
  flushMs?: number;
  agents?: () => Promise<AdeAgentInfo[]>;
  /** 测试注入。缺省读本机 CLI 的额度，读不成是「读不到」。 */
  quotaFor?: (env: NodeJS.ProcessEnv) => Promise<Record<string, string>>;
  /** runDue 自己抛出来的错（库断了）。单条定时没建成记在那一行上，不走这里。 */
  onScheduleError?: (err: unknown) => void;
  /**
   * 给会话里的 agent 挂 open_child_session。本机装法打开。
   * 令牌写进 MCP 配置文件，不进命令行。claude、grok 才挂得上；codex、pi 没有这套配置格式。
   */
  mcp?: boolean;
  /** 测试把 SSH config 写到临时目录。缺省是用户的 ~/.ssh。 */
  sshDir?: string;
}

interface Live {
  runId: string;
  stopped: boolean;
  /** 模型正文，只从标准输出收。 */
  lastText: string;
  /** 标准错误，给调试视图。不进正文、不进预览。 */
  stderr: string;
  stop: () => void;
  item: AdeQueueItem;
  /** 这一句已经用过的账号。空串是机器上 CLI 自己的登录。 */
  tried: string[];
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

/** 从一行模型输出里取出要留在列表摘要上的正文。UTF-8 字符串原样留，这里不再解码。 */
export function remember(line: string, prev: string): string {
  const t = line.trim();
  if (!t) return prev;
  try {
    const m = JSON.parse(t) as {
      type?: string;
      result?: unknown;
      data?: unknown;
      toolName?: unknown;
      message?: { content?: { type?: string; text?: string }[] };
    };
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      const texts = m.message.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text ?? '');
      if (texts.length) return texts.join('\n');
    }
    if (m.type === 'text' && typeof m.data === 'string' && m.data) return prev + m.data;
    if (m.type === 'tool_call' && typeof m.toolName === 'string' && m.toolName) {
      return `${prev}${prev ? '\n' : ''}[${m.toolName}]`;
    }
    if (m.type === 'result' && typeof m.result === 'string' && m.result) return m.result;
  } catch {
    return t;
  }
  return prev;
}

const AGENT_BIN: Record<string, string> = { claude: 'reclaude', grok: 'grok', codex: 'codex', pi: 'pi' };

function grokExtraEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const extra: Record<string, string> = { ...GROK_UNATTENDED_ENV };
  for (const k of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    const v = base[k];
    if (v) extra[k] = v;
  }
  return extra;
}

export class AdeService {
  readonly #db: Db;
  readonly #dataDir: string;
  readonly #host: ProcessHost;
  readonly #env: NodeJS.ProcessEnv;
  readonly #commandFor: typeof adeCommand;
  readonly #flushMs: number;
  readonly #agents?: () => Promise<AdeAgentInfo[]>;
  readonly #quotaFor?: (env: NodeJS.ProcessEnv) => Promise<Record<string, string>>;
  readonly #onScheduleError?: (err: unknown) => void;
  readonly #sshDir: string;
  /** 每个远端别名一条 hostd 连接。远端 hostd 自己看守，这里不再套一层。 */
  readonly #remotes = new Map<string, ProcessHost>();
  readonly #live = new Map<string, Live>();
  readonly #locks = new Map<string, Promise<void>>();
  #scheduleTimer: ReturnType<typeof setInterval> | undefined;
  #dueRunning = false;
  readonly #wantMcp: boolean;
  #mcp: HarnessApi | null = null;
  #mcpBase: string | null = null;

  constructor(o: AdeOptions) {
    this.#db = o.db;
    this.#dataDir = o.dataDir;
    this.#host = o.host;
    this.#env = o.env ?? process.env;
    this.#commandFor = o.commandFor ?? adeCommand;
    this.#flushMs = o.flushMs ?? 200;
    this.#wantMcp = o.mcp === true;
    if (o.agents) this.#agents = o.agents;
    if (o.quotaFor) this.#quotaFor = o.quotaFor;
    if (o.onScheduleError) this.#onScheduleError = o.onScheduleError;
    this.#sshDir = o.sshDir ?? defaultSshDir();
  }

  /** 本机装配在 recover 之后才起。测试不走这个间隔，直接把钟传给 runDue。 */
  startScheduleTicker(tickMs: number): void {
    this.stopScheduleTicker();
    if (!tickMs || tickMs <= 0) return;
    const timer = setInterval(() => {
      void this.runDue(new Date()).catch((err) => this.#onScheduleError?.(err));
    }, tickMs);
    timer.unref?.();
    this.#scheduleTimer = timer;
  }

  stopScheduleTicker(): void {
    if (this.#scheduleTimer) clearInterval(this.#scheduleTimer);
    this.#scheduleTimer = undefined;
  }

  /** 关掉给 agent 用的 MCP。不停已经在跑的会话进程。 */
  async close(): Promise<void> {
    await this.#mcp?.close();
    this.#mcp = null;
    this.#mcpBase = null;
  }

  /** 测试用：MCP 的根地址（不含 /mcp）。没开就抛。 */
  async mcpUrl(): Promise<string> {
    if (!this.#wantMcp) throw new AdeError('没开 MCP', 500);
    return this.#ensureMcp();
  }

  /** 没选远端就用装配时的本机宿主。选了就用那个别名的一条 ssh hostd，不另起看守。 */
  #hostFor(row: AdeSessionRow): ProcessHost {
    const alias = row.hostAlias;
    if (!alias) return this.#host;
    let host = this.#remotes.get(alias);
    if (!host) {
      host = remoteHostd(alias);
      this.#remotes.set(alias, host);
    }
    return host;
  }

  async recover(): Promise<number> {
    await releaseFiringSchedules(this.#db, new Date());
    const running = await listRunningAdeSessions(this.#db);
    let n = 0;
    for (const s of running) {
      const alive = s.runId ? await this.#hostFor(s).attach(s.runId) : false;
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
    const repo = await inspectRepo(dir, await loadGitlabHosts(this.#dataDir));
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

  async #baseAgents(): Promise<AdeAgentInfo[]> {
    if (this.#agents) return this.#agents();
    return discoverAgents(this.#env);
  }

  async listAgents(): Promise<AdeAgentInfo[]> {
    const [list, file] = await Promise.all([this.#baseAgents(), this.#accountsFile()]);
    return withRelayModels(list, file);
  }

  async accountsView(): Promise<AccountsView> {
    const [file, agents] = await Promise.all([this.#accountsFile(), this.#baseAgents()]);
    return toView(file, agents);
  }

  async quotaView(): Promise<Record<string, string>> {
    try {
      return await (this.#quotaFor ?? readLocalQuota)(this.#env);
    } catch {
      return unreadQuota();
    }
  }

  async selectAccount(agent: string, tier: string): Promise<AccountsView> {
    return this.#change((file) => withSelection(file, agent, tier));
  }

  async activateAccount(agent: string, activeId: string | null): Promise<AccountsView> {
    return this.#change((file) => withActive(file, agent, activeId));
  }

  async createAccount(agent: string, label: string, env: Record<string, string>): Promise<AccountsView> {
    return this.#change((file) => addAccount(file, agent, label, env));
  }

  async deleteAccount(agent: string, id: string): Promise<AccountsView> {
    return this.#change((file) => removeAccount(file, agent, id));
  }

  async createRelay(input: {
    name: string;
    baseUrl: string;
    key: string;
    models: unknown;
  }): Promise<AccountsView> {
    return this.#change((file) => addRelay(file, { ...input, models: modelList(input.models) }));
  }

  async deleteRelay(id: string): Promise<AccountsView> {
    return this.#change((file) => removeRelay(file, id));
  }

  async #accountsFile() {
    try {
      return await loadAccounts(this.#dataDir);
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '账号配置读不到', 500);
    }
  }

  async #change(fn: (file: AccountsFile) => AccountsFile): Promise<AccountsView> {
    const file = await this.#accountsFile();
    let next: AccountsFile;
    try {
      next = fn(file);
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '账号配置不对', 400);
    }
    try {
      await saveAccounts(this.#dataDir, next);
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '账号配置写不了', 500);
    }
    return this.accountsView();
  }

  listTasks() {
    return listAdeTasks(this.#db);
  }

  listSessions() {
    return listAdeSessions(this.#db);
  }

  listSshHosts(): Promise<SshHost[]> {
    return loadSshHosts(this.#dataDir);
  }

  gitlabHosts(): Promise<GitlabHostRow[]> {
    return gitlabHostRows(this.#dataDir);
  }

  async addGitlabHost(raw: string): Promise<GitlabHostRow[]> {
    try {
      await rememberGitlabHost(this.#dataDir, raw);
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '主机名不对', 400);
    }
    return gitlabHostRows(this.#dataDir);
  }

  async removeGitlabHost(raw: string): Promise<GitlabHostRow[]> {
    try {
      await forgetGitlabHost(this.#dataDir, raw);
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '主机名不对', 400);
    }
    return gitlabHostRows(this.#dataDir);
  }

  async saveGitlabToken(host: string, token: string): Promise<{ host: string; hasToken: true }> {
    try {
      await writeGitlabToken(this.#dataDir, host, token);
      return { host: normalizeGitlabHost(host), hasToken: true };
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '令牌没写下', 400);
    }
  }

  async addSshHost(input: unknown): Promise<SshHost[]> {
    let host: SshHost;
    try {
      host = parseSshHost(input);
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '宿主配置不合法', 400);
    }
    const hosts = (await loadSshHosts(this.#dataDir)).filter((h) => h.alias !== host.alias);
    hosts.push(host);
    await saveSshHosts(this.#dataDir, hosts);
    await writeSshConfig(this.#sshDir, hosts);
    return hosts;
  }

  async #resolveHost(host: string | null | undefined): Promise<string | null> {
    const alias = (host ?? '').trim();
    if (!alias || alias === 'local') return null;
    const hosts = await loadSshHosts(this.#dataDir);
    if (!hosts.some((h) => h.alias === alias)) throw new AdeError('没有这个宿主', 400);
    return alias;
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

  async #sessionTarget(agent: string, model: string, workspaceId: string) {
    if (!AGENTS.includes(agent as AgentId)) throw new AdeError(`不认识的 agent：${agent}`, 400);
    if (!MODEL.test(model)) throw new AdeError(`模型名不合法：${model}`, 400);
    const listed = (await this.listAgents()).find((a) => a.id === agent);
    if (listed?.ready === false) {
      throw new AdeError(listed.note ? `${agent} ${listed.note}` : `${agent} 现在不能用`, 400);
    }
    const ws = await getAdeWorkspace(this.#db, workspaceId);
    if (!ws) throw new AdeError('没有这个工作区', 404);
    return ws;
  }

  listSchedules() {
    return listAdeSchedules(this.#db);
  }

  async createSchedule(input: {
    workspaceId: string;
    agent: string;
    model: string;
    text: string;
    runAt: string;
  }): Promise<AdeScheduleRow> {
    const text = input.text.trim();
    if (!text) throw new AdeError('话不能空', 400);
    if ([...text].length > 8000) throw new AdeError('话太长', 400);
    const ms = Date.parse(input.runAt);
    if (Number.isNaN(ms)) throw new AdeError('到点时间不对', 400);
    await this.#sessionTarget(input.agent, input.model, input.workspaceId);
    const id = `h${randomBytes(8).toString('hex')}`;
    await insertAdeSchedule(this.#db, {
      id,
      workspaceId: input.workspaceId,
      agent: input.agent,
      model: input.model,
      prompt: text,
      runAt: new Date(ms),
    });
    const row = await getAdeSchedule(this.#db, id);
    if (!row) throw new Error('定时写进去了却读不到');
    return row;
  }

  async pauseSchedule(id: string): Promise<AdeScheduleRow> {
    const row = await pauseAdeSchedule(this.#db, id, new Date());
    if (row) return row;
    const cur = await getAdeSchedule(this.#db, id);
    if (!cur) throw new AdeError('没有这条定时', 404);
    throw new AdeError('只有还在等的定时能暂停', 400);
  }

  async deleteSchedule(id: string): Promise<void> {
    const r = await deleteAdeSchedule(this.#db, id);
    if (r === 'deleted') return;
    if (r === 'firing') throw new AdeError('正在到点建会话，等这一下结束再删', 409);
    throw new AdeError('没有这条定时', 404);
  }

  /**
   * 到点的定时调用和人手同一个 createSession。now 由调用方给：测试用假钟，本机装配传系统钟。
   * 没到点、暂停、已经触发过、上次没建成，都不起会话。
   */
  async runDue(now: Date): Promise<{ fired: string[] }> {
    if (Number.isNaN(now.getTime())) throw new AdeError('时钟无效', 400);
    if (this.#dueRunning) return { fired: [] };
    this.#dueRunning = true;
    const fired: string[] = [];
    try {
      const due = await listDueAdeSchedules(this.#db, now);
      for (const row of due) {
        const claimed = await claimAdeSchedule(this.#db, row.id, now);
        if (!claimed) continue;
        try {
          const session = await this.createSession({
            workspaceId: claimed.workspaceId,
            agent: claimed.agent,
            model: claimed.model,
            worktree: false,
            text: claimed.prompt,
          });
          await finishAdeSchedule(this.#db, claimed.id, session.id, now);
          fired.push(session.id);
        } catch (err) {
          const message = (err instanceof Error ? err.message : '建会话失败').replace(/\s+/g, ' ').trim();
          await failAdeSchedule(this.#db, claimed.id, message.slice(0, 300), now);
        }
      }
      return { fired };
    } finally {
      this.#dueRunning = false;
    }
  }

  async createSession(input: {
    workspaceId: string;
    agent: string;
    model: string;
    worktree: boolean;
    taskId?: number | null;
    parentId?: string | null;
    text?: string;
    /** 已登记的 SSH 别名。空或 local 用本机宿主。 */
    host?: string | null;
  }) {
    const ws = await this.#sessionTarget(input.agent, input.model, input.workspaceId);
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
    const hostAlias = await this.#resolveHost(input.host);
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
      hostAlias,
    });
    await appendToSession(this.#db, id, 'session.created', {
      workspaceId: ws.id,
      agent: input.agent,
      model: input.model,
      worktree: input.worktree,
      parentId: input.parentId ?? null,
      taskId: input.taskId ?? null,
      cwd,
      host: hostAlias,
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
      await this.getSession(id);
      const item: AdeQueueItem = {
        text,
        from: msg.from,
        expectReply: msg.expectReply,
        hops: msg.hops,
        kind: msg.kind,
      };
      const deliverOnly =
        msg.kind === 'report' || (msg.from.kind === 'session' && (!msg.expectReply || msg.hops >= 1));
      // 还在排队的不进对话。真开跑时由 #begin 写 session.message。转发和 report 不跑一轮，这里就记。
      if (deliverOnly) {
        await appendToSession(this.#db, id, 'session.message', {
          from: msg.from,
          to: id,
          text,
          kind: msg.kind,
          expectReply: msg.expectReply,
          hops: msg.hops,
          mode: msg.mode,
        });
        return;
      }
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
    return this.#git(id, (s) => gitSnapshot({ db: this.#db, dataDir: this.#dataDir }, s));
  }

  gitOp(id: string, body: Record<string, unknown>) {
    return this.#git(id, (s) => gitAct({ db: this.#db, dataDir: this.#dataDir }, s, body));
  }

  async #git<T>(id: string, fn: (s: AdeSessionRow) => Promise<T>): Promise<T> {
    const s = await this.getSession(id);
    try {
      return await fn(s);
    } catch (err) {
      if (err instanceof GitPanelError) throw new AdeError(err.message, err.status);
      throw err;
    }
  }

  /** 把工作区里的 diff 排进 outbox（forge 跟工作区走），并立刻处理 local。 */
  async deliver(id: string): Promise<{ opKey: string; patchFile?: string }> {
    const row = await this.getSession(id);
    const ws = await getAdeWorkspace(this.#db, row.workspaceId);
    if (!ws) throw new AdeError('工作区没了', 404);
    const diff = await worktreeDiff(row.cwd);
    if (!diff.diff.trim()) throw new AdeError('没有已跟踪的改动', 400);
    const looked = await inspectRepo(row.cwd, await loadGitlabHosts(this.#dataDir));
    const forge = (looked.isGit ? looked.forge : ws.forge) as Forge;
    if (forge === 'gitlab') throw new AdeError('GitLab 不走这条交付，用面板推送', 400);
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

  /** 调用方拿着这会话的锁。tried 是这一句已经用过的账号，用尽了才带。 */
  async #begin(row: AdeSessionRow, item: AdeQueueItem, tried: string[] = []): Promise<void> {
    // 换账号重跑同一句时不再写一遍，避免对话里出现两条一样的用户消息。
    if (tried.length === 0) {
      await appendToSession(this.#db, row.id, 'session.message', {
        from: item.from,
        to: row.id,
        text: item.text,
        kind: item.kind,
        expectReply: item.expectReply,
        hops: item.hops,
        mode: 'send',
      });
    }
    const file = await this.#accountsFile();
    const info = (await this.#baseAgents()).find((a) => a.id === row.agent);
    let plan: ReturnType<typeof planSpawn>;
    try {
      plan = planSpawn(file, row.agent, row.model, info?.models ?? [], tried);
    } catch (err) {
      throw new AdeError(err instanceof Error ? err.message : '账号配置起不了会话', 400);
    }
    if (!plan) throw new AdeError('没有下一个账号', 409);
    const runId = `ade-${row.id}-${randomBytes(4).toString('hex')}`;
    const resume = row.agentSessionId !== null;
    const agentSessionId = row.agentSessionId ?? randomUUID();
    const nativeResume = row.agent === 'claude' || row.agent === 'grok';
    const tmp = join(this.#dataDir, 'tmp', runId);
    await mkdir(tmp, { recursive: true });
    const prompt =
      nativeResume || !resume ? item.text : `（这个 agent 没有原生续接，上文在会话页里）\n${item.text}`;
    const promptFile = join(tmp, 'prompt.md');
    if (row.agent === 'grok') await writeFile(promptFile, prompt, 'utf8');
    let env = mergeAccountEnv(
      buildWorkerEnv({
        base: this.#env,
        tmpDir: tmp,
        ...(row.agent === 'grok' ? { extra: grokExtraEnv(this.#env) } : {}),
      }),
      plan.env,
    );
    await updateAdeSession(this.#db, row.id, { status: 'running', runId, agentSessionId, hold: false });
    await appendToSession(this.#db, row.id, 'session.turn.started', {
      turnId: runId,
      text: item.text,
      runId,
      agent: row.agent,
      model: plan.model,
    });
    const command = [
      ...this.#commandFor(
        row.agent,
        plan.model,
        agentSessionId,
        resume,
        row.agent === 'grok' ? { promptFile, cwd: row.cwd } : {},
      ),
    ];
    if (command[0] === AGENT_BIN[row.agent]) {
      const resolved = await findAgentBin(row.agent, this.#env);
      if (resolved) command[0] = resolved;
    }
    env = await this.#attachMcp(row, command, env, tmp);
    const proc = this.#hostFor(row).start({ command, cwd: row.cwd, env, runId });
    const writer = new TranscriptWriter({
      db: this.#db,
      runId,
      redact: makeRedactor([]),
      flushMs: this.#flushMs,
      maxBatch: 1,
      ...(row.agent === 'claude'
        ? {}
        : {
            parser:
              row.agent === 'grok' ? new GrokTranscriptParser(runId, makeRedactor([])) : textParser(runId),
          }),
    });
    const live: Live = {
      runId,
      stopped: false,
      lastText: '',
      stderr: '',
      item,
      tried: [...tried, plan.accountId],
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
      void this.#lock(row.id, () => this.#finish(row.id, runId, outcome, live.lastText, live.stderr, writer));
    };
    readLines(proc.stdout, (line) => {
      live.lastText = remember(line, live.lastText);
      writer.pushLine(line);
    });
    // 标准错误不进过程流，也不当成模型说的话。调试视图读收场事件上的 stderr。
    readLines(proc.stderr, (line) => {
      const t = line.trim();
      if (!t) return;
      live.stderr = `${live.stderr}${live.stderr ? '\n' : ''}${t}`.slice(-2000);
    });
    proc.onError(() => done('failed'));
    proc.onExit((code) => done(live.stopped ? 'stopped' : code === 0 ? 'completed' : 'failed'));
    if (row.agent !== 'grok') proc.stdin.write(prompt);
    proc.stdin.end();
  }

  async #switchAccount(
    row: AdeSessionRow,
    live: Live | undefined,
    outcome: 'completed' | 'stopped' | 'failed' | 'lost',
    lastText: string,
    stderr: string,
  ): Promise<boolean> {
    if (!live || live.stopped || row.hold || outcome === 'stopped' || outcome === 'lost') return false;
    // 额度用尽的句子常在标准错误。正文仍只收标准输出，判定两边都看。
    const reason = accountExhaustedReason(`${lastText}\n${stderr}`, outcome === 'failed' ? 1 : 0);
    if (!reason) return false;
    const file = await this.#accountsFile();
    const info = (await this.#baseAgents()).find((a) => a.id === row.agent);
    let plan: ReturnType<typeof planSpawn>;
    try {
      plan = planSpawn(file, row.agent, row.model, info?.models ?? [], live.tried);
    } catch {
      return false;
    }
    if (!plan?.accountId || plan.accountId === live.tried[live.tried.length - 1]) return false;
    await appendToSession(this.#db, row.id, 'session.turn.settled', {
      turnId: live.runId,
      runId: live.runId,
      outcome: 'failed',
      text: '额度用尽，换下一个账号',
    });
    await saveAccounts(this.#dataDir, withActive(file, row.agent, plan.accountId));
    await this.#begin(await this.getSession(row.id), live.item, live.tried);
    return true;
  }

  async #finish(
    id: string,
    runId: string,
    outcome: 'completed' | 'stopped' | 'failed' | 'lost',
    lastText: string,
    stderr: string,
    writer: TranscriptWriter,
  ): Promise<void> {
    const live = this.#live.get(id);
    this.#live.delete(id);
    await writer.close();
    const row = await this.getSession(id);
    if (row.runId !== runId) return;
    // 这一轮的进程没了，这一轮的令牌也作废。换账号或队列里的下一句会在 #begin 里另发一枚。
    if (this.#wantMcp) await revokeSessionTokens(this.#db, id);
    if (await this.#switchAccount(row, live, outcome, lastText, stderr)) return;
    await appendToSession(this.#db, id, 'session.turn.settled', {
      turnId: runId,
      runId,
      outcome,
      text: lastText.slice(-500),
      ...(stderr ? { stderr } : {}),
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

  async #ensureMcp(): Promise<string> {
    if (this.#mcpBase) return this.#mcpBase;
    const api = createHarnessApi({
      db: this.#db,
      ade: true,
      openChildSession: (parentId, input) =>
        this.createSession({
          workspaceId: input.workspaceId,
          agent: input.agent,
          model: input.model,
          text: input.text,
          worktree: false,
          parentId,
        }).then((row) => ({ id: row.id })),
    });
    this.#mcp = api;
    const port = await api.listen(0, '127.0.0.1');
    this.#mcpBase = `http://127.0.0.1:${port}`;
    return this.#mcpBase;
  }

  async #mcpEndpoint(sessionId: string): Promise<McpEndpoint> {
    const base = await this.#ensureMcp();
    const issued = await issueToken(this.#db, sessionId, 'commander');
    return { url: `${base}/mcp`, token: issued.token };
  }

  /** claude、grok 才挂得上。令牌写进配置文件，不进命令行。 */
  async #attachMcp(
    row: AdeSessionRow,
    command: string[],
    env: Record<string, string>,
    tmp: string,
  ): Promise<Record<string, string>> {
    if (!this.#wantMcp || (row.agent !== 'claude' && row.agent !== 'grok')) return env;
    const endpoint = await this.#mcpEndpoint(row.id);
    // acceptEdits 只放行改文件。无头没人点批准，不放行的工具会被当场拒。只放这一只。
    const claudeAllow = `mcp__${MCP_SERVER_NAME}__${OPEN_CHILD_SESSION}`;
    const grokAllow = `MCPTool(${MCP_SERVER_NAME}__${OPEN_CHILD_SESSION})`;
    if (row.agent === 'claude') {
      command.push(
        '--strict-mcp-config',
        '--mcp-config',
        await writeMcpConfig(tmp, endpoint),
        '--allowedTools',
        claudeAllow,
      );
      return env;
    }
    command.push('--allow', grokAllow);
    const home = join(tmp, 'grok-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), grokConfigToml(endpoint), { mode: 0o600 });
    const auth =
      this.#env.GROK_AUTH_PATH ||
      join(this.#env.USERPROFILE ?? this.#env.HOME ?? homedir(), '.grok', 'auth.json');
    return { ...env, GROK_HOME: home, GROK_AUTH_PATH: auth };
  }
}
