import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_CASES } from '../src/cases/index.ts';
import { type AgentDefinition, parseAgentDefinition } from '../src/definitions.ts';
import {
  buildJudgeArgs,
  buildSessionArgs,
  claudeCommand,
  displayArgs,
  type LaunchRequest,
  type LaunchResult,
  realLauncher,
} from '../src/launcher.ts';
import { OUTPUT_LIMIT, runCase } from '../src/runner.ts';
import { parseStream, StreamFormatError } from '../src/stream.ts';
import type { EvalCase } from '../src/types.ts';
import { REPO_ROOT, UngradableError } from '../src/types.ts';
import { caseDirOf, prepareFixture, type Workspace } from '../src/workspace.ts';

const DEF_TEXT = `---
name: fleet-demo
description: 演示
model: claude-haiku-5-5
maxTurns: 15
tools: Read, Grep, mcp__codegraph__codegraph_explore
---
你是 fleet-demo，只读。
`;
const DEF: AgentDefinition = parseAgentDefinition(DEF_TEXT, 'demo.md');
const DEFS = new Map([['fleet-demo', DEF]]);

/** 录好的 stream-json：一行一个事件，最后一个是 result。 */
function recorded(
  answer: string,
  usage = {
    input_tokens: 120,
    output_tokens: 45,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 200,
  },
) {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
    '(这一行不是 JSON，要被跳过)',
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 4321,
      num_turns: 3,
      result: answer,
      usage,
    }),
  ].join('\n');
}

const ok = (stdout: string): LaunchResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function demoCase(grade: EvalCase['grade']): EvalCase {
  return {
    id: 'demo/one',
    scenario: 'demo',
    name: 'one',
    agent: 'fleet-demo',
    prompt: '题面原文',
    source: { kind: 'fixture' },
    planted: '',
    why: '',
    grade,
  };
}

function fakeWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
  tmpDirs.push(dir);
  return { dir, cleanup: () => {} };
}

describe('parseStream', () => {
  it('读出最终回答、token（输入含缓存）、回合数', () => {
    const s = parseStream(recorded('答案'));
    expect(s).toMatchObject({
      answer: '答案',
      inputTokens: 330,
      outputTokens: 45,
      numTurns: 3,
      isError: false,
    });
  });

  it('没有 result 事件、没有 usage、字段不是数：认不出', () => {
    expect(() => parseStream('')).toThrow(StreamFormatError);
    expect(() => parseStream(JSON.stringify({ type: 'result', result: 'x' }))).toThrow(/usage/);
    expect(() =>
      parseStream(
        JSON.stringify({ type: 'result', result: 'x', usage: { input_tokens: 'a', output_tokens: 1 } }),
      ),
    ).toThrow(/input_tokens/);
    expect(() =>
      parseStream(
        JSON.stringify({ type: 'result', result: 5, usage: { input_tokens: 1, output_tokens: 1 } }),
      ),
    ).toThrow(/result 不是字符串/);
  });

  it('会话自己报错：isError 为真', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    expect(parseStream(line)).toMatchObject({ isError: true, subtype: 'error_during_execution' });
  });
});

describe('起会话的参数', () => {
  it('被测会话：完整 id、去掉 mcp__ 的工具、定义正文当附加系统提示，没有提示词（走 stdin）', () => {
    expect(buildSessionArgs(DEF, 'claude-sonnet-5-5')).toEqual([
      '-p',
      '--model',
      'claude-sonnet-5-5',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Read,Grep',
      '--append-system-prompt',
      '你是 fleet-demo，只读。',
    ]);
  });

  it('裁判会话固定 claude-sonnet-5-5，不给工具', () => {
    const a = buildJudgeArgs();
    expect(a.slice(0, 3)).toEqual(['-p', '--model', 'claude-sonnet-5-5']);
    expect(a).not.toContain('--allowedTools');
  });

  it('dry-run 显示时正文换成字数', () => {
    expect(displayArgs(buildSessionArgs(DEF, 'claude-haiku-5-5')).join(' ')).toContain(
      `<定义正文 ${DEF.body.length} 字>`,
    );
  });

  it('命令和本机工人起 Claude 的是同一个（worker-lib.mjs 里写的 reclaude）', () => {
    const lib = readFileSync(
      join(REPO_ROOT, 'agents', 'skills', 'commander', 'scripts', 'worker-lib.mjs'),
      'utf8',
    );
    expect(lib).toContain(`command: '${claudeCommand({})}'`);
    expect(claudeCommand({ AGENT_EVAL_CLAUDE: 'claude' })).toBe('claude');
  });
});

