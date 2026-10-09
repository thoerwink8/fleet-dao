// redactor 补的一条：URL 查询参数里的令牌（#1148）。
// 真实日志的形状：`mirasim server v0.0.425: http://localhost:4318/?token=<令牌> (workdir /home/fleet-agent-carpool)`，
// journalctl 一读就把能登录会话的令牌打进对话。规则在 agents/hooks/redact.mjs 的 URL_TOKEN_PARAM。
// 「认不出就不谎称遮好了」的约定见 redact.mjs 开头和 redactText 的注释：这是安全网，不是保险箱；
// 认不出的形状原样交回、hasSecretValue 说 false（只表示没认出，不表示干净），下面「故意造出的失败」一组把这点钉住。
// 令牌都是假的：FAKE 开头。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface RedactLib {
  redactText(text: string): string;
  redactLines(text: string): string;
  hasSecretValue(text: string): boolean;
}
interface SecretsLib {
  main(argv: string[], io: { out(s: string): void; err(s: string): void }, readStdin?: () => string): number;
}

const load = async <T>(rel: string) =>
  (await import(pathToFileURL(fileURLToPath(new URL(rel, import.meta.url))).href)) as T;
const redact = await load<RedactLib>('../hooks/redact.mjs');
const secrets = await load<SecretsLib>('../hooks/redact-secrets.mjs');

const TOKEN = 'FAKEtoken0123456789abcdefABCDEF';

describe('URL 查询参数里的令牌：值换成 ***，参数名和 URL 其余部分照旧', () => {
  it('2026-10 那条 mirasim 日志的原样', () => {
    const line = `mirasim server v0.0.425: http://localhost:4318/?token=${TOKEN} (workdir /home/fleet-agent-carpool)`;
    expect(redact.redactText(line)).toBe(
      'mirasim server v0.0.425: http://localhost:4318/?token=*** (workdir /home/fleet-agent-carpool)',
    );
    expect(redact.hasSecretValue(line)).toBe(true);
  });

  const forms: [string, string, string][] = [
    ['?access_token', `http://h/cb?access_token=${TOKEN}`, 'http://h/cb?access_token=***'],
    ['&token（后面还有参数）', `http://h/p?a=1&token=${TOKEN}&b=2`, 'http://h/p?a=1&token=***&b=2'],
    ['&api_key', `https://api.x.io/v1?x=1&api_key=${TOKEN}`, 'https://api.x.io/v1?x=1&api_key=***'],
    ['?apikey', `https://api.x.io/v1?apikey=${TOKEN}`, 'https://api.x.io/v1?apikey=***'],
    ['?api-key（连字符）', `https://api.x.io/v1?api-key=${TOKEN}`, 'https://api.x.io/v1?api-key=***'],
    ['?key（只在 URL 查询里）', `https://maps.x.io/js?key=${TOKEN}&v=3`, 'https://maps.x.io/js?key=***&v=3'],
    ['?secret', `http://h/hook?secret=${TOKEN}`, 'http://h/hook?secret=***'],
    ['&client_secret', `http://h/o?id=1&client_secret=${TOKEN}`, 'http://h/o?id=1&client_secret=***'],
    ['?password', `ftp://h/f?password=${TOKEN}`, 'ftp://h/f?password=***'],
    ['#fragment 前停住', `http://h/?token=${TOKEN}#top`, 'http://h/?token=***#top'],
    ['值带 . _ ~ + / = -', 'http://h/?token=ab.cd_ef~gh+ij/kl=mn-op', 'http://h/?token=***'],
    ['百分号编码过的值', 'http://h/?token=ab%2Bcd%2Fef%3Dgh12', 'http://h/?token=***'],
    ['整行在引号里', `curl "http://h/?token=${TOKEN}" -o x`, 'curl "http://h/?token=***" -o x'],
  ];
  it.each(forms)('%s', (_n, input, want) => {
    expect(redact.redactText(input)).toBe(want);
  });

  it('参数名大小写混合也遮', () => {
    expect(redact.redactText(`http://h/?Token=${TOKEN}`)).toBe('http://h/?Token=***');
    expect(redact.redactText(`http://h/?ACCESS_TOKEN=${TOKEN}`)).toBe('http://h/?ACCESS_TOKEN=***');
    expect(redact.redactText(`http://h/?x=1&Api_Key=${TOKEN}`)).toBe('http://h/?x=1&Api_Key=***');
    expect(redact.redactText(`http://h/?KEY=${TOKEN}`)).toBe('http://h/?KEY=***');
    expect(redact.redactText(`http://h/?PassWord=${TOKEN}`)).toBe('http://h/?PassWord=***');
  });

  it('整段多行日志过一遍：令牌没了，别的行和行数不动', () => {
    const log = [
      'Oct 09 10:00:01 fr node[42]: listening',
      `Oct 09 10:00:02 fr node[42]: mirasim server v0.0.425: http://localhost:4318/?token=${TOKEN} (workdir /x)`,
      'Oct 09 10:00:03 fr node[42]: ready',
    ].join('\n');
    const out = redact.redactLines(log);
    expect(out).not.toContain(TOKEN);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('Oct 09 10:00:01 fr node[42]: listening');
    expect(out).toContain('http://localhost:4318/?token=*** (workdir /x)');
  });

  it('命令行入口（redact-secrets.mjs）从标准输入读到的 URL 也遮', () => {
    const out: string[] = [];
    const code = secrets.main(
      [],
      { out: (s) => out.push(s), err: () => {} },
      () => `http://localhost:4318/?token=${TOKEN}\n`,
    );
    expect(code).toBe(0);
    expect(out.join('')).not.toContain(TOKEN);
    expect(out.join('')).toContain('http://localhost:4318/?token=***');
  });
});

