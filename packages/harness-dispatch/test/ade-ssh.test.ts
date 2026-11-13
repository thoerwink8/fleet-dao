// #3928：选了远端宿主的会话，ProcessHost 的 launch 是 ssh -T <别名> fleet2-hostd --stdio。
// 配置只有别名、目标和密钥路径。事件和写出的文件不含密钥正文。
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { HostProcess, HostSpawnSpec, ProcessHost } from '@fleet-dao/harness-runner';
import { readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdeError, AdeService } from '../src/ade/service.ts';
import { renderSshConfig, sshHostsPath } from '../src/ade/ssh-hosts.ts';

const h = vi.hoisted(() => ({
  launches: [] as string[][],
  localStarts: 0,
  remoteStarts: 0,
}));

vi.mock('@fleet-dao/harness-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fleet-dao/harness-runner')>();
  const { PassThrough: Pass } = await import('node:stream');
  const remote: ProcessHost = {
    kind: 'hostd',
    start(): HostProcess {
      h.remoteStarts += 1;
      const stdout = new Pass();
      const stderr = new Pass();
      const stdin = new Pass();
      let onExit: ((code: number | null, signal: string | null) => void) | undefined;
      let onClose: (() => void) | undefined;
      queueMicrotask(() => {
        stdout.end();
        onExit?.(0, null);
        onClose?.();
      });
      return {
        pid: 7,
        stdin,
        stdout,
        stderr,
        onError() {},
        onExit(cb: (code: number | null, signal: string | null) => void) {
          onExit = cb;
        },
        onClose(cb: () => void) {
          onClose = cb;
        },
        stop() {},
        async reap() {
          return { found: 0, leftovers: 0 };
        },
      };
    },
    async attach() {
      return false;
    },
  };
  return {
    ...actual,
    remoteHostd(alias: string) {
      h.launches.push([...actual.remoteHostd(alias).launch]);
      return remote;
    },
  };
});

const SENTINEL = 'FLEET2_KEY_BODY_3928_SENTINEL';

function proc(): HostProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let onExit: ((code: number | null, signal: string | null) => void) | undefined;
  let onClose: (() => void) | undefined;
  queueMicrotask(() => {
    stdout.end();
    onExit?.(0, null);
    onClose?.();
  });
  return {
    pid: 3,
    stdin,
    stdout,
    stderr,
    onError() {},
    onExit(cb: (code: number | null, signal: string | null) => void) {
      onExit = cb;
    },
    onClose(cb: () => void) {
      onClose = cb;
    },
    stop() {},
    async reap() {
      return { found: 0, leftovers: 0 };
    },
  };
}

const localHost: ProcessHost = {
  kind: 'local',
  start(_spec: HostSpawnSpec) {
    h.localStarts += 1;
    return proc();
  },
  async attach() {
    return false;
  },
};

function texts(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...texts(p));
    else out.push(readFileSync(p, 'utf8'));
  }
  return out;
}

let t: TestDb;
let root: string;
let sshDir: string;
let svc: AdeService;

beforeAll(async () => {
  t = await createTestDb();
  root = mkdtempSync(join(tmpdir(), 'fleet2-ssh-'));
  sshDir = join(root, 'ssh');
  svc = new AdeService({
    db: t.db,
    dataDir: root,
    host: localHost,
    sshDir,
    flushMs: 20,
    commandFor: () => ['fake'],
    agents: async () => [{ id: 'claude', resume: true, models: ['default'] }],
  });
}, 60_000);

afterAll(async () => {
  await t.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  h.launches.length = 0;
  h.localStarts = 0;
  h.remoteStarts = 0;
});

async function waitIdle(id: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const row = await svc.getSession(id);
    if (row.status === 'idle' && row.runId === null) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('会话没有收回');
}

describe('SSH 宿主（#3928）', () => {
  it('配置只有别名、目标和密钥路径，不认端口转发', async () => {
    await expect(
      svc.addSshHost({ alias: 'desk', target: 'me@127.0.0.1', keyPath: 'k', portForward: '1' }),
    ).rejects.toBeInstanceOf(AdeError);
    await expect(
      svc.addSshHost({ alias: 'desk', target: 'me@127.0.0.1', keyPath: 'k', localForward: '9' }),
    ).rejects.toThrow(/不认/);
    const key = join(root, 'id_ed25519');
    writeFileSync(key, `-----BEGIN OPENSSH PRIVATE KEY-----\n${SENTINEL}\n`);
    const hosts = await svc.addSshHost({ alias: 'desk', target: 'me@127.0.0.1', keyPath: key });
    expect(Object.keys(hosts[0] ?? {}).sort()).toEqual(['alias', 'keyPath', 'target']);
    const saved = JSON.parse(readFileSync(sshHostsPath(root), 'utf8')) as {
      hosts: Record<string, unknown>[];
    };
    expect(Object.keys(saved).sort()).toEqual(['hosts']);
    expect(Object.keys(saved.hosts[0] ?? {}).sort()).toEqual(['alias', 'keyPath', 'target']);
    const config = readFileSync(join(sshDir, 'config'), 'utf8');
    expect(config).toContain('Host desk');
    expect(config).toContain('HostName 127.0.0.1');
    expect(config).toContain('IdentityFile');
    expect(config).not.toMatch(/LocalForward|RemoteForward|DynamicForward|portForward/);
    expect(config).not.toContain(SENTINEL);
    expect(texts(root).join('\n').replaceAll(readFileSync(key, 'utf8'), '')).not.toContain(SENTINEL);
    expect(renderSshConfig([{ alias: 'box', target: 'me@host:2222', keyPath: '/tmp/k' }])).not.toMatch(
      /LocalForward|RemoteForward|DynamicForward/,
    );
    const src = readFileSync(fileURLToPath(new URL('../src/ade/ssh-hosts.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/LocalForward|RemoteForward|DynamicForward|portForward|localForward/);
  });

  it('选了远端宿主就只起 ssh hostd，不另起本机看守', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('远端', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      host: 'desk',
      text: '你好',
    });
    expect(s.hostAlias).toBe('desk');
    expect(h.launches).toEqual([['ssh', '-T', 'desk', 'fleet2-hostd', '--stdio']]);
    expect(h.remoteStarts).toBe(1);
    expect(h.localStarts).toBe(0);
    const evs = await readStream(t.db, `session:${s.id}`, 0, 40);
    const packed = JSON.stringify(evs);
    expect(packed).not.toContain(SENTINEL);
    expect(packed).not.toContain('BEGIN OPENSSH');
    const created = evs.find((e) => e.type === 'session.created');
    expect(created?.payload).toMatchObject({ host: 'desk' });
    expect(created?.payload).not.toHaveProperty('keyPath');
    await waitIdle(s.id);
  });

  it('没选宿主仍用本机 ProcessHost', async () => {
    const dir = mkdtempSync(join(root, 'local-'));
    const ws = await svc.addWorkspace('本机', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'default',
      worktree: false,
      text: '在本机',
    });
    expect(h.localStarts).toBe(1);
    expect(h.remoteStarts).toBe(0);
    expect(h.launches).toEqual([]);
    await waitIdle(s.id);
  });
});
