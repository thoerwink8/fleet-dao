import type { Db } from '@fleet-dao/db';
import type { createGitHub } from '@fleet-dao/github';
import { silentLogger } from '@fleet-dao/store';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { githubMirror } from '../src/github-mirror.ts';
import { harness, IDS, write } from './harness.ts';

function githubFixture() {
  const sink = { accept: vi.fn(async () => {}) };
  const releaseFacts = { mainlineHead: vi.fn(async () => 'a'.repeat(40)) };
  const selfCheck = vi.fn(async () => []);
  const readIssueState = vi.fn(async () => 'open');
  // 只替换 GitHub 传输/凭据创建；跑 main 实际使用的完整装配函数。
  const make = vi.fn(() => ({
    deps: { client: {}, bots: {} },
    client: {},
    claims: {},
    eventSink: () => sink,
    releaseFacts,
    selfCheck,
    readIssueState,
  })) as unknown as typeof createGitHub;
  return { make, sink, releaseFacts, selfCheck, readIssueState };
}

describe('生产 GitHub 功能与公开策略桥装配隔离', () => {
  it('合法 dev 默认 HTTP origin 仅缺桥，其余 GitHub 能力保留，公开读写明确503', async () => {
    const config = loadConfig({ FLEET_ENV: 'development' });
    const f = githubFixture();
    const result = githubMirror({} as Db, config.publicUrl, silentLogger, true, f.make);
    expect(result.credentialsMissing).toBeUndefined();
    expect(result.ciPolicyBridge).toBeUndefined();
    expect(result.releaseFacts).toBe(f.releaseFacts);
    expect(await result.selfCheck?.([])).toEqual([]);
    expect(result.requestIssues?.openIssue).toBeTypeOf('function');
    expect(result.installationRepos?.list).toBeTypeOf('function');
    expect(result.decisionCommenter?.comment).toBeTypeOf('function');
    await result.sink.accept({
      deliveryId: 'test',
      source: 'webhook',
      repo: 'example/canary',
      event: 'status',
      payload: {},
      wake: false,
      receivedAt: new Date().toISOString(),
    });
    expect(f.sink.accept).toHaveBeenCalledOnce();
    const h = harness();
    h.deps.github = result.sink;
    expect((await h.cockpit.request('/api/public/ci-policy/v1/repos/123')).status).toBe(503);
    const session = await h.login();
    expect(
      (await h.cockpit.request(`/api/repos/${IDS.repo}/ci-policy`, write('PUT', session, { mode: 'off' })))
        .status,
    ).toBe(503);
  });

  it('生产 origin 不支持时明确抛桥初始化失败，不混成凭据缺失；规范 HTTPS 正常装配', () => {
    const f = githubFixture();
    expect(() =>
      githubMirror({} as Db, new URL('http://localhost:5173'), silentLogger, false, f.make),
    ).toThrow('CI 策略桥初始化失败');
    expect(
      githubMirror({} as Db, new URL('https://cockpit.example.test'), silentLogger, false, f.make)
        .ciPolicyBridge,
    ).toBeDefined();
  });
});
