// 只看新增内容的扫法：从 git diff -U0 里取新增的行（行号对得上新文件），加上新出现的文件名，过同一套规则。
import { describe, expect, it } from 'vitest';
import { addedHunks, scanAdded } from '../src/diff.ts';
import { formatFinding } from '../src/scan.ts';
import { pseudoRandom } from './helpers.ts';

const token = ['ghp', pseudoRandom(36, 301)].join('_');
const keyBody = pseudoRandom(64, 302, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const pemHeader = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');

const DIFF = [
  'diff --git a/docs/a.md b/docs/a.md',
  'index 1111111..2222222 100644',
  '--- a/docs/a.md',
  '+++ b/docs/a.md',
  '@@ -3,0 +4,2 @@ 标题',
  '+第四行',
  `+export GH_TOKEN=${token}`,
  '@@ -10 +12 @@',
  '-旧的一行',
  '+++i 这一行本身以 ++ 开头',
  'diff --git a/deploy/key.md b/deploy/key.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/deploy/key.md',
  '@@ -0,0 +1,3 @@',
  '+部署钥匙：',
  `+${pemHeader}`,
  `+${keyBody}`,
  'diff --git a/gone.md b/gone.md',
  'deleted file mode 100644',
  '--- a/gone.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  `-export GH_TOKEN=${token}`,
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  'diff --git "a/docs/\\344\\270\\255.md" "b/docs/\\344\\270\\255.md"',
  '--- "a/docs/\\344\\270\\255.md"',
  '+++ "b/docs/\\344\\270\\255.md"',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n');

describe('addedHunks', () => {
  it('按文件、按连续的一段取新增行，记下每段在新文件里从第几行开始；删掉的文件、二进制文件没有新增行', () => {
    expect(addedHunks(DIFF).map((h) => [h.path, h.startLine, h.text.split('\n').length])).toEqual([
      ['docs/a.md', 4, 2],
      ['docs/a.md', 12, 1],
      ['deploy/key.md', 1, 3],
      ['docs/中.md', 1, 1],
    ]);
    // 段落里以 +++ 开头的是新增的内容（例如 ++i），不是文件头。
    expect(addedHunks(DIFF)[1]?.text).toBe('++i 这一行本身以 ++ 开头');
  });
});

describe('scanAdded', () => {
  it('新增行里的令牌、跨行的私钥（行号是新文件里的），新出现的密钥文件名，都报；删掉的行不报', () => {
    const found = scanAdded(addedHunks(DIFF), ['docs/a.md', 'deploy/key.md', 'logo.png', '.secrets/x.pass'], {
      allowlist: [],
    });
    expect(found.map(formatFinding).sort()).toEqual(
      [
        '.secrets/x.pass 密钥文件',
        'deploy/key.md:2 私钥',
        'docs/a.md:5 令牌',
        'docs/a.md:5 像密钥的赋值',
      ].sort(),
    );
  });

  it('【故意造出的失败】新出现的路径里带真密钥（目录名）也报：正文干净不算过，报出来的路径要遮住那段', () => {
    // 路径本身就是写出去的东西：文件名会进 commit 和网页地址。和全仓检查一样，行号 0、命中那段遮成「…」。
    const secret = ['ghp', pseudoRandom(36, 304)].join('_');
    const leakPath = `specs/532-x/${secret}/需求.md`;
    const found = scanAdded([], [leakPath], { allowlist: [] });
    expect(found.map(formatFinding)).toEqual(['specs/532-x/…/需求.md 令牌']);
    for (const f of found) expect(f.path).not.toContain(secret);
  });

  it('白名单照全仓检查的规矩来', () => {
    // export GH_TOKEN=… 这种写法同时对上 token（前缀）和 secret-assign（键名像密钥）两条规则，和上面那条一样。
    const otherToken = ['ghp', pseudoRandom(36, 303)].join('_');
    const hunks = [{ path: 'docs/b.md', startLine: 7, text: `export GH_TOKEN=${otherToken}` }];
    expect(scanAdded(hunks, [], { allowlist: [] }).map(formatFinding).sort()).toEqual(
      ['docs/b.md:7 令牌', 'docs/b.md:7 像密钥的赋值'].sort(),
    );
    const allow = [
      { rule: 'token' as const, path: /^docs\//, reason: '测试用：放行 docs 里的。' },
      { rule: 'secret-assign' as const, path: /^docs\//, reason: '测试用：放行 docs 里的。' },
    ];
    expect(scanAdded(hunks, [], { allowlist: allow })).toEqual([]);
  });
});
