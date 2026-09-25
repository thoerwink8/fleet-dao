// 接口外壳：两种线格式的请求与回包、「读写文件 + 跑命令」循环（假接口、假或真的本机工具）、出错分流、路径关在工作树里。
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { judgeRun } from '../src/judge.ts';
import { type ApiShellSpec, apiShellSummary, classifyHttpError, runApiShell } from '../src/shell/run.ts';
import { createHost, insideTree, SHELL_TOOLS, type ShellHost } from '../src/shell/tools.ts';
import { parseReply, requestFor, type ShellApi } from '../src/shell/wire.ts';
import { tempDir } from './helpers.ts';

const onPosix = process.platform !== 'win32';
const KEY = 'sk-test-not-a-real-key';
const openai: ShellApi = {
  format: 'openai-chat',
  baseUrl: 'https://llm.example/v1/',
  model: 'm-1',
  apiKey: KEY,
};
const anthropic: ShellApi = {
  format: 'anthropic-messages',
  baseUrl: 'https://llm.example',
  model: 'm-2',
  apiKey: KEY,
};

type Scripted = { status?: number; body: unknown; headers?: Record<string, string> };

function fakeFetch(script: Scripted[]) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const step = script[Math.min(requests.length - 1, script.length - 1)] as Scripted;
    return new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: step.headers ?? {},
    });
  }) as typeof fetch;
  return { fn, requests };
}

function memoryHost(
  files: Record<string, string> = {},
): ShellHost & { files: Record<string, string>; commands: string[] } {
  const commands: string[] = [];
  return {
    files,
    commands,
    async readFile(path) {
      const v = files[path];
      if (v === undefined) throw new Error(`没有这个文件：${path}`);
      return v;
    },
    async writeFile(path, content) {
      files[path] = content;
    },
    async run(command) {
      commands.push(command);
      return command.includes('fail')
        ? { exitCode: 1, output: 'boom', timedOut: false }
        : { exitCode: 0, output: '[main abc123] ok', timedOut: false };
    },
  };
}

const oaTool = (id: string, name: string, args: object) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const oaReply = (
  message: object,
  finish: string,
  usage: object = { prompt_tokens: 100, completion_tokens: 10 },
) => ({
  model: 'm-1-2026',
  choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }],
  usage,
});

const spec = (cwd: string, extra: Partial<ApiShellSpec> = {}): ApiShellSpec => ({
  runId: 'run-s1',
  cwd,
  prompt: '在 notes.md 末尾追加一行并提交',
  api: openai,
  env: { base: { PATH: '/usr/bin:/bin', HOME: cwd }, fleetApi: 'http://127.0.0.1:9', fleetToken: 't' },
  testCommands: ['git commit'],
  ...extra,
});

