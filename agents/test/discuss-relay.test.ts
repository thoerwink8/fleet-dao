// GPT 中转：本地假的 OpenAI 兼容服务器，不打真接口、不读本机 discuss.env。
// 配了就走 chat/completions 的路由组；超时、非 2xx、空回答记没答上；没配退出码 2，不改走别的工具；输出里不出现密钥和地址。
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const SCRIPTS = fileURLToPath(new URL('../skills/discuss/scripts/', import.meta.url));
const relayLib = await import(pathToFileURL(join(SCRIPTS, 'gpt-relay.mjs')).href);
const { completeChat, discussionGateway, gptRelayConfig, judgeCursorText, parseEnvFile, relayFailureWhy } =
  relayLib as {
    completeChat(opts: {
      baseUrl: string;
      apiKey: string;
      model: string;
      prompt: string;
      timeoutMs: number;
    }): Promise<
      | { ok: true; text: string }
      | { ok: false; kind: 'timeout' }
      | { ok: false; kind: 'http'; status: number }
      | { ok: false; kind: 'empty' }
      | { ok: false; kind: 'json' }
      | { ok: false; kind: 'network'; code: string }
    >;
    gptRelayConfig(opts?: {
      home?: string;
      env?: Record<string, string | undefined>;
      readFile?: (path: string) => string;
    }): { baseUrl: string; apiKey: string } | null;
    judgeCursorText(
      raw: string,
      nonce: string,
      sampleLen?: number,
    ): { kind: 'ok'; text: string } | { kind: 'empty' } | { kind: 'nonce'; sample: string };
    parseEnvFile(text: string): Record<string, string>;
    relayFailureWhy(
      failure:
        | { ok: false; kind: 'timeout' }
        | { ok: false; kind: 'http'; status: number }
        | { ok: false; kind: 'empty' }
        | { ok: false; kind: 'json' }
        | { ok: false; kind: 'network'; code: string },
      seconds: number,
    ): string;
    discussionGateway(opts?: {
      home?: string;
      env?: Record<string, string | undefined>;
      readFile?: (path: string) => string;
    }): { baseUrl: string; apiKey: string } | null;
  };

const KEY = 'relay-test-key';
const LONG = `【推演】${'从开单走到关单，每个阶段的边界和最坏情况都列了，对照了成熟产品的做法。'.repeat(3)}`;
const CRITIQUE = ['## 框架对不对', '一致', '## 漏掉的', '无', '## 选项怎么改', '无', '结论：同意'].join('\n');
const WIN = process.platform === 'win32';

const made: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of made.splice(0))
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
});

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `relay-${name}-`));
  made.push(dir);
  return dir;
}

interface Hit {
  url: string | undefined;
  auth: string;
  model: string | undefined;
  content: string | undefined;
  stream: boolean | undefined;
}
type Mode =
  | 'ok'
  | 'empty'
  | 'http'
  | 'hang'
  | 'garbage'
  | 'array'
  | 'magpie'
  | 'magpie-parallel'
  | 'magpie-partial';

