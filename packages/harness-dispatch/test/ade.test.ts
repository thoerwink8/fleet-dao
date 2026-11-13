// 本机 ADE（#3914）：不连 GitHub 也能建工作区、开会话、看到流式回答、续一句、停下、子会话回报、补丁落文件。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createCockpitApi,
  createLocalGateway,
  LOCAL_TOKEN_HEADER,
  localAuthorize,
} from '@fleet-dao/harness-api';
import type { HostProcess, HostSpawnSpec, ProcessHost } from '@fleet-dao/harness-runner';
import { insertAdeSession, readStream, updateAdeSession } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdeHandler } from '../src/ade/http.ts';
import { AdeService, adeCommand } from '../src/ade/service.ts';

const TOKEN = 'b'.repeat(64);
let mode: 'fake' | 'hang' | 'stderr' | 'ask' = 'fake';
let askSpec: { tool: string; input: unknown } = { tool: 'Bash', input: { command: 'git init' } };
let lastProc: ScriptProc | null = null;

class ScriptProc implements HostProcess {
  pid = 42;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  ended = false;
  stdinText = '';
  behavior = '';
  updatedInput: unknown;
  answered = false;
  initReplied = false;
  #onExit?: (code: number | null, signal: string | null) => void;
  #onClose?: () => void;
  constructor() {
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.stdinText += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (
        mode === 'ask' &&
        !this.ended &&
        !this.initReplied &&
        this.stdinText.includes('"subtype":"initialize"')
      ) {
        this.initReplied = true;
        const id = /"request_id":"([^"]+)"/.exec(this.stdinText)?.[1] ?? 'init';
        this.stdout.write(
          `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: {} } })}\n`,
        );
      }
      if (mode !== 'ask' || this.ended || this.answered) return;
      const line = this.stdinText.split('\n').find((part) => part.includes('"control_response"'));
      if (!line) return;
      this.answered = true;
      const msg = JSON.parse(line) as {
        response?: { response?: { behavior?: string; updatedInput?: unknown } };
      };
      this.behavior = msg.response?.response?.behavior ?? '';
      this.updatedInput = msg.response?.response?.updatedInput;
      if (this.behavior === 'allow') this.say('跑完了');
    });
  }
  onError(): void {}
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.#onExit = cb;
  }
  onClose(cb: () => void): void {
    this.#onClose = cb;
  }
  stop(): void {
    this.finish(0, 'SIGTERM');
  }
  async reap() {
    return { found: 0, leftovers: 0 };
  }
  armAsk(tool: string, input: unknown): void {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'tu-1' },
    });
    this.stdout.write(`${line}\n`);
  }
  say(text: string): void {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.stdout.write(`${line}\n`);
    this.stdout.write(`${JSON.stringify({ type: 'result', result: text })}\n`);
    this.finish(0, null);
  }
  finish(code: number | null, signal: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.stdout.end();
    this.#onExit?.(code, signal);
    this.#onClose?.();
  }
}

const host: ProcessHost = {
  kind: 'local',
  start(spec: HostSpawnSpec): HostProcess {
    const proc = new ScriptProc();
    lastProc = proc;
    queueMicrotask(() => {
      if (proc.ended) return;
      if (spec.command[0] === 'hang') return;
      if (mode === 'stderr') {
        proc.stderr.write('同步配置…\n');
        proc.finish(0, null);
        return;
      }
      if (mode === 'ask') {
        proc.armAsk(askSpec.tool, askSpec.input);
        return;
      }
      proc.say('你好');
    });
    return proc;
  },
  async attach() {
    return false;
  },
};

let t: TestDb;
let root: string;
let svc: AdeService;
let base: string;
const gateways: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  t = await createTestDb();
  root = mkdtempSync(join(tmpdir(), 'fleet2-ade-'));
  svc = new AdeService({
    db: t.db,
    dataDir: root,
    host,
    flushMs: 20,
    commandFor: () => (mode === 'hang' ? ['hang'] : ['fake']),
    agents: async () => [{ id: 'claude', resume: true, models: ['default'] }],
  });
  const cockpit = createCockpitApi({
    db: t.db,
    authorize: localAuthorize(TOKEN),
    apiPrefix: '/api',
    pollMs: 30,
  });
  const g = createLocalGateway({
    cockpit,
    token: TOKEN,
    status: () => ({
      profile: 'local',
      version: '0',
      listen: '127.0.0.1:0',
      dataDir: root,
      isolation: { level: 'weak', facts: [] },
      externalWrites: { github: false, egressGateway: false },
      hosts: [],
      settings: [],
      ade: true,
    }),
    ade: createAdeHandler(svc, TOKEN, null),
  });
  gateways.push(g);
  const port = await g.listen(0);
  base = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  for (const g of gateways) await g.close();
  await t.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mode = 'fake';
  askSpec = { tool: 'Bash', input: { command: 'git init' } };
});