describe('线格式', () => {
  it('OpenAI 兼容：/chat/completions、Bearer、工具写成 function、工具结果按 tool_call_id 接回', () => {
    const req = requestFor(
      openai,
      'sys',
      [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }] },
        { role: 'tool', results: [{ id: 'c1', name: 'read_file', output: 'A', isError: false }] },
      ],
      SHELL_TOOLS,
    );
    expect(req.url).toBe('https://llm.example/v1/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
    ]);
    expect((req.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual([
      'read_file',
      'write_file',
      'run_command',
    ]);
  });

  it('Anthropic：/v1/messages、x-api-key、工具结果放在 user 里的 tool_result', () => {
    const req = requestFor(
      anthropic,
      'sys',
      [
        { role: 'user', text: 'hi' },
        {
          role: 'assistant',
          text: '先看看',
          toolCalls: [{ id: 't1', name: 'run_command', input: { command: 'ls' } }],
        },
        { role: 'tool', results: [{ id: 't1', name: 'run_command', output: 'exit code 1', isError: true }] },
      ],
      SHELL_TOOLS,
    );
    expect(req.url).toBe('https://llm.example/v1/messages');
    expect(req.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
    expect(req.body).toMatchObject({ system: 'sys', max_tokens: 8192 });
    expect((req.body.messages as unknown[])[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'exit code 1', is_error: true }],
    });
    expect((req.body.tools as { input_schema: unknown }[])[0]?.input_schema).toBe(SHELL_TOOLS[0]?.parameters);
  });

  it('回包：两家都解析成说了什么、要调哪些工具、为什么停、用量；认不出就抛', () => {
    expect(
      parseReply(
        'openai-chat',
        oaReply({ content: 'ok', tool_calls: [oaTool('c1', 'read_file', { path: 'a' })] }, 'tool_calls'),
      ),
    ).toEqual({
      text: 'ok',
      toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }],
      stopReason: 'tool_calls',
      model: 'm-1-2026',
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    expect(
      parseReply('anthropic-messages', {
        model: 'm-2',
        content: [
          { type: 'text', text: '好' },
          { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a', content: 'x' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 40 },
      }),
    ).toEqual({
      text: '好',
      toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'a', content: 'x' } }],
      stopReason: 'tool_use',
      model: 'm-2',
      usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 40 },
    });
    expect(() => parseReply('openai-chat', { choices: [] })).toThrow('choices');
    expect(() => parseReply('anthropic-messages', { stop_reason: 'end_turn' })).toThrow('content');
    // 参数不是 JSON：交给工具报参数不对
    const bad = parseReply(
      'openai-chat',
      oaReply(
        { content: '', tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: '{oops' } }] },
        'tool_calls',
      ),
    );
    expect(bad.toolCalls[0]?.input).toEqual({ __unparsed: '{oops' });
    // 回包不带用量：不记成 0
    expect(
      parseReply('openai-chat', { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }).usage,
    ).toEqual({});
  });

  it('OpenAI 的 prompt_tokens 含命中缓存的部分：输入只记没命中的，缓存不算两遍', () => {
    const cachedReply = oaReply({ content: 'ok' }, 'stop', {
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(parseReply('openai-chat', cachedReply).usage).toEqual({
      inputTokens: 200,
      outputTokens: 10,
      cacheReadTokens: 800,
    });
  });

  it('HTTP 错误按下一步动作分', () => {
    expect(classifyHttpError(401, '')).toBe('auth');
    expect(classifyHttpError(402, '')).toBe('quota');
    expect(classifyHttpError(429, '{"error":{"code":"insufficient_quota"}}')).toBe('quota');
    expect(classifyHttpError(429, 'slow down')).toBe('rate_limit');
    expect(classifyHttpError(503, '')).toBe('upstream');
  });
});

