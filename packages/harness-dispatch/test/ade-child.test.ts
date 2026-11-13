// #3930：MCP 工具 open_child_session 建出 parent_id；子会话收尾只给父会话一条 report，父会话仍是 idle。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { issueToken } from '@fleet-dao/harness-api';
import type { HostProcess, HostSpawnSpec, ProcessHost } from '@fleet-dao/harness-runner';
import { readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdeService } from '../src/ade/service.ts';

class ScriptProc implements HostProcess {
  pid = 42;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  ended = false;
  #onExit?: (code: number | null, signal: string | null) => void;
  #onClose?: () => void;
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

const started: { command: string[]; env: Record<string, string> }[] = [];

const host: ProcessHost = {
  kind: 'local',
  start(spec: HostSpawnSpec): HostProcess {
    started.push({ command: [...spec.command], env: { ...spec.env } });
    const proc = new ScriptProc();
    queueMicrotask(() => {
      if (!proc.ended) proc.say('文件里就一句话');
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

beforeAll(async () => {
  t = await createTestDb();
  root = mkdtempSync(join(tmpdir(), 'fleet2-child-'));
  svc = new AdeService({
    db: t.db,
    dataDir: root,
    host,
    flushMs: 20,
    mcp: true,
    commandFor: () => ['fake'],
    agents: async () => [
      { id: 'claude', resume: true, models: ['default'] },
      { id: 'grok', resume: true, models: ['grok-4.7'] },
    ],
  });
}, 60_000);

afterAll(async () => {
  await svc.close();
  await t.close();
  rmSync(root, { recursive: true, force: true });
});

async function waitIdle(id: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const row = await svc.getSession(id);
    if (row.status === 'idle' && row.runId === null) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`会话 ${id} 没停下来`);
}

async function mcpCall(base: string, token: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-fleet-session-token': token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'open_child_session', arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${res.status}：${text.slice(0, 400)}`);
  const dataLine = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .at(-1);
  const raw = dataLine ? dataLine.slice('data:'.length).trim() : text;
  const msg = JSON.parse(raw) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  if (msg.error) throw new Error(msg.error.message ?? 'MCP 拒绝');
  const body = msg.result?.content?.[0]?.text ?? 'null';
  if (msg.result?.isError) throw new Error(body);
  return JSON.parse(body);
}

describe('指挥官开子会话', () => {
  it('MCP 工具建出 parent_id，收尾只投 report，父会话仍是 idle，没有 goal 表', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('指挥', dir);
    const parent = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
    });
    const base = await svc.mcpUrl();
    const token = await issueToken(t.db, parent.id, 'commander');
    const before = started.length;
    const opened = (await mcpCall(base, token.token, {
      workspace_id: ws.id,
      agent: 'claude',
      model: 'default',
      text: '读一下 note.txt，回一句话',
    })) as { opened: boolean; sessionId: string; parentId: string };
    expect(opened.opened).toBe(true);
    expect(opened.parentId).toBe(parent.id);
    const child = await svc.getSession(opened.sessionId);
    expect(child.parentId).toBe(parent.id);
    await waitIdle(child.id);
    const parentRow = await svc.getSession(parent.id);
    expect(parentRow.status).toBe('idle');
    expect(parentRow.runId).toBeNull();
    const evs = await readStream(t.db, `session:${parent.id}`, 0, 20);
    const report = evs.find((e) => e.type === 'session.message' && e.payload.kind === 'report');
    expect(report?.payload.expectReply).toBe(false);
    expect(String(report?.payload.text ?? '')).toContain('文件里就一句话');
    expect(evs.some((e) => e.type === 'session.turn.started')).toBe(false);

    const spec = started[before];
    expect(spec?.command).toContain('--mcp-config');
    expect(spec?.command).toContain('--allowedTools');
    expect(spec?.command).toContain('mcp__fleet__open_child_session');
    const mcpPath = spec?.command[spec.command.indexOf('--mcp-config') + 1] ?? '';
    const cfg = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: { fleet: { headers: Record<string, string> } };
    };
    const childToken = cfg.mcpServers.fleet.headers['X-Fleet-Session-Token'] ?? '';
    expect(childToken.length).toBeGreaterThan(10);
    expect(spec?.command.join('\n')).not.toContain(childToken);
    expect(JSON.stringify(spec?.env)).not.toContain(childToken);

    const tables = (await t.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'fleet2' and (table_name ilike '%goal%' or table_name ilike '%mission%')`,
    )) as { rows?: unknown[] } | unknown[];
    const rows = Array.isArray(tables) ? tables : (tables.rows ?? []);
    expect(rows).toEqual([]);
  }, 20_000);

  it('grok 的令牌在 config.toml 里，不在命令行上', async () => {
    const dir = mkdtempSync(join(root, 'gk-'));
    const ws = await svc.addWorkspace('grok', dir);
    const before = started.length;
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'grok',
      model: 'grok-4.7',
      worktree: false,
      text: '读一下',
    });
    await waitIdle(s.id);
    const spec = started[before];
    const home = spec?.env.GROK_HOME ?? '';
    expect(home).not.toBe('');
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    const token = /X-Fleet-Session-Token" = "([^"]+)"/.exec(toml)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(10);
    expect(spec?.command).toContain('--allow');
    expect(spec?.command).toContain('MCPTool(fleet__open_child_session)');
    expect(spec?.command.join('\n')).not.toContain(token);
    expect(JSON.stringify(spec?.env)).not.toContain(token);
  }, 20_000);
});
