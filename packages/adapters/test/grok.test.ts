// Grok 命令行插头：参数、过程记录解析（真跑夹具）、起停与判定（假执行体回放夹具）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { buildGrokArgs, grokModelMatches } from '../src/grok/args.ts';
import { type GrokRunSpec, grokRunSummary, runGrok } from '../src/grok/run.ts';
import { GrokStreamReader } from '../src/grok/stream.ts';
import { judgeRun } from '../src/judge.ts';
import type { FilePayload, PlanPayload, SayPayload, TestPayload, ToolPayload } from '../src/types.ts';
import { fakeAgent, fixtureLines, fixtureMeta, fixturePath, tempDir } from './helpers.ts';

const NOW = new Date('2026-09-25T00:00:00.000Z');
const SESSION = '9cd315bc-0a1d-4025-8c11-e693d43ec1fb';

function readAll(name: string, testCommands?: string[]) {
  const reader = new GrokStreamReader({
    runId: 'r1',
    cwd: fixtureMeta('grok', name).cwd,
    ...(testCommands ? { testCommands } : {}),
    now: () => NOW,
  });
  const events: ProgressEvent[] = [];
  for (const line of fixtureLines('grok', name)) events.push(...reader.read(line).events);
  events.push(...reader.flush());
  const of = <T>(kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload as T);
  return { summary: reader.summary(), events, of };
}

describe('grok 参数', () => {
  it('新会话用我们的 UUID，提示词从 /dev/stdin 读，旗标都在前面', () => {
    const args = buildGrokArgs({
      model: 'grok-4.7',
      session: { mode: 'new', id: SESSION },
      cwd: '/w',
      alwaysApprove: true,
    });
    expect(args).toEqual([
      '--prompt-file',
      '/dev/stdin',
      '--output-format',
      'streaming-json',
      '--always-approve',
      '-m',
      'grok-4.7',
      '--cwd',
      '/w',
      '-s',
      SESSION,
    ]);
    // GK-03：不用子命令，旗标放在子命令后面会报 unexpected argument
    expect(args[0]?.startsWith('-')).toBe(true);
  });

  it('续会话用 -r；effort、轮数上限、提示词文件可选', () => {
    const args = buildGrokArgs({
      model: 'grok-4.7',
      session: { mode: 'resume', id: SESSION },
      cwd: '/w',
      alwaysApprove: false,
      reasoningEffort: 'high',
      maxTurns: 20,
      promptFile: '/tmp/p.txt',
    });
    expect(args).not.toContain('--always-approve');
    expect(args.slice(0, 2)).toEqual(['--prompt-file', '/tmp/p.txt']);
    expect(args.slice(-6)).toEqual(['-r', SESSION, '--reasoning-effort', 'high', '--max-turns', '20']);
  });

  it('拒掉不合法的模型名、会话号、effort、轮数', () => {
    const base = {
      model: 'grok-4.7',
      session: { mode: 'new' as const, id: SESSION },
      cwd: '/w',
      alwaysApprove: true,
    };
    expect(() => buildGrokArgs({ ...base, model: 'grok 4.7' })).toThrow('模型名');
    expect(() => buildGrokArgs({ ...base, session: { mode: 'new', id: 'abc' } })).toThrow('UUID');
    expect(() => buildGrokArgs({ ...base, reasoningEffort: 'high; rm' })).toThrow('effort');
    expect(() => buildGrokArgs({ ...base, maxTurns: 0 })).toThrow('max turns');
  });

  it('模型核对：带渠道后缀算同一个，换代不算', () => {
    expect(grokModelMatches('grok-4.7', 'grok-4.7-build')).toBe(true);
    expect(grokModelMatches('grok-4.7', 'grok-4.7')).toBe(true);
    expect(grokModelMatches('grok-4.6', 'grok-4.7-build')).toBe(false);
    expect(grokModelMatches('grok-4', 'grok-4.7-build')).toBe(false);
  });
});

