// cursor-agent 插头：参数、过程记录解析（真跑夹具）、起停与判定（假执行体回放夹具）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { buildCursorArgs } from '../src/cursor/args.ts';
import { type CursorRunSpec, cursorRunSummary, runCursorAgent } from '../src/cursor/run.ts';
import { CursorStreamReader } from '../src/cursor/stream.ts';
import { judgeRun } from '../src/judge.ts';
import type { FilePayload, PlanPayload, SayPayload, TestPayload, ToolPayload } from '../src/types.ts';
import { fakeAgent, fixtureLines, fixtureMeta, fixturePath, tempDir } from './helpers.ts';

const NOW = new Date('2026-09-25T00:00:00.000Z');
const SESSION = 'e06fc62e-72a6-4020-9144-01155dbba6db';

function readAll(name: string, testCommands?: string[]) {
  const reader = new CursorStreamReader({
    runId: 'r1',
    cwd: fixtureMeta('cursor-agent', name).cwd,
    ...(testCommands ? { testCommands } : {}),
    now: () => NOW,
  });
  const events: ProgressEvent[] = [];
  const inits = [];
  for (const line of fixtureLines('cursor-agent', name)) {
    const effect = reader.read(line);
    events.push(...effect.events);
    if (effect.init) inits.push(effect.init);
  }
  const of = <T>(kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload as T);
  return { reader, summary: reader.summary(), events, inits, of };
}

describe('cursor 参数', () => {
  it('新会话：固定带 --trust、工作树、模型；提示词不进参数', () => {
    expect(
      buildCursorArgs({ model: 'auto', session: { mode: 'new' }, workspace: '/w', force: true }),
    ).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--trust',
      '--workspace',
      '/w',
      '--model',
      'auto',
      '--force',
    ]);
  });

  it('续会话带 --resume；不放开权限就不带 --force', () => {
    const args = buildCursorArgs({
      model: 'auto',
      session: { mode: 'resume', id: SESSION },
      workspace: '/w',
      force: false,
    });
    expect(args).not.toContain('--force');
    expect(args.slice(-2)).toEqual(['--resume', SESSION]);
  });

  it('拒掉不像模型名、不是 UUID 的会话号', () => {
    const base = { session: { mode: 'new' as const }, workspace: '/w', force: true };
    expect(() => buildCursorArgs({ ...base, model: 'auto --force' })).toThrow('模型名不合法');
    expect(() =>
      buildCursorArgs({ ...base, model: 'auto', session: { mode: 'resume', id: 'x; rm -rf /' } }),
    ).toThrow('UUID');
  });
});

