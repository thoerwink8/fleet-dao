// 定时（#3929）：假钟到点走和人手同一个 createSession；没到点不起会话。
import { mkdtempSync, rmSync } from 'node:fs';
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
import { claimAdeSchedule, getAdeSchedule, readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdeHandler } from '../src/ade/http.ts';
import { AdeService } from '../src/ade/service.ts';

const TOKEN = 'c'.repeat(64);
const DUE = new Date('2032-04-01T00:00:00.000Z');
const EARLY = new Date('2032-03-01T00:00:00.000Z');

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
  finish(code: number | null, signal: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.stdout.end();
    this.#onExit?.(code, signal);
    this.#onClose?.();
  }
}

let starts = 0;
const host: ProcessHost = {
  kind: 'local',
  start(_spec: HostSpawnSpec): HostProcess {
    starts += 1;
    const proc = new ScriptProc();
    queueMicrotask(() => {
      if (proc.ended) return;
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '好' }] },
      });
      proc.stdout.write(`${line}\n`);
      proc.stdout.write(`${JSON.stringify({ type: 'result', result: '好' })}\n`);
      proc.finish(0, null);
    });
    return proc;
  },
  async attach() {
    return false;
  },
};

let ready = true;
let t: TestDb;
let root: string;
let svc: AdeService;
let base: string;
const gateways: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  t = await createTestDb();
  root = mkdtempSync(join(tmpdir(), 'fleet2-sched-'));
  svc = new AdeService({
    db: t.db,
    dataDir: root,
    host,
    flushMs: 20,
    commandFor: () => ['fake'],
    agents: async () => [{ id: 'claude', resume: true, models: ['sonnet'], ready }],
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
  starts = 0;
  ready = true;
});

async function workspace() {
  const dir = mkdtempSync(join(root, 'ws-'));
  return svc.addWorkspace('定时仓', dir);
}

async function waitIdle(id: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const row = await svc.getSession(id);
    if (row.status === 'idle' && row.runId === null) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`会话 ${id} 没停下来`);
}

type CreateInput = Parameters<AdeService['createSession']>[0];

async function watchCreate(): Promise<{ seen: CreateInput[]; restore: () => void }> {
  const seen: CreateInput[] = [];
  const real = svc.createSession.bind(svc);
  svc.createSession = async (input) => {
    seen.push(input);
    return real(input);
  };
  return {
    seen,
    restore: () => {
      svc.createSession = real;
    },
  };
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      [LOCAL_TOKEN_HEADER]: TOKEN,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

describe('定时', () => {
  it('没到点不起会话', async () => {
    const ws = await workspace();
    const schedule = await svc.createSchedule({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'sonnet',
      text: '还没到',
      runAt: DUE.toISOString(),
    });
    const watch = await watchCreate();
    try {
      const r = await svc.runDue(EARLY);
      expect(r.fired).toEqual([]);
      expect(watch.seen).toEqual([]);
      expect(starts).toBe(0);
      const sessions = await svc.listSessions();
      expect(sessions.some((s) => s.title.includes('还没到'))).toBe(false);
    } finally {
      watch.restore();
      await svc.deleteSchedule(schedule.id);
    }
  });

  it('到点走 createSession，工作区、agent、模型来自这条定时', async () => {
    const ws = await workspace();
    const schedule = await svc.createSchedule({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'sonnet',
      text: '到点开会话',
      runAt: DUE.toISOString(),
    });
    const watch = await watchCreate();
    try {
      const r = await svc.runDue(DUE);
      expect(watch.seen).toEqual([
        {
          workspaceId: ws.id,
          agent: 'claude',
          model: 'sonnet',
          worktree: false,
          text: '到点开会话',
        },
      ]);
      expect(r.fired).toHaveLength(1);
      const sessionId = r.fired[0] ?? '';
      await waitIdle(sessionId);
      const session = await svc.getSession(sessionId);
      expect(session).toMatchObject({ workspaceId: ws.id, agent: 'claude', model: 'sonnet' });
      expect(starts).toBe(1);
      const evs = await readStream(t.db, `session:${sessionId}`, 0, 50);
      expect(JSON.stringify(evs)).toContain('到点开会话');
      const again = await svc.runDue(new Date(DUE.getTime() + 60_000));
      expect(again.fired).toEqual([]);
      expect(watch.seen).toHaveLength(1);
      expect(starts).toBe(1);
      const saved = await getAdeSchedule(t.db, schedule.id);
      expect(saved?.status).toBe('done');
      expect(saved?.sessionId).toBe(sessionId);
    } finally {
      watch.restore();
    }
  });

  it('暂停的到点也不起', async () => {
    const ws = await workspace();
    const schedule = await svc.createSchedule({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'sonnet',
      text: '暂停这条',
      runAt: DUE.toISOString(),
    });
    await svc.pauseSchedule(schedule.id);
    const r = await svc.runDue(DUE);
    expect(r.fired).toEqual([]);
    expect(starts).toBe(0);
    const saved = await getAdeSchedule(t.db, schedule.id);
    expect(saved?.status).toBe('paused');
  });

  it('建会话失败记错误，下一拍不再试', async () => {
    const ws = await workspace();
    const schedule = await svc.createSchedule({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'sonnet',
      text: '会失败',
      runAt: DUE.toISOString(),
    });
    ready = false;
    const r = await svc.runDue(DUE);
    expect(r.fired).toEqual([]);
    expect(starts).toBe(0);
    const saved = await getAdeSchedule(t.db, schedule.id);
    expect(saved?.status).toBe('error');
    expect(saved?.lastError).toContain('现在不能用');
    ready = true;
    const again = await svc.runDue(new Date(DUE.getTime() + 60_000));
    expect(again.fired).toEqual([]);
    expect(starts).toBe(0);
  });

  it('重启时还停在 firing 的改成 error，可以删', async () => {
    const ws = await workspace();
    const schedule = await svc.createSchedule({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'sonnet',
      text: '半道停了',
      runAt: DUE.toISOString(),
    });
    const claimed = await claimAdeSchedule(t.db, schedule.id, DUE);
    expect(claimed?.status).toBe('firing');
    await expect(svc.deleteSchedule(schedule.id)).rejects.toThrow(/正在到点/);
    await svc.recover();
    const saved = await getAdeSchedule(t.db, schedule.id);
    expect(saved?.status).toBe('error');
    await svc.deleteSchedule(schedule.id);
    expect(await getAdeSchedule(t.db, schedule.id)).toBeNull();
    const r = await svc.runDue(DUE);
    expect(r.fired).toEqual([]);
  });

  it('接口能建、暂停、删', async () => {
    const ws = await workspace();
    const created = await api('POST', '/api/ade/schedules', {
      workspaceId: ws.id,
      agent: 'claude',
      model: 'sonnet',
      text: '从接口来',
      runAt: DUE.toISOString(),
    });
    expect(created.status).toBe(201);
    const schedule = created.json?.schedule as { id: string; status: string };
    const list = await api('GET', '/api/ade/schedules');
    const rows = list.json?.schedules as { id: string }[];
    expect(rows.some((row) => row.id === schedule.id)).toBe(true);
    const paused = await api('POST', `/api/ade/schedules/${schedule.id}/pause`, {});
    expect(paused.status).toBe(200);
    expect(paused.json).toMatchObject({ schedule: { status: 'paused' } });
    const removed = await api('DELETE', `/api/ade/schedules/${schedule.id}`);
    expect(removed.status).toBe(204);
    expect(await getAdeSchedule(t.db, schedule.id)).toBeNull();
  });
});
