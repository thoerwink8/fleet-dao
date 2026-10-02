import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCreatedPr, publishReleasePlan } from '../src/publish-actions.ts';
import { publishPr } from '../src/publish-pr.ts';
import { UNRELEASED_HEADING } from '../src/release-notes.ts';

const CHANGELOG_V1 = `# Changelog

${UNRELEASED_HEADING}

- 加了发布 vN 这一头

## [v1] - 2026-10-01

### Added / 新增

- 第一版。
`;

describe('publishReleasePlan：算「该怎么开这张发布 PR」（纯判定）', () => {
  it('从 CHANGELOG.md 读下一版（v1 已发 → 这一版叫 v2）；正文带「Closes #227」；标题固定「发布 v<N>」；base 一律 main', () => {
    const p = publishReleasePlan({ changelog: CHANGELOG_V1, head: 'feat/some-thing' });
    expect(p.version).toBe('v2');
    expect(p.title).toBe('发布 v2');
    expect(p.headBranch).toBe('feat/some-thing');
    expect(p.base).toBe('main');
    expect(p.body).toContain('Closes #227');
    expect(p.body).toContain('- 加了发布 vN 这一头');
  });

  it('CHANGELOG.md 认不出（缺 Unreleased 段）→ splitChangelog 的错直接抛出来', () => {
    expect(() => publishReleasePlan({ changelog: '# Changelog\n\n无内容\n', head: 'x' })).toThrow(
      /缺 ## \[Unreleased\]/,
    );
  });

  it('head 分支名是空 → 明说缺，不拿空分支去开 PR', () => {
    expect(() => publishReleasePlan({ changelog: CHANGELOG_V1, head: '' })).toThrow(/head 分支名/);
  });
});

describe('parseCreatedPr：从 gh 输出认 PR 号', () => {
  it('正常输出（最后一行是 …/pull/<N>）能认出', () => {
    const r = parseCreatedPr(
      'Creating pull request for feat/foo into main\n\nhttps://github.com/x/y/pull/123\n',
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

  it('故意造出的失败：没拿到 GITHUB_TOKEN → 明确失败，不伪造 PR 号、不拿 0 顶', async () => {
    await expect(publishPr({ env: {}, root, currentBranch: 'feat/x' })).rejects.toThrow(/缺 GITHUB_TOKEN/);
  });

  it('故意造出的失败：GITHUB_TOKEN 只是空白字符串照样不放行', async () => {
    await expect(publishPr({ env: { GITHUB_TOKEN: '  \n' }, root, currentBranch: 'feat/x' })).rejects.toThrow(
      /缺 GITHUB_TOKEN/,
    );
  });

  it('正常一轮：gh pr create 退出 0、回 …/pull/<N>，拿到 PR 号、版本号、head 分支名', async () => {
    let sawArgs: string[] | undefined;
    const r = await publishPr({
      env: { GITHUB_TOKEN: 'x' },
      root,
      currentBranch: 'feat/release-notes',
      gh: async (args) => {
        sawArgs = args;
        return { code: 0, stdout: 'Create pull request\n\nhttps://github.com/x/y/pull/42\n', stderr: '' };
      },
    });
    expect(r.pr).toBe(42);
    expect(r.url).toBe('https://github.com/x/y/pull/42');
    expect(r.version).toBe('v2');
    expect(r.headBranch).toBe('feat/release-notes');
    expect(sawArgs).toBeDefined();
    expect(sawArgs).toContain('pr');
    expect(sawArgs).toContain('create');
    expect(sawArgs).toContain('--base');
    expect(sawArgs).toContain('main');
    expect(sawArgs).toContain('--head');
    expect(sawArgs).toContain('feat/release-notes');
    expect(sawArgs).toContain('--title');
    expect(sawArgs?.[sawArgs.indexOf('--title') + 1]).toBe('发布 v2');
  });

  it('故意造出的失败：gh pr create 退出非 0 → 明确失败，带 gh 的 stderr', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'feat/x',
        gh: async () => ({ code: 1, stdout: '', stderr: 'GraphQL: No commits between main and feat/x' }),
      }),
    ).rejects.toThrow(/gh pr create 失败/);
  });

  it('故意造出的失败：gh 退出 0 但输出里认不出 PR 号 → 不拿假 PR 号放行', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        currentBranch: 'feat/x',
        gh: async () => ({ code: 0, stdout: 'weird output with no url\n', stderr: '' }),
      }),
    ).rejects.toThrow(/认不出 PR 号/);
  });

  it('故意造出的失败：没传 currentBranch 且 git rev-parse 挂 → 明确失败，不拿空分支去开', async () => {
    await expect(
      publishPr({
        env: { GITHUB_TOKEN: 'x' },
        root,
        git: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
      }),
    ).rejects.toThrow(/查当前分支失败/);
  });
});
