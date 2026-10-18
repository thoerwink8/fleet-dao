import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  latestPolicyStatus,
  parsePolicyUrl,
  policyHead,
  policyRepo,
} from '../../shared/src/ci-policy-bridge.ts';
import { policyReader, readPolicyHttp } from '../src/ci-policy-bridge.ts';
import { type GhApi, ghApi } from '../src/gh-api.ts';
import { gateGitHub, gatePr, runMergeGate, targetPrs } from '../src/merge-gate.ts';
import { runChild } from './child.ts';

const sha = 'a'.repeat(40);
const slug = 'acme/widgets';
const endpoint = 'https://policy.example.test/api/public/ci-policy/v1/repos/123';
const sourceUrl = `${endpoint}?pr=7&head=${sha}`;
const repoRaw = { id: 123, full_name: slug, private: false };
const prRaw = {
  number: 7,
  state: 'open',
  body: '',
  head: { ref: 'fleet/2997-t12345678', sha, repo: { id: 123, full_name: slug } },
  base: { repo: { id: 123, full_name: slug } },
};
const status = (over: Record<string, unknown> = {}) => ({
  id: 20,
  context: 'fleet-ci-policy-source/pr/7',
  state: 'success',
  url: `https://api.github.com/repos/${slug}/statuses/${sha}`,
  target_url: sourceUrl,
  creator: { id: 99, type: 'Bot' },
  ...over,
});
const response = (mode: 'force' | 'off' = 'off') =>
  new Response(JSON.stringify({ version: 1, repo: slug, githubId: 123, ciPolicy: mode }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
function fixture(over: { repo?: unknown; pr?: unknown; statuses?: unknown[] } = {}) {
  const api: GhApi = {
    get: vi.fn(async (path) => {
      if (path === '') return over.repo ?? repoRaw;
      if (path === '/pulls/7') return over.pr ?? prRaw;
      if (path.startsWith(`/commits/${sha}/statuses`)) return over.statuses ?? [status()];
      if (path.startsWith('/pulls?')) return [over.pr ?? prRaw];
      if (path.startsWith('/pulls/7/files')) return [];
      throw new Error(`unexpected ${path}`);
    }),
    globalGet: vi.fn(async () => ({ id: 99, type: 'Bot', login: 'fleet-dao-engine[bot]' })),
    getOrNull: async () => null,
    post: vi.fn(async () => {}),
  };
  const gh = gateGitHub(api);
  const http = vi.fn<typeof fetch>(async () => response());
  return { api, gh, http, reader: policyReader(api, gh, slug, http) };
}
function temp() {
  mkdirSync('_tmp', { recursive: true });
  return mkdtempSync(resolve('_tmp/2997-bridge-'));
}

describe('可信 source 与真实 HTTPS reader', () => {
  it('公开转私有即走 force，历史 off source 不跟随；有 cold 可沿原闸通过', async () => {
    const f = fixture({
      repo: { ...repoRaw, private: true },
      statuses: [status(), { context: 'cold-verify', state: 'success' }],
    });
    const statuses = vi.spyOn(f.gh, 'statuses');
    expect(await f.reader(7, sha)).toBe('force');
    expect(statuses).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
    expect((await gatePr(7, { gh: f.gh, readCiPolicy: f.reader })).state).toBe('success');
    expect(f.http).not.toHaveBeenCalled();
  });
  it('只由可信数字Bot选择固定URL，HTTP无凭据，真实off可读', async () => {
    const f = fixture();
    expect(await f.reader(7, sha)).toBe('off');
    expect(f.api.globalGet).toHaveBeenCalledWith('/users/fleet-dao-engine%5Bbot%5D');
    expect(f.http).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'no-store' }),
    );
    expect(new Headers(f.http.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  });
  it('无source只force；伪造context/错数字writer不能放off；latest可信坏不退旧绿', async () => {
    expect(await fixture({ statuses: [] }).reader(7, sha)).toBe('force');
    for (const statuses of [
      [status({ creator: { id: 1, type: 'Bot' } })],
      [status({ state: 'failure' }), status({ id: 19 })],
    ]) {
      const f = fixture({ statuses });
      await expect(f.reader(7, sha)).rejects.toThrow();
      expect(f.http).not.toHaveBeenCalled();
    }
  });
  it('可信用户读口返回了别人的 login 时不可借数字身份放行', async () => {
    const f = fixture();
    f.api.globalGet = async () => ({ id: 99, type: 'Bot', login: 'other[bot]' });
    await expect(policyReader(f.api, f.gh, slug, f.http)(7, sha)).rejects.toThrow('数字身份');
    expect(f.http).not.toHaveBeenCalled();
  });
  it('新的正确source能修复旧坏source；仍不能回退到旧正确source', () => {
    const repo = policyRepo(repoRaw);
    expect(
      latestPolicyStatus(
        [status(), status({ id: 19, url: 'bad', state: 'nonsense', target_url: 'bad' })],
        repo,
        sha,
        99,
        'fleet-ci-policy-source/pr/7',
      )?.id,
    ).toBe(20);
    expect(() =>
      latestPolicyStatus(
        [status({ url: 'bad' }), status({ id: 19 })],
        repo,
        sha,
        99,
        'fleet-ci-policy-source/pr/7',
      ),
    ).toThrow('URL');
  });
  it.each([
    { repo: { ...repoRaw, id: 124 } },
    { repo: { ...repoRaw, private: undefined } },
    { statuses: [status({ creator: { id: 99, type: 'User' } })] },
    { statuses: [status({ url: `https://api.github.com/repos/other/repo/statuses/${sha}` })] },
    { statuses: [status({ target_url: `${sourceUrl}&mode=off` })] },
    { statuses: [status({ target_url: sourceUrl.replace('pr=7', 'pr=8') })] },
    { pr: { ...prRaw, head: { ...prRaw.head, repo: { id: 456, full_name: 'other/fork' } } } },
  ])('错误repo/private/creator/head/URL拒绝 %j', async (over) => {
    const f = fixture(over);
    await expect(f.reader(7, sha)).rejects.toThrow();
    expect(f.http).not.toHaveBeenCalled();
  });
  it('必须完整分页；下一页失败不拿已找到的off source放行', async () => {
    const f = fixture();
    const original = f.api.get;
    f.api.get = async (path) => {
      if (path.includes('/statuses?')) {
        if (path.endsWith('page=2')) throw new Error('page2 unavailable');
        return [status(), ...Array.from({ length: 99 }, () => ({ context: 'unrelated' }))];
      }
      return original(path);
    };
    await expect(policyReader(f.api, gateGitHub(f.api), slug, f.http)(7, sha)).rejects.toThrow('page2');
    expect(f.http).not.toHaveBeenCalled();
  });
  it.each([
    'http://policy.example.test',
    'https://user@policy.example.test',
    'https://policy.example.test:8443',
  ])('不接受不规范authority %s', (origin) => {
    expect(() =>
      parsePolicyUrl(
        origin + sourceUrl.slice(sourceUrl.indexOf('/api/')),
        123,
        policyHead(prRaw, policyRepo(repoRaw)),
      ),
    ).toThrow();
  });
  it.each([
    () => new Response('{}', { status: 302 }),
    () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response('{}', { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } }),
    () =>
      new Response('x'.repeat(4097), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
    () =>
      new Response('{"version":1,"githubId":123,"repo":"other/repo","ciPolicy":"off"}', {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
  ])('HTTP错误/HTML/缓存/超限/串仓都失败，不用旧off', async (make) => {
    await expect(
      readPolicyHttp(sourceUrl, { githubId: 123, repo: slug }, async () => make()),
    ).rejects.toThrow();
  });
  it('source事件两层过滤后的入口全PR重算', async () => {
    expect(await targetPrs('status', { context: 'fleet-ci-policy-source/pr/7' }, fixture().gh)).toEqual([7]);
    for (const suffix of ['0', '01', '-1', '1.2', '9007199254740992', '7/extra'])
      expect(
        await targetPrs('status', { context: `fleet-ci-policy-source/pr/${suffix}` }, fixture().gh),
      ).toMatch(/正安全整数/);
    expect(await targetPrs('status', { context: 'fleet-ci-policy-source' }, fixture().gh)).toEqual([]);
  });
});

describe('实际入口收口', () => {
  it('gate发表前DB off变force，不能把先前off结论写绿', async () => {
    const dir = temp();
    try {
      const eventPath = resolve(dir, 'event.json');
      writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
      const f = fixture();
      let reads = 0;
      const r = await runMergeGate({
        eventName: 'pull_request_target',
        eventPath,
        gh: f.gh,
        write: true,
        readCiPolicy: async () => (++reads === 1 ? 'off' : 'force'),
      });
      expect(r.code).toBe(2);
      expect(f.api.post).toHaveBeenCalledWith(
        `/statuses/${sha}`,
        expect.objectContaining({ state: 'failure' }),
      );
      expect(f.api.post).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ state: 'success' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('真实Node bin零安装接通GitHub身份/source -> HTTP -> merge-gate success，无caller模式输入', {
    timeout: 0,
  }, () => {
    const dir = temp();
    try {
      const event = resolve(dir, 'event.json'),
        preload = resolve(dir, 'fetch.mjs'),
        output = resolve(dir, 'posts.json');
      writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
      writeFileSync(
        preload,
        `import {writeFileSync} from 'node:fs';
const posts=[];globalThis.fetch=async(url,init)=>{url=String(url);let data;
if(url.startsWith('https://policy.example.test/')){if(new Headers(init.headers).has('authorization')||init.redirect!=='error')throw Error('credential/redirect leak');data={version:1,repo:${JSON.stringify(slug)},githubId:123,ciPolicy:'off'};return new Response(JSON.stringify(data),{headers:{'content-type':'application/json','cache-control':'no-store'}});}
if(init.method==='POST'){posts.push(JSON.parse(init.body));writeFileSync(${JSON.stringify(output)},JSON.stringify(posts));return new Response('{}');}
if(url.includes('/users/'))data={id:99,type:'Bot',login:'fleet-dao-engine[bot]'};
else if(url.includes('/pulls/7/files'))data=[];
else if(url.includes('/pulls/7'))data=${JSON.stringify(prRaw)};
else if(url.includes('/statuses?'))data=[${JSON.stringify(status())}];
else if(url==='https://api.github.com/repos/acme/widgets')data=${JSON.stringify(repoRaw)};
else throw Error('unexpected URL '+url);return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});};`,
      );
      const result = runChild(
        process.execPath,
        ['--import', pathToFileURL(preload).href, 'packages/conventions/src/bin/merge-gate.ts'],
        {
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: 'pull_request_target',
            GITHUB_EVENT_PATH: event,
            GITHUB_REPOSITORY: slug,
            GITHUB_API_URL: 'https://api.github.com',
            GITHUB_TOKEN: 'test-token',
            GITHUB_ACTIONS: 'false',
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('merge-gate success');
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual([
        expect.objectContaining({ context: 'merge-gate', state: 'success' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('生产ghApi的global读口与repo读口保持分离', async () => {
    const http = vi.fn<typeof fetch>(async () => new Response('{}'));
    const api = ghApi({ GITHUB_REPOSITORY: slug, GITHUB_TOKEN: 'test-token' }, http);
    await api.globalGet?.('/users/fleet-dao-engine%5Bbot%5D');
    expect(String(http.mock.calls[0]?.[0])).toBe('https://api.github.com/users/fleet-dao-engine%5Bbot%5D');
  });
});
