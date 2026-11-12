// #3925：本机账号文件起进程、额度用尽换下一个、不读法国的路由表。
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { accountExhaustedReason } from '@fleet-dao/adapters/judge';
import type { HostProcess, HostSpawnSpec, ProcessHost } from '@fleet-dao/harness-runner';
import { readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyAccounts, loadAccounts, saveAccounts } from '../src/ade/accounts.ts';
import { claudeAccount, emailField } from '../src/ade/agents.ts';
import { formatQuota } from '../src/ade/quota-view.ts';
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

describe('用尽判定和额度显示', () => {
  it('退出非 0 且像额度用尽才换；「not your usage limit」不算', () => {
    expect(accountExhaustedReason("You've hit your usage limit", 1)).toBe('quota_exhausted');
    expect(accountExhaustedReason('This is not your usage limit', 1)).toBeNull();
    expect(accountExhaustedReason('Your quota is exhausted. API key status: exceeded', 0)).toBe(
      'relay_quota_exhausted',
    );
    expect(accountExhaustedReason('你好', 0)).toBeNull();
  });

  it('没有 used、limit、utilization 就不显示，不补 0', () => {
    expect(formatQuota([])).toBeNull();
    expect(formatQuota([{ label: '7d', unit: 'points', used: 1, limit: 2 }])).toBe('7d 1/2');
    expect(formatQuota([{ label: '7d', unit: 'points' }])).toBeNull();
  });

  it('认得出的额度字段写成短中文，认不出的留原名', () => {
    expect(
      formatQuota([
        { label: 'weekly_all', unit: 'percent', used: 31, limit: 100 },
        { label: 'weekly_scoped:fable', unit: 'percent', used: 28, limit: 100 },
      ]),
    ).toBe('本周全部 31% · 本周 Fable 28%');
    expect(formatQuota([{ label: 'new_bucket', unit: 'percent', used: 4, limit: 100 }])).toBe(
      'new_bucket 4%',
    );
  });

  it('账号只认名叫 email 的字段', () => {
    expect(claudeAccount('{"loggedIn":true,"email":"a@b.c"}')).toBe('a@b.c');
    expect(emailField({ token: 'secret', profile: { email: 'g@x.ai' } })).toBe('g@x.ai');
    expect(emailField({ token: 'a@b.c' })).toBeNull();
  });

  it('账号文件不收下 channels、pools、routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet2-acc-'));
    try {
      writeFileSync(
        join(dir, 'accounts.json'),
        JSON.stringify({
          agent: 'claude',
          tier: 'low',
          channels: [{ id: 'x' }],
          pools: [{ id: 'y' }],
          routes: [{ id: 'z' }],
          accounts: {},
          active: {},
          relays: [],
        }),
      );
      const loaded = await loadAccounts(dir);
      expect(Object.keys(loaded).sort()).toEqual(['accounts', 'active', 'agent', 'relays', 'tier']);
      expect(JSON.stringify(loaded)).not.toMatch(/channels|pools|routes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('额度用尽换下一个账号', () => {
  const specs: HostSpawnSpec[] = [];
  let n = 0;
  const host: ProcessHost = {
    kind: 'local',
    start(spec) {
      specs.push(spec);
      const proc = new ScriptProc();
      const which = n++;
      queueMicrotask(() => {
        if (proc.ended) return;
        if (which === 0) {
          proc.stdout.write("You've hit your usage limit\n");
          proc.finish(1, null);
        } else {
          proc.say('你好');
        }
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
    root = mkdtempSync(join(tmpdir(), 'fleet2-acc-'));
    const file = emptyAccounts();
    file.tier = 'low';
    file.accounts.claude = [
      { id: 'a1', label: '一', env: { FLEET_ACCOUNT: 'one' } },
      { id: 'a2', label: '二', env: { FLEET_ACCOUNT: 'two' } },
    ];
    file.active.claude = 'a1';
    file.relays = [
      {
        id: 'r1',
        name: '测',
        baseUrl: 'http://127.0.0.1:9/v1',
        key: 'local-test-key',
        models: ['sonnet'],
      },
    ];
    await saveAccounts(root, file);
    svc = new AdeService({
      db: t.db,
      dataDir: root,
      host,
      env: { PATH: '' },
      flushMs: 20,
      agents: async () => [{ id: 'claude', resume: true, models: ['sonnet', 'sonnet:low'], ready: true }],
    });
  }, 60_000);

  afterAll(async () => {
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

  it('按账号文件起进程，假额度用尽后换 a2，数据目录没有法国的表', async () => {
    const dir = mkdtempSync(join(root, 'ws-'));
    const ws = await svc.addWorkspace('试', dir);
    const s = await svc.createSession({
      workspaceId: ws.id,
      agent: 'claude',
      model: 'relay.r1.sonnet',
      worktree: false,
      text: '你好',
    });
    await waitIdle(s.id);
    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.command[0]).toBe('reclaude');
      expect(spec.command).toContain('sonnet:low');
      expect(spec.command).not.toContain('relay.r1.sonnet');
      expect(spec.env.OPENAI_BASE_URL).toBe('http://127.0.0.1:9/v1');
      expect(spec.env.OPENAI_API_KEY).toBe('local-test-key');
      expect(spec.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9/v1');
      expect(spec.env.ANTHROPIC_API_KEY).toBe('local-test-key');
      expect(spec.env.FLEET2_TIER).toBe('low');
    }
    expect(specs[0]?.env.FLEET_ACCOUNT).toBe('one');
    expect(specs[1]?.env.FLEET_ACCOUNT).toBe('two');

    const saved = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(['accounts', 'active', 'agent', 'relays', 'tier']);
    expect((saved.active as { claude: string }).claude).toBe('a2');
    const names = readdirSync(root);
    expect(names.some((name) => /^(channels|pools|routes)(\.|$)/.test(name))).toBe(false);

    const evs = await readStream(t.db, `session:${s.id}`, 0, 50);
    const settled = evs.filter((e) => e.type === 'session.turn.settled');
    expect(settled.map((e) => (e.payload as { text?: string }).text)).toEqual([
      '额度用尽，换下一个账号',
      '你好',
    ]);

    const adeDir = fileURLToPath(new URL('../src/ade/', import.meta.url));
    const files = walkTs(adeDir);
    const specsFrom = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line) =>
          [...line.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
        ),
    );
    expect(specsFrom.length).toBeGreaterThan(0);
    for (const spec of specsFrom) {
      expect(spec).not.toMatch(/@fleet-dao\/db/);
      expect(spec).not.toMatch(/routing\.default/);
      expect(spec).not.toMatch(/(^|\/)(channels|pools|routes)(\/|$)/);
    }
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}