describe('runCase：注入假的起会话函数', () => {
  it('过：结果记对（题、场景、子代理、模型、理由、用时、token、提示词、产出）', async () => {
    const ws = fakeWorkspace();
    let seen: LaunchRequest | undefined;
    let clock = 1000;
    const r = await runCase(
      demoCase(async (ctx) => ({ pass: ctx.answer === '答案', reason: '对上了' })),
      'haiku',
      {
        defs: DEFS,
        command: 'reclaude',
        prepare: () => ws,
        now: () => (clock += 2500),
        launch: async (req) => {
          seen = req;
          return ok(recorded('答案'));
        },
      },
    );
    expect(r).toMatchObject({
      caseId: 'demo/one',
      scenario: 'demo',
      agent: 'fleet-demo',
      model: 'haiku',
      modelId: 'claude-haiku-5-5',
      status: 'pass',
      pass: true,
      reason: '对上了',
      durationMs: 2500,
      inputTokens: 330,
      outputTokens: 45,
      numTurns: 3,
      maxTurns: 15,
      turnBudget: 15,
      prompt: '题面原文',
      output: '答案',
      outputTruncated: false,
      judgeUsed: false,
    });
    expect(seen).toMatchObject({ command: 'reclaude', stdin: '题面原文', cwd: ws.dir, timeoutMs: 600_000 });
    expect(seen?.args).toContain('claude-haiku-5-5');
  });

  it('没写 maxTurns 的子代理：回合预算记 40', async () => {
    const def = parseAgentDefinition(DEF_TEXT.replace('maxTurns: 15\n', ''), 'demo.md');
    const r = await runCase(
      demoCase(async () => ({ pass: true, reason: '' })),
      'opus',
      {
        defs: new Map([['fleet-demo', def]]),
        command: 'reclaude',
        prepare: fakeWorkspace,
        launch: async () => ok(recorded('x')),
      },
    );
    expect(r).toMatchObject({ maxTurns: null, turnBudget: 40, modelId: 'claude-opus-5-5' });
  });

  it('没过：记没过和理由，不是没跑成', async () => {
    const r = await runCase(
      demoCase(async () => ({ pass: false, reason: '答错了' })),
      'sonnet',
      {
        defs: DEFS,
        command: 'reclaude',
        prepare: fakeWorkspace,
        launch: async () => ok(recorded('错的')),
      },
    );
    expect(r).toMatchObject({ status: 'fail', pass: false, reason: '答错了' });
  });

  const base = { defs: DEFS, command: 'reclaude', prepare: fakeWorkspace };
  const grade = demoCase(async () => ({ pass: true, reason: '' }));

  it('起不来：没跑成，不当过也不当没过', async () => {
    const r = await runCase(grade, 'haiku', {
      ...base,
      launch: async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: 'spawn reclaude ENOENT',
      }),
    });
    expect(r).toMatchObject({ status: 'not-run', pass: null });
    expect(r.reason).toContain('ENOENT');
  });

  it('超时：没跑成', async () => {
    const r = await runCase(grade, 'haiku', {
      ...base,
      launch: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
    });
    expect(r).toMatchObject({ status: 'not-run', pass: null });
    expect(r.reason).toContain('10 分钟');
  });

  it('输出认不出：没跑成，理由带 stderr 尾部', async () => {
    const r = await runCase(grade, 'haiku', {
      ...base,
      launch: async () => ({ exitCode: 1, stdout: 'garbage', stderr: 'login required', timedOut: false }),
    });
    expect(r).toMatchObject({ status: 'not-run', pass: null });
    expect(r.reason).toContain('login required');
  });

  it('会话自己报错：没跑成', async () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 5, output_tokens: 0 },
    });
    const r = await runCase(grade, 'haiku', { ...base, launch: async () => ok(line) });
    expect(r).toMatchObject({ status: 'not-run', pass: null, inputTokens: 5 });
  });

  it('判分自己判不了：没跑成', async () => {
    const r = await runCase(
      demoCase(async () => {
        throw new UngradableError('夹具读不到');
      }),
      'haiku',
      { ...base, launch: async () => ok(recorded('x')) },
    );
    expect(r).toMatchObject({ status: 'not-run', pass: null });
    expect(r.reason).toContain('夹具读不到');
  });

  it('没有这个子代理的定义、备目录失败：没跑成', async () => {
    expect(
      await runCase({ ...grade, agent: 'fleet-nope' }, 'haiku', { ...base, launch: async () => ok('') }),
    ).toMatchObject({ status: 'not-run' });
    const r = await runCase(grade, 'haiku', {
      defs: DEFS,
      command: 'reclaude',
      prepare: () => {
        throw new Error('磁盘满了');
      },
      launch: async () => ok(''),
    });
    expect(r.reason).toContain('磁盘满了');
  });

  it('产出超过 2 万字截断并标出', async () => {
    const r = await runCase(grade, 'haiku', {
      ...base,
      launch: async () => ok(recorded('字'.repeat(25_000))),
    });
    expect(r.outputTruncated).toBe(true);
    expect(r.output.startsWith('字'.repeat(OUTPUT_LIMIT))).toBe(true);
    expect(r.output).toContain('已截断');
  });

  it('LLM 打分的题：判分里调用裁判，记 judgeUsed', async () => {
    const launches: string[][] = [];
    const r = await runCase(
      demoCase(async (ctx) => {
        const text = await ctx.judge('评一下');
        return { pass: text === '0.9', reason: '裁判说', score: 0.9 };
      }),
      'opus',
      {
        ...base,
        launch: async (req) => {
          launches.push(req.args);
          return ok(recorded(req.stdin === '评一下' ? '0.9' : '方案'));
        },
      },
    );
    expect(launches).toHaveLength(2);
    expect(launches[1]?.slice(0, 3)).toEqual(['-p', '--model', 'claude-sonnet-5-5']);
    expect(r).toMatchObject({ status: 'pass', score: 0.9, judgeUsed: true });
  });
});