describe('循环', () => {
  it('写文件、提交、说完：事件、对话记录、用量累加、摘要', async () => {
    const host = memoryHost({ 'notes.md': '# notes\n' });
    const f = fakeFetch([
      {
        body: oaReply(
          {
            content: '先改再提交',
            tool_calls: [
              oaTool('c1', 'read_file', { path: 'notes.md' }),
              oaTool('c2', 'write_file', { path: 'notes.md', content: '# notes\n- 到此一游\n' }),
            ],
          },
          'tool_calls',
        ),
      },
      {
        body: oaReply(
          {
            content: null,
            tool_calls: [oaTool('c3', 'run_command', { command: 'git add -A && git commit -m x' })],
          },
          'tool_calls',
        ),
      },
      { body: oaReply({ content: '好了' }, 'stop', { prompt_tokens: 300, completion_tokens: 5 }) },
    ]);
    const events: ProgressEvent[] = [];
    const report = await runApiShell(spec(tempDir()), {
      fetch: f.fn,
      host,
      onEvent: (e) => void events.push(e),
    });
    expect(host.files['notes.md']).toBe('# notes\n- 到此一游\n');
    expect(host.commands).toEqual(['git add -A && git commit -m x']);
    expect(events.map((e) => e.kind)).toEqual([
      'say',
      'tool',
      'tool',
      'tool',
      'tool',
      'file',
      'tool',
      'tool',
      'test',
      'say',
    ]);
    expect(report).toMatchObject({
      turns: 3,
      final: { text: '好了', stopReason: 'stop' },
      usage: { inputTokens: 500, outputTokens: 25 },
      toolCalls: 3,
      toolErrors: 0,
      filesChanged: ['notes.md'],
      testRuns: [{ command: 'git add -A && git commit -m x', passed: true }],
    });
    // 第二次请求带着第一轮的工具结果
    const second = f.requests[1]?.body.messages as {
      role: string;
      tool_call_id?: string;
      content?: string;
    }[];
    expect(second.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content])).toEqual([
      ['c1', '# notes\n'],
      ['c2', 'wrote 15 characters to notes.md'],
    ]);
    const summary = apiShellSummary(report);
    expect(summary).toMatchObject({ actualModel: 'm-1-2026', usage: { inputTokens: 500, outputTokens: 25 } });
    expect(judgeRun(summary.facts)).toMatchObject({ outcome: 'ok', reason: 'answered' });
    // 密钥只在请求头里：不进报告
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it('续跑：把上一轮的对话记录带回来，新提示词接在后面', async () => {
    const f = fakeFetch([{ body: oaReply({ content: 'x: 追加一行' }, 'stop') }]);
    const history = [
      { role: 'user' as const, text: '改文件' },
      { role: 'assistant' as const, text: '好了', toolCalls: [] },
    ];
    const report = await runApiShell(spec(tempDir(), { prompt: '提交信息是什么？', history }), {
      fetch: f.fn,
      host: memoryHost(),
    });
    expect(((f.requests[0]?.body.messages ?? []) as { role: string }[]).map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(report.messages).toHaveLength(4);
  });

  it('Anthropic 格式照样跑通', async () => {
    const f = fakeFetch([
      {
        body: {
          model: 'm-2',
          content: [{ type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'make fail' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      },
      {
        body: {
          model: 'm-2',
          content: [{ type: 'text', text: '命令挂了' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 4 },
        },
      },
    ]);
    const report = await runApiShell(spec(tempDir(), { api: anthropic }), {
      fetch: f.fn,
      host: memoryHost(),
    });
    expect(report).toMatchObject({ toolErrors: 1, final: { text: '命令挂了', stopReason: 'end_turn' } });
    const toolResult = ((f.requests[1]?.body.messages ?? []) as { content: { is_error?: boolean }[] }[])[2]
      ?.content[0];
    expect(toolResult?.is_error).toBe(true);
  });

  it('认证失败：不重试，判执行体报错并带上原因', async () => {
    const f = fakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    const report = await runApiShell(spec(tempDir()), { fetch: f.fn, host: memoryHost(), retryBaseMs: 1 });
    expect(f.requests).toHaveLength(1);
    expect(report.error).toMatchObject({ kind: 'auth', status: 401 });
    const verdict = judgeRun(apiShellSummary(report).facts);
    expect(verdict).toMatchObject({ outcome: 'failed', reason: 'no_result' });
    expect(verdict.detail).toContain('auth');
  });

  it('额度用完：判额度用满；限流先按 retry-after 重试', async () => {
    const quota = await runApiShell(spec(tempDir()), {
      fetch: fakeFetch([{ status: 429, body: { error: { code: 'insufficient_quota' } } }]).fn,
      host: memoryHost(),
      retryBaseMs: 1,
    });
    expect(judgeRun(apiShellSummary(quota).facts).reason).toBe('quota_exhausted');
    const f = fakeFetch([
      { status: 429, body: 'slow down', headers: { 'retry-after': '0' } },
      { body: oaReply({ content: '好了' }, 'stop') },
    ]);
    const limited = await runApiShell(spec(tempDir()), { fetch: f.fn, host: memoryHost(), retryBaseMs: 1 });
    expect(f.requests).toHaveLength(2);
    expect(limited.final?.text).toBe('好了');
  });

  it('上游 5xx 重试几次还不行：上游出错', async () => {
    const f = fakeFetch([{ status: 502, body: 'bad gateway' }]);
    const report = await runApiShell(spec(tempDir()), { fetch: f.fn, host: memoryHost(), retryBaseMs: 1 });
    expect(f.requests).toHaveLength(4);
    expect(report.error?.kind).toBe('upstream');
  });

  it('回话被截断、到了轮数上限：都判失败，不当成说完了', async () => {
    const cut = await runApiShell(spec(tempDir()), {
      fetch: fakeFetch([{ body: oaReply({ content: '写到一半' }, 'length') }]).fn,
      host: memoryHost(),
    });
    expect(judgeRun(apiShellSummary(cut).facts)).toMatchObject({
      reason: 'agent_error',
      detail: '回话被截断（length）',
    });
    const loop = await runApiShell(spec(tempDir(), { maxTurns: 2 }), {
      fetch: fakeFetch([
        {
          body: oaReply(
            { content: '', tool_calls: [oaTool('c', 'run_command', { command: 'ls' })] },
            'tool_calls',
          ),
        },
      ]).fn,
      host: memoryHost(),
    });
    expect(loop.maxTurnsReached).toBe(true);
    expect(judgeRun(apiShellSummary(loop).facts).detail).toContain('轮数上限');
  });

  it('引擎叫停：停在下一轮之前，判叫停', async () => {
    const controller = new AbortController();
    const f = fakeFetch([
      {
        body: oaReply(
          { content: '', tool_calls: [oaTool('c', 'run_command', { command: 'ls' })] },
          'tool_calls',
        ),
      },
    ]);
    const host = memoryHost();
    const original = host.run.bind(host);
    host.run = async (c) => {
      controller.abort();
      return original(c);
    };
    const report = await runApiShell(spec(tempDir()), { fetch: f.fn, host, signal: controller.signal });
    expect(report.killed?.reason).toBe('aborted');
    expect(judgeRun(apiShellSummary(report).facts).outcome).toBe('stopped');
  });

  it('引擎叫停：信号传进正在跑的命令，不等它跑完', async () => {
    const controller = new AbortController();
    const f = fakeFetch([
      {
        body: oaReply(
          { content: '', tool_calls: [oaTool('c', 'run_command', { command: 'pnpm test' })] },
          'tool_calls',
        ),
      },
    ]);
    const host = memoryHost();
    host.run = (_c, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () =>
          resolve({ exitCode: null, output: '', timedOut: false, aborted: true }),
        );
      });
    setTimeout(() => controller.abort(), 50);
    const report = await runApiShell(spec(tempDir()), { fetch: f.fn, host, signal: controller.signal });
    expect(report.killed?.reason).toBe('aborted');
    const results = report.messages.find((m) => m.role === 'tool');
    expect(results).toMatchObject({ results: [{ isError: true, output: 'stopped by the engine\n' }] });
  });

  it('测试里不给假 fetch 就不许起', async () => {
    await expect(runApiShell(spec(tempDir()))).rejects.toThrow('测试里不许连真的模型接口');
  });
});

describe('本机工具：关在工作树里', () => {
  it('路径出了工作树一律拒', () => {
    expect(() => insideTree('/w/tree', '../x')).toThrow('出了工作树');
    expect(() => insideTree('/w/tree', '/etc/passwd')).toThrow('出了工作树');
    expect(() => insideTree('/w/tree', '')).toThrow('空');
  });

  it('读写在工作树里、父目录自动建；读不存在的文件回报错', async () => {
    const cwd = tempDir();
    const host = createHost({ cwd, runId: 'r', env: {}, commandTimeoutMs: 5_000, maxOutputChars: 1_000 });
    await host.writeFile('a/b/c.txt', 'hello');
    expect(readFileSync(join(cwd, 'a', 'b', 'c.txt'), 'utf8')).toBe('hello');
    expect(await host.readFile('a/b/c.txt')).toBe('hello');
    await expect(host.readFile('nope.txt')).rejects.toThrow();
  });

  it.skipIf(!onPosix)('符号链接也逃不出工作树', async () => {
    const outside = tempDir();
    writeFileSync(join(outside, 'secret'), 's3cret');
    const cwd = tempDir();
    symlinkSync(outside, join(cwd, 'link'));
    const host = createHost({ cwd, runId: 'r', env: {}, commandTimeoutMs: 5_000, maxOutputChars: 1_000 });
    await expect(host.readFile('link/secret')).rejects.toThrow('符号链接');
    await expect(host.writeFile('link/new', 'x')).rejects.toThrow('符号链接');
  });

  it.skipIf(!onPosix)(
    '跑命令：退出码、输出（尾巴）、超时被杀',
    async () => {
      const cwd = tempDir();
      mkdirSync(join(cwd, 'd'));
      const host = createHost({
        cwd,
        runId: 'r',
        env: { PATH: '/usr/bin:/bin' },
        commandTimeoutMs: 1_500,
        maxOutputChars: 20,
      });
      const ok = await host.run('ls; echo done');
      expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
      expect(ok.output).toContain('done');
      const bad = await host.run('echo oops >&2; exit 3');
      expect(bad).toMatchObject({ exitCode: 3, timedOut: false, output: 'oops' });
      const long = await host.run('seq 1 100');
      expect(long.output.startsWith('…（前面省略')).toBe(true);
      expect(long.output.endsWith('100')).toBe(true);
      const slow = await host.run('sleep 30');
      expect(slow.timedOut).toBe(true);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const t0 = Date.now();
      const stopped = await host.run('sleep 30', controller.signal);
      expect(stopped).toMatchObject({ aborted: true, timedOut: false });
      expect(Date.now() - t0).toBeLessThan(1_400);
    },
    20_000,
  );
});
