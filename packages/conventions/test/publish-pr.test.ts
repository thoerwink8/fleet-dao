import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeChangelog, parseCreatedPr, publishReleasePlan } from '../src/publish-actions.ts';
import { publishPr } from '../src/publish-pr.ts';
import { UNRELEASED_HEADING } from '../src/release-notes.ts';

const CHANGELOG_V1 = `# Changelog

${UNRELEASED_HEADING}

- 加了发布 vN 这一头

## [v1] - 2026-10-01

### Added / 新增

- 第一版。
`;

describe('finalizeChangelog：把 Unreleased 段收进 ## [vN] - 日期', () => {
  it('正常一份：Unreleased → ## [v2] - <今天 UTC>，Unreleased 重置成「还没有」，下一个已发版的位置不动', () => {
    const next = finalizeChangelog(CHANGELOG_V1, { version: 'v2', date: '2026-10-02' });
    expect(next).toContain(UNRELEASED_HEADING);
    expect(next).toContain('## [v2] - 2026-10-02');
    expect(next).toContain('- 加了发布 vN 这一头');
    expect(next).toContain('## [v1] - 2026-10-01');
    // 「还没有」是 Unreleased 的新内容；Unreleased 正文得在 ## [v2] 之前
    const unreleasedIdx = next.indexOf(UNRELEASED_HEADING);
    const v2Idx = next.indexOf('## [v2] - ');
    const v1Idx = next.indexOf('## [v1] - ');
    expect(unreleasedIdx).toBeLessThan(v2Idx);
    expect(v2Idx).toBeLessThan(v1Idx);
  });

  it('故意造出的失败：Unreleased 是空的 → 不发起（先把要发的话写进 Unreleased 段）', () => {
    const text = `# Changelog\n\n${UNRELEASED_HEADING}\n`;
    expect(() => finalizeChangelog(text, { version: 'v1', date: '2026-10-02' })).toThrow(
      /Unreleased 段是空的/,
    );
  });

  it('故意造出的失败：缺 Unreleased 段 → splitChangelog 的错直接抛出来', () => {
    expect(() =>
      finalizeChangelog('# Changelog\n\n## [v1] - 2026-10-01\n- x\n', { version: 'v2', date: '2026-10-02' }),
    ).toThrow(/缺 ## \[Unreleased\]/);
  });
});

/** 开着的里程碑（GitHub 上现读的那份）：当前版本 v2。 */
const OPEN_V2 = [
  { number: 12, title: 'v2 发布这一头' },
  { number: 3, title: 'P2 驾驶舱 v1' },
];

/** 仓里现在这份：一版没发过，Unreleased 里写了东西。 */
const CHANGELOG_NONE_RELEASED = `# Changelog

${UNRELEASED_HEADING}

- 加了无人值守推进
`;

describe('publishReleasePlan：算「该怎么开这张发布 PR」（纯判定）', () => {
  it('版本号取当前版本里程碑（v2 开着 → 这一版叫 v2）；标题固定「发布 v<N>」；base 一律 main；head 必须是对得上的 release/v<N>', () => {
    const p = publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v2', openMilestones: OPEN_V2 });
    expect(p.version).toBe('v2');
    expect(p.milestone).toEqual({ number: 12, title: 'v2 发布这一头' });
    expect(p.title).toBe('发布 v2');
    expect(p.headBranch).toBe('release/v2');
    expect(p.base).toBe('main');
    expect(p.body).toContain('当前版本里程碑「v2 发布这一头」');
    expect(p.body).toContain('关里程碑「v2 发布这一头」');
    expect(p.body).toContain('- 加了发布 vN 这一头');
    expect(p.nextChangelog).toContain('## [v2] - ');
    expect(p.commitMessage).toContain('发布 v2');
  });

  // 【故意造出的失败】#593：原先按 CHANGELOG.md「上一版 +1」算，一版没发过就叫 v1；开着的却是 v3，
  // 合并之后 release.yml 关不到 v3、在已关的「v1 Fusion 接活」里找到同名的就当「已经关过了」报绿。
  it('更新日志一版没发过、开着的是 v3 → 这一版叫 v3（不是按 +1 的 v1）；切成 release/v1 的明确拒绝', () => {
    const open = [{ number: 10, title: 'v3 三段一条龙' }];
    const p = publishReleasePlan({
      changelog: CHANGELOG_NONE_RELEASED,
      head: 'release/v3',
      openMilestones: open,
    });
    expect(p.version).toBe('v3');
    expect(p.nextChangelog).toContain('## [v3] - ');
    expect(() =>
      publishReleasePlan({ changelog: CHANGELOG_NONE_RELEASED, head: 'release/v1', openMilestones: open }),
    ).toThrow(/当前版本里程碑「v3 三段一条龙」（v3）对不上/);
  });

  it('发布 PR 正文不再写死关哪张单（Closes #227 早关了，发布 PR 不关单）', () => {
    const p = publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v2', openMilestones: OPEN_V2 });
    expect(p.body).not.toMatch(/(Closes|Fixes|Resolves) #\d+/i);
  });

  it('开着不止一张版本里程碑 → 照「当前版本＝N 最小那张」挑（和派活同一条规矩），正文列出别的那几张', () => {
    const open = [
      { number: 13, title: 'v3 下一版' },
      { number: 12, title: 'v2 发布这一头' },
    ];
    const p = publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v2', openMilestones: open });
    expect(p.version).toBe('v2');
    expect(p.body).toContain('还开着的别的版本里程碑：「v3 下一版」');
  });

  it('故意造出的失败：开着的里程碑里没有版本里程碑（只有 P 阶段的、或一张都没有）→ 明确拒绝，不拿「上一版 +1」猜', () => {
    for (const open of [[], [{ number: 3, title: 'P2 驾驶舱 v1' }]]) {
      expect(() =>
        publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v2', openMilestones: open }),
      ).toThrow(/没有版本里程碑/);
    }
  });

  it('故意造出的失败：「v2.5 …」「V2 …」不算版本里程碑（认法和派活、开单同一份 milestoneVersion）', () => {
    const open = [
      { number: 20, title: 'v2.5 小版本' },
      { number: 21, title: 'V2 大写' },
    ];
    expect(() =>
      publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v2', openMilestones: open }),
    ).toThrow(/没有版本里程碑/);
  });

  it('故意造出的失败：CHANGELOG.md 里已经有这一版的标题（上一张发布 PR 合过、里程碑没关上）→ 明确拒绝，指去重跑 release', () => {
    expect(() =>
      publishReleasePlan({
        changelog: CHANGELOG_V1,
        head: 'release/v1',
        openMilestones: [{ number: 8, title: 'v1 Fusion 接活' }],
      }),
    ).toThrow(/已经有「## \[v1\] - …」了[\s\S]*workflow_dispatch，version=v1/);
  });

  it('故意造出的失败：CHANGELOG.md 已经发到比当前版本里程碑还新的版本 → 明确拒绝（两边对不上，先核一眼）', () => {
    const changelog = `${CHANGELOG_V1}\n## [v5] - 2026-09-01\n\n- 很久以前的一版\n`;
    expect(() => publishReleasePlan({ changelog, head: 'release/v2', openMilestones: OPEN_V2 })).toThrow(
      /已经发到 v5 了，比当前版本里程碑/,
    );
  });

  it('CHANGELOG.md 认不出（缺 Unreleased 段）→ splitChangelog 的错直接抛出来', () => {
    expect(() =>
      publishReleasePlan({
        changelog: '# Changelog\n\n无内容\n',
        head: 'release/v2',
        openMilestones: OPEN_V2,
      }),
    ).toThrow(/缺 ## \[Unreleased\]/);
  });

  it('故意造出的失败：Unreleased 只剩占位「还没有」→ 不发起（先把要发的话写进 Unreleased 段）', () => {
    const changelog = `# Changelog\n\n${UNRELEASED_HEADING}\n\n还没有\n`;
    expect(() => publishReleasePlan({ changelog, head: 'release/v2', openMilestones: OPEN_V2 })).toThrow(
      /Unreleased 段是空的/,
    );
  });

  it('head 分支名是空 → 明说缺，不拿空分支去开 PR', () => {
    expect(() => publishReleasePlan({ changelog: CHANGELOG_V1, head: '', openMilestones: OPEN_V2 })).toThrow(
      /head 分支名/,
    );
  });

  it('head 不是 release/v<N> 的模样（feat/…）→ 明确拒绝，并写出该切哪个分支（第二意见 2026-10-02）', () => {
    expect(() =>
      publishReleasePlan({ changelog: CHANGELOG_V1, head: 'feat/some-thing', openMilestones: OPEN_V2 }),
    ).toThrow(/不是 release\/v<N>[\s\S]*git switch -c release\/v2/);
  });

  it('head 是 release/v<别的>（版本号对不上当前版本里程碑）→ 明确拒绝：分支和要发的版本错位', () => {
    expect(() =>
      publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v3', openMilestones: OPEN_V2 }),
    ).toThrow(/当前版本里程碑「v2 发布这一头」（v2）对不上：分支名贴的是 v3/);
  });
});

describe('parseCreatedPr：从 gh 输出认 PR 号', () => {
  it('正常输出（最后一行是 …/pull/<N>）能认出', () => {
    const r = parseCreatedPr(
      'Creating pull request for release/v2 into main\n\nhttps://github.com/x/y/pull/123\n',
    );
    expect(r).toEqual({ pr: 123, url: 'https://github.com/x/y/pull/123' });
  });

  it('认不出 PR 号 → 抛错（不拿 0 或空字符串冒充成功）', () => {
    expect(() => parseCreatedPr('something weird\nno url here\n')).toThrow(/认不出 PR 号/);
  });
});

describe('publishPr：编排（deps 换 mock）', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'publish-pr-'));
    writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG_V1, 'utf8');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 读里程碑的替身：开着当前版本 v2，另有一张早关了的 v1。 */
  const milestonesV2 = async () => [
    { number: 12, title: 'v2 发布这一头', state: 'open' as const },
    { number: 8, title: 'v1 Fusion 接活', state: 'closed' as const },
  ];
  /** git 替身：工作区干净、rev-parse 回一个提交号，每一条记进 ops。 */
  const cleanGit =
    (ops: string[] = []) =>
    async (args: string[]) => {
      ops.push(`git ${args.join(' ')}`);
      if (args[0] === 'rev-parse')
        return { code: 0, stdout: 'ab1234567890abcdef1234567890abcdef123456\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };

  it('故意造出的失败：gh auth status 退出非 0（没 gh auth login、也没 GITHUB_TOKEN/GH_TOKEN）→ 明确失败，不伪造 PR 号、不拿 0 顶（第二意见 2026-10-02）', async () => {
    await expect(
      publishPr({
        env: {},
        root,
        currentBranch: 'release/v2',
        milestones: milestonesV2,
        git: cleanGit(),
        gh: async (args) =>
          args[0] === 'auth'
            ? {
                code: 1,
                stdout: '',
                stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
              }
            : { code: 0, stdout: '', stderr: '' },
      }),
    ).rejects.toThrow(/gh 没有可用的身份/);
  });

  it('故意造出的失败：当前分支不是 release/v<N>（feat/…）→ 明确失败，不碰网络、不开一张注定红的 PR（第二意见 2026-10-02）', async () => {
    let read = false;
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'feat/x',
        milestones: async () => {
          read = true;
          return await milestonesV2();
        },
      }),
    ).rejects.toThrow(/不是 release\/v<N>/);
    expect(read).toBe(false);
  });

  it('故意造出的失败：当前分支是 release/v<别的>（版本号对不上当前版本里程碑）→ 明确失败、CHANGELOG.md 不动', async () => {
    const ops: string[] = [];
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v3',
        milestones: milestonesV2,
        git: cleanGit(ops),
        gh: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
    ).rejects.toThrow(/对不上/);
    expect(ops.some((l) => l.startsWith('git commit'))).toBe(false);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(CHANGELOG_V1);
  });

  it('故意造出的失败：读 GitHub 上的里程碑失败 → 明确失败（不拿「上一版 +1」猜版本号），CHANGELOG.md 不动、不提交', async () => {
    const ops: string[] = [];
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        milestones: async () => {
          throw new Error('连不上 GitHub（fetch failed：ECONNRESET）');
        },
        git: cleanGit(ops),
        gh: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
    ).rejects.toThrow(/读 GitHub 上的里程碑失败（连不上 GitHub[\s\S]*不猜、不动仓/);
    expect(ops.some((l) => l.startsWith('git add') || l.startsWith('git commit'))).toBe(false);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(CHANGELOG_V1);
  });

  it('故意造出的失败：只有关了的版本里程碑、没有开着的 → 明确失败（关了的不算当前版本）', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        milestones: async () => [{ number: 12, title: 'v2 发布这一头', state: 'closed' as const }],
        git: cleanGit(),
        gh: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
    ).rejects.toThrow(/没有版本里程碑/);
  });

  it('故意造出的失败：工作区除了 CHANGELOG.md 还有别的没提交 → 不带私货，明确失败', async () => {
    // 塞一个别的没提交文件
    writeFileSync(join(root, 'scratch.txt'), 'junk\n', 'utf8');
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        git: async (args) => {
          if (args[0] === 'status')
            return { code: 0, stdout: ' M CHANGELOG.md\n?? scratch.txt\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/私货/);
  });

  it('故意造出的失败：「fooCHANGELOG.md」「other/CHANGELOG.md」也算私货，不被路径名里带「CHANGELOG.md」骗过去（第二意见 2026-10-02）', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        git: async (args) => {
          if (args[0] === 'status')
            return {
              code: 0,
              stdout: ' M CHANGELOG.md\n M fooCHANGELOG.md\n?? other/CHANGELOG.md\n',
              stderr: '',
            };
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/fooCHANGELOG\.md/);
  });

  it('正常一轮：改了 CHANGELOG.md、commit、push、gh pr create、拿到 PR 号', async () => {
    const ops: string[] = [];
    const notes: string[] = [];
    const r = await publishPr({
      env: { GITHUB_TOKEN: 'x' },
      root,
      currentBranch: 'release/v2',
      // 日期钉死：不读真钟（2026-10-03 UTC 起，写死的 10-02 遇上真钟让每个 PR 的 test (rest) 都红）
      today: () => '2026-10-02',
      milestones: milestonesV2,
      note: (line) => notes.push(line),
      git: cleanGit(ops),
      gh: async (args) => {
        ops.push(`gh ${args.join(' ')}`);
        return { code: 0, stdout: 'Create pull request\n\nhttps://github.com/x/y/pull/42\n', stderr: '' };
      },
    });
    expect(notes[0]).toBe('这一版是 v2（当前版本里程碑「v2 发布这一头」）');
    expect(r.pr).toBe(42);
    expect(r.url).toBe('https://github.com/x/y/pull/42');
    expect(r.version).toBe('v2');
    expect(r.headBranch).toBe('release/v2');
    expect(r.commitSha).toBe('ab1234567890abcdef1234567890abcdef123456');
    // 顺序：add → commit → rev-parse → push → gh pr create
    const addIdx = ops.indexOf('git add CHANGELOG.md');
    const commitIdx = ops.indexOf(
      'git commit -m 发布 v2：CHANGELOG.md 的 Unreleased 段收进 ## [v2] - 2026-10-02',
    );
    const pushIdx = ops.indexOf('git push -u origin release/v2');
    const ghIdx = ops.findIndex((l) => l.startsWith('gh pr create'));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(pushIdx).toBeGreaterThan(commitIdx);
    expect(ghIdx).toBeGreaterThan(pushIdx);
    expect(ops[ghIdx]).toContain('--head');
    expect(ops[ghIdx]).toContain('release/v2');
    expect(ops[ghIdx]).toContain('--title');
    expect(ops[ghIdx]).toContain('发布 v2');
    // CHANGELOG.md 真被改了
    const newChangelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(newChangelog).toContain('## [v2] - ');
    expect(newChangelog).toContain(UNRELEASED_HEADING);
  });

  it('故意造出的失败：git push 撞墙 → 明确失败，不去开 PR', async () => {
    const ops: string[] = [];
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        milestones: milestonesV2,
        git: async (args) => {
          ops.push(`git ${args.join(' ')}`);
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-parse')
            return { code: 0, stdout: 'ab1234567890abcdef1234567890abcdef123456\n', stderr: '' };
          if (args[0] === 'push') return { code: 1, stdout: '', stderr: 'remote rejected' };
          return { code: 0, stdout: '', stderr: '' };
        },
        gh: async (args) => {
          ops.push(`gh ${args.join(' ')}`);
          return { code: 0, stdout: 'https://github.com/x/y/pull/42\n', stderr: '' };
        },
      }),
    ).rejects.toThrow(/git push -u origin release\/v2 失败/);
    expect(ops.some((l) => l.startsWith('gh pr'))).toBe(false);
  });

  it('故意造出的失败：gh pr create 退出非 0 → 明确失败，带 gh 的 stderr', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        milestones: milestonesV2,
        git: cleanGit(),
        gh: async (args) =>
          args[0] === 'auth'
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 1, stdout: '', stderr: 'GraphQL: No commits between main and release/v2' },
      }),
    ).rejects.toThrow(/gh pr create 失败/);
  });

  it('故意造出的失败：gh 退出 0 但输出里认不出 PR 号 → 不拿假 PR 号放行', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        milestones: milestonesV2,
        git: cleanGit(),
        gh: async () => ({ code: 0, stdout: 'weird output with no url\n', stderr: '' }),
      }),
    ).rejects.toThrow(/认不出 PR 号/);
  });

  it('故意造出的失败：没传 currentBranch 且 git rev-parse 挂 → 明确失败，不拿空分支去开', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        git: async (args) => {
          if (args[0] === 'rev-parse')
            return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/查当前分支失败/);
  });

  it('故意造出的失败：commit 之后 git rev-parse HEAD 挂 → 明确失败、不拿空提交号接着 push（第二意见 2026-10-02 小毛病）', async () => {
    const ops: string[] = [];
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        milestones: milestonesV2,
        // CI 上没有 gh 身份：身份那一步换成 mock，测的是后面 rev-parse 那一步
        gh: async () => ({ code: 0, stdout: '', stderr: '' }),
        git: async (args) => {
          ops.push(`git ${args.join(' ')}`);
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-parse' && args.includes('HEAD'))
            return { code: 128, stdout: '', stderr: 'something broke' };
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/git rev-parse HEAD 失败/);
    // push / gh pr create 都没动
    expect(ops.some((l) => l.includes('push'))).toBe(false);
  });

  it('故意造出的失败：commit 之后 git rev-parse HEAD 输出认不出提交号 → 不拿空串顶替', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'release/v2',
        milestones: milestonesV2,
        // CI 上没有 gh 身份：身份那一步换成 mock，测的是后面 rev-parse 那一步
        gh: async () => ({ code: 0, stdout: '', stderr: '' }),
        git: async (args) => {
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-parse' && args.includes('HEAD'))
            return { code: 0, stdout: '???\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/认不出提交号/);
  });
});
