// 工人以会话用户跑（#3814）：帮手协议（先问能力、按回执身份删、scope 编号带前缀）和 runClaudeWorker 的收尾顺序。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AdoptedDir, SandboxError, scopeSandbox, type WorkerSandbox } from '../src/sandbox.ts';
import { runClaudeWorker, type WorkerTurn } from '../src/slot.ts';

const HELPER = fileURLToPath(new URL('./fake-scope-helper.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const TOKEN = `tok-${'q7'.repeat(16)}`;
let root: string;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet2-sandbox-test-'));
});

function fake(mode = 'ok') {
  const log = join(root, `log-${++n}.jsonl`);
  const sandbox = scopeSandbox({ sudo: [process.execPath, HELPER, log, mode], helper: 'fleet-agent-scope' });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
      : [];
  return { sandbox, calls };
}

describe('帮手协议', () => {
  it('adopt 先问能力；release 按回执的身份删；stop 的编号带 fleet2- 前缀', async () => {
    const { sandbox, calls } = fake();
    const h = await sandbox.adopt('/var/lib/fleet-work/fleet2/w1');
    await h.release();
    await sandbox.stop('d7-a1');
    expect(calls()).toEqual([
      ['capabilities'],
      ['adopt', '/var/lib/fleet-work/fleet2/w1', '--user', 'fleet-agent-carpool'],
      ['capabilities'],
      ['remove', '/var/lib/fleet-work/fleet2/w1', '--dev', '64769', '--ino', '1234', '--uid', '1001'],
      ['stop', 'fleet2-d7-a1'],
    ]);
  });

  it('旧版帮手（能力不全）不交；回执身份对不上、删的不是原来那个都拒', async () => {
    await expect(fake('old-helper').sandbox.adopt('/var/lib/fleet-work/fleet2/w2')).rejects.toThrow(
      '不支持完整的交树、删树协议',
    );
    await expect(fake('wrong-identity').sandbox.adopt('/var/lib/fleet-work/fleet2/w3')).rejects.toThrow(
      '回执里的目录身份不是',
    );
    const h = await fake('remove-other').sandbox.adopt('/var/lib/fleet-work/fleet2/w4');
    await expect(h.release()).rejects.toThrow('删除回执不是原来交出去的目录');
  });

  it('帮手退出码非 0 带出原因；相对路径、编号不合法不上命令行', async () => {
    await expect(fake('adopt-fails').sandbox.adopt('/var/lib/fleet-work/fleet2/w5')).rejects.toThrow(
      'path outside managed root',
    );
    const { sandbox, calls } = fake();
    await expect(sandbox.adopt('relative/dir')).rejects.toBeInstanceOf(SandboxError);
    await expect(sandbox.stop('x'.repeat(60))).rejects.toThrow('scope 编号不合法');
    expect(calls()).toEqual([]);
  });
});

describe('runClaudeWorker 带 sandbox', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.pg.exec('truncate fleet2.events restart identity');
  });

  /** 记调用顺序的内存 sandbox；release 真删（模拟帮手以 root 删）。 */
  function memory(fail: { stop?: boolean; adopt?: boolean } = {}) {
    const steps: string[] = [];
    const sandbox: WorkerSandbox = {
      async adopt(dir) {
        steps.push(`adopt:${existsSync(join(dir, 'mcp.json')) ? 'mcp-ready' : 'no-mcp'}`);
        if (fail.adopt) throw new Error('交不出去');
        return {
          async release() {
            steps.push('release');
            const { rm } = await import('node:fs/promises');
            await rm(dir, { recursive: true, force: true });
          },
        } satisfies AdoptedDir;
      },
      async stop(runId) {
        steps.push(`stop:${runId}`);
        if (fail.stop) throw new Error(`收不掉 ${TOKEN}`);
      },
    };
    return { sandbox, steps };
  }

  const turn = (sandbox: WorkerSandbox, tmpRoot: string): WorkerTurn => ({
    db: t.db,
    runId: `sb-${process.pid}-${++n}`,
    command: [process.execPath, FAKE],
    model: 'claude-opus-5-5',
    permissionMode: 'bypassPermissions',
    prompt: '改一行',
    cwd: process.cwd(),
    mcp: { url: 'http://127.0.0.1:4799/mcp', token: TOKEN },
    budget: { startupMs: 2_000, totalMs: 10_000, killGraceMs: 200 },
    hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    tmpRoot,
    sandbox,
  });

  it('MCP 配置写好再交出去；跑完先收 scope 再按回执删；记 worker.cleaned', async () => {
    const { sandbox, steps } = memory();
    const tmpRoot = await mkdtemp(join(root, 'run-'));
    const tr = turn(sandbox, tmpRoot);
    const { result } = await runClaudeWorker(tr);
    expect(result.exitCode).toBe(0);
    expect(steps).toEqual(['adopt:mcp-ready', `stop:${tr.runId}`, 'release']);
    const events = await readStream(t.db, `worker:${tr.runId}`, 0);
    expect(events.map((e) => e.type)).toEqual(['worker.spawned', 'worker.settled', 'worker.cleaned']);
    expect(events[2]?.payload).toMatchObject({ ok: true, errors: [] });
  });

  it('收 scope 失败照实记（脱敏）、照样删目录，不抛', async () => {
    const { sandbox, steps } = memory({ stop: true });
    const tmpRoot = await mkdtemp(join(root, 'run-'));
    const tr = turn(sandbox, tmpRoot);
    await runClaudeWorker(tr);
    expect(steps.at(-1)).toBe('release');
    const cleaned = (await readStream(t.db, `worker:${tr.runId}`, 0))[2];
    expect(cleaned?.type).toBe('worker.cleaned');
    expect(cleaned?.payload.ok).toBe(false);
    const errors = cleaned?.payload.errors as string[];
    expect(errors[0]).toContain('收 scope');
    expect(errors.join('')).not.toContain(TOKEN);
  });

  it('交不出去：不起工人、不记事件，目录自己删', async () => {
    const { sandbox, steps } = memory({ adopt: true });
    const tmpRoot = await mkdtemp(join(root, 'run-'));
    const tr = turn(sandbox, tmpRoot);
    await expect(runClaudeWorker(tr)).rejects.toThrow('交不出去');
    expect(steps).toEqual(['adopt:mcp-ready', `stop:${tr.runId}`]);
    expect(await readStream(t.db, `worker:${tr.runId}`, 0)).toEqual([]);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});
