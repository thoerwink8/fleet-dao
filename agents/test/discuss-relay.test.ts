// GPT 中转：本地假的 OpenAI 兼容服务器，不打真接口、不读本机 discuss.env。
// 配了就走 chat/completions；超时、非 2xx、空回答记没答上；失败不改走 Cursor；输出里不出现密钥和地址。
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const SCRIPTS = fileURLToPath(new URL('../skills/discuss/scripts/', import.meta.url));
const relayLib = await import(pathToFileURL(join(SCRIPTS, 'gpt-relay.mjs')).href);
const { completeChat, gptRelayConfig, judgeCursorText, parseEnvFile, relayFailureWhy } = relayLib as {
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
type Mode = 'ok' | 'empty' | 'http' | 'hang' | 'garbage' | 'array';

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
      'const server = createServer((req, res) => {',
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
      "    if (mode === 'hang') return;",
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
  const r = runChild(process.execPath, [join(SCRIPTS, script), ...args], { env, cwd: temp('cwd') });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
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
  return { DISCUSS_GPT_BASE_URL: baseUrl, DISCUSS_GPT_API_KEY: KEY, ...extra };
}

describe('gpt-relay：配置和核对码判法', () => {
  it('文件里两个都有才算配了；引号、export、注释认得出；末尾斜杠去掉', () => {
    expect(
      parseEnvFile('# c\nexport DISCUSS_GPT_BASE_URL="http://127.0.0.1:9/v1/"\nDISCUSS_GPT_API_KEY=\'k\'\n'),
    ).toEqual({ DISCUSS_GPT_BASE_URL: 'http://127.0.0.1:9/v1/', DISCUSS_GPT_API_KEY: 'k' });
    const home = temp('home');
    const readFile = () => 'DISCUSS_GPT_BASE_URL=http://127.0.0.1:9/v1/\nDISCUSS_GPT_API_KEY=file-key\n';
    expect(gptRelayConfig({ home, env: {}, readFile })).toEqual({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'file-key',
    });
    expect(gptRelayConfig({ home, env: { DISCUSS_GPT_API_KEY: 'env-key' }, readFile })?.apiKey).toBe(
      'env-key',
    );
    expect(gptRelayConfig({ home, env: { DISCUSS_GPT_BASE_URL: '' }, readFile })).toBeNull();
    expect(gptRelayConfig({ home, env: { DISCUSS_GPT_API_KEY: KEY }, readFile: () => '' })).toBeNull();
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

  it('核对码：空、没有、去掉那一行；只剩核对码仍算答上', () => {
    expect(judgeCursorText('  ', 'abc')).toEqual({ kind: 'empty' });
    expect(judgeCursorText('无法读取', 'abc', 4)).toEqual({ kind: 'nonce', sample: '无法读取'.slice(0, 4) });
    expect(judgeCursorText('abc\n真正的答案\n', 'abc')).toEqual({ kind: 'ok', text: '真正的答案' });
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
      await completeChat({ baseUrl: http.baseUrl, apiKey: KEY, model: 'm', prompt: 'q', timeoutMs: 5_000 }),
    ).toEqual({
      ok: false,
      kind: 'http',
      status: 503,
    });
    const empty = await fakeRelay('empty', '');
    expect(
      await completeChat({ baseUrl: empty.baseUrl, apiKey: KEY, model: 'm', prompt: 'q', timeoutMs: 5_000 }),
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
      await completeChat({ baseUrl: hang.baseUrl, apiKey: KEY, model: 'm', prompt: 'q', timeoutMs: 300 }),
    ).toEqual({
      ok: false,
      kind: 'timeout',
    });
  });
});

const SLOW = { timeout: 0 };

describe('ask.mjs：配了就问中转，没配才问 Cursor', SLOW, () => {
  it('没装 cursor-agent 也能答上，默认型号，题面里的中文送到了', async () => {
    const relay = await fakeRelay('ok', '四');
    const home = temp('home');
    const r = run(
      'ask.mjs',
      ['--text', topic(`只回一行：2 的两倍是几。\n\n${LONG}`), '--round', '1', '--models', 'gpt'],
      {
        home,
        env: relayEnv(`${relay.baseUrl}/`),
      },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('## gpt（gpt-6-luna，');
    expect(r.out).toContain('四');
    expect(relay.hits()[0]?.content).toContain('两倍');
    expect(relay.hits()[0]?.model).toBe('gpt-6-luna');
    expectClean(r.all);
  });

  it('--gpt-model 换型号；失败不改走 Cursor，正文里的密钥不出现', async () => {
    const relay = await fakeRelay('http', '');
    const home = temp('home');
    const marker = join(home, 'cursor-called');
    const r = run(
      'ask.mjs',
      ['--text', topic(LONG), '--round', '1', '--models', 'gpt', '--gpt-model', 'gpt-6-sol', '--limit', '30'],
      { home, path: sentinel(marker), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(2);
    expect(r.out).toContain('没答上：HTTP 503');
    expect(relay.hits()[0]?.model).toBe('gpt-6-sol');
    expect(existsSync(marker)).toBe(false);
    expectClean(r.all);
  });

  it('挂住按 --limit 记超时；空回答、不是 JSON 也记没答上', async () => {
    const hang = await fakeRelay('hang', '');
    const timed = run('ask.mjs', ['--text', topic(LONG), '--round', '1', '--limit', '1'], {
      home: temp('home'),
      env: relayEnv(hang.baseUrl),
    });
    expect(timed.code).toBe(2);
    expect(timed.out).toContain('没答上：超过 1 秒');
    expectClean(timed.all);

    const empty = await fakeRelay('empty', '');
    const blank = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      env: relayEnv(empty.baseUrl),
    });
    expect(blank.code).toBe(2);
    expect(blank.out).toContain('没答上：没有输出');

    const garbage = await fakeRelay('garbage', '');
    const bad = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home: temp('home'),
      env: relayEnv(garbage.baseUrl),
    });
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('没答上：回答不是 JSON');
  });

  it('只写在文件里也走；进程里的空值盖过文件，于是回到 Cursor', async () => {
    const relay = await fakeRelay('ok', '来自文件');
    const home = temp('home');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(
      join(home, '.fleet-dao', 'discuss.env'),
      `DISCUSS_GPT_BASE_URL=${relay.baseUrl}\nDISCUSS_GPT_API_KEY=${KEY}\n`,
    );
    const fromFile = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], { home });
    expect(fromFile.code).toBe(0);
    expect(fromFile.out).toContain('来自文件');
    expectClean(fromFile.all);

    const covered = run('ask.mjs', ['--text', topic(LONG), '--round', '1'], {
      home,
      env: { DISCUSS_GPT_BASE_URL: '' },
    });
    expect(covered.code).toBe(2);
    expect(covered.err).toContain('没装 cursor-agent');
    expect(relay.hits()).toHaveLength(1);
  });

  it('连不上时输出没有地址和密钥', () => {
    const r = run('ask.mjs', ['--text', topic(LONG), '--round', '1', '--limit', '5'], {
      home: temp('home'),
      env: relayEnv('http://127.0.0.1:1/v1'),
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain('没答上：连不上');
    expectClean(r.all);
  });
});

