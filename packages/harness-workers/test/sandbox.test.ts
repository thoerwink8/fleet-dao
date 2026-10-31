// 工人以会话用户跑（#3814）：runClaudeWorker 带 sandbox 的收尾顺序——MCP 配置写好再交出去、先收 scope 再按回执删、
// 收不干净照实记（脱敏）、交不出去不起工人。sandbox 用内存实现；经 sudo 调帮手的真实现在 harness-dispatch 测。
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdoptedDir, WorkerSandbox } from '../src/sandbox.ts';
import { runClaudeWorker, type WorkerTurn } from '../src/slot.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const TOKEN = `tok-${'q7'.repeat(16)}`;
let t: TestDb;
let root: string;
let n = 0;

beforeAll(async () => {
  t = await createTestDb();
  root = await mkdtemp(join(tmpdir(), 'fleet2-sandbox-test-'));
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

describe('runClaudeWorker 带 sandbox', () => {
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
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});