/** 单独的进程：ask.mjs 用同步子进程，假服务器若挤在测试进程里，事件循环转不动，请求没人接。 */
async function fakeRelay(mode: Mode, answer: string) {
  const dir = temp('srv');
  const hitsFile = join(dir, 'hits.json');
  const answerFile = join(dir, 'answer.txt');
  const script = join(dir, 'server.mjs');
  writeFileSync(hitsFile, '[]');
  writeFileSync(answerFile, answer);
  writeFileSync(
    script,
    [
      "import { createServer } from 'node:http';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const mode = process.argv[2];',
      'const hitsFile = process.argv[3];',
      'const answer = readFileSync(process.argv[4], "utf8");',
      'const hits = [];',
      'const pending = [];',
      'const server = createServer((req, res) => {',
      "    if (req.url === '/v1/models') {",
      "      res.writeHead(200, { 'content-type': 'application/json' });",
      "      res.end(JSON.stringify({ data: ['recodex/gpt-6-astra', 'recodex/gpt-6-luna', 'devin/swe-2', 'chaeng/deepseek-v4.1-flash', 'grok/grok-4.7', 'devin/gpt-custom', 'cursor/claude-haiku-5-5@300k'].map(id => ({ id })) }));",
      '      return;',
      '    }',
      '  const chunks = [];',
      "  req.on('data', (c) => chunks.push(c));",
      "  req.on('end', () => {",
      '    let model, content, stream;',
      '    try {',
      "      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
      '      model = body.model; stream = body.stream; content = body.messages?.[0]?.content;',
      '    } catch { /* 留空 */ }',
      '    hits.push({ url: req.url, auth: String(req.headers.authorization ?? ""), model, content, stream });',
      '    writeFileSync(hitsFile, JSON.stringify(hits));',
      "    if (mode === 'hang' || (mode === 'magpie-partial' && model === 'deepseek-pool')) return;",
      "    if (mode === 'magpie-parallel') {",
      '      pending.push(res);',
      '      if (pending.length >= 3) for (const r of pending.filter(r => !r.writableEnded)) {',
      "        r.writeHead(200, { 'content-type': 'application/json' });",
      '        r.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));',
      '      }',
      '      return;',
      '    }',
      "    if (mode === 'http') {",
      "      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });",
      '      res.end("echo " + (req.headers.authorization ?? ""));',
      '      return;',
      '    }',
      "    if (mode === 'garbage') {",
      "      res.writeHead(200, { 'content-type': 'application/json' });",
      "      res.end('not-json');",
      '      return;',
      '    }',
      "    const message = mode === 'array'",
      '      ? { content: [{ type: "text", text: answer }] }',
      "      : { content: mode === 'empty' ? '   ' : answer };",
      "    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });",
      '    res.end(JSON.stringify({ choices: [{ message }] }));',
      '  });',
      '});',
      "server.listen(0, '127.0.0.1', () => {",
      '  const addr = server.address();',
      "  process.stdout.write(String(addr.port) + '\\n');",
      '});',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, [script, mode, hitsFile, answerFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let errBuf = '';
  child.stderr.on('data', (d: Buffer) => {
    errBuf += d;
  });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`假服务器没起来：${errBuf}`)), 5_000);
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      resolve(buf.slice(0, nl).trim());
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`假服务器退出 ${code}：${errBuf}`));
    });
  });
  const close = () => {
    child.kill();
    return Promise.resolve();
  };
  closers.push(close);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits: (): Hit[] => JSON.parse(readFileSync(hitsFile, 'utf8')) as Hit[],
    close,
  };
}

