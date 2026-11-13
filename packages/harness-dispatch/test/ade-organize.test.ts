// 会话整理（#3931）：改名、置顶、归档写在会话行上；轮数是开跑次数；用量只留执行体给过的数。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  createCockpitApi,
  createLocalGateway,
  LOCAL_TOKEN_HEADER,
  localAuthorize,
} from '@fleet-dao/harness-api';
import type { HostProcess, HostSpawnSpec, ProcessHost } from '@fleet-dao/harness-runner';
import { listRunningAdeSessions, readStream, updateAdeSession } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdeHandler } from '../src/ade/http.ts';
import { AdeError, AdeService } from '../src/ade/service.ts';

const TOKEN = 'c'.repeat(64);

class ScriptProc implements HostProcess {
  pid = 7;
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
  finish(code: number | null, signal: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.stdout.end();
    this.#onExit?.(code, signal);
    this.#onClose?.();
  }
}

let hang = false;
let lines: string[] = [];

const host: ProcessHost = {
  kind: 'local',
  start(_spec: HostSpawnSpec): HostProcess {
    const proc = new ScriptProc();
    if (!hang) {
      const out = lines;
      queueMicrotask(() => {
        if (proc.ended) return;
        for (const line of out) proc.stdout.write(`${line}\n`);
        proc.finish(0, null);
      });
    }
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
let gateway: { close(): Promise<void> };

beforeAll(async () => {
  t = await createTestDb();
  root = mkdtempSync(join(tmpdir(), 'fleet2-ade-org-'));
  svc = new AdeService({
    db: t.db,
    dataDir: root,
    host,
    flushMs: 20,
    commandFor: () => (hang ? ['hang'] : ['fake']),
    agents: async () => [
      { id: 'claude', resume: true, models: ['default'] },
      { id: 'grok', resume: true, models: ['grok-4.7'] },
    ],
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
  const port = await g.listen(0);
  base = `http://127.0.0.1:${port}`;
  gateway = g;
}, 60_000);

afterAll(async () => {
  hang = false;
  await gateway.close();
  await t.close();
  rmSync(root, { recursive: true, force: true });
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

function claudeLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 3,
        output_tokens: 4,
      },
    },
  });
}

describe('会话整理', () => {
  it('改名、置顶、归档写在行上；列表按标题筛，已归档能单独找回来', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('整理', dir);
    lines = [claudeLine(), JSON.stringify({ type: 'result', result: '好', num_turns: 4 })];
    const keep = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '留下的',
    });
    await waitIdle(keep.id);
    const gone = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '收起来的',
    });
    await waitIdle(gone.id);
    const odd = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '100%_done\\x',
    });
    await waitIdle(odd.id);

    const renamed = await svc.updateSession(keep.id, { title: '  改过的名字  ' });
    expect(renamed.title).toBe('改过的名字');
    const pinned = await svc.updateSession(keep.id, { pinned: true });
    expect(pinned.pinned).toBe(true);
    const archived = await svc.updateSession(gone.id, { archived: true });
    expect(archived.archived).toBe(true);

    const visible = await svc.listSessions();
    expect(visible.map((s) => s.id)).toContain(keep.id);
    expect(visible.map((s) => s.id)).not.toContain(gone.id);
    expect(visible[0]?.id).toBe(keep.id);

    const found = await svc.listSessions({ q: '改过' });
    expect(found.map((s) => s.id)).toEqual([keep.id]);
    const literal = await svc.listSessions({ q: '100%_done\\x' });
    expect(literal.map((s) => s.id)).toEqual([odd.id]);
    const percent = await svc.listSessions({ q: '%' });
    expect(percent.map((s) => s.id)).toEqual([odd.id]);
    const underscore = await svc.listSessions({ q: '_' });
    expect(underscore.map((s) => s.id)).toEqual([odd.id]);

    const onlyArchived = await svc.listSessions({ archived: true });
    expect(onlyArchived.map((s) => s.id)).toEqual([gone.id]);
    const back = await svc.updateSession(gone.id, { archived: false });
    expect((await svc.listSessions()).map((s) => s.id)).toContain(back.id);

    await expect(svc.updateSession(keep.id, {})).rejects.toBeInstanceOf(AdeError);
    await expect(svc.updateSession(keep.id, { title: '   ' })).rejects.toMatchObject({ status: 400 });

    const row = await svc.getSession(keep.id);
    expect(row.turns).toBe(1);
    expect(row.context).toMatchObject({
      inputTokens: 10,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 3,
      outputTokens: 4,
    });
    expect(row.context).not.toHaveProperty('windowTokens');
    const evs = await readStream(t.db, `session:${keep.id}`, 0, 50);
    expect(evs.filter((e) => e.type === 'session.turn.started')).toHaveLength(row.turns);
    expect(evs.length).toBeGreaterThan(row.turns);
    await t.db.execute(sql`update fleet2.ade_sessions set turns = 0 where id = ${keep.id}`);
    const backfill = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../harness-store/migrations/0011_nebulous_landau.sql',
      ),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((part) =>
        part
          .replace(/^--[^\n]*\n/m, '')
          .trim()
          .replace(/;\s*$/, ''),
      )
      .find((part) => part.startsWith('UPDATE'));
    if (!backfill) throw new Error('迁移里没有轮数回填');
    await t.db.execute(sql.raw(backfill));
    expect((await svc.getSession(keep.id)).turns).toBe(1);

    await updateAdeSession(t.db, gone.id, { status: 'running', archived: true });
    expect((await listRunningAdeSessions(t.db)).map((s) => s.id)).toContain(gone.id);
    await updateAdeSession(t.db, gone.id, { status: 'idle', archived: false });
  });

  it('排队还没开跑不加轮；开跑两次就是两轮', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('轮数', dir);
    hang = true;
    lines = [];
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '第一句',
    });
    expect((await svc.getSession(s.id)).turns).toBe(1);
    await svc.postMessage(s.id, {
      text: '先排队',
      from: { kind: 'user', id: null },
      mode: 'queue',
      kind: 'chat',
      expectReply: true,
      hops: 0,
    });
    const queued = await svc.getSession(s.id);
    expect(queued.turns).toBe(1);
    expect(queued.queue).toHaveLength(1);
    await svc.stop(s.id);
    await waitIdle(s.id);
    expect((await svc.getSession(s.id)).turns).toBe(1);
    await svc.editQueue(s.id, 0, 'drop');

    hang = false;
    lines = [claudeLine()];
    await svc.postMessage(s.id, {
      text: '第二句',
      from: { kind: 'user', id: null },
      mode: 'send',
      kind: 'chat',
      expectReply: true,
      hops: 0,
    });
    await waitIdle(s.id);
    const done = await svc.getSession(s.id);
    expect(done.turns).toBe(2);
    const evs = await readStream(t.db, `session:${s.id}`, 0, 50);
    expect(evs.filter((e) => e.type === 'session.turn.started')).toHaveLength(2);
  });

  it('Grok 留下 usage 帧，不拿 end 的加总覆盖', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('用量', dir);
    lines = [
      JSON.stringify({
        type: 'usage',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
          output_tokens: 8,
        },
      }),
      JSON.stringify({
        type: 'end',
        usage: {
          input_tokens: 999,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 8,
        },
      }),
    ];
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'grok',
      model: 'grok-4.7',
      worktree: false,
      text: '看用量',
    });
    await waitIdle(s.id);
    const row = await svc.getSession(s.id);
    expect(row.context).toMatchObject({ inputTokens: 100, cacheReadInputTokens: 50 });
    expect(row.context).not.toMatchObject({ inputTokens: 999 });
  });

  it('列表参数和改会话走 HTTP', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('接口', dir);
    lines = [claudeLine()];
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '接口上的',
    });
    await waitIdle(s.id);
    const headers = { [LOCAL_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' };
    const bad = await fetch(`${base}/api/ade/sessions?archived=2`, { headers });
    expect(bad.status).toBe(400);
    const renamed = await fetch(`${base}/api/ade/sessions/${s.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: '接口改名', pinned: true, archived: true }),
    });
    expect(renamed.status).toBe(200);
    const body = (await renamed.json()) as { session: { title: string; pinned: boolean; archived: boolean } };
    expect(body.session).toMatchObject({ title: '接口改名', pinned: true, archived: true });
    const listed = await fetch(`${base}/api/ade/sessions?q=${encodeURIComponent('接口改名')}&archived=1`, {
      headers,
    });
    const list = (await listed.json()) as { sessions: { id: string }[] };
    expect(list.sessions.map((row) => row.id)).toEqual([s.id]);
    const hidden = await fetch(`${base}/api/ade/sessions?q=${encodeURIComponent('接口改名')}`, { headers });
    const hiddenBody = (await hidden.json()) as { sessions: { id: string }[] };
    expect(hiddenBody.sessions.map((row) => row.id)).not.toContain(s.id);
    const marked = await fetch(
      `${base}/api/ade/sessions?known=${encodeURIComponent(`${s.id},not-a-session`)}`,
      {
        headers,
      },
    );
    const markedBody = (await marked.json()) as { sessions: { id: string }[]; knownIds: string[] };
    expect(marked.status).toBe(200);
    expect(markedBody.sessions.map((row) => row.id)).not.toContain(s.id);
    expect(markedBody.knownIds).toEqual([s.id]);
    const tooMany = Array.from({ length: 201 }, (_, i) => `s${i}`).join(',');
    const over = await fetch(`${base}/api/ade/sessions?known=${tooMany}`, { headers });
    expect(over.status).toBe(400);
    const empty = await fetch(`${base}/api/ade/sessions/${s.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });
});