describe('真题 + 假会话（会话在临时目录里把活干了）', () => {
  const fixer = ALL_CASES.find((c) => c.id === 'fixer/format-bytes') as EvalCase;
  const defs = new Map([
    [
      'fleet-fixer',
      parseAgentDefinition(
        readFileSync(join(REPO_ROOT, '.claude', 'agents', 'fleet-fixer.md'), 'utf8'),
        'fixer.md',
      ),
    ],
  ]);

  it('干对了：夹具拷进临时目录、会话改了文件、判分在同一个目录里跑测试转绿 → 过；用完目录删掉', async () => {
    let dir = '';
    const r = await runCase(fixer, 'haiku', {
      defs,
      command: 'reclaude',
      launch: async (req) => {
        dir = req.cwd;
        expect(req.cwd.startsWith(tmpdir())).toBe(true);
        expect(req.cwd.startsWith(REPO_ROOT)).toBe(false);
        cpSync(join(caseDirOf(fixer), 'hidden', 'fix', 'src'), join(req.cwd, 'src'), { recursive: true });
        return ok(recorded('改好了'));
      },
    });
    expect(r.status).toBe('pass');
    expect(() => readFileSync(join(dir, 'package.json'))).toThrow();
  });

  it('什么都没干：测试还是红 → 没过', async () => {
    const r = await runCase(fixer, 'haiku', {
      defs,
      command: 'reclaude',
      launch: async () => ok(recorded('不会')),
    });
    expect(r.status).toBe('fail');
    expect(r.reason).toContain('测试没转绿');
  });

  it('临时目录里没有标准答案', () => {
    const ws = prepareFixture(fixer);
    try {
      expect(() => readFileSync(join(ws.dir, 'hidden', 'extra.test.ts'))).toThrow();
      expect(() => readFileSync(join(ws.dir, 'extra.test.ts'))).toThrow();
    } finally {
      ws.cleanup();
    }
  });
});

describe('realLauncher（起一个 node 子进程当假会话）', () => {
  const req = (code: string, stdin = '', timeoutMs = 20_000): LaunchRequest => ({
    command: process.execPath,
    args: ['-e', code],
    stdin,
    cwd: tmpdir(),
    timeoutMs,
  });

  it('提示词走 stdin，stdout 收回来', async () => {
    const r = await realLauncher(req('process.stdin.pipe(process.stdout)', '你好 stdin'));
    expect(r).toMatchObject({ exitCode: 0, stdout: '你好 stdin', timedOut: false });
  });

  it('超过限时被杀，标 timedOut', async () => {
    const r = await realLauncher(req('setTimeout(() => {}, 60000)', '', 400));
    expect(r.timedOut).toBe(true);
  });

  it('命令不存在：spawnError', async () => {
    const r = await realLauncher({ ...req(''), command: 'agent-eval-no-such-command-xyz' });
    expect(r.spawnError).toBeTruthy();
  });
});
