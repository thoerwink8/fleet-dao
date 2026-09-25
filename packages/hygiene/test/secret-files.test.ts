// 密钥文件按名字拦：规则表（rules.ts 的 SECRET_FILES）和仓根 .gitignore 里标记圈出来的那一段是同一张名单，两边对不上就红。
// .gitignore 管「平常 git add 加不进来」，卫生检查管「git add -f 强行加进来的」。只核对标记段：别的行（*.log 之类）随便加。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findSecretFile, SECRET_FILES } from '../src/rules.ts';
import { formatFinding, scanFiles } from '../src/scan.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GITIGNORE = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8');
const BEGIN = '# >>> 密钥文件名单';
const END = '# <<< 密钥文件名单';

/** 标记段里的规则行（去掉注释、空行）。标记不在就返回 undefined。 */
function markedSection(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const from = lines.findIndex((l) => l.startsWith(BEGIN));
  const to = lines.findIndex((l) => l.startsWith(END));
  if (from < 0 || to < from) return undefined;
  return lines.slice(from + 1, to).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
}

/** 照 .gitignore 的一行造一个会被它忽略的路径：* 换成 x，目录后面补个文件名。 */
const sampleFor = (line: string) => line.replace(/\*/g, 'x').replace(/\/$/, '/x');

describe('按文件名拦密钥文件', () => {
  it.each(SECRET_FILES.map((r) => [r.name, r.sample]))('%s：%s 被拦', (_name, sample) => {
    expect(findSecretFile(sample)?.rule).toBe('secret-file');
  });

  it('大小写、目录深浅都拦；源码、公钥、样例 env 不拦', () => {
    for (const path of [
      'a/b/.SECRETS/x.txt',
      'Deploy/TLS.PEM',
      'x/y/z/id_rsa',
      'packages/api/.env',
      'VAULT-KEY.TXT',
    ]) {
      expect([path, findSecretFile(path)?.rule]).toEqual([path, 'secret-file']);
    }
    for (const path of [
      'packages/github/src/credentials.ts',
      'deploy/id_ed25519.pub',
      'packages/api/.env.example',
      'docs/keys.md',
      'src/passwords.ts',
      'secrets/README.md',
      'docs/vault-key.md',
      'src/page.ts',
    ]) {
      expect([path, findSecretFile(path)]).toEqual([path, undefined]);
    }
  });

  it('被强行提交的密钥文件：二进制的、工作树里已删的（还在 git 里）也报，不带行号', () => {
    const files: Record<string, Buffer> = {
      '.secrets/vault.pass': Buffer.from('随便什么内容\n'),
      'backup/vault.kdbx': Buffer.from([0x03, 0xd9, 0xa2, 0x9a, 0x00]),
      'docs/ok.md': Buffer.from('没问题\n'),
    };
    const read = (path: string) => {
      const content = files[path];
      if (!content) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return content;
    };
    const report = scanFiles([...Object.keys(files), 'deploy/github-app.pem'], read, []);
    expect(report.findings.map(formatFinding)).toEqual([
      '.secrets/vault.pass 密钥文件',
      'backup/vault.kdbx 密钥文件',
      'deploy/github-app.pem 密钥文件',
    ]);
    expect([report.binary, report.missing]).toEqual([['backup/vault.kdbx'], ['deploy/github-app.pem']]);
  });
});

describe('规则表和 .gitignore 的标记段是同一张名单', () => {
  const section = markedSection(GITIGNORE);

  it('标记段在，而且不是空的（标记被删掉，下面两条就成了空测）', () => {
    expect(section?.length ?? 0).toBeGreaterThan(10);
  });

  it('标记段的每一行规则表都拦得住；规则表每一类的样例 .gitignore 都忽略（git 只起一次）', () => {
    const lines = section ?? [];
    expect(lines.filter((l) => findSecretFile(sampleFor(l)) === undefined)).toEqual([]);
    const paths = [...new Set([...SECRET_FILES.map((r) => r.sample), ...lines.map(sampleFor)])];
    let ignored: string[];
    try {
      ignored = execFileSync('git', ['check-ignore', '--no-index', '--', ...paths], {
        cwd: ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
    } catch (e) {
      // 退出码 1 = 一个都没被忽略；别的都是真出错。
      if ((e as { status?: number }).status !== 1) throw e;
      ignored = [];
    }
    expect(paths.filter((p) => !ignored.includes(p))).toEqual([]);
  });

  it('标记段外面随便加行（*.log 之类）不影响', () => {
    const extra = `${GITIGNORE}\n*.log\ntmp/\n`;
    expect(markedSection(extra)).toEqual(section);
  });
});
