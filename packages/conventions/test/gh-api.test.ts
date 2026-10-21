import { describe, expect, it } from 'vitest';
import {
  appendResponseEvidence,
  appendTransportEvidence,
  GITHUB_RATE_LIMIT_RESOURCES,
  GITHUB_RESPONSE_EVIDENCE_HEADERS,
  type GitHubHeaderSource,
  githubResponseEvidence,
  githubTransportEvidence,
} from '../src/gh-api.ts';

const SECRET = 'ghp_fakeSyntheticTokenValue3335';
const ALLOWED = new Set<string>(GITHUB_RESPONSE_EVIDENCE_HEADERS);

function headers(values: Record<string, string | null>): GitHubHeaderSource {
  return {
    get(name: string) {
      const key = name.toLowerCase();
      if (!ALLOWED.has(key)) throw new Error(`读了未白名单的头 ${name}`);
      return values[key] ?? null;
    },
  };
}

function evidence(values: Record<string, string | null> = {}): string {
  return githubResponseEvidence(headers(values));
}

describe('GitHub 响应证据：只格式化白名单', () => {
  it('白名单就是诊断要用的那几项，resource 只认官方已知资源', () => {
    expect([...GITHUB_RESPONSE_EVIDENCE_HEADERS]).toEqual([
      'date',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'x-ratelimit-resource',
      'retry-after',
      'x-github-request-id',
    ]);
    expect(GITHUB_RATE_LIMIT_RESOURCES).toContain('core');
    expect(GITHUB_RATE_LIMIT_RESOURCES).toContain('graphql');
    expect(GITHUB_RATE_LIMIT_RESOURCES).not.toContain('audit_log');
    expect(GITHUB_RATE_LIMIT_RESOURCES).toContain('code_scanning_upload');
  });

  it('403 remaining=0 的有效 reset/resource 写成 epoch 和 UTC，不猜时区', () => {
    const text = evidence({
      date: 'Mon, 19 Oct 2026 19:25:25 GMT',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1792441800',
      'x-ratelimit-resource': 'core',
      'x-github-request-id': 'ABCD:1234:9ABC',
    });
    expect(text).toBe(
      [
        '阶段=响应已收到',
        'date=2026-10-19T19:25:25.000Z',
        'limit=5000',
        'remaining=0',
        'reset=1792441800 utc=2026-10-19T20:30:00.000Z',
        'resource=core',
        'retry-after=unknown',
        'request-id=ABCD:1234:9ABC',
      ].join('；'),
    );
    expect(text).not.toContain('+08:00');
    expect(text).not.toContain('已恢复');
  });

  it('已知 resource 都接受，大小写或 schema 外的名字是 unknown', () => {
    for (const name of GITHUB_RATE_LIMIT_RESOURCES) {
      expect(evidence({ 'x-ratelimit-resource': name })).toContain(`resource=${name}`);
    }
    expect(evidence({ 'x-ratelimit-resource': 'CORE' })).toContain('resource=unknown');
    expect(evidence({ 'x-ratelimit-resource': 'audit_log' })).toContain('resource=unknown');
    expect(evidence({ 'x-ratelimit-resource': 'code_scanning_upload' })).toContain(
      'resource=code_scanning_upload',
    );
    expect(evidence({ 'x-ratelimit-resource': `core ${SECRET}` })).toContain('resource=unknown');
    expect(evidence({ 'x-ratelimit-resource': `core ${SECRET}` })).not.toContain(SECRET);
  });

  it('retry-after 接受等待秒数或 HTTP 日期，畸形仍是 unknown', () => {
    expect(evidence({ 'retry-after': '60' })).toContain('retry-after=seconds:60');
    expect(evidence({ 'retry-after': '0' })).toContain('retry-after=seconds:0');
    expect(evidence({ 'retry-after': 'Mon, 19 Oct 2026 19:40:00 GMT' })).toContain(
      'retry-after=http-date:2026-10-19T19:40:00.000Z',
    );
    expect(evidence({ 'retry-after': 'Sun Nov  6 08:49:37 1994' })).toContain(
      'retry-after=http-date:1994-11-06T08:49:37.000Z',
    );
    expect(evidence({ 'retry-after': '' })).toContain('retry-after=unknown');
    for (const raw of ['60.5', '-1', ' 60', '00', 'Sunday, 06-Nov-94 08:49:37 GMT', `60 ${SECRET}`]) {
      const text = evidence({ 'retry-after': raw });
      expect(text).toContain('retry-after=unknown');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(raw);
    }
  });

  it('缺头、坏数字、坏日期、坏 request-id 都是 unknown，不换成 0 或今天', () => {
    const today = new Date().toISOString().slice(0, 10);
    const missing = evidence();
    expect(missing).toContain('阶段=响应已收到');
    expect(missing).not.toContain('阶段=响应未收到');
    for (const field of ['date', 'limit', 'remaining', 'reset', 'resource', 'retry-after', 'request-id']) {
      expect(missing).toContain(`${field}=unknown`);
    }
    expect(missing).not.toContain('remaining=0');
    expect(missing).not.toContain(today);

    const broken = evidence({
      date: 'Tue, 19 Oct 2026 19:33:08 GMT',
      'x-ratelimit-limit': '00',
      'x-ratelimit-remaining': '1.5',
      'x-ratelimit-reset': '1792441800abc',
      'x-ratelimit-resource': 'not-a-resource',
      'retry-after': 'Mon, 32 Oct 2026 00:00:00 GMT',
      'x-github-request-id': 'not-a-request-id',
    });
    expect(broken).toContain('date=unknown');
    expect(broken).toContain('limit=unknown');
    expect(broken).toContain('remaining=unknown');
    expect(broken).toContain('reset=unknown');
    expect(broken).toContain('resource=unknown');
    expect(broken).toContain('retry-after=unknown');
    expect(broken).toContain('request-id=unknown');
    expect(broken).not.toContain(today);
    expect(broken).not.toContain('19:33:08');
  });

  it('旧式 HTTP 日期只用本次响应 Date 解两位年份，缺锚点不猜本机时钟', () => {
    expect(
      evidence({
        date: 'Mon, 19 Oct 2026 19:25:25 GMT',
        'retry-after': 'Sunday, 06-Nov-94 08:49:37 GMT',
      }),
    ).toContain('retry-after=http-date:1994-11-06T08:49:37.000Z');
    for (const date of [null, 'not-a-date', 'Sunday, 06-Nov-94 08:49:37 GMT']) {
      expect(evidence({ date, 'retry-after': 'Sunday, 06-Nov-94 08:49:37 GMT' })).toContain(
        'retry-after=unknown',
      );
    }
    expect(
      evidence({
        date: 'Mon, 19 Oct 2026 19:25:25 GMT',
        'retry-after': 'Monday, 06-Nov-94 08:49:37 GMT',
      }),
    ).toContain('retry-after=unknown');
    expect(
      evidence({
        date: 'Mon, 19 Oct 2026 19:25:25 GMT',
        'retry-after': 'Saturday, 06-Nov-76 08:49:37 GMT',
      }),
    ).toContain('retry-after=http-date:1976-11-06T08:49:37.000Z');
  });

  it('超长或夹着合成 secret 的头不进文本，也不遍历白名单以外的头', () => {
    const bulky = `${SECRET}${'x'.repeat(400)}`;
    const text = evidence({
      date: bulky,
      'x-ratelimit-limit': bulky,
      'x-ratelimit-remaining': `0\nBearer ${SECRET}`,
      'x-ratelimit-reset': bulky,
      'x-ratelimit-resource': bulky,
      'retry-after': bulky,
      'x-github-request-id': bulky,
      cookie: `session=${SECRET}`,
      authorization: `Bearer ${SECRET}`,
      'x-unlisted-secret': SECRET,
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('x'.repeat(40));
    expect(text).not.toContain('cookie');
    expect(text).not.toContain('authorization');
    expect(text).not.toContain('x-unlisted-secret');
    expect(text.length).toBeLessThan(500);
  });

  it('reset=0 是 1970 的事实，不是缺字段被填成现在', () => {
    expect(evidence({ 'x-ratelimit-reset': '0' })).toContain('reset=0 utc=1970-01-01T00:00:00.000Z');
    expect(evidence({ 'x-ratelimit-reset': '253402300800' })).toContain('reset=unknown');
  });

  it('前缀原样保留，证据只接在后面', () => {
    const suffix = evidence({ 'x-ratelimit-remaining': '0' });
    expect(appendResponseEvidence('GitHub 回了 403', headers({ 'x-ratelimit-remaining': '0' }))).toBe(
      `GitHub 回了 403；${suffix}`,
    );
  });
});

describe('GitHub 响应证据：没有响应', () => {
  it('网络或超时只标明响应未收到，不伪造头，不抄错误原文', () => {
    const leaked = new TypeError(`fetch failed ${SECRET} https://api.example/x?access_token=${SECRET}`, {
      cause: { code: 'ECONNRESET' },
    });
    const text = githubTransportEvidence(leaked);
    expect(text.startsWith('阶段=响应未收到；name=TypeError；code=ECONNRESET；')).toBe(true);
    expect(text).not.toContain('阶段=响应已收到');
    expect(text).toContain('date=unknown');
    expect(text).toContain('remaining=unknown');
    expect(text).toContain('reset=unknown');
    expect(text).not.toContain('remaining=0');
    expect(text).not.toContain('utc=');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('fetch failed');
    expect(text).toContain('detail=unknown');

    const safe = new Error('GitHub 的 gh 请求没完成（进程不可用、超时或输出超限）。');
    expect(githubTransportEvidence(safe)).toContain(
      'detail=GitHub 的 gh 请求没完成（进程不可用、超时或输出超限）。',
    );
    expect(text).not.toContain('access_token');

    const timeout = new Error(`aborted ${SECRET}`);
    timeout.name = 'TimeoutError';
    const timed = githubTransportEvidence(timeout);
    expect(timed).toContain('阶段=响应未收到');
    expect(timed).toContain('name=TimeoutError');
    expect(timed).toContain('code=unknown');
    expect(timed).not.toContain(SECRET);

    const badCode = new Error('x');
    (badCode as Error & { code: string }).code = `ECONNRESET ${SECRET}`;
    expect(githubTransportEvidence(badCode)).toContain('code=unknown');
    expect(githubTransportEvidence(badCode)).not.toContain(SECRET);
    const asciiSecret = new Error('hidden');
    asciiSecret.name = 'SyntheticSecret3335';
    (asciiSecret as Error & { code: string }).code = 'SYNTHETIC_SECRET_3335';
    const rejected = githubTransportEvidence(asciiSecret);
    expect(rejected).toContain('name=unknown');
    expect(rejected).toContain('code=unknown');
    expect(rejected).not.toContain('SyntheticSecret3335');
    expect(rejected).not.toContain('SYNTHETIC_SECRET_3335');
    expect(githubTransportEvidence('down')).toContain('name=unknown');
    expect(appendTransportEvidence('连不上 GitHub', leaked)).toBe(`连不上 GitHub；${text}`);
  });
});