describe('cursor 过程记录', () => {
  it('改文件并提交：会话号、说的话、命令、终帧用量', () => {
    const { summary, inits, of } = readAll('cursor-edit-commit', ['git commit']);
    expect(inits[0]).toEqual({ sessionId: SESSION, model: 'Auto' });
    expect(of<SayPayload>('say').map((s) => s.text)).toEqual(['先追加那一行，再按你给的信息提交。', '好了']);
    const tools = of<ToolPayload>('tool');
    expect(tools.map((t) => [t.phase, t.name, t.action, t.ok])).toEqual([
      ['start', 'shell', 'run', undefined],
      ['end', 'shell', 'run', true],
    ]);
    expect(tools[0]?.summary).toContain('git commit');
    expect(tools[0]?.description).toBe('Append line and commit changes');
    // && 串起来的命令退出码可信
    expect(of<TestPayload>('test')).toEqual([expect.objectContaining({ passed: true })]);
    expect(summary.result).toMatchObject({
      isError: false,
      subtype: 'success',
      usage: { inputTokens: 12715, outputTokens: 178, cacheReadTokens: 19968, cacheWriteTokens: 0 },
    });
    expect(summary.toolCalls).toBe(1);
    expect(summary.unknownFrames).toEqual({});
    expect(summary.unknownTools).toEqual({});
  });

  it('用编辑工具改、建文件：成功后各发一条改文件，路径相对工作树', () => {
    const { summary, of } = readAll('cursor-edit-tools');
    expect(of<FilePayload>('file')).toEqual([
      { path: 'plan.md', tool: 'edit' },
      { path: 'notes.md', tool: 'edit' },
    ]);
    expect(summary.filesChanged).toEqual(['plan.md', 'notes.md']);
    expect(
      of<ToolPayload>('tool')
        .filter((t) => t.phase === 'end')
        .every((t) => t.ok),
    ).toBe(true);
  });

  it('待办清单：每次更新发一整张单子，状态换成 fleet 的写法', () => {
    const { summary, of } = readAll('cursor-plan');
    const plans = of<PlanPayload>('plan');
    expect(plans).toHaveLength(4);
    expect(plans[0]?.steps).toEqual([
      { title: '读 hello.txt', state: 'in_progress' },
      { title: '把 hello.txt 第二行改成 third line', state: 'pending' },
      { title: '运行 git diff --stat', state: 'pending' },
    ]);
    expect(plans.at(-1)?.steps.every((s) => s.state === 'done')).toBe(true);
    expect(summary.plan).toEqual(plans.at(-1)?.steps);
  });

  it('命令里用 ; 接了 echo：工具报成功，测试结果记未知', () => {
    const { of } = readAll('cursor-bash-fail', ['ls missing-dir']);
    expect(of<ToolPayload>('tool').at(-1)).toMatchObject({
      ok: true,
      summary: 'ls missing-dir; echo EXIT:$?',
    });
    expect(of<TestPayload>('test')).toEqual([
      { command: 'ls missing-dir; echo EXIT:$?', unknownBecause: '带 ;，退出码是最后一条命令的' },
    ]);
  });

  it('续会话回的是同一个会话号', () => {
    const { summary } = readAll('cursor-resume');
    expect(summary.sessionId).toBe(SESSION);
    expect(summary.result?.text).toBe('cursor: 追加一行');
  });

  it('不点模型时 init 回显的是界面名，不是模型 id', () => {
    expect(readAll('cursor-read').summary.initModel).toBe('Grok 4.6 High Fast');
  });

  it('终帧的用量缺字段、没有用量：缺的就不带，不记成 0', () => {
    const reader = new CursorStreamReader({ runId: 'r1', cwd: '/w', now: () => NOW });
    reader.read(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { outputTokens: 7 } }),
    );
    expect(reader.summary().result?.usage).toEqual({ outputTokens: 7 });
    const bare = new CursorStreamReader({ runId: 'r1', cwd: '/w', now: () => NOW });
    bare.read(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
    expect(bare.summary().result).toEqual({ isError: false, subtype: 'success' });
  });

  it('命令退出码不是 0、认不出的工具：记失败原因、按键计数', () => {
    const reader = new CursorStreamReader({ runId: 'r1', cwd: '/w', now: () => NOW });
    const call = (subtype: string, body: object) =>
      JSON.stringify({ type: 'tool_call', subtype, call_id: 'c1', tool_call: body });
    reader.read(call('started', { shellToolCall: { args: { command: 'pnpm check' } } }));
    const end = reader.read(
      call('completed', {
        shellToolCall: {
          args: { command: 'pnpm check' },
          result: { success: { exitCode: 1, stderr: 'boom' } },
        },
      }),
    );
    expect(end.events[0]?.payload).toMatchObject({ ok: false, error: '退出码 1：boom' });
    reader.read(call('started', { brandNewToolCall: { args: {} } }));
    reader.read(
      call('completed', { brandNewToolCall: { args: {}, result: { error: { message: 'nope' } } } }),
    );
    expect(reader.summary()).toMatchObject({ toolErrors: 2, unknownTools: { brandNewToolCall: 2 } });
  });
});

