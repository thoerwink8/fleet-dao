// 逐个提交扫：git log 三份输出怎么切、怎么对账；认不出、对不上就抛错（调用方按「没扫成」拒推）。
// 真 git 造提交的用例在 prepush.test.ts；这里喂手写的输出，专门造「格式认不出」。
import { describe, expect, it } from 'vitest';
import { historyArgs, scanHistory } from '../src/history.ts';
import { formatFinding } from '../src/scan.ts';
import { pseudoRandom } from './helpers.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const mark = (sha: string) => `\x01fleet-commit ${sha}`;
const message = (sha: string, body: string, who = 't <t@example.invalid>') =>
  `\0${sha}\x01${who}\x01${who}\x01${body}\n`;
const scan = (patch: string, names: string, messages: string) =>
  scanHistory({ patch, names, messages }, { allowlist: [] });
const token = (seed: number) => ['ghp', pseudoRandom(36, seed)].join('_');

describe('scanHistory', () => {
  it('按提交切开：每条命中带上它出在哪个提交；带引号的路径照样认', () => {
    const patch = [
      mark(A),
      '',
      'diff --git a/docs/a.md b/docs/a.md',
      '--- /dev/null',
      '+++ b/docs/a.md',
      '@@ -0,0 +1,2 @@',
      '+第一行',
      `+令牌 ${token(801)}`,
      mark(B),
      '',
      'diff --git "a/docs/\\346\\226\\207.md" "b/docs/\\346\\226\\207.md"',
      '--- "a/docs/\\346\\226\\207.md"',
      '+++ "b/docs/\\346\\226\\207.md"',
      '@@ -3,0 +4 @@',
      `+又是 ${token(802)}`,
    ].join('\n');
    const names = [
      mark(A),
      '',
      'docs/a.md',
      mark(B),
      '',
      '"docs/\\346\\226\\207.md"',
      '.secrets/x.pass',
    ].join('\n');
    const result = scan(patch, names, message(A, '第一个') + message(B, '第二个'));
    expect(result.commits).toEqual([A, B]);
    expect(result.addedLines).toBe(3);
    expect(result.findings.map(formatFinding)).toEqual([
      'docs/a.md:2 令牌（提交 aaaaaaa）',
      '.secrets/x.pass 密钥文件（提交 bbbbbbb）',
      'docs/文.md:4 令牌（提交 bbbbbbb）',
    ]);
  });

  it('没有提交：三份输出都是空的，扫了 0 个', () => {
    expect(scan('', '', '')).toEqual({ commits: [], addedLines: 0, binaryHunks: 0, findings: [] });
  });

  it('带 NUL 的段去掉 NUL 照扫、单独计数；同一个提交里别的段照看', () => {
    const patch = [
      mark(A),
      '',
      'diff --git a/logo.png b/logo.png',
      '--- /dev/null',
      '+++ b/logo.png',
      '@@ -0,0 +1,2 @@',
      '+\x89PNG\0\x01',
      `+又是 ${token(803)}`,
      'diff --git a/docs/a.md b/docs/a.md',
      '--- /dev/null',
      '+++ b/docs/a.md',
      '@@ -0,0 +1 @@',
      `+令牌 ${token(804)}`,
    ].join('\n');
    const result = scan(patch, [mark(A), '', 'logo.png', 'docs/a.md'].join('\n'), message(A, 'x'));
    expect(result).toMatchObject({ binaryHunks: 1, addedLines: 3 });
    // NUL 换空格、去掉 NUL 两遍都命中同一处，只报一条。
    expect(result.findings.map(formatFinding)).toEqual([
      'docs/a.md:1 令牌（提交 aaaaaaa）',
      'logo.png:2 令牌（提交 aaaaaaa）',
    ]);
  });

  it('令牌紧贴在 NUL 两边：换空格那遍拆得开，去掉 NUL 那遍拼得起（UTF-16）', () => {
    const t = token(805);
    const utf16 = [...`K=${t}`].join('\0');
    const patch = [
      mark(A),
      '',
      'diff --git a/a.bin b/a.bin',
      '--- /dev/null',
      '+++ b/a.bin',
      '@@ -0,0 +1,2 @@',
      `+x\0${t}\0y`,
      `+${utf16}\0`,
    ].join('\n');
    const result = scan(patch, [mark(A), '', 'a.bin'].join('\n'), message(A, 'x'));
    expect(result.findings.map(formatFinding)).toEqual([
      'a.bin:1 令牌（提交 aaaaaaa）',
      'a.bin:2 令牌（提交 aaaaaaa）',
    ]);
  });

  it('差异里有文件只给了「Binary files … differ」或二进制补丁：没给内容，抛错', () => {
    const head = `${mark(A)}\n\ndiff --git a/x.bin b/x.bin\nindex 0000000..1111111 100644\n`;
    for (const line of ['Binary files /dev/null and b/x.bin differ', 'GIT binary patch'])
      expect(() => scan(`${head}${line}\n`, `${mark(A)}\n\nx.bin\n`, message(A, 'x'))).toThrow('没给内容');
  });

  it('认不出、对不上就抛错，不当成扫过没事', () => {
    // 差异输出里第一个提交标记之前就有内容（例如本机配置改了输出格式）。
    expect(() => scan('diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n', '', message(A, 'x'))).toThrow(
      '认不出',
    );
    // 提交标记后面不是提交号。
    expect(() => scan(`${mark('HEAD')}\n`, '', message(A, 'x'))).toThrow('认不出');
    // 提交说明的输出开头不是分隔符、缺段落。
    expect(() => scan('', '', `${A}\x01x\x01x\x01body\n`)).toThrow('认不出');
    expect(() => scan('', '', `\0${A}\x01只有作者\n`)).toThrow('认不出');
    // 差异里的提交不在提交清单里：三份输出对不上。
    expect(() => scan(`${mark(B)}\n`, '', message(A, 'x'))).toThrow('对不上');
  });

  it('三条命令都钉住输出格式、按从旧到新排，范围参数原样放在 -- 前面', () => {
    const args = historyArgs(['HEAD', '--not', '--remotes']);
    for (const cmd of [args.patch, args.names, args.messages]) {
      expect(cmd.slice(-4)).toEqual(['HEAD', '--not', '--remotes', '--']);
      expect(cmd).toEqual(
        expect.arrayContaining(['log', '--reverse', '--no-color', 'log.showSignature=false']),
      );
    }
    // --text：git 当成二进制的文本文件（-diff 属性、大文件阈值）也要出内容。
    expect(args.patch).toEqual(
      expect.arrayContaining(['--diff-merges=remerge', '--no-textconv', '--text', '-U0']),
    );
  });
});
