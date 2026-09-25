// 演示版产物扫描：先造一份带真名的产物看它报红，改干净后再看它变绿；空目录、源码对照文件、配置里加的词也各试一次。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { BUILTIN_TERMS, forbiddenTerms, scanDir } from './scan';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一份最小的「产物」：页面、脚本、样式、字体。 */
function out(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'demo-scan-'));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(d, name, '..'), { recursive: true });
    writeFileSync(join(d, name), body);
  }
  return d;
}

const CLEAN = {
  'index.html':
    '<!doctype html><title>子午（演示版）</title><script src="/demo/assets/entry-a1b2.js"></script>',
  'assets/entry-a1b2.js': 'const t="演示版·全是假数据";export{t};',
  'assets/app-c3d4.css': '.a{color:red}',
  'assets/inter-e5f6.woff2': '\u0000\u0001binary',
};

describe('演示版产物扫描', () => {
  test('干净的产物：扫到了文件、没有命中', () => {
    const r = scanDir(out(CLEAN));
    expect(r.files).toBe(4);
    expect(r.hits).toEqual([]);
  });

  test('先红后绿：带出真名就报红，改干净就变绿', () => {
    const d = out({ ...CLEAN, 'assets/entry-a1b2.js': 'const n="fleet·dao 驾驶舱";' });
    const red = scanDir(d);
    expect(red.hits.map((h) => h.term).sort()).toEqual(['dao', 'fleet', '驾驶舱']);
    expect(red.hits[0]?.file).toBe('assets/entry-a1b2.js');
    expect(red.hits[0]?.context).toContain('fleet·dao');

    writeFileSync(join(d, 'assets/entry-a1b2.js'), 'const n="子午 控制台";');
    expect(scanDir(d).hits).toEqual([]);
  });

  test('内置名单里的每一个词都拦得住，不分大小写', () => {
    for (const term of BUILTIN_TERMS) {
      const r = scanDir(out({ ...CLEAN, 'assets/x.js': `x="${term.toUpperCase()}"` }));
      expect(
        r.hits.map((h) => h.term),
        term,
      ).toContain(term.toLowerCase());
    }
  });

  test('先红后绿：本项目自己的叫法和规矩原话也拦得住（拿一句去 GitHub 搜就能对上公开仓）', () => {
    const words = [
      '人闸',
      '拼车',
      '独享',
      '总指挥',
      '指挥官',
      '审官',
      '出比 5.1',
      '不做 UI 类活',
      'GPT 族不碰',
      'GPT 不碰',
      '不用 Fable',
    ];
    const d = out({ ...CLEAN, 'assets/x.js': `x=${JSON.stringify(words.join('，'))}` });
    expect(
      scanDir(d)
        .hits.map((h) => h.term)
        .sort(),
    ).toEqual(words.map((w) => w.toLowerCase()).sort());
    writeFileSync(join(d, 'assets/x.js'), 'x="要不要人来拍板；样例禁令：这一类模型不接界面活"');
    expect(scanDir(d).hits).toEqual([]);
  });

  test('GitHub 地址、创始人的用户名、内部叫法', () => {
    const r = scanDir(
      out({
        ...CLEAN,
        'assets/x.js': 'a="https://GitHub.com/someone/x";b="thoerwink8";c="Mirasim 云端";d="Temporal"',
      }),
    );
    expect(r.hits.map((h) => h.term).sort()).toEqual(['github.com', 'mirasim', 'temporal', 'thoerwink']);
  });

  test('短名按整词比：Jev 判断题拦，别的词里碰巧含这三个字母不拦', () => {
    expect(scanDir(out({ ...CLEAN, 'assets/x.js': 'a="Jev 判断题"' })).hits.map((h) => h.term)).toEqual([
      'jev',
    ]);
    expect(scanDir(out({ ...CLEAN, 'assets/x.js': 'a="fleet-dao"' })).hits.map((h) => h.term)).toEqual([
      'fleet',
      'dao',
    ]);
    expect(scanDir(out({ ...CLEAN, 'assets/x.js': 'a="majevski",b="daonly",c=Xjev' })).hits).toEqual([]);
  });

  test('文件名里带出来的也算', () => {
    const r = scanDir(out({ ...CLEAN, 'assets/fleet-dao-web-9f8e.js': 'x=1' }));
    expect(r.hits.filter((h) => h.file === 'assets/fleet-dao-web-9f8e.js').map((h) => h.term)).toEqual([
      'fleet',
      'dao',
    ]);
  });

  test('源码对照文件：有 .map 文件、或者产物里指向它，都算', () => {
    const withMap = scanDir(out({ ...CLEAN, 'assets/entry-a1b2.js.map': '{"version":3}' }));
    expect(withMap.hits.map((h) => h.term)).toContain('源码对照文件（sourcemap）');
    const withComment = scanDir(out({ ...CLEAN, 'assets/x.js': 'x=1\n//# sourceMappingURL=x.js.map' }));
    expect(withComment.hits.map((h) => h.term)).toEqual(['sourceMappingURL']);
  });

  test('配置里加的词（真域名）：给了就拦，没给就不拦', () => {
    const d = out({ ...CLEAN, 'index.html': '<a href="https://cockpit.example.test/">x</a>' });
    expect(scanDir(d).hits).toEqual([]);
    const terms = forbiddenTerms(' cockpit.example.test, other.example.test ');
    expect(terms).toContain('cockpit.example.test');
    expect(scanDir(d, terms).hits.map((h) => h.term)).toEqual(['cockpit.example.test']);
  });

  test('一个文件都没扫到就报错，不冒充「扫了没事」', () => {
    expect(() => scanDir(out({}))).toThrow(/没扫到任何文件/);
  });

  test('字体、图片只看文件名，不按文本扫内容', () => {
    expect(scanDir(out({ ...CLEAN, 'assets/font.woff2': 'fleet' })).hits).toEqual([]);
  });
});
