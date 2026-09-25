// codex 插头（直起 codex exec --json）：参数、过程记录解析（真 CLI 对假上游的夹具）、起停与判定（假执行体回放）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../src/codex/args.ts';
import { type CodexRunSpec, codexRunSummary, runCodex } from '../src/codex/run.ts';
import { CodexStreamReader, codexUsageOfThisRun, unwrapShell } from '../src/codex/stream.ts';
import { judgeRun } from '../src/judge.ts';
import type { FilePayload, SayPayload, TestPayload, ToolPayload } from '../src/types.ts';
import { fakeAgent, fixtureLines, fixtureMeta, fixturePath, tempDir } from './helpers.ts';

const NOW = new Date('2026-09-25T00:00:00.000Z');
const THREAD = '01a0d533-b133-7a01-aab9-35f1bd7ef90a';

function readAll(name: string, testCommands?: string[]) {
  const reader = new CodexStreamReader({
    runId: 'r1',
    cwd: fixtureMeta('codex', name).cwd,
    ...(testCommands ? { testCommands } : {}),
    now: () => NOW,
  });
  const events: ProgressEvent[] = [];
  for (const line of fixtureLines('codex', name)) events.push(...reader.read(line).events);
  const of = <T>(kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload as T);
  return { summary: reader.summary(), of };
}

describe('codex 参数', () => {
  it('新会话：exec --json -C 树 -m 模型 …，提示词给 - 从 stdin 读', () => {
    expect(
      buildCodexArgs({ model: 'gpt-5.6-luna', session: { mode: 'new' }, cwd: '/w', bypassSandbox: true }),
    ).toEqual([
      'exec',
      '--json',
      '-C',
      '/w',
      '-m',
      'gpt-5.6-luna',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ]);
  });

  it('续会话：exec resume（不认 -C、-s），会话号放在 - 前面；不放开就用 workspace-write', () => {
    expect(
      buildCodexArgs({
        model: 'gpt-5.6-luna',
        session: { mode: 'resume', id: THREAD },
        cwd: '/w',
        bypassSandbox: false,
        config: { model_provider: '"relay"' },
      }),
    ).toEqual([
      'exec',
      'resume',
      '--json',
      '-m',
      'gpt-5.6-luna',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'model_provider="relay"',
      THREAD,
      '-',
    ]);
  });

  it('拒掉不合法的模型名、会话号、-c 键', () => {
    const base = { session: { mode: 'new' as const }, cwd: '/w', bypassSandbox: true };
    expect(() => buildCodexArgs({ ...base, model: 'gpt 5' })).toThrow('模型名');
    expect(() => buildCodexArgs({ ...base, model: 'm', session: { mode: 'resume', id: 'last' } })).toThrow(
      'UUID',
    );
    expect(() => buildCodexArgs({ ...base, model: 'm', config: { 'Bad Key': '1' } })).toThrow('-c');
  });
});

describe('codex 过程记录', () => {
  it('改文件、提交、跑挂一条命令：说的话、工具起止、改文件、测试、累计用量', () => {
    const { summary, of } = readAll('cx-edit', ['git commit']);
    expect(summary.sessionId).toBe(THREAD);
    expect(of<SayPayload>('say').map((s) => s.text)).toEqual(['先列计划，再改文件并提交。', '好了']);
    const ends = of<ToolPayload>('tool').filter((t) => t.phase === 'end');
    expect(ends.map((t) => [t.name, t.action, t.ok, t.summary])).toEqual([
      ['apply_patch', 'edit', true, 'notes.md（update）'],
      ['exec_command', 'run', true, 'git add -A && git commit -m "codex: 追加一行"'],
      ['exec_command', 'run', false, 'ls missing-dir'],
    ]);
    expect(ends[2]?.error).toBe("退出码 2：ls: cannot access 'missing-dir': No such file or directory");
    expect(of<FilePayload>('file')).toEqual([{ path: 'notes.md', tool: 'apply_patch' }]);
    expect(of<TestPayload>('test')).toEqual([
      { command: 'git add -A && git commit -m "codex: 追加一行"', passed: true },
    ]);
    expect(summary.turn).toEqual({
      ok: true,
      sessionUsage: {
        inputTokens: 4010,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 0,
        outputTokens: 210,
        reasoningOutputTokens: 40,
      },
    });
    expect(summary).toMatchObject({ toolCalls: 3, toolErrors: 1, unknownFrames: {}, unknownItems: {} });
  });

  it('续会话：同一个 thread，usage 是整个会话的累计值', () => {
    const { summary } = readAll('cx-resume');
    expect(summary.sessionId).toBe(THREAD);
    expect(summary.turn?.sessionUsage?.inputTokens).toBe(5011);
  });

  it('本轮用量：新会话就是累计值（去掉命中缓存的输入）；续会话按上一轮求差', () => {
    const first = readAll('cx-edit').summary.turn?.sessionUsage;
    const second = readAll('cx-resume').summary.turn?.sessionUsage;
    expect(codexUsageOfThisRun(first)).toEqual({
      inputTokens: 3210,
      cacheReadTokens: 800,
      outputTokens: 210,
      reasoningTokens: 40,
    });
    expect(codexUsageOfThisRun(second, first)).toEqual({
      inputTokens: 801,
      cacheReadTokens: 200,
      outputTokens: 51,
      reasoningTokens: 10,
    });
    // 上一轮的读数缺了字段：那个字段就是没查成，不当 0 减
    expect(codexUsageOfThisRun(second, { outputTokens: 210 })).toEqual({ outputTokens: 51 });
    expect(codexUsageOfThisRun(undefined)).toBeUndefined();
  });

  it('上游 401：先重连 5 次，再报错、turn.failed', () => {
    const { summary } = readAll('cx-401');
    expect(summary.reconnects).toBe(5);
    expect(summary.errors).toHaveLength(6);
    expect(summary.turn).toEqual({ ok: false, error: expect.stringContaining('401 Unauthorized') });
  });

  it('拆掉 bash -lc 的包装', () => {
    expect(unwrapShell('/bin/bash -lc \'git commit -m "x"\'')).toBe('git commit -m "x"');
    expect(unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell('pnpm test')).toBe('pnpm test');
  });

  it('turn.completed 不带 usage：用量没查成，不记成 0', () => {
    const reader = new CodexStreamReader({ runId: 'r1', cwd: '/w' });
    reader.read(JSON.stringify({ type: 'turn.completed' }));
    expect(reader.summary().turn).toEqual({ ok: true });
  });
});

