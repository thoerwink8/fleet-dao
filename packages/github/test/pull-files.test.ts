// PR 改到的文件（先审后合按路径判要它，#253）：翻完页、带 patch、认不出的一条抛错（不当空文件处理）。
import { describe, expect, it } from 'vitest';
import { json, repo, setup } from './helpers.ts';

describe('PR 改到的文件（pullFiles）', () => {
  it('翻完页、带 patch 和改名前的名字', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) => {
      if (req.method !== 'GET' || !req.path.endsWith('/pulls/7/files')) return undefined;
      const page = req.query.get('page') ?? '1';
      if (page === '1') {
        return json(
          200,
          [{ filename: 'packages/api/src/auth.ts', status: 'modified', patch: '@@ -1 +1 @@' }],
          {
            link: `<https://api.github.test/repos/acme/widgets/pulls/7/files?per_page=100&page=2>; rel="next"`,
          },
        );
      }
      return json(200, [
        { filename: 'src/new-name.ts', status: 'renamed', previous_filename: 'src/old-name.ts' },
      ]);
    });
    const files = await gh.pullFiles({ repo, prNumber: 7 });
    expect(files).toEqual([
      { filename: 'packages/api/src/auth.ts', status: 'modified', patch: '@@ -1 +1 @@' },
      { filename: 'src/new-name.ts', status: 'renamed', previous: 'src/old-name.ts' },
    ]);
  });

  it('带上 changes（没有 patch 时靠它分得开二进制和太大）；不是非负整数的不带，不当成 0', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) => {
      if (req.method !== 'GET' || !req.path.endsWith('/pulls/8/files')) return undefined;
      return json(200, [
        { filename: 'logo.png', status: 'added', changes: 0 },
        { filename: 'big.json', status: 'modified', changes: 90210 },
        { filename: 'odd-1.txt', status: 'modified', changes: -1 },
        { filename: 'odd-2.txt', status: 'modified', changes: '12' },
      ]);
    });
    const files = await gh.pullFiles({ repo, prNumber: 8 });
    expect(files).toEqual([
      { filename: 'logo.png', status: 'added', changes: 0 },
      { filename: 'big.json', status: 'modified', changes: 90210 },
      { filename: 'odd-1.txt', status: 'modified' },
      { filename: 'odd-2.txt', status: 'modified' },
    ]);
  });

  it('【故意造出的失败】一条认不出（没有 filename）就抛错，不当空文件处理', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) => {
      if (req.method !== 'GET' || !req.path.endsWith('/pulls/9/files')) return undefined;
      return json(200, [{ status: 'modified' }]);
    });
    await expect(gh.pullFiles({ repo, prNumber: 9 })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});
