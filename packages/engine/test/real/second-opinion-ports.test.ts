// 先审后合（#253）：这个 PR 碰没碰高风险路径（checkHighRisk）、第二意见的结论写回 GitHub（postSecondOpinion）。
// github 包本身换成假的（记下每次调用）；三态纪律：清单读不到、翻不完页、贴状态没权限都要明确抛错，不当「没碰到」「贴上了」。
import { describe, expect, it, vi } from 'vitest';
import type { PortContext } from '../../src/ports.ts';
import { createGitHubPorts, type EngineGitHub } from '../../src/real/github-ports.ts';

const ctx: PortContext = {
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
};
const repo = {
  id: 'repo-1',
  owner: 'acme',
  name: 'widgets',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const scope = { taskId: 'task-1' };

const RISK_JSON = JSON.stringify({
  说明: '测试',
  paths: [{ path: 'packages/api/src/auth.ts', kind: '碰安全', why: '登录鉴权' }],
});

function setup(
  over: {
    readRepoFile?: EngineGitHub['readRepoFile'];
    pullFiles?: EngineGitHub['pullFiles'];
    setStatus?: EngineGitHub['claims']['setStatus'];
    commentPull?: EngineGitHub['claims']['commentPull'];
  } = {},
) {
  const setStatus = over.setStatus ?? vi.fn(async () => undefined);
  const commentPull =
    over.commentPull ?? vi.fn(async () => ({ commentId: 1, url: 'https://x/comment/1', created: true }));
  const gh = {
    readRepoFile:
      over.readRepoFile ??
      (async () => ({
        defaultBranch: 'main',
        commit: 'a'.repeat(40),
        file: { kind: 'text', text: RISK_JSON },
      })),
    pullFiles: over.pullFiles ?? (async () => [{ filename: 'packages/api/src/auth.ts', status: 'modified' }]),
    claims: { setStatus, commentPull } as unknown as EngineGitHub['claims'],
  } as unknown as EngineGitHub;
  const ports = createGitHubPorts({
    gh,
    trees: {} as never,
    exec: {} as never,
    tmpDir: '/tmp/fake',
    archiveDir: '/tmp/fake-archive',
  });
  return { ports, setStatus, commentPull };
}

const RISK_PATHS_FILE = 'packages/conventions/high-risk-paths.json';

describe('checkHighRisk：这个 PR 碰没碰先审后合的路径', () => {
  it('文件落在清单里：命中，带上规则和为什么', async () => {
    const { ports } = setup();
    const res = await ports.checkHighRisk(
      { ...scope, repo, prNumber: 7, riskPathsFile: RISK_PATHS_FILE },
      ctx,
    );
    expect(res.hits).toEqual([
      { file: 'packages/api/src/auth.ts', rule: 'packages/api/src/auth.ts', kind: '碰安全' },
    ]);
  });

  it('文件不在清单里：不命中', async () => {
    const { ports } = setup({ pullFiles: async () => [{ filename: 'docs/design.md', status: 'modified' }] });
    const res = await ports.checkHighRisk(
      { ...scope, repo, prNumber: 7, riskPathsFile: RISK_PATHS_FILE },
      ctx,
    );
    expect(res.hits).toEqual([]);
  });

  it('项目没声明先审后合清单（riskPathsFile 没给）：不查、不请第二意见——不读清单、不翻 PR 文件，直接算没命中', async () => {
    const readRepoFile = vi.fn(async () => ({
      defaultBranch: 'main',
      commit: 'a'.repeat(40),
      file: { kind: 'text' as const, text: RISK_JSON },
    }));
    const pullFiles = vi.fn(async () => [{ filename: 'packages/api/src/auth.ts', status: 'modified' }]);
    const { ports } = setup({ readRepoFile, pullFiles });
    const res = await ports.checkHighRisk({ ...scope, repo, prNumber: 7 }, ctx);
    expect(res.hits).toEqual([]);
    expect(res.note).toMatch(/没声明先审后合清单/);
    expect(readRepoFile).not.toHaveBeenCalled();
    expect(pullFiles).not.toHaveBeenCalled();
  });

  it('【故意造出的失败】主线上读不到清单文件：抛错，不当「没碰到」', async () => {
    const { ports } = setup({
      readRepoFile: async () => ({
        defaultBranch: 'main',
        commit: 'a'.repeat(40),
        file: { kind: 'missing' },
      }),
    });
    await expect(
      ports.checkHighRisk({ ...scope, repo, prNumber: 7, riskPathsFile: RISK_PATHS_FILE }, ctx),
    ).rejects.toMatchObject({
      code: 'RISK_PATHS_MISSING',
    });
  });

  it('【故意造出的失败】清单不是合法的 JSON：抛错，不当「一条都不命中」', async () => {
    const { ports } = setup({
      readRepoFile: async () => ({
        defaultBranch: 'main',
        commit: 'a'.repeat(40),
        file: { kind: 'text', text: '不是 JSON' },
      }),
    });
    await expect(
      ports.checkHighRisk({ ...scope, repo, prNumber: 7, riskPathsFile: RISK_PATHS_FILE }, ctx),
    ).rejects.toMatchObject({
      code: 'RISK_PATHS_INVALID',
    });
  });

  it('【故意造出的失败】PR 改动文件翻不完页：抛错，不当「没碰到」', async () => {
    const { ports } = setup({
      pullFiles: async () => {
        throw new Error('翻到上限还没翻完');
      },
    });
    await expect(
      ports.checkHighRisk({ ...scope, repo, prNumber: 7, riskPathsFile: RISK_PATHS_FILE }, ctx),
    ).rejects.toBeTruthy();
  });
});

describe('postSecondOpinion：第二意见的结论写回 GitHub', () => {
  const hits = [
    { file: 'packages/api/src/auth.ts', rule: 'packages/api/src/auth.ts', kind: '碰安全' as const },
  ];

  it('通过：状态贴 success，评论带结论和头', async () => {
    const { ports, setStatus, commentPull } = setup();
    const res = await ports.postSecondOpinion(
      {
        ...scope,
        repo,
        prNumber: 7,
        head: 'a'.repeat(40),
        round: 1,
        hits,
        verdict: 'pass',
        findings: [],
        model: 'gpt-6-luna',
        riskPathsFile: RISK_PATHS_FILE,
      },
      ctx,
    );
    expect(setStatus).toHaveBeenCalledWith(repo, 'a'.repeat(40), {
      context: 'second-opinion',
      state: 'success',
      description: '第二意见通过',
    });
    expect(commentPull).toHaveBeenCalledOnce();
    expect(res.commentUrl).toBe('https://x/comment/1');
  });

  it('必须改：状态贴 failure，说明带条数', async () => {
    const { ports, setStatus } = setup();
    await ports.postSecondOpinion(
      {
        ...scope,
        repo,
        prNumber: 7,
        head: 'b'.repeat(40),
        round: 2,
        hits,
        verdict: 'changes',
        findings: [
          { severity: 'blocking', text: '登录态没校验签名', file: 'packages/api/src/auth.ts' },
          { severity: 'minor', text: '变量名可以更清楚' },
        ],
        model: 'gpt-6-luna',
        riskPathsFile: RISK_PATHS_FILE,
      },
      ctx,
    );
    expect(setStatus).toHaveBeenCalledWith(repo, 'b'.repeat(40), {
      context: 'second-opinion',
      state: 'failure',
      description: '第二意见：必须改 1 条',
    });
  });

  it('【故意造出的失败】贴状态没权限：抛错，不能拿评论贴没贴顶替', async () => {
    const { ports } = setup({
      setStatus: vi.fn(async () => {
        throw new Error('没有 statuses 写权限');
      }),
    });
    await expect(
      ports.postSecondOpinion(
        {
          ...scope,
          repo,
          prNumber: 7,
          head: 'c'.repeat(40),
          round: 1,
          hits,
          verdict: 'pass',
          findings: [],
          model: 'x',
          riskPathsFile: RISK_PATHS_FILE,
        },
        ctx,
      ),
    ).rejects.toBeTruthy();
  });

  it('评论被卫生检查拦下：不影响已经贴好的状态，只是没有 commentUrl', async () => {
    const { ports, setStatus } = setup({
      commentPull: vi.fn(async () => {
        throw new Error('卫生检查拦下了');
      }),
    });
    const res = await ports.postSecondOpinion(
      {
        ...scope,
        repo,
        prNumber: 7,
        head: 'd'.repeat(40),
        round: 1,
        hits,
        verdict: 'pass',
        findings: [],
        model: 'x',
        riskPathsFile: RISK_PATHS_FILE,
      },
      ctx,
    );
    expect(setStatus).toHaveBeenCalledOnce();
    expect(res.commentUrl).toBeUndefined();
  });

  it('沿用上一轮通过的结论（合并前重跑头变了、patch-id 一样）：状态还是贴 success，评论写清是沿用、不是真审', async () => {
    const { ports, setStatus, commentPull } = setup();
    const res = await ports.postSecondOpinion(
      {
        ...scope,
        repo,
        prNumber: 7,
        head: 'e'.repeat(40),
        round: 2,
        hits,
        verdict: 'pass',
        findings: [],
        model: '沿用，没有再审',
        reused: { fromHead: 'a'.repeat(40), round: 1 },
        riskPathsFile: RISK_PATHS_FILE,
      },
      ctx,
    );
    expect(setStatus).toHaveBeenCalledWith(repo, 'e'.repeat(40), {
      context: 'second-opinion',
      state: 'success',
      description: '第二意见沿用第 1 轮（头 aaaaaaa）',
    });
    const body = vi.mocked(commentPull).mock.calls[0]?.[3] as string;
    expect(body).toContain('沿用第 1 轮在 aaaaaaa 上的通过');
    expect(body).toContain('不再拉一次审查');
    expect(res.commentUrl).toBe('https://x/comment/1');
  });
});

describe('runTests：合并前重跑那一步，判合并闸红是不是只缺 second-opinion（结构化，不匹配文案）', () => {
  const ciRed = (failedChecks: string[]) => ({
    state: 'red' as const,
    head: 'a'.repeat(40),
    checks: [],
    failedChecks,
  });

  function setupRunTests(
    over: {
      waitCi?: EngineGitHub['waitCi'];
      latestStatus?: EngineGitHub['claims']['latestStatus'];
      readRepoFile?: EngineGitHub['readRepoFile'];
      pullFiles?: EngineGitHub['pullFiles'];
    } = {},
  ) {
    const latestStatus =
      over.latestStatus ?? (vi.fn(async () => null) as EngineGitHub['claims']['latestStatus']);
    const gh = {
      waitCi: over.waitCi ?? (async () => ({ state: 'green' as const, head: 'a'.repeat(40), checks: [] })),
      readRepoFile:
        over.readRepoFile ??
        (async () => ({
          defaultBranch: 'main',
          commit: 'a'.repeat(40),
          file: { kind: 'text', text: RISK_JSON },
        })),
      pullFiles:
        over.pullFiles ?? (async () => [{ filename: 'packages/api/src/auth.ts', status: 'modified' }]),
      claims: { latestStatus } as unknown as EngineGitHub['claims'],
    } as unknown as EngineGitHub;
    const ports = createGitHubPorts({
      gh,
      trees: {} as never,
      exec: {} as never,
      tmpDir: '/tmp/fake',
      archiveDir: '/tmp/fake-archive',
    });
    return { ports, latestStatus };
  }

  it('合并闸红、碰了先审后合的路径、当前头上还没有 second-opinion 状态：secondOpinionWait=missing，不是测试真红', async () => {
    const { ports } = setupRunTests({ waitCi: async () => ciRed(['merge-gate']) });
    const res = await ports.runTests(
      { ...scope, repo, prNumber: 7, branch: 'fleet/12-a', head: 'a'.repeat(40) },
      ctx,
    );
    expect(res).toMatchObject({ passed: false, secondOpinionWait: 'missing' });
  });

  it('合并闸红、second-opinion 还在跑（pending）：secondOpinionWait=pending，不是测试真红', async () => {
    const { ports } = setupRunTests({
      waitCi: async () => ciRed(['merge-gate']),
      latestStatus: async () => ({ state: 'pending', description: '', byEngine: true }),
    });
    const res = await ports.runTests(
      { ...scope, repo, prNumber: 7, branch: 'fleet/12-a', head: 'a'.repeat(40) },
      ctx,
    );
    expect(res).toMatchObject({ passed: false, secondOpinionWait: 'pending' });
  });

  it('合并闸红、但这个 PR 没碰先审后合的路径：不当「缺 second-opinion」，按真测试红交回（另有原因——草稿、认领对不上……）', async () => {
    const { ports, latestStatus } = setupRunTests({
      waitCi: async () => ciRed(['merge-gate']),
      pullFiles: async () => [{ filename: 'docs/design.md', status: 'modified' }],
    });
    const res = await ports.runTests(
      { ...scope, repo, prNumber: 7, branch: 'fleet/12-a', head: 'a'.repeat(40) },
      ctx,
    );
    expect(res.passed).toBe(false);
    expect(res.secondOpinionWait).toBeUndefined();
    expect(latestStatus).not.toHaveBeenCalled();
  });

  it('还有别的检查也红了（不只是合并闸）：真测试红，不查 second-opinion（有没有它都改不了这一次的结论）', async () => {
    const { ports, latestStatus } = setupRunTests({
      waitCi: async () => ciRed(['merge-gate', 'test (engine)']),
    });
    const res = await ports.runTests(
      { ...scope, repo, prNumber: 7, branch: 'fleet/12-a', head: 'a'.repeat(40) },
      ctx,
    );
    expect(res.passed).toBe(false);
    expect(res.secondOpinionWait).toBeUndefined();
    expect(latestStatus).not.toHaveBeenCalled();
  });

  it('second-opinion 已经是通过的：合并闸红另有原因，按真测试红交回', async () => {
    const { ports } = setupRunTests({
      waitCi: async () => ciRed(['merge-gate']),
      latestStatus: async () => ({ state: 'success', description: '第二意见通过', byEngine: true }),
    });
    const res = await ports.runTests(
      { ...scope, repo, prNumber: 7, branch: 'fleet/12-a', head: 'a'.repeat(40) },
      ctx,
    );
    expect(res.passed).toBe(false);
    expect(res.secondOpinionWait).toBeUndefined();
  });

  it('绿了：照常交回 passed true，不查 second-opinion', async () => {
    const { ports, latestStatus } = setupRunTests();
    const res = await ports.runTests(
      { ...scope, repo, prNumber: 7, branch: 'fleet/12-a', head: 'a'.repeat(40) },
      ctx,
    );
    expect(res.passed).toBe(true);
    expect(latestStatus).not.toHaveBeenCalled();
  });

  it('【故意造出的失败】second-opinion 状态读不到（GitHub 报错）：抛错，不当「查成了、缺状态」', async () => {
    const { ports } = setupRunTests({
      waitCi: async () => ciRed(['merge-gate']),
      latestStatus: async () => {
        throw new Error('GitHub 一时读不到');
      },
    });
    await expect(
      ports.runTests({ ...scope, repo, prNumber: 7, branch: 'fleet/12-a', head: 'a'.repeat(40) }, ctx),
    ).rejects.toBeTruthy();
  });
});