describe('没有令牌的 URL 一个字不动', () => {
  const clean = [
    'http://localhost:4318/',
    'http://localhost:4318/?page=2&sort=asc',
    'https://github.com/org/repo/issues?q=is%3Aopen+label%3Abug',
    'http://h/?key=en',
    'http://h/?token=short',
    'http://h/?monkey=FAKEbanana0123456789',
    'http://h/?tokenizer=on',
    'http://h/?keyboard=FAKEqwertyuiop12345',
    'token=FAKEtoken0123456789abcdef  # 不在 URL 查询里（没有 ? 或 &）归别的规则管',
    'mirasim server v0.0.425: ready (workdir /home/fleet-agent-carpool)',
  ];
  it.each(clean.map((c) => [c] as const))('%s', (line) => {
    expect(redact.redactText(line)).toBe(line);
    expect(redact.hasSecretValue(line)).toBe(false);
  });
});

describe('故意造出的失败：认不出的形状，不谎称遮好了', () => {
  // 这些写法令牌其实在里面，规则认不出；约定是原样交回、hasSecretValue 说 false（= 没认出），
  // 绝不改成别的样子冒充「处理过」。看这一组红了，说明规则被改得宽了或窄了，要回头看 redact.mjs 开头那段话。
  it('参数名本身被百分号编码：认不出，原样交回、不标成遮过', () => {
    const line = `http://h/?%74oken=${TOKEN}`;
    expect(redact.redactText(line)).toBe(line);
    expect(redact.hasSecretValue(line)).toBe(false);
  });

  it('令牌被换行拆开：行尾的 ?token= 后面没有值，认不出，原样交回', () => {
    const line = `mirasim server: http://localhost:4318/?token=\n${TOKEN}`;
    const out = redact.redactText(line);
    expect(out).toBe(line);
    expect(redact.hasSecretValue(line)).toBe(false);
    expect(out).toContain(TOKEN); // 令牌还在：调用方不能把这段当成「已遮好」
  });

  it('令牌被换行拆成前后两截：前半段够长的遮了，后半段原样留着——不假装整个令牌都遮了', () => {
    const line = `http://h/?token=${TOKEN.slice(0, 16)}\n${TOKEN.slice(16)}`;
    const out = redact.redactText(line);
    expect(out).toBe(`http://h/?token=***\n${TOKEN.slice(16)}`);
    expect(out).toContain(TOKEN.slice(16));
  });

  it('不满 8 位的值不遮（规则定死的下限）', () => {
    expect(redact.redactText('http://h/?token=abc1234')).toBe('http://h/?token=abc1234');
  });

  it('读不了标准输入时给明确的失败（退出码 1、不打空），不当成没有令牌', () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = secrets.main([], { out: (s) => out.push(s), err: (s) => err.push(s) }, () => {
      throw Object.assign(new Error('boom'), { code: 'EIO' });
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('EIO');
  });
});