function sentinel(marker: string): string {
  const bin = temp('bin');
  const script = join(bin, 'sentinel.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
  );
  if (WIN) writeFileSync(join(bin, 'cursor-agent.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  else {
    writeFileSync(join(bin, 'cursor-agent'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(join(bin, 'cursor-agent'), 0o755);
  }
  return bin;
}

function run(
  script: string,
  args: string[],
  o: { home: string; path?: string; env?: Record<string, string> },
) {
  const env: Record<string, string> = {
    HOME: o.home,
    USERPROFILE: o.home,
    PATH: o.path ?? temp('empty'),
    ...o.env,
  };
  for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined && env[k] === undefined) env[k] = v;
  }
  const r = runChild(process.execPath, [join(SCRIPTS, script), ...args], {
    env,
    cwd: temp('cwd'),
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    all: `${r.stdout}\n${r.stderr}`,
  };
}

function topic(text: string): string {
  const file = join(temp('topic'), '题面.md');
  writeFileSync(file, text);
  return file;
}

function expectClean(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain('127.0.0.1');
  expect(text).not.toMatch(/https?:\/\//);
}

function relayEnv(baseUrl: string, extra: Record<string, string> = {}) {
  return { DISCUSS_MAGPIE_BASE_URL: baseUrl, DISCUSS_GPT_API_KEY: KEY, ...extra };
}

describe('gpt-relay：配置和核对码判法', () => {
  it('文件里两个都有才算配了；引号、export、注释认得出；末尾斜杠去掉', () => {
    expect(
      parseEnvFile('# c\nexport DISCUSS_GPT_BASE_URL="http://127.0.0.1:9/v1/"\nDISCUSS_GPT_API_KEY=\'k\'\n'),
    ).toEqual({
      DISCUSS_GPT_BASE_URL: 'http://127.0.0.1:9/v1/',
      DISCUSS_GPT_API_KEY: 'k',
    });
    const home = temp('home');
    const readFile = () => 'DISCUSS_GPT_BASE_URL=http://127.0.0.1:9/v1/\nDISCUSS_GPT_API_KEY=file-key\n';
    expect(gptRelayConfig({ home, env: {}, readFile })).toEqual({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'file-key',
    });
    expect(
      gptRelayConfig({
        home,
        env: { DISCUSS_GPT_API_KEY: 'env-key' },
        readFile,
      })?.apiKey,
    ).toBe('env-key');
    expect(gptRelayConfig({ home, env: { DISCUSS_GPT_BASE_URL: '' }, readFile })).toBeNull();
    expect(
      gptRelayConfig({
        home,
        env: { DISCUSS_GPT_API_KEY: KEY },
        readFile: () => '',
      }),
    ).toBeNull();
    expect(
      gptRelayConfig({
        home,
        env: {},
        readFile: () => {
          throw new Error('nope');
        },
      }),
    ).toBeNull();
  });

  it('讨论网关：默认本机 magpie，密钥用 discuss.env 里的，不跟旧 GPT 地址走', () => {
    const home = temp('home');
    const readFile = () => '';
    expect(
      discussionGateway({
        home,
        env: { DISCUSS_GPT_BASE_URL: 'http://127.0.0.1:9/v1/', DISCUSS_GPT_API_KEY: 'k' },
        readFile,
      }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'k' });
    expect(
      discussionGateway({
        home,
        env: { DISCUSS_MAGPIE_BASE_URL: 'http://127.0.0.1:8/v1/', DISCUSS_GPT_API_KEY: 'k' },
        readFile,
      }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:8/v1', apiKey: 'k' });
    expect(
      discussionGateway({
        home,
        env: {
          DISCUSS_MAGPIE_BASE_URL: '',
          DISCUSS_GPT_BASE_URL: 'http://127.0.0.1:9/v1',
          DISCUSS_GPT_API_KEY: 'k',
        },
        readFile,
      }),
    ).toBeNull();
    expect(discussionGateway({ home, env: { DISCUSS_GPT_API_KEY: '' }, readFile })).toBeNull();
    expect(discussionGateway({ home, env: {}, readFile })).toBeNull();
  });

  it('核对码：空、没有、去掉那一行；只剩核对码仍算答上', () => {
    expect(judgeCursorText('  ', 'abc')).toEqual({ kind: 'empty' });
    expect(judgeCursorText('无法读取', 'abc', 4)).toEqual({
      kind: 'nonce',
      sample: '无法读取'.slice(0, 4),
    });
    expect(judgeCursorText('abc\n真正的答案\n', 'abc')).toEqual({
      kind: 'ok',
      text: '真正的答案',
    });
    expect(judgeCursorText('abc', 'abc')).toEqual({ kind: 'ok', text: '' });
  });

  it('失败原因只有状态和错误码', () => {
    expect(relayFailureWhy({ ok: false, kind: 'timeout' }, 1)).toBe('超过 1 秒');
    expect(relayFailureWhy({ ok: false, kind: 'http', status: 503 }, 1)).toBe('HTTP 503');
    expect(relayFailureWhy({ ok: false, kind: 'empty' }, 1)).toBe('没有输出');
    expect(relayFailureWhy({ ok: false, kind: 'json' }, 1)).toBe('回答不是 JSON');
    expect(relayFailureWhy({ ok: false, kind: 'network', code: 'ECONNREFUSED' }, 1)).toBe(
      '连不上（ECONNREFUSED）',
    );
    expect(relayFailureWhy({ ok: false, kind: 'network', code: '' }, 1)).toBe('连不上');
  });
});

describe('completeChat：假的 chat/completions', () => {
  it('答上：默认外的型号、非流式、正文原样；数组 content 拼起来', async () => {
    const relay = await fakeRelay('array', '四');
    const r = await completeChat({
      baseUrl: `${relay.baseUrl}/`,
      apiKey: KEY,
      model: 'gpt-6-sol',
      prompt: '2 的两倍是几',
      timeoutMs: 5_000,
    });
    expect(r).toEqual({ ok: true, text: '四' });
    expect(relay.hits()[0]).toMatchObject({
      url: '/v1/chat/completions',
      auth: `Bearer ${KEY}`,
      model: 'gpt-6-sol',
      content: '2 的两倍是几',
      stream: false,
    });
  });

  it('非 2xx 不读正文，空回答、不是 JSON、挂住，各是一种没答上', async () => {
    const http = await fakeRelay('http', '');
    expect(
      await completeChat({
        baseUrl: http.baseUrl,
        apiKey: KEY,
        model: 'm',
        prompt: 'q',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      ok: false,
      kind: 'http',
      status: 503,
    });
    const empty = await fakeRelay('empty', '');
    expect(
      await completeChat({
        baseUrl: empty.baseUrl,
        apiKey: KEY,
        model: 'm',
        prompt: 'q',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      ok: false,
      kind: 'empty',
    });
    const garbage = await fakeRelay('garbage', '');
    expect(
      await completeChat({
        baseUrl: garbage.baseUrl,
        apiKey: KEY,
        model: 'm',
        prompt: 'q',
        timeoutMs: 5_000,
      }),
    ).toEqual({
      ok: false,
      kind: 'json',
    });
    const hang = await fakeRelay('hang', '');
    expect(
      await completeChat({
        baseUrl: hang.baseUrl,
        apiKey: KEY,
        model: 'm',
        prompt: 'q',
        timeoutMs: 300,
      }),
    ).toEqual({
      ok: false,
      kind: 'timeout',
    });
  });
});

const SLOW = { timeout: 0 };

const magpieLib = (await import(pathToFileURL(join(SCRIPTS, 'magpie.mjs')).href)) as {
  magpieFamily(model: string): string | null;
  magpieConfig(opts: {
    env: Record<string, string>;
    fetchImpl?: typeof fetch;
    probeMs?: number;
  }): Promise<unknown>;
  magpiePanel(
    keys?: string[],
    overrides?: Record<string, string>,
    opts?: { env: Record<string, string>; readFile: () => string },
  ): Array<{ key: string; model: string }>;
};

function magpieEnv(baseUrl: string) {
  return { DISCUSS_MAGPIE_BASE_URL: baseUrl, DISCUSS_MAGPIE_API_KEY: KEY };
}

function critiqueBody(r: ReturnType<typeof run>) {
  return readFileSync(r.out.trim().split(/\r?\n/).at(-1) ?? '', 'utf8');
}

describe('讨论路由组：并行、单家失败、同族不问', SLOW, () => {
  it('真并行：假网关等三家请求都到齐才回；输出型号和族', async () => {
    const relay = await fakeRelay('magpie-parallel', '答案第一行\n答案第二行');
    const r = run(
      'ask.mjs',
      [
        '--text',
        topic('2+2？'),
        '--round',
        '0',
        '--limit',
        '3',
        '--models',
        'gpt-pool,grok-pool,deepseek-pool',
      ],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(
      relay
        .hits()
        .map((h) => h.model)
        .sort(),
    ).toEqual(['deepseek-pool', 'gpt-pool', 'grok-pool']);
    for (const family of ['gpt', 'grok', 'deepseek']) expect(r.out).toContain(`厂商族：${family}`);
    expect(r.out).not.toContain('没答上');
  });

  it('单家超时照实标没答上；其他家保留答案', async () => {
    const relay = await fakeRelay('magpie-partial', '有答案');
    const r = run(
      'ask.mjs',
      [
        '--text',
        topic('题目'),
        '--round',
        '0',
        '--limit',
        '0.3',
        '--models',
        'gpt-pool,grok-pool,deepseek-pool,kimi-pool',
      ],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('没答上：超过 0.3 秒');
    expect(r.out.match(/有答案/g)).toHaveLength(3);
    expect(relay.hits()).toHaveLength(4);
  });

  it('只问点名的路由组；旧的 --gpt-model 直接拒绝，不发请求', async () => {
    const relay = await fakeRelay('ok', '答案');
    const one = run('ask.mjs', ['--text', topic('题目'), '--round', '0', '--models', 'gpt-pool,kimi-pool'], {
      home: temp('home'),
      env: magpieEnv(relay.baseUrl),
    });
    expect(one.code).toBe(0);
    expect(
      relay
        .hits()
        .map((h) => h.model)
        .sort(),
    ).toEqual(['gpt-pool', 'kimi-pool']);
    expect(one.out).toContain('厂商族：gpt');
    const dup = run('ask.mjs', ['--text', topic('题目'), '--round', '0', '--models', 'gpt-pool,gpt-pool'], {
      home: temp('home'),
      env: magpieEnv(relay.baseUrl),
    });
    expect(dup.code).toBe(2);
    expect(dup.err).toContain('不能重复');
    const rejected = run(
      'ask.mjs',
      ['--text', topic('题目'), '--round', '0', '--models', 'gpt-pool', '--gpt-model', 'devin/gpt-custom'],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(rejected.code).toBe(2);
    expect(rejected.err).toContain('不要 --gpt-model');
    expect(relay.hits()).toHaveLength(2);
  });

  it('magpie 地址连不上不改走另一套中转；探测失败仍返回 null', async () => {
    const relay = await fakeRelay('ok', '不该走到');
    const r = run(
      'ask.mjs',
      ['--text', topic('题目'), '--round', '0', '--models', 'gpt-pool', '--limit', '2'],
      {
        home: temp('home'),
        env: { ...relayEnv(relay.baseUrl), ...magpieEnv('http://127.0.0.1:1/v1') },
      },
    );
    expect(r.code).toBe(2);
    expect(r.out).toContain('没答上：连不上');
    expect(r.out).not.toContain('不该走到');
    expect(relay.hits()).toHaveLength(0);
    expectClean(r.all);
    const failedFetch: typeof fetch = async () => {
      throw new Error('unavailable');
    };
    expect(await magpieLib.magpieConfig({ env: {}, fetchImpl: failedFetch })).toBeNull();
  });

  it('禁用渠道、路由组、未知模型和同族伪装不发请求；跨渠道仍按实际厂商族', () => {
    for (const id of [
      'claude/claude-opus-5-5',
      'antigravity/gpt-6',
      'gemini/gemini-4',
      'group/smart',
      'auto/gpt-6',
      'cursor/gemini-4-carbon',
      'cursor/kimi-k3',
      'cursor/claude-opus-5-5@300k',
      'cursor/gpt-6-astra',
    ]) {
      expect(magpieLib.magpieFamily(id)).toBeNull();
      expect(() => magpieLib.magpiePanel(['gpt'], { gpt: id })).toThrow('被禁用');
    }
    expect(magpieLib.magpieFamily('devin/gpt-6-sol')).toBe('gpt');
    expect(magpieLib.magpieFamily('recodex/gpt-6-astra')).toBe('gpt');
    expect(magpieLib.magpieFamily('cursor/claude-haiku-5-5@300k')).toBe('claude');
    expect(magpieLib.magpieFamily('devin/swe-2')).toBe('swe');
    expect(() => magpieLib.magpiePanel(['swe'], { swe: 'devin/gpt-6-sol' })).toThrow('同族');
    expect(() => magpieLib.magpiePanel(['gpt', 'gpt'])).toThrow('重复');
  });

  it('反方按路由组排除作者族，点名同族不发请求', async () => {
    const relay = await fakeRelay('magpie', CRITIQUE);
    const r = run(
      'second-opinion.mjs',
      [
        '--text',
        topic(LONG),
        '--author-family',
        'gpt-pool,grok-pool,deepseek-pool',
        '--models',
        'kimi-pool,glm-pool',
      ],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(
      relay
        .hits()
        .map((h) => h.model)
        .sort(),
    ).toEqual(['glm-pool', 'kimi-pool']);
    expect(critiqueBody(r)).toContain('厂商族：kimi');
    expect(critiqueBody(r)).toContain('结论：同意');
    const blocked = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'kimi-pool', '--models', 'kimi-pool'],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('同一族');
    expect(relay.hits()).toHaveLength(2);
  });

  it('cn-pool 要显式选；作者同族则拒绝', async () => {
    const relay = await fakeRelay('magpie', CRITIQUE);
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'claude', '--models', 'cn-pool'],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(relay.hits()[0]?.model).toBe('cn-pool');
    expect(critiqueBody(r)).toContain('厂商族：cn');
    const blocked = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'cn-pool', '--models', 'cn-pool'],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('同一族');
    expect(relay.hits()).toHaveLength(1);
  });

  it('gemini-pool 点名才问：参数校验通过，不进默认那五家，同族不问', async () => {
    const relay = await fakeRelay('magpie', CRITIQUE);
    const env = magpieEnv(relay.baseUrl);
    const home = temp('home');
    const asked = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'claude', '--models', 'gemini-pool', '--budget-sec', '5'],
      { home, env },
    );
    expect(asked.code).not.toBe(2);
    expect(asked.err).not.toContain('不认识的模型');
    expect(relay.hits()[0]?.model).toBe('gemini-pool');
    expect(critiqueBody(asked)).toContain('厂商族：gemini');

    const bare = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'gemini', '--models', 'gpt-pool', '--budget-sec', '5'],
      { home, env },
    );
    expect(bare.code).not.toBe(2);
    expect(bare.err).not.toContain('不认识的作者模型族');
    expect(relay.hits().map((h) => h.model)).toEqual(['gemini-pool', 'gpt-pool']);

    const same = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'gemini-pool', '--models', 'gemini-pool'],
      { home, env },
    );
    expect(same.code).toBe(2);
    expect(same.err).toContain('同一族');

    const beforeDefault = relay.hits().length;
    const defaults = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'claude', '--budget-sec', '5'],
      { home, env },
    );
    expect(defaults.err).not.toContain('不认识的模型');
    const askedByDefault = relay
      .hits()
      .slice(beforeDefault)
      .map((h) => h.model);
    expect(askedByDefault).not.toContain('gemini-pool');
    expect(askedByDefault).not.toContain('cn-pool');
    expect(askedByDefault.length).toBeGreaterThan(0);
  });

  it('网关探测有两秒预算、坏名单不能用，配置空值明确停用', async () => {
    const env = magpieEnv('http://127.0.0.1:1234/v1');
    const aborting: typeof fetch = async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    };
    expect(await magpieLib.magpieConfig({ env, fetchImpl: aborting, probeMs: 30 })).toBeNull();
    const malformed: typeof fetch = async () => new Response(JSON.stringify({ models: [] }));
    expect(await magpieLib.magpieConfig({ env, fetchImpl: malformed })).toBeNull();
    expect(
      await magpieLib.magpieConfig({ env: { DISCUSS_MAGPIE_BASE_URL: '' }, fetchImpl: malformed }),
    ).toBeNull();
  });

  it('反方全失败或结论格式认不出，退出码 2，绝不算同意', async () => {
    const relay = await fakeRelay('hang', '');
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'claude', '--models', 'gpt-pool', '--budget-sec', '0.3'],
      { home: temp('home'), env: magpieEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(2);
    expect(critiqueBody(r)).toContain('没查成');
    expect(critiqueBody(r)).not.toContain('结论：同意');
    const bad = await fakeRelay('magpie', '我没写结论');
    const unparsed = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--author-family', 'claude', '--models', 'gpt-pool'],
      { home: temp('home'), env: magpieEnv(bad.baseUrl) },
    );
    expect(unparsed.code).toBe(2);
    expect(critiqueBody(unparsed)).toContain('认不出（没查成）');
  });
});

