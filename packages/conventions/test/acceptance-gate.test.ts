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
  state: 'open',
  supersededAt: null,
  supersededBy: null,
  supersedeEvidence: null,
  successorId: null,
  successorGeneration: null,
};
const done = {
  settledAt: '2026-10-18T10:00:00Z',
  settledBy: 'ops',
  settleEvidence: '现场记录',
  state: 'settled',
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
    expect(await acceptanceGate(gh, repo, 7, fetchRows([{ ...row, ...done }]))).toBeUndefined();
    expect(await acceptanceGate(gh, repo, 7, fetchRows([]))).toBeUndefined();
  });
  it('跨仓、跨issue、坏代次、缺证据、网络失败全部unknown', async () => {
    vi.stubEnv('FLEET_PUBLIC_URL', 'https://example.org');
    for (const duties of [
      [{ ...row, repo: 'evil/r' }],
      [{ ...row, generation: 0 }],
      [{ ...row, issueNumber: 8 }],
      [{ ...row, ...done, settleEvidence: '' }],
      [{ ...row, state: undefined }],
      [{ ...row, state: 'closed' }],
      [{ ...row, ...done, state: 'open' }],
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

describe('旧头替代收口后的关闭判定（#3114）', () => {
  const final = { ...row, id: 2, generation: 3, head: 'c'.repeat(40), ...done };
  const old = {
    ...row,
    id: 1,
    mergeCommit: null,
    state: 'superseded',
    supersededAt: '2026-10-18T11:00:00Z',
    supersededBy: 'ops:acceptance:frank',
    supersedeEvidence: 'PR 最终头已合已验',
    successorId: 2,
    successorGeneration: 3,
  };
  it('旧头被替代、最终头已验：放行关单；旧头仍 open 或替代已过期（读口回 open）照旧拦', async () => {
    vi.stubEnv('FLEET_PUBLIC_URL', 'https://example.org');
    expect(await acceptanceGate(gh, repo, 7, fetchRows([old, final]))).toBeUndefined();
    expect(await acceptanceGate(gh, repo, 7, fetchRows([{ ...old, ...row, id: 1 }, final]))).toContain(
      '未结清',
    );
    // 目标后来新增项：读口把目标和旧头都算回 open
    expect(
      await acceptanceGate(
        gh,
        repo,
        7,
        fetchRows([
          { ...old, state: 'open' },
          { ...final, generation: 4, state: 'open', settledAt: null, settledBy: null, settleEvidence: null },
        ]),
      ),
    ).toContain('未结清');
  });
  it('有效替代保留历史合并字段：不能把旧值当旧头已合证明，也不能挡住最终责任收口', async () => {
    vi.stubEnv('FLEET_PUBLIC_URL', 'https://example.org');
    for (const mergeCommit of [null, final.mergeCommit, 'd'.repeat(40)])
      expect(await acceptanceGate(gh, repo, 7, fetchRows([{ ...old, mergeCommit }, final]))).toBeUndefined();
    // 源字段存在不能代替最终头的合并回执，不能放过仍未验的目标。
    await expect(
      acceptanceGate(
        gh,
        repo,
        7,
        fetchRows([
          { ...old, mergeCommit: final.mergeCommit },
          { ...final, mergeCommit: null },
        ]),
      ),
    ).rejects.toThrow('最终验收');
    await expect(
      acceptanceGate(
        gh,
        repo,
        7,
        fetchRows([
          { ...old, mergeCommit: final.mergeCommit },
          { ...final, state: 'open', settledAt: null },
        ]),
      ),
    ).rejects.toThrow();
  });
  it('替代证据缺失、指向对不上（目标缺、代次不符、非已验、不同 PR、同头）、冒充完成回执：不放行', async () => {
    vi.stubEnv('FLEET_PUBLIC_URL', 'https://example.org');
    for (const duties of [
      [old],
      [old, { ...final, generation: 4 }],
      [old, { ...final, state: 'open', settledAt: null, settledBy: null, settleEvidence: null }],
      [old, { ...final, prNumber: 10 }],
      [old, { ...final, head: old.head }],
      [{ ...old, supersedeEvidence: ' ' }, final],
      [{ ...old, supersededBy: null }, final],
      [{ ...old, successorId: null }, final],
      [{ ...old, mergeCommit: 'not-a-sha' }, final],
      [{ ...old, mergeCommit: undefined }, final],
      [{ ...old, settledAt: '2026-10-18T10:00:00Z' }, final],
    ])
      await expect(acceptanceGate(gh, repo, 7, fetchRows(duties))).rejects.toThrow();
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
      ...done,
      settleEvidence: 'x'.repeat(6000),
    };
    expect(await acceptanceGate(gh, repo, 7, fetchRows([settled]))).toBeUndefined();
    await expect(acceptanceGate(gh, repo, 7, fetchRows([row, row]))).rejects.toThrow();
    await expect(
      acceptanceGate(gh, repo, 7, fetchRows([{ ...settled, settleEvidence: 'x'.repeat(1024 * 1024) }])),
    ).rejects.toThrow('过大');
  });
});
