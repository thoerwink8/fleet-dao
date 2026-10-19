import { describe, expect, it } from 'vitest';
import { POLICY_READ_ATTEMPTS, readPolicyHttp } from '../src/ci-policy-bridge.ts';

// #3268：Actions 读策略来源偶发 10 秒超时、请求根本没到入口；只对没收到响应的网络失败重读一次。
const slug = 'acme/widgets';
const repo = { githubId: 123, repo: slug };
const url = `https://policy.example.test/api/public/ci-policy/v1/repos/123?pr=7&head=${'a'.repeat(40)}`;
const ok = () =>
  new Response(JSON.stringify({ version: 1, repo: slug, githubId: 123, ciPolicy: 'force' }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const netError = (code: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

function scripted(steps: Array<() => Response | Error>) {
  const inits: RequestInit[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    inits.push(init);
    const step = steps[inits.length - 1];
    if (!step) throw new Error('多读了一次');
    const out = step();
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { impl, inits };
}

describe('策略来源读取只对网络失败重读', () => {
  it('最多读两次', () => {
    expect(POLICY_READ_ATTEMPTS).toBe(2);
  });

  it.each([
    ['10 秒超时', timeout],
    ['DNS 暂时失败', () => netError('EAI_AGAIN')],
    ['连接被重置', () => netError('ECONNRESET')],
    ['连接超时', () => netError('UND_ERR_CONNECT_TIMEOUT')],
  ])('%s后第二次读成就用第二次的即时结果', async (_name, fail) => {
    const { impl, inits } = scripted([fail, ok]);
    expect((await readPolicyHttp(url, repo, impl, 0)).ciPolicy).toBe('force');
    expect(inits).toHaveLength(2);
  });

  it('每次都是新的 10 秒合同：两次的 signal 各自独立，第一次超时不连累第二次', async () => {
    const { impl, inits } = scripted([timeout, ok]);
    await readPolicyHttp(url, repo, impl, 0);
    expect(inits[0]?.signal).not.toBe(inits[1]?.signal);
    expect(inits[1]?.signal?.aborted).toBe(false);
    for (const init of inits)
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
  });

  it('两次都超时：明确失败并说读了几次，不回退任何策略', async () => {
    const { impl, inits } = scripted([timeout, timeout]);
    await expect(readPolicyHttp(url, repo, impl, 0)).rejects.toThrow(/读了 2 次都没收到响应：.*timeout/);
    expect(inits).toHaveLength(2);
  });

  it.each([
    ['重定向被拒', () => new TypeError('fetch failed', { cause: new Error('unexpected redirect') })],
    ['认不出的错', () => new Error('boom')],
  ])('%s不重读', async (_name, fail) => {
    const { impl, inits } = scripted([fail, ok]);
    await expect(readPolicyHttp(url, repo, impl, 0)).rejects.toThrow();
    expect(inits).toHaveLength(1);
  });

  it.each([
    ['HTTP 503', () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })],
    [
      '可缓存的响应',
      () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
        }),
    ],
    [
      '串仓',
      () =>
        new Response(JSON.stringify({ version: 1, repo: 'other/repo', githubId: 123, ciPolicy: 'off' }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        }),
    ],
  ])('收到了响应（%s）就照原样判，不重读', async (_name, make) => {
    const { impl, inits } = scripted([make, ok]);
    await expect(readPolicyHttp(url, repo, impl, 0)).rejects.toThrow();
    expect(inits).toHaveLength(1);
  });
});
