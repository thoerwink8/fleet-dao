// 逐个提交扫：git log 三份输出怎么切、怎么对账；认不出、对不上就抛错（调用方按「没扫成」拒推）。
// 真 git 造提交的用例在 prepush.test.ts；这里喂手写的输出，专门造「格式认不出」。
import { describe, expect, it } from 'vitest';
import { historyArgs, scanHistory } from '../src/history.ts';
import { formatFinding } from '../src/scan.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const mark = (sha: string) => `\x01fleet-commit ${sha}`;
const message = (sha: string, body: string, who = 't <t@example.invalid>') =>
  `\0${sha}\x01${who}\x01${who}\x01${body}\n`;
const scan = (patch: string, names: string, messages: string) =>
  scanHistory({ patch, names, messages }, { values: ['fake-org-778899'], allowlist: [] });

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
      '+用户 fake-org-778899',
      mark(B),
      '',
      'diff --git "a/docs/\\346\\226\\207.md" "b/docs/\\346\\226\\207.md"',
      '--- "a/docs/\\346\\226\\207.md"',
      '+++ "b/docs/\\346\\226\\207.md"',
      '@@ -3,0 +4 @@',
      '+又是 fake-org-778899',
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
      'docs/a.md:2 名单里的敏感值（提交 aaaaaaa）',
      '.secrets/x.pass 密钥文件（提交 bbbbbbb）',
      'docs/文.md:4 名单里的敏感值（提交 bbbbbbb）',
    ]);
  });

  it('没有提交：三份输出都是空的，扫了 0 个', () => {
    expect(scan('', '', '')).toEqual({ commits: [], addedLines: 0, findings: [] });
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
    const args = historyArgs(['HEAD', '--not', '--remotes=origin']);
    for (const cmd of [args.patch, args.names, args.messages]) {
      expect(cmd.slice(-4)).toEqual(['HEAD', '--not', '--remotes=origin', '--']);
      expect(cmd).toEqual(
        expect.arrayContaining(['log', '--reverse', '--no-color', 'log.showSignature=false']),
      );
    }
    expect(args.patch).toEqual(expect.arrayContaining(['--diff-merges=remerge', '--no-textconv', '-U0']));
  });
});