describe('cursor 起停', () => {
  const spec = (cwd: string, extra: Partial<CursorRunSpec> = {}): CursorRunSpec => ({
    runId: 'run-c1',
    cwd,
    prompt: '在 notes.md 末尾追加一行',
    model: 'auto',
    session: { mode: 'new' },
    force: true,
    env: {
      base: { PATH: process.env.PATH ?? '', HOME: cwd, GH_TOKEN: 'x' },
      fleetApi: 'http://127.0.0.1:9',
      fleetToken: 't',
    },
    testCommands: ['git commit'],
    ...extra,
  });

  it('回放真跑记录：参数、stdin、环境、事件、摘要都对得上', async () => {
    const cwd = tempDir();
    const out = tempDir();
    const command = fakeAgent({
      replay: fixturePath('cursor-agent', 'cursor-edit-commit'),
      stdinTo: join(out, 'stdin'),
      argvTo: join(out, 'argv'),
      envTo: join(out, 'env'),
    });
    const events: ProgressEvent[] = [];
    const report = await runCursorAgent(spec(cwd), { command, onEvent: (e) => void events.push(e) });
    expect(readFileSync(join(out, 'stdin'), 'utf8')).toBe('在 notes.md 末尾追加一行');
    const argv = JSON.parse(readFileSync(join(out, 'argv'), 'utf8')) as string[];
    expect(argv).toEqual(
      buildCursorArgs({ model: 'auto', session: { mode: 'new' }, workspace: cwd, force: true }),
    );
    const env = JSON.parse(readFileSync(join(out, 'env'), 'utf8')) as Record<string, string>;
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.FLEET_RUN_ID).toBe('run-c1');
    expect(events.map((e) => e.kind)).toEqual(['say', 'tool', 'tool', 'test', 'say']);
    const summary = cursorRunSummary(report);
    expect(summary).toEqual({
      facts: {
        exitCode: 0,
        signal: null,
        terminal: { isError: false, detail: 'success · 先追加那一行，再按你给的信息提交。好了' },
        quotaExhausted: false,
      },
      sessionId: SESSION,
      usage: { inputTokens: 12715, outputTokens: 178, cacheReadTokens: 19968, cacheWriteTokens: 0 },
    });
    expect(judgeRun(summary.facts)).toMatchObject({ outcome: 'ok', reason: 'answered' });
  });

  it('续会话回来的不是原来那个会话：当场停', async () => {
    const report = await runCursorAgent(
      spec(tempDir(), { session: { mode: 'resume', id: '11111111-2222-4333-8444-555555555555' } }),
      {
        command: fakeAgent({
          replay: fixturePath('cursor-agent', 'cursor-resume'),
          lineDelayMs: 50,
          after: 'hang',
        }),
      },
    );
    expect(report.killed?.reason).toBe('session_mismatch');
    expect(judgeRun(cursorRunSummary(report).facts).reason).toBe('session_mismatch');
  });

  it('只在 stderr 报错就退出：没有终帧，原因带上原文', async () => {
    const report = await runCursorAgent(spec(tempDir()), {
      command: fakeAgent({ stderr: '✗ Failed to reach the Cursor API.', exitCode: 1 }),
    });
    const verdict = judgeRun(cursorRunSummary(report).facts);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'no_result' });
    expect(verdict.detail).toContain('Failed to reach the Cursor API');
  });

  it('stderr 说额度用完：判额度用满，不当成执行体失败', async () => {
    const report = await runCursorAgent(spec(tempDir()), {
      command: fakeAgent({
        stderr: 'Error: You have run out of credits for this billing period',
        exitCode: 1,
      }),
    });
    expect(judgeRun(cursorRunSummary(report).facts).reason).toBe('quota_exhausted');
  });

  it('测试里起真的 cursor-agent 一律拒绝', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'x'), '');
    await expect(runCursorAgent(spec(cwd), { command: ['/usr/local/bin/cursor-agent'] })).rejects.toThrow(
      '测试里不许起真的执行体',
    );
  });
});
