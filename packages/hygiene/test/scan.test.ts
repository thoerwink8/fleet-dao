// scanFiles 本身：按路径放行、二进制和已删的单列、白名单用没用上都报出来。不碰真目录，文件内容全在内存里。
import { describe, expect, it } from 'vitest';
import type { Allow } from '../src/allowlist.ts';
import { formatFinding, scanFiles } from '../src/scan.ts';
import { pseudoRandom } from './helpers.ts';

const reqId = ['req', pseudoRandom(24, 201)].join('_');
const leakToken = ['ghp', pseudoRandom(36, 202)].join('_');
const files: Record<string, Buffer> = {
  'docs/ok.md': Buffer.from('没有问题的一段话\n'),
  'docs/leak.md': Buffer.from(`第一行\n令牌 ${leakToken}\n`),
  'packages/x/test/fixtures/run.ndjson': Buffer.from(`{"request":"${reqId}"}\n`),
  'packages/x/quota/fixtures/org.json': Buffer.from(`{"note":"${reqId}"}\n`),
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
};
const read = (path: string) => {
  const content = files[path];
  if (!content) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return content;
};
const fixturesAllow: Allow = {
  rule: 'request-id',
  path: /\/test\/fixtures\//,
  reason: '测试用：插头夹具里的请求号放行。',
};
const staleAllow: Allow = { rule: 'webhook', path: /^nowhere\//, reason: '测试用：一处都用不上的条目。' };

describe('scanFiles', () => {
  it('按规则报出命中（只有文件、行、规则名），白名单只放行它那一类文件', () => {
    const report = scanFiles([...Object.keys(files), 'docs/deleted.md'], read, [fixturesAllow, staleAllow]);
    expect(report.findings.map(formatFinding)).toEqual([
      'docs/leak.md:2 令牌',
      'packages/x/quota/fixtures/org.json:1 请求编号',
    ]);
    // 二进制、工作树里已删的单列，不混进「扫了没事」。
    expect(report.scanned).toEqual([
      'docs/ok.md',
      'docs/leak.md',
      'packages/x/test/fixtures/run.ndjson',
      'packages/x/quota/fixtures/org.json',
    ]);
    expect(report.binary).toEqual(['assets/logo.png']);
    expect(report.missing).toEqual(['docs/deleted.md']);
    // 用不上的白名单条目报出来（由 check.ts 只提示、不判红）。
    expect(report.unusedAllows).toEqual([staleAllow]);
  });

  it('【故意造出的失败】真密钥藏在路径里（文件名 / 目录名）也拦：正文干净不算过，报出来的路径要遮住那段', () => {
    // 路径本身就是写出去的东西（commit 里的文件名、网页地址、目录名）：`writeSpecDoc` 的路径是 AI 给的、
    // 可变的，把令牌样式的密钥拼进去就会连文件名一起公开。只看内容会放过去。
    const secret = ['ghp', pseudoRandom(36, 203)].join('_');
    const leakPath = `specs/532-x/${secret}/需求.md`;
    const clean = new Map([[leakPath, Buffer.from('正文干净\n')]]);
    const report = scanFiles([leakPath], (p) => clean.get(p) ?? Buffer.from(''), []);
    // 行号 0：命中的是路径本身，不是哪一行。路径里那段遮成「…」——报出来的东西里不带值
    expect(report.findings.map(formatFinding)).toEqual(['specs/532-x/…/需求.md 令牌']);
    for (const f of report.findings) expect(f.path).not.toContain(secret);
  });

  it('【故意造出的失败】路径藏密钥 + 文件是二进制（或工作树里已删）：这两个清单里也不许出现原路径', () => {
    // report.binary / report.missing 会进 publish-check 的 HYGIENE_UNSCANNED 报错，一样会写进日志。
    const secret = ['ghp', pseudoRandom(36, 209)].join('_');
    const binaryPath = `assets/${secret}.png`;
    const gonePath = `docs/${secret}/gone.md`;
    const files = new Map([[binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])]]);
    const report = scanFiles(
      [binaryPath, gonePath],
      (p) => {
        const c = files.get(p);
        if (!c) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
        return c;
      },
      [],
    );
    expect(report.binary).toEqual(['assets/…']);
    expect(report.missing).toEqual(['docs/…/gone.md']);
    for (const p of [...report.binary, ...report.missing, ...report.findings.map((f) => f.path)]) {
      expect(p).not.toContain(secret);
    }
  });

  it('路径里藏了密钥时，内容里的命中也不遮不白名单地放过去（整条都不白名单）', () => {
    const secret = ['ghp', pseudoRandom(36, 205)].join('_');
    const other = ['ghp', pseudoRandom(36, 206)].join('_');
    const leakPath = `packages/x/test/fixtures/${secret}/run.md`;
    const files = new Map([[leakPath, Buffer.from(`令牌 ${other}\n`)]]);
    // 这条白名单本来会放行 packages/x/test/fixtures 下的 request-id；路径脏了就不放行任何一条
    const allow: Allow = { rule: 'token', path: /^packages\/x\/test\/fixtures\//, reason: '测试用：放行。' };
    const report = scanFiles([leakPath], (p) => files.get(p) ?? Buffer.from(''), [allow]);
    const lines = report.findings.map(formatFinding);
    expect(lines).toContain(`packages/x/test/fixtures/…/run.md:1 令牌`);
    for (const f of report.findings) expect(f.path).not.toContain(secret);
  });

  it('【故意造出的失败】JWT 藏在路径里：遮的是整段，不是规则匹配到的那一截', () => {
    // JWT 的规则只匹配前两段（`eyJ…` 开头那两截），签名那一段不在匹配里；只遮匹配到的一截等于把签名泄出去。
    // 值在测试里拼出来（`eyJ` 也拆开写），免得文件自己长得像 JWT。
    const head = ['ey', 'J'].join('');
    const body = pseudoRandom(10, 207);
    const signature = pseudoRandom(18, 208);
    const jwt = `${head}${body}.${head}${body}.${signature}`;
    const leakPath = `docs/${jwt}`;
    const report = scanFiles([leakPath], () => Buffer.from('正文干净\n'), []);
    expect(report.findings.map(formatFinding)).toEqual(['docs/… JWT']);
    for (const f of report.findings) {
      expect(f.path).not.toContain(signature);
      expect(f.path).not.toContain(head);
    }
  });

  it('正常的仓内路径不会误报', () => {
    const report = scanFiles(
      ['specs/532-删敏感值名单/需求.md', 'packages/hygiene/src/allowlist.ts'],
      () => Buffer.from('干净\n'),
      [],
    );
    expect(report.findings).toEqual([]);
  });

  it('一个文件都没给：扫了 0 个，和「扫了没事」分得开', () => {
    const report = scanFiles([], read, []);
    expect([report.scanned.length, report.findings.length]).toEqual([0, 0]);
  });

  it('读文件出了别的错（不是文件不在）就直接抛，不当成扫过', () => {
    const denied = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    expect(() => scanFiles(['docs/ok.md'], denied, [])).toThrow(/EACCES/);
  });
});
