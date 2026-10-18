import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptanceGate, acceptanceOriginForPull } from '../src/acceptance-gate.ts';

afterEach(() => vi.unstubAllEnvs());
const repo = 'https://api.github.com/repos/o/r';
const gh = async () => ({
  code: 0,
  stdout: JSON.stringify({ id: 1, full_name: 'o/r', private: false }),
  stderr: '',
});
const row = {
  id: 1,
  generation: 2,
  repo: 'o/r',
  issueNumber: 7,
  prNumber: 9,
  head: 'a'.repeat(40),
  mergeCommit: 'b'.repeat(40),
  settledAt: null,
  settledBy: null,
  settleEvidence: null,
};
const fetchRows = (duties: unknown[], over = {}) =>
  (async () =>
    new Response(JSON.stringify({ version: 1, githubId: 1, repo: 'o/r', issueNumber: 7, duties, ...over }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })) as typeof fetch;
describe('DB最终验收可信读', () => {
  it('open拒关，可信精确已验可收尾，普通空责任照旧', async () => {
    vi.stubEnv('FLEET_PUBLIC_URL', 'https://example.org');
    expect(await acceptanceGate(gh, repo, 7, fetchRows([row]))).toContain('未结清');
    expect(
      await acceptanceGate(
        gh,
        repo,
        7,
        fetchRows([
          { ...row, settledAt: '2026-10-18T10:00:00Z', settledBy: 'ops', settleEvidence: '现场记录' },
        ]),
      ),
    ).toBeUndefined();
    expect(await acceptanceGate(gh, repo, 7, fetchRows([]))).toBeUndefined();
  });
  it('跨仓、跨issue、坏代次、缺证据、网络失败全部unknown', async () => {
    vi.stubEnv('FLEET_PUBLIC_URL', 'https://example.org');
    for (const duties of [
      [{ ...row, repo: 'evil/r' }],
      [{ ...row, generation: 0 }],
      [{ ...row, issueNumber: 8 }],
      [{ ...row, settledAt: '2026-10-18T10:00:00Z', settledBy: 'ops', settleEvidence: '' }],
    ])
      await expect(acceptanceGate(gh, repo, 7, fetchRows(duties))).rejects.toThrow();
    await expect(acceptanceGate(gh, repo, 7, fetchRows([], { issueNumber: 8 }))).rejects.toThrow();
    await expect(
      acceptanceGate(gh, repo, 7, (async () => {
        throw new Error('refused');
      }) as typeof fetch),
    ).rejects.toThrow('refused');
  });
});

describe('Actions真实来源路径', () => {
  it('无仓变量仍可由可信App精确PR/head找到origin，伪Bot与错head不授权', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('FLEET_PUBLIC_URL', '');
    const sha = 'a'.repeat(40);
    let writer = 55;
    let urlHead = sha;
    const gh = async (args: string[]) => {
      const path = args[1];
      const r = { id: 1, full_name: 'o/r', private: false };
      const raw =
        path === 'repos/{owner}/{repo}'
          ? r
          : path?.includes('/pulls/')
            ? { number: 9, state: 'closed', head: { sha, repo: r }, base: { repo: r } }
            : path?.startsWith('users/')
              ? { id: 55, type: 'Bot', login: 'fleet-dao-engine[bot]' }
              : [
                  {
                    id: 8,
                    context: 'fleet-ci-policy-source/pr/9',
                    creator: { id: writer, type: 'Bot' },
                    state: 'success',
                    url: `https://api.github.com/repos/o/r/statuses/${sha}`,
                    target_url: `https://example.org/api/public/ci-policy/v1/repos/1?pr=9&head=${urlHead}`,
                  },
                ];
      return { code: 0, stdout: JSON.stringify(raw), stderr: '' };
    };
    expect(await acceptanceOriginForPull(gh, 9)).toBe('https://example.org');
    writer = 56;
    await expect(acceptanceOriginForPull(gh, 9)).rejects.toThrow();
    writer = 55;
    urlHead = 'b'.repeat(40);
    await expect(acceptanceOriginForPull(gh, 9)).rejects.toThrow();
  });
});

describe('有界完整读取', () => {
  it('支持大于旧policy上限的完整验收账，超限或重复身份明确unknown', async () => {
    vi.stubEnv('FLEET_PUBLIC_URL', 'https://example.org');
    const settled = {
      ...row,
      settledAt: '2026-10-18T10:00:00Z',
      settledBy: 'ops',
      settleEvidence: 'x'.repeat(6000),
    };
    expect(await acceptanceGate(gh, repo, 7, fetchRows([settled]))).toBeUndefined();
    await expect(acceptanceGate(gh, repo, 7, fetchRows([row, row]))).rejects.toThrow();
    await expect(
      acceptanceGate(gh, repo, 7, fetchRows([{ ...settled, settleEvidence: 'x'.repeat(1024 * 1024) }])),
    ).rejects.toThrow('过大');
  });
});