describe('second-opinion.mjs：反方轮到 GPT 走同一条', SLOW, () => {
  it('作者不是 GPT 时第一家走中转，同意则退出码 0', async () => {
    const relay = await fakeRelay('ok', CRITIQUE);
    const home = temp('home');
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'relay-ok', '--author-family', 'claude', '--gpt-model', 'gpt-6-sol'],
      { home, env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(relay.hits()).toHaveLength(1);
    expect(relay.hits()[0]?.model).toBe('gpt-6-sol');
    const file = r.out.trim().split(/\r?\n/).at(-1) ?? '';
    const body = readFileSync(file, 'utf8');
    expect(body).toContain('gpt-6-sol');
    expect(body).toContain('OpenAI 兼容接口');
    expect(body).toContain('结论：同意');
    expectClean(`${r.all}\n${body}`);
  });

  it('显式 cursor 档在配了中转时也不起 cursor-agent', async () => {
    const relay = await fakeRelay('ok', CRITIQUE);
    const home = temp('home');
    const marker = join(home, 'cursor-called');
    const r = run(
      'second-opinion.mjs',
      ['--text', topic(LONG), '--name', 'relay-cursor', '--author-family', 'claude', '--agent', 'cursor'],
      { home, path: sentinel(marker), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(0);
    expect(relay.hits()[0]?.model).toBe('gpt-6-luna');
    expect(existsSync(marker)).toBe(false);
    expectClean(r.all);
  });

  it('中转失败只换下一家厂商，不改走 Cursor', async () => {
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
        'grok,claude,deepseek,kimi',
        '--budget-sec',
        '30',
      ],
      { home, path: sentinel(marker), env: relayEnv(relay.baseUrl) },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain('HTTP 503');
    expect(r.err).toContain('gpt-relay');
    expect(existsSync(marker)).toBe(false);
    expectClean(r.all);
  });
});