describe('codex 起停', () => {
  const spec = (cwd: string, extra: Partial<CodexRunSpec> = {}): CodexRunSpec => ({
    runId: 'run-x1',
    cwd,
    prompt: '在 notes.md 末尾追加一行',
    model: 'gpt-5.6-luna',
    session: { mode: 'new' },
    bypassSandbox: true,
    env: {
      base: { PATH: process.env.PATH ?? '', HOME: cwd, OPENAI_API_KEY: 'x' },
      fleetApi: 'http://127.0.0.1:9',
      fleetToken: 't',
      extra: { CODEX_HOME: join(cwd, '.codex-pool') },
    },
    testCommands: ['git commit'],
    allowMetered: true,
    ...extra,
  });

  it('调用方没显式允许按量计费：拒起，一个进程都不起', async () => {
    const out = tempDir();
    const command = fakeAgent({ replay: fixturePath('codex', 'cx-edit'), stdinTo: join(out, 'stdin') });
    const { allowMetered: _, ...notAllowed } = spec(tempDir());
    await expect(runCodex(notAllowed, { command })).rejects.toThrow('codex 不直起');
    await expect(runCodex({ ...notAllowed, allowMetered: false }, { command })).rejects.toThrow(
      'allowMetered: true',
    );
    expect(existsSync(join(out, 'stdin'))).toBe(false);
  });

  it('回放真跑记录：参数、stdin、CODEX_HOME、摘要', async () => {
    const out = tempDir();
    const cwd = tempDir();
    const command = fakeAgent({
      replay: fixturePath('codex', 'cx-edit'),
      stdinTo: join(out, 'stdin'),
      argvTo: join(out, 'argv'),
      envTo: join(out, 'env'),
    });
    const report = await runCodex(spec(cwd), { command });
    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('在 notes.md 末尾追加一行');
    expect(JSON.parse(readFileSync(join(out, 'argv'), 'utf8'))).toEqual(
      buildCodexArgs({ model: 'gpt-5.6-luna', session: { mode: 'new' }, cwd, bypassSandbox: true }),
    );
    const env = JSON.parse(readFileSync(join(out, 'env'), 'utf8')) as Record<string, string>;
    expect(env.CODEX_HOME).toBe(join(cwd, '.codex-pool'));
    // 基础环境是白名单：宿主的 key 不会被顺手带进去
    expect(env.OPENAI_API_KEY).toBeUndefined();
    const summary = codexRunSummary(report);
    expect(summary).toMatchObject({ sessionId: THREAD, usage: { inputTokens: 3210, outputTokens: 210 } });
    expect(judgeRun(summary.facts)).toMatchObject({ outcome: 'ok', reason: 'answered' });
  });

  it('续跑没给上一轮的用量：不带用量（不把累计值当本轮的记）', async () => {
    const report = await runCodex(spec(tempDir(), { session: { mode: 'resume', id: THREAD } }), {
      command: fakeAgent({ replay: fixturePath('codex', 'cx-resume') }),
    });
    expect(codexRunSummary(report).usage).toEqual({});
  });

  it('续会话回来的 thread 不是原来那个：当场停', async () => {
    const report = await runCodex(
      spec(tempDir(), { session: { mode: 'resume', id: '11111111-2222-4333-8444-555555555555' } }),
      {
        command: fakeAgent({ replay: fixturePath('codex', 'cx-resume'), lineDelayMs: 50, after: 'hang' }),
      },
    );
    expect(report.killed?.reason).toBe('session_mismatch');
  });

  it('上游一直报错后 turn.failed：判执行体报错，原因带原文', async () => {
    const report = await runCodex(spec(tempDir()), {
      command: fakeAgent({ replay: fixturePath('codex', 'cx-401'), exitCode: 1 }),
    });
    const verdict = judgeRun(codexRunSummary(report).facts);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'agent_error' });
    expect(verdict.detail).toContain('401 Unauthorized');
  });

  it('额度用完：判额度用满', async () => {
    const report = await runCodex(spec(tempDir()), {
      command: fakeAgent({
        stderr: 'ERROR: You exceeded your current quota, please check your plan and billing details.',
        exitCode: 1,
      }),
    });
    expect(judgeRun(codexRunSummary(report).facts).reason).toBe('quota_exhausted');
  });
});
