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

describe('publishReleasePlan：算「该怎么开这张发布 PR」（纯判定）', () => {
  it('从 CHANGELOG.md 读下一版（v1 已发 → 这一版叫 v2）；正文带「Closes #227」；标题固定「发布 v<N>」；base 一律 main；head 必须是对得上的 release/v<N>', () => {
    const p = publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v2' });
    expect(p.version).toBe('v2');
    expect(p.title).toBe('发布 v2');
    expect(p.headBranch).toBe('release/v2');
    expect(p.base).toBe('main');
    expect(p.body).toContain('Closes #227');
    expect(p.body).toContain('- 加了发布 vN 这一头');
    expect(p.nextChangelog).toContain('## [v2] - ');
    expect(p.commitMessage).toContain('发布 v2');
  });

  it('CHANGELOG.md 认不出（缺 Unreleased 段）→ splitChangelog 的错直接抛出来', () => {
    expect(() => publishReleasePlan({ changelog: '# Changelog\n\n无内容\n', head: 'release/v2' })).toThrow(
      /缺 ## \[Unreleased\]/,
    );
  });

  it('head 分支名是空 → 明说缺，不拿空分支去开 PR', () => {
    expect(() => publishReleasePlan({ changelog: CHANGELOG_V1, head: '' })).toThrow(/head 分支名/);
  });

  it('head 不是 release/v<N> 的模样（feat/…）→ 明确拒绝：这张 PR 合并之后工作流落不进 proceed，与其开了才红不放开（第二意见 2026-10-02）', () => {
    expect(() => publishReleasePlan({ changelog: CHANGELOG_V1, head: 'feat/some-thing' })).toThrow(
      /不是 release\/v<N>/,
    );
  });

  it('head 是 release/v<别的>（版本号对不上 CHANGELOG.md 算出来的）→ 明确拒绝：分支和要发的版本错位', () => {
    expect(() => publishReleasePlan({ changelog: CHANGELOG_V1, head: 'release/v3' })).toThrow(
      /CHANGELOG\.md 算出来的版本.*对不上/,
    );
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

  it('故意造出的失败：gh auth status 退出非 0（没 gh auth login、也没 GITHUB_TOKEN/GH_TOKEN）→ 明确失败，不伪造 PR 号、不拿 0 顶（第二意见 2026-10-02）', async () => {
    await expect(
      publishPr({
        env: {},
        root,
        currentBranch: 'release/v2',
        git: async (args) => {
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-parse')
            return { code: 0, stdout: 'ab1234567890abcdef1234567890abcdef123456\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
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

  it('故意造出的失败：当前分支不是 release/v<N>（feat/…）→ 明确失败，不开一张注定红的 PR（第二意见 2026-10-02）', async () => {
    await expect(publishPr({ env: { GITHUB_TOKEN: 'x' }, root, currentBranch: 'feat/x' })).rejects.toThrow(
      /不是 release\/v<N>/,
    );
  });

  it('故意造出的失败：当前分支是 release/v<别的>（版本号对不上 CHANGELOG.md 算出来的）→ 明确失败', async () => {
    await expect(
      publishPr({ env: { GITHUB_TOKEN: 'x' }, root, currentBranch: 'release/v3' }),
    ).rejects.toThrow(/对不上/);
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
    const r = await publishPr({
      env: { GITHUB_TOKEN: 'x' },
      root,
      currentBranch: 'release/v2',
      // 日期钉死：不读真钟（2026-10-03 UTC 起，写死的 10-02 遇上真钟让每个 PR 的 test (rest) 都红）
      today: () => '2026-10-02',
      git: async (args) => {
        ops.push(`git ${args.join(' ')}`);
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
        if (args[0] === 'rev-parse')
          return { code: 0, stdout: 'ab1234567890abcdef1234567890abcdef123456\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      gh: async (args) => {
        ops.push(`gh ${args.join(' ')}`);
        return { code: 0, stdout: 'Create pull request\n\nhttps://github.com/x/y/pull/42\n', stderr: '' };
      },
    });
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
        git: async (args) => {
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-parse')
            return { code: 0, stdout: 'ab1234567890abcdef1234567890abcdef123456\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
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
        git: async (args) => {
          if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-parse')
            return { code: 0, stdout: 'ab1234567890abcdef1234567890abcdef123456\n', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
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