async function waitIdle(id: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const row = await svc.getSession(id);
    if (row.status === 'idle' && row.runId === null) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`会话 ${id} 没停下来`);
}

async function textsOf(id: string): Promise<string> {
  const evs = await readStream(t.db, `session:${id}`, 0, 50);
  const runId = [...evs].reverse().find((e) => e.type === 'session.turn.started')?.payload.runId;
  const transcript = typeof runId === 'string' ? await readStream(t.db, `transcript:${runId}`, 0, 50) : [];
  return JSON.stringify([...evs, ...transcript]);
}

describe('会话', () => {
  it('建工作区、发一句、看到回答、再续一句', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('试', dir);
    expect(ws.forge).toBe('local');
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '你好',
    });
    await waitIdle(s.id);
    expect(await textsOf(s.id)).toContain('你好');
    await svc.postMessage(s.id, {
      text: '再来一句',
      from: { kind: 'user', id: null },
      mode: 'send',
      kind: 'chat',
      expectReply: true,
      hops: 0,
    });
    await waitIdle(s.id);
    const evs = await readStream(t.db, `session:${s.id}`, 0, 50);
    expect(evs.filter((e) => e.type === 'session.turn.settled')).toHaveLength(2);
  });

  it('子会话结束给父会话一条 report，父会话不自己开跑', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('父', dir);
    const parent = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const child = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      parentId: parent.id,
      text: '去做',
    });
    await waitIdle(child.id);
    const parentRow = await svc.getSession(parent.id);
    expect(parentRow.status).toBe('idle');
    expect(parentRow.runId).toBeNull();
    const evs = await readStream(t.db, `session:${parent.id}`, 0, 20);
    const report = evs.find((e) => e.type === 'session.message' && e.payload.kind === 'report');
    expect(report?.payload.expectReply).toBe(false);
    expect(evs.some((e) => e.type === 'session.turn.started')).toBe(false);
  });

  it('停下正在跑的一轮，结局是 stopped，队列不自己接', async () => {
    mode = 'hang';
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('停', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '一直跑',
    });
    expect((await svc.getSession(s.id)).status).toBe('running');
    await svc.stop(s.id);
    await waitIdle(s.id);
    const evs = await readStream(t.db, `session:${s.id}`, 0, 20);
    const settled = evs.find((e) => e.type === 'session.turn.settled');
    expect(settled?.payload.outcome).toBe('stopped');
    expect((await svc.getSession(s.id)).hold).toBe(true);
  });

  it('只有 stderr、没有正文时，stderr 不进过程流也不进收场正文', async () => {
    mode = 'stderr';
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('错', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '看文件',
    });
    await waitIdle(s.id);
    const evs = await readStream(t.db, `session:${s.id}`, 0, 20);
    const settled = evs.find((e) => e.type === 'session.turn.settled');
    expect(String(settled?.payload.text ?? '')).not.toContain('同步配置');
    expect(settled?.payload.stderr).toContain('同步配置');
    const runId = evs.find((e) => e.type === 'session.turn.started')?.payload.runId;
    const transcript = typeof runId === 'string' ? await readStream(t.db, `transcript:${runId}`, 0, 20) : [];
    expect(JSON.stringify(transcript)).not.toContain('同步配置');
  });

  it('跑着的时候可以撤回队列，插队会停掉当前轮再跑那一句', async () => {
    mode = 'hang';
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('队', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '一直跑',
    });
    const msg = {
      from: { kind: 'user' as const, id: null },
      kind: 'chat' as const,
      expectReply: true,
      hops: 0,
    };
    await svc.postMessage(s.id, { ...msg, text: '等一下', mode: 'queue' });
    await svc.postMessage(s.id, { ...msg, text: '先做这个', mode: 'queue' });
    expect((await svc.getSession(s.id)).queue).toMatchObject([{ text: '等一下' }, { text: '先做这个' }]);
    await svc.editQueue(s.id, 0, 'drop');
    expect((await svc.getSession(s.id)).queue).toMatchObject([{ text: '先做这个' }]);
    mode = 'fake';
    await svc.editQueue(s.id, 0, 'jump');
    await waitIdle(s.id);
    expect((await svc.getSession(s.id)).status).toBe('idle');
    expect((await svc.getSession(s.id)).queue).toEqual([]);
  });

  it('排队的话先不进对话，真开始跑才记一条，撤回的不记', async () => {
    mode = 'hang';
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('排队', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '一直跑',
    });
    const msg = {
      from: { kind: 'user' as const, id: null },
      kind: 'chat' as const,
      expectReply: true,
      hops: 0,
    };
    await svc.postMessage(s.id, { ...msg, text: '等一下', mode: 'queue' });
    await svc.postMessage(s.id, { ...msg, text: '先做这个', mode: 'queue' });
    const messageTexts = async () => {
      const evs = await readStream(t.db, `session:${s.id}`, 0, 40);
      return evs.filter((e) => e.type === 'session.message').map((e) => e.payload.text);
    };
    expect(await messageTexts()).not.toContain('等一下');
    expect(await messageTexts()).not.toContain('先做这个');
    expect((await svc.getSession(s.id)).queue).toMatchObject([{ text: '等一下' }, { text: '先做这个' }]);
    await svc.editQueue(s.id, 0, 'drop');
    expect(await messageTexts()).not.toContain('等一下');
    mode = 'fake';
    await svc.editQueue(s.id, 0, 'jump');
    await waitIdle(s.id);
    const texts = await messageTexts();
    expect(texts.filter((text) => text === '先做这个')).toHaveLength(1);
    expect(texts).not.toContain('等一下');
  });

  it('重启时接不回的一轮记成 lost', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('掉', dir);
    await insertAdeSession(t.db, {
      id: 'slost0001',
      workspaceId: ws.id,
      parentId: null,
      taskId: null,
      agent: 'claude',
      model: 'default',
      worktree: false,
      cwd: dir,
      title: '掉了',
    });
    await updateAdeSession(t.db, 'slost0001', { status: 'running', runId: 'gone-1' });
    expect(await svc.recover()).toBeGreaterThanOrEqual(1);
    const row = await svc.getSession('slost0001');
    expect(row.status).toBe('idle');
    expect(row.hold).toBe(true);
    const evs = await readStream(t.db, 'session:slost0001', 0, 10);
    expect(evs.some((e) => e.type === 'session.turn.settled' && e.payload.outcome === 'lost')).toBe(true);
  });
});

