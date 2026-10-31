// Claude Code 工人槽位：起止事件进 fleet2.events、会话号先登记、令牌不进命令行、影子自检缺一不起、工人环境没有凭据。
// 用假执行体（fake-claude.mjs），真 reclaude 的八种情况在法国真机跑（#3775）。
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/claude-code.ts';
import { buildWorkerEnv, ForbiddenEnvError } from '../src/env.ts';
import { mcpConfigJson } from '../src/mcp-config.ts';
import { type ProbeResult, ShadowSelfCheckError, shadowSelfCheck } from '../src/shadow.ts';
import { runClaudeWorker, type WorkerTurn } from '../src/slot.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
// 假令牌现拼：源码里不留像令牌的字面量
const TOKEN = `tok-${'x9'.repeat(16)}`;
let t: TestDb;
let tmpRoot: string;
let n = 0;

beforeAll(async () => {
  t = await createTestDb();
  tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-slot-test-'));
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate fleet2.events restart identity');
});

function turn(over: Partial<WorkerTurn> = {}): WorkerTurn {
  return {
    db: t.db,
    runId: `slot-${process.pid}-${++n}`,
    command: [process.execPath, FAKE],
    model: 'claude-opus-5-5',
    permissionMode: 'bypassPermissions',
    prompt: '改一行',
    cwd: process.cwd(),
    mcp: { url: 'http://127.0.0.1:4799/mcp', token: TOKEN },
    budget: { startupMs: 2_000, totalMs: 10_000, killGraceMs: 200 },
    hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, GH_TOKEN: 'leak', HOME: '/h' },
    tmpRoot,
    ...over,
  };
}

const pass = async (): Promise<ProbeResult> => 'pass';

describe('起一轮工人', () => {
  it('起之前记 worker.spawned（带会话号），跑完记 worker.settled；临时目录删掉', async () => {
    const tr = turn();
    const { sessionId, result } = await runClaudeWorker(tr);
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBeUndefined();
    expect(result.sessionId).toBe(sessionId);
    const events = await readStream(t.db, `worker:${tr.runId}`, 0);
    expect(events.map((e) => e.type)).toEqual(['worker.spawned', 'worker.settled']);
    expect(events[0]?.payload).toMatchObject({
      sessionId,
      sessionMode: 'new',
      model: 'claude-opus-5-5',
      shadow: false,
    });
    expect(events[1]?.payload).toMatchObject({ sessionId, exitCode: 0, killed: null });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('续会话：起来的会话号对不上就判冲突、停掉，结局写进 worker.settled', async () => {
    const tr = turn({
      resumeSessionId: '11111111-1111-4111-8111-111111111111',
      extraEnv: { FAKE_MODE: 'other-session' },
    });
    const { result } = await runClaudeWorker(tr);
    expect(result.killed?.reason).toBe('session_conflict');
    const events = await readStream(t.db, `worker:${tr.runId}`, 0);
    expect(events[0]?.payload).toMatchObject({
      sessionMode: 'resume',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    expect(events[1]?.payload).toMatchObject({ killed: { reason: 'session_conflict' } });
  });

  it('只吐 init 不动：起步时限到判无进展', async () => {
    const tr = turn({
      extraEnv: { FAKE_MODE: 'hang' },
      budget: { startupMs: 300, totalMs: 10_000, killGraceMs: 200 },
    });
    const { result } = await runClaudeWorker(tr);
    expect(result.killed?.reason).toBe('no_progress');
  });
});

describe('令牌和凭据（H1、SEC2 的工人这一侧）', () => {
  it('令牌只进 MCP 配置文件，不进命令行；地址带查询参数拒', () => {
    const args = buildClaudeArgs({
      model: 'claude-opus-5-5',
      session: { mode: 'new', id: '22222222-2222-4222-8222-222222222222' },
      permissionMode: 'bypassPermissions',
      mcpConfigPath: '/tmp/x/mcp.json',
    });
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(args).toContain('--strict-mcp-config');
    expect(mcpConfigJson({ url: 'http://h/mcp', token: TOKEN })).toContain(TOKEN);
    expect(() => mcpConfigJson({ url: 'http://h/mcp?token=x', token: TOKEN })).toThrow('查询参数');
  });

  it('工人环境只抄白名单：宿主的 GH_TOKEN 不带过去；额外变量里塞凭据当场拒', () => {
    const env = buildWorkerEnv({ base: { PATH: '/bin', GH_TOKEN: 'x', HOME: '/h' }, tmpDir: '/tmp/w' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', TMPDIR: '/tmp/w', TEMP: '/tmp/w', TMP: '/tmp/w' });
    expect(() => buildWorkerEnv({ base: {}, tmpDir: '/t', extra: { GITHUB_TOKEN: 'x' } })).toThrow(
      ForbiddenEnvError,
    );
    expect(() => buildWorkerEnv({ base: {}, tmpDir: '/t', extra: { OPENAI_API_KEY: 'x' } })).toThrow(
      ForbiddenEnvError,
    );
  });
});

describe('影子自检：缺一不起', () => {
  it('三样都过才起', async () => {
    expect(
      await shadowSelfCheck({ noWriteAccess: pass, realHandlersAbsent: pass, egressRulesPresent: pass }),
    ).toEqual({
      ok: true,
    });
  });

  it.each([
    ['noWriteAccess', 'fail'],
    ['realHandlersAbsent', 'fail'],
    ['egressRulesPresent', 'unknown'],
  ] as const)('%s 是 %s：不起工人、不记事件', async (probe, outcome) => {
    const probes = {
      noWriteAccess: pass,
      realHandlersAbsent: pass,
      egressRulesPresent: pass,
      [probe]: async () => outcome,
    };
    const tr = turn({ shadow: probes });
    await expect(runClaudeWorker(tr)).rejects.toBeInstanceOf(ShadowSelfCheckError);
    expect(await readStream(t.db, `worker:${tr.runId}`, 0)).toEqual([]);
  });

  it('探测本身抛错按没查成，不当成过', async () => {
    const r = await shadowSelfCheck({
      noWriteAccess: async () => {
        throw new Error('gh 连不上');
      },
      realHandlersAbsent: pass,
      egressRulesPresent: pass,
    });
    expect(r).toEqual({ ok: false, why: ['只读探测（工人对 GitHub 没有写权限）：没查成（gh 连不上）'] });
  });

  it('自检过了的影子工人照常跑，事件里标影子', async () => {
    const tr = turn({ shadow: { noWriteAccess: pass, realHandlersAbsent: pass, egressRulesPresent: pass } });
    await runClaudeWorker(tr);
    const [spawned] = await readStream(t.db, `worker:${tr.runId}`, 0);
    expect(spawned?.payload).toMatchObject({ shadow: true });
    expect(existsSync(tmpRoot)).toBe(true);
  });
});
