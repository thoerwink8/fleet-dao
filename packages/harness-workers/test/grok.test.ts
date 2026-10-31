// Grok 壳（#3842）：参数、每轮的 grok-home 配置、判帧、过程拆成和 Claude 同一套 transcript.* 事件，槽位按 shell 换壳。
// 用假执行体（fake-grok.mjs）回放 fixtures/grok-sample.jsonl（形状照旧引擎法国真跑的 grok 记录）；真 grok 在法国真机跑。
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGrokLine, makeRedactor } from '@fleet-dao/harness-runner';
import { readStream } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGrokArgs, grokConfigToml, grokEnv } from '../src/grok.ts';
import { runClaudeWorker } from '../src/slot.ts';
import { GrokTranscriptParser } from '../src/transcript.ts';

const FAKE = fileURLToPath(new URL('./fake-grok.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/grok-sample.jsonl', import.meta.url));
const TOKEN = `tok-${'g7'.repeat(16)}`;
const SID = '9cd315bc-0a1d-4025-8c11-e693d43ec1fb';
const sampleLines = () =>
  readFileSync(SAMPLE, 'utf8')
    .split('__SID__')
    .join(SID)
    .split('__TOKEN__')
    .join(TOKEN)
    .split('\n')
    .filter((l) => l !== '');

describe('参数和配置', () => {
  const base = {
    model: 'grok-4.7',
    session: { mode: 'new' as const, id: SID },
    cwd: '/w',
    promptFile: '/t/prompt.md',
  };
  it('提示词走文件、会话号用 -s、放开权限才带 --always-approve、总带 --no-plan', () => {
    const args = buildGrokArgs({ ...base, permissionMode: 'bypassPermissions' });
    expect(args.slice(0, 2)).toEqual(['--prompt-file', '/t/prompt.md']);
    expect(args).toContain('--always-approve');
    expect(args).toContain('--no-plan');
    expect(args.slice(-2)).toEqual(['-s', SID]);
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.7');
    // 联网搜索、取网页走 grok 服务端、出网关拦不住，影子工人会搜到已合并的答案：必须关
    const off = args[args.indexOf('--disallowed-tools') + 1]?.split(',') ?? [];
    expect(off).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    expect(buildGrokArgs({ ...base, permissionMode: 'acceptEdits' })).not.toContain('--always-approve');
    expect(
      buildGrokArgs({ ...base, session: { mode: 'resume', id: SID }, permissionMode: 'plan' }),
    ).toContain('-r');
  });
  it('模型名、会话号不合法就拒', () => {
    expect(() => buildGrokArgs({ ...base, model: 'a b', permissionMode: 'plan' })).toThrow();
    expect(() =>
      buildGrokArgs({ ...base, session: { mode: 'new', id: 'x' }, permissionMode: 'plan' }),
    ).toThrow();
  });
  it('config.toml 只挂内核的 MCP，令牌在请求头里；地址带查询参数拒', () => {
    const toml = grokConfigToml({ url: 'http://127.0.0.1:7345/mcp', token: TOKEN });
    expect(toml).toContain('[mcp_servers.fleet]');
    expect(toml).toContain('url = "http://127.0.0.1:7345/mcp"');
    expect(toml).toContain(`"X-Fleet-Session-Token" = "${TOKEN}"`);
    expect(toml).toMatch(/\[features\]\ntelemetry = false/);
    expect(toml).toContain('mixpanel_enabled = false');
    expect(() => grokConfigToml({ url: 'http://h/mcp?token=1', token: TOKEN })).toThrow();
  });
  it('环境：关自动升级、目录信任和反问，GROK_HOME 指到这一轮，登录态要绝对路径', () => {
    expect(grokEnv('/t/grok-home', '/home/u/.grok/auth.json')).toEqual({
      GROK_DISABLE_AUTOUPDATER: '1',
      GROK_FOLDER_TRUST: '0',
      GROK_ASK_USER_QUESTION: '0',
      GROK_TELEMETRY_ENABLED: 'false',
      GROK_TELEMETRY_TRACE_UPLOAD: 'false',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      GROK_HOME: '/t/grok-home',
      GROK_AUTH_PATH: '/home/u/.grok/auth.json',
    });
    expect(() => grokEnv('/t', 'auth.json')).toThrow();
  });
});