describe('grok 过程记录', () => {
  it('改文件并提交：增量拼成整句、工具起止、改文件、终帧', () => {
    const { summary, of } = readAll('grok-edit-commit', ['git commit']);
    expect(of<SayPayload>('say').map((s) => s.text)).toEqual([
      '我先看 `notes.md` 和仓库状态，再按你的要求追加那一行并提交。',
      '好了',
    ]);
    const ends = of<ToolPayload>('tool').filter((t) => t.phase === 'end');
    expect(ends.map((t) => [t.name, t.action, t.ok])).toEqual([
      ['list_dir', 'search', true],
      ['read_file', 'read', true],
      // grep 没匹配时 exit_code=1，不算失败
      ['grep', 'search', true],
      ['search_replace', 'edit', true],
      ['run_terminal_command', 'run', true],
    ]);
    expect(of<FilePayload>('file')).toEqual([{ path: 'notes.md', tool: 'search_replace' }]);
    expect(of<TestPayload>('test')).toEqual([
      { command: 'git add -A && git commit -m "grok: 追加一行"', passed: true },
    ]);
    expect(summary.end).toEqual({
      stopReason: 'end_turn',
      sessionId: SESSION,
      numTurns: 4,
      costUsd: 0.04253468,
      usage: {
        inputTokens: 42438,
        outputTokens: 955,
        cacheReadTokens: 68992,
        cacheWriteTokens: 0,
        reasoningTokens: 766,
      },
      models: ['grok-4.7-build'],
    });
    expect(summary.unknownFrames).toEqual({});
    expect(summary.errors).toEqual([]);
  });

  it('待办清单：plan 帧是整张单子，状态换成 fleet 的写法', () => {
    const { summary, of } = readAll('grok-plan');
    const plans = of<PlanPayload>('plan');
    expect(plans).toHaveLength(4);
    expect(plans[0]?.steps.map((s) => s.state)).toEqual(['in_progress', 'pending', 'pending']);
    expect(plans.at(-1)?.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(summary.plan?.[1]?.title).toBe('把 hello.txt 第二行改成 third line');
    expect(of<FilePayload>('file')).toEqual([{ path: 'hello.txt', tool: 'search_replace' }]);
  });

  it('命令里用 ; 接了 echo：测试结果记未知', () => {
    const { of } = readAll('grok-bash-fail', ['ls missing-dir']);
    expect(of<TestPayload>('test')).toEqual([
      { command: 'ls missing-dir; echo "EXIT_CODE:$?"', unknownBecause: '带 ;，退出码是最后一条命令的' },
    ]);
  });

  it('续会话：终帧回同一个会话号，花费只算这一轮', () => {
    const { summary } = readAll('grok-resume');
    expect(summary.end?.sessionId).toBe(SESSION);
    expect(summary.end?.costUsd).toBe(0.00494564);
  });

  it('终帧不带用量、不带花费：不记成 0', () => {
    const reader = new GrokStreamReader({ runId: 'r1', cwd: '/w', now: () => NOW });
    reader.read(
      JSON.stringify({
        type: 'end',
        stopReason: 'end_turn',
        sessionId: SESSION,
        usage: { output_tokens: 3 },
      }),
    );
    expect(reader.summary().end).toEqual({
      stopReason: 'end_turn',
      sessionId: SESSION,
      usage: { outputTokens: 3 },
      models: [],
    });
  });

  it('命令失败、error 帧、认不出的帧：记原因、计数', () => {
    const reader = new GrokStreamReader({ runId: 'r1', cwd: '/w', now: () => NOW });
    reader.read(
      JSON.stringify({
        type: 'tool_call',
        toolCallId: 't1',
        kind: 'execute',
        toolName: 'run_terminal_command',
        rawInput: { command: 'pnpm check' },
      }),
    );
    const end = reader.read(
      JSON.stringify({
        type: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        rawOutput: { type: 'Bash', exit_code: 1, output_for_prompt: 'exit: 1\nboom' },
      }),
    );
    expect(end.events[0]?.payload).toMatchObject({ ok: false, error: '退出码 1：exit: 1\nboom' });
    reader.read(JSON.stringify({ type: 'error', message: "Couldn't start session: 403" }));
    reader.read(JSON.stringify({ type: 'brand_new' }));
    reader.read('not json');
    expect(reader.summary()).toMatchObject({
      toolErrors: 1,
      errors: ["Couldn't start session: 403"],
      unknownFrames: { brand_new: 1 },
      nonJsonLines: 1,
    });
  });
});

describe('grok 起停', () => {
  const spec = (cwd: string, extra: Partial<GrokRunSpec> = {}): GrokRunSpec => ({
    runId: 'run-g1',
    cwd,
    prompt: '在 notes.md 末尾追加一行',
    model: 'grok-4.7',
    session: { mode: 'new', id: SESSION },
    alwaysApprove: true,
    env: {
      base: { PATH: process.env.PATH ?? '', HOME: cwd },
      fleetApi: 'http://127.0.0.1:9',
      fleetToken: 't',
    },
    testCommands: ['git commit'],
    ...extra,
  });

  it('回放真跑记录：参数、stdin、关自动更新、摘要', async () => {
    const out = tempDir();
    const cwd = tempDir();
    const command = fakeAgent({
      replay: fixturePath('grok', 'grok-edit-commit'),
      stdinTo: join(out, 'stdin'),
      argvTo: join(out, 'argv'),
      envTo: join(out, 'env'),
    });
    const kinds: string[] = [];
    const report = await runGrok(spec(cwd), { command, onEvent: (e) => void kinds.push(e.kind) });
    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('在 notes.md 末尾追加一行');
    expect(JSON.parse(readFileSync(join(out, 'argv'), 'utf8'))).toEqual(
      buildGrokArgs({ model: 'grok-4.7', session: { mode: 'new', id: SESSION }, cwd, alwaysApprove: true }),
    );
    expect(
      (JSON.parse(readFileSync(join(out, 'env'), 'utf8')) as Record<string, string>).GROK_DISABLE_AUTOUPDATER,
    ).toBe('1');
    expect(kinds.filter((k) => k === 'say')).toHaveLength(2);
    const summary = grokRunSummary(report);
    expect(summary).toMatchObject({
      actualModel: 'grok-4.7-build',
      sessionId: SESSION,
      usage: { inputTokens: 42438, outputTokens: 955, costUsd: 0.04253468 },
    });
    expect(judgeRun(summary.facts)).toMatchObject({ outcome: 'ok', reason: 'answered' });
  });

  it.skipIf(process.platform === 'win32')(
    'grok 读 /dev/stdin 要真管道：Node 给的 stdin 是 socketpair（VPS 实跑报 ENXIO），前面垫一个 cat',
    async () => {
      const out = tempDir();
      const cursorKind = join(out, 'cursor-kind');
      const grokKind = join(out, 'grok-kind');
      await runGrok(spec(tempDir()), {
        command: fakeAgent({
          replay: fixturePath('grok', 'grok-resume'),
          stdinKindTo: grokKind,
          stdinTo: join(out, 'in'),
        }),
      });
      expect(readFileSync(grokKind, 'utf8')).toBe('fifo');
      expect(readFileSync(join(out, 'in'), 'utf8')).toBe('在 notes.md 末尾追加一行');
      // 对照：不垫的话（给了提示词文件）stdin 就是 Node 的 socketpair
      await runGrok(spec(tempDir(), { promptFile: '/tmp/unused-prompt' }), {
        command: fakeAgent({ replay: fixturePath('grok', 'grok-resume'), stdinKindTo: cursorKind }),
      });
      expect(readFileSync(cursorKind, 'utf8')).toBe('socket');
    },
  );

  it('终帧回的会话号不是我们起的：判续会话没续上', async () => {
    const report = await runGrok(
      spec(tempDir(), { session: { mode: 'resume', id: '11111111-2222-4333-8444-555555555555' } }),
      {
        command: fakeAgent({ replay: fixturePath('grok', 'grok-resume') }),
      },
    );
    expect(judgeRun(grokRunSummary(report).facts)).toMatchObject({
      outcome: 'failed',
      reason: 'session_mismatch',
    });
  });

  it('点名 4.6、实际回 4.7：判模型不符', async () => {
    const report = await runGrok(spec(tempDir(), { model: 'grok-4.6' }), {
      command: fakeAgent({ replay: fixturePath('grok', 'grok-edit-commit') }),
    });
    const verdict = judgeRun(grokRunSummary(report).facts);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'model_mismatch' });
    expect(verdict.detail).toContain('grok-4.7-build');
  });

  it('半路断了：没有终帧；攒着的最后一句话也交出去', async () => {
    const lines = fixtureLines('grok', 'grok-edit-commit');
    const cutAt = lines.findIndex((l) => l.includes('"type":"text"')) + 5;
    const kinds: ProgressEvent[] = [];
    const report = await runGrok(spec(tempDir()), {
      command: fakeAgent({ replay: fixturePath('grok', 'grok-edit-commit'), replayLines: cutAt }),
      onEvent: (e) => void kinds.push(e),
    });
    expect(kinds.map((e) => e.kind)).toEqual(['say']);
    expect(judgeRun(grokRunSummary(report).facts).reason).toBe('no_result');
  });

  it('额度用完（402 / 要订阅）：判额度用满', async () => {
    const report = await runGrok(spec(tempDir()), {
      command: fakeAgent({
        stderr: '403 You have run out of credits or need a Grok subscription',
        exitCode: 1,
      }),
    });
    expect(judgeRun(grokRunSummary(report).facts).reason).toBe('quota_exhausted');
  });
});