describe('ask.mjs：讨论只走网关路由组', SLOW, () => {
  it('路由组名就是模型，题面里的中文送到了', async () => {
    const relay = await fakeRelay('ok', '四');
    const home = temp('home');
    const r = run(
      'ask.mjs',
      ['--text', topic(`只回一行：2 的两倍是几。\n\n${LONG}`), '--round', '1', '--models', 'gpt-pool'],
      { home, env: relayEnv(`${relay.baseUrl}/`) },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('## gpt-pool（gpt-pool，');
    expect(r.out).toContain('厂商族：gpt');
    expect(r.out).toContain('四');
    expect(relay.hits()[0]?.content).toContain('两倍');
    expect(relay.hits()[0]?.model).toBe('gpt-pool');
    expectClean(r.all);
  });

  it('失败记没答上，不改走别的工具，正文里的密钥不出现', async () => {
    const relay = await fakeRelay('http', '');
    const home = temp('home');
    const marker = join(home, 'cursor-called');
    const r = run(
      'ask.mjs',
      ['--text', topic(LONG), '--round', '1', '--models', 'gpt-pool', '--limit', '30'],
      { home, path: sentinel(marker), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(2);
    expect(r.out).toContain('没答上：HTTP 503');
    expect(relay.hits()[0]?.model).toBe('gpt-pool');
    expect(existsSync(marker)).toBe(false);
    expectClean(r.all);
  });

  it('挂住按 --limit 记超时；空回答、不是 JSON 也记没答上', async () => {
    const hang = await fakeRelay('hang', '');
    const timed = run(
      'ask.mjs',
      ['--text', topic(LONG), '--round', '1', '--models', 'gpt-pool', '--limit', '1'],
      {
        home: temp('home'),
        env: relayEnv(hang.baseUrl),
      },
    );
    expect(timed.code).toBe(2);
    expect(timed.out).toContain('没答上：超过 1 秒');
    expectClean(timed.all);

    const empty = await fakeRelay('empty', '');
    const blank = run('ask.mjs', ['--text', topic(LONG), '--round', '1', '--models', 'kimi-pool'], {
      home: temp('home'),
      env: relayEnv(empty.baseUrl),
    });
    expect(blank.code).toBe(2);
    expect(blank.out).toContain('没答上：没有输出');

    const garbage = await fakeRelay('garbage', '');
    const bad = run('ask.mjs', ['--text', topic(LONG), '--round', '1', '--models', 'glm-pool'], {
      home: temp('home'),
      env: relayEnv(garbage.baseUrl),
    });
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('没答上：回答不是 JSON');
  });

  it('只写在文件里也走；进程里的空值盖过文件，于是没讨论成', async () => {
    const relay = await fakeRelay('ok', '来自文件');
    const home = temp('home');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(
      join(home, '.fleet-dao', 'discuss.env'),
      `DISCUSS_MAGPIE_BASE_URL=${relay.baseUrl}\nDISCUSS_GPT_API_KEY=${KEY}\n`,
    );
    const fromFile = run('ask.mjs', ['--text', topic(LONG), '--round', '1', '--models', 'deepseek-pool'], {
      home,
    });
    expect(fromFile.code).toBe(0);
    expect(fromFile.out).toContain('来自文件');
    expectClean(fromFile.all);

    const covered = run('ask.mjs', ['--text', topic(LONG), '--round', '1', '--models', 'deepseek-pool'], {
      home,
      env: { DISCUSS_GPT_API_KEY: '' },
    });
    expect(covered.code).toBe(2);
    expect(covered.err).toContain('没配讨论网关');
    expect(covered.err).toContain('没讨论成');
    expect(relay.hits()).toHaveLength(1);
  });

  it('连不上时输出没有地址和密钥', () => {
    const r = run(
      'ask.mjs',
      ['--text', topic(LONG), '--round', '1', '--models', 'gpt-pool', '--limit', '5'],
      {
        home: temp('home'),
        env: relayEnv('http://127.0.0.1:1/v1'),
      },
    );
    expect(r.code).toBe(2);
    expect(r.out).toContain('没答上：连不上');
    expectClean(r.all);
  });

  it('记录落在 --out；父级不是目录就没问成', async () => {
    const relay = await fakeRelay('ok', '四');
    const out = join(temp('out'), 'runs');
    const r = run(
      'ask.mjs',
      ['--text', topic(LONG), '--round', '1', '--models', 'deepseek-pool', '--out', out],
      { home: temp('home'), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(readdirSync(out).some((f) => f.startsWith('ask-'))).toBe(true);
    const blocker = join(temp('out'), 'not-a-dir');
    writeFileSync(blocker, 'x');
    const bad = run(
      'ask.mjs',
      ['--text', topic(LONG), '--round', '1', '--models', 'deepseek-pool', '--out', join(blocker, 'runs')],
      { home: temp('home'), env: relayEnv(relay.baseUrl) },
    );
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('没问成');
  });
});

describe('second-opinion.mjs：反方走同一条讨论网关', SLOW, () => {
  it('点名的路由组走网关，同意则退出码 0', async () => {
    const relay = await fakeRelay('ok', CRITIQUE);
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'relay-ok', '--author-family', 'claude', '--models', 'gpt-pool'],
      { home: temp('home'), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(relay.hits()).toHaveLength(1);
    expect(relay.hits()[0]?.model).toBe('gpt-pool');
    const body = critiqueBody(r);
    expect(body).toContain('gpt-pool');
    expect(body).toContain('OpenAI 兼容接口');
    expect(body).toContain('结论：同意');
    expect(body).toContain('厂商族：gpt');
    expectClean(`${r.all}\n${body}`);
  });

  it('--agent 直接拒绝，不起别的执行体', async () => {
    const relay = await fakeRelay('ok', CRITIQUE);
    const home = temp('home');
    const marker = join(home, 'cursor-called');
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'relay-cursor', '--author-family', 'claude', '--agent', 'cursor'],
      { home, path: sentinel(marker), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('不要 --agent');
    expect(relay.hits()).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('网关失败记没答上，不改走别的工具', async () => {
    const relay = await fakeRelay('http', '');
    const home = temp('home');
    const marker = join(home, 'cursor-called');
    const r = run(
      'second-opinion.mjs',
      [
        '--text',
        topic(LONG),
        '--name',
        'relay-down',
        '--author-family',
        'claude',
        '--models',
        'gpt-pool',
        '--budget-sec',
        '30',
      ],
      { home, path: sentinel(marker), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('HTTP 503');
    expect(r.err).toContain('gpt-pool');
    expect(existsSync(marker)).toBe(false);
    expectClean(r.all);
  });
});
