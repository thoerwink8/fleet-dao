// 起停测试：用假执行体回放真跑夹具，或故意卡住、留子进程，看插头怎么喂提示词、判超时、杀进程、交报告。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type ClaudeCodeRunSpec,
  judgeClaudeRun,
  MIN_CLAUDE_VERSION,
  runClaudeCode,
} from '../src/claude-code/run.ts';
import { DEFAULT_PROCESS_LIMITS } from '../src/process.ts';
import type { ToolPayload } from '../src/types.ts';
import { fakeAgent, fixtureInit, fixtureLines, fixturePath, pidAlive, tempDir } from './helpers.ts';

const onPosix = process.platform !== 'win32';
const readText = (file: string) => readFileSync(file, 'utf8');

/** 被杀的孙进程要等 init 收尸才从进程表消失，轮询一会儿。 */
async function waitGone(pid: number, ms = 3_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

function spec(fixture: string, over: Partial<ClaudeCodeRunSpec> = {}): ClaudeCodeRunSpec {
  return {
    runId: 'run-7',
    cwd: tempDir(),
    prompt: '把 notes.md 里的「TODO: 写测试」改成「DONE: 写测试」',
    model: 'claude-haiku-4-5',
    session: { mode: 'new', id: fixtureInit(fixture).sessionId },
    permissionMode: 'bypassPermissions',
    env: { base: process.env, fleetApi: 'http://127.0.0.1:7070', fleetToken: 'tok-7' },
    limits: { startupMs: 10_000, wallClockMs: 20_000, killGraceMs: 300 },
    ...over,
  };
}

// 每个用例都起真进程；Windows 开发机并行跑时起一个 node 就要几百毫秒，超时给宽
describe('runClaudeCode', { timeout: 30_000 }, () => {
  it('提示词只走 stdin 且喂完就关；参数、环境按约定；进度事件边跑边吐；报告里有终帧', async () => {
    const dir = tempDir();
    const files = { stdinTo: join(dir, 'stdin'), argvTo: join(dir, 'argv'), envTo: join(dir, 'env') };
    const events: ProgressEvent[] = [];
    const s = spec('cc-haiku-edit');
    const report = await runClaudeCode(s, {
      command: fakeAgent({
        ...files,
        stderr: 'Syncing config…',
        replay: fixturePath('claude-code', 'cc-haiku-edit'),
      }),
      onEvent: (e) => events.push(e),
    });

    expect(readText(files.stdinTo)).toBe(s.prompt);
    const argv = JSON.parse(readText(files.argvTo)) as string[];
    expect(argv.join('\n')).not.toContain('notes.md');
    expect(argv).toContain('--session-id');
    const env = JSON.parse(readText(files.envTo)) as Record<string, string>;
    expect(env.FLEET_API).toBe('http://127.0.0.1:7070');
    expect(env.FLEET_TOKEN).toBe('tok-7');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(Object.keys(env).filter((k) => /^ANTHROPIC_|_PROXY$/i.test(k))).toEqual([]);

    expect(events.map((e) => e.kind)).toEqual(['tool', 'tool', 'tool', 'tool', 'file', 'say']);
    expect(report.exitCode).toBe(0);
    expect(report.killed).toBeUndefined();
    expect(report.stderrTail).toContain('Syncing config…');
    expect(report.stream.result?.isError).toBe(false);
    expect(report.lines).toBe(fixtureLines('claude-code', 'cc-haiku-edit').length);
    expect(judgeClaudeRun(report)).toEqual({ outcome: 'ok', reason: 'answered', detail: '正常结束' });
  });

  it('实际回话的模型不是点名的那个：读到第一条真实回复就停', async () => {
    const report = await runClaudeCode(spec('cc-haiku-edit', { model: 'claude-opus-5-5' }), {
      command: fakeAgent({
        replay: fixturePath('claude-code', 'cc-haiku-edit'),
        lineDelayMs: 30,
        after: 'hang',
      }),
    });
    expect(report.killed?.reason).toBe('model_mismatch');
    expect(report.stream.observedModel).toBe('claude-haiku-4-5-20251001');
    expect(judgeClaudeRun(report).reason).toBe('model_mismatch');
  });

  it('续会话却回来一个别的会话号：停', async () => {
    const report = await runClaudeCode(
      spec('cc-haiku-resume-b', { session: { mode: 'resume', id: '00000000-0000-4000-8000-000000000000' } }),
      { command: fakeAgent({ replay: fixturePath('claude-code', 'cc-haiku-resume-b'), after: 'hang' }) },
    );
    expect(report.killed?.reason).toBe('session_mismatch');
  });

  it('命令行版本低于要求：停', async () => {
    const report = await runClaudeCode(spec('cc-haiku-read'), {
      command: fakeAgent({ replay: fixturePath('claude-code', 'cc-haiku-read'), after: 'hang' }),
      minCliVersion: '2.1.999',
    });
    expect(report.killed?.reason).toBe('cli_too_old');
    expect(MIN_CLAUDE_VERSION).toBe('2.1.277');
  });

  it('起动预算默认不少于 180 秒；只有 stderr 在打「Syncing config…」时不判失败、不重发提示词', async () => {
    expect(DEFAULT_PROCESS_LIMITS.startupMs).toBeGreaterThanOrEqual(180_000);
    const dir = tempDir();
    const report = await runClaudeCode(
      spec('cc-haiku-read', { limits: { startupMs: 5_000, killGraceMs: 300 } }),
      {
        command: fakeAgent({
          stdinTo: join(dir, 'stdin'),
          stderr: 'Syncing config…',
          firstLineDelayMs: 500,
          replay: fixturePath('claude-code', 'cc-haiku-read'),
        }),
      },
    );
    expect(report.killed).toBeUndefined();
    expect(report.firstLineMs).toBeGreaterThanOrEqual(400);
    expect(judgeClaudeRun(report).outcome).toBe('ok');
  });

  it('迟迟没有第一帧：按起动超时杀掉', async () => {
    const report = await runClaudeCode(
      spec('cc-haiku-read', { limits: { startupMs: 300, killGraceMs: 300 } }),
      {
        command: fakeAgent({ stderr: 'Syncing config…', after: 'hang' }),
      },
    );
    expect(report.killed?.reason).toBe('startup_timeout');
    expect(report.firstLineMs).toBeUndefined();
    expect(report.wallMs).toBeLessThan(5_000);
    expect(judgeClaudeRun(report)).toMatchObject({ outcome: 'failed', reason: 'startup_timeout' });
  });

  it('总时长到顶：连同子进程一起杀掉，判超时而不是 0', async () => {
    const pidFile = join(tempDir(), 'child.pid');
    const report = await runClaudeCode(
      spec('cc-haiku-read', { limits: { startupMs: 10_000, wallClockMs: 3_000, killGraceMs: 300 } }),
      {
        command: fakeAgent({
          replay: fixturePath('claude-code', 'cc-haiku-read'),
          replayLines: 3,
          after: 'hang-with-child',
          childPidTo: pidFile,
        }),
      },
    );
    expect(report.killed?.reason).toBe('wall_clock_timeout');
    expect(report.firstLineMs).toBeDefined();
    expect(await waitGone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    expect(judgeClaudeRun(report)).toMatchObject({ outcome: 'failed', reason: 'wall_clock_timeout' });
  });

  it('没有工具在跑却长时间没动静：判停滞', async () => {
    const report = await runClaudeCode(
      spec('cc-haiku-read', { limits: { startupMs: 5_000, idleMs: 300, killGraceMs: 300 } }),
      {
        command: fakeAgent({
          replay: fixturePath('claude-code', 'cc-haiku-read'),
          replayLines: 4,
          after: 'hang',
        }),
      },
    );
    expect(report.killed?.reason).toBe('idle_timeout');
    expect(judgeClaudeRun(report).outcome).toBe('stalled');
  });

  it('有工具在跑（比如一轮长测试）时不算停滞', async () => {
    // 前 5 行停在 Read 的 tool_use 上、结果还没回来
    const report = await runClaudeCode(
      spec('cc-haiku-read', {
        limits: { startupMs: 10_000, idleMs: 300, wallClockMs: 3_000, killGraceMs: 300 },
      }),
      {
        command: fakeAgent({
          replay: fixturePath('claude-code', 'cc-haiku-read'),
          replayLines: 5,
          after: 'hang',
        }),
      },
    );
    expect(report.killed?.reason).toBe('wall_clock_timeout');
    expect(report.lines).toBe(5);
  });

  it('引擎叫停：停掉进程，判 stopped', async () => {
    const controller = new AbortController();
    // 前 5 行里第一个进度事件是读工具开始；收到它就叫停
    const report = await runClaudeCode(spec('cc-haiku-read'), {
      command: fakeAgent({
        replay: fixturePath('claude-code', 'cc-haiku-read'),
        replayLines: 5,
        after: 'hang',
      }),
      signal: controller.signal,
      onEvent: () => controller.abort(),
    });
    expect(report.killed?.reason).toBe('aborted');
    expect(judgeClaudeRun(report).outcome).toBe('stopped');
  });

  it('起之前就已叫停：不起进程', async () => {
    const controller = new AbortController();
    controller.abort();
    const dir = tempDir();
    const report = await runClaudeCode(spec('cc-haiku-read'), {
      command: fakeAgent({ stdinTo: join(dir, 'stdin') }),
      signal: controller.signal,
    });
    expect(report.killed?.reason).toBe('aborted');
    expect(report.lines).toBe(0);
  });

  it.skipIf(!onPosix)('不理 SIGTERM 的进程，宽限期过后 SIGKILL', async () => {
    const report = await runClaudeCode(
      spec('cc-haiku-read', { limits: { startupMs: 10_000, wallClockMs: 3_000, killGraceMs: 300 } }),
      {
        command: fakeAgent({
          replay: fixturePath('claude-code', 'cc-haiku-read'),
          replayLines: 3,
          after: 'hang',
          ignoreSigterm: true,
        }),
      },
    );
    expect(report.killed?.reason).toBe('wall_clock_timeout');
    expect(report.signal).toBe('SIGKILL');
  });

  it.skipIf(!onPosix)('主进程退了、子进程还握着输出：收掉子进程，照常交报告', async () => {
    const pidFile = join(tempDir(), 'child.pid');
    const report = await runClaudeCode(spec('cc-haiku-read'), {
      command: fakeAgent({
        replay: fixturePath('claude-code', 'cc-haiku-read'),
        after: 'exit-leaving-child',
        childPidTo: pidFile,
      }),
    });
    expect(report.stragglers).toBe(true);
    expect(await waitGone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
    expect(report.wallMs).toBeLessThan(5_000);
    expect(judgeClaudeRun(report).outcome).toBe('ok');
  });

  it('模型不存在：退出码 1、终帧报错，判执行体出错并写明原因', async () => {
    const report = await runClaudeCode(spec('cc-bad-model', { model: 'claude-nonexistent-0' }), {
      command: fakeAgent({ replay: fixturePath('claude-code', 'cc-bad-model'), exitCode: 1 }),
    });
    const verdict = judgeClaudeRun(report);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'agent_error' });
    expect(verdict.detail).toContain('model_not_found');
    expect(verdict.detail).toContain('HTTP 404');
  });

  it('进程退出却没有终帧：判没交代结果', async () => {
    const lines = fixtureLines('claude-code', 'cc-haiku-read');
    const truncated = join(tempDir(), 'truncated.ndjson');
    writeFileSync(truncated, `${lines.slice(0, -1).join('\n')}\n`);
    const report = await runClaudeCode(spec('cc-haiku-read'), { command: fakeAgent({ replay: truncated }) });
    expect(judgeClaudeRun(report)).toMatchObject({ outcome: 'failed', reason: 'no_result' });
  });

  it('命令不存在：交报告说进程没起来，不抛', async () => {
    const report = await runClaudeCode(spec('cc-haiku-read'), {
      command: [join(tempDir(), 'no-such-binary')],
    });
    expect(report.spawnError).toBeTruthy();
    expect(judgeClaudeRun(report).reason).toBe('spawn_failed');
  });

  it('进度回调抛错不打断解析，记在 hookError 里', async () => {
    const seen: string[] = [];
    const report = await runClaudeCode(spec('cc-haiku-edit'), {
      command: fakeAgent({ replay: fixturePath('claude-code', 'cc-haiku-edit') }),
      onEvent: (e) => {
        seen.push(e.kind);
        if (e.kind === 'file') throw new Error('写库失败');
      },
    });
    expect(seen).toContain('say');
    expect(report.hookError).toBe('写库失败');
    expect(report.stream.result?.isError).toBe(false);
  });

  it('起之前就拒：单元测试里起真执行体、环境里带上游改写、工作目录不存在、提示词为空', async () => {
    await expect(
      runClaudeCode(spec('cc-haiku-read'), { command: ['/usr/local/bin/reclaude'] }),
    ).rejects.toThrow('测试里不许起真的执行体');
    const withUpstream = spec('cc-haiku-read', {
      env: { base: {}, fleetApi: 'a', fleetToken: 'b', extra: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } },
    });
    await expect(runClaudeCode(withUpstream, { command: fakeAgent({}) })).rejects.toThrow(
      'ANTHROPIC_BASE_URL',
    );
    await expect(
      runClaudeCode(spec('cc-haiku-read', { cwd: join(tempDir(), 'missing') }), { command: fakeAgent({}) }),
    ).rejects.toThrow('工作目录不存在');
    await expect(
      runClaudeCode(spec('cc-haiku-read', { prompt: '  ' }), { command: fakeAgent({}) }),
    ).rejects.toThrow('提示词是空的');
  });

  it('额度读数边跑边交出去', async () => {
    const readings: unknown[] = [];
    await runClaudeCode(spec('cc-haiku-read'), {
      command: fakeAgent({ replay: fixturePath('claude-code', 'cc-haiku-read') }),
      onRateLimit: (r) => readings.push(r),
    });
    expect(readings).toHaveLength(1);
  });

  it('工具事件里带着工具名和白话摘要，驾驶舱直播直接能用', async () => {
    const events: ProgressEvent[] = [];
    await runClaudeCode(spec('cc-haiku-bash'), {
      command: fakeAgent({ replay: fixturePath('claude-code', 'cc-haiku-bash') }),
      onEvent: (e) => events.push(e),
    });
    const start = events.find((e) => e.kind === 'tool')?.payload as ToolPayload;
    expect(start).toMatchObject({ tool: 'Bash', action: 'run', summary: 'ls -1 && git status --short' });
  });
});