describe('判帧', () => {
  it('话和思考算干活；工具开一个、到 completed 才收；end 带会话号；usage 不算', () => {
    const frames = sampleLines().map(classifyGrokLine);
    expect(frames.filter((f) => f.substantive).length).toBeGreaterThan(0);
    const opened = frames.reduce((s, f) => s + f.toolsOpened, 0);
    const closed = frames.reduce((s, f) => s + f.toolsClosed, 0);
    expect([opened, closed]).toEqual([2, 2]);
    expect(frames.at(-1)).toMatchObject({ kind: 'result', sessionId: SID });
    expect(classifyGrokLine('{"type":"usage"}').substantive).toBe(false);
    expect(classifyGrokLine('Syncing…').substantive).toBe(false);
  });
});

describe('过程拆成 transcript.* 事件', () => {
  it('一字一帧的话攒成一条；工具调用和结果按 toolCallId 配对；退出码非 0 算出错；令牌打码；end 成 result', () => {
    const redact = makeRedactor([TOKEN]);
    const p = new GrokTranscriptParser('r1', redact);
    const items = [...sampleLines().flatMap((l) => p.parse(l)), ...p.end()];
    expect(items.map((i) => i.type)).toEqual([
      'transcript.assistant',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.tool_use',
      'transcript.tool_result',
      'transcript.assistant',
      'transcript.result',
    ]);
    expect(items[0]?.payload).toMatchObject({ text: '我先读一下 notes.md。' });
    expect(items[1]?.payload).toMatchObject({
      toolUseId: 'call-1',
      name: 'read_file',
      summary: '/w/notes.md',
    });
    expect(items[2]?.payload).toMatchObject({ toolUseId: 'call-1', isError: false, text: '1→# notes\n' });
    expect(items[4]?.payload).toMatchObject({ toolUseId: 'call-2', isError: true });
    expect(items[5]?.payload).toMatchObject({ text: '目录不在，我改好了。' });
    expect(items[6]?.payload).toMatchObject({ subtype: 'end_turn', isError: false, numTurns: 2 });
    expect(JSON.stringify(items)).not.toContain(TOKEN);
  });
  it('没走到 end 就被杀：攒着的话 end() 吐出来', () => {
    const p = new GrokTranscriptParser('r2', makeRedactor([]));
    expect(p.parse('{"type":"text","data":"做到一半"}')).toEqual([]);
    expect(p.end()).toMatchObject([{ type: 'transcript.assistant', payload: { text: '做到一半' } }]);
  });
});

describe('槽位按 shell=grok 起', () => {
  let t: TestDb;
  let tmpRoot: string;
  beforeAll(async () => {
    t = await createTestDb();
    tmpRoot = await mkdtemp(join(tmpdir(), 'fleet2-grok-test-'));
  }, 60_000);
  afterAll(() => t.close());

  it('配置写进 grok-home、令牌不进命令行；起止事件带壳；过程落成 transcript.*；临时目录删掉', async () => {
    const runId = `grok-${process.pid}`;
    const { sessionId, result } = await runClaudeWorker({
      db: t.db,
      runId,
      shell: 'grok',
      grokAuthPath: '/home/u/.grok/auth.json',
      command: [process.execPath, FAKE],
      model: 'grok-4.7',
      permissionMode: 'bypassPermissions',
      prompt: '改一行',
      cwd: process.cwd(),
      mcp: { url: 'http://127.0.0.1:4799/mcp', token: TOKEN },
      budget: { startupMs: 5_000, totalMs: 15_000, killGraceMs: 200 },
      hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: '/h' },
      extraEnv: { FAKE_REPLAY: SAMPLE },
      tmpRoot,
    });
    expect(result.stderrTail).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(sessionId);
    const worker = await readStream(t.db, `worker:${runId}`, 0);
    expect(worker.map((e) => e.type)).toEqual(['worker.spawned', 'worker.settled']);
    expect(worker[0]?.payload).toMatchObject({ shell: 'grok', model: 'grok-4.7' });
    expect(JSON.stringify(worker)).not.toContain(TOKEN);
    const steps = await readStream(t.db, `transcript:${runId}`, 0);
    expect(steps.map((e) => e.type)).toContain('transcript.tool_result');
    expect(steps.at(-1)?.type).toBe('transcript.result');
    expect(JSON.stringify(steps)).not.toContain(TOKEN);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('没给登录态文件不起、不记事件', async () => {
    const runId = `grok-noauth-${process.pid}`;
    await expect(
      runClaudeWorker({
        db: t.db,
        runId,
        shell: 'grok',
        command: [process.execPath, FAKE],
        model: 'grok-4.7',
        permissionMode: 'bypassPermissions',
        prompt: 'x',
        cwd: process.cwd(),
        mcp: { url: 'http://127.0.0.1:4799/mcp', token: TOKEN },
        tmpRoot,
      }),
    ).rejects.toThrow(/grokAuthPath/);
    expect(await readStream(t.db, `worker:${runId}`, 0)).toEqual([]);
  });
});
