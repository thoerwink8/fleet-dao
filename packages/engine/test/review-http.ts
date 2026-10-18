// 本包内的受控HTTP边界；client、App令牌装配和claims均用生产实现，不读其他包的测试文件。
import { generateKeyPairSync } from 'node:crypto';
import { type AppCredentials, type AppRole, createGitHub, memoryLedger } from '@fleet-dao/github';

export const API = 'https://api.github.test';
export const repo = { owner: 'acme', name: 'widgets' };
export const sha = (c: string) => c.repeat(40).slice(0, 40);
export const json = (status: number, data: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const apps = Object.fromEntries(
  ['agent', 'engine'].map((role, i) => [
    role,
    {
      role,
      appId: i + 1,
      slug: `fixture-${role}`,
      privateKey,
      source: 'test-generated',
    },
  ]),
) as Record<AppRole, AppCredentials>;
export interface ReviewRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  as: string;
}

export function setup() {
  const requests: ReviewRequest[] = [];
  const before: ((r: ReviewRequest) => Response | undefined)[] = [];
  const permissions = {
    metadata: 'read',
    pull_requests: 'write',
    contents: 'write',
    issues: 'write',
    statuses: 'write',
    checks: 'read',
    administration: 'write',
  };
  const gh = createGitHub({
    apps,
    ledger: memoryLedger(),
    apiUrl: API,
    env: {},
    now: () => new Date('2026-10-18T00:00:00Z'),
    sleep: async () => undefined,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== API) throw Error(`fixture HTTP越界 ${url.origin}`);
      const request = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        as:
          new Headers(init?.headers).get('authorization') === 'Bearer fixture-engine-token'
            ? 'engine'
            : 'app',
      };
      requests.push(request);
      for (const hook of before) {
        const result = hook(request);
        if (result) return result;
      }
      if (request.path === '/repos/acme/widgets/installation') return json(200, { id: 1, permissions });
      if (request.path === '/app/installations/1/access_tokens')
        return json(201, {
          token: 'fixture-engine-token',
          expires_at: '2026-10-18T01:00:00Z',
          permissions,
        });
      throw Error(`fixture未准备HTTP ${request.method} ${url.pathname}`);
    },
  });
  return { gh, fake: { before, requests } };
}