describe('接口', () => {
  it('没有令牌 401，不是 JSON 415，没连 GitHub 就明说', async () => {
    expect((await fetch(`${base}/api/ade/workspaces`)).status).toBe(401);
    const bad = await fetch(`${base}/api/ade/tasks`, {
      method: 'POST',
      headers: { [LOCAL_TOKEN_HEADER]: TOKEN, 'content-type': 'text/plain' },
      body: 'nope',
    });
    expect(bad.status).toBe(415);
    const imp = await fetch(`${base}/api/ade/tasks/import-github`, {
      method: 'POST',
      headers: { [LOCAL_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(imp.status).toBe(400);
    expect(await imp.json()).toMatchObject({ error: '没连 GitHub' });
  });
});

describe('外送', () => {
  it('local 把 diff 写成补丁文件', async () => {
    const dir = mkdtempSync(join(root, 'repo-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
    git(['init']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(['add', 'a.txt']);
    git(['commit', '-m', 'init']);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const ws = await svc.addWorkspace('仓', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const out = await svc.deliver(s.id);
    expect(out.patchFile).toBeTruthy();
    expect(await textsOfFile(out.patchFile ?? '')).toContain('two');
  });
});

async function textsOfFile(p: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(p, 'utf8');
}

function flag(cmd: string[], name: string): string | undefined {
  const i = cmd.indexOf(name);
  return i >= 0 ? cmd[i + 1] : undefined;
}

function isGrok(bin: string): boolean {
  return bin === 'grok' || bin === 'grok.exe' || /[/\\]grok(\.exe)?$/i.test(bin);
}

describe('真命令', () => {
  it('claude 第二次带同一个会话号的 --resume；grok 用 -r 和 acceptEdits，流里有字和工具；没登录的开不了', async () => {
    const calls: string[][] = [];
    const realHost: ProcessHost = {
      kind: 'local',
      start(spec) {
        calls.push(spec.command);
        const proc = new ScriptProc();
        queueMicrotask(() => {
          if (proc.ended) return;
          if (isGrok(spec.command[0] ?? '')) {
            proc.stdout.write(`${JSON.stringify({ type: 'text', data: '改好了' })}\n`);
            proc.stdout.write(
              `${JSON.stringify({ type: 'tool_call', toolName: 'read_file', toolCallId: 't1', rawInput: { path: 'a.txt' } })}\n`,
            );
            proc.stdout.write(`${JSON.stringify({ type: 'end', stopReason: 'end_turn' })}\n`);
            proc.finish(0, null);
            return;
          }
          proc.say('记住了');
        });
        return proc;
      },
      async attach() {
        return false;
      },
    };
    const local = new AdeService({
      db: t.db,
      dataDir: root,
      host: realHost,
      flushMs: 20,
      commandFor: adeCommand,
      agents: async () => [
        { id: 'claude', resume: true, models: ['sonnet'], ready: true },
        { id: 'grok', resume: true, models: ['grok-4.7'], ready: true },
        { id: 'codex', resume: false, models: [], ready: false, note: '未登录' },
        { id: 'pi', resume: false, models: [], ready: false, note: '未登录' },
      ],
    });
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await local.addWorkspace('真', dir);
    await expect(
      local.createSession({ workspaceId: ws.id, agent: 'codex', model: 'default', worktree: false }),
    ).rejects.toThrow(/未登录/);

    const claude = await local.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'sonnet',
      worktree: false,
      text: '第一句',
    });
    await waitIdle(claude.id);
    await local.postMessage(claude.id, {
      text: '第二句',
      from: { kind: 'user', id: null },
      mode: 'send',
      kind: 'chat',
      expectReply: true,
      hops: 0,
    });
    await waitIdle(claude.id);
    const c1 = calls[0] ?? [];
    const c2 = calls[1] ?? [];
    expect(flag(c1, '--session-id')).toBeTruthy();
    expect(flag(c2, '--resume')).toBe(flag(c1, '--session-id'));
    expect(c2.join(' ')).not.toContain('bypassPermissions');
    expect(flag(c1, '--permission-prompts')).toBe('host');
    expect(flag(c1, '--permission-prompt-tool')).toBe('stdio');
    expect(c1).toContain('--await-initialize');
    expect(flag(c1, '--setting-sources')).toBe('project,local');
    expect(flag(c1, '--input-format')).toBe('stream-json');
    expect(c1.join(' ')).not.toContain('--permission-prompts none');
    const listed = await local.listAgents();
    expect(listed.find((a) => a.id === 'claude')?.approvals).toBe('per-call');
    expect(listed.find((a) => a.id === 'grok')?.approvals).toBe('none');
    expect(listed.find((a) => a.id === 'codex')?.approvals).toBe('none');

    const grok = await local.createSession({
      workspaceId: ws.id,
      agent: 'grok',
      model: 'grok-4.7',
      worktree: false,
      text: '改一行',
    });
    await waitIdle(grok.id);
    expect(await textsOf(grok.id)).toContain('改好了');
    expect(await textsOf(grok.id)).toContain('read_file');
    await local.postMessage(grok.id, {
      text: '还记得吗',
      from: { kind: 'user', id: null },
      mode: 'send',
      kind: 'chat',
      expectReply: true,
      hops: 0,
    });
    await waitIdle(grok.id);
    const g1 = calls[2] ?? [];
    const g2 = calls[3] ?? [];
    expect(isGrok(g1[0] ?? '')).toBe(true);
    expect(flag(g2, '-r')).toBe(flag(g1, '-s'));
    expect(g2).toContain('acceptEdits');
    expect(g2).not.toContain('--always-approve');
    expect(g2.join(' ')).not.toContain('bypassPermissions');
    const promptPath = flag(g2, '--prompt-file');
    expect(promptPath).toBeTruthy();
    expect(readFileSync(promptPath ?? '', 'utf8')).toBe('还记得吗');
    expect(readFileSync(promptPath ?? '', 'utf8')).not.toContain('无原生续接');
  });
});

async function approvalsOf(id: string) {
  const evs = await readStream(t.db, `session:${id}`, 0, 80);
  return evs.filter((e) => e.type === 'session.approval');
}

async function waitPending(id: string): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const hit = (await approvalsOf(id)).find((e) => e.payload.status === 'pending');
    if (hit) return hit.payload;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`会话 ${id} 没有待审批`);
}

function postDecision(id: string, approvalId: unknown, decision: 'allow' | 'deny') {
  return fetch(`${base}/api/ade/sessions/${encodeURIComponent(id)}/approval`, {
    method: 'POST',
    headers: { [LOCAL_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ approvalId, decision }),
  });
}

async function outcomeOf(id: string): Promise<unknown> {
  const evs = await readStream(t.db, `session:${id}`, 0, 80);
  return [...evs].reverse().find((e) => e.type === 'session.turn.settled')?.payload.outcome;
}

describe('审批', () => {
  it('列出来的能力只有 claude 是逐条', async () => {
    const list = await svc.listAgents();
    expect(list.find((a) => a.id === 'claude')?.approvals).toBe('per-call');
  });

  it('改文件由 acceptEdits 放行并留下记录，不挂待审批', async () => {
    mode = 'ask';
    const input = { file_path: 'a.txt', old_string: 'a', new_string: 'b' };
    askSpec = { tool: 'Edit', input };
    const dir = mkdtempSync(join(root, 'ask-'));
    const ws = await svc.addWorkspace('改', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '改文件',
    });
    await waitIdle(s.id);
    const rows = await approvalsOf(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      status: 'allowed',
      result: 'allowed',
      by: 'acceptEdits',
      category: 'edit',
      tool: 'Edit',
    });
    expect(rows[0]?.payload.input).toContain('a.txt');
    expect(String(rows[0]?.payload.at)).toMatch(/^\d{4}-/);
    expect(rows.some((e) => e.payload.status === 'pending')).toBe(false);
    expect(lastProc?.behavior).toBe('allow');
    expect(lastProc?.updatedInput).toEqual(input);
    expect(await outcomeOf(s.id)).toBe('completed');
  });

  it('跑命令先写成待审批，点允许才把原参数交回', async () => {
    mode = 'ask';
    const input = { command: 'git init' };
    askSpec = { tool: 'Bash', input };
    const dir = mkdtempSync(join(root, 'ask-'));
    const ws = await svc.addWorkspace('令', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '初始化',
    });
    const pending = await waitPending(s.id);
    expect(pending).toMatchObject({ status: 'pending', category: 'command', tool: 'Bash' });
    expect(pending.input).toContain('git init');
    expect(pending.by).toBeUndefined();
    expect(lastProc?.stdinText).toContain('"subtype":"initialize"');
    expect(lastProc?.stdinText).toContain('初始化');
    expect(String(pending.at)).toMatch(/^\d{4}-/);
    const res = await postDecision(s.id, pending.approvalId, 'allow');
    expect(res.status).toBe(202);
    await waitIdle(s.id);
    expect(lastProc?.behavior).toBe('allow');
    expect(lastProc?.updatedInput).toEqual(input);
    const decided = (await approvalsOf(s.id)).find((e) => e.payload.status === 'allowed');
    expect(decided?.payload).toMatchObject({
      by: '本机',
      result: 'allowed',
      tool: 'Bash',
      category: 'command',
      approvalId: pending.approvalId,
    });
    expect(String(decided?.payload.at)).toMatch(/^\d{4}-/);
    expect((await postDecision(s.id, pending.approvalId, 'allow')).status).toBe(409);
    expect(await outcomeOf(s.id)).toBe('completed');
  });

  it('联网要人点，点拒绝则这一轮记成停', async () => {
    mode = 'ask';
    const input = { url: 'https://example.com' };
    askSpec = { tool: 'WebFetch', input };
    const dir = mkdtempSync(join(root, 'ask-'));
    const ws = await svc.addWorkspace('网', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '看一眼',
    });
    const pending = await waitPending(s.id);
    expect(pending).toMatchObject({ category: 'network', tool: 'WebFetch', status: 'pending' });
    expect(pending.input).toContain('example.com');
    expect((await postDecision(s.id, pending.approvalId, 'deny')).status).toBe(202);
    await waitIdle(s.id);
    expect(lastProc?.behavior).toBe('deny');
    const decided = (await approvalsOf(s.id)).find((e) => e.payload.status === 'denied');
    expect(decided?.payload).toMatchObject({
      by: '本机',
      result: 'denied',
      tool: 'WebFetch',
      category: 'network',
      approvalId: pending.approvalId,
    });
    expect(String(decided?.payload.at)).toMatch(/^\d{4}-/);
    expect(await outcomeOf(s.id)).toBe('stopped');
  });

  it('还没点这一轮就停了，记成 dropped，不写成是人点的', async () => {
    mode = 'ask';
    askSpec = { tool: 'Bash', input: { command: 'git status' } };
    const dir = mkdtempSync(join(root, 'ask-'));
    const ws = await svc.addWorkspace('停', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '等一下',
    });
    await waitPending(s.id);
    await svc.stop(s.id);
    await waitIdle(s.id);
    const dropped = (await approvalsOf(s.id)).find((e) => e.payload.status === 'dropped');
    expect(dropped?.payload).toMatchObject({
      result: 'stopped',
      status: 'dropped',
      tool: 'Bash',
      category: 'command',
    });
    expect(dropped?.payload.by).toBeUndefined();
    expect(await outcomeOf(s.id)).toBe('stopped');
  });
});
